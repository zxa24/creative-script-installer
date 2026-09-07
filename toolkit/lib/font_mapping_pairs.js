"use strict";

// lib/font_mapping_pairs.js — Phase 8D 跨脚本字体映射配对引擎
//
// 处理品牌字体配置（fonts_by_language + pairs + equivalence_groups +
// preferred_per_language + fallback_chains + weight_aliases）的 schema 校验、
// 配对方向投影、字体等价类规范化、字重模糊匹配。
//
// 跟现有 lib/font_mapping.js（Phase 2 字体策略 / resolveCJKFont / Latin
// fallback）独立 — 那个解决"用什么字体"，本文件解决"怎么从源字体映射到
// 目标字体"。
//
// Schema 详见 task_plan.md Phase 8D「配置 schema」段，相关 findings 见
// findings.md html-dialog-sizing。
//
// 设计参考：docs/字体映射面板/ prototype（2026-05-29 移植，A 层数据模型 +
// 业务算法，跟 UI 无关）。

// ---------------------------------------------------------------------------
// Schema 校验 — validateBrandConfig
// ---------------------------------------------------------------------------
// 返回 { ok: boolean, errors: [string] }
// errors 包含 schema 缺失字段 / 引用不一致（pairs/equivalence_groups 引用
// 的 font / weight 不在 fonts_by_language 里）/ canonical 不在 group 成员里 等

// TODO#58 R4/R2: one module-level lang normalizer, so the validator and the
// message builder cannot disagree about whether two spellings are one language.
var _normLang = (function () {
    var f = null;
    try { f = require("./lang_script_table.js").normalizeBcp47Identity; } catch (e) { f = null; }
    return function (l) { return f ? f(l) : String(l == null ? "" : l); };
})();

// 🔴 representative_by_lang is written with WHATEVER SPELLING the config used,
// and read with whatever spelling the caller happens to hold. Keying the lookup on
// a raw string is the same one-side-normalized shape as R4 / round-3 slot keys /
// round-5 mergedInIndex — this is its FOURTH appearance, so it gets a single
// lookup instead of a fix per site.
//
// MEASURED consequence of the raw version (5A, audit round 5): a pair whose target
// members are spelled `zh-Hans-CN` with a representative filed under `zh-CN` was
// ACCEPTED by the validator (which normalizes) and then MISSED by the projection
// (which did not) — so the projection silently fell back to `tgtMembers[0]` and
// emitted `Regular` where the operator had chosen `Book`. The config was valid and
// the operator's choice was dropped without a word.
//
// ⚠ Exact key first: a config that really does carry two different entries for two
// spellings keeps its exact behaviour; only a MISS falls back to the equivalent
// spelling.
function _repFor(pair, lang) {
    var rbl = pair && pair.representative_by_lang;
    if (!rbl || typeof rbl !== "object") return undefined;
    if (rbl[lang] !== undefined) return rbl[lang];
    var want = _normLang(lang);
    var keys = Object.keys(rbl);
    for (var i = 0; i < keys.length; i++) {
        if (_normLang(keys[i]) === want) return rbl[keys[i]];
    }
    return undefined;
}

// TODO#58 R2 (3) — the message an operator actually reads when a config is refused.
//
// 🔴 P4 (audit round 5) — the REMEDY SET is the part that can do damage, and
// the previous one was actively wrong. It offered only "point both at the same
// target, or remove one of the two pairings". But the commonest way to reach this
// state is an equivalence group produced by the RETIRED name heuristic (or hand-
// written): two spellings that are NOT one face were declared equivalent. In that
// case both of the operator's lines are CORRECT and the group is the error — and
// the old wording steered him into deleting a good line to satisfy a bad group.
// The third exit is therefore named first when a group is involved.
//
// 🔴 P6 — it must not claim the font engine said anything. A config carries no
// `postscriptName` and no `status`, and `_origin` is stripped at export, so the
// validator cannot know whether this group came from measured identity or from a
// name guess. It states only what is in the config.
function _egSplitMessage(grouped, first, conflict, tgtLang) {
    function nameOf(key) { var q = String(key).split("|"); return q[0] + " " + q[1]; }
    function dstOf(e) { var q = String(e.dst).split("|"); return q[0] + " " + q[1]; }
    if (!grouped) {
        // no equivalence group in play: the SAME source weight is wired twice.
        return "\"" + nameOf(first.key) + "\" is paired with two different targets for " +
            tgtLang + ": " + dstOf(first) + " and " + dstOf(conflict) + ". " +
            "Applying this would keep only one of them, chosen arbitrarily. " +
            "To fix: keep the pairing you want for " + tgtLang + " and remove the other.";
    }
    return "\"" + nameOf(first.key) + "\" and \"" + nameOf(conflict.key) + "\" are listed in the " +
        "same equivalence group, so they are treated as one font — but for " + tgtLang +
        " they are paired with different targets: \"" + nameOf(first.key) + "\" -> " + dstOf(first) +
        ", while \"" + nameOf(conflict.key) + "\" -> " + dstOf(conflict) + ". " +
        "Applying this would keep only one of the two, chosen arbitrarily. To fix, in order of " +
        "likelihood: (1) if these two are NOT actually the same typeface, the equivalence group " +
        "is wrong — remove one of them from it, and both pairings keep working; " +
        "(2) if they ARE the same typeface, point both at the same target for " + tgtLang + "; " +
        "(3) or remove one of the two pairings.";
}

function validateBrandConfig(config, opts) {
    var errors = [];
    if (!config || typeof config !== "object") {
        return { ok: false, errors: ["config must be an object"] };
    }

    // 必需字段
    if (!config.brand_name) errors.push("missing brand_name");
    if (typeof config.fonts_by_language !== "object" || !config.fonts_by_language) {
        errors.push("missing fonts_by_language");
        return { ok: false, errors: errors };
    }

    var languages = Object.keys(config.fonts_by_language);
    if (languages.length === 0) errors.push("fonts_by_language is empty");

    // 构建语言→字体集索引供后续 cross-ref 校验用
    var fontsIndex = {};   // { lang: Set("font|weight") }
    languages.forEach(function (lang) {
        var fonts = config.fonts_by_language[lang];
        if (!Array.isArray(fonts)) {
            errors.push("fonts_by_language[" + lang + "] must be array");
            return;
        }
        var set = {};
        fonts.forEach(function (fw, idx) {
            if (!fw || !fw.font || !fw.weight) {
                errors.push("fonts_by_language[" + lang + "][" + idx + "] needs {font, weight}");
                return;
            }
            set[fw.font + "|" + fw.weight] = true;
        });
        fontsIndex[lang] = set;
    });

    // Phase 8D-ext-MM (II-d): 按 lang 索引 equivalence_groups[].merged_in，供
    // A/MM 互斥校验用。{ lang: { "font|weight": true } }。注意此处只读 raw 结构，
    // equivalence_groups 自身的完整性在下方 equivalence_groups 块单独校验。
    var mergedInIndex = {};
    if (Array.isArray(config.equivalence_groups)) {
        config.equivalence_groups.forEach(function (eg) {
            if (!eg || !eg.lang || !Array.isArray(eg.merged_in)) return;
            // 🔴 NORMALIZED (audit round 5, shape-two sweep — this one was not in
            // any finding, it turned up while fixing the others). II-d looks this up
            // with the pair's member lang, which is normalized now; leaving the eg
            // side raw would make `zh-Hans-CN` groups invisible to `zh-CN` members
            // and II-d would silently stop firing. Same one-side-normalized shape as
            // R4 and as the slot key in round 3.
            var _egL = _normLang(eg.lang);
            if (!mergedInIndex[_egL]) mergedInIndex[_egL] = {};
            eg.merged_in.forEach(function (m) {
                if (m && m.font && m.weight) mergedInIndex[_egL][m.font + "|" + m.weight] = true;
            });
        });
    }

    // ---------------------------------------------------------------------
    // TODO#58 R2 (3) — 一条 eg 的不同成员被投向不同目标（跨 pairing 矛盾）
    // ---------------------------------------------------------------------
    // 🔴 这不是放宽 II-d，II-d 一行没动。II-d 只在【同一条 pairing 内】同 lang
    // 有 ≥2 成员时才跑（`if (langCount[lang] <= 1) return;`），而这里要抓的形状是
    // **两条【不同】pairing 各 1 个成员** ⇒ 每条的 langCount 都是 1 ⇒ II-d 永不触发。
    // 实测（tests/spikes/spike_r2_samefamily_eg_drops_a_pairing.js）：那个 config
    // 曾经 `ok:true` 通过，然后 apply 期 `buildCjkWeightMap.put` 先到先得
    // ⇒ **恰好一条 operator 亲手画的线被静默丢掉，丢哪条取决于投影顺序。**
    //
    // 🔴🔴 本检查是【唯一】的守卫，不是兜底。（P5，第 3 轮审计点名的
    // 文档 bug —— 上一版注释写着「面板侧 (1b) 已把同 family 的 eg 渲染成组行 ⇒ 面板
    // 自己不会再产生这个形状 ⇒ 本检查兜导入」。**(1b) 已在第 2 轮被撤销**，面板
    // **就是**这个形状的主要产生者：同 family 的两个字重各自可见可连，operator
    // 随手就能连出矛盾。若照旧注释读，会得出「这个检查可以放宽或删掉」的结论 ——
    // 那会把静默丢线原样放回来。）owner 2026-08-20（姿态甲）已点头
    // 「会开始拒绝今天能过的 config」——那些 config 今天正在悄悄丢线。
    //
    // 🔴 判据（第 3 轮重写，旧版三个轴上都错）：
    //     会被投影进【同一个方向】（同 source lang + 同 target lang）的两条线，
    //     是否让【同一条 eg 的不同成员】落到【不同的有效目标】上？
    // 旧版只问「两条不同 pairing 认领了同一条 eg 的两个不同成员」，于是：
    //   - 假阳①：两条 pairing 目标语言不同（en→zh-CN 与 en→ja）也被拒，
    //     而 projectByPairWithIndex **一次只投影一个方向** ⇒ 两条根本不会进同一个
    //     byPair 数组 ⇒ 什么都没丢。（实测：两个方向各 1 行。）
    //   - 假阳②：两条 pairing 指向**同一个目标**也被拒，消息还把同一个目标名打印两遍，
    //     自证不矛盾。
    // 用「有效目标」而不是「成员」作判据，两个假阳同时消失；而按方向分组后逐组比，
    // 一次就能报全部冲突（不会修一条又被拒一次）。
    //
    // 🔴 「有效目标」不自己算 —— 直接用 projectByPairWithIndex 的输出。
    // 它已经处理了 MM 代表、getCanonical 归一等全部规则；重算一遍就是第二个真相来源
    // （上一轮 `w` 的教训，CLAUDE.md #27）。
    //
    // 🔴 canonical 也算成员（audit R1 的同一个概念）。
    var _egMemberIndex = {};   // { normLang: { "font|weight": egIndex } }
    var _egOverlaps = [];      // 同一个成员落进 ≥2 条【不同】 eg —— 见下方硬拒
    var _egCanonOf = {};       // { normLang: { key: [egIndex...] } } —— 它在哪几条组里是 canonical
    function _egSignature(eg) {
        if (!eg || !eg.canonical) return "";
        var ms = (Array.isArray(eg.merged_in) ? eg.merged_in : [])
            .map(function (m) { return (m && m.font) + "|" + (m && m.weight); }).sort();
        return _normLang(eg.lang) + "\u241F" + eg.canonical.font + "|" + eg.canonical.weight +
            "\u241F" + ms.join(",");
    }
    if (Array.isArray(config.equivalence_groups)) {
        config.equivalence_groups.forEach(function (eg, gi) {
            if (!eg || !eg.lang || !eg.canonical) return;
            var L = _normLang(eg.lang);
            if (!_egMemberIndex[L]) _egMemberIndex[L] = {};
            var all = [eg.canonical].concat(Array.isArray(eg.merged_in) ? eg.merged_in : []);
            all.forEach(function (m, mi) {
                if (!m || !m.font || !m.weight) return;
                var k = m.font + "|" + m.weight;
                if (_egMemberIndex[L][k] === undefined) {
                    _egMemberIndex[L][k] = gi;
                    if (mi === 0) { if (!_egCanonOf[L]) _egCanonOf[L] = {}; _egCanonOf[L][k] = [gi]; }
                    return;
                }
                if (_egMemberIndex[L][k] === gi) return;
                // 🔴 P2 (audit round 5): two BYTE-IDENTICAL groups are a redundancy,
                // not a contradiction — every reader resolves them the same way, so
                // "which group applies depends on storage order" would be a false
                // statement about this shape. Redundant, and left alone.
                if (_egSignature(config.equivalence_groups[_egMemberIndex[L][k]]) ===
                    _egSignature(eg)) return;
                if (mi === 0) {
                    if (!_egCanonOf[L]) _egCanonOf[L] = {};
                    if (!_egCanonOf[L][k]) _egCanonOf[L][k] = [];
                    if (_egCanonOf[L][k].indexOf(gi) < 0) _egCanonOf[L][k].push(gi);
                }
                // 🔴 first-wins used to SWALLOW this silently, and that was a real
                // false negative (audit round 3, reproduced): a member in two groups
                // was filed under the first, so the two claims landed in different
                // buckets and the contradiction went unreported while apply happily
                // resolved the weight to somebody else's target.
                _egOverlaps.push({ lang: L, key: k, egs: [_egMemberIndex[L][k], gi],
                                   canonicalIn: (_egCanonOf[L] && _egCanonOf[L][k]) ? _egCanonOf[L][k].slice() : [] });
            });
        });
    }
    function _egIndexOfMember(lang, key) {
        var byLang = _egMemberIndex[_normLang(lang)];
        if (!byLang) return null;
        var gi = byLang[key];
        return (gi === undefined) ? null : gi;
    }
    // 🔴 An overlapping eg set is a contradiction in ITSELF, before any pairing is
    // considered: getCanonical / findEquivalenceGroup both return the FIRST match in
    // array order, so which group wins is decided by array position (measured, audit
    // R1). 姿态甲 = contradictions are refused, so this is rejected here rather than
    // only counted in the ⑤ readout (font_identity_groups.findOverlaps).
    _egOverlaps.forEach(function (o) {
        var parts = o.key.split("|");
        var isCanon = o.canonicalIn.length > 0;
        // 🔴 P3 (audit round 5): the remedy has to be one he can actually carry
        // out. "Remove it from one of them" is impossible when the shared weight is
        // a group's CANONICAL — removing the canonical is not an edit the shape
        // allows; that group has to go, or be re-headed.
        var howToFix = isCanon
            ? ("It is the canonical of group" + (o.canonicalIn.length > 1 ? "s " : " ") +
               o.canonicalIn.join(" and ") + ", so it cannot simply be dropped from there: " +
               "delete the group that should not own it, or give that group a different canonical.")
            : "Remove it from one of the two groups.";
        errors.push("equivalence_groups: {" + parts[0] + ", " + parts[1] + "} (lang=" + o.lang +
            ") is listed in two different groups (" + o.egs[0] + " and " + o.egs[1] + "). " +
            "A weight can belong to only one group — otherwise which group applies depends on the " +
            "order the groups happen to be stored in. " + howToFix);
    });

    // 🔴 One roster lookup that tolerates an equivalent lang spelling (5A).
    // Exact key first so a config carrying two genuinely different roster entries
    // keeps its behaviour; only a MISS falls back to the equivalent spelling.
    function _fontsIndexFor(lang) {
        if (fontsIndex[lang]) return fontsIndex[lang];
        var want = _normLang(lang);
        var ks = Object.keys(fontsIndex);
        for (var i = 0; i < ks.length; i++) {
            if (_normLang(ks[i]) === want) return fontsIndex[ks[i]];
        }
        return null;
    }

    // pairs[] 校验
    if (config.pairs !== undefined) {
        if (!Array.isArray(config.pairs)) {
            errors.push("pairs must be array");
        } else {
            config.pairs.forEach(function (pair, pi) {
                if (!pair || !Array.isArray(pair.members) || pair.members.length < 2) {
                    errors.push("pairs[" + pi + "].members must be array of ≥2");
                    return;
                }
                // Phase 8D-ext-MM (II-a): 同 lang 多成员**允许**，当且仅当
                // representative_by_lang[lang] 存在且匹配成员（见下方 post-loop pass）。
                // 旧版无条件 dup-lang reject 改为有条件 → 这里只按 lang 收集成员数 +
                // 成员 key 集，rep 校验移到成员循环之后按 per-lang count 分支。
                // 🔴 KEYED ON NORMALIZED LANG (audit round 5, P2 — third time this
                // shape appears). Raw keys made `zh-Hans-CN` and `zh-CN` two
                // languages with one member each, so the >1-member STRICT branch
                // (II-b/c/d) was skipped entirely — while projectByPairWithIndex
                // normalizes and treats them as ONE, then reads
                // representative_by_lang[<first target member's lang>]. Net effect:
                // the operator's declared representative was ignored and no check
                // said anything.
                // `langSpellings` keeps the raw spellings so representative_by_lang
                // (written with whatever spelling the config used) can still be found
                // and so messages name the language the way the file does.
                var langCount = {};          // { normLang: count }
                var memberKeysByLang = {};   // { normLang: { "font|weight": true } }
                var langSpellings = {};      // { normLang: [rawLang...] }
                pair.members.forEach(function (m, mi) {
                    if (!m || !m.lang || !m.font || !m.weight) {
                        errors.push("pairs[" + pi + "].members[" + mi + "] needs {lang, font, weight}");
                        return;
                    }
                    var key = m.font + "|" + m.weight;
                    var mL = _normLang(m.lang);
                    if (!langSpellings[mL]) langSpellings[mL] = [];
                    if (langSpellings[mL].indexOf(m.lang) < 0) langSpellings[mL].push(m.lang);
                    langCount[mL] = (langCount[mL] || 0) + 1;
                    if (!memberKeysByLang[mL]) memberKeysByLang[mL] = {};
                    // Phase 8D-ext-MM (Fix 1): 同 lang 同 {font,weight} 重复 = 数据错误
                    // （MM = DISTINCT 字重 fan-in；identical-duplicate 下游会 double-emit）。
                    // memberKeysByLang 会去重 → 须独立于 langCount 检测重复。
                    if (memberKeysByLang[mL][key]) {
                        errors.push("pairs[" + pi + "].members lang=" + m.lang + " has duplicate identical member {" + m.font + ", " + m.weight + "}");
                    }
                    memberKeysByLang[mL][key] = true;
                    // 🔴 Roster lookup tolerates an equivalent lang spelling (5A).
                    // Surfaced while pinning the rlang mutation: a member spelled
                    // `zh-Hans-CN` against a roster keyed `zh-CN` was reported as
                    // "not in fonts_by_language" — a FALSE REJECT of a config the
                    // rest of the validator (and the projection) treats as valid.
                    // Same one-side-normalized shape, same fix.
                    var _mfi = _fontsIndexFor(m.lang);
                    if (!_mfi) {
                        errors.push("pairs[" + pi + "].members[" + mi + "] lang=" + m.lang + " not in fonts_by_language");
                    } else if (!_mfi[key]) {
                        errors.push("pairs[" + pi + "].members[" + mi + "] references {" + m.font + ", " + m.weight + "} not in fonts_by_language[" + m.lang + "]");
                    }
                });

                var repMap = pair.representative_by_lang;
                var repIsObject = repMap !== undefined && repMap !== null && typeof repMap === "object";
                if (repMap !== undefined && !repIsObject) {
                    errors.push("pairs[" + pi + "].representative_by_lang must be object");
                }

                // Phase 8D-ext-MM (II-b/c/d): >1 同 lang 成员的 lang 走 STRICT —
                // 代表必填 (II-b) + 代表须是成员 (II-c) + 成员不得是 eg merged_in (II-d)。
                Object.keys(langCount).forEach(function (lang) {
                    if (langCount[lang] <= 1) return;
                    // repMap is keyed with whatever spelling the config used; `lang`
                    // is normalized now, so try both (audit round 5, P2).
                    // one lookup for everybody (see _repFor)
                    var rep = repIsObject ? _repFor(pair, lang) : undefined;
                    // (II-b) 多成员 lang 代表必填
                    if (!rep || !rep.font || !rep.weight) {
                        errors.push("pairs[" + pi + "] lang=" + lang + " has " + langCount[lang] + " members but representative_by_lang[" + lang + "] is missing/invalid");
                        return;
                    }
                    // (II-c) 代表须是该 pair 该 lang 的某个成员（而非仅在 fonts_by_language）
                    if (!memberKeysByLang[lang][rep.font + "|" + rep.weight]) {
                        errors.push("pairs[" + pi + "].representative_by_lang[" + lang + "] references {" + rep.font + ", " + rep.weight + "} which is not a member of this pair for lang=" + lang);
                    }
                    // (II-d) A/MM 互斥：多成员 lang 的成员不得同时是 eg merged_in alias
                    var mIdx = mergedInIndex[lang] || {};
                    Object.keys(memberKeysByLang[lang]).forEach(function (mk) {
                        if (mIdx[mk]) {
                            errors.push("pairs[" + pi + "] lang=" + lang + " member {" + mk.split("|").join(", ") + "} is both an MM same-lang member and an equivalence_groups merged_in (A/MM overlap)");
                        }
                    });
                });

                // Phase 8D-ext-MM (II-c-compat): ≤1 成员 lang 的 representative_by_lang
                // 保持 LENIENT — 沿用旧的 fonts_by_language cross-ref 校验，不加新严格度
                // （legacy 1en+1zh pair 可能带 weight 在 roster 但非成员的代表，须仍 ok:true）。
                if (repIsObject) {
                    Object.keys(repMap).forEach(function (rlang) {
                        // 🔴 NORMALIZED on both sides (5A A-class #2). `langCount` is
                        // keyed on the normalized lang, so a representative filed under
                        // `zh-Hans-CN` while the members say `zh-CN` used to read
                        // `langCount["zh-Hans-CN"]` = undefined, fall through to this
                        // LENIENT branch, and then miss `fontsIndex` for the same
                        // reason — reporting "not in fonts_by_language" about a
                        // representative that is perfectly valid. A FALSE REJECT of the
                        // operator's own choice.
                        var rL = _normLang(rlang);
                        if (langCount[rL] > 1) return;   // 多成员 lang 已在上面 strict 校验
                        var r = repMap[rlang];
                        if (!r || !r.font || !r.weight) {
                            errors.push("pairs[" + pi + "].representative_by_lang[" + rlang + "] needs {font, weight}");
                            return;
                        }
                        var _fi = _fontsIndexFor(rlang);
                        if (!_fi) {
                            errors.push("pairs[" + pi + "].representative_by_lang lang=" + rlang + " not in fonts_by_language");
                        } else if (!_fi[r.font + "|" + r.weight]) {
                            errors.push("pairs[" + pi + "].representative_by_lang[" + rlang + "] references {" + r.font + ", " + r.weight + "} not in fonts_by_language[" + rlang + "]");
                        }
                    });
                }
            });
        }
    }

    // equivalence_groups[] 校验

    // TODO#58 R2 (3) — 出声：同一方向上，两条线对【同一个物理字体】给出不同目标。
    //
    // 🔴 桶里保留【全部】行，不是第一行（audit round 5，first-wins 这个形状
    // 第三次出现了）。旧版 `if (!byEg[gi][key])` 只留每个成员的第一行 ⇒ 同一成员的
    // 第二条线**从不被比较** ⇒ 三条配对时 ok:true 而 apply 丢一条。
    // 🔴 同一个 bug 有两个版本，这里一次解掉：
    //   有 eg：一条 eg 的不同成员 → 不同目标
    //   无 eg：**同一个源成员**出现在两条 pairing、同方向 → 不同目标
    //         （P7，既有缺陷。面板主路径够不到，但导入配置够得到。）
    // 两者都是「同一个源键在这个方向上有两个互相矛盾的答案」，所以判据只写一次。
    // 🔴 WHICH DIRECTIONS ARE JUDGED (audit round 5, the heaviest finding).
    // A config can be sound in one direction and ambiguous in the other, and only
    // the caller knows which one is real:
    //   pair0: en Gotham/Book  <-> zh-CN SHS/Regular
    //   pair1: en Whitney/Book <-> zh-CN SHS/Normal      + eg: SHS Regular = Normal
    // Running en->zh-CN: both lines survive, nothing is lost — the zh-CN group is
    //   on the TARGET side, where it is physical normalisation (two Latin faces
    //   legitimately mapping onto one CJK face).
    // Running zh-CN->en: the two source spellings ARE one face, so they collide in
    //   buildCjkWeightMap and one line is dropped — a real loss (measured).
    // The same group is benign one way and lossy the other. Scanning every ordered
    // language pair therefore refused a config whose actual direction is fine —
    // and under 姿态甲 the operator has no un-merge to escape with.
    //
    // 🔴 `opts.directions` ([{source, target}, ...]) is how a caller says what it
    // actually runs: the importer knows it from `_meta`, the panel from its primary
    // language. When it is supplied ONLY those directions are judged.
    //
    // ⚠ DEFAULT IS UNCHANGED (every ordered pair) AND THAT IS DELIBERATE, not an
    // oversight: with no direction supplied, "silently accept a config that loses a
    // hand-drawn line in the direction someone might actually run" is the worse of
    // the two errors — the failure it guards is silent, the failure it causes is
    // loud and names the reason. Narrowing the default is a product call (it trades
    // a false refusal for a silent loss) and belongs with owner, not here.
    // No caller passes `directions` yet; wiring the panel and the importer is a
    // separate, mechanical change.
    if (Array.isArray(config.pairs)) {
        var _optDirs = (opts && Array.isArray(opts.directions)) ? opts.directions : null;
        var _dirLangs = Object.keys(config.fonts_by_language || {});
        var _seen = {};
        var _dirPairs = [];
        if (_optDirs) {
            _optDirs.forEach(function (d) {
                if (d && d.source && d.target) _dirPairs.push([d.source, d.target]);
            });
        } else {
            _dirLangs.forEach(function (a) {
                _dirLangs.forEach(function (b) { _dirPairs.push([a, b]); });
            });
        }
        _dirPairs.forEach(function (dp) {
            (function (srcLang, tgtLang) {
                if (_normLang(srcLang) === _normLang(tgtLang)) return;
                var rows = [];
                try { rows = projectByPairWithIndex(config.pairs, srcLang, tgtLang, config); }
                catch (eProj) { rows = []; }
                if (!rows || rows.length < 2) return;

                // group key = the eg the source member belongs to, or the member
                // itself when it is in no group. ONE loop, both versions.
                var buckets = {};
                rows.forEach(function (r) {
                    if (!r || !r.srcFont) return;
                    var key = r.srcFont + "|" + (r.srcWeight == null ? "Regular" : r.srcWeight);
                    var gi = _egIndexOfMember(srcLang, key);
                    var bk = (gi === null) ? ("member\u241F" + key) : ("eg\u241F" + gi);
                    if (!buckets[bk]) buckets[bk] = { grouped: gi !== null, rows: [] };
                    buckets[bk].rows.push({ key: key, dst: r.dstFont + "|" + r.dstWeight });
                });

                Object.keys(buckets).forEach(function (bk) {
                    var all = buckets[bk].rows;
                    if (all.length < 2) return;
                    var first = all[0], conflict = null;
                    for (var i = 1; i < all.length && !conflict; i++) {
                        if (all[i].dst !== first.dst) conflict = all[i];
                    }
                    if (!conflict) return;
                    // 🔴 Dedup on STRUCTURE, not on the message text (audit round 5,
                    // P8): the old key embedded the raw tgtLang, so `zh-CN` and
                    // `zh-Hans-CN` produced two texts for one contradiction.
                    var dk = bk + "\u241F" + _normLang(tgtLang) + "\u241F" +
                        [first.key, conflict.key].sort().join("\u241F") + "\u241F" +
                        [first.dst, conflict.dst].sort().join("\u241F");
                    if (_seen[dk]) return;
                    _seen[dk] = true;
                    errors.push(_egSplitMessage(buckets[bk].grouped, first, conflict, tgtLang));
                });
            })(dp[0], dp[1]);
        });
    }

    if (config.equivalence_groups !== undefined) {
        if (!Array.isArray(config.equivalence_groups)) {
            errors.push("equivalence_groups must be array");
        } else {
            config.equivalence_groups.forEach(function (eg, gi) {
                if (!eg || !eg.lang || !eg.canonical || !Array.isArray(eg.merged_in)) {
                    errors.push("equivalence_groups[" + gi + "] needs {lang, canonical, merged_in[]}");
                    return;
                }
                if (!eg.canonical.font || !eg.canonical.weight) {
                    errors.push("equivalence_groups[" + gi + "].canonical needs {font, weight}");
                }
                if (!fontsIndex[eg.lang]) {
                    errors.push("equivalence_groups[" + gi + "].lang=" + eg.lang + " not in fonts_by_language");
                    return;
                }
                var canonicalKey = eg.canonical.font + "|" + eg.canonical.weight;
                if (!fontsIndex[eg.lang][canonicalKey]) {
                    errors.push("equivalence_groups[" + gi + "].canonical references font not in fonts_by_language");
                }
                eg.merged_in.forEach(function (m, mi) {
                    if (!m || !m.font || !m.weight) {
                        errors.push("equivalence_groups[" + gi + "].merged_in[" + mi + "] needs {font, weight}");
                        return;
                    }
                    var key = m.font + "|" + m.weight;
                    if (!fontsIndex[eg.lang][key]) {
                        errors.push("equivalence_groups[" + gi + "].merged_in[" + mi + "] references font not in fonts_by_language[" + eg.lang + "]");
                    }
                });
            });
        }
    }

    return { ok: errors.length === 0, errors: errors };
}

// ---------------------------------------------------------------------------
// projectPairsForDirection — 把无向 pairs[] 按 (source, target) 投影成有向替换列表
// ---------------------------------------------------------------------------
// 返回 [{ from: {lang, font, weight}, to: {lang, font, weight}, via: 'preset' }]
// 一个 pair 里没有 source 或 target 语言成员 → 跳过
//
// 8D-ext-MM (III / r3#3): fan-out 双向 — source lang 每个成员各产一条 entry
// （source-keyed，无需 memberIdx；下游 detectUnmatchedItems 按 from.font|weight
// 建 presetMap，成员各自 distinct → 不互覆）。target 多成员 → 读
// representative_by_lang[target]。多成员 pair（任一侧 ≥2）的 dst MM-gated
// canonicalize（r3#2，只作用于 MM 行，不加宽非-MM 单成员 pair）。lang 匹配走
// _norm 两侧 canon（与 projectByPairWithIndex 同 B2 normalizer）。

function projectPairsForDirection(config, sourceLang, targetLang) {
    var out = [];
    if (!config || !Array.isArray(config.pairs)) return out;
    var _norm = require("./lang_script_table.js").normalizeBcp47Identity;
    var canonSrc = _norm(sourceLang);
    var canonTgt = _norm(targetLang);
    config.pairs.forEach(function (pair) {
        if (!pair || !Array.isArray(pair.members)) return;
        var srcMembers = [], tgtMembers = [];
        for (var i = 0; i < pair.members.length; i++) {
            var m = pair.members[i];
            var canonM = _norm(m.lang);
            if (canonM === canonSrc) srcMembers.push(m);
            if (canonM === canonTgt) tgtMembers.push(m);
        }
        if (srcMembers.length === 0 || tgtMembers.length === 0) return;
        // 单 dst：target 多成员 → 代表（rep 按匹配成员**自身** lang 取，config
        // canonical，不用可能 region/script-tagged 的 targetLang arg）。
        var dstFont, dstWeight;
        if (tgtMembers.length >= 2) {
            var rep = _repFor(pair, tgtMembers[0].lang);
            if (rep && rep.font && rep.weight) {
                dstFont = rep.font; dstWeight = rep.weight;
            } else {
                dstFont = tgtMembers[0].font; dstWeight = tgtMembers[0].weight;
            }
        } else {
            dstFont = tgtMembers[0].font; dstWeight = tgtMembers[0].weight;
        }
        var isMM = (srcMembers.length >= 2) || (tgtMembers.length >= 2);
        if (isMM) {
            var canonDst = getCanonical(config, targetLang, dstFont, dstWeight);
            dstFont = canonDst.font; dstWeight = canonDst.weight;
        }
        for (var mi = 0; mi < srcMembers.length; mi++) {
            out.push({
                from: { lang: srcMembers[mi].lang, font: srcMembers[mi].font, weight: srcMembers[mi].weight },
                to:   { lang: tgtMembers[0].lang,  font: dstFont,             weight: dstWeight },
                via: "preset"
            });
        }
    });
    return out;
}

// ---------------------------------------------------------------------------
// projectByPairWithIndex — 8D-ext-D 有向投影 adapter (r26 P2#1)
// ---------------------------------------------------------------------------
// projectPairsForDirection 输出 {from, to, via} 且丢 original pairIndex —
// 不满足 D byPair contract (skipDecisions / diagnostics 用 pairingId =
// original pairIndex 寻址, projection 后不可 reindex)。本 adapter 输出
// byPair shape + 保留 original index:
//   [{ pairingId, memberIdx, srcFont, srcWeight, dstFont, dstWeight, srcLang, dstLang }]
// importer (import_translations_v2 / import_integrated) + M3 panel 共享同一
// adapter (r26 P3)。
//
// 8D-ext-MM (III / r4.1 #1): fan-out + 读代表 + MM-gated dst canonicalize。
// 新增 4th 参 `config`（供 getCanonical 用 equivalence_groups）。
//   - source lang **每个**成员各产**一条** entry（废 last-write-wins = 丢非末
//     src 字重的 silent data loss）。
//   - target 多成员 → dst = representative_by_lang[target]；单成员 → 该成员。
//   - 多成员 pair（任一侧 ≥2 = isMM）的 dst 走 getCanonical 物理归一（r3#2，
//     gated 到 MM 行，不加宽非-MM 单成员 pair 的 merged_in-dst pre-existing 分歧）。
//   - fan-out 行加 `memberIdx`（diagnostic/preview ONLY，**绝不**进 skip 键）。
//     一 pairing 的所有 fan-out 行共享 pairingId + dstLang（单 targetLang →
//     dstLang 恒同）→ 共享 2-part skip 键 `pairingId|dstLang`（group-level skip，
//     与 resolve:428 / sweep skip-parser 的 2-part 契约一致；C r4 不变量）。

function projectByPairWithIndex(pairs, sourceLang, targetLang, config) {
    var out = [];
    if (!Array.isArray(pairs)) return out;
    // 8D-ext-D step-3a (the A-class the B2 verification round surfaced):
    // sourceLang/targetLang arrive RAW from _meta (region/script-bearing, e.g.
    // "en-US" / "zh-Hans-CN") while config member langs are canonical
    // ("en" / "zh-CN", per B2 "canonical end-to-end"). A raw `m.lang ===
    // sourceLang` compares "en" against "en-US" → no match → empty projection
    // → byPair no-op → import saves wrong fonts with no error. Canonicalize
    // BOTH sides of the match via the B2 normalizer, and emit canonical
    // srcLang/dstLang so the produced byPair is canonical from birth.
    var _norm = require("./lang_script_table.js").normalizeBcp47Identity;
    var canonSrc = _norm(sourceLang);
    var canonTgt = _norm(targetLang);
    for (var pi = 0; pi < pairs.length; pi++) {
        var pair = pairs[pi];
        if (!pair || !Array.isArray(pair.members)) continue;
        // III: collect ALL src members (was last-write-wins → kept末成员).
        var srcMembers = [];
        for (var i = 0; i < pair.members.length; i++) {
            var m = pair.members[i];
            if (_norm(m.lang) === canonSrc) srcMembers.push(m);
        }
        if (srcMembers.length === 0) continue;
        // 单 dst：rep-or-sole + canonicalize-always — EXTRACTED to
        // effectiveTargetWeight so the dst derivation has ONE SoT shared with any
        // emit-time consumer. Byte-identical to the old inline block — getCanonical
        // internally _norm()s its lang arg, so passing canonTgt here == passing raw
        // targetLang before.
        var eff = effectiveTargetWeight(pair, canonTgt, config);
        if (!eff) continue;   // no target member for this lang → skip pair
        var dstFont = eff.font, dstWeight = eff.weight, dstLang = eff.dstLang;
        // fan-out: ONE entry per source member.
        for (var mi = 0; mi < srcMembers.length; mi++) {
            out.push({
                pairingId: pi,    // original pairIndex — NEVER reindexed
                memberIdx: mi,    // diagnostic/preview ONLY — NEVER in skip key
                srcFont: srcMembers[mi].font, srcWeight: srcMembers[mi].weight,
                dstFont: dstFont,             dstWeight: dstWeight,
                srcLang: _norm(srcMembers[mi].lang), dstLang: dstLang
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// effectiveTargetWeight — the EFFECTIVE (font, weight) a pair maps a target
// lang to: rep-or-sole selection + canonicalize-always.
// ---------------------------------------------------------------------------
// EXTRACTED from projectByPairWithIndex (was inline) so the byPair dst derivation
// has ONE SoT — emit-time-derive, NOT a stale create-time snapshot. Behavior is
// byte-identical to the old inline block (existing pairs/resolve tests pin it).
//
//   • tgtMembers = pair members whose lang canonicalizes to `canonTgtLang`.
//   • ≥2 same-lang members → representative_by_lang[tgtMembers[0].lang] (the matched
//     member's OWN config-canonical lang, NOT the possibly region/script-tagged arg);
//     falls back to the first matched member if the rep is missing/invalid. 1 → that one.
//   • dst then runs getCanonical for EVERY pair (MM AND non-MM) — equivalence_groups is
//     PHYSICAL normalization (merged_in replaced by canonical at apply); idempotent for
//     already-canonical configs. The old `isMM &&` gate was a cardinality-dependent
//     contract drift (UNIFY-converge Phase 1 A-block ②).
//
// @param {object} pair          one config.pairs[] entry
// @param {string} canonTgtLang  canonical target lang code (caller normalizes)
// @param {object} [config]      brand config (for getCanonical equivalence_groups)
// @returns {{font, weight, dstLang}|null} null when the pair has no member for the
//   target lang (caller skips). dstLang = the matched member's canonical lang.
function effectiveTargetWeight(pair, canonTgtLang, config) {
    if (!pair || !Array.isArray(pair.members)) return null;
    var _norm = require("./lang_script_table.js").normalizeBcp47Identity;
    var tgtMembers = [];
    for (var i = 0; i < pair.members.length; i++) {
        if (_norm(pair.members[i].lang) === canonTgtLang) tgtMembers.push(pair.members[i]);
    }
    if (tgtMembers.length === 0) return null;
    var dstFont, dstWeight;
    if (tgtMembers.length >= 2) {
        var rep = _repFor(pair, tgtMembers[0].lang);
        if (rep && rep.font && rep.weight) {
            dstFont = rep.font; dstWeight = rep.weight;
        } else {
            dstFont = tgtMembers[0].font; dstWeight = tgtMembers[0].weight;
        }
    } else {
        dstFont = tgtMembers[0].font; dstWeight = tgtMembers[0].weight;
    }
    if (config) {
        var canonDst = getCanonical(config, canonTgtLang, dstFont, dstWeight);
        dstFont = canonDst.font; dstWeight = canonDst.weight;
    }
    return { font: dstFont, weight: dstWeight, dstLang: _norm(tgtMembers[0].lang) };
}

// ---------------------------------------------------------------------------
// getCanonical — 给定 (lang, font, weight)，查 equivalence_groups 返回 canonical
// ---------------------------------------------------------------------------
// 如果该 (font, weight) 在某 equivalence_groups 的 merged_in[] 里 → 返回 canonical
// 否则返回原 (font, weight)
//
// 这是物理规范化语义：apply 时 merged_in 字体被实际替换为 canonical

function getCanonical(config, lang, font, weight) {
    if (!config || !Array.isArray(config.equivalence_groups)) {
        return { font: font, weight: weight };
    }
    // step-3a audit P2: canonicalize BOTH sides of the lang compare (same B2
    // normalizer as projectByPairWithIndex). resolve's equivalence fallback
    // passes canonical srcLang; a raw `eg.lang !== lang` against a config
    // authored as e.g. "zh-Hans-CN" never matches canonical "zh-CN" → alias
    // fonts silently not canonicalized. Idempotent — no-op for
    // already-canonical configs.
    var _norm = require("./lang_script_table.js").normalizeBcp47Identity;
    var canonLang = _norm(lang);
    for (var i = 0; i < config.equivalence_groups.length; i++) {
        var eg = config.equivalence_groups[i];
        if (_norm(eg.lang) !== canonLang) continue;
        for (var j = 0; j < eg.merged_in.length; j++) {
            var m = eg.merged_in[j];
            if (m.font === font && m.weight === weight) {
                return { font: eg.canonical.font, weight: eg.canonical.weight, normalized_from: { font: font, weight: weight } };
            }
        }
    }
    return { font: font, weight: weight };
}

// ---------------------------------------------------------------------------
// findEquivalenceGroup — 找包含某 (lang, font, weight) 的 equivalence_group
// ---------------------------------------------------------------------------
// 返回 group 或 null。canonical 项也算 group 成员（自己是 canonical）。

function findEquivalenceGroup(config, lang, font, weight) {
    if (!config || !Array.isArray(config.equivalence_groups)) return null;
    // step-3a audit sweep-completion: same both-sides canonicalize as
    // getCanonical above — exported API (step-4 panel path may consume it),
    // same producer/consumer asymmetry. Idempotent for canonical configs.
    var _norm = require("./lang_script_table.js").normalizeBcp47Identity;
    var canonLang = _norm(lang);
    for (var i = 0; i < config.equivalence_groups.length; i++) {
        var eg = config.equivalence_groups[i];
        if (_norm(eg.lang) !== canonLang) continue;
        if (eg.canonical.font === font && eg.canonical.weight === weight) return eg;
        for (var j = 0; j < eg.merged_in.length; j++) {
            var m = eg.merged_in[j];
            if (m.font === font && m.weight === weight) return eg;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// getPreferredWeight — 返回某语言的 preferred_weight（缺省 "regular"）
// ---------------------------------------------------------------------------

function getPreferredWeight(config, lang) {
    if (!config || !config.preferred_per_language) return "regular";
    var pref = config.preferred_per_language[lang];
    return (pref && pref.preferred_weight) || "regular";
}

// ---------------------------------------------------------------------------
// getFallbackChain — 返回某语言的字体 fallback_chain（缺省 []）
// ---------------------------------------------------------------------------

function getFallbackChain(config, lang) {
    if (!config || !config.fallback_chains) return [];
    var chain = config.fallback_chains[lang];
    return Array.isArray(chain) ? chain.slice() : [];
}

// ---------------------------------------------------------------------------
// normalizeWeight — 用 weight_aliases 规范化字重词（如 "semibold" → "bold"）
// ---------------------------------------------------------------------------
// 仅用于 Edit UI 预填模糊匹配。运行时按 pair 显式映射，不走 normalize。
//
// 例：weight_aliases = { bold: ["bold", "semibold", "demibold"] }
//     normalizeWeight(config, "Semibold") → "bold"
// 命中则返回 alias 组的 canonical key（这里 "bold"）；未命中返回原值。

function normalizeWeight(config, weight) {
    if (!config || !config.weight_aliases) return weight;
    var w = String(weight).toLowerCase();
    var keys = Object.keys(config.weight_aliases);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var aliases = config.weight_aliases[key];
        if (!Array.isArray(aliases)) continue;
        for (var j = 0; j < aliases.length; j++) {
            if (String(aliases[j]).toLowerCase() === w) return key;
        }
    }
    return weight;
}

// ---------------------------------------------------------------------------
// mmMemberKeySet — 8D-ext-MM step 5: the (font|weight) keys that are MM
// multi-member members for `lang`
// ---------------------------------------------------------------------------
// A member is an "MM multi-member" iff its lang has ≥2 members in the SAME pair
// (one lang → multiple weights fan-in). These are exactly the keys that:
//   • trip validateBrandConfig II-d when ALSO an equivalence_groups merged_in
//     (A/MM overlap), and
//   • A.1 twin-fold must SKIP — explicit MM intent owns the weight, A.1 must
//     never (re-)fold it (the A.1 side of the bidirectional remediation).
// SCOPE: this helper is the Node-testable MIRROR of the panel's inline
// `mmFoldSkipByLang` key logic (app.jsx) — it pins the key rule under unit test.
// It is NOT a live production gate: the runtime A.1↔MM path uses the panel's own
// inline computation, and validateBrandConfig computes II-d independently. Only
// the test suite calls this. Pure. Returns { "font|weight": true } (same key
// form the validator's mergedInIndex uses, so the two domains compare
// like-for-like).
function mmMemberKeySet(pairs, lang) {
    var set = {};
    (pairs || []).forEach(function (pair) {
        if (!pair || !Array.isArray(pair.members)) return;
        var inLang = pair.members.filter(function (m) {
            return m && m.lang === lang && m.font && m.weight;
        });
        if (inLang.length < 2) return;
        inLang.forEach(function (m) { set[m.font + "|" + m.weight] = true; });
    });
    return set;
}

// ---------------------------------------------------------------------------
// groupByPairKey — collapse fan-out byPair entries to one row per pairing
// ---------------------------------------------------------------------------
// 8D-ext-MM step 2 made projectByPairWithIndex FAN OUT: an MM pairing emits N
// entries (one per source member), all sharing the GROUP-level skip key
// `pairingId|dstLang` (the resolver skips the whole group, not a single row).
// Preview surfaces care about the (pairingId, dstLang) GROUP, not the row:
//   • the skip checkbox must be ONE per group — checking it skips all N rows;
//     N separate checkboxes would let one stay "checked" while the siblings
//     read "unchecked" yet ALL get skipped (the UI would lie about scope).
//   • the honest "pairing-direction count" is the group count, NOT
//     byPair.length (rows overstate the pairing count for MM fan-outs).
// Returns [{ key, pairingId, dstLang, dstFont, dstWeight,
//   srcWeights:[{srcFont, srcWeight, srcLang, memberIdx}] }] in first-seen
// order. `key` uses the SAME `pairingId|dstLang` form as buildSkipKey so a
// caller can feed it straight into the skip-decision map. Non-MM 1:1 pairings
// yield a group with exactly one srcWeight (renders identically to before).
// Pure. Does NOT touch the projection or the skip-key contract.
function groupByPairKey(byPair) {
    var groups = [];
    var index = {};
    if (!Array.isArray(byPair)) return groups;
    for (var i = 0; i < byPair.length; i++) {
        var e = byPair[i];
        if (!e) continue;
        var key = String(e.pairingId) + "|" + String(e.dstLang);
        var g = index[key];
        if (!g) {
            g = {
                key: key,
                pairingId: e.pairingId,
                dstLang: e.dstLang,
                dstFont: e.dstFont,
                dstWeight: e.dstWeight,
                srcWeights: []
            };
            index[key] = g;
            groups.push(g);
        }
        g.srcWeights.push({
            srcFont: e.srcFont,
            srcWeight: e.srcWeight,
            srcLang: e.srcLang,
            memberIdx: e.memberIdx
        });
    }
    return groups;
}

// ---------------------------------------------------------------------------
// buildCjkWeightMap / makeCjkWeightLookup — TODO#15 ② pair-authoritative CJK weight
// ---------------------------------------------------------------------------
// The translation-mode style builder (style_sheet_builder resolvedCjkStyle) used
// to RANK-MAP the SOURCE Latin weight to the nearest installed CJK weight
// (Semibold→Bold, Medium→Medium), silently dropping the brand_config pair's
// EXPLICIT CJK target (Semibold→Xbold, Medium→Bold). Cross-font weight carries no
// intrinsic rank correspondence — rank-nearest is an invalid model. The pair IS
// the authority (user ground truth, 2026-06-22); rank survives only as a SURFACED
// fallback when a (src font, src weight) is in NO pair.
//
// buildCjkWeightMap folds the PROJECTED byPair (projectByPairWithIndex rows —
// directional, dst already getCanonical-normalized) into a flat lookup keyed by
// the RAW pair src member (font, weight) PLUS every equivalence_groups alias of
// that src, so a doc baseline authored in the preferred-family naming (e.g.
// "Whitney Semibold"/"Regular") still resolves to the canonical src's pair.
// First-write-wins (deterministic w.r.t. projection order). Pure / Node-testable.
//
//   byPair — projectByPairWithIndex(...) rows. [] / non-array → {}.
//   config — brand config (equivalence_groups alias expansion). Optional.
// @returns { "<font>␟<weight>": { dstFont, dstWeight, srcFont, srcWeight, pairingId } }
var CJK_WEIGHT_MAP_SEP = "␟";

function buildCjkWeightMap(byPair, config) {
    var map = {};
    var bp = Array.isArray(byPair) ? byPair : [];
    function put(font, weight, val) {
        if (!font) return;
        var k = String(font) + CJK_WEIGHT_MAP_SEP + String(weight == null ? "Regular" : weight);
        if (!Object.prototype.hasOwnProperty.call(map, k)) map[k] = val;
    }
    for (var i = 0; i < bp.length; i++) {
        var e = bp[i];
        if (!e || !e.srcFont || !e.dstWeight) continue;
        var val = {
            dstFont: e.dstFont, dstWeight: e.dstWeight,
            srcFont: e.srcFont, srcWeight: e.srcWeight,
            pairingId: e.pairingId
        };
        put(e.srcFont, e.srcWeight, val);
        // equivalence aliases: merged_in fonts are physically the same glyphs at
        // apply, so they share the canonical src's CJK pair target.
        var eg = findEquivalenceGroup(config, e.srcLang, e.srcFont, e.srcWeight);
        if (eg) {
            if (eg.canonical) put(eg.canonical.font, eg.canonical.weight, val);
            if (Array.isArray(eg.merged_in)) {
                for (var j = 0; j < eg.merged_in.length; j++) {
                    if (eg.merged_in[j]) put(eg.merged_in[j].font, eg.merged_in[j].weight, val);
                }
            }
        }
    }
    return map;
}

// makeCjkWeightLookup — returns fn(srcFont, srcStyle) → pair entry | null. Tries
// the exact (font, style) key, then an italic-stripped key (CJK weights carry no
// italic — the synthetic slant is handled separately by the builder's skew prop,
// so an italic source weight maps to the same CJK target as its upright form).
// Keeps ALL pair-matching logic in the pairs module so the style builder stays a
// dumb consumer (no separator / equivalence knowledge).
function makeCjkWeightLookup(byPair, config) {
    var map = buildCjkWeightMap(byPair, config);
    function stripItalic(s) {
        return String(s == null ? "" : s)
            .replace(/italic/ig, "").replace(/oblique/ig, "").replace(/\s+/g, " ").trim();
    }
    return function (srcFont, srcStyle) {
        if (!srcFont) return null;
        var f = String(srcFont);
        var s = String(srcStyle == null ? "Regular" : srcStyle);
        var k1 = f + CJK_WEIGHT_MAP_SEP + s;
        if (Object.prototype.hasOwnProperty.call(map, k1)) return map[k1];
        var ws = stripItalic(s);
        if (ws && ws !== s) {
            var k2 = f + CJK_WEIGHT_MAP_SEP + ws;
            if (Object.prototype.hasOwnProperty.call(map, k2)) return map[k2];
        }
        return null;
    };
}

// ---------------------------------------------------------------------------
// makeCjkEmphasisWeightResolver — TODO#15 ② extended to the EMPHASIS apply path
// ---------------------------------------------------------------------------
// The baseline path (style_sheet_builder.resolvedCjkStyle) resolves a paragraph's
// SOURCE Latin weight to the brand CJK weight via makeCjkWeightLookup(srcFont,
// srcStyle). The EMPHASIS apply path (style_applier._applyDiffToRange) has only
// the range's CURRENT (already-mapped) CJK family + the SOURCE weight name the
// run carries (e.g. "Semibold") — it lost the source Latin font. Without pair
// translation it composes "<cjkFamily>\t<srcWeight>" (e.g. "MHei PRC\tSemibold"),
// which is NOT a real face, so InDesign / the BRIDGE-17 missing-font remap
// silently DOWNGRADES it one notch (MHei Semibold→Bold) — violating the brand
// policy where Semibold↔Xbold is the authoritative pair.
//
// This indexes the pair map by (DST cjk font ␟ SRC weight) → DST weight, so the
// emphasis path can recover the brand target from just (currentCjkFamily,
// srcWeight). First-write-wins (same determinism as buildCjkWeightMap). Italic is
// stripped for the weight key (CJK slant is synthetic skew, handled separately).
// Returns fn(cjkFamily, srcStyle) → brand dstWeight | null (null → caller keeps
// its current behavior; fail-open). Pure / Node-testable.
function makeCjkEmphasisWeightResolver(byPair, config) {
    var map = buildCjkWeightMap(byPair, config);
    var byDst = {}; // "<dstFont>␟<srcWeight>" → dstWeight (first-write-wins)
    for (var k in map) {
        if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
        var v = map[k];
        if (!v || !v.dstFont || !v.dstWeight) continue;
        var dk = String(v.dstFont) + CJK_WEIGHT_MAP_SEP +
            String(v.srcWeight == null ? "Regular" : v.srcWeight);
        if (!Object.prototype.hasOwnProperty.call(byDst, dk)) byDst[dk] = v.dstWeight;
    }
    function stripItalic(s) {
        return String(s == null ? "" : s)
            .replace(/italic/ig, "").replace(/oblique/ig, "").replace(/\s+/g, " ").trim();
    }
    return function (cjkFamily, srcStyle) {
        if (!cjkFamily) return null;
        var f = String(cjkFamily);
        var s = String(srcStyle == null ? "Regular" : srcStyle);
        var dk1 = f + CJK_WEIGHT_MAP_SEP + s;
        if (Object.prototype.hasOwnProperty.call(byDst, dk1)) return byDst[dk1];
        var ws = stripItalic(s);
        if (ws && ws !== s) {
            var dk2 = f + CJK_WEIGHT_MAP_SEP + ws;
            if (Object.prototype.hasOwnProperty.call(byDst, dk2)) return byDst[dk2];
        }
        return null;
    };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
    validateBrandConfig: validateBrandConfig,
    projectPairsForDirection: projectPairsForDirection,
    projectByPairWithIndex: projectByPairWithIndex,
    effectiveTargetWeight: effectiveTargetWeight,
    getCanonical: getCanonical,
    findEquivalenceGroup: findEquivalenceGroup,
    getPreferredWeight: getPreferredWeight,
    getFallbackChain: getFallbackChain,
    normalizeWeight: normalizeWeight,
    mmMemberKeySet: mmMemberKeySet,
    groupByPairKey: groupByPairKey,
    buildCjkWeightMap: buildCjkWeightMap,
    makeCjkWeightLookup: makeCjkWeightLookup,
    makeCjkEmphasisWeightResolver: makeCjkEmphasisWeightResolver
};
