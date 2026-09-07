"use strict";

// lib/font_mapping_ops.js — Phase 8D Edit UI 业务算法（A 层移植自 prototype）
//
// pure-function 风格的 (config, args) → newConfig 操作，无副作用、无 React /
// DOM 依赖。UI 视觉层（C 层）独立实现时直接 import 这些 ops 处理 state mutation。
//
// 设计参考 docs/字体映射面板/ prototype 的 app.jsx applyMerge / applyReorder
// / applyPair 等算法语义。schema 改成 Phase 8D 字符串 key 引用（lang/font/
// weight 直接用 string），而非 prototype 的 uid。
//
// 配套：lib/font_mapping_pairs.js（schema 校验 + 配对引擎）。

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _deepClone(o) {
    return JSON.parse(JSON.stringify(o));
}

function _ensureLang(config, lang) {
    if (!config.fonts_by_language) config.fonts_by_language = {};
    if (!config.fonts_by_language[lang]) config.fonts_by_language[lang] = [];
}

function _findFontIdx(fonts, font, weight) {
    for (var i = 0; i < fonts.length; i++) {
        if (fonts[i].font === font && fonts[i].weight === weight) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Language ops
// ---------------------------------------------------------------------------

function addLanguage(config, lang) {
    var next = _deepClone(config || {});
    _ensureLang(next, lang);
    return next;
}

function removeLanguage(config, lang) {
    var next = _deepClone(config || {});
    if (next.fonts_by_language && next.fonts_by_language[lang]) {
        delete next.fonts_by_language[lang];
    }
    if (next.preferred_per_language && next.preferred_per_language[lang]) {
        delete next.preferred_per_language[lang];
    }
    if (next.fallback_chains && next.fallback_chains[lang]) {
        delete next.fallback_chains[lang];
    }
    // 清理 pairs 里该 lang 的成员，少于 2 成员的 pair 删除。8D-ext-MM step 4: 保留
    // pair 对象（含 representative_by_lang）— 原先 map 成 {members} 会丢 rep；改为就地
    // 过滤 members + _normalizeReps（删掉该 lang 残留 rep + 重导其它多成员 lang 代表）。
    if (Array.isArray(next.pairs)) {
        next.pairs = next.pairs.filter(function (p) {
            p.members = p.members.filter(function (m) { return m.lang !== lang; });
            return p.members.length >= 2;
        });
        next.pairs.forEach(_normalizeReps);
    }
    // 清理 equivalence_groups 里该 lang 的条目
    if (Array.isArray(next.equivalence_groups)) {
        next.equivalence_groups = next.equivalence_groups.filter(function (eg) { return eg.lang !== lang; });
    }
    return next;
}

// ---------------------------------------------------------------------------
// Font / weight ops
// ---------------------------------------------------------------------------

function addFontWeight(config, lang, font, weight) {
    var next = _deepClone(config || {});
    _ensureLang(next, lang);
    if (_findFontIdx(next.fonts_by_language[lang], font, weight) < 0) {
        next.fonts_by_language[lang].push({ font: font, weight: weight });
    }
    return next;
}

function removeFontWeight(config, lang, font, weight) {
    var next = _deepClone(config || {});
    if (!next.fonts_by_language || !next.fonts_by_language[lang]) return next;
    next.fonts_by_language[lang] = next.fonts_by_language[lang].filter(function (fw) {
        return !(fw.font === font && fw.weight === weight);
    });
    // 清理 pairs 里 references。8D-ext-MM step 4: 保留 pair 对象（含 rep）；就地过滤 +
    // _normalizeReps —— 若被删的是某 MM lang 的 first-connected 代表，归一会重导到下一个
    // 有效成员（否则孤儿 rep → lenient cross-ref reject → panelDataToConfig ok:false）。
    if (Array.isArray(next.pairs)) {
        next.pairs = next.pairs.filter(function (p) {
            p.members = p.members.filter(function (m) {
                return !(m.lang === lang && m.font === font && m.weight === weight);
            });
            return p.members.length >= 2;
        });
        next.pairs.forEach(_normalizeReps);
    }
    // 清理 equivalence_groups
    if (Array.isArray(next.equivalence_groups)) {
        next.equivalence_groups = next.equivalence_groups
            .map(function (eg) {
                if (eg.lang !== lang) return eg;
                // canonical 被删 → 整组废
                if (eg.canonical.font === font && eg.canonical.weight === weight) return null;
                // merged_in 被删 → 过滤
                var filtered = eg.merged_in.filter(function (m) {
                    return !(m.font === font && m.weight === weight);
                });
                return { lang: eg.lang, canonical: eg.canonical, merged_in: filtered };
            })
            .filter(function (eg) { return eg !== null; });
    }
    return next;
}

// ---------------------------------------------------------------------------
// Equivalence group ops (字体等价类 — 物理规范化)
// ---------------------------------------------------------------------------

// 把 mergedIn[] = [{font, weight}, ...] 合并到 canonical = {font, weight}
// 同 lang 下。如果某 mergedIn 项已在另一 group 里，先从那 group 移除。
// 如果 canonical 自己已在某 group 里作 merged_in，先把它从那提为 canonical。
function mergeWeights(config, lang, canonical, mergedIn) {
    var next = _deepClone(config || {});
    // 本地副本：下方会向 mergedIn push 吸收进来的成员，不能改 caller 的数组
    // （pure-function 契约对所有入参成立，不只 config — 见 Finding 2）。
    mergedIn = (mergedIn || []).slice();
    if (!Array.isArray(next.equivalence_groups)) next.equivalence_groups = [];

    // 先把 canonical / mergedIn 项从已有 groups 拆出来
    var allTargets = [canonical].concat(mergedIn);
    next.equivalence_groups = next.equivalence_groups
        .map(function (eg) {
            if (eg.lang !== lang) return eg;
            // canonical 被吸收 → 整组转入新 canonical
            var canonicalAbsorbed = allTargets.some(function (t) {
                return t.font === eg.canonical.font && t.weight === eg.canonical.weight;
            });
            if (canonicalAbsorbed) {
                // 原 canonical + 原 merged_in 都加入到新 mergedIn 候选里
                eg.merged_in.forEach(function (m) {
                    if (!mergedIn.some(function (x) { return x.font === m.font && x.weight === m.weight; })
                        && !(canonical.font === m.font && canonical.weight === m.weight)) {
                        mergedIn.push(m);
                    }
                });
                if (!(canonical.font === eg.canonical.font && canonical.weight === eg.canonical.weight)
                    && !mergedIn.some(function (x) { return x.font === eg.canonical.font && x.weight === eg.canonical.weight; })) {
                    mergedIn.push(eg.canonical);
                }
                return null;
            }
            // 否则只过滤掉 mergedIn 项
            eg.merged_in = eg.merged_in.filter(function (m) {
                return !mergedIn.some(function (x) { return x.font === m.font && x.weight === m.weight; });
            });
            return eg.merged_in.length > 0 ? eg : null;
        })
        .filter(function (eg) { return eg !== null; });

    // 加新 group
    next.equivalence_groups.push({
        lang: lang,
        canonical: { font: canonical.font, weight: canonical.weight },
        merged_in: mergedIn.map(function (m) { return { font: m.font, weight: m.weight }; })
    });

    return next;
}

// 从某 group 拆出一个成员（变独立 weight）
// member 可以是 canonical 或 merged_in 项。
function unmergeWeight(config, lang, member) {
    var next = _deepClone(config || {});
    if (!Array.isArray(next.equivalence_groups)) return next;
    next.equivalence_groups = next.equivalence_groups
        .map(function (eg) {
            if (eg.lang !== lang) return eg;
            // canonical 被拆 → 选第一个 merged_in 项作新 canonical
            if (eg.canonical.font === member.font && eg.canonical.weight === member.weight) {
                if (eg.merged_in.length === 0) return null;
                var newCanonical = eg.merged_in[0];
                var newMergedIn = eg.merged_in.slice(1);
                if (newMergedIn.length === 0) return null;  // 不足成等价类
                return { lang: eg.lang, canonical: newCanonical, merged_in: newMergedIn };
            }
            // merged_in 项被拆 → 过滤
            var filtered = eg.merged_in.filter(function (m) {
                return !(m.font === member.font && m.weight === member.weight);
            });
            if (filtered.length === 0) return null;  // 仅剩 canonical 不构成等价类，废
            return { lang: eg.lang, canonical: eg.canonical, merged_in: filtered };
        })
        .filter(function (eg) { return eg !== null; });
    return next;
}

// 修改 canonical（用 group 里某 merged_in 项作新 canonical，原 canonical 进 merged_in）
function setCanonical(config, lang, groupCanonical, newCanonical) {
    var next = _deepClone(config || {});
    if (!Array.isArray(next.equivalence_groups)) return next;
    for (var i = 0; i < next.equivalence_groups.length; i++) {
        var eg = next.equivalence_groups[i];
        if (eg.lang !== lang) continue;
        if (eg.canonical.font !== groupCanonical.font || eg.canonical.weight !== groupCanonical.weight) continue;
        // 找 newCanonical 在 merged_in 里
        var nIdx = -1;
        for (var j = 0; j < eg.merged_in.length; j++) {
            if (eg.merged_in[j].font === newCanonical.font && eg.merged_in[j].weight === newCanonical.weight) {
                nIdx = j; break;
            }
        }
        if (nIdx < 0) continue;
        var oldCanonical = eg.canonical;
        eg.canonical = { font: newCanonical.font, weight: newCanonical.weight };
        eg.merged_in.splice(nIdx, 1);
        eg.merged_in.push(oldCanonical);
        break;
    }
    return next;
}

// ---------------------------------------------------------------------------
// Pair ops (跨语言 pairs — 无向)
// ---------------------------------------------------------------------------

function _addrEq(a, b) {
    return a.lang === b.lang && a.font === b.font && a.weight === b.weight;
}

// Phase 8D-ext-MM step 4: representative_by_lang 不变量的**单一归一化例程**。
// 每次 pair 突变（create / merge / 任何 removal）后都调用，保持以下不变量：
//   对每个 lang —— rep 存在 IFF 该 lang 在本 pair 有 ≥2 成员，且 rep.{font,weight}
//   等于该 lang 的某个成员（默认 first-connected = members[] 中最早出现者；保留 user
//   已设的有效选择）。≤1 成员 / 已移除的 lang 必须**无** rep 键。
// validateBrandConfig (II-a/b/c) 要求多成员 lang 必带 rep 且代表是成员；≤1 成员 lang
// 的残留 rep 会触发 lenient cross-ref reject（孤儿 rep 指向已删字体）→ 故必须 prune。
function _normalizeReps(pair) {
    if (!pair || !Array.isArray(pair.members)) return;
    // 按 lang 分组（保持 members[] 插入顺序 → mems[0] = first-connected）
    var byLang = {};
    for (var i = 0; i < pair.members.length; i++) {
        var m = pair.members[i];
        if (!byLang[m.lang]) byLang[m.lang] = [];
        byLang[m.lang].push(m);
    }
    var rbl = pair.representative_by_lang;
    // 1) PRUNE: 删掉 ≤1 成员（含零成员 = 该 lang 已不在 pair）的 rep 键
    if (rbl && typeof rbl === "object") {
        Object.keys(rbl).forEach(function (lang) {
            var mems = byLang[lang];
            if (!mems || mems.length < 2) delete rbl[lang];
        });
    }
    // 2) SET/KEEP: ≥2 成员 lang 设/保 first-connected 有效代表（缺失或代表已非成员 → 重导出）
    Object.keys(byLang).forEach(function (lang) {
        var mems = byLang[lang];
        if (mems.length < 2) return;
        if (!pair.representative_by_lang) pair.representative_by_lang = {};
        var rep = pair.representative_by_lang[lang];
        var valid = rep && rep.font && rep.weight && mems.some(function (m) {
            return m.font === rep.font && m.weight === rep.weight;
        });
        if (!valid) {
            pair.representative_by_lang[lang] = { font: mems[0].font, weight: mems[0].weight };
        }
    });
    // 3) 容器空了就删（保持 config 最小 + round-trip 干净）
    if (pair.representative_by_lang && Object.keys(pair.representative_by_lang).length === 0) {
        delete pair.representative_by_lang;
    }
}

function _findPairByMember(config, addr) {
    if (!Array.isArray(config.pairs)) return -1;
    for (var i = 0; i < config.pairs.length; i++) {
        var p = config.pairs[i];
        for (var j = 0; j < p.members.length; j++) {
            if (_addrEq(p.members[j], addr)) return i;
        }
    }
    return -1;
}

// W2 — createPair is the ONE writer in this repo that could push a pair member
// without registering it in fonts_by_language, i.e. the only structural producer of
// a member no panel node can be built for (every other writer already ensures the
// roster: addPairMember:472-483 and addPairToConfig's _ensureFontRegistered). It is
// currently dead in production — the only callers are tests — so this is a guard
// rail, not a bug fix: validateBrandConfig:106-110 requires members to cross-ref the
// roster, so a config built through here would fail its own validator.
// Applied ONLY where a member is actually pushed; the no-op/degenerate branches
// (already paired, exact duplicate, addrA === addrB) must not write a roster entry
// for a pair they decline to create.
function _ensureRosterEntry(config, addr) {
    if (!addr || !addr.lang || !addr.font || !addr.weight) return;
    _ensureLang(config, addr.lang);
    if (_findFontIdx(config.fonts_by_language[addr.lang], addr.font, addr.weight) < 0) {
        config.fonts_by_language[addr.lang].push({ font: addr.font, weight: addr.weight });
    }
}

// 创建一个 pair（addrA, addrB 跨语言成员）。
// 行为同 prototype applyPair：
//   - 两者都已在同一 pair → no-op
//   - 都在不同 pair → 合并两个 pair
//   - 一方在 pair → 另一方加入该 pair
//   - 都未在 pair → 新建 pair
function createPair(config, addrA, addrB) {
    var next = _deepClone(config || {});
    if (!Array.isArray(next.pairs)) next.pairs = [];

    var pa = _findPairByMember(next, addrA);
    var pb = _findPairByMember(next, addrB);

    if (pa >= 0 && pb >= 0 && pa === pb) return next;
    if (pa >= 0 && pb >= 0) {
        // 8D-ext-MM step 4: 合并两 pair，去掉 EXACT-duplicate 成员（幂等），
        // 同 lang 多成员**允许**（不再放弃合并）。合并后自动落 first-connected 代表。
        // codex P1 reverse-index fix: capture the merged pair by REFERENCE before
        // splice. If pb < pa, splice(pb,1) shifts the merged pair's index down by
        // one → next.pairs[pa] would point at the wrong pair (or undefined).
        var mergedPair = next.pairs[pa];
        var mergedMembers = mergedPair.members.concat(
            next.pairs[pb].members.filter(function (m) {
                return !mergedPair.members.some(function (x) { return _addrEq(x, m); });
            })
        );
        mergedPair.members = mergedMembers;
        next.pairs.splice(pb, 1);
        _normalizeReps(mergedPair);
        return next;
    }
    if (pa >= 0) {
        // EXACT-duplicate 成员 → no-op（幂等）。同 lang 不同 {font,weight} → 允许 MM。
        if (next.pairs[pa].members.some(function (x) { return _addrEq(x, addrB); })) return next;
        next.pairs[pa].members.push({ lang: addrB.lang, font: addrB.font, weight: addrB.weight });
        _ensureRosterEntry(next, addrB);          // W2
        _normalizeReps(next.pairs[pa]);
        return next;
    }
    if (pb >= 0) {
        if (next.pairs[pb].members.some(function (x) { return _addrEq(x, addrA); })) return next;
        next.pairs[pb].members.push({ lang: addrA.lang, font: addrA.font, weight: addrA.weight });
        _ensureRosterEntry(next, addrA);          // W2
        _normalizeReps(next.pairs[pb]);
        return next;
    }
    // 8D-ext-MM step 4: 同 lang 两 DISTINCT 成员可成 MM pair；完全相同的 addr 不构成 pair。
    if (_addrEq(addrA, addrB)) return next;
    var newPair = {
        members: [
            { lang: addrA.lang, font: addrA.font, weight: addrA.weight },
            { lang: addrB.lang, font: addrB.font, weight: addrB.weight }
        ]
    };
    _ensureRosterEntry(next, addrA);              // W2
    _ensureRosterEntry(next, addrB);              // W2
    _normalizeReps(newPair);
    next.pairs.push(newPair);
    return next;
}

// 删除整个 pair
function removePair(config, addr) {
    var next = _deepClone(config || {});
    if (!Array.isArray(next.pairs)) return next;
    var idx = _findPairByMember(next, addr);
    if (idx < 0) return next;
    next.pairs.splice(idx, 1);
    return next;
}

// 从 pair 里移除某 member（若移除后 < 2 成员则整 pair 删除）
function removePairMember(config, addr) {
    var next = _deepClone(config || {});
    if (!Array.isArray(next.pairs)) return next;
    var idx = _findPairByMember(next, addr);
    if (idx < 0) return next;
    next.pairs[idx].members = next.pairs[idx].members.filter(function (m) { return !_addrEq(m, addr); });
    if (next.pairs[idx].members.length < 2) {
        next.pairs.splice(idx, 1);
    } else {
        // 8D-ext-MM step 4: 移除一个成员可能把某 MM lang 降到 1（→ prune rep）或删掉它的
        // first-connected 代表（→ 重导下一个有效成员）。归一保不变量。
        _normalizeReps(next.pairs[idx]);
    }
    return next;
}

// ---------------------------------------------------------------------------
// Preferred / fallback ops
// ---------------------------------------------------------------------------

function setPreferredWeight(config, lang, weight) {
    var next = _deepClone(config || {});
    if (!next.preferred_per_language) next.preferred_per_language = {};
    if (!next.preferred_per_language[lang]) next.preferred_per_language[lang] = {};
    next.preferred_per_language[lang].preferred_weight = weight;
    return next;
}

function setFallbackChain(config, lang, fonts) {
    var next = _deepClone(config || {});
    if (!next.fallback_chains) next.fallback_chains = {};
    next.fallback_chains[lang] = Array.isArray(fonts) ? fonts.slice() : [];
    return next;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
    // Language
    addLanguage: addLanguage,
    removeLanguage: removeLanguage,
    // Font / weight
    addFontWeight: addFontWeight,
    removeFontWeight: removeFontWeight,
    // Equivalence group
    mergeWeights: mergeWeights,
    unmergeWeight: unmergeWeight,
    setCanonical: setCanonical,
    // Pair
    createPair: createPair,
    removePair: removePair,
    removePairMember: removePairMember,
    // Preferred / fallback
    setPreferredWeight: setPreferredWeight,
    setFallbackChain: setFallbackChain,
    // read-only test seam (#33d 读数型钉子): _normalizeReps is the documented
    // lib TWIN of the panel's rep-normalize effect (app.jsx — "panel twin of
    // lib font_mapping_ops._normalizeReps, enforces the SAME invariant"), so
    // the exemption-pins READOUT measures the load-time rep invention through
    // the same invariant without booting React. Additive export, zero
    // behaviour change.
    _internal: {
        _normalizeReps: _normalizeReps
    }
};
