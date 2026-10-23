"use strict";

/**
 * lib/font_recombination.js — Phase 8D-ext-A cross-family equivalence matcher
 *
 * 🪦 RETIRED AS A MERGE CRITERION (TODO#58, 2026-08-20). Nothing in production
 * calls this module any more: doc_scan no longer requires it, its
 * `recombination_candidates` output is gone, and the panel builds its groups from
 * FACE IDENTITY (lib/font_identity_groups.js — `Font.postscriptName`, with an
 * INSTALLED + non-empty gate). owner: 「不应该是确定的方法用于判断它们是绝对一致的
 * 再合并吗，而不是靠表面的名称」.
 *
 * 🔴 It is kept, with its tests, as a DIAGNOSTIC — the normalize() rules below
 * are still the best written description of how these spellings vary, and #58 ⑥
 * records the one thing identity grouping deliberately CANNOT do ("two genuinely
 * different faces the design wants treated as one" — which, per audit R3, has no
 * route in the panel AT ALL today, manual included; see font_identity_groups.js).
 * Do not
 * wire it back into a merge decision; that is the change #58 exists to make.
 *
 * Pure leaf (Node-testable, no `app` / no DOM). Detects "twin" fonts whose
 * family⊕style was re-combined differently between the document and the brand
 * config — e.g. the document uses "Whitney Book" / "Regular" where the brand
 * config pairs "Whitney" / "Book". These name the SAME physical font but the
 * weight token lives in the family in one spelling and in the style in the
 * other, so byPair's font|weight key never matches → CJK target font never
 * applied → missing-font bug (task_plan 8D-ext-A).
 *
 * This module ONLY does cross-family recombination. Same-family collisions
 * ("Whitney" with both "Book" and "Regular" styles) stay in
 * font_mapping_doc_scan.detectMergesAndCollisions — those have a different
 * (single-family) data shape + UI + confirm path (r2 plan-gate A1: do NOT
 * merge the two concerns).
 *
 * Public API:
 *   normalize(family, style, opts) → { family, style, key }
 *     Migrate a weight-like LAST family token to the front of the style, then
 *     collapse upright-no-weight tokens (regular/roman/normal/plain) to empty.
 *     `key` = lowercase + strip-space join, used to group twins.
 *
 *   detectRecombinationCandidates(documentFonts, brandConfig, homeLangByFamily, opts)
 *       → [{ normalized_key, members:[{family,style,homeLang,used,isBrandSource}],
 *            suggested_canonical:{font,weight,homeLang} }]
 *     Cross-family groups where ≥1 brand-source member (canonical) AND ≥1
 *     cross-family document-only member (merged_in). B1 filter: a group with
 *     no brand-source member is skipped (no canonical, no bug to fix).
 *
 * r2 plan-gate grounding:
 *   A3 — styleAlias is used ONLY as a membership test for "is this family's
 *        last token a weight token I may migrate". The migrated token is kept
 *        RAW (not folded to its alias canonical). "Book" stays "Book". The
 *        only collapse-to-empty is the SEPARATE upright class
 *        {regular,roman,normal,plain}. This is the data-loss firewall: folding
 *        "Book"→"regular" would make "Whitney Book"/Regular ≡ "Whitney"/Regular
 *        (wrong-weight merge). Kept raw, they normalize to whitney␟book vs
 *        whitney␟(empty) → distinct → no merge.
 *   B1 — requires brandConfig (pairs + fonts_by_language) to define canonical
 *        and to filter candidates with no brand source.
 *   B3 — matcher takes brandConfig as an explicit input (still pure).
 */

// Upright "no extra weight" tokens that collapse to empty when normalizing the
// style. This is the SEPARATE rule from styleAlias membership (r2 A3): it must
// NOT contain Book/Medium/Semibold/etc. Kept lowercase for case-insensitive
// membership.
var UPRIGHT_NULL_TOKENS = { "regular": 1, "roman": 1, "normal": 1, "plain": 1 };

function _isUprightNull(token) {
    return !!UPRIGHT_NULL_TOKENS[String(token == null ? "" : token).toLowerCase()];
}

// Default weight-token membership test. Reuses font_mapping_doc_scan.styleAlias
// (single source of truth for the alias table). Required LAZILY to avoid a
// load-time circular dependency (doc_scan requires THIS module at top). When
// doc_scan calls us it passes its own styleAlias via opts.styleAlias, so this
// fallback only runs for standalone use.
function _defaultStyleAlias(token) {
    try {
        var Scan = require("./font_mapping_doc_scan.js");
        return Scan.styleAlias(token);
    } catch (e) {
        return null;
    }
}

function _key(family, style) {
    var f = String(family == null ? "" : family).toLowerCase().replace(/\s+/g, "");
    var s = String(style == null ? "" : style).toLowerCase().replace(/\s+/g, "");
    return f + "␟" + s; // ␟ — same separator convention as doc_scan.canonicalKey
}

function _rawKey(family, style) {
    // Exact (case + space preserving) identity for "is this the same raw entry".
    return String(family == null ? "" : family) + "" + String(style == null ? "" : style);
}

// normalize(family, style) — see module header. opts.styleAlias overrides the
// weight-token membership test (doc_scan injects its own).
function normalize(family, style, opts) {
    opts = opts || {};
    var styleAliasFn = (typeof opts.styleAlias === "function") ? opts.styleAlias : _defaultStyleAlias;
    function isWeightToken(tok) { return styleAliasFn(tok) !== null; }

    var famRaw = String(family == null ? "" : family).trim();
    var styRaw = String(style == null ? "" : style).trim();

    var famTokens = famRaw ? famRaw.split(/\s+/) : [];
    var migrated = "";
    // Migrate a weight-like LAST family token to the front of the style.
    // Only migrate when the family has >1 token (never strip the whole family).
    if (famTokens.length > 1) {
        var last = famTokens[famTokens.length - 1];
        if (isWeightToken(last)) {
            migrated = last;                       // r2 A3: keep RAW token
            famTokens = famTokens.slice(0, famTokens.length - 1);
        }
    }
    var newFamily = famTokens.join(" ");

    // Combined style tokens: migrated weight first, then the original style.
    var styTokens = styRaw ? styRaw.split(/\s+/) : [];
    var combined = [];
    if (migrated) combined.push(migrated);
    for (var i = 0; i < styTokens.length; i++) combined.push(styTokens[i]);

    // Independent upright-null collapse: drop regular/roman/normal/plain. This
    // runs on the migrated token too, so "Whitney Roman"+Italic → (Whitney,
    // Italic) matches "Whitney"+Italic (audit B-4). Book/Medium/Semibold are
    // NOT in UPRIGHT_NULL_TOKENS so they survive (r2 A3 firewall).
    var kept = [];
    for (var j = 0; j < combined.length; j++) {
        if (!_isUprightNull(combined[j])) kept.push(combined[j]);
    }
    var newStyle = kept.join(" ");

    return {
        family: newFamily,
        style: newStyle,
        key: _key(newFamily, newStyle)
    };
}

// Build the set of brand-source (font|weight) raw keys from a brand config:
// every fonts_by_language entry + every pair member. Used for B1 filter +
// canonical selection. Returns { byKey: {rawKey:true}, inPairs: {rawKey:true} }.
function _brandSourceIndex(config) {
    var byKey = {};
    var inPairs = {};
    if (!config) return { byKey: byKey, inPairs: inPairs };

    var fbl = config.fonts_by_language;
    if (fbl && typeof fbl === "object") {
        for (var lng in fbl) {
            if (!Object.prototype.hasOwnProperty.call(fbl, lng)) continue;
            var arr = fbl[lng] || [];
            for (var i = 0; i < arr.length; i++) {
                if (arr[i] && arr[i].font) byKey[_rawKey(arr[i].font, arr[i].weight)] = true;
            }
        }
    }
    if (Array.isArray(config.pairs)) {
        for (var pi = 0; pi < config.pairs.length; pi++) {
            var pair = config.pairs[pi];
            if (!pair || !Array.isArray(pair.members)) continue;
            for (var mi = 0; mi < pair.members.length; mi++) {
                var m = pair.members[mi];
                if (m && m.font) {
                    var rk = _rawKey(m.font, m.weight);
                    byKey[rk] = true;
                    inPairs[rk] = true;
                }
            }
        }
    }
    return { byKey: byKey, inPairs: inPairs };
}

// detectRecombinationCandidates — see module header.
//   documentFonts:    [{font, weight, used}]  (raw doc fonts, from doc_scan)
//   brandConfig:      {fonts_by_language, pairs}  (B1 filter + canonical source)
//   homeLangByFamily: {family: langCode}      (eg.lang derivation)
//   opts.styleAlias:  injected weight-token membership test (doc_scan passes
//                     its own; tests may pass Scan.styleAlias)
function detectRecombinationCandidates(documentFonts, brandConfig, homeLangByFamily, opts) {
    opts = opts || {};
    homeLangByFamily = homeLangByFamily || {};
    var brandIdx = _brandSourceIndex(brandConfig);

    // Universe = document fonts (doc-used) ∪ brand-source fonts. We need brand
    // fonts in the universe so a twin can match a canonical that lives ONLY in
    // the config (not necessarily present in the doc).
    var universe = {}; // rawKey → { family, style, used, isDoc, isBrandSource }
    function add(family, style, used, isDoc, isBrandSource) {
        if (!family) return;
        var rk = _rawKey(family, style);
        var rec = universe[rk];
        if (!rec) {
            rec = { family: family, style: style, used: 0, isDoc: false, isBrandSource: false };
            universe[rk] = rec;
        }
        if (isDoc) { rec.isDoc = true; rec.used += (used || 0); }
        if (isBrandSource) rec.isBrandSource = true;
    }

    var df = Array.isArray(documentFonts) ? documentFonts : [];
    for (var d = 0; d < df.length; d++) {
        var e = df[d];
        if (!e || !e.font) continue;
        var rkd = _rawKey(e.font, e.weight);
        add(e.font, e.weight, e.used || 0, true, !!brandIdx.byKey[rkd]);
    }
    // Brand-source fonts (from fonts_by_language + pairs) so canonical-only
    // entries join the group. We re-derive (family, style) from the raw keys.
    var fbl = brandConfig && brandConfig.fonts_by_language;
    if (fbl) {
        for (var lng in fbl) {
            if (!Object.prototype.hasOwnProperty.call(fbl, lng)) continue;
            var fa = fbl[lng] || [];
            for (var fi = 0; fi < fa.length; fi++) {
                if (fa[fi] && fa[fi].font) add(fa[fi].font, fa[fi].weight, 0, false, true);
            }
        }
    }
    if (brandConfig && Array.isArray(brandConfig.pairs)) {
        for (var p2 = 0; p2 < brandConfig.pairs.length; p2++) {
            var pr = brandConfig.pairs[p2];
            if (!pr || !Array.isArray(pr.members)) continue;
            for (var m2 = 0; m2 < pr.members.length; m2++) {
                var mm = pr.members[m2];
                if (mm && mm.font) add(mm.font, mm.weight, 0, false, true);
            }
        }
    }

    // Group by normalized key.
    var groups = {}; // key → [rec]
    for (var rk2 in universe) {
        if (!Object.prototype.hasOwnProperty.call(universe, rk2)) continue;
        var rec2 = universe[rk2];
        var norm = normalize(rec2.family, rec2.style, { styleAlias: opts.styleAlias });
        if (!groups[norm.key]) groups[norm.key] = [];
        groups[norm.key].push(rec2);
    }

    var candidates = [];
    var keys = Object.keys(groups).sort(); // deterministic order
    for (var gi = 0; gi < keys.length; gi++) {
        var nk = keys[gi];
        var members = groups[nk];
        if (members.length < 2) continue;

        // Cross-family requirement (r2 A1): the group must span ≥2 distinct
        // raw families. A single-family same-key group is doc_scan territory.
        var familySet = {};
        for (var mi2 = 0; mi2 < members.length; mi2++) familySet[members[mi2].family] = true;
        if (Object.keys(familySet).length < 2) continue;

        // B1: need ≥1 brand-source member to define canonical.
        var brandMembers = members.filter(function (x) { return x.isBrandSource; });
        if (brandMembers.length === 0) continue;

        // Pick canonical: prefer a brand-source font that is also a pair member
        // (those are the real byPair targets), else any brand-source. Tie-break
        // by raw (family,style) sort for determinism.
        brandMembers.sort(function (a, b) {
            var ap = brandIdx.inPairs[_rawKey(a.family, a.style)] ? 0 : 1;
            var bp = brandIdx.inPairs[_rawKey(b.family, b.style)] ? 0 : 1;
            if (ap !== bp) return ap - bp;
            if (a.family !== b.family) return a.family < b.family ? -1 : 1;
            return a.style < b.style ? -1 : 1;
        });
        var canonical = brandMembers[0];

        // merged_in candidates: cross-family (≠ canonical.family) document
        // fonts that need physical remap. Same-family entries are excluded
        // (r2 A1 — those are doc_scan's same-family merges).
        var mergedIn = [];
        for (var mi3 = 0; mi3 < members.length; mi3++) {
            var cm = members[mi3];
            if (cm === canonical) continue;
            if (cm.family === canonical.family) continue;      // same-family → not recombination
            if (!cm.isDoc) continue;                            // only remap real doc usage
            mergedIn.push(cm);
        }
        if (mergedIn.length === 0) continue;

        // Build output members (canonical first, then merged_in), each with its
        // home lang for the B2 "凭命名判断" display.
        var canonHome = homeLangByFamily[canonical.family] || "en";
        var outMembers = [{
            family: canonical.family, style: canonical.style,
            homeLang: canonHome, used: canonical.used, isBrandSource: true
        }];
        for (var oi = 0; oi < mergedIn.length; oi++) {
            outMembers.push({
                family: mergedIn[oi].family, style: mergedIn[oi].style,
                homeLang: homeLangByFamily[mergedIn[oi].family] || "en",
                used: mergedIn[oi].used, isBrandSource: !!mergedIn[oi].isBrandSource
            });
        }

        candidates.push({
            normalized_key: nk,
            members: outMembers,
            suggested_canonical: {
                font: canonical.family,
                weight: canonical.style,
                homeLang: canonHome
            }
        });
    }
    return candidates;
}

module.exports = {
    normalize: normalize,
    detectRecombinationCandidates: detectRecombinationCandidates,
    // exposed for tests / introspection
    _UPRIGHT_NULL_TOKENS: UPRIGHT_NULL_TOKENS,
    _brandSourceIndex: _brandSourceIndex
};
