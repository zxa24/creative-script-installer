"use strict";

/**
 * lib/font_mapping_resolve.js — Phase 8D-ext-0 pure planning stage
 *
 * Per task_plan 8D-ext-0 P1d fix: separates planning from execution. The
 * apply pipeline is:
 *
 *   scan (lib/font_mapping_doc_scan) → resolveDocActions (THIS) → apply_to_doc
 *
 * resolveDocActions takes:
 *   - scanResult: from font_mapping_doc_scan.scanActiveDoc — contains
 *                 tsrMap with per-TSR (storyIdx, idxStart, idxEnd, dominantLang,
 *                 sourceFont, sourceWeight)
 *   - config:     brand config { fonts_by_language, pairs, equivalence_groups,
 *                                 pairs[].representative_by_lang? }
 *   - skipDecisions: { (pairingId + "|" + lang) → 'skip' | 'apply' }
 *                    Default = apply if not present. 'skip' means user clicked
 *                    "Skip & Continue" on that (pair, lang) and wants this TSR
 *                    left unchanged.
 *
 * Returns:
 *   {
 *     actions: [{ storyIdx, idxStart, idxEnd, dstFamily, dstStyle,
 *                  sourcePairingId, sourceLang, dominantLang,
 *                  sourceFont, sourceWeight }],
 *     diagnostics: { skipped: N, unmatched: N, applied: N, errors: [...] }
 *   }
 *
 * Decision logic per TSR:
 *   1. If dominantLang is null (empty/neutral text) → skip silently (no action)
 *   2. Find pair(s) containing source (font, weight). For each:
 *      a. If pair has member at dominantLang and (pairId|domLang) NOT in
 *         skipDecisions → emit action to that member's (font, weight)
 *      b. If pair has member but skipDecisions[pairId|domLang]==='skip' →
 *         increment diagnostics.skipped, no action
 *      c. If pair has NO member at dominantLang → diagnostics.unmatched++
 *         (caller can ask user to add via panel UnresolvedLangSection;
 *         not an error per C3-relaxed)
 *
 * Pure function — no side effects, no doc access. Deterministic: same
 * inputs → same outputs. Suitable for Node tests.
 *
 * MVP detail #11: Skip & Continue. Implemented via skipDecisions input.
 */

var FMP;
try { FMP = require("./font_mapping_pairs.js"); } catch (e) { FMP = null; }

function _safeStr(v) { try { return String(v); } catch (e) { return ""; } }

// Look up the dst (font, weight) for a pair member at given lang.
// Handles representative_by_lang for asymmetric pairs (B4: lang has 1 member
// in pair but multiple "represented" weights from another lang map to it).
//
// Standard case: pair.members[lang]. Asymmetric reverse: when projecting
// FROM srcLang multi-weight TO dstLang single-weight, all srcLang weights
// map to dstLang's single member; when projecting FROM dstLang single TO
// srcLang multi, use representative_by_lang[srcLang].
function _resolveDstForLang(pair, dstLang, srcLang, sourceFont, sourceWeight, config) {
    if (!pair || !Array.isArray(pair.members)) return null;
    // dstLang arrives canonical (scan-derived dominantLang ∈ DOM_LANG_ORDER —
    // font_mapping_doc_scan.js:98/101; never region/script-tagged), so the raw
    // `members[i].lang === dstLang` / `representative_by_lang[dstLang]` match is
    // sound (symmetric with step-2's projection match).
    var member = null;
    var sameLangCount = 0;
    for (var i = 0; i < pair.members.length; i++) {
        if (pair.members[i].lang === dstLang) {
            sameLangCount++;
            if (!member) member = pair.members[i];
        }
    }
    if (!member) return null;

    // 8D-ext-MM r3#1 consumer guard (closes codex P0#2): read
    // representative_by_lang ONLY for ≥2 same-lang members (validated to exist
    // and be a member for ≥2-member langs, II-c-compat). For ≤1 member, IGNORE
    // a (possibly stale legacy) rep entirely and use the single member —
    // SYMMETRIC with the validator's scoping and with step-2's projection,
    // which reads rep only when tgtMembers.length >= 2.
    var dstFont, dstWeight;
    if (sameLangCount >= 2 &&
        pair.representative_by_lang &&
        pair.representative_by_lang[dstLang] &&
        pair.representative_by_lang[dstLang].font &&
        pair.representative_by_lang[dstLang].weight) {
        dstFont = pair.representative_by_lang[dstLang].font;
        dstWeight = pair.representative_by_lang[dstLang].weight;
    } else {
        dstFont = member.font;
        dstWeight = member.weight;
    }

    // Codex r4 P1-2 fix: canonicalize the dst too. If the pair member /
    // representative_by_lang holds a merged_in (font, weight), the user's A4
    // confirmation expects the canonical form to be physically applied —
    // not the merged_in label that was historically used.
    if (config) {
        var canon = _toCanonical(config, dstLang, dstFont, dstWeight);
        return { family: canon.font, style: canon.weight };
    }
    return { family: dstFont, style: dstWeight };
}

// Build index: "lang|font|weight" → [{pairIdx, pair, sourceLangInPair}]
// where sourceLangInPair is the lang under which (font, weight) appears in
// pair.members. We need this to identify TSR's "source lang" (which lang's
// font is currently applied).
function _indexPairsByFontWeight(config) {
    var idx = {};
    if (!config || !Array.isArray(config.pairs)) return idx;
    for (var pi = 0; pi < config.pairs.length; pi++) {
        var pair = config.pairs[pi];
        if (!pair || !Array.isArray(pair.members)) continue;
        for (var mi = 0; mi < pair.members.length; mi++) {
            var m = pair.members[mi];
            if (!m || !m.lang || !m.font || !m.weight) continue;
            var key = m.font + "|" + m.weight;
            if (!idx[key]) idx[key] = [];
            // Apply A4 equivalence: if font/weight in equivalence_group as a
            // merged_in, also index under canonical.
            idx[key].push({ pairIdx: pi, pair: pair, sourceLangInPair: m.lang });
        }
    }
    return idx;
}

// Equivalence-aware reverse lookup: if (font, weight) maps via
// equivalence_groups[lang].merged_in → canonical, return canonical;
// otherwise return as-is. Used to bridge "doc uses 'whitney/bookitalic'"
// to the config-canonical "Whitney/Book Italic".
function _toCanonical(config, lang, font, weight) {
    if (!FMP || typeof FMP.getCanonical !== "function") {
        return { font: font, weight: weight };
    }
    var c = FMP.getCanonical(config, lang, font, weight);
    return { font: c.font, weight: c.weight };
}

// TODO#38 (owner 3A 2026-08-13): gate a config-derived dst face through the ONE
// shared installedness + alias-resolution predicate (byPair_script_coverage.
// checkDstFaceInstalled — the same implementation gate A and the panel's
// missing-face warning read, so none of the three can drift). Returns:
//   { ok:true,  family, weight, aliased }  — emit; family/weight are the names to
//                                            WRITE (resolved installed spelling
//                                            when the config used an alias)
//   { ok:false }                           — face not installed within layers ①-④
//                                            (⑤ case-scan NOT consulted) → caller
//                                            skips the action and SURFACES the
//                                            skip (never silent — #28 doctrine)
// Node (!verifiable): pass through unchanged — today's behavior; on host the
// predicate is always verifiable. checkFn is injectable for Node tests only;
// production callers omit it (one resolution, one exit).
function _gateDst(family, weight, checkFn) {
    var chk = (checkFn || require("./byPair_script_coverage.js").checkDstFaceInstalled)(family, weight);
    if (!chk.verifiable) return { ok: true, family: family, weight: weight, aliased: false };
    if (chk.installed) {
        if (chk.resolvedFont !== null && chk.resolvedFont !== undefined) {
            return { ok: true, family: chk.resolvedFont, weight: chk.resolvedWeight, aliased: true };
        }
        return { ok: true, family: family, weight: weight, aliased: false };
    }
    return { ok: false };
}

function resolveDocActions(scanResult, config, skipDecisions) {
    skipDecisions = skipDecisions || {};
    var actions = [];
    var diagnostics = {
        skipped: 0,
        unmatched: 0,
        applied: 0,
        sameLangNoOp: 0,
        skippedEmpty: 0,
        errors: [],
        // TODO#38: dst faces the gate refused (not installed within layers ①-④)
        // — the action is SKIPPED, surfaced here (never silent). Additive field.
        dstFaceSkipped: [],
        // TODO#38: dst emitted under its resolved installed spelling because the
        // config used an alias (config itself is never rewritten). Additive.
        aliasResolved: []
    };

    if (!scanResult || !Array.isArray(scanResult.tsrMap)) {
        diagnostics.errors.push("scanResult missing tsrMap");
        return { actions: actions, diagnostics: diagnostics };
    }
    if (!config) {
        diagnostics.errors.push("config required");
        return { actions: actions, diagnostics: diagnostics };
    }

    var byFontWeight = _indexPairsByFontWeight(config);
    var tsrMap = scanResult.tsrMap;

    // Codex r4 P1-1 fix: pre-compute set of (font, weight) entries that are
    // legitimately registered under each lang in fonts_by_language. A TSR
    // whose (sourceFont, sourceWeight, dominantLang) matches this set is
    // using its home-lang font and should be sameLangNoOp regardless of
    // whether the same (font, weight) ALSO appears in another lang's
    // misconfigured pair member.
    var registeredInLang = {}; // "lang|font|weight" → true
    if (config.fonts_by_language) {
        Object.keys(config.fonts_by_language).forEach(function (lng) {
            var arr = config.fonts_by_language[lng] || [];
            for (var fi = 0; fi < arr.length; fi++) {
                registeredInLang[lng + "|" + arr[fi].font + "|" + arr[fi].weight] = true;
            }
        });
    }

    for (var i = 0; i < tsrMap.length; i++) {
        var t = tsrMap[i];
        if (!t.dominantLang) { diagnostics.skippedEmpty++; continue; }

        // Codex r3 P1-3 fix: A4 same-language normalization.
        // Codex r5 audit (new P1): MUST run BEFORE home-font short-circuit,
        // since merged_in entries ARE registered in fonts_by_language (per
        // validateBrandConfig). Otherwise short-circuit eats every A4
        // normalize candidate.
        var canonicalSame = _toCanonical(config, t.dominantLang, t.sourceFont, t.sourceWeight);
        var needsA4Normalize = (canonicalSame.font !== t.sourceFont ||
                                canonicalSame.weight !== t.sourceWeight);
        if (needsA4Normalize) {
            // TODO#38: the canonical target comes straight from config
            // (equivalence_groups) — gate it like every other config-derived dst.
            var _gA4 = _gateDst(canonicalSame.font, canonicalSame.weight);
            if (!_gA4.ok) {
                diagnostics.dstFaceSkipped.push({
                    kind: "a4_normalize", storyIdx: t.storyIdx,
                    dstFamily: canonicalSame.font, dstStyle: canonicalSame.weight,
                    sourceFont: t.sourceFont, sourceWeight: t.sourceWeight,
                    message: "a4 canonical target not installed (layers ①-④) — normalize skipped"
                });
                // do NOT fall through to the pair-swap arm: the TSR still IS a
                // canonicalization candidate; swapping it cross-lang on top of a
                // failed normalize would double-decide. Leave the run unchanged.
                continue;
            }
            if (_gA4.aliased) {
                diagnostics.aliasResolved.push({
                    kind: "a4_normalize",
                    from: { font: canonicalSame.font, weight: canonicalSame.weight },
                    to: { font: _gA4.family, weight: _gA4.weight }
                });
            }
            actions.push({
                storyIdx: t.storyIdx,
                idxStart: t.idxStart,
                idxEnd: t.idxEnd,
                cellPath: t.cellPath || null,
                dstFamily: _gA4.family,
                dstStyle: _gA4.weight,
                sourcePairingId: -1,  // not from a pair
                sourceLang: t.dominantLang,
                dominantLang: t.dominantLang,
                sourceFont: t.sourceFont,
                sourceWeight: t.sourceWeight,
                paraId: t.paraId,
                kind: 'a4_normalize'
            });
            diagnostics.applied++;
            // After A4 normalize, the TSR is now (in semantic intent)
            // running its canonical font for dominantLang — same-lang
            // home-font. Skip pair-based swap to avoid double action.
            continue;
        }

        // Codex r4 P1-1 fix: same-lang home-font short-circuit. If TSR is
        // (font, weight) registered under fonts_by_language[dominantLang]
        // AND NOT subject to A4 normalize (handled above), no swap.
        var homeKey = t.dominantLang + "|" + t.sourceFont + "|" + t.sourceWeight;
        if (registeredInLang[homeKey]) {
            diagnostics.sameLangNoOp++;
            continue;
        }

        // Resolve source (font, weight) via equivalence groups across all langs.
        // We try the raw key first, then per-lang canonicalized key.
        var keys = [t.sourceFont + "|" + t.sourceWeight];
        var matched = byFontWeight[keys[0]] || [];
        if (matched.length === 0) {
            // try canonical per each known lang
            var langs = config.fonts_by_language ? Object.keys(config.fonts_by_language) : [];
            for (var li = 0; li < langs.length; li++) {
                var c = _toCanonical(config, langs[li], t.sourceFont, t.sourceWeight);
                var ck = c.font + "|" + c.weight;
                if (ck !== keys[0] && byFontWeight[ck]) {
                    matched = matched.concat(byFontWeight[ck]);
                    keys.push(ck);
                }
            }
        }
        if (matched.length === 0) {
            // TSR source not in any pair — leave unchanged, no diagnostic flag
            // (sourceFont may be outside brand's scope; not an error)
            continue;
        }

        var seenPairs = {};
        for (var mp = 0; mp < matched.length; mp++) {
            var pi = matched[mp].pairIdx;
            if (seenPairs[pi]) continue;
            seenPairs[pi] = true;

            var pair = matched[mp].pair;
            var srcLang = matched[mp].sourceLangInPair;

            // Same-language: no swap needed
            if (srcLang === t.dominantLang) { diagnostics.sameLangNoOp++; continue; }

            var skipKey = pi + "|" + t.dominantLang;
            if (skipDecisions[skipKey] === 'skip') {
                diagnostics.skipped++;
                continue;
            }

            var dst = _resolveDstForLang(pair, t.dominantLang, srcLang, t.sourceFont, t.sourceWeight, config);
            if (!dst) {
                // Pair has no member for dominantLang — unmatched. C3-relaxed:
                // not an error; caller (panel) can prompt via UnresolvedLangSection.
                diagnostics.unmatched++;
                continue;
            }
            // TODO#38: pair-member dst comes straight from config — gate it.
            var _gP = _gateDst(dst.family, dst.style);
            if (!_gP.ok) {
                diagnostics.dstFaceSkipped.push({
                    kind: "pair_swap", storyIdx: t.storyIdx, sourcePairingId: pi,
                    dstFamily: dst.family, dstStyle: dst.style,
                    sourceFont: t.sourceFont, sourceWeight: t.sourceWeight,
                    message: "pair dst not installed (layers ①-④) — swap skipped"
                });
                continue;
            }
            if (_gP.aliased) {
                diagnostics.aliasResolved.push({
                    kind: "pair_swap", sourcePairingId: pi,
                    from: { font: dst.family, weight: dst.style },
                    to: { font: _gP.family, weight: _gP.weight }
                });
            }

            actions.push({
                storyIdx: t.storyIdx,
                idxStart: t.idxStart,
                idxEnd: t.idxEnd,
                cellPath: t.cellPath || null,  // codex r2 P2-2: carry through
                dstFamily: _gP.family,
                dstStyle: _gP.weight,
                sourcePairingId: pi,
                sourceLang: srcLang,
                dominantLang: t.dominantLang,
                sourceFont: t.sourceFont,
                sourceWeight: t.sourceWeight,
                paraId: t.paraId
            });
            diagnostics.applied++;
        }
    }

    return { actions: actions, diagnostics: diagnostics };
}

// ---------------------------------------------------------------------------
// resolveByPairActions — Phase 8D-ext-D net-new sibling (additive; the
// existing resolveDocActions above is untouched).
// ---------------------------------------------------------------------------
// Resolves byPair font-swap actions against a post-pipeline scan. Consumed
// only by lib/byPair_char_sweep.js (the M3/M4/M5 shared facade).
//
// Signature (task_plan 8D-ext-D r23 P1, 5-arg):
//   resolveByPairActions(scanResult, byPair, skipDecisions, brandConfig, langScriptTable)
//
//   scanResult     — from scanActiveDoc(); caller MUST have checked ok===true.
//                    tsrMap is the data source (top-level field).
//   byPair         — already-projected entries (projectByPairWithIndex output):
//                    [{ pairingId, srcFont, srcWeight, dstFont, dstWeight,
//                       srcLang, dstLang }]. pairingId = original pairIndex
//                    (transient, assigned by the importer/panel adapter).
//   skipDecisions  — { (pairingId + "|" + dstLang) → 'skip' } (r25: lang
//                    component pinned to dstLang).
//   brandConfig    — for _toCanonical equivalence_groups (pass {} not null).
//   langScriptTable— B2 deliverable { lang → { required_scripts: [...],
//                    lang_unsupported? } }; needed by the collision
//                    disambiguator + unresolvable-tie detection.
//
// Match semantics (r20 P3 / r25 / r26):
//   1. Raw match first — strict (srcFont, srcWeight).
//   2. Equivalence fallback — only on raw miss; canonicalize BOTH sides
//      under the byPair entry's srcLang (NOT scan dominantLang: post-pipeline
//      dominantLang is the target lang → CJK alias miss in zh-CN→zh-TW M5).
//   3. Disambiguator (collision only, never AND-gates a unique match):
//      compare script CLASS of byPair.dstLang vs scan dominantLang via
//      langScriptTable (scan collapses all Latin to 'en' — strict lang
//      equality would silent-no-op fr/de/es targets, iter2 NEW-3).
//   4. Unresolvable tie (≥2 candidates, script-class also tied, or table
//      data missing) → diagnostics.rejections, NEVER arbitrary first-pick.
//
// Returns { actions, diagnostics: { collisions, rejections, warnings,
//           skipped, applied, sameFontNoOp } } — facade merges its coverage
// results into the same diagnostics channels.

// Coarse script-class collapse for the disambiguator. han/kana/hangul → cjk
// (scan classifies at script-class granularity, not per-lang).
var _COARSE_CLASS = {
    latin: "latin", han: "cjk", kana: "cjk", hangul: "cjk",
    thai: "thai", arabic: "arabic", hebrew: "hebrew",
    cyrillic: "cyrillic", devanagari: "devanagari"
};

// lang → {class: true} via langScriptTable; null when unknowable
// (missing entry / lang_unsupported / empty required_scripts).
function _scriptClassesOf(lang, langScriptTable) {
    // step-3a audit P3: proto-safe exact lookup (same helper coverage uses) —
    // a raw langScriptTable[lang] index would hit Object.prototype members.
    var entry = require("./lang_script_table.js").lookupLangScriptEntry(lang, langScriptTable);
    if (!entry || entry.lang_unsupported || !Array.isArray(entry.required_scripts) ||
        entry.required_scripts.length === 0) return null;
    var out = {};
    var any = false;
    for (var i = 0; i < entry.required_scripts.length; i++) {
        var cls = _COARSE_CLASS[entry.required_scripts[i]];
        if (cls) { out[cls] = true; any = true; }
    }
    return any ? out : null;
}

function _classesIntersect(a, b) {
    if (!a || !b) return false;
    for (var k in a) {
        if (Object.prototype.hasOwnProperty.call(a, k) && b[k]) return true;
    }
    return false;
}

// CONTRACT (8D-ext-D step-3a, B-class): this entry point REQUIRES canonical
// BCP-47 langs on byPair[].srcLang/dstLang AND in skipDecisions keys
// ("pairingId|dstLang"). The canonical lookups here (skipKey, _scriptClassesOf)
// assume the facade has already folded any raw region/script tags. The single
// enforcement point is applyByPairSweep (_canonicalizeSweepInputs in
// lib/byPair_char_sweep.js) — the choke-point is deliberate; do NOT add a
// per-consumer normalize here. A direct caller passing raw tags is a contract
// violation.
// UNIFY-converge Phase 1 B-ui (#3 / #6): the SHARED pair-membership index for the
// equiv-aware ownership predicate. Keyed "font|weight" → true for EVERY pair
// member across ALL langs (the same source-of-truth buildUnresolvedByLang walks).
// Built from config.pairs (not the D-scoped projection — which would misjudge a
// pair-owned-but-missing-target source as unpaired, gate-1#3).
//
// B-ui A-2 fix (alias-member ownership): A pair member MAY itself be a
// merged_in ALIAS (the A/MM mutual-exclusion check in font_mapping_pairs.js:133
// only forbids that for MM multi-member langs — a non-MM pair member can be an
// eg alias). If the doc uses the CANONICAL font but the pair stores the alias,
// the old raw-only index missed it → the canonical doc font was misjudged
// `unowned` → wrongly HARD-blocked. So we index BOTH halves of every member's
// equivalence: the RAW member key (so a doc using the alias still matches via
// _isSourceOwnedByPair's raw probe) AND its CANONICAL key under m.lang (so a doc
// using the canonical matches an alias-member pair). _isSourceOwnedByPair folds
// the OTHER direction (doc-side alias → canonical); both directions meet here so
// the predicate is symmetric.
function _buildPairMembershipIdx(config) {
    var idx = {};
    if (!config || !Array.isArray(config.pairs)) return idx;
    var Core = require("./resolve_core.js");
    for (var pi = 0; pi < config.pairs.length; pi++) {
        var pair = config.pairs[pi];
        if (!pair || !Array.isArray(pair.members)) continue;
        for (var mi = 0; mi < pair.members.length; mi++) {
            var m = pair.members[mi];
            if (!m || !m.font || !m.weight) continue;
            // raw member key (member font may be canonical OR an alias)
            idx[m.font + "|" + m.weight] = true;
            // canonical key under the member's own lang (folds an alias member
            // to its canonical so a doc using the canonical font still owns it).
            var c = Core._toCanonical(config, m.lang, m.font, m.weight);
            if (c && (c.font !== m.font || c.weight !== m.weight)) {
                idx[c.font + "|" + c.weight] = true;
            }
        }
    }
    return idx;
}

// Fold a core diag's unmappedCjk delta (unowned / owned_missing_target) into an
// adapter-level accumulator. Both adapters call this so the surface model is
// identical on the panel and import paths (spec: 两 adapter 都 emit + 消费).
function _foldUnmappedCjk(acc, d) {
    if (!d || !d.unmappedCjk) return;
    var u = d.unmappedCjk.unowned || [];
    for (var i = 0; i < u.length; i++) acc.unowned.push(u[i]);
    var o = d.unmappedCjk.owned_missing_target || [];
    for (var j = 0; j < o.length; j++) acc.owned_missing_target.push(o[j]);
    // B-ui A-5: fold the explicitly-skipped unowned runs (non-blocking surface).
    var s = d.unmappedCjk.skipped || [];
    if (Array.isArray(acc.skipped)) {
        for (var k = 0; k < s.length; k++) acc.skipped.push(s[k]);
    }
}

// B-ui A-5: optional `fontSkip` ({ "font|weight": true }) — the explicit
// unowned-font skip channel. Defaults {} → no skip (regression-lock: every
// existing call omits it and behaves exactly as before). Threaded into rcx so
// resolve_core routes a skipped unowned CJK run to unmappedCjk.skipped (not
// .unowned) → the facade does not block the save on it.
function resolveByPairActions(scanResult, byPair, skipDecisions, brandConfig, langScriptTable, fontSkip) {
    skipDecisions = skipDecisions || {};
    brandConfig = brandConfig || {};
    langScriptTable = langScriptTable || {};
    fontSkip = fontSkip || {};
    var actions = [];
    var diagnostics = {
        collisions: [],
        rejections: [],
        warnings: [],
        skipped: 0,
        applied: 0,
        sameFontNoOp: 0,
        // B-ui (#6): shared unmapped-CJK surface model, also emitted by the panel
        // adapter. unowned → import facade folds into `blocked` save-gate.
        // skipped (A-5) → user explicitly accepted; surfaced but non-blocking.
        unmappedCjk: { unowned: [], owned_missing_target: [], skipped: [] }
    };

    if (!scanResult || !Array.isArray(scanResult.tsrMap)) {
        diagnostics.rejections.push({ type: "bad_input", message: "scanResult missing tsrMap" });
        return { actions: actions, diagnostics: diagnostics };
    }
    // B-ui A-1 fix (empty-byPair classification): an empty byPair (no config /
    // every pair filtered to a coverage miss) used to early-return BEFORE the
    // tsrMap classification loop → unowned CJK runs were NOT classified, NOT
    // surfaced, and (via the facade) saved as silent tofu. We now FALL THROUGH:
    // with byPair=[], rawIdx is empty so every TSR misses → the core classifies
    // each CJK run as unowned (or owned_missing_target if config.pairs still owns
    // its source) and emits the shared unmappedCjk surface. The facade folds
    // `unowned` into its `blocked` save-gate (M4/M5) so no silent tofu save.
    // pairMembershipIdx is still built from brandConfig.pairs below, so the
    // unowned-vs-owned split stays correct even with zero byPair rows.
    byPair = Array.isArray(byPair) ? byPair : [];

    // gate-1 fix: CJK_LANG_SET for the 3rd-tier SA-gate (§3 (c)). LAZY/call-time
    // require (mirrors apply_to_doc.js:98) — avoids the byPair_char_sweep↔resolve
    // load-order cycle (byPair_char_sweep requires resolve only lazily).
    var CJK_LANG_SET = require("./byPair_char_sweep.js").CJK_LANG_SET;

    // Raw index: "srcFont|srcWeight" → [entry]
    // 8D-ext-MM fan-out invariant (maintainer trap): a multi-member pair emits
    // N byPair rows that SHARE pairingId but have DISTINCT srcFont|srcWeight (one
    // per source member). They survive intact because they bucket into SEPARATE
    // rawIdx lists here — so a given TSR's candidates list never contains two
    // sibling fan-out rows, and the pairingId-keyed dedup below (which keys on
    // pairingId ALONE) never collapses them. The dedup MUST stay AFTER this
    // bucketing: moving it earlier, or re-keying the bucket by pairingId, would
    // make two sibling rows collide and silently drop one → MM font data loss.
    var rawIdx = {};
    for (var bi = 0; bi < byPair.length; bi++) {
        var e = byPair[bi];
        if (!e || !e.srcFont || !e.srcWeight || !e.dstFont || !e.dstWeight) {
            diagnostics.warnings.push({
                type: "malformed_byPair_entry",
                pairingId: e && e.pairingId,
                message: "byPair entry missing srcFont/srcWeight/dstFont/dstWeight — skipped"
            });
            continue;
        }
        var rk = e.srcFont + "|" + e.srcWeight;
        if (!rawIdx[rk]) rawIdx[rk] = [];
        rawIdx[rk].push(e);
    }

    // UNIFY-converge Phase 1 (A-block): build the rcx context ONCE, then
    // delegate each TSR's matching to the shared core (lib/resolve_core.js).
    // The per-TSR matching body (raw → equivalence → upright-rematch SA-gated →
    // dedup+skip → collision reject-on-tie → sameFontNoOp) lives there now.
    // Adapter I responsibilities that STAY here: rawIdx build (MM fan-out
    // invariant), malformed-entry warnings (already pushed above), pairMembership
    // index (gate-1#3 placeholder — built for the core's rcx; catch-all consumer
    // is Phase 1 B, not A), diagnostics shape + folding.
    //
    // pairMembershipIdx (B-ui #3): the FULL set of pair-member (font|weight) keys
    // across ALL langs, from config.pairs — NOT the D-scoped byPair projection
    // (which would misjudge a pair-owned-but-missing-target source as unpaired,
    // gate-1#3). resolve_core consumes this to split unmappedCjk unowned vs
    // owned_missing_target. Falls back to the byPair-derived source set ONLY when
    // brandConfig.pairs is unavailable (a direct caller passing {} config) — that
    // preserves a best-effort ownership signal without the config.
    var pairMembershipIdx = (brandConfig && Array.isArray(brandConfig.pairs))
        ? _buildPairMembershipIdx(brandConfig)
        : (function () {
            var idx = {};
            for (var pmi = 0; pmi < byPair.length; pmi++) {
                var pe = byPair[pmi];
                if (!pe || !pe.srcFont || !pe.srcWeight) continue;
                idx[pe.srcFont + "|" + pe.srcWeight] = true;
            }
            return idx;
        })();

    var Core = require("./resolve_core.js");
    var rcx = {
        brandConfig: brandConfig,
        langScriptTable: langScriptTable,
        skipDecisions: skipDecisions,
        cjkSet: CJK_LANG_SET,
        // fauxTierEnabled omitted → undefined → tier-3 runs (import default).
        pairMembershipIdx: pairMembershipIdx,
        // B-ui A-5: explicit unowned-font skip channel (keyed "font|weight").
        fontSkipSet: fontSkip
    };

    var tsrMap = scanResult.tsrMap;
    for (var i = 0; i < tsrMap.length; i++) {
        var res = Core._resolveTsrAgainstByPair(tsrMap[i], rawIdx, byPair, rcx);
        var d = res.diag;
        // Fold the core's per-TSR diag delta into the adapter's diagnostics
        // (output shape unchanged: collisions/rejections/warnings/skipped/
        // applied/sameFontNoOp).
        diagnostics.skipped     += d.skipped;
        diagnostics.applied     += d.applied;
        diagnostics.sameFontNoOp += d.sameFontNoOp;
        for (var cli = 0; cli < d.collisions.length; cli++) diagnostics.collisions.push(d.collisions[cli]);
        for (var rji = 0; rji < d.rejections.length; rji++) diagnostics.rejections.push(d.rejections[rji]);
        for (var wri = 0; wri < d.warnings.length; wri++) diagnostics.warnings.push(d.warnings[wri]);
        _foldUnmappedCjk(diagnostics.unmappedCjk, d);
        if (res.action) actions.push(res.action);
    }

    return { actions: actions, diagnostics: diagnostics };
}

// ---------------------------------------------------------------------------
// resolvePanelActions — UNIFY-converge Phase 1 (B-core). Adapter II.
// ---------------------------------------------------------------------------
// Routes the panel Apply path through the SAME shared matching core
// (lib/resolve_core.js) that import byPair uses — eliminating the entry-point
// drift (SA / faux-tier / equivalence / collision-disambig were import-only).
// Preserves the panel's per-TSR direction by BUCKETING surviving TSRs by their
// effective target lang and projecting byPair scoped to each bucket's target.
//
// Signature (design §3.3.4):
//   resolvePanelActions(scanResult, config, skipDecisions, langScriptTable, opts)
//     → { actions, diagnostics, unresolvedByLang, targetLangResolution }
//
//   scanResult      — scanActiveDoc() output; tsrMap + (透传) unresolvedByLang.
//   config          — brand config (fonts_by_language, pairs, equivalence_groups).
//   skipDecisions   — { "pairingId|dstLang" → 'skip' } (canonical dstLang key,
//                     SAME shape the core consumes).
//   langScriptTable — { lang → { required_scripts:[...] | lang_unsupported } }.
//   opts            — { primaryLang?, metaTargetLang? }
//                     ③ target-lang priority chain inputs (see below). Both
//                     optional; omitted → falls through the chain.
//
// CONTRACT INVARIANTS (design §3.3.4 / §B.2 — testable):
//   INV-1: every emitted action a → a.dstLang === a.<effective target>.
//   INV-2: a TSR's matching only consults byPair rows with dstLang===its target
//          (structurally — the per-bucket projection only emits dstLang===D rows,
//          so a (srcFont,srcWeight) can NEVER collide across different-script
//          targets; resolve_core's global-collision risk is eliminated in-bucket).
//
// faux-off (#2): rcx.fauxTierEnabled=false skips tier-3 on the panel path, so a
//   panel italic-Latin→CJK run keeps its source italic (today's panel behavior).
//   byPair never auto-skews from source italic (the #17 Y-model variant subsystem
//   was removed). Broad faux-on-panel (every italic CJK run) is Phase 2.
//
// pre-pass (panel-only, runs BEFORE the core, has no byPair equivalent):
//   A4 same-lang normalize + home-font short-circuit + null-dominantLang skip.
//   These `continue` and never enter the core (keeps the core byPair-pure).
//
// NOT done here (Phase 1 B-ui): #4 reject-visible UI, surface-unmapped /
//   unmappedCjk diagnostic, import pre-save block. This B-core only produces the
//   diagnostics (rejections[]/collisions[]) — rendering them is B-ui.

// CJK target set (SAME basis as the sweep facade / resolve_core SA-gate —
// NOT langScriptTable, which a partial table could under-report). Lazy require
// to mirror resolveByPairActions's load-order discipline.
function _panelCjkSet() {
    return require("./byPair_char_sweep.js").CJK_LANG_SET;
}

// ③ target-lang priority chain. Returns one of:
//   { kind:"resolved", lang:<canonical CJK lang> }       — authoritative target
//   { kind:"scanner",  lang:<dominantLang> }             — ≤1 CJK target, safe
//   { kind:"blocked",  reason, candidates:[...] }         — multi-CJK + no signal
//
// Invariant (re-gate4, A-class): the scanner is NEVER allowed to DECIDE among
// MULTIPLE CJK targets. When config has ≥2 CJK target langs and (1)/(2)/(3)
// give no authoritative signal, we DO NOT fall to the scanner's dominantLang
// (it collapses all Han → zh-CN, so it would silently pick zh-CN over ja/zh-TW);
// instead we return "blocked" so the caller (B-ui) force-selects or aborts the
// mutation. Single-CJK / no-ambiguity → scanner is fine (kind:"scanner").
function _resolveCjkTarget(dominantLang, cjkTargetsInConfig, opts, cjkSet) {
    opts = opts || {};
    var _norm = require("./lang_script_table.js").normalizeBcp47Identity;
    // (1) workflow _meta targetLang — panel-only can't read it TODAY; this is the
    //     interface seam for project_meta A1 (the two parallel lines meet here).
    //     When supplied + canonical CJK, it is authoritative.
    if (opts.metaTargetLang) {
        var mt = _norm(opts.metaTargetLang);
        if (cjkSet[mt]) return { kind: "resolved", lang: mt, source: "meta" };
    }
    // (2) panel primaryLang — the user-selected dropdown (app.jsx). The現成
    //     authoritative panel signal; thread through onDone → adapter.
    if (opts.primaryLang) {
        var pl = _norm(opts.primaryLang);
        if (cjkSet[pl]) return { kind: "resolved", lang: pl, source: "primaryLang" };
    }
    // (3) single-CJK-lang config — unambiguous, no plumb needed.
    if (cjkTargetsInConfig.length === 1) {
        return { kind: "resolved", lang: cjkTargetsInConfig[0], source: "single_cjk_config" };
    }
    // (4) scanner dominantLang — ONLY when ≤1 CJK target (no ambiguity to decide).
    if (cjkTargetsInConfig.length <= 1) {
        return { kind: "scanner", lang: dominantLang, source: "scanner" };
    }
    // ≥2 CJK targets, no authoritative (1)(2)(3) signal → DO NOT let scanner pick.
    return { kind: "blocked", reason: "panel_multi_cjk_target_ambiguous",
             candidates: cjkTargetsInConfig.slice() };
}

function resolvePanelActions(scanResult, config, skipDecisions, langScriptTable, opts) {
    skipDecisions = skipDecisions || {};
    langScriptTable = langScriptTable || {};
    opts = opts || {};
    // B-ui A-5: explicit unowned-font skip channel ({ "font|weight": true }),
    // passed by the panel (opts.fontSkip). Omitted → {} → no skip (regression-lock).
    var fontSkip = opts.fontSkip || {};
    var Core = require("./resolve_core.js");
    var _norm = require("./lang_script_table.js").normalizeBcp47Identity;
    var cjkSet = _panelCjkSet();

    var actions = [];
    // TODO#38: dst emitted under its resolved installed spelling because config
    // used an alias (config never rewritten). Top-level return field, symmetric
    // with applyByPairSweep's aliasResolved. Additive.
    var aliasResolved = [];
    var diagnostics = {
        collisions: [], rejections: [], warnings: [],
        skipped: 0, applied: 0, sameFontNoOp: 0,
        sameLangNoOp: 0, unmatched: 0, skippedEmpty: 0,
        // B-ui (#6): shared unmapped-CJK surface model (same shape Adapter I emits).
        // skipped (A-5): explicitly user-skipped unowned runs (non-blocking).
        unmappedCjk: { unowned: [], owned_missing_target: [], skipped: [] }
    };
    // B-ui (#3): equiv-aware pair-membership index, built ONCE from config.pairs
    // and threaded into every bucket's rcx so resolve_core can split unmappedCjk.
    var pairMembershipIdx = _buildPairMembershipIdx(config);
    // ③ resolution audit — one entry per distinct CJK target decision, so B-ui
    // can render the force-select / block prompt. Keyed by decision kind.
    var targetLangResolution = { resolved: [], blocked: [] };
    var _blockedSeen = {};

    if (!scanResult || !Array.isArray(scanResult.tsrMap)) {
        diagnostics.rejections.push({ type: "bad_input", message: "scanResult missing tsrMap" });
        return { actions: actions, diagnostics: diagnostics,
                 unresolvedByLang: (scanResult && scanResult.unresolvedByLang) || {},
                 targetLangResolution: targetLangResolution };
    }
    if (!config) {
        diagnostics.rejections.push({ type: "bad_input", message: "config required" });
        return { actions: actions, diagnostics: diagnostics,
                 unresolvedByLang: {}, targetLangResolution: targetLangResolution };
    }

    // CJK target langs present in this config (intersection of fonts_by_language
    // keys with the CJK set, canonicalized). Drives the ③ ambiguity decision.
    var cjkTargetsInConfig = [];
    if (config.fonts_by_language) {
        var _seenCjk = {};
        Object.keys(config.fonts_by_language).forEach(function (lng) {
            var c = _norm(lng);
            if (cjkSet[c] && !_seenCjk[c]) { _seenCjk[c] = true; cjkTargetsInConfig.push(c); }
        });
    }

    // ── pre-pass (panel-only; runs BEFORE the core, mirrors resolveDocActions
    //    A4-normalize + home-font short-circuit). Survivors are bucketed by
    //    effective target lang. ──────────────────────────────────────────────
    var registeredInLang = {}; // "lang|font|weight" → true (home-font set)
    if (config.fonts_by_language) {
        Object.keys(config.fonts_by_language).forEach(function (lng) {
            var arr = config.fonts_by_language[lng] || [];
            for (var fi = 0; fi < arr.length; fi++) {
                registeredInLang[_norm(lng) + "|" + arr[fi].font + "|" + arr[fi].weight] = true;
            }
        });
    }

    // buckets: targetLang → [tsr]. Source lang (L≠D) projection is built per
    // bucket below.
    var buckets = {};
    var bucketOrder = [];
    var tsrMap = scanResult.tsrMap;

    for (var i = 0; i < tsrMap.length; i++) {
        var t = tsrMap[i];
        if (!t.dominantLang) { diagnostics.skippedEmpty++; continue; }
        var dom = _norm(t.dominantLang);

        // A-1 fix (re-gate): the EFFECTIVE target must be resolved BEFORE any
        // A4-normalize / home-font short-circuit. Previously A4/home ran under
        // the scanner's `dom`, so a CJK TSR with primaryLang=ja but scanner
        // collapse=zh-CN would (a) canonicalize/home-check under the WRONG lang
        // and (b) in the multi-CJK-ambiguous case it could A4-mutate or
        // short-circuit BEFORE the blocked decision — a swap on an ambiguous
        // target. So: resolve target (or detect blocked) FIRST; a blocked TSR
        // skips with ZERO A4/home mutation.
        var target;
        if (cjkSet[dom]) {
            var tr = _resolveCjkTarget(dom, cjkTargetsInConfig, opts, cjkSet);
            if (tr.kind === "blocked") {
                // multi-CJK ambiguity, no authoritative signal → force-select /
                // block (B-ui). Surface, do NOT silently bucket to scanner.
                // A-1: this `continue` is now BEFORE A4/home, so a blocked TSR
                // is never normalized or short-circuited (no pre-block mutation).
                if (!_blockedSeen[tr.reason]) {
                    _blockedSeen[tr.reason] = true;
                    targetLangResolution.blocked.push({
                        reason: tr.reason, candidates: tr.candidates
                    });
                }
                diagnostics.rejections.push({
                    type: "panel_target_lang_ambiguous",
                    storyIdx: t.storyIdx, idxStart: t.idxStart, idxEnd: t.idxEnd,
                    dominantLang: dom, candidates: tr.candidates,
                    message: "panel CJK target ambiguous — config has " + tr.candidates.length +
                             " CJK target langs and no authoritative target signal " +
                             "(_meta/primaryLang); mutation must force-select or block"
                });
                continue; // do NOT emit a swap on an ambiguous target
            }
            target = tr.lang;
            var _rkey = target + "|" + tr.source;
            if (!_blockedSeen[_rkey]) {
                _blockedSeen[_rkey] = true;
                targetLangResolution.resolved.push({ lang: target, source: tr.source });
            }
        } else {
            target = dom;
        }
        if (!target) { diagnostics.skippedEmpty++; continue; }

        // A4 same-lang normalize (merged_in → canonical, same lang). A-1 fix:
        // canonicalize under the EFFECTIVE `target`, not the scanner `dom`, so a
        // CJK TSR routed to ja by primaryLang normalizes against ja's
        // equivalence_groups. Emit直接, continue — no pair swap, no core.
        // (Mirrors resolveDocActions:188-217.)
        var canonicalSame = _toCanonical(config, target, t.sourceFont, t.sourceWeight);
        if (canonicalSame.font !== t.sourceFont || canonicalSame.weight !== t.sourceWeight) {
            // TODO#38: canonical target comes straight from config — gate it
            // through the shared predicate (same as byPair gate A / the panel's
            // own missing-face marks, which read the same checkDstFaceInstalled).
            var _gA4p = _gateDst(canonicalSame.font, canonicalSame.weight);
            if (!_gA4p.ok) {
                diagnostics.warnings.push({
                    type: "dst_face_not_installed_skipped",
                    kind: "a4_normalize", storyIdx: t.storyIdx,
                    dstFont: canonicalSame.font, dstWeight: canonicalSame.weight,
                    sourceFont: t.sourceFont, sourceWeight: t.sourceWeight,
                    message: "a4 canonical target not installed (layers ①-④) — normalize skipped, run left unchanged"
                });
                continue;   // leave the run unchanged; do NOT fall into pair-swap
            }
            if (_gA4p.aliased) {
                aliasResolved.push({
                    kind: "a4_normalize",
                    from: { font: canonicalSame.font, weight: canonicalSame.weight },
                    to: { font: _gA4p.family, weight: _gA4p.weight }
                });
            }
            actions.push({
                storyIdx: t.storyIdx, idxStart: t.idxStart, idxEnd: t.idxEnd,
                cellPath: t.cellPath || null,
                dstFamily: _gA4p.family, dstStyle: _gA4p.weight,
                sourcePairingId: -1, sourceLang: target, dominantLang: target,
                dstLang: target,              // INV-1: A4 target IS effective target
                sourceFont: t.sourceFont, sourceWeight: t.sourceWeight,
                paraId: t.paraId, kind: "a4_normalize"
            });
            diagnostics.applied++;
            continue;
        }
        // home-font short-circuit (TSR already running its home-lang font).
        // A-1 fix: check against the EFFECTIVE `target`'s home set, not `dom`.
        if (registeredInLang[target + "|" + t.sourceFont + "|" + t.sourceWeight]) {
            diagnostics.sameLangNoOp++;
            continue;
        }

        // annotate the TSR with its resolved target for the core's dominantLang
        // collision-disambig input (the core compares dstLang vs the TSR's
        // dominantLang; we feed the resolved target so an authoritative ja/zh-TW
        // is honored over the scanner's zh-CN collapse).
        var tt = {
            storyIdx: t.storyIdx, idxStart: t.idxStart, idxEnd: t.idxEnd,
            cellPath: t.cellPath || null,
            sourceFont: t.sourceFont, sourceWeight: t.sourceWeight,
            paraId: t.paraId,
            dominantLang: target           // resolved target drives in-core disambig
        };
        if (!buckets[target]) { buckets[target] = []; bucketOrder.push(target); }
        buckets[target].push(tt);
    }

    // ── per-bucket: project byPair scoped to target D, build rawIdx, run core ──
    var Pairs = require("./font_mapping_pairs.js");
    var pairs = Array.isArray(config.pairs) ? config.pairs : [];

    for (var bo = 0; bo < bucketOrder.length; bo++) {
        var D = bucketOrder[bo];
        var tsrs = buckets[D];

        // Collect every src lang L≠D that has a config pair member, then union
        // the L→D projections. Each produced row has dstLang===D → in-bucket
        // rawIdx only holds D-targeted rows → INV-2 holds structurally.
        var srcLangs = {};
        for (var pi2 = 0; pi2 < pairs.length; pi2++) {
            var pair = pairs[pi2];
            if (!pair || !Array.isArray(pair.members)) continue;
            for (var mi2 = 0; mi2 < pair.members.length; mi2++) {
                var ml = _norm(pair.members[mi2].lang);
                if (ml && ml !== D) srcLangs[ml] = true;
            }
        }
        var bucketByPair = [];
        Object.keys(srcLangs).forEach(function (L) {
            var proj = Pairs.projectByPairWithIndex(pairs, L, D, config);
            for (var k = 0; k < proj.length; k++) bucketByPair.push(proj[k]);
        });

        // TODO#38: screen the projected entries through the SAME per-entry logic
        // gate A uses (byPair_char_sweep._screenByPairEntries — clone-on-alias,
        // skip-on-missing, original config objects never mutated). verifyFn is a
        // predicate-only adapter over the shared checkDstFaceInstalled — no
        // Stage-2 script hints here (the panel surfaces those elsewhere).
        // Lazy require, same as the CJK_LANG_SET import above (no load cycle).
        var _screen = require("./byPair_char_sweep.js")._screenByPairEntries(
            bucketByPair, langScriptTable,
            function (e) {
                var g = _gateDst(e.dstFont, e.dstWeight);
                return {
                    stage1Reject: !g.ok,
                    stage2Warning: false,
                    pairingId: e.pairingId,
                    dstFont: e.dstFont, dstWeight: e.dstWeight, dstLang: e.dstLang,
                    resolvedDst: (g.ok && g.aliased) ? { font: g.family, weight: g.weight } : null,
                    message: g.ok ? "" : ("dstFont not installed: " + e.dstFont + "/" + e.dstWeight)
                };
            });
        bucketByPair = _screen.validByPair;
        for (var swi = 0; swi < _screen.coverageWarnings.length; swi++) {
            var _sw = _screen.coverageWarnings[swi];
            _sw.type = "dst_face_not_installed_skipped";   // panel-path label, same semantics
            diagnostics.warnings.push(_sw);
        }
        for (var sai = 0; sai < _screen.aliasResolved.length; sai++) {
            var _sa = _screen.aliasResolved[sai];
            _sa.kind = "pair_swap";
            aliasResolved.push(_sa);
        }

        // rawIdx (MM fan-out invariant: bucket by srcFont|srcWeight, dedup by
        // pairingId AFTER bucketing — same as Adapter I).
        var rawIdx = {};
        for (var bi = 0; bi < bucketByPair.length; bi++) {
            var e = bucketByPair[bi];
            if (!e || !e.srcFont || !e.srcWeight || !e.dstFont || !e.dstWeight) continue;
            var rk = e.srcFont + "|" + e.srcWeight;
            if (!rawIdx[rk]) rawIdx[rk] = [];
            rawIdx[rk].push(e);
        }

        var rcx = {
            brandConfig: config,
            langScriptTable: langScriptTable,
            skipDecisions: skipDecisions,
            cjkSet: cjkSet,
            fauxTierEnabled: false,  // #2: Phase-1 panel keeps source italic.
            // B-ui (#3): equiv-aware ownership → resolve_core splits unmappedCjk.
            pairMembershipIdx: pairMembershipIdx,
            // B-ui A-5: explicit unowned-font skip channel (keyed "font|weight").
            fontSkipSet: fontSkip
        };

        for (var ti = 0; ti < tsrs.length; ti++) {
            var srcT = tsrs[ti];
            var res = Core._resolveTsrAgainstByPair(srcT, rawIdx, bucketByPair, rcx);
            var d = res.diag;
            diagnostics.skipped     += d.skipped;
            diagnostics.applied     += d.applied;
            diagnostics.sameFontNoOp += d.sameFontNoOp;
            for (var cli = 0; cli < d.collisions.length; cli++) diagnostics.collisions.push(d.collisions[cli]);
            for (var rji = 0; rji < d.rejections.length; rji++) diagnostics.rejections.push(d.rejections[rji]);
            for (var wri = 0; wri < d.warnings.length; wri++) diagnostics.warnings.push(d.warnings[wri]);
            // B-ui (#6): fold the shared unmapped-CJK surface from the core. This
            // SUPERSEDES the B-core fixer's standalone panel_effective_target_unmapped
            // concept — now there is ONE model (unowned vs owned_missing_target),
            // emitted by the core and consumed identically here and on import.
            _foldUnmappedCjk(diagnostics.unmappedCjk, d);
            if (res.action) {
                // INV-1 hard guard: the core's winner.dstLang must equal the
                // bucket target. Structurally guaranteed (rawIdx only D rows),
                // but assert defensively — a violation = silent wrong-swap.
                if (res.action.dstLang !== D) {
                    diagnostics.rejections.push({
                        type: "panel_target_invariant_violation",
                        storyIdx: res.action.storyIdx,
                        expected: D, got: res.action.dstLang,
                        message: "INV-1 breach: action dstLang !== bucket target"
                    });
                    continue;
                }
                actions.push(res.action);
            } else if (d.skipped === 0 && d.sameFontNoOp === 0 &&
                       d.collisions.length === 0 && d.rejections.length === 0 &&
                       !(d.unmappedCjk && d.unmappedCjk.skipped &&
                         d.unmappedCjk.skipped.length > 0)) {
                // The core returned NO action with an all-zero diag — the
                // EFFECTIVE-target projection (bucketByPair, scoped to D) had no
                // raw/equivalence candidate for this TSR. Surface non-silently.
                // B-ui reframe: the CONCEPT of "未映射" now lives in unmappedCjk
                // (CJK runs are classified unowned vs owned_missing_target by the
                // core above). We still bump `unmatched` and emit a per-run
                // rejection so the existing partial-apply gate (idjs A-3 floor)
                // and tests keep working, but its `type` now reflects the
                // ownership class for CJK so B-ui can route the right入口
                // (new-pair / skip). Non-CJK targets keep the generic type.
                //
                // UNIFY model rule-3 (.skipped is TERMINAL) [A-1 fix]: a run the
                // user explicitly skipped lands in unmappedCjk.skipped with an
                // otherwise all-zero diag. It MUST NOT also count as `unmatched`
                // or push a panel_effective_target_unmapped rejection — that double
                // -counting made a skipped run still drive Apply→PARTIAL (the run
                // is already resolved by the user, accepted-as-tofu). The added
                // skipped-guard above excludes it; it is surfaced (non-blocking)
                // via diagnostics.unmappedCjk.skipped (folded just below) only.
                diagnostics.unmatched++;
                var _wasUnowned = (d.unmappedCjk &&
                    d.unmappedCjk.unowned.length > 0);
                var _wasOwnedMissing = (d.unmappedCjk &&
                    d.unmappedCjk.owned_missing_target.length > 0);
                diagnostics.rejections.push({
                    type: _wasUnowned ? "panel_unmapped_cjk_unowned"
                        : (_wasOwnedMissing ? "panel_unmapped_cjk_owned_missing_target"
                            : "panel_effective_target_unmapped"),
                    ownership: _wasUnowned ? "unowned"
                        : (_wasOwnedMissing ? "owned_missing_target" : null),
                    storyIdx: srcT.storyIdx, idxStart: srcT.idxStart, idxEnd: srcT.idxEnd,
                    targetLang: D,
                    sourceFont: srcT.sourceFont, sourceWeight: srcT.sourceWeight,
                    message: "panel: no byPair projection candidate for source font under " +
                             "effective target '" + D + "' — run left unchanged (non-silent)" +
                             (_wasUnowned ? " [unmapped font — needs a new pair or explicit skip]"
                                : (_wasOwnedMissing ? " [pair owns source but lacks a '" + D + "' member]" : ""))
                });
            }
        }
    }

    // 透传 scan's unresolvedByLang (produced by buildUnresolvedByLang at scan;
    // the resolver does NOT recompute — design §B.1 impl note).
    return {
        actions: actions,
        diagnostics: diagnostics,
        aliasResolved: aliasResolved,   // TODO#38 (additive; see decl)
        unresolvedByLang: scanResult.unresolvedByLang || {},
        targetLangResolution: targetLangResolution
    };
}

module.exports = {
    resolveDocActions: resolveDocActions,
    resolveByPairActions: resolveByPairActions,
    resolvePanelActions: resolvePanelActions,
    _gateDst: _gateDst,   // TODO#38 (checkFn injectable — Node tests only)
    _indexPairsByFontWeight: _indexPairsByFontWeight,
    _resolveDstForLang: _resolveDstForLang,
    _toCanonical: _toCanonical,
    _scriptClassesOf: _scriptClassesOf,
    _resolveCjkTarget: _resolveCjkTarget,
    _buildPairMembershipIdx: _buildPairMembershipIdx
};
