"use strict";

// lib/font_mapping_apply.js — Phase 8D 字体映射 Apply 阶段逻辑
//
// 跟 lib/font_mapping_pairs.js（schema 校验 + 配对方向投影）+
// lib/font_mapping_ops.js（数据变更算法）正交，处理 Apply 流程：
//
// 1. languageToScript — BCP-47 lang code → script 分类
// 2. isCrossScript — 判断 source / target 是否跨脚本
// 3. detectUnmatchedItems — 扫文档实际字体 vs config preset/override → 算每行状态
// 4. computeAutoFallback — "使用兜底"快捷计算（primary_cjk + preferred_weight）
// 5. shouldBlockApply — 跨脚本未匹配未设置时禁 Apply 按钮的逻辑
// 6. resolveApplyMode — report.font_mapping.apply_mode 枚举
//
// task_plan Phase 8D「跨脚本未匹配 blocking 处理」段策略：
//   default 1: 跨脚本场景未匹配未设置项 → Apply 禁用，强制用户决策
//   shortcut 2: 每行加快捷『使用兜底』一键填入
//   opt-in: 配置可设 auto_apply_default = true 跳过 blocking

var FMP = require("./font_mapping_pairs.js");

// ---------------------------------------------------------------------------
// languageToScript — BCP-47 lang code → script ("Latin" | "CJK" | "Cyrillic"
// | "Arabic" | "Devanagari" | "Thai" | "Hebrew" | "Other")
// ---------------------------------------------------------------------------
// 按主流商业排版场景覆盖。lang code 前缀匹配（"en-US" 取 "en"）。
// 不在表里的 → "Other"。

var SCRIPT_BY_PRIMARY_LANG = {
    // Latin script (default for European languages)
    en: "Latin", fr: "Latin", de: "Latin", es: "Latin", it: "Latin",
    pt: "Latin", nl: "Latin", pl: "Latin", sv: "Latin", no: "Latin",
    da: "Latin", fi: "Latin", tr: "Latin", vi: "Latin", id: "Latin",
    ms: "Latin", tl: "Latin", ro: "Latin", hu: "Latin", cs: "Latin",
    sk: "Latin", hr: "Latin", sl: "Latin", lt: "Latin", lv: "Latin",
    et: "Latin", el: "Other",                  // 希腊语 — 自己 script，归 Other
    // CJK
    zh: "CJK", ja: "CJK", ko: "CJK",
    // Cyrillic
    ru: "Cyrillic", uk: "Cyrillic", bg: "Cyrillic", sr: "Cyrillic",
    mk: "Cyrillic", be: "Cyrillic", kk: "Cyrillic", ky: "Cyrillic",
    // Arabic
    ar: "Arabic", fa: "Arabic", ur: "Arabic", ps: "Arabic",
    // Hebrew
    he: "Hebrew", yi: "Hebrew",
    // Devanagari / Indic
    hi: "Devanagari", mr: "Devanagari", ne: "Devanagari", sa: "Devanagari",
    // Thai
    th: "Thai"
};

// BCP-47 显式 script 子标签表（tag 第二段、恰好 4 个字母）。命中时优先于
// 主语言推断（如 "sr-Latn" 应判 Latin 而非 sr 主语言的 Cyrillic）。键用
// TitleCase 规范化形（输入 "latn"/"LATN" 都归一到 "Latn"）。Finding 2。
var SCRIPT_SUBTAG_MAP = {
    Latn: "Latin",
    Cyrl: "Cyrillic",
    Arab: "Arabic",
    Hebr: "Hebrew",
    Deva: "Devanagari",
    Thai: "Thai",
    Hans: "CJK", Hant: "CJK", Hani: "CJK",   // Han
    Jpan: "CJK", Kana: "CJK", Hira: "CJK",   // Japanese / kana
    Hang: "CJK", Kore: "CJK"                 // Korean
};

function languageToScript(lang) {
    if (!lang || typeof lang !== "string") return "Other";
    var parts = lang.split("-");
    // 显式 script 子标签优先：第二段且恰好 4 个字母（region 是 2 字母 / 3 数字，
    // 故 "en-US" 的 "US" 不会被误判为 script）。命中映射表才早返回，否则落回主语言。
    if (parts.length > 1 && /^[A-Za-z]{4}$/.test(parts[1])) {
        var subtag = parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase();
        if (SCRIPT_SUBTAG_MAP[subtag]) return SCRIPT_SUBTAG_MAP[subtag];
    }
    var primary = parts[0].toLowerCase();
    return SCRIPT_BY_PRIMARY_LANG[primary] || "Other";
}

// ---------------------------------------------------------------------------
// isCrossScript — true 当 source / target 属不同 script
// ---------------------------------------------------------------------------

function isCrossScript(sourceLang, targetLang) {
    return languageToScript(sourceLang) !== languageToScript(targetLang);
}

// ---------------------------------------------------------------------------
// detectUnmatchedItems — 算 Apply UI 替换列表每一行的状态
// ---------------------------------------------------------------------------
// 输入：
//   config              — brand config
//   documentFonts       — 文档实际用到的 (font, weight) 清单，类型 [{font, weight}]
//   sourceLang / targetLang
//   overrides           — per-project override，键 "font|weight"，
//                         值 {font, weight} | null（null = 用户显式跳过）
//
// 返回 [{
//   source: {font, weight},
//   target: {font, weight} | null,
//   status: "preset" | "override" | "equivalence_canonical" |
//           "auto_fallback" | "unmatched_passthrough" | "unmatched_blocking",
//   canonical?: {font, weight}    // 走 equivalence_canonical 时
// }]
//
// status 区分：
//   - preset                   = 来自 config.pairs[] 投影
//   - override                 = 用户在 Apply UI 改过，存 overrides
//   - equivalence_canonical    = source 在 equivalence_groups merged_in 里，
//                                映射到 canonical 后再走 pair
//   - auto_fallback            = 跨脚本未匹配 + config.auto_apply_default===true +
//                                有可算兜底 → 直接物化兜底目标（Route A，Finding 1）
//   - unmatched_passthrough    = 同脚本场景下未匹配未设置（target null = 不替换）
//   - unmatched_blocking       = 跨脚本场景下未匹配未设置（apply blocked）

function detectUnmatchedItems(config, documentFonts, sourceLang, targetLang, overrides) {
    overrides = overrides || {};
    var cross = isCrossScript(sourceLang, targetLang);
    // Route A（Finding 1）：跨脚本 + auto_apply_default 且能算出兜底时，未匹配项
    // 直接物化兜底目标，不再留 target:null 让 caller 静默漏处理。
    var autoFallback = (cross && config && config.auto_apply_default === true)
        ? computeAutoFallback(config, targetLang)
        : null;
    var presetMap = {};            // 字面 "font|weight" → target
    var normalizedPresetMap = {};  // canonical 归一后 "font|weight" → target（Finding 4）
    FMP.projectPairsForDirection(config, sourceLang, targetLang).forEach(function (sub) {
        presetMap[sub.from.font + "|" + sub.from.weight] = sub.to;
        // pair 成员若写成 merged_in 形，归一到 canonical key，doc 用 canonical 也能命中
        var canon = FMP.getCanonical(config, sourceLang, sub.from.font, sub.from.weight);
        normalizedPresetMap[canon.font + "|" + canon.weight] = sub.to;
    });

    return documentFonts.map(function (df) {
        var key = df.font + "|" + df.weight;

        // 1) override 优先
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
            var ov = overrides[key];
            return {
                source: { font: df.font, weight: df.weight },
                target: ov || null,                          // null = 用户显式跳过
                status: "override"
            };
        }

        // 2) preset 命中（字面）
        if (presetMap[key]) {
            // doc 字体本身是 merged_in 项时（pair 也写 merged_in 形，literal 命中）：
            // 实际 apply 会先物理归一到 canonical，故归类 equivalence_canonical 而非
            // preset（Finding 4 refinement — doc/pair 同为 merged_in 的情形）。
            var litCanonical = FMP.getCanonical(config, sourceLang, df.font, df.weight);
            if (litCanonical.normalized_from) {
                return {
                    source: { font: df.font, weight: df.weight },
                    target: presetMap[key],
                    status: "equivalence_canonical",
                    canonical: { font: litCanonical.font, weight: litCanonical.weight }
                };
            }
            return {
                source: { font: df.font, weight: df.weight },
                target: presetMap[key],
                status: "preset"
            };
        }

        // 3) equivalence 规范化（Route B — Finding 4）：doc 侧或 pair 侧任一是
        //    merged_in 时都归一到 canonical key 再查 preset。
        //    - doc 是 merged_in、pair 写 canonical 形 → presetMap[canonicalKey]
        //    - doc 是 canonical、pair 写 merged_in 形 → normalizedPresetMap[canonicalKey]
        var canonical = FMP.getCanonical(config, sourceLang, df.font, df.weight);
        var canonicalKey = canonical.font + "|" + canonical.weight;
        var canonTarget = presetMap[canonicalKey] || normalizedPresetMap[canonicalKey];
        if (canonTarget) {
            return {
                source: { font: df.font, weight: df.weight },
                target: canonTarget,
                status: "equivalence_canonical",
                canonical: { font: canonical.font, weight: canonical.weight }
            };
        }

        // 4a) unmatched + 可物化兜底（跨脚本 + auto_apply_default + 有兜底）→
        //     直接给 target，status: "auto_fallback"（Route A，Finding 1）
        if (autoFallback) {
            return {
                source: { font: df.font, weight: df.weight },
                target: { font: autoFallback.font, weight: autoFallback.weight },
                status: "auto_fallback"
            };
        }
        // 4b) unmatched —— 跨脚本场景下默认 blocking，同脚本 passthrough
        return {
            source: { font: df.font, weight: df.weight },
            target: null,
            status: cross ? "unmatched_blocking" : "unmatched_passthrough"
        };
    });
}

// ---------------------------------------------------------------------------
// computeAutoFallback — "使用兜底"快捷按钮的填入计算
// ---------------------------------------------------------------------------
// 返回 {font, weight} | null。null = 配置没 fallback 字体或 preferred_weight。
//
// 选 fallback_chains[targetLang] 第一项作 font；preferred_per_language[targetLang]
// .preferred_weight 作 weight。配置都没设 → return null。

function computeAutoFallback(config, targetLang) {
    var chain = FMP.getFallbackChain(config, targetLang);
    if (!chain.length) return null;
    var weight = FMP.getPreferredWeight(config, targetLang);
    if (!weight) return null;
    return { font: chain[0], weight: weight };
}

// ---------------------------------------------------------------------------
// shouldBlockApply — 判断 apply 应不应被 blocking
// ---------------------------------------------------------------------------
// 返回 { block: bool, reason: string, unresolved: [items] }
//
// 规则：
//   - 同脚本场景：不 blocking（unmatched_passthrough 默认）
//   - 跨脚本场景 + 有 status === "unmatched_blocking" 项：
//       - config.auto_apply_default === true → 不 blocking，用 fallback 兜底
//       - 否则 block
//   - 用户在 Apply UI 把 unmatched 改成 override（带 target 或 null 显式跳过）：
//       items[].status === "override"，不算 unresolved

function shouldBlockApply(config, items, sourceLang, targetLang) {
    var cross = isCrossScript(sourceLang, targetLang);
    if (!cross) {
        return { block: false, reason: "same_script", unresolved: [] };
    }
    // auto_apply_default 只在能算出有效兜底目标时才解除 block；否则 unmatched
    // 项仍是 target:null，apply_mode 会谎报 auto_apply_default — 继续 block。
    if (config && config.auto_apply_default === true && computeAutoFallback(config, targetLang)) {
        return { block: false, reason: "auto_apply_default_opted_in", unresolved: [] };
    }
    var unresolved = (items || []).filter(function (it) {
        return it.status === "unmatched_blocking";
    });
    if (unresolved.length > 0) {
        return {
            block: true,
            reason: (config && config.auto_apply_default === true)
                ? "auto_apply_default_set_but_no_fallback_target"
                : "cross_script_unmatched_items_require_user_resolution",
            unresolved: unresolved
        };
    }
    return { block: false, reason: "all_items_resolved", unresolved: [] };
}

// ---------------------------------------------------------------------------
// resolveApplyMode — report.font_mapping.apply_mode 枚举
// ---------------------------------------------------------------------------
// 返回:
//   "passthrough"                — 同脚本场景，unmatched 项保留原状
//   "blocking_resolved_by_user"  — 跨脚本场景，user 在 Apply UI 已逐项解决所有 unmatched
//   "auto_apply_default"         — 跨脚本场景，config.auto_apply_default = true 静默套兜底
//   "blocked"                    — 跨脚本场景仍有 unmatched_blocking，apply 被禁

function resolveApplyMode(config, items, sourceLang, targetLang) {
    var cross = isCrossScript(sourceLang, targetLang);
    if (!cross) return "passthrough";
    // auto_apply_default 仅在能算出有效兜底目标时才生效；否则按下方常规分类，
    // report 不谎报（与 shouldBlockApply 保持同步 — 见 Finding 1）。
    if (config && config.auto_apply_default === true && computeAutoFallback(config, targetLang)) {
        return "auto_apply_default";
    }
    var unresolved = (items || []).filter(function (it) {
        return it.status === "unmatched_blocking";
    });
    if (unresolved.length === 0) return "blocking_resolved_by_user";
    return "blocked";
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
    languageToScript: languageToScript,
    isCrossScript: isCrossScript,
    detectUnmatchedItems: detectUnmatchedItems,
    computeAutoFallback: computeAutoFallback,
    shouldBlockApply: shouldBlockApply,
    resolveApplyMode: resolveApplyMode
};
