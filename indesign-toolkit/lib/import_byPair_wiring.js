"use strict";

/**
 * lib/import_byPair_wiring.js — 8D-ext-D step-3b importer wiring helpers
 *
 * The PURE parts of import_translations_v2's M4/M5 byPair UI step, extracted
 * so plain Node can test them (an .idjs entry is not Node-requirable — same
 * entry/lib split precedent as reorganize_styles_inplace → reorganize_inplace_core).
 * The idjs keeps only host work: dialogs, file reads, ctx assignment, the
 * facade call and the post-sweep enforcer loop.
 *
 * Spec: task_plan.md "DR3 split-entry" pseudocode (:2219-2266) + "Multi-source
 * reconstruction" + detectM4CJKHazard (:2154, r26 P2#2 basis = facade
 * CJK_LANG_SET) + ctx wiring (:2247/:2264).
 *
 * Host-free by construction: no require("indesign"), no fs.
 */

// r26 P2#2: the detection basis is the facade's CJK_LANG_SET — REQUIRED from
// byPair_char_sweep (object identity), NOT duplicated and NOT derived from
// langScriptTable[lang].required_scripts (a partial table that is non-empty
// but missing the CJK lang entry would silently pass).
var CJK_LANG_SET = require("./byPair_char_sweep.js").CJK_LANG_SET;
var LANG_SCRIPT_TABLE = require("./lang_script_table.js").LANG_SCRIPT_TABLE;

// ---------------------------------------------------------------------------
// resolveImporterModeDefault — DR3 split-entry importer default (:2224-2229)
// ---------------------------------------------------------------------------
// meta             — translations.json top-level _meta object (or null/garbage)
// skipStyleCleanup — the ALREADY-COMPUTED ctx.skipStyleCleanup (:553); passing
//                    it (rather than re-reading the payload) keeps the dialog
//                    default structurally consistent with the ctx field it
//                    will later override.
// cjkRouting       — OPTIONAL 3rd param (8D-ext-UNIFY-core F4 / REV gate-2 rung 4):
//                    { targetIsCJK, srcIsCJK, brandCjkResolvable }. OMITTED (or
//                    null/undefined) → _cjkRoute returns null at every rung, so
//                    the function reduces to today's EXACT branch logic
//                    (regression-lock; the omitted-arg call is byte-for-byte the
//                    pre-UNIFY behavior, and the live suite
//                    import_v2_byPair_wiring_tests.js still passes verbatim).
//
// Returns { mode: 'M4'|'M5'|null, block: bool, blockReason: string|null,
//           hint: string|null }
//
// THE LOCKED MODE PRECEDENCE LATTICE (REV gate-2; first match top→bottom):
//   rung 1  workflow_mode edit-only/bilingual → block (panel-apply-only, abort)
//   rung 3  skip_style_cleanup===true → M5     (translation branch ONLY — NOT
//           hoisted to the fallback; hoisting breaks the locked scope-lock test
//           import_v2_byPair_wiring_tests.js:62-63 AND would flip every legacy
//           no-_meta skip import M4→M5)
//   rung 4  CJK routing (_cjkRoute) — runs on translation AND fallback (A2):
//           srcIsCJK→M5; targetIsCJK→(brandCjkResolvable?M4:M5); else fall through
//   rung 5  default — translation→M4; missing/invalid _meta → M4 + hint
//   (rung 2, the headless automationOptions.byPairMode override, is applied at
//    the importer CALL SITE on top of this lib output — NOT here.)
function resolveImporterModeDefault(meta, skipStyleCleanup, cjkRouting) {
    var wm = (meta && typeof meta === "object") ? meta.workflow_mode : undefined;

    // Rung 1 — block (first; wins over everything incl. the headless override).
    if (wm === "edit-only" || wm === "bilingual") {
        return {
            mode: null, block: true,
            blockReason: "_meta.workflow_mode='" + wm + "' is a panel-apply-only workflow; "
                + "the translation importer (M4/M5) cannot apply it.",
            hint: null
        };
    }

    if (wm === "translation") {
        // Rung 3 — skip wins over CJK (translation-scoped; today's logic verbatim).
        if (skipStyleCleanup === true) {
            return { mode: "M5", block: false, blockReason: null, hint: null };
        }
        // Rung 4 — CJK routing (cjkRouting omitted → null → falls through == today).
        var m = _cjkRoute(cjkRouting);
        if (m) return { mode: m, block: false, blockReason: null, hint: null };
        // Rung 5 — translation default.
        return { mode: "M4", block: false, blockReason: null, hint: null };
    }

    // missing / invalid _meta — FALLBACK branch.
    // Rung 4 applies here too (A2). skip is deliberately NOT consulted (the
    // scope-lock regression import_v2_byPair_wiring_tests.js:62-63).
    var mf = _cjkRoute(cjkRouting);
    if (mf) return { mode: mf, block: false, blockReason: null, hint: "metadata missing; CJK routing → " + mf };
    // Rung 5 — fallback default (BYTE-identical to today when cjkRouting omitted).
    return { mode: "M4", block: false, blockReason: null, hint: "metadata missing, using default M4" };
}

// rung-4 helper (pure). Omitted/null cjkRouting → null at every rung → today's
// behavior verbatim. srcIsCJK preserves (M5); targetIsCJK routes on whether the
// brand CJK family actually resolves (M4 rebuild lands brand) else M5 (preserve).
function _cjkRoute(cjk) {
    if (!cjk) return null;
    if (cjk.srcIsCJK) return "M5";
    if (cjk.targetIsCJK) return cjk.brandCjkResolvable ? "M4" : "M5";
    return null;
}

// ---------------------------------------------------------------------------
// normalizeModeOverride — automationOptions.byPairMode sanitizer
// ---------------------------------------------------------------------------
// 'M4'/'M5' (any case, padded) → canonical; anything else → null (caller
// keeps the _meta-derived default).
function normalizeModeOverride(value) {
    if (typeof value !== "string") return null;
    var s = value.trim().toUpperCase();
    return (s === "M4" || s === "M5") ? s : null;
}

// ---------------------------------------------------------------------------
// detectM4CJKHazard — :2154 (r18 P1#3 + r23 P3 + r26 P2#2)
// ---------------------------------------------------------------------------
// projectedByPair — ALREADY-PROJECTED entries (projectByPairWithIndex output,
//                   canonical langs from birth).
// langScriptTable — accepted for signature parity with the spec'd call site
//                   but deliberately UNUSED for detection (r26 P2#2): the
//                   facade-shared CJK_LANG_SET is the single basis.
// Returns the hit entries (warning list for the modal); empty array = no hazard.
function detectM4CJKHazard(projectedByPair, langScriptTable) { // eslint-disable-line no-unused-vars
    var hits = [];
    if (!projectedByPair || !projectedByPair.length) return hits;
    for (var i = 0; i < projectedByPair.length; i++) {
        var p = projectedByPair[i];
        if (!p) continue;
        if (CJK_LANG_SET[p.srcLang] || CJK_LANG_SET[p.dstLang]) {
            hits.push({
                pairingId: p.pairingId,
                srcFont: p.srcFont, srcWeight: p.srcWeight,
                dstFont: p.dstFont, dstWeight: p.dstWeight,
                srcLang: p.srcLang, dstLang: p.dstLang
            });
        }
    }
    return hits;
}

// ---------------------------------------------------------------------------
// buildBrandConfigCandidatePaths — discovery priority (:2253)
// ---------------------------------------------------------------------------
// (1) <docPath-without-.indd/.idml>_brand_config.json next to the doc
// (2) <packageDir>/brand_config.json — the importer fully extracts ZIP
//     packages before this step runs, so a brand_config.json zip entry
//     materializes on disk next to translations.json; the same path covers
//     plain (non-zip) package folders.
// (3) user picker — deliberately NOT built here (TODO step-5); caller falls
//     back to byPair=[].
// Pure path-string construction; existence checks are the caller's job.
function buildBrandConfigCandidatePaths(docPathStr, packageDirStr) {
    var out = [];
    var doc = String(docPathStr || "");
    if (doc) {
        var stem = doc.replace(/\.(indd|idml)$/i, "");
        out.push({ tier: 1, path: stem + "_brand_config.json" });
    }
    var pkg = String(packageDirStr || "");
    if (pkg) {
        var sep = (pkg.indexOf("\\") >= 0) ? "\\" : "/";
        out.push({ tier: 2, path: pkg.replace(/[\\\/]+$/, "") + sep + "brand_config.json" });
    }
    return out;
}

// ---------------------------------------------------------------------------
// TODO#63 — describe the WHOLE ladder, not just the rung that won
// ---------------------------------------------------------------------------
// MEASURED FIRST (arch: 先量再改). 35 historical import_integrated logs, 32 with an
// outcome:
//     loaded tier 0 : 20        tier 1 : 0        tier 2 : 0        not_found : 12
// i.e. 🔴 two of the three rungs have never carried anyone, ever. Two structural
// reasons, both checked rather than assumed:
//   - tier 2 (`<packageDir>/brand_config.json`): export never writes a brand_config
//     into a package (grep of the export side: zero hits), so the file is not there
//     unless a human puts it there by hand.
//   - tier 1 (`<docStem>_brand_config.json`): 🔴 NOTHING IN PRODUCTION WRITES THAT
//     NAME either. The only producer of it in the whole repo is a probe fixture
//     builder (probes/20260610_04). What the panel actually exports is
//     `font_apply_<brand>.json`, saved wherever the operator chooses.
//
// And a third thing the logs show, which is the one that actually bites: when nothing
// is found, the log says exactly `brand_config status: not_found` and NOTHING ELSE —
// no list of what was looked for. So a reader cannot tell whether the code even
// looked, or where. 🔴 That is the real silence here, and it is wider than the
// "tier 0 shadowed tier 1" case arch asked about — in the observed data tier 1 never
// exists to be shadowed.
//
// This function therefore returns the ladder ALWAYS, including the rungs that are
// not consulted, each tagged with the role it is playing. Existence checks stay with
// the caller (they need host fs); `exists` is filled in there.
//
// ⚠ It does NOT change which rung wins. owner settled that: 「③不改，如果包里也有
// 又选了一个配置则用另选的」. Priority is untouched; only the silence is.
function describeBrandConfigLadder(docPathStr, packageDirStr, pickedPathStr) {
    var rungs = [];
    var picked = String(pickedPathStr || "");
    if (picked) rungs.push({ tier: 0, path: picked, role: "selected" });
    var auto = buildBrandConfigCandidatePaths(docPathStr, packageDirStr);
    for (var i = 0; i < auto.length; i++) {
        rungs.push({
            tier: auto[i].tier,
            path: auto[i].path,
            // "shadowed" is deliberate wording: with a tier-0 pick these paths are
            // never even constructed by the loader, so this is the ONLY place they
            // are ever named.
            role: picked ? "shadowed" : "candidate"
        });
    }
    return rungs;
}

// Render the ladder for the log — one line per rung, always, whatever the outcome.
// `rungs` entries may carry `exists: true|false|null` (null = not checked).
function formatBrandConfigLadder(rungs) {
    var out = [];
    for (var i = 0; i < (rungs || []).length; i++) {
        var r = rungs[i];
        var mark = r.exists === true ? "present"
                 : r.exists === false ? "absent"
                 : "not checked";
        out.push("  tier " + r.tier + " [" + r.role + "] " + mark + " — " + r.path);
    }
    return out;
}

// ---------------------------------------------------------------------------
// TODO#63 (a) — does the chosen config look like it belongs to THIS job?
// ---------------------------------------------------------------------------
// arch: 「tier 0 也要过归属校验（不符出声，不硬拦）」.
//
// 🔴 Deliberately NOT a match/mismatch verdict — it is a list of reasons to doubt,
// and an empty list means "nothing to say", NOT "verified correct". The only thing
// available to check against at this point in the importer is the package `_meta`
// (source/target language), and a brand config legitimately need not enumerate every
// language a job touches. So this can produce false alarms in one direction only:
// it can doubt a config that is fine. It must never block.
//
// ⚠ Silence when there is nothing to compare: no `_meta` languages, or a config
// with no `fonts_by_language`, produces NO warning. "I could not check" is not
// evidence of "wrong" — the same rule the identity gate follows (#58 ③).
//
// `sameLang` is injected so the caller passes the SHARED comparator; a raw compare
// fallback keeps this module Node-testable and is strictly the stricter direction
// (it can only produce MORE doubt, never less).
function checkBrandConfigAttribution(config, facts, sameLang) {
    var doubts = [];
    if (!config || typeof config !== "object") return doubts;
    var fbl = config.fonts_by_language;
    if (!fbl || typeof fbl !== "object") return doubts;   // nothing to compare
    var langs = Object.keys(fbl);
    if (!langs.length) return doubts;                      // nothing to compare
    var same = typeof sameLang === "function"
        ? sameLang
        : function (a, b) { return String(a == null ? "" : a) === String(b == null ? "" : b); };
    function covers(want) {
        for (var i = 0; i < langs.length; i++) {
            if (same(langs[i], want) && (fbl[langs[i]] || []).length) return true;
        }
        return false;
    }
    var f = facts || {};
    var tgt = f.targetLang ? String(f.targetLang) : "";
    var src = f.sourceLang ? String(f.sourceLang) : "";
    if (tgt && !covers(tgt)) {
        doubts.push("this job's target language " + tgt + " has no fonts in the config"
            + " (it covers: " + langs.join(", ") + ")");
    }
    if (src && !covers(src)) {
        doubts.push("this job's source language " + src + " has no fonts in the config"
            + " (it covers: " + langs.join(", ") + ")");
    }
    return doubts;
}

// ---------------------------------------------------------------------------
// resolveLangScriptTable — fallback chain (audit P2 closure)
// ---------------------------------------------------------------------------
// brand_config.langScriptTable (non-empty object, optional field) ELSE the
// vendored B2 LANG_SCRIPT_TABLE. An empty {} config field is treated as
// absent — wiring the vendored table is strictly better than an empty one
// (an empty table would trip the facade's M4+CJK hard reject even though
// real data exists).
function resolveLangScriptTable(brandConfig) {
    var t = brandConfig && brandConfig.langScriptTable;
    if (t && typeof t === "object" && !Array.isArray(t)) {
        for (var k in t) {
            if (Object.prototype.hasOwnProperty.call(t, k)) return t;
        }
    }
    return LANG_SCRIPT_TABLE;
}

// ---------------------------------------------------------------------------
// buildSkipKey — resolver skip-decision key shape (r25 P3: dstLang pinned)
// ---------------------------------------------------------------------------
function buildSkipKey(pairingId, dstLang) {
    return String(pairingId) + "|" + String(dstLang);
}

// ---------------------------------------------------------------------------
// buildFontSkipSet — UNIFY-converge Phase 1 B-ui (A-5 import接通)
// ---------------------------------------------------------------------------
// The resolver's unowned-CJK skip channel is a map { "font|weight": true }
// (resolve_core rcx.fontSkipSet / resolveByPairActions' 6th arg). On the PANEL
// path the map is built in React and threaded directly via opts.fontSkip; on the
// IMPORT path there is no live React, so the skip set must arrive PERSISTED in
// the brand_config — as the optional top-level `config.font_skip` ARRAY of
// "font|weight" keys (schema-safe: validateBrandConfig ignores unknown keys, the
// same orthogonal-block precedent as faux_italic / equivalence_groups).
//
// This pure helper normalizes EITHER source into the resolver's map shape so the
// facade can read it host-free:
//   • an explicit opts.fontSkip map (already { key:true }) — passes through, OR
//   • a brand_config.font_skip array (["font|weight", ...]) — folded to a map.
// The explicit map (if non-empty) wins; otherwise the persisted config array is
// used. Omitted / garbage → {} (regression-lock: no skip, every legacy import
// behaves exactly as before).
function buildFontSkipSet(explicitMap, brandConfig) {
    var out = {};
    var bc = brandConfig || {};
    if (Array.isArray(bc.font_skip)) {
        for (var i = 0; i < bc.font_skip.length; i++) {
            var k = bc.font_skip[i];
            if (typeof k === "string" && k) out[k] = true;
        }
    }
    // An explicit (panel/automation) map overrides — its keys union onto the
    // persisted set so a per-run skip can ADD to the config's baseline.
    if (explicitMap && typeof explicitMap === "object" && !Array.isArray(explicitMap)) {
        for (var ek in explicitMap) {
            if (Object.prototype.hasOwnProperty.call(explicitMap, ek) && explicitMap[ek]) {
                out[ek] = true;
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// configHasMeaning — re-audit残留-2 (skip-only config acceptance gate)
// ---------------------------------------------------------------------------
// A panel/brand config carries ACTIONABLE content iff it has ≥1 pair OR a
// non-empty top-level `font_skip` set. The import entry's old gate accepted a
// panel config ONLY when `pairs.length` — so a SKIP-ONLY config (the user
// triaged every unowned-CJK font via Skip → `pairs: []` + `font_skip: [...]`)
// was dropped, __brandConfig stayed null, and the facade then re-derived those
// CJK fonts as .unowned → M4/M5 BLOCKED the save the user skipped to unblock.
// Accepting a skip-only config lets its font_skip ride
// ctx.preloadedFontMapping.brandConfig → buildFontSkipSet → resolver routes the
// runs to .skipped (non-blocking); byPair stays [] (no swaps), which is correct.
//
// equivalence_groups alone are intentionally NOT counted: they only fold/merge
// existing mapping membership, so without a pair or a skip there is nothing to
// apply or persist that changes the import outcome — keeping the legacy
// empty-config "cancelled / no mapping" behavior for a groups-only artifact.
function configHasMeaning(cfg) {
    if (!cfg || typeof cfg !== "object") return false;
    if (Array.isArray(cfg.pairs) && cfg.pairs.length) return true;
    if (Array.isArray(cfg.font_skip) && cfg.font_skip.length) return true;
    return false;
}

// ---------------------------------------------------------------------------
// buildPreloadedFontMapping + buildCtxFields — ctx wiring shape (:2247/:2264)
// ---------------------------------------------------------------------------
// B-ui A-5: the persisted unowned-CJK skip set rides ON brandConfig.font_skip
// (single source of truth), so buildPreloadedFontMapping carries no separate
// fontSkip field — the facade derives it from preloadedFontMapping.brandConfig
// via buildFontSkipSet. Keeping it on the config (not a sibling ctx field) means
// the skip persists through the SAME export/round-trip path as the rest of the
// mapping, and the panel and import paths read it identically.
function buildPreloadedFontMapping(byPair, skipDecisions, brandConfig, langScriptTable) {
    return {
        source: "brand_config",
        byPair: byPair || [],
        skipDecisions: skipDecisions || {},
        brandConfig: brandConfig || null,
        langScriptTable: langScriptTable || {}
    };
}

// runEnforcer is a TOP-LEVEL ctx field, not nested in preloadedFontMapping
// (r19 iter3 subprocess fix). Default-on: anything except explicit false → true.
function buildCtxFields(mode, preloadedFontMapping, runEnforcer) {
    return {
        skipStyleCleanup: (mode === "M5"),
        preloadedFontMapping: preloadedFontMapping,
        runEnforcer: (runEnforcer !== false)
    };
}

// ---------------------------------------------------------------------------
// buildEnforcerPreserveList — post-sweep enforcer preserve list
// ---------------------------------------------------------------------------
// From the facade's appliedActions (resolve-stage actions that reached apply —
// skipDecisions-skipped + coverage-rejected already excluded, codex step-2
// P1#2): dedup by font-key + cjk flag. Mirrors the M3 pattern
// (reorganize_inplace_core.js :1328-1380) so all three modes build the same
// preserve shape.
//
// A-4 fix (panel-converge B-core): the `cjk` flag MUST be derived from the
// DESTINATION script, NOT (sourceLang||dstLang). The enforcer matches a
// preserve entry per-character: `preserve[].cjk === isCJK` where `isCJK` is the
// script class of the CHARACTER under the swept run (script_font_enforcer.js
// :236/:259). The swept run holds destination-script characters, so the flag
// has to reflect the DESTINATION. The old OR标记 a zh-CN→en (Latin-dest) action
// as cjk:true (because sourceLang=zh-CN ∈ CJK_LANG_SET) → its Latin chars
// (isCJK=false) never matched the preserve entry → the enforcer overwrote the
// correctly-swapped Latin destination font on those chars. Derive strictly from
// the destination lang's script class.
//
// Note: the live import suite's existing assertions (en→fr ⇒ cjk:false,
// zh-CN→zh-TW ⇒ cjk:true) are UNCHANGED — both have dst-script == "either-side"
// result. Only the REVERSE CJK→Latin direction flips (true→false), which is the
// bug being fixed.
function buildEnforcerPreserveList(appliedActions) {
    var preserve = [];
    var seen = {};
    var acts = appliedActions || [];
    for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        if (!a || !a.dstFamily) continue;
        var key = a.dstFamily + "|" + a.dstStyle;
        // Destination script class. dstLang is set on every action that reaches
        // apply (resolve_core byPair_sweep + panel a4_normalize both set it);
        // fall back to sourceLang ONLY if dstLang is somehow absent (legacy /
        // malformed action) so an undefined dstLang doesn't silently force
        // cjk:false on a CJK run.
        var cjk = (typeof a.dstLang !== "undefined" && a.dstLang !== null)
            ? !!CJK_LANG_SET[a.dstLang]
            : !!CJK_LANG_SET[a.sourceLang];
        var pk = key + "|" + cjk;
        if (seen[pk]) continue;
        seen[pk] = true;
        preserve.push({ key: key, cjk: cjk });
    }
    return preserve;
}

// ---------------------------------------------------------------------------
// normalizeSkipDecisions — automationOptions.skipDecisions sanitizer (FIX 2b)
// ---------------------------------------------------------------------------
// The interactive dialog produces { "pairingId|dstLang": "skip" } (buildSkipKey
// keys). The headless / automationOptions path must accept the SAME shape so a
// bridge caller can skip individual pairs per-pair, exactly like the dialog
// checkboxes. Non-object / array / null → {} (preserves the prior automation
// behavior: no skips). Shallow-copies own enumerable keys; values pass through
// untouched (only 'skip' is meaningful today — the facade re-keys + consumes).
function normalizeSkipDecisions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    var out = {};
    for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = value[k];
    }
    return out;
}

// ---------------------------------------------------------------------------
// brandConfigStatus — discovery outcome → persisted-report status (FIX 2a)
// ---------------------------------------------------------------------------
// loadedPath      — path of the brand_config that parsed AND validated (the
//                   idjs discovery loop sets it in the ok branch), else "".
// foundButInvalid — a candidate file WAS read off disk but failed JSON.parse
//                   or validateBrandConfig (idjs sets it in the else / catch).
// No file read at any tier → "not_found": empty byPair stays a valid no-op
// (r19 P1#2 — legacy packages need not carry a config), but this string makes
// that no-op NON-SILENT in the saved report so the operator can see "no font
// mapping was applied because no brand_config was found".
function brandConfigStatus(loadedPath, foundButInvalid) {
    if (loadedPath) return "found:" + loadedPath;
    if (foundButInvalid) return "found_but_invalid";
    return "not_found";
}

// ---------------------------------------------------------------------------
// buildUnmappedCjkRejections — UNIFY-converge Phase 1 B-ui (#6 import pre-save block)
// ---------------------------------------------------------------------------
// The resolver now emits a SHARED unmappedCjk surface model on its diagnostics:
//   { unowned: [run...], owned_missing_target: [run...] }
// A `unowned` run is a CJK font that belongs to NO pair — applying nothing would
// SAVE it as tofu/unstyled CJK (the bypair-unpaired-cjk-tofu root cause). The
// import path must NOT save silently; convert each unowned run into a HARD
// rejection so it reaches the facade's `blocked` save-gate (the importer then
// discards the work copy). `owned_missing_target` is deliberately NOT converted —
// it keeps the existing unresolved/skip semantics (#3) and does not block.
//
// Pure: takes a resolver diagnostics object, returns a rejection[] (possibly
// empty). The facade concats these into resolveOut.diagnostics.rejections BEFORE
// the M3-soften / blocked computation, so M3 softens (in-place reorganize must
// not roll back over one unmapped font) while M4/M5 (translation import) block.
function buildUnmappedCjkRejections(diagnostics) {
    var out = [];
    var um = (diagnostics && diagnostics.unmappedCjk && diagnostics.unmappedCjk.unowned) || [];
    for (var i = 0; i < um.length; i++) {
        var r = um[i] || {};
        out.push({
            type: "unmapped_cjk_unowned_blocked",
            storyIdx: r.storyIdx, idxStart: r.idxStart, idxEnd: r.idxEnd,
            cellPath: r.cellPath || null,
            targetLang: r.targetLang,
            sourceFont: r.sourceFont, sourceWeight: r.sourceWeight,
            message: "unmapped CJK font '" + r.sourceFont + "/" + r.sourceWeight +
                     "' (target " + r.targetLang + ") belongs to no pair — would save as " +
                     "tofu/unstyled CJK. Add a pair for it or explicitly skip before saving."
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// buildByPairSweepSummary — persisted-report sweep summary (FIX 1)
// ---------------------------------------------------------------------------
// applyByPairSweep returns its diagnostics onto the EPHEMERAL
// pipelineResult.byPairSweep only; this folds the operator-relevant subset into
// the report.json that survives the run, so an uninstalled-dstFont Stage-1 skip
// (r25 P2#5 softer routing: correctly does NOT block) is no longer invisible.
//
// sweepOut — facade return { swapped, errors, blocked, diagnostics:{...} } (or
//            null/garbage → defensive zeroed summary).
// meta     — { mode, projectedPairs, projectedEntries } the wiring step already
//            knows. projectedPairs = distinct (pairingId, dstLang) group count
//            (the honest pairing-direction count); projectedEntries = raw
//            fan-out row count (N per MM pairing). 8D-ext-MM byPair-preview
//            cosmetic: report `projected_pairs` no longer carries the inflated
//            row count.
//
// `skipped` pulls the Stage-1 uninstalled-font skip entries (diagnostics.warnings,
// type 'stage1_reject_softer_skip_entry') into a stable shape with `reason`.
// src* fields are carried WHEN present — today coverage warning entries carry
// only dst*/pairingId/message (no src*), so those map to null rather than being
// invented (断言纪律: don't fabricate fields the producer doesn't emit). The
// REMAINING (non-skip) warnings stay raw in `warnings` so nothing is lost;
// `rejections` (the hard-block list) is carried verbatim.
function buildByPairSweepSummary(sweepOut, meta) {
    meta = meta || {};
    var diag = (sweepOut && sweepOut.diagnostics) || {};
    var warnings = diag.warnings || [];
    var rejections = diag.rejections || [];
    var skipped = [];
    var otherWarnings = [];
    for (var i = 0; i < warnings.length; i++) {
        var w = warnings[i] || {};
        if (w.type === "stage1_reject_softer_skip_entry") {
            skipped.push({
                pairingId: (w.pairingId != null) ? w.pairingId : null,
                srcFont:   (w.srcFont != null) ? w.srcFont : null,
                srcWeight: (w.srcWeight != null) ? w.srcWeight : null,
                dstFont:   (w.dstFont != null) ? w.dstFont : null,
                dstWeight: (w.dstWeight != null) ? w.dstWeight : null,
                srcLang:   (w.srcLang != null) ? w.srcLang : null,
                dstLang:   (w.dstLang != null) ? w.dstLang : null,
                reason:    w.message || w.warningType || w.type || null
            });
        } else {
            otherWarnings.push(w);
        }
    }
    // B-ui A-3 fix: carry the shared unmapped-CJK surface into the PERSISTED
    // report so an unowned-CJK block (or an owned_missing_target surface) is not
    // lost once the ephemeral pipelineResult.byPairSweep is gone. The unowned
    // entries are the operator-actionable "add a pair or it saves as tofu" list;
    // owned_missing_target rides along for context (it does not block). Defensive
    // default keeps the field a stable shape even on a zeroed/garbage sweepOut.
    var um = (diag.unmappedCjk &&
              typeof diag.unmappedCjk === "object") ? diag.unmappedCjk : {};
    var unmappedCjk = {
        unowned: Array.isArray(um.unowned) ? um.unowned : [],
        owned_missing_target: Array.isArray(um.owned_missing_target) ? um.owned_missing_target : [],
        // UNIFY model rule-2 (persist diagnostics UNCONDITIONALLY) [A-3]: the
        // explicitly-skipped unowned runs (A-5) are part of the same shared
        // surface. Persisting them lets the report distinguish "blocked on unowned"
        // (needs action) from "accepted-as-tofu via skip" (terminal, non-blocking)
        // instead of dropping the skip record once the ephemeral sweep is gone.
        skipped: Array.isArray(um.skipped) ? um.skipped : []
    };
    return {
        mode: meta.mode || null,
        projected_pairs: (typeof meta.projectedPairs === "number") ? meta.projectedPairs : null,
        projected_entries: (typeof meta.projectedEntries === "number") ? meta.projectedEntries : null,
        swapped: (sweepOut && typeof sweepOut.swapped === "number") ? sweepOut.swapped : 0,
        errors: (sweepOut && typeof sweepOut.errors === "number") ? sweepOut.errors : 0,
        blocked: !!(sweepOut && sweepOut.blocked),
        skipped: skipped,
        warnings: otherWarnings,
        rejections: rejections,
        unmappedCjk: unmappedCjk
    };
}

// ---------------------------------------------------------------------------
// 8D-ext-bypair-tofu-ux — early-warning + interactive-resolution helpers
// ---------------------------------------------------------------------------
// PURE (Node-testable, no host). Consumed by import_integrated.idjs Hook A
// (early warning, pre-pipeline) + Hook B (interactive end-sweep). See
// docs/8D-ext-bypair-tofu-ux-IMPL-SPEC.md.

// buildSyntheticTofuScan — rewrite a source-doc scan's dominantLang so the
// SAME resolveByPairActions unowned predicate the end sweep uses predicts which
// SOURCE fonts will become tofu after translation to a CJK target. Per-TSR rule
// (spec §3.2): null-dominant (neutral) → DROP (end sweep never classifies a
// null-dominant run — resolve_core gates on CJK_LANG_SET[dominantLang]; keeping
// them as CJK would flood the early dialog with page-numbers/bullets/numeric
// cells = false positives; the genuinely-translated null→CJK case is caught by
// the end-sweep backstop / Hook B). dominantLang already CJK → keep (source
// already CJK, classify as-is). non-CJK (en/…) → override to canonTgtLang (it
// will be translated to the CJK target). Every other field cloned verbatim so
// resolve_core reads identical storyIdx/idxStart/idxEnd/cellPath/sourceFont/
// sourceWeight/paraId (buildUnmappedCjkRejections reads cellPath/paraId).
//   scanResult   — scanActiveDoc() output (needs .tsrMap). null/garbage → {ok:true,tsrMap:[]}.
//   canonTgtLang — canonical target CJK lang (caller normalizes).
//   cjkLangSet   — CJK_LANG_SET (membership).
//   normalizeFn  — normalizeBcp47Identity (for the dominantLang CJK check).
// Returns { ok:true, tsrMap:[...] } — feed directly to resolveByPairActions.
function buildSyntheticTofuScan(scanResult, canonTgtLang, cjkLangSet, normalizeFn) {
    var src = (scanResult && Array.isArray(scanResult.tsrMap)) ? scanResult.tsrMap : [];
    var cjk = cjkLangSet || {};
    var norm = (typeof normalizeFn === "function") ? normalizeFn : function (x) { return x; };
    var out = [];
    for (var i = 0; i < src.length; i++) {
        var t = src[i];
        if (!t) continue;
        var dl = t.dominantLang;
        var ndl;
        if (dl === null || typeof dl === "undefined") {
            continue;                                   // neutral → drop (§3.2)
        } else if (cjk[norm(dl)]) {
            ndl = norm(dl);                             // already CJK → keep
        } else {
            ndl = canonTgtLang;                         // non-CJK → translated to target
        }
        var c = {};
        for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) c[k] = t[k]; }
        c.dominantLang = ndl;
        out.push(c);
    }
    return { ok: true, tsrMap: out };
}

// nearestCjkWeightDefault — pick the default dst (font, weight) for the add-pair
// <select> by nearest weight-CLASS match (spec §4.2). srcWeight is folded to a
// class via styleAliasFn (font_mapping_doc_scan.styleAlias); the first cjkFonts
// entry whose weight folds to the same class wins; else the first cjkFonts entry.
//   srcWeight     — source weight string (e.g. "Bold").
//   cjkFonts      — [{font, weight}] = fonts_by_language[targetLang] (or a
//                   byPair-dst-derived roster per §4.2 fallback).
//   styleAliasFn  — styleAlias(weight) → canonical class | null.
// Returns { font, weight } | null (null when cjkFonts empty → caller hides add-pair).
function nearestCjkWeightDefault(srcWeight, cjkFonts, styleAliasFn) {
    var list = Array.isArray(cjkFonts) ? cjkFonts : [];
    if (!list.length) return null;
    var aliasFn = (typeof styleAliasFn === "function") ? styleAliasFn : function () { return null; };
    var srcClass = aliasFn(srcWeight);
    if (srcClass) {
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (e && e.font && aliasFn(e.weight) === srcClass) return { font: e.font, weight: e.weight };
        }
    }
    var f = list[0];
    return (f && f.font) ? { font: f.font, weight: f.weight } : null;
}

// _ensureFontRegistered — idempotently add (font, weight) to
// config.fonts_by_language[lang]. Keeps the config validateBrandConfig-clean
// after an add-pair (validate requires every pair member to be in
// fonts_by_language[member.lang], font_mapping_pairs.js:106-110).
function _ensureFontRegistered(config, lang, font, weight) {
    if (!config.fonts_by_language || typeof config.fonts_by_language !== "object") {
        config.fonts_by_language = {};
    }
    if (!Array.isArray(config.fonts_by_language[lang])) config.fonts_by_language[lang] = [];
    var arr = config.fonts_by_language[lang];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].font === font && arr[i].weight === weight) return;
    }
    arr.push({ font: font, weight: weight });
}

// addPairToConfig — IN-PLACE add a 2-member cross-lang pair for a tofu-resolution
// "add pair" choice (spec §5 / §3.3). MUTATES the passed config (must be the SAME
// instance ctx.preloadedFontMapping holds by reference). Also registers BOTH
// members into fonts_by_language so the config stays validateBrandConfig-clean
// (round-3 A1 fix). The src font is the unowned/orphan font → it is in no existing
// pair → its byPair row is the sole rawIdx occupant → no collision in resolve_core;
// a 2-member cross-lang pair (1 member per lang) never reads representative_by_lang.
// Returns the mutated config.
function addPairToConfig(config, srcLang, srcFont, srcWeight, dstLang, dstFont, dstWeight) {
    if (!config || typeof config !== "object") return config;
    if (!Array.isArray(config.pairs)) config.pairs = [];
    config.pairs.push({
        members: [
            { lang: srcLang, font: srcFont, weight: srcWeight },
            { lang: dstLang, font: dstFont, weight: dstWeight }
        ]
    });
    _ensureFontRegistered(config, srcLang, srcFont, srcWeight);
    _ensureFontRegistered(config, dstLang, dstFont, dstWeight);
    return config;
}

// addFontSkip — IN-PLACE add a "font|weight" key to config.font_skip for an
// "accept tofu" choice (spec §5 / §3.3). MUTATES the passed config (same instance
// ctx holds). Idempotent (dedup). Key shape matches buildFontSkipSet (:210) +
// resolve_core fontSkipSet consumer (:296). Returns the mutated config.
function addFontSkip(config, srcFont, srcWeight) {
    if (!config || typeof config !== "object") return config;
    if (!Array.isArray(config.font_skip)) config.font_skip = [];
    var key = String(srcFont) + "|" + String(srcWeight);
    if (config.font_skip.indexOf(key) < 0) config.font_skip.push(key);
    return config;
}

module.exports = {
    CJK_LANG_SET: CJK_LANG_SET,
    resolveImporterModeDefault: resolveImporterModeDefault,
    normalizeModeOverride: normalizeModeOverride,
    detectM4CJKHazard: detectM4CJKHazard,
    buildBrandConfigCandidatePaths: buildBrandConfigCandidatePaths,
    // TODO#63 — the ladder is described in full (including rungs never consulted)
    // and the chosen config is questioned; neither changes which rung wins.
    describeBrandConfigLadder: describeBrandConfigLadder,
    formatBrandConfigLadder: formatBrandConfigLadder,
    checkBrandConfigAttribution: checkBrandConfigAttribution,
    resolveLangScriptTable: resolveLangScriptTable,
    buildSkipKey: buildSkipKey,
    buildFontSkipSet: buildFontSkipSet,
    configHasMeaning: configHasMeaning,
    buildPreloadedFontMapping: buildPreloadedFontMapping,
    buildCtxFields: buildCtxFields,
    buildEnforcerPreserveList: buildEnforcerPreserveList,
    normalizeSkipDecisions: normalizeSkipDecisions,
    brandConfigStatus: brandConfigStatus,
    buildUnmappedCjkRejections: buildUnmappedCjkRejections,
    buildByPairSweepSummary: buildByPairSweepSummary,
    // 8D-ext-bypair-tofu-ux: early-warning + interactive-resolution helpers
    buildSyntheticTofuScan: buildSyntheticTofuScan,
    nearestCjkWeightDefault: nearestCjkWeightDefault,
    addPairToConfig: addPairToConfig,
    addFontSkip: addFontSkip
};
