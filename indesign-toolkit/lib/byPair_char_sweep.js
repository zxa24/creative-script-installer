"use strict";

/**
 * lib/byPair_char_sweep.js — Phase 8D-ext-D shared facade (M3/M4/M5)
 *
 * Single-call ergonomics over the shipped 8D-ext-0 pipeline:
 *   scan (font_mapping_doc_scan) → coverage pre-check (byPair_script_coverage)
 *   → resolveByPairActions (font_mapping_resolve, net-new sibling)
 *   → applyActionsToDoc (font_mapping_apply_to_doc).
 *
 * 8D-ext-SA (2026-06-11): applyActionsToDoc is no longer a blind whole-range
 * swapper. For actions whose dstLang ∈ CJK_LANG_SET && sourceLang ∉ CJK_LANG_SET
 * (Latin source → CJK target), it re-fonts ONLY the CJK chars in the range and
 * leaves Latin/digit/halfwidth-punct on the source font. Consequence for our
 * return: `swapped` now counts a CJK-target range only when it contained ≥1 CJK
 * char that got re-fonted — a pure-Latin range under such a pair contributes 0
 * (it used to count as a swap). Latin→Latin and CJK→CJK pairs still whole-range
 * swap, so their swapped count is unchanged.
 *
 * Implements task_plan.md "### 8D-ext-D" facade spec verbatim (r13→r26):
 *   - hard no-op on empty byPair (reorganize double-click/bridge entries)
 *   - workDoc === app.activeDocument assertion (scanActiveDoc is hardwired
 *     to activeDocument; a mismatch would scan one doc and write another)
 *   - per-entry coverage: Stage-1 (uninstalled font) → warnings + skip-entry
 *     for ALL modes (r25 P2#5 softer routing — one bad pair must not kill
 *     the run; entry filtered out of resolve/apply); Stage-2 → warnings
 *   - M4 + empty langScriptTable + CJK byPair → rejections (hard block,
 *     r25 P2#4: the primary detectM4CJKHazard has no data — the fallback
 *     net must surface, no silent succeed)
 *   - M3 resolve-level rejections softened to warnings (r24 P2#2: an
 *     unresolvable collision must not destroy a successful reorganize;
 *     M4/M5 keep rejections → blocked → importer refuses save)
 *   - uniform return shape on all three exit paths (r20 P3)
 *   - `blocked` is the SOLE save-gate authority; `ok` may be true while
 *     blocked is true (apply_to_doc per-action failures only increment
 *     errors without flipping ok) — consumers must not check `ok` alone.
 *
 * opts: { mode: 'M3'|'M4'|'M5',          // REQUIRED for mode routing
 *         skipDecisions: {},              // pairingId|dstLang → 'skip'
 *         brandConfig: {},                // equivalence_groups for _toCanonical
 *         langScriptTable: {} }           // B2 deliverable
 *
 * Callers (per task_plan 调用 contexts):
 *   M3 — reorganize main(), inside its own doScript closure, AFTER #27
 *        restoreDocDirectOverrides + underline/rule dedup, last step before
 *        the :1241 close. Caller captures the result into stats and throws
 *        on blocked (its inner catch re-throws → ENTIRE_SCRIPT rollback).
 *   M4/M5 — import_translations_v2, inside the :1345 doScript closure,
 *        after runPipeline/runMinimalApply; importer ORs result.blocked
 *        into pipelineResult.blocked (never un-blocks).
 */

// MVP detail #2: isolated-module app resolution (Node tests tolerate absence).
var app;
try { app = require("indesign").app; } catch (eReq) {}

// r23 P2#1: CJK lang set — shared detection basis with detectM4CJKHazard
// (NOT langScriptTable[lang].required_scripts: a partial table that is
// non-empty but missing the CJK lang entry would silently pass, r26 P2#2).
var CJK_LANG_SET = { "zh-CN": true, "zh-TW": true, "zh-HK": true, "ja": true, "ko": true };

function _hasCJKFonts(byPair) {
    for (var i = 0; i < byPair.length; i++) {
        var p = byPair[i];
        if (p && (CJK_LANG_SET[p.srcLang] || CJK_LANG_SET[p.dstLang])) return true;
    }
    return false;
}

function _uniformReturn(fields) {
    var r = {
        ok: true,
        swapped: 0,
        errors: 0,
        errorSamples: [],
        actionsExecuted: 0,
        actionsTotal: 0,
        diagnostics: { collisions: [], rejections: [], warnings: [] },
        // 8D-ext-D: the resolve-stage actions that reached apply (already
        // excludes skipDecisions-skipped + coverage-rejected entries). M3's
        // post-facade enforcer builds its preserve list from THESE, so a
        // skipped/rejected pair can't exempt fonts document-wide (codex
        // step-2 P1#2). Empty on no-op / scan-fail paths.
        appliedActions: [],
        // TODO#34: [{pairingId, from:{font,weight}, to:{font,weight}}] — entries whose
        // dst passed Stage 1 via alias resolution and were forwarded as runtime copies
        // (config untouched). Report/log observability only — never a UI prompt
        // (owner: 自动合并不提示). Empty on no-op / scan-fail paths.
        aliasResolved: [],
        blocked: false
    };
    for (var k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) r[k] = fields[k];
    }
    return r;
}

function _copyWith(obj, extra) {
    var out = {};
    var k;
    for (k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]; }
    for (k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k]; }
    return out;
}

// Per-entry coverage screening (pure — verifyFn injected so Node tests can drive
// it without a host; production passes coverage.verifyDstFontScriptCoverage).
// Returns { validByPair, coverageWarnings, aliasResolved }.
function _screenByPairEntries(byPair, langScriptTable, verifyFn) {
    var coverageWarnings = [];
    var aliasResolved = [];
    var validByPair = [];
    for (var i = 0; i < byPair.length; i++) {
        var coverageResult = verifyFn(byPair[i], langScriptTable);
        if (coverageResult.stage1Reject) {
            // r22 P2#2: do NOT pass the entry to resolve/apply (would
            // substitute an uninstalled font). r25 P2#5: ALL modes route
            // Stage-1 to warnings + skip-entry; remaining pairs still apply.
            coverageWarnings.push(_copyWith(coverageResult, { type: "stage1_reject_softer_skip_entry" }));
        } else {
            var _rd = coverageResult.resolvedDst;
            if (_rd && _rd.font
                && (_rd.font !== byPair[i].dstFont || _rd.weight !== byPair[i].dstWeight)) {
                // TODO#34: Stage 1 passed via alias resolution — the config spelling
                // is not installed but the SAME font is, under the resolved name.
                // Forward a RUNTIME COPY with the installed name so resolve/apply
                // (resolve_core:340 inherits dstFont/dstWeight verbatim into the
                // action) writes a name InDesign can materialize. Forwarding the
                // config spelling here would pass the gate and then substitute at
                // write time — green-but-ineffective. The entry object from config
                // is NOT mutated; config is NEVER rewritten (owner: merge happens
                // in the gate; 自动合并不提示 — recorded in aliasResolved, no prompt).
                var _clone = _copyWith(byPair[i], { dstFont: _rd.font, dstWeight: _rd.weight });
                validByPair.push(_clone);
                aliasResolved.push({
                    pairingId: coverageResult.pairingId,
                    from: { font: byPair[i].dstFont, weight: byPair[i].dstWeight },
                    to: { font: _rd.font, weight: _rd.weight }
                });
            } else {
                validByPair.push(byPair[i]);
            }
            if (coverageResult.stage2Warning) coverageWarnings.push(coverageResult);
        }
    }
    return { validByPair: validByPair, coverageWarnings: coverageWarnings, aliasResolved: aliasResolved };
}

// 8D-ext-D step-3a — CANONICALIZE the sweep inputs at the facade choke point.
// This is THE single normalize point for the apply path. byPair reaches the
// facade from two producers: brand_config (projectByPairWithIndex, already
// canonical) and panel-source (passed directly, may carry raw region/script
// tags). Folding srcLang/dstLang to canonical identity keys here means EVERY
// downstream consumer — coverage (langScriptTable lookup), _hasCJKFonts
// (CJK_LANG_SET / the M4-empty-table hazard fallback), and resolve
// (_scriptClassesOf) — compares against the canonical langScriptTable +
// CJK_LANG_SET keys. Without it a raw "zh-Hans-CN" dstLang misses CJK_LANG_SET
// → M4 silently skips the CJK swap with no hazard surfaced, and misses
// langScriptTable → spurious "unknown target script".
//
// skipDecisions ALSO encodes dstLang in its keys ("pairingId|dstLang"); resolve
// now looks up the canonical dstLang (because byPair is canonicalized), so a
// raw-built key ("7|zh-Hans-CN") would miss resolve's canonical lookup
// ("7|zh-CN") and a pairing the user explicitly SKIPPED gets swapped anyway
// (silent). Re-key skipDecisions here on the SAME pass so skip keys travel with
// the langs they pin (codex step-3a A-class). Re-keying is idempotent because
// normalizeBcp47Identity is a FIXPOINT function (N(N(x)) === N(x), enforced by
// the idempotency property test in tests/lang_script_table_tests.js) — safe
// whether keys came in raw or canonical. CAVEAT (step-3a audit P3): two
// DISTINCT raw keys can fold to ONE canonical key ("7|zh-CN" + "7|zh-Hans-CN"
// both → "7|zh-CN"); the collision is last-write-wins by for-in order. Benign
// today because skipDecisions values are only ever 'skip' (the colliding
// writes are identical); it would matter only if mixed skip/apply values are
// ever stored under aliasing keys.
//
// Consumers receive canonical langs + canonical skip keys and MUST NOT
// re-normalize — single responsibility lives here.
function _canonicalizeSweepInputs(byPair, skipDecisions) {
    var _norm = require("./lang_script_table.js").normalizeBcp47Identity;

    var canonByPair = [];
    for (var ci = 0; ci < byPair.length; ci++) {
        var cp = byPair[ci];
        if (!cp) { canonByPair.push(cp); continue; }
        canonByPair.push(_copyWith(cp, {
            srcLang: _norm(cp.srcLang),
            dstLang: _norm(cp.dstLang)
        }));
    }

    var canonSkip = {};
    var sd = skipDecisions || {};
    for (var sk in sd) {
        if (!Object.prototype.hasOwnProperty.call(sd, sk)) continue;
        // key parse: first "|" separates numeric pairingId from lang (langs
        // contain no "|"). malformed / no-"|" key → pass through unchanged.
        var bar = sk.indexOf("|");
        if (bar === -1) { canonSkip[sk] = sd[sk]; continue; }
        var pid = sk.slice(0, bar);
        var lang = sk.slice(bar + 1);
        canonSkip[pid + "|" + _norm(lang)] = sd[sk];
    }

    return { byPair: canonByPair, skipDecisions: canonSkip };
}

function applyByPairSweep(doc, byPair, opts) {
    opts = opts || {}; // r24 P3: top-level default — uniform facade defensiveness

    // B-ui A-1 fix (empty-byPair classification + block): an empty byPair used to
    // hard no-op HERE — before any scan — so an unowned CJK run (a CJK font in no
    // pair) saved as silent tofu, and the standalone enforcer (gated on
    // swapped>0) was also off. We no longer blanket no-op: an empty byPair still
    // SCANS + CLASSIFIES (resolveByPairActions falls through to the core, which
    // classifies every CJK run as unowned / owned_missing_target), and the
    // unowned→rejection conversion below routes it to the `blocked` save-gate for
    // M4/M5. A truly empty doc (no TSRs) or a pure-Latin doc still nets a clean
    // no-op because the classification only fires for CJK runs (non-CJK targets
    // stay silent in resolve_core) → zero rejections → blocked:false. The old
    // "no byPair" no-op is therefore subsumed by the normal path with byPair=[].
    byPair = Array.isArray(byPair) ? byPair : [];

    // r13 iter1 NEW-1: scanActiveDoc(opts) is hardwired to app.activeDocument;
    // apply_to_doc writes the passed doc. A mismatch scans one doc and writes
    // another — assert instead.
    // UXP host objects are NOT ===-comparable — a fresh JS wrapper is minted on
    // every property access, so even `app.activeDocument === app.activeDocument`
    // is false. The original `app.activeDocument !== doc` was therefore ALWAYS
    // true → this guard threw on EVERY byPair sweep (the swap path is never
    // exercised by the structure-only M3 host test, so it stayed latent).
    // Compare by the stable `.id` instead. Host-confirmed 2026-06-10; same root
    // cause as the FontStatus enum fix (byPair_script_coverage.js:108).
    var _activeId = (app && app.activeDocument) ? app.activeDocument.id : null;
    var _docId = doc ? doc.id : null;
    if (app && _activeId !== _docId) {
        throw new Error("byPair_char_sweep: workDoc must === app.activeDocument");
    }

    // 8D-ext-D step-3a — choke-point canonicalize (byPair langs + skipDecisions
    // keys, see _canonicalizeSweepInputs). Both returned values flow downstream.
    var _canon = _canonicalizeSweepInputs(byPair, opts.skipDecisions);
    byPair = _canon.byPair;
    var canonSkipDecisions = _canon.skipDecisions;

    // r26 P3 note (gate-9): this is a second full-doc TSR walk inside the
    // caller's ENTIRE_SCRIPT closure (post-pipeline). V8 sync freeze adds up;
    // large-doc baseline to be recorded during acceptance. Scoped scan /
    // periodic yield are follow-up options if it bites.
    // B-ui A-3 fix: pass brandConfig so scanActiveDoc runs buildUnresolvedByLang
    // (it early-returns {} without a config) — the import path now surfaces the
    // owned_missing_target ownership predicate the panel already had, instead of
    // a blank unresolvedByLang. (The unowned-CJK block is independent — it rides
    // resolveByPairActions' unmappedCjk fold below — but owned_missing_target was
    // invisible on import until this config thread.)
    var scanResult = require("./font_mapping_doc_scan.js")
        .scanActiveDoc({ config: opts.brandConfig || null });
    if (!scanResult.ok) {
        return _uniformReturn({
            ok: false, blocked: true,
            reason: "scan failed: " + scanResult.reason
        });
    }

    // Coverage pre-check, per entry, BEFORE resolve (r21 P1#4 owner here).
    var coverage = require("./byPair_script_coverage.js");
    var coverageRejections = [];
    var _screened = _screenByPairEntries(byPair, opts.langScriptTable || {},
        coverage.verifyDstFontScriptCoverage);
    var coverageWarnings = _screened.coverageWarnings;
    var aliasResolved = _screened.aliasResolved;
    var validByPair = _screened.validByPair;

    // r25 P2#4: M4 + empty langScriptTable + CJK byPair → hard reject.
    // detectM4CJKHazard (the pre-pipeline primary authority) has no data in
    // this state; this fallback must block — "no silent succeed" acceptance.
    // M3/M5 same-script CJK byPair is reliable → no false positive (mode gate).
    var lstEmpty = true;
    var lst = opts.langScriptTable || {};
    for (var lk in lst) { if (Object.prototype.hasOwnProperty.call(lst, lk)) { lstEmpty = false; break; } }
    if (opts.mode === "M4" && lstEmpty && _hasCJKFonts(byPair)) {
        coverageRejections.push({
            type: "langScriptTable_empty_with_CJK_M4_blocked",
            message: "M4 + CJK byPair requires non-empty langScriptTable; primary detectM4CJKHazard unable to detect hazard"
        });
    }

    // B-ui A-5 (import接通): derive the unowned-CJK skip set so the import path
    // has the SAME skip逃生 the panel already has. On import there is no live
    // React fontSkip — the skip set arrives PERSISTED on brandConfig.font_skip
    // (an array of "font|weight" keys). buildFontSkipSet folds that array (and any
    // explicit opts.fontSkip map for automation callers) into the resolver's
    // { key:true } map. Omitted on both → {} → no skip (regression-lock: every
    // legacy facade call passes neither and behaves exactly as before).
    var _fontSkip = require("./import_byPair_wiring.js")
        .buildFontSkipSet(opts.fontSkip, opts.brandConfig || {});

    // Resolve — only valid (non-rejected) entries. brandConfig {} not null
    // (getCanonical tolerates {} and returns identity, r23 P3). 6th arg = the
    // skip set → resolve_core routes a skipped unowned CJK run to
    // unmappedCjk.skipped (non-blocking) instead of .unowned (blocked save-gate).
    var resolveOut = require("./font_mapping_resolve.js").resolveByPairActions(
        scanResult, validByPair, canonSkipDecisions, opts.brandConfig || {}, lst, _fontSkip);
    resolveOut.diagnostics = resolveOut.diagnostics || { collisions: [], rejections: [], warnings: [] };
    resolveOut.actions = resolveOut.actions || [];
    resolveOut.diagnostics.warnings = resolveOut.diagnostics.warnings || [];
    resolveOut.diagnostics.rejections = resolveOut.diagnostics.rejections || [];
    resolveOut.diagnostics.collisions = resolveOut.diagnostics.collisions || [];

    // UNIFY-converge Phase 1 B-ui (#6 import pre-save block): a truly-unconfigured
    // CJK font (unmappedCjk.unowned — source belongs to NO pair, CJK run) is a tofu
    // risk that today resolve-continues silently → the table CJK saves as tofu
    // (the bypair-unpaired-cjk-tofu root cause). Convert each unowned run into a
    // hard rejection (shared wiring helper) so it reaches the `blocked` save-gate
    // below — the importer discards the work copy instead of writing tofu. This is
    // INTENTIONALLY pushed BEFORE the M3-soften block: M3 (in-place reorganize)
    // softens it to a warning (one unmapped font must not roll back a reorganize),
    // M4/M5 (translation import) keep it → blocked (no silent save).
    // owned_missing_target is NOT converted — existing unresolved/skip semantics (#3).
    var _unmappedRej = require("./import_byPair_wiring.js")
        .buildUnmappedCjkRejections(resolveOut.diagnostics);
    for (var ui = 0; ui < _unmappedRej.length; ui++) {
        resolveOut.diagnostics.rejections.push(_unmappedRej[ui]);
    }

    // r24 P2#2: M3 softens resolve-level rejections (unresolvable collisions)
    // to warnings — one ambiguous pair must not roll back a successful
    // reorganize. M4/M5 keep rejections → blocked (refuse-save is safer for
    // the expensive translation pipeline).
    if (opts.mode === "M3" && resolveOut.diagnostics.rejections.length > 0) {
        for (var ri = 0; ri < resolveOut.diagnostics.rejections.length; ri++) {
            resolveOut.diagnostics.warnings.push(
                _copyWith(resolveOut.diagnostics.rejections[ri], { type: "resolve_reject_M3_softer" }));
        }
        resolveOut.diagnostics.rejections = [];
    }

    // Merge coverage results. Warnings never fire blocked.
    resolveOut.diagnostics.rejections = resolveOut.diagnostics.rejections.concat(coverageRejections);
    resolveOut.diagnostics.warnings = resolveOut.diagnostics.warnings.concat(coverageWarnings);

    // Apply — executor is script-aware for CJK-target actions (8D-ext-SA): a
    // Latin-source→CJK-target action re-fonts only the CJK chars, so `swapped`
    // counts such a range only when it held ≥1 CJK char (see header note).
    var applyOut = require("./font_mapping_apply_to_doc.js").applyActionsToDoc(doc, resolveOut.actions);

    return {
        ok: applyOut.ok && resolveOut.diagnostics.rejections.length === 0,
        swapped: applyOut.swapped,
        errors: applyOut.errors,
        errorSamples: applyOut.errorSamples,
        actionsExecuted: applyOut.actionsExecuted,
        actionsTotal: applyOut.actionsTotal,
        diagnostics: resolveOut.diagnostics,
        // resolve-stage actions that reached apply (skipDecisions-skipped +
        // coverage-rejected already excluded). M3 enforcer preserve builds
        // from these (codex step-2 P1#2).
        appliedActions: resolveOut.actions,
        aliasResolved: aliasResolved,
        // `blocked` is the sole save-gate authority. `ok` can be true while
        // blocked is true (per-action apply failures only increment errors);
        // consumers must not standalone-check `ok`.
        blocked: !applyOut.ok || applyOut.errors > 0 || resolveOut.diagnostics.rejections.length > 0
    };
}

module.exports = {
    applyByPairSweep: applyByPairSweep,
    _canonicalizeSweepInputs: _canonicalizeSweepInputs,
    _hasCJKFonts: _hasCJKFonts,
    _screenByPairEntries: _screenByPairEntries,   // TODO#34 (pure; Node-testable)
    CJK_LANG_SET: CJK_LANG_SET
};
