"use strict";

/**
 * lib/resolve_core.js — UNIFY-converge Phase 1 (A-block) shared matching core.
 *
 * The SoT for the per-TSR matching tiers. Lifted VERBATIM (no semantic change)
 * from resolveByPairActions's per-TSR body (font_mapping_resolve.js, the
 * matching loop). Both apply paths converge here:
 *   - import byPair  (Adapter I, resolveByPairActions → delegates to this)
 *   - panel Apply    (Adapter II, Phase 1 B — NOT in A-block)
 *
 * _resolveTsrAgainstByPair(t, rawIdx, byPair, rcx) → { action | null, diag }
 *   t       — one tsrMap entry { storyIdx, idxStart, idxEnd, cellPath,
 *             dominantLang, sourceFont, sourceWeight, paraId }
 *   rawIdx  — { "srcFont|srcWeight" → [byPair row] }. The adapter builds this
 *             ONCE. MM fan-out invariant (font_mapping_resolve.js fan-out note):
 *             a multi-member pair emits N rows sharing pairingId but with
 *             DISTINCT srcFont|srcWeight → they bucket into SEPARATE rawIdx
 *             lists, so a TSR's candidate list never holds two sibling rows and
 *             the pairingId-keyed dedup (keyed on pairingId ALONE) never
 *             collapses them. The dedup MUST stay AFTER bucketing.
 *   byPair  — full projected row list (for equivalence + upright-rematch
 *             full-scan fallbacks).
 *   rcx     — {
 *               brandConfig,          // for _toCanonical (equivalence_groups)
 *               langScriptTable,      // collision disambiguator
 *               skipDecisions,        // { "pairingId|dstLang" → 'skip' }
 *               cjkSet,               // CJK_LANG_SET (SA-gate membership)
 *               fauxTierEnabled,      // gate-1#2: undefined/true → tier-3 runs
 *                                     //   (import default). false skips tier-3
 *                                     //   (panel path keeps source italic). This
 *                                     //   flag ONLY gates the tier-3 font-finding
 *                                     //   rematch; byPair never writes skew.
 *                                     //   A-block import path: omitted.
 *               pairMembershipIdx     // gate-1#3 placeholder: Set of srcFont|
 *                                     //   srcWeight in any pair. A-block builds
 *                                     //   but does NOT consume (catch-all = B).
 *             }
 *
 * Returns { action: <normalized action | null>, diag: <delta> } where diag is a
 * partial accumulation the adapter folds into its diagnostics channels:
 *   { skipped?, applied?, sameFontNoOp?, collisions?: [], rejections?: [],
 *     warnings?: [] }
 *
 * Pure — no side effects, no doc access. Deterministic.
 */

var FMP;
try { FMP = require("./font_mapping_pairs.js"); } catch (e) { FMP = null; }

// pure leaf for italic provenance (tier-3 upright-rematch font-finding).
var FI = require("./faux_italic.js");

// Coarse script-class collapse for the disambiguator. han/kana/hangul → cjk
// (scan classifies at script-class granularity, not per-lang).
var _COARSE_CLASS = {
    latin: "latin", han: "cjk", kana: "cjk", hangul: "cjk",
    thai: "thai", arabic: "arabic", hebrew: "hebrew",
    cyrillic: "cyrillic", devanagari: "devanagari"
};

// Equivalence-aware reverse lookup: if (font, weight) maps via
// equivalence_groups[lang].merged_in → canonical, return canonical; else as-is.
function _toCanonical(config, lang, font, weight) {
    if (!FMP || typeof FMP.getCanonical !== "function") {
        return { font: font, weight: weight };
    }
    var c = FMP.getCanonical(config, lang, font, weight);
    return { font: c.font, weight: c.weight };
}

// lang → {class: true} via langScriptTable; null when unknowable
// (missing entry / lang_unsupported / empty required_scripts).
function _scriptClassesOf(lang, langScriptTable) {
    // proto-safe exact lookup (same helper coverage uses) — a raw
    // langScriptTable[lang] index would hit Object.prototype members.
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

// UNIFY-converge Phase 1 B-ui (#3 equiv-aware ownership): is this (font, weight)
// the SOURCE side of ANY config pair? "Belongs to a pair" must be
// equivalence-aware so a doc font that is a merged_in ALIAS of a pair member
// still counts as owned (区分「真未配」vs「配了但缺目标 D」). The adapter builds
// `rcx.pairMembershipIdx` ONCE — a Set of canonical "font|weight" keys for every
// pair member. We probe BOTH the raw key AND the per-lang canonical key (the
// merged_in → canonical fold), so an alias source font resolves to its owned
// canonical. The SAME predicate is shared with buildUnresolvedByLang's notion of
// "pair covers this source" (doc_scan owns the owned_missing_target list); here
// it gates only the unowned-vs-owned SPLIT of the unmappedCjk surface.
function _isSourceOwnedByPair(config, font, weight, pairMembershipIdx, cjkSet) {
    if (!pairMembershipIdx) return false;
    // raw key
    if (pairMembershipIdx[font + "|" + weight]) return true;
    // equivalence fold: canonicalize the source under each lang the config knows,
    // and check the canonical key. A merged_in alias → its canonical member key.
    if (config && config.fonts_by_language) {
        var langs = Object.keys(config.fonts_by_language);
        for (var li = 0; li < langs.length; li++) {
            var c = _toCanonical(config, langs[li], font, weight);
            if ((c.font !== font || c.weight !== weight) &&
                pairMembershipIdx[c.font + "|" + c.weight]) {
                return true;
            }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// _resolveTsrAgainstByPair — the lifted per-TSR matching body.
// ---------------------------------------------------------------------------
function _resolveTsrAgainstByPair(t, rawIdx, byPair, rcx) {
    rcx = rcx || {};
    var brandConfig     = rcx.brandConfig || {};
    var langScriptTable = rcx.langScriptTable || {};
    var skipDecisions   = rcx.skipDecisions || {};
    var CJK_LANG_SET    = rcx.cjkSet || {};
    // gate-1#2: undefined → on (import default). false → skip tier-3 (panel path).
    // This flag gates ONLY the tier-3 font-finding rematch; byPair never writes skew
    // (the #17 Y-model faux-variant subsystem was removed).
    var fauxTierEnabled = rcx.fauxTierEnabled;

    // B-ui A-5: explicit per-font skip channel for UNOWNED fonts. Unowned runs
    // have NO pairingId, so the existing skipDecisions (keyed pairingId|dstLang)
    // can't carry them. When the user explicitly skips an unmapped font, its
    // "font|weight" key lands here; a matching unowned CJK run is routed to
    // unmappedCjk.skipped (NOT .unowned) so buildUnmappedCjkRejections does not
    // convert it to a blocking rejection → the import save is no longer blocked
    // on a font the user chose to accept-as-tofu / skip.
    var fontSkipSet     = rcx.fontSkipSet || {};

    var diag = { skipped: 0, applied: 0, sameFontNoOp: 0,
                 collisions: [], rejections: [], warnings: [],
                 // UNIFY-converge Phase 1 B-ui (#6): the shared unmapped-CJK
                 // surface model. unowned = CJK run whose source font is in NO
                 // pair (truly未配 — surface + import pre-save block);
                 // owned_missing_target = source belongs to a pair but that pair
                 // has no member for the effective target D (existing
                 // unresolved/skip semantics, NOT a hard block); skipped = an
                 // unowned run the user explicitly skipped (A-5 — surfaced for
                 // visibility but does NOT block). Both adapters fold these.
                 unmappedCjk: { unowned: [], owned_missing_target: [], skipped: [] } };

    // 1. Raw match first (strict).
    var candidates = rawIdx[t.sourceFont + "|" + t.sourceWeight] || [];

    // 2. Equivalence fallback — only on raw miss; both sides canonicalized
    //    under the byPair entry's srcLang.
    if (candidates.length === 0) {
        for (var fi = 0; fi < byPair.length; fi++) {
            var fe = byPair[fi];
            if (!fe || !fe.srcFont || !fe.srcWeight || !fe.dstFont || !fe.dstWeight) continue;
            var cScan = _toCanonical(brandConfig, fe.srcLang, t.sourceFont, t.sourceWeight);
            var cPair = _toCanonical(brandConfig, fe.srcLang, fe.srcFont, fe.srcWeight);
            if (cScan.font === cPair.font && cScan.weight === cPair.weight) {
                candidates = candidates.concat([fe]);
            }
        }
    }
    // 3. 3rd tier — strip-to-upright italic rematch (FONT-FINDING ONLY).
    //    Fires ONLY on raw+equivalence double-miss. Non-italic unmatched TSRs
    //    are untouched → no regression. gate-1 FIX (codex P1): the match is
    //    RESTRICTED to SA-bound pairings (Latin-source → CJK-target) so a non-SA
    //    match never swaps the font to upright on the whole-range branch with NO
    //    skew → SILENT italic loss (regression vs unmatched-keeps-source-italic).
    //    So gather into `fxc`, SA-filter, and only CLAIM a match (assign
    //    `candidates`) when ≥1 SA-bound survives.
    //    READ-only of rawIdx — never rebuild / re-bucket / pre-dedup (the MM
    //    fan-out invariant; the dedup below still keys on pairingId alone).
    //    gate-1#2: this tier runs on the IMPORT path (fauxTierEnabled!==false). On
    //    the panel path the adapter passes fauxTierEnabled===false so it is SKIPPED
    //    — a Latin-italic source keeps its source italic there. This tier is pure
    //    FONT-FINDING (strip-to-upright to reach the CJK base winner): it sets NO
    //    skew flag of any kind. The #17 Y-model faux-variant skew subsystem was
    //    removed; byPair never auto-skews from source italic.
    if (candidates.length === 0 && fauxTierEnabled !== false) {
        var prov = FI._detectItalicProvenance(t.sourceWeight);
        if (prov.isItalic) {
            // (a) retry RAW with the upright weight ("Book Italic" → "Book").
            var fxc = rawIdx[t.sourceFont + "|" + prov.upright] || [];
            // (b) on still-miss, retry EQUIVALENCE with the upright weight —
            //     mirrors the B2 fallback ("Whitney Book|Italic" →
            //     "Whitney Book|Regular", then a FULL-PAIR equivalence
            //     canonicalizes {Whitney Book,Regular} → {Whitney,Book};
            //     getCanonical compares the COMPLETE pair — see §10.2).
            if (fxc.length === 0) {
                for (var xi = 0; xi < byPair.length; xi++) {
                    var xe = byPair[xi];
                    if (!xe || !xe.srcFont || !xe.srcWeight || !xe.dstFont || !xe.dstWeight) continue;
                    var cScanU = _toCanonical(brandConfig, xe.srcLang, t.sourceFont, prov.upright);
                    var cPairU = _toCanonical(brandConfig, xe.srcLang, xe.srcFont, xe.srcWeight);
                    if (cScanU.font === cPairU.font && cScanU.weight === cPairU.weight) {
                        fxc = fxc.concat([xe]);
                    }
                }
            }
            // (c) SA-gate: keep ONLY candidates whose pairing takes the apply
            //     SA branch (= _isScriptAwareAction: dstLang ∈ CJK_LANG_SET &&
            //     srcLang ∉ CJK_LANG_SET). SAME membership set apply uses, so
            //     resolve's prediction == apply's branch EXACTLY.
            if (fxc.length > 0) {
                fxc = fxc.filter(function (c) {
                    return CJK_LANG_SET[c.dstLang] && !CJK_LANG_SET[c.srcLang];
                });
            }
            if (fxc.length > 0) {            // ≥1 SA-bound match survives
                candidates = fxc;
                // FONT-FINDING ONLY — strip-to-upright reaches the CJK base winner.
                // NO skew flag is set here (the #17 faux-variant skew was removed).
            }
            // else: candidates stays [] → falls to the continue → TSR
            // unmatched → KEEPS its source italic font (no regression). ✔
        }
    }

    if (candidates.length === 0) {
        // UNIFY-converge Phase 1 B-ui (#6 surface-unmapped, ④ reframe): a CJK run
        // that found NO byPair candidate is NOT silently "outside scope" — it is
        // either truly-unconfigured (unowned) or a pair-owned source missing the
        // target member. Classify so the adapters can surface it (and the import
        // path can block a真未配 save instead of writing tofu). Non-CJK runs
        // (target not in the CJK set) stay silent — out of brand scope, not an
        // error (matches today's resolveDocActions behavior).
        if (CJK_LANG_SET[t.dominantLang]) {
            var owned = _isSourceOwnedByPair(brandConfig, t.sourceFont, t.sourceWeight,
                                             rcx.pairMembershipIdx, CJK_LANG_SET);
            var entry = {
                storyIdx: t.storyIdx, idxStart: t.idxStart, idxEnd: t.idxEnd,
                cellPath: t.cellPath || null,
                sourceFont: t.sourceFont, sourceWeight: t.sourceWeight,
                targetLang: t.dominantLang, paraId: t.paraId
            };
            if (owned) {
                // pair-owned source, no member for THIS target D → existing
                // unresolved/skip semantics (#3). Surfaced, NOT a hard block.
                diag.unmappedCjk.owned_missing_target.push(entry);
            } else if (fontSkipSet[t.sourceFont + "|" + t.sourceWeight]) {
                // B-ui A-5: user explicitly skipped this unmapped font. Route to
                // `skipped` (surfaced, NOT blocking) instead of `unowned` — the
                // import save proceeds, accepting the tofu/unstyled run.
                diag.unmappedCjk.skipped.push(entry);
            } else {
                // truly-unpaired CJK font → tofu risk. Surface as unmapped;
                // the import facade folds unowned into its `blocked` save-gate.
                diag.unmappedCjk.unowned.push(entry);
            }
        }
        return { action: null, diag: diag }; // no swap — surface above is non-silent
    }

    // Dedupe by pairingId + apply skipDecisions (key: pairingId|dstLang).
    var live = [];
    var seen = {};
    for (var ci = 0; ci < candidates.length; ci++) {
        var c = candidates[ci];
        var pid = (typeof c.pairingId !== "undefined" && c.pairingId !== null) ? c.pairingId : "?";
        if (seen[pid]) continue;
        seen[pid] = true;
        if (skipDecisions[pid + "|" + c.dstLang] === "skip") {
            diag.skipped++;
            continue;
        }
        live.push(c);
    }
    if (live.length === 0) return { action: null, diag: diag };

    var winner = null;
    if (live.length === 1) {
        // Unique match — no lang check (disambiguator never AND-gates).
        winner = live[0];
    } else {
        // 3. Collision — disambiguate by script class (dstLang vs scan
        //    dominantLang), both via langScriptTable.
        diag.collisions.push({
            storyIdx: t.storyIdx, idxStart: t.idxStart, idxEnd: t.idxEnd,
            sourceFont: t.sourceFont, sourceWeight: t.sourceWeight,
            candidatePairingIds: live.map(function (x) { return x.pairingId; })
        });
        var tsrClasses = _scriptClassesOf(t.dominantLang, langScriptTable);
        var survivors = [];
        if (tsrClasses) {
            for (var li = 0; li < live.length; li++) {
                var dstClasses = _scriptClassesOf(live[li].dstLang, langScriptTable);
                if (_classesIntersect(dstClasses, tsrClasses)) survivors.push(live[li]);
            }
        }
        if (survivors.length === 1) {
            winner = survivors[0];
        } else {
            // 4. Unresolvable tie (incl. missing langScriptTable data) —
            //    detect-and-report, never arbitrary pick (防 silent wrong-swap).
            diag.rejections.push({
                type: "byPair_collision_unresolvable",
                storyIdx: t.storyIdx, idxStart: t.idxStart, idxEnd: t.idxEnd,
                sourceFont: t.sourceFont, sourceWeight: t.sourceWeight,
                dominantLang: t.dominantLang,
                candidatePairingIds: live.map(function (x) { return x.pairingId; }),
                pairingId: live[0].pairingId,
                message: "byPair multi-target collision unresolvable — scan lang granularity insufficient to disambiguate (" +
                         (tsrClasses ? survivors.length + " script-class survivors" : "langScriptTable data missing") + ")"
            });
            return { action: null, diag: diag };
        }
    }

    // ── same-font short-circuit ──
    // The winner maps the run to the SAME font+weight it already has → no font
    // swap → a genuine no-op. (The #17 Y-model skew_apply variant path that used
    // to emit here was removed; byPair never auto-skews from source italic.)
    if (winner.dstFont === t.sourceFont && winner.dstWeight === t.sourceWeight) {
        diag.sameFontNoOp++;
        return { action: null, diag: diag };
    }

    // Field mapping per spec: byPair {dstFont,dstWeight} → action
    // {dstFamily,dstStyle}; source-side names align with resolveDocActions
    // (apply_to_doc error-samples render sourceFont/sourceWeight).
    var action = {
        storyIdx: t.storyIdx,
        idxStart: t.idxStart,
        idxEnd: t.idxEnd,
        cellPath: t.cellPath || null,
        dstFamily: winner.dstFont,
        dstStyle: winner.dstWeight,
        sourceFont: t.sourceFont,
        sourceWeight: t.sourceWeight,
        pairingId: winner.pairingId,
        sourceLang: winner.srcLang,
        dstLang: winner.dstLang,       // 8D-ext-D: enforcer preserve cjk-flag
        dominantLang: t.dominantLang,
        paraId: t.paraId,
        kind: "byPair_sweep"
    };
    diag.applied++;
    return { action: action, diag: diag };
}

module.exports = {
    _resolveTsrAgainstByPair: _resolveTsrAgainstByPair,
    _toCanonical: _toCanonical,
    _scriptClassesOf: _scriptClassesOf,
    _isSourceOwnedByPair: _isSourceOwnedByPair
};
