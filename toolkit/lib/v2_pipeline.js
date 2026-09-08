"use strict";

/**
 * lib/v2_pipeline.js
 *
 * Phase 1-4 pipeline orchestration — extracted from import_translations_v2.idjs
 * so the same logic can drive both the .idjs entry point AND the bridge-based
 * automated test runner (tests/bridge/bridge_run_v2_pipeline.js).
 *
 * Two functions:
 *
 *   applyOnePara(workDoc, locateResult, sheet, plan, translation, applyResults, deps)
 *     Per-paragraph commit step: assign cluster style, write target text,
 *     apply annotations[], track format_mixed_not_restored.
 *
 *   runPipeline(workDoc, ctx, deps) → { aborted, blocked, plan, locatePlan,
 *                                       preflight, sheet?, applyResults?, postflight? }
 *     5-stage pipeline orchestration:
 *       ① Analyze (buildStylePlan + locateAllSegments + runPreflight)
 *       ② Gate (block on preflight.blocking)
 *       ③ Commit (commitStylePlanGuarded + applyOnePara × N)
 *       ④ Postflight (runPostflight)
 *     Returns the result object the caller uses to decide saveTarget routing
 *     (.translated.indd / .BLOCKED.indd / .QUARANTINED.indd / .aborted.indd).
 *
 * UXP / ExtendScript compatibility:
 *   - Pure module + dependency injection via deps argument
 *   - var only, no ES6+
 *   - All InDesign API + lib refs come through deps:
 *       deps.findFont
 *       deps.LinkStatus, deps.ColorSpace, deps.Position
 *       deps.getCollectionItem
 *       deps.hashFn
 *       deps.lib.fontMapping / segmentLocator / styleSheetBuilder /
 *               styleApplier / hardErrors
 *
 * ctx shape:
 *   { report,                  // mutable report object — pipeline writes
 *                              // pipeline_stage / style_plan / locate /
 *                              // preflight / apply / postflight / errors[]
 *     segments,                // array from segments.json
 *     translations,            // { rows, byTid }
 *     fontPolicy }             // optional override; null = lib defaults
 */

// #BRIDGE-25: script-font enforcer is a top-level dep (translation-agnostic
// post-apply pass — see lib/script_font_enforcer.js header). Top-level
// require so both the .idjs entry and the bridge runner's transitive
// require scanner pull it in.
var ScriptFontEnforcer = require("./script_font_enforcer.js");

// fix-faux-latin-italic: shared SoT for the faux-italic decision. The doc-wide
// italic→skew sites below (BRIDGE-35 sweep, BRIDGE-41 restamp, link-uniform)
// gate on it so a Latin font WITH a real italic variant keeps real italic
// instead of being downgraded to upright + faux skew. Top-level require so the
// bridge runner's transitive require scanner bundles the leaf.
var FontItalicProbe = require("./font_italic_probe.js");
// Script-aware italic applier (CJK→faux skew, Latin-with-real-italic→real
// italic) shared by the BRIDGE-41 restamp + link-uniform sites below.
var ItalicApply = require("./italic_apply.js");
// univ-italic ④: CJK-text gate for the whole-paragraph uniform-italic migration
// (applyOnePara "Step 3.4b"). Uses the SAME splitter the per-run apply uses, so
// the gate's CJK definition can never drift from the split that follows.
var ScriptSplit = require("./script_split.js");
function _textHasCJK(t) {
    try {
        var runs = ScriptSplit.splitRunsByScript(String(t == null ? "" : t));
        for (var i = 0; i < runs.length; i++) { if (runs[i].isCJK) return true; }
    } catch (e) {}
    return false;
}
// Cross-repo「未手动标注 → 不沿用源格式」policy gate. Single SoT for the
// _auto decision across all annotation-apply sites (Step 3 applier, BRIDGE-39
// underline-preserve collection, BRIDGE-41 re-stamp) + the emphasis_runs gate.
var AutoFormatGate = require("./auto_format_gate.js");
// Soft-break group discriminator: which sub-segment groups the preclean fully
// split (format-differing lines → keep as separate paragraphs) vs re-join.
var SoftBreakPlan = require("./soft_break_plan.js");

// ─── _remapEmphasisRunsForFallback (E2E-18) ────────────────────────
// DORMANT after SPEC §14 refactor: the new combined-char-style emphasis
// helper (applyEmphasisRunsAsCharStyles) reads family from the LIVE DOM /
// source format_snapshot and weight from the UN-remapped diff, so the
// fallback family/weight rewrite is moot for it — all three emphasis call
// sites now pass un-remapped runs. Kept (not deleted) as the
// fallback-remap reference should the retained raw-override path
// (applyEmphasisRunsAsOverrides) ever need it again (SPEC §12.4).
//
// Walk an emphasis_runs array and rewrite each `diff` so neither the
// family nor the weight lets the post-import doc end up with an
// invalid SHS combination (e.g. "Source Han Sans CN | Semibold" — SHS
// has no Semibold variant, so InDesign substitutes the rendered glyph
// from a different style or family, producing inconsistent weights
// across paragraphs).
//
// Two cases:
//   (a) diff.fontFamily IS a CJK font (MHei PRC, STSong, …).
//       Remap to the fallback family (SHS) and replace the weight
//       with the closest SHS-installed variant. Original case for
//       this helper — preserves designer intent across font systems.
//
//   (b) diff.fontFamily is a Latin font (EJ Sans Text Semibold, Dax
//       Pro Bold, …) and the emphasis range happens to contain CJK
//       characters (common after EN→SC/EN→TC translation). InDesign
//       auto-substitutes the Latin family with SHS for those CJK
//       chars but keeps the requested weight literally, yielding the
//       "SHS|Semibold" rendering bug. Solution: remap the weight (not
//       the family) so the Latin chars in the range take a slightly
//       different weight (Semibold → Bold) and the CJK chars in the
//       range get a valid SHS variant. The Latin downgrade is the
//       cost of fallback mode; per-style designer-approved mapping
//       belongs to the upcoming font-compliance project.
//
// Pure (returns a new array); leaves the original diff untouched so
// re-runs of the same translation row don't compound rewrites.
var _FALLBACK_CJK_FAMILY = "Source Han Sans CN";

// SPEC §10.5/§12.6: shared faithfulness gate. `target_emphasis_runs_auto: true`
// has two producers (overlay heuristic = non-faithful, must stay stripped; vs
// codec clean-roundtrip stamped `target_emphasis_runs_faithful: true` = apply).
// Gate = auto && !faithful. Extracted module-level so Step3.4 AND runMinimalApply
// (M5) apply the SAME door to target-side runs (no-auto-propagation policy must
// hold symmetrically across both apply sites).
function _terIsAuto(translation) {
    // Local convenience wrapper around the cross-module SoT (auto_format_gate)
    // so Step 3.4 + M5 share ONE faithful-aware gate (auto && !faithful) and
    // can't drift. @integration: emphstyle extracted this helper independently
    // with identical semantics — reconciled to delegate to the canonical SoT.
    return AutoFormatGate.isAutoEmphasisRuns(translation);
}
function _remapEmphasisRunsForFallback(runs, workDoc, SS) {
    if (!runs || !runs.length) return runs;
    var I = SS && SS._internal;
    if (!I || typeof I._isCJKFont !== "function") return runs;
    function _nearestSHSWeight(rawStyle) {
        var desired = I._stripItalicForWeightOnly(rawStyle);
        if (!desired) desired = "Regular";
        var alreadyOk = false;
        try { alreadyOk = !!I._isFontInstalled(workDoc, _FALLBACK_CJK_FAMILY, desired); } catch (eIF) {}
        if (alreadyOk) return desired;
        if (!Array.isArray(I._CANDIDATE_WEIGHTS) || typeof I._rankWeight !== "function") return null;
        var target = I._rankWeight(desired);
        var bestStyle = null;
        var bestScore = Infinity;
        for (var ci = 0; ci < I._CANDIDATE_WEIGHTS.length; ci++) {
            var cand = I._CANDIDATE_WEIGHTS[ci];
            var present = false;
            try { present = !!I._isFontInstalled(workDoc, _FALLBACK_CJK_FAMILY, cand); } catch (eCI) {}
            if (!present) continue;
            var rank = I._rankWeight(cand);
            var dist = Math.abs(rank - target);
            var dirPen = (rank < target) ? 1 : 0;
            var score = dist * 10 + dirPen;
            if (score < bestScore) { bestScore = score; bestStyle = cand; }
        }
        return bestStyle;
    }
    var out = new Array(runs.length);
    for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        if (!r || !r.diff) { out[i] = r; continue; }
        var fam = r.diff.fontFamily;
        var famIsCJK = fam ? I._isCJKFont(String(fam)) : false;
        // Case (b) — Latin emphasis fontStyle remap is intentionally
        // disabled. Rewriting "EJ Sans Text | Semibold" to
        // "EJ Sans Text | Bold" deadlocks workDoc.save even with
        // #BRIDGE-7 holding NEVER_INTERACT (engine's save-time font
        // resolution path apparently doesn't honor that flag and
        // re-enters substitution synchronously on Latin variants
        // that aren't installed on this corpus, e.g. EJ Sans Text
        // Bold). The visible "SHS|Semibold" / "SHS|Italic" missing-
        // fonts dialog at doc load is the known cost of fallback
        // mode and is explicitly deferred to the font-compliance
        // track where the per-style approved mapping table replaces
        // this whole helper.
        if (!famIsCJK) { out[i] = r; continue; }
        var rawStyle = (typeof r.diff.fontStyle === "string") ? r.diff.fontStyle : "";
        var newDiff = {};
        for (var k in r.diff) {
            if (Object.prototype.hasOwnProperty.call(r.diff, k)) newDiff[k] = r.diff[k];
        }
        newDiff.fontFamily = _FALLBACK_CJK_FAMILY;
        if (rawStyle) {
            var mapped = _nearestSHSWeight(rawStyle);
            if (mapped) newDiff.fontStyle = mapped;
        }
        out[i] = { start: r.start, end: r.end, diff: newDiff };
    }
    return out;
}

// ─── _writeParaPreserveMark (shared helper) ────────────────────────
// Write `targetText` into `para` while preserving the trailing
// paragraph mark (\r). InDesign's `para.contents = ...` deletes ALL
// characters including the \r, which momentarily merges the paragraph
// with the next one — the new text + \r then re-splits, but the NEXT
// paragraph inherits the appliedParagraphStyle. The replacement-by-
// range form below replaces only the chars BEFORE the \r so the
// paragraph boundary never disappears.
//
// #E2E-17 safety net: even with the range form, certain configurations
// (short paragraph + downstream paragraph with different style) end
// up with the \r consumed anyway. The post-write check reads back
// the paragraph's last char and re-appends \r when missing, unless
// this is the last paragraph in its story (where adding \r would
// create a phantom empty paragraph).
//
// Returns { ok, hadTrailingCR, postLen } so callers can report stats.
// #BRIDGE-34: UXP Paragraph wrappers behave like persistent CHARACTER RANGES,
// not stable paragraph identifiers. When a sibling paragraph's contents are
// reassigned to a string of different length (via
// `chars.itemByRange(...).contents = X`), the surrounding paragraph wrappers
// shift their END forward to keep up — even WHEN the inserted chars belong
// to a different paragraph. Concretely:
//
//   Before any writes: p38 wrapper = chars [X0..X0+70], end at p38's \r.
//   tid 4797 writes p39 (source "S&P 500 " → "标准普尔 500 指数", +3 chars).
//   p38 wrapper end shifts to X0+73 → wrapper now spans p38 + \r + "标准普"
//   (first 3 chars of p39's new content).
//
// When _writeParaPreserveMark next runs on the p38 wrapper, charCount=74
// and raw.charCodeAt(73)="普" (≠ 13). The `hasTrailingCR` check fails →
// dangerous `else { para.contents = write }` branch fires → wrapper's whole
// 74-char range is replaced + p38's \r is eaten + p38 merges with p39.
//
// Fix: before any reads, re-resolve the wrapper to the paragraph that
// currently contains the wrapper's FIRST character. This drops the leaked
// trailing chars and gives a clean paragraph wrapper bounded at \r.
//
// O(1) implementation: read first-char's parent paragraph directly via
// InDesign's text-object navigation, which is constant-time. Earlier
// approach walked story.paragraphs (O(P) × N writes ≈ O(P²)) and hung
// large docs.
function _refreshParaWrapper(para) {
    try {
        if (!para || !para.characters || para.characters.length === 0) return para;
        var first = para.characters.item(0);
        // Character → its enclosing Paragraph. UXP exposes this as
        // `firstChar.paragraphs[0]` (or paragraphs.item(0)) — when called
        // on a Character object, it returns the Paragraph the char belongs
        // to. This is the cheapest reliable way to re-resolve a possibly-
        // leaked Paragraph wrapper back to a properly-bounded paragraph.
        var paraColl = first.paragraphs;
        var n = 0; try { n = paraColl.length; } catch (eN) {}
        if (n > 0) {
            var fresh = paraColl.item(0);
            if (fresh && fresh.isValid) return fresh;
        }
    } catch (e) {}
    return para;
}

function _writeParaPreserveMark(para, targetText) {
    para = _refreshParaWrapper(para);
    var write = String(targetText);
    while (write.length > 0 && write.charAt(write.length - 1) === "\r") {
        write = write.substring(0, write.length - 1);
    }
    var charCount = para.characters.length;
    // #BRIDGE-30b: detect trailing \r via para.contents (raw string), NOT
    // via String(Character.contents). UXP wraps the paragraph-end character
    // and returns a SpecialCharacters enum label (e.g. "COLUMN_BREAK")
    // even though the underlying raw character is \r — so the previous
    // check `String(char.contents) === "\r"` reported false for normal
    // paragraphs ending in column-break-labeled \r, falling into the
    // dangerous `else { para.contents = write }` branch that eats the
    // paragraph mark and merges the next paragraph in.
    //
    // Symptom in Client-A Product-1 Brochure import: story 17081 lost 17
    // paragraph marks → 9 merged CN+EN paragraphs + 41 "Object is invalid"
    // cascade as subsequent Paragraph DOM wrappers stale out.
    //
    // raw contents includes the paragraph mark when the paragraph is not
    // the last in its story; check the literal char code 13.
    var hasTrailingCR = false;
    try {
        var __raw = String(para.contents || "");
        if (__raw.length > 0 && __raw.charCodeAt(__raw.length - 1) === 13) {
            hasTrailingCR = true;
        }
    } catch (eRaw) {
        hasTrailingCR = (charCount > 0);  // best-effort fallback
    }

    if (hasTrailingCR && charCount >= 1) {
        if (charCount === 1) {
            // Empty para (just \r) — insert before the mark.
            para.insertionPoints.item(0).contents = write;
        } else {
            para.characters.itemByRange(0, charCount - 2).contents = write;
        }
    } else {
        // No trailing CR (last paragraph in story) — whole assignment is safe.
        para.contents = write;
    }

    // #E2E-17 safety net.
    if (hasTrailingCR) {
        try {
            var postLen = para.characters.length;
            var isLastInStory = false;
            try {
                var story = para.parentStory;
                var sParas = story.paragraphs;
                var lastP = sParas.item(sParas.length - 1);
                isLastInStory = (lastP && lastP.id === para.id);
            } catch (eLast) {}
            if (postLen === 0) {
                if (!isLastInStory) {
                    try { para.contents = write + "\r"; } catch (eRe1) {}
                }
            } else {
                // #BRIDGE-30b: same UXP quirk as the pre-write check —
                // read raw para.contents string instead of Character.contents,
                // which returns SpecialCharacters labels for paragraph-end
                // chars and would mis-detect missing \r.
                var postLastCh = "";
                try {
                    var __postRaw = String(para.contents || "");
                    if (__postRaw.length > 0) postLastCh = (__postRaw.charCodeAt(__postRaw.length - 1) === 13) ? "\r" : "X";
                } catch (ePLC) {}
                if (postLastCh !== "\r" && !isLastInStory) {
                    try { para.insertionPoints.item(postLen).contents = "\r"; }
                    catch (eIns) {
                        try { para.contents = write + "\r"; } catch (eRe2) {}
                    }
                }
            }
        } catch (eGuard) {}
    }

    return { ok: true, hadTrailingCR: hasTrailingCR };
}

// #TABLE-MINION (Phase 3): decide whether post-`.contents=` clearParaCharOverrides
// runs. Clear (legacy) when the paragraph has a _T_p_* cluster (CJK default +
// Latin GREP re-route the cleared runs), OR the source paragraph was NON-uniform
// (the `.contents=` by-position char-replace (gate #6) splits the new text across
// the source runs' fonts at column boundaries meaningless for the translation —
// without a clear and without GREP it wears arbitrary source-Latin fonts at
// arbitrary offsets), OR the style name is unreadable (conservative). Skip ONLY
// for a uniform NON-cluster paragraph (e.g. an edit-mode table cell that stayed
// [Basic Paragraph]) — there the single source font is the intended Latin base
// and byPair still re-routes CJK→MHei on top, so the cleared-to-Minion bug is
// avoided. Pure + Node-testable. Host-verified 20260622_01.
function _shouldClearParaOverrides(paraStyleName, srcUniform) {
    if (paraStyleName === null || paraStyleName === undefined) return true;   // unreadable → clear
    if (String(paraStyleName).indexOf("_T_p_") === 0) return true;           // cluster → clear
    return srcUniform !== true;                                               // non-cluster: clear unless uniform
}

// #HANG-LOG (20260908) — per-item tracing is OPT-IN, and here is the arithmetic.
//
// The hang instrumentation writes ~5 lines per worklist item, and plog does one
// writeFileSync per line into <docDir>/script_outputs/log/ — which sits next to the
// document, i.e. routinely on a network share. Measured on the run that closed the
// font bug: the log went 100 -> 2164 lines and the settle pass went ~6ms to ~35ms
// per item, 14.0s of a 69.7s import. That was worth paying WHILE diagnosing and is
// not worth paying every day.
//
// So the split is by FREQUENCY, not by usefulness: everything that fires once per
// item is gated here; everything RARE stays always-on (a widen, a font-catalog
// scan, a frame that actually reads overset, any single item over a second). The
// always-on set still names the face and the frame — it just cannot name the item
// index. Set IMPORT_TRACE_SETTLE=1 to get that back before re-running a hang.
function _traceSettle() {
    try { return !!(typeof process !== "undefined" && process.env && process.env.IMPORT_TRACE_SETTLE); }
    catch (e) { return false; }
}

// ─── overset-widen-before-emphasis (SPEC #ac-overset-widen, part A) ─────────
//
// Root cause (host-verified 20260714): appliedCharacterStyle= SILENTLY fails on
// chars pushed into a frame's OVERSET (out-of-frame) region — the emphasis
// (bold/superscript) lands only on the in-frame prefix, the tail stays baseline,
// and the report shows failed:0 (silent, no throw). Fix: BEFORE applying emphasis,
// if the paragraph's frame overflows, PERMANENTLY widen it HORIZONTALLY (direction
// by paragraph justification) until it no longer overflows, so every char is
// in-frame when the style is assigned. Never restored (user-decided: the text
// visibly pokes out of the original design box so the designer sees it and adjusts).
// Only touches frames that ACTUALLY overflow (AC4: non-overset frames untouched).
// Horizontal only (SCOPE); a vertical overflow that can't clear is capped and
// reported (stillOverflows), and the emphasis read-back (part B) surfaces any drop.
//
// Idempotent + bounded: a frame already recorded in applyResults.framesWidened is
// skipped (re-reading its now-larger bounds and re-growing would compound across
// the frame's paragraphs). Host-only — under Node mocks para.parentTextFrames is
// absent so _firstTextFrame returns null and this is a no-op.

// Unwrap a parentTextFrames / textContainers collection (possibly double-wrapped
// [[TextFrame]], CLAUDE.md gate #3) down to the first real TextFrame (has a boolean
// .overflows). Returns null for empty / non-host (Node mock) inputs.
function _firstTextFrame(coll) {
    var node = coll;
    for (var depth = 0; depth < 3 && node; depth++) {
        var isFrame = false;
        try { isFrame = (typeof node.overflows === "boolean"); } catch (eF) {}
        if (isFrame) return node;
        var next = null;
        try {
            if (typeof node.item === "function") {
                if (typeof node.length === "number" && node.length === 0) return null;
                next = node.item(0);
            } else if (typeof node.length === "number") {
                if (node.length === 0) return null;
                next = node[0];
            }
        } catch (eN) { return null; }
        if (next == null || next === node) return null;
        node = next;
    }
    try { if (typeof node.overflows === "boolean") return node; } catch (eL) {}
    return null;
}

// Direction to grow an overset frame, by paragraph justification (AC5):
//   LEFT_ALIGN / JUSTIFY / default → "RIGHT" (grow right edge)
//   RIGHT_ALIGN                    → "LEFT"  (grow left edge)
//   CENTER                         → "BOTH"  (grow symmetrically)
// Enum stringify casing varies across UXP builds (CLAUDE.md gate #3) → substring
// match on the upper-cased name is casing-robust.
function _widenDirectionFromJustification(para) {
    var j = "";
    try { j = String(para.justification || ""); } catch (eJ) {}
    if (j.indexOf(".") >= 0) j = j.split(".").pop();   // strip "Justification." prefix
    var up = j.toUpperCase();
    if (up.indexOf("CENTER") >= 0) return "BOTH";
    // AWAY_FROM_SPINE / TO_BINDING are binding-relative right-alignment — same
    // treatment as frame_repair.js determineWidthExpandMode (grow the left edge).
    if (up.indexOf("RIGHT") >= 0 || up.indexOf("AWAY_FROM_SPINE") >= 0 || up.indexOf("TO_BINDING") >= 0) return "LEFT";
    return "RIGHT";
}

// @returns {Object|null} null if nothing done (no frame / not overset / already
//   widened), else { frameId, direction, origWidth, newWidth, stillOverflows, tid }.
function _widenOversetFrameForEmphasis(para, workDoc, deps, applyResults, tid) {
    if (!para) return null;

    var frame = null;
    try { frame = _firstTextFrame(para.parentTextFrames); } catch (e1) {}
    if (!frame) {
        // fallback: story's first container (single-frame headline case, per SPEC).
        try { frame = _firstTextFrame(para.parentStory.textContainers); } catch (e2) {}
    }
    if (!frame) return null;

    var frameId = null; try { frameId = frame.id; } catch (eId) {}
    // dedup: once we've widened a frame, never re-process it — its bounds are now
    // larger and re-growing from them would compound unboundedly across paragraphs.
    if (applyResults && applyResults.framesWidened && frameId != null) {
        for (var q = 0; q < applyResults.framesWidened.length; q++) {
            if (applyResults.framesWidened[q].frameId === frameId) return null;
        }
    }

    var overs;
    try { overs = frame.overflows; } catch (eOv) { return null; }   // Node mock / not a frame
    if (overs !== true) return null;   // AC4 / RED-LINE: never touch a non-overset frame

    // Force POINTS for geometricBounds reads/writes (server CLAUDE.md: the default
    // may be PICAS). Restored in finally. app via guarded require (host-only).
    var idsn = null; try { idsn = require("indesign"); } catch (eI) {}
    var app = idsn && idsn.app;
    var MU = (deps && deps.MeasurementUnits) || (idsn && idsn.MeasurementUnits);
    var prevMU = null;
    var muWasSet = false;
    if (app && MU && MU.POINTS !== undefined) {
        try { prevMU = app.scriptPreferences.measurementUnit; } catch (ePm) {}
        try { app.scriptPreferences.measurementUnit = MU.POINTS; muWasSet = true; } catch (ePs) {}
    }

    var result = null;
    try {
        var gb0 = frame.geometricBounds;                 // [y1, x1, y2, x2] in POINTS
        var y1 = gb0[0], x1 = gb0[1], y2 = gb0[2], x2 = gb0[3];
        var origWidth = x2 - x1;
        if (!(origWidth > 0)) return null;

        var direction = _widenDirectionFromJustification(para);

        // #HANG-LOG (20260908). The per-frame line at the bottom of this function
        // reports a COMPLETION, and a hang has no completion: the 20260908 stall
        // burned a core for 10+ minutes and produced ZERO `widen:` lines, because
        // the FIRST call never returned. Completion lines answer "which call was
        // slow"; only an ENTER line answers "which call is stuck". So every probe
        // is bracketed, and each host call inside it is timed separately — the
        // last line in the log then names the operation still running, and says
        // whether the cost is the geometry set, the story recompose, the frame
        // recompose, or the overflows read. (Same lesson as #REALTIME-LOG, one
        // layer down: that one was about a channel that never arrived, this one
        // about a line that only prints when the work is already over.)
        var __wlog = (deps && typeof deps.plog === "function") ? deps.plog : null;
        var __wnow = function () { return (typeof Date !== "undefined" && Date.now) ? Date.now() : 0; };
        var __wt0 = __wnow();
        var __wprobe = 0;
        if (__wlog) {
            try {
                __wlog("widen enter: frame=" + frameId + " dir=" + direction
                    + " w=" + Math.round(origWidth) + "pt");
            } catch (eWE) {}
        }

        // Grow the frame the MINIMUM horizontal distance that clears the overflow
        // (user-required 20260714: expand as little as possible — do NOT balloon; the
        // widened text should just barely fit, poking minimally past the design box).
        // Helper: set origWidth+`a` in the chosen direction, force a full reflow (reading
        // `overflows` alone does not reliably reflect the new glyph layout), and return
        // the live overflow — or null if the geometry set itself threw (locked frame).
        var _setAdded = function (a) {
            var nb;
            if (direction === "LEFT") nb = [y1, x1 - a, y2, x2];          // right-aligned → grow left edge
            else if (direction === "BOTH") nb = [y1, x1 - a / 2, y2, x2 + a / 2]; // centered → symmetric
            else nb = [y1, x1, y2, x2 + a];                              // left / justify / default → grow right
            var __pn = ++__wprobe, __p0 = __wnow();
            if (__wlog) { try { __wlog("widen probe " + __pn + ": added=" + Math.round(a) + " — set bounds"); } catch (eL0) {} }
            try { frame.geometricBounds = nb; } catch (eGB) { return null; }
            if (__wlog) { try { __wlog("widen probe " + __pn + ": bounds set +" + (__wnow() - __p0) + "ms — story.recompose"); } catch (eL1) {} }
            try { var _st = frame.parentStory; if (_st && typeof _st.recompose === "function") _st.recompose(); } catch (e) {}
            if (__wlog) { try { __wlog("widen probe " + __pn + ": story.recompose +" + (__wnow() - __p0) + "ms — frame.recompose"); } catch (eL2) {} }
            try { if (typeof frame.recompose === "function") frame.recompose(); } catch (e) {}
            if (__wlog) { try { __wlog("widen probe " + __pn + ": frame.recompose +" + (__wnow() - __p0) + "ms — read overflows"); } catch (eL3) {} }
            var __ov = false;
            try { __ov = (frame.overflows === true); } catch (e) { __ov = false; }
            if (__wlog) { try { __wlog("widen probe " + __pn + ": DONE overflows=" + __ov + " +" + (__wnow() - __p0) + "ms"); } catch (eL4) {} }
            return __ov;
        };

        var MAX_ADD = Math.max(origWidth * 3, 3000);     // horizontal ceiling (a vertical-only overflow can't clear)
        // Phase 1 — geometric growth to BRACKET the minimal clearing width. Small initial
        // step + growth so we find a clearing upper bound fast WITHOUT a big overshoot.
        var lo = 0;                                      // largest added-width still OVERFLOWING
        var hi = -1;                                     // smallest added-width that CLEARS (−1 = none yet)
        var step = Math.max(origWidth * 0.1, 36);
        var added = step, it = 0, MAX_IT = 40, gset;
        while (it < MAX_IT && added <= MAX_ADD) {
            gset = _setAdded(added);
            if (gset === null) break;                    // set threw → give up, revert below
            if (gset) { lo = added; added += step; step *= 1.5; }
            else { hi = added; break; }
            it++;
        }
        // Phase 2 — binary-search (lo, hi] down to the minimal clearing width (~2pt).
        var it2 = 0;                                     // hoisted: the log below reads it
        if (hi >= 0) {
            it2 = 0;
            while (hi - lo > 2 && it2 < 40) {
                var mid = (lo + hi) / 2;
                var bset = _setAdded(mid);
                if (bset === null) break;
                if (bset) lo = mid; else hi = mid;
                it2++;
            }
            _setAdded(hi);                               // land on the minimal clearing width
        }

        var stillOverflows = true;
        try { stillOverflows = (frame.overflows === true); } catch (eO3) {}

        // One line per widened frame, carrying the two numbers that say WHY it was
        // slow. Every iteration of either phase costs a story recompose, so
        // `phase1=40 cleared=false` is the expensive-and-useless case: the overflow
        // was vertical, the horizontal ceiling could never clear it, and the whole
        // budget was spent before reverting. From outside, that case was previously
        // indistinguishable from a hang - the pass logged one line, at the end.
        if (__wlog) {
            var __wms = ((typeof Date !== "undefined" && Date.now) ? Date.now() : 0) - __wt0;
            try {
                __wlog("widen: frame=" + frameId + " dir=" + direction
                    + " phase1=" + it + "/" + MAX_IT
                    + " phase2=" + it2
                    + " cleared=" + (!stillOverflows)
                    + (stillOverflows ? " (reverted - not horizontally fixable)" : "")
                    + " +" + __wms + "ms");
            } catch (eWL) {}
        }
        if (stillOverflows) {
            // Never cleared within the horizontal ceiling → vertical / not horizontally
            // fixable (out of SCOPE). REVERT to the original box: the width bought nothing,
            // and leaving it would let a sibling paragraph compound-grow. Record nothing —
            // the emphasis read-back (part B) is the SPEC's path for any residual drop.
            try { frame.geometricBounds = [y1, x1, y2, x2]; } catch (eRv) {}
        } else {
            var newWidth = origWidth;
            try { var gb1 = frame.geometricBounds; newWidth = gb1[3] - gb1[1]; } catch (eGB1) {}

            // Record only a frame whose width ACTUALLY grew — a locked frame / locked
            // layer makes geometricBounds= throw on the first set (newWidth == origWidth),
            // which must NOT be reported as a widen (AC2/AC4 honesty).
            if (newWidth > origWidth + 0.01) {
                result = {
                    tid: tid, frameId: frameId, direction: direction,
                    origWidth: origWidth, newWidth: newWidth, stillOverflows: false
                };
            }
        }
    } catch (eW) {
        result = null;
    } finally {
        // Restore only if we actually flipped the unit; if the prior value was
        // unreadable (prevMU null) there is nothing known to restore to.
        if (muWasSet && app && prevMU !== null) {
            try { app.scriptPreferences.measurementUnit = prevMU; } catch (ePr) {}
        }
    }

    if (result && applyResults) {
        if (!applyResults.framesWidened) applyResults.framesWidened = [];
        applyResults.framesWidened.push(result);
    }
    return result;
}

// ─── applyOnePara ──────────────────────────────────────────────────

// #BRIDGE-41 restamp — EXTRACTED so it can run TWICE (#ac-overset-widen, 20260715).
// It exists to have the LAST WORD over annotation format props (see its docstring at
// the original call site): the emphasis apply calls spanRange.clearOverrides()
// (style_applier.js:1704) before assigning the CS, and the compensating replay
// (_replaySubRangeOverrides) restores only underline/strikeThrough DETAIL — the
// `underline` / `strikeThrough` BOOLEANS are never captured by _readCharOverrides
// (:2453-2464 capture ulColor/ulTint/ulWeight/ulOffset/ulGap*, not `underline`).
// So a translator underline annotation overlapping an emphasis run is wiped by the
// CS apply and only this restamp puts it back. Deferring emphasis to pass 2 moved it
// AFTER this pass and silently dropped those underlines (impl-audit 20260715,
// A-class) — so pass 2 re-runs this at its end. Idempotent: it re-stamps the same
// annotation-derived values onto the same ranges.
function _restampAnnotationFormats(workDoc, locatePlan, translations, applyResults, deps) {
    try {
        var __b41Restamp = 0;
        var __b41Idsn = null;
        try { __b41Idsn = require("indesign"); } catch (eIdsn) {}
        var __b41ColorSpace = (__b41Idsn && __b41Idsn.ColorSpace) || (deps && deps.ColorSpace);
        var __b41Position = (__b41Idsn && __b41Idsn.Position) || (deps && deps.Position);

        for (var __b41i = 0; __b41i < locatePlan.length; __b41i++) {
            var __b41lr = locatePlan[__b41i];
            if (!__b41lr || !__b41lr.para || !__b41lr.seg) continue;
            var __b41Tr = translations.byTid[__b41lr.seg.tid];
            if (!__b41Tr || !__b41Tr.annotations || !__b41Tr.annotations.length) continue;
            if (__b41Tr.target_text === undefined || __b41Tr.target_text === null || String(__b41Tr.target_text).length === 0) continue;

            var __b41Para = __b41lr.para;
            try { __b41Para = _refreshParaWrapper(__b41Para); } catch (eRP41) {}
            var __b41Chars = 0;
            try { __b41Chars = __b41Para.characters.length; } catch (eCC) {}
            if (!__b41Chars) continue;
            var __b41Raw = "";
            try { __b41Raw = String(__b41Para.contents || ""); } catch (eRw) {}
            // exclude trailing \r from end bound
            var __b41Last = (__b41Raw.length > 0 && __b41Raw.charCodeAt(__b41Raw.length - 1) === 13)
                ? __b41Chars - 2 : __b41Chars - 1;
            if (__b41Last < 0) continue;

            for (var __b41ai = 0; __b41ai < __b41Tr.annotations.length; __b41ai++) {
                var __b41a = __b41Tr.annotations[__b41ai];
                // Cross-repo policy: never re-stamp AI/heuristic (_auto)
                // annotations. This is the SECOND annotation-apply path (after
                // Step 3); without this gate the re-stamp would re-apply an
                // _auto color/underline the Step 3 applier already dropped.
                // See lib/auto_format_gate.js + CLAUDE.md「跨仓政策」.
                if (AutoFormatGate.isAutoAnnotation(__b41a)) continue;
                if (!__b41a || __b41a.type !== "format") continue;
                // TODO#15 B2 / SPEC §10.5: cross-repo no-auto-propagation. The
                // main applyAnnotations pass skips `_auto:true` annotations
                // (style_applier.js:482 → reason "auto_skipped"); this FINAL
                // re-stamp MUST mirror that gate, or it re-applies the very
                // annotations the policy stripped. Host bug 20260624: a title's
                // `_auto:true` `action:"bold"` annotation (auto-echo of the
                // source bold) was re-stamped here as a literal `fontStyle="Bold"`
                // DIRECT override AFTER the emphasis char-style refactor applied
                // the precise `_T_c_emp_w_*` face (e.g. MHei Xbold / Whitney
                // Semibold) — direct override > char style, so the prefix
                // rendered the generic Bold baseline instead of the emphasis
                // weight ("中文还是未加粗"). Skipping `_auto` here lets the
                // emphasis CS own the weight unclobbered. Faithful/manual
                // annotations (`_auto` absent/false) still re-stamp as before.
                if (__b41a._auto === true) continue;
                if (typeof __b41a.offset !== "number" || typeof __b41a.length !== "number") continue;
                if (__b41a.length <= 0 || __b41a.offset < 0) continue;
                var __b41End = Math.min(__b41a.offset + __b41a.length - 1, __b41Last);
                if (__b41End < __b41a.offset) continue;
                var __b41Rng = null;
                try { __b41Rng = __b41Para.characters.itemByRange(__b41a.offset, __b41End); } catch (eRng) { continue; }
                if (!__b41Rng) continue;

                if (__b41a.action === "color") {
                    var __b41Val = __b41a.value || __b41a.color;
                    if (!__b41Val || !__b41ColorSpace) continue;
                    var __b41Hex = String(__b41Val).replace(/^#/, "");
                    if (__b41Hex.length !== 6) continue;
                    var __b41SwName = "_T_c_color_" + __b41Hex;
                    var __b41Sw = null;
                    try { __b41Sw = workDoc.colors.itemByName(__b41SwName); } catch (eSwN) {}
                    if (!__b41Sw || !__b41Sw.isValid) {
                        try { __b41Sw = workDoc.swatches.itemByName(__b41SwName); } catch (eSwN2) {}
                    }
                    if (!__b41Sw || !__b41Sw.isValid) {
                        try {
                            workDoc.colors.add({
                                name: __b41SwName,
                                space: __b41ColorSpace.RGB,
                                colorValue: [
                                    parseInt(__b41Hex.substring(0, 2), 16),
                                    parseInt(__b41Hex.substring(2, 4), 16),
                                    parseInt(__b41Hex.substring(4, 6), 16)
                                ]
                            });
                            try { __b41Sw = workDoc.colors.itemByName(__b41SwName); } catch (eSwN3) {}
                        } catch (eAdd) {}
                    }
                    if (__b41Sw && __b41Sw.isValid) {
                        try { __b41Rng.fillColor = __b41Sw; __b41Restamp++; } catch (eApplyC) {}
                    }
                } else if (__b41a.action === "underline") {
                    // Char-level underline only. Translator-driven
                    // upgrade to paragraph-level ruleBelow lives in the
                    // standalone post-processing script
                    // `convert_underline_to_rule.idjs` — operator runs it
                    // on demand against the saved .translated.indd.
                    try { __b41Rng.underline = true; __b41Restamp++; } catch (eAppU) {}
                } else if (__b41a.action === "italic") {
                    // univ-italic ② (乙 STRICT): config-gated script-aware italic.
                    // Per (family,weight) subgroup → faux@config-angle / real /
                    // block / surface; unconfigured never auto-slants (was a blanket
                    // CJK skew=15 / Latin auto real). Surfaced non-silently.
                    try {
                        var __b41It = ItalicApply.applyScriptAwareItalic({
                            charContainer: __b41Para.characters,
                            baseOffset: __b41a.offset,
                            endOffset: __b41End,
                            workDoc: workDoc,
                            italicConfig: (deps && deps.italicConfig) || null
                        });
                        if (__b41It.ok) __b41Restamp++;
                        if (__b41It.surfaced && __b41It.surfaced.length) {
                            applyResults.annotationItalicSurfaced =
                                (applyResults.annotationItalicSurfaced || 0) + __b41It.surfaced.length;
                        }
                    } catch (eAppI) {}
                } else if (__b41a.action === "bold") {
                    try { __b41Rng.fontStyle = "Bold"; __b41Restamp++; } catch (eAppB) {}
                } else if (__b41a.action === "superscript" && __b41Position && __b41Position.SUPERSCRIPT) {
                    try { __b41Rng.position = __b41Position.SUPERSCRIPT; __b41Restamp++; } catch (eAppSp) {}
                }
            }
        }
        applyResults.annotationFinalRestamped = __b41Restamp;
    } catch (eB41) {
        applyResults.clusterApplyFailures.push({
            tid: "<global-bridge-41>",
            reason: "annotation_final_restamp_failed: " + (eB41 && eB41.message ? eB41.message : eB41)
        });
    }
}

// ─── two-pass settle-then-emphasis (SPEC #ac-overset-widen) ────────
//
// WHY applyOnePara runs TWICE. Root cause (host-verified 20260714): with
// splitSoftBreaks (production), merging soft-break paragraphs (deleting the \r)
// leaves the layout UN-SETTLED. On un-settled layout (a) frame.overflows reads
// WRONG (a widen sized off it overshoots — measured 1648.2pt vs 1098.7pt for the
// same paragraph in the same 784.1pt frame), and (b) an emphasis char style
// applied to the overset tail is DISCARDED when the layout really settles.
// story/frame/doc recompose does NOT settle it — only a save-level flush does.
//
// A save cannot be issued from in here: runPipeline runs inside a SYNCHRONOUS
// app.doScript(..., ENTIRE_SCRIPT) (import_integrated.idjs:1950) and doc.save()
// is async — the V8 event loop is fully stopped inside that block (CLAUDE.md
// gate #9), so the promise could never resolve. The settle therefore has to be
// the entry's EXISTING post-doScript `await workDoc.save()` (:3062), which
// already carries the #BRIDGE-17 missing-font sweep in front of it (a save
// without that sweep hits the one modal NEVER_INTERACT can't suppress —
// gate #8). Hence: pass 1 (in doScript) writes text/styles, the entry's save
// settles, pass 2 (a second doScript) applies emphasis on the settled layout.
//
//   pass 1  deps.deferEmphasis = true   → everything EXCEPT the emphasis sites
//   settle  entry: BRIDGE-17 sweep → await workDoc.save()
//   pass 2  deps.emphasisOnly   = true   → ONLY the emphasis sites (+ Step 4)
//
// The sites keep their original positions and relative order — the two flags
// just gate which half runs — so no ordering contract is disturbed:
//   • Step 3.6's enforcer skips `_T_*` (pipeline-owned) chars outright
//     (script_font_enforcer.js:222), so emphasis landing after it is immaterial.
//   • Site 1 (untranslated restyle) implies !hasTarget ⇒ annotations never run
//     on that paragraph, so it moving after Step 3 cannot collide. Its #27
//     direct-override replay is re-run in pass 2 from deps.carryDirectOverrideRanges
//     (pass 1's styleResult is gone by then).
//   • Sites 2/3/4 already ran after annotations; they still do.
// Both flags unset = the original single-pass behavior (Node tests / any
// non-settle caller), so this is opt-in and the old path stays exercised.
function applyOnePara(workDoc, locateResult, sheet, plan, translation, applyResults, deps) {
    var emphasisOnly  = !!(deps && deps.emphasisOnly);    // pass 2: emphasis sites only
    var deferEmphasis = !!(deps && deps.deferEmphasis);   // pass 1: skip emphasis sites
    // Pass-2 eligibility handshake. applyOnePara has EARLY RETURNS (no paragraph,
    // empty target, and — critically — write_target_failed at :745) past which the
    // single-pass code never reached the emphasis sites at all. Those returns are
    // normal returns, not throws, so the caller cannot see them; without this flag it
    // would enqueue the paragraph anyway and pass 2 — which skips the text write and so
    // never hits that failure — would apply TARGET-offset emphasis runs to a paragraph
    // still holding SOURCE text, i.e. bold on the wrong characters, silently. Set false
    // on entry, true only if we reach the bottom; the caller enqueues only on true.
    if (deferEmphasis) {
        applyResults.__deferParaCompleted = false;
        applyResults.__deferCarryRanges = null;
    }
    if (!locateResult || !locateResult.para) {
        if (!emphasisOnly) applyResults.skippedNoPara++;  // pass 1 already counted it
        return;
    }
    var seg = locateResult.seg;
    var para = locateResult.para;
    var tid = seg && seg.tid;

    var SS = deps.lib.styleSheetBuilder;
    var SA = deps.lib.styleApplier;

    // Translation-paired check: only paragraphs with a non-empty target_text
    // get their cluster style applied + content rewritten. Untranslated
    // paragraphs stay in their original style → preserves source visual
    // exactly for any text we don't touch.
    //
    // Earlier behavior was "apply cluster style to every located paragraph
    // for global typographic consistency" — but that re-flowed many
    // English paragraphs that were never translated, creating ~10 spurious
    // overset_text frames per run. This change makes the pipeline strictly
    // additive: existing layout untouched unless we have something new
    // to put there.
    //
    // EXCEPTION 1: deps.reorganizeOnly = true overrides this gate. In that
    // mode, EVERY located paragraph gets its cluster style applied (no
    // text changes), turning the pipeline into a pure style-reorganization
    // tool — useful for consolidating messy InDesign docs where a
    // designer hand-tweaked many paragraphs into ad-hoc overrides.
    //
    // EXCEPTION 2: deps.applyStyleToUntranslated = true folds the
    // reorganize behavior INTO the import: paragraphs without target_text
    // still receive their cluster style + source-side emphasisRuns
    // (offsets still align — text is unchanged). The translated subset
    // continues to follow the normal write-text + annotations path.
    // End result: the entire doc shares the consolidated _T_p_* style pool
    // even though only some paragraphs were actually translated.
    var target = (translation && translation.target_text !== undefined) ? translation.target_text : null;
    var hasTarget = (target !== null && target !== undefined && String(target).length > 0);
    var reorganizeOnly = !!(deps && deps.reorganizeOnly);
    var applyStyleToUntranslated = !!(deps && deps.applyStyleToUntranslated);
    var restyleUntranslated = !hasTarget && applyStyleToUntranslated && !reorganizeOnly;

    if (!hasTarget && !reorganizeOnly && !applyStyleToUntranslated) {
        if (!emphasisOnly) applyResults.skippedEmptyTarget++;   // pass 1 already counted it
        return;
    }

    // Step 1: assign cluster paragraph style.
    // normalizeCascade=true is required when text is NOT being rewritten
    // (reorganizeOnly OR restyleUntranslated): leftover character styles
    // and direct overrides on source chars otherwise contradict the new
    // paragraph style. The translation flow achieves the same effect via
    // clearParaCharOverrides AFTER content rewrite (Step 2b below).
    //
    // EDIT-MODE Step 1 BYPASS: when deps.editTextOnly is true (the row
    // landed in import_diff_classify's textOnly bucket — text changed,
    // paragraph format stable, live PS still matches prior applied style),
    // skip cluster style assignment entirely. This is the core promise of
    // edit mode: unchanged-format rows keep their already-applied PS
    // (including any operator hand-tweaks to that PS made post-import).
    var editTextOnly = !!(deps && deps.editTextOnly);
    var styleResult = { applied: false, reason: emphasisOnly ? "emphasis_only_pass" : "edit_text_only_skip" };
    if (emphasisOnly) {
        // pass 2 applies emphasis onto the SETTLED layout only — the cluster style
        // (and the text write / override clear below) already landed in pass 1 and
        // must not be redone: re-running them would re-wipe the char overrides
        // pass 1 restored and re-dirty the layout we just settled.
    } else if (!editTextOnly) {
        var needsCascadeNormalize = reorganizeOnly || restyleUntranslated;
        styleResult = SA.applyClusterStyleToParagraph(
            para, sheet, locateResult, plan,
            { fingerprintParagraph: SS.fingerprintParagraph },
            { normalizeCascade: needsCascadeNormalize }
        );
    } else {
        applyResults.editTextOnlySkippedStyle = (applyResults.editTextOnlySkippedStyle || 0) + 1;
    }
    if (!styleResult.applied && !editTextOnly && !emphasisOnly) {
        applyResults.clusterApplyFailures.push({
            tid: tid,
            reason: styleResult.reason,
            fingerprint: styleResult.fingerprint
        });
    } else if (styleResult.applied) {
        applyResults.clusterStylesApplied++;
        if (restyleUntranslated) {
            applyResults.untranslatedRestyled = (applyResults.untranslatedRestyled || 0) + 1;
        }
        // Diagnostic: track which tids got the cluster style — helps debug
        // when more paragraphs end up with _T_p_* than we explicitly applied.
        if (!applyResults.appliedClusterTids) applyResults.appliedClusterTids = [];
        applyResults.appliedClusterTids.push({ tid: tid, styleName: styleResult.paraStyleName });

        // Designer character-style preservation diagnostics. The applier
        // captures non-pipeline char-style ranges before normalize-wipe
        // and restores them after. Surface counts so report consumers can
        // spot when designer formatting was about to be clobbered, and
        // surface failures (data loss).
        if (typeof styleResult.designerCharStylesPreserved === "number" && styleResult.designerCharStylesPreserved > 0) {
            applyResults.designerCharStylesPreserved = (applyResults.designerCharStylesPreserved || 0) + styleResult.designerCharStylesPreserved;
            applyResults.designerCharStylesRestored = (applyResults.designerCharStylesRestored || 0) + (styleResult.designerCharStylesRestored || 0);
            if (styleResult.designerCharStylesFailed && styleResult.designerCharStylesFailed.length) {
                if (!applyResults.designerCharStylesLost) applyResults.designerCharStylesLost = [];
                for (var __di = 0; __di < styleResult.designerCharStylesFailed.length; __di++) {
                    var __df = styleResult.designerCharStylesFailed[__di];
                    applyResults.designerCharStylesLost.push({
                        tid: tid,
                        charStart: __df.start,
                        charEnd: __df.end,
                        styleName: __df.styleName,
                        reason: __df.reason
                    });
                }
            }
        }
    }

    // Step 2: write target text WHILE PRESERVING the paragraph mark.
    // Skipped entirely in reorganizeOnly mode — we only wanted the
    // paragraph style assignment, not the text rewrite.
    //
    // CRITICAL InDesign DOM quirk: assigning `para.contents = "...\r"` first
    // deletes ALL chars (incl. the trailing \r), which momentarily merges
    // this paragraph with the next. The new text + \r then re-splits, but
    // the NEXT paragraph inherits this paragraph's appliedParagraphStyle —
    // causing _T_p_X to silently propagate to a paragraph we never intended
    // to touch.
    //
    // Fix: replace only the chars BEFORE the paragraph mark via a character
    // range, leaving the existing \r in place. This way the paragraph
    // boundary never disappears, and the next paragraph stays untouched.
    // (!emphasisOnly: pass 2 must NOT rewrite the text — it already landed in
    //  pass 1 and the save settled the layout around it. Rewriting would re-dirty
    //  that layout and re-open the exact stale-layout window this split closes.)
    if (hasTarget && !reorganizeOnly && !emphasisOnly) {
        try {
            // #BRIDGE-20: shared helper preserves the paragraph mark
            // and runs the #E2E-17 safety net. Same implementation used
            // by runMinimalApply so both paths get identical \r-handling.
            _writeParaPreserveMark(para, target);
            applyResults.targetTextWritten++;
        } catch (eW) {
            applyResults.clusterApplyFailures.push({
                tid: tid,
                reason: "write_target_failed: " + eW.message
            });
            return;
        }

        // Step 2b: clear character-level overrides AFTER content rewrite.
        // InDesign inherits prior-run character properties (font, size, color)
        // when you assign para.contents — so the CJK appliedFont we set on
        // the paragraph style gets overridden by source's Latin font, and the
        // GREP rule for Latin chars never gets a chance to apply correctly.
        // Clearing here makes para.appliedFont = (paragraph style default = CJK)
        // and re-triggers GREP for Latin runs.
        //
        // #TABLE-MINION (Phase 3): the clear ASSUMES the paragraph carries a
        // pipeline cluster style (_T_p_*) whose CJK default + Latin GREP routing
        // re-catch the cleared runs. A paragraph WITHOUT a _T_p_* cluster has no
        // GREP to re-route Latin: clearing strips the source's direct Latin font
        // and the run falls to the [Basic Paragraph] default (Minion Pro), while
        // byPair only re-stamps CJK. Such non-cluster paragraphs arise both in
        // edit-mode (Step 1 cluster-assign bypassed → table cells stay
        // [Basic Paragraph]) AND in full/fresh mode when applyClusterStyleToParagraph
        // returns applied:false with no _T_p_ fallback (:375-380).
        //
        // BUT skipping the clear is only safe for a UNIFORM source paragraph.
        // _writeParaPreserveMark's `.contents=` is a by-POSITION character
        // replacement (gate #6): the new text inherits the source textStyleRanges
        // BY CHAR POSITION (NOT a "collapse to run-1" — host-verified
        // 20260622_01). For a UNIFORM paragraph (table cell — one source font) the
        // new CJK uniformly wears that single source font (skip is benign — byPair
        // still routes CJK→MHei on top; 20260622_01: Arial source preserved). For a
        // NON-uniform paragraph (run1=fontA cols 0..k, run2=fontB cols k..n) the new
        // CJK gets SPLIT across fontA/fontB at the SOURCE runs' column boundaries —
        // boundaries meaningless for the translated text — so without a clear + GREP
        // it wears arbitrary source-Latin fonts at arbitrary offsets (20260622_01:
        // CJK split Arial|Georgia at the English run boundary). So skip ONLY for a
        // uniform non-cluster paragraph; cluster OR non-uniform OR unreadable →
        // clear (legacy behaviour — non-uniform non-cluster keeps the pre-fix Minion
        // fall, a KNOWN limitation, not a new error). clearOverrides removes DIRECT
        // overrides only; BRIDGE-31/39 leaks are CS-level so this skip never reopens
        // them.
        var __psName = null;
        try { __psName = String(para.appliedParagraphStyle.name); } catch (ePsn) { __psName = null; }
        var __srcUniform = !!(seg && seg.format_snapshot && seg.format_snapshot.uniform === true);
        if (_shouldClearParaOverrides(__psName, __srcUniform)) {
            try { SA.clearParaCharOverrides(para); } catch (eClr) {}
        } else {
            applyResults.nonClusterUniformClearSkipped = (applyResults.nonClusterUniformClearSkipped || 0) + 1;
        }

        // #BRIDGE-31: re-apply baseline fillColor / pointSize on translated
        // chars when a designer character style bleeds through cluster ps
        // defaults.
        //
        // The visual baseline captured by visual_snapshot is the EFFECTIVE
        // visual of the source chars — which for a paragraph like
        //   CS:Headings (fillColor=PANTONE 300 C, pointSize=18) +
        //   direct override (fillColor=Paper, pointSize=22.5)
        // gives baseline = {Paper, 22.5pt}. The cluster ps is built from
        // baseline, so ps.fillColor=Paper / ps.pointSize=22.5 — correct.
        //
        // But translation flow runs with normalizeCascade=false, so the
        // designer CS "Headings" survives onto translated chars (it's a
        // non-`_T_*` designer CS, so the apply skip-condition keeps it).
        // clearParaCharOverrides only clears DIRECT overrides; CS-defined
        // properties remain. Result: CS-defined PANTONE 300 C wins over
        // ps default Paper → blue text on a PANTONE 300 C background
        // becomes invisible.
        //
        // Detected in Client-A Product-1 Brochure import: 5 back-cover CTA
        // paragraphs (page 5 "Let's connect" → "让我们联系吧" with CS
        // "Headings"; body-copy / hyperlink lines with CS "Body copy" /
        // "Hyperlink") rendered as CS-default Black on PANTONE 300 C bg.
        //
        // Fix: detect when char[0] effective fillColor differs from
        // cluster ps.fillColor AND a designer CS is applied — re-stamp
        // baseline fillColor (and pointSize for the same reason) as a
        // direct override on the translated range (excluding trailing \r).
        // Emphasis runs are re-applied after this and explicitly write
        // their own diff, so this doesn't clobber emphasis intent.
        try {
            var __clusterPs = para.appliedParagraphStyle;
            var __rawC = String(para.contents || "");
            var __nC = para.characters.length;
            var __endIdxC = (__rawC.length > 0 && __rawC.charCodeAt(__rawC.length - 1) === 13)
                ? __nC - 2
                : __nC - 1;
            if (__clusterPs && __endIdxC >= 0) {
                var __ch0 = para.characters.item(0);
                var __cs0 = __ch0.appliedCharacterStyle;
                var __csName = "";
                try { __csName = (__cs0 && __cs0.name) || ""; } catch (eCsN) {}
                var __isDesignerCS = __csName &&
                    __csName !== "[None]" &&
                    __csName.indexOf("_T_") !== 0;
                if (__isDesignerCS) {
                    var __range = para.characters.itemByRange(0, __endIdxC);
                    // fillColor: compare by id (color object identity).
                    try {
                        var __psFC = __clusterPs.fillColor;
                        var __chFC = __ch0.fillColor;
                        var __same = false;
                        try { __same = (__psFC && __chFC && __psFC.id === __chFC.id); } catch (eFCEq) {}
                        if (!__same && __psFC) {
                            __range.fillColor = __psFC;
                            applyResults.designerCsBleedFillColor = (applyResults.designerCsBleedFillColor || 0) + 1;
                        }
                    } catch (eFC0) {}
                    // pointSize: compare with epsilon.
                    try {
                        var __psPS = __clusterPs.pointSize;
                        var __chPS = __ch0.pointSize;
                        if (typeof __psPS === "number" && typeof __chPS === "number" && Math.abs(__psPS - __chPS) > 0.01) {
                            __range.pointSize = __psPS;
                            applyResults.designerCsBleedPointSize = (applyResults.designerCsBleedPointSize || 0) + 1;
                        }
                    } catch (ePS0) {}
                    // font/fontStyle: skip — CJK GREP routes Latin chars
                    // to a different CS that intentionally carries a
                    // different font; overwriting here would clobber it.
                }
            }
        } catch (eBL) {}

        // #BRIDGE-35 moved to post-apply doc-wide sweep
        // (see _sweepCjkItalicToSkew at the end of runPipeline) — per-para
        // mutation here was thrashing the layout engine on the Client-A Whole
        // Life doc (~237 applies × textStyleRanges access + recompose).
    }

    // Step 2c: untranslated-restyle path — re-apply Phase 8B emphasis runs
    // using the source-side offsets. Text is unchanged (we did not rewrite),
    // so the original offsets still index the same characters. Mirrors what
    // reorganize_styles_inplace does in standalone mode, so the entire doc
    // ends up with consistent _T_p_* / _T_c_emp_* coverage instead of a
    // mix of new styles (translated paragraphs) and untouched legacy
    // overrides (untranslated paragraphs).
    // EMPHASIS SITE 1/4 — deferred to pass 2 (settled layout). See the two-pass
    // note on applyOnePara. !hasTarget here ⇒ Step 3 annotations never run on this
    // paragraph, so running after them in pass 2 cannot collide; its #27 replay
    // below re-runs from deps.carryDirectOverrideRanges.
    if (restyleUntranslated && tid && plan && plan.empRunsBySegment && plan.empRunsBySegment[tid]
            && !deferEmphasis) {
        try {
            // #ac-overset-widen (part A): widen an overset frame before the
            // untranslated-restyle emphasis lands (same protection as the 4 char-style
            // call sites). No-op if the frame isn't overset. In the two-pass flow this
            // runs on the SETTLED layout, so frame.overflows reads true and the widen
            // is minimal instead of overshooting off a stale reading.
            _widenOversetFrameForEmphasis(para, workDoc, deps, applyResults, tid);
            var empResult = SA.applyEmphasisRunsToParagraph(para, sheet, plan, tid);
            applyResults.untranslatedEmphasisApplied = (applyResults.untranslatedEmphasisApplied || 0) + (empResult.applied || 0);
            applyResults.untranslatedEmphasisSkipped = (applyResults.untranslatedEmphasisSkipped || 0)
                + (empResult.skippedNoStyle || 0) + (empResult.skippedRangeFailed || 0);
        } catch (eEmpA) {
            applyResults.clusterApplyFailures.push({
                tid: tid,
                reason: "untranslated_emphasis_failed: " + (eEmpA && eEmpA.message ? eEmpA.message : eEmpA)
            });
        }
    }

    // #27: SECOND-PASS restore of direct character overrides (capitalization /
    // fillColor / pointSize). applyEmphasisRunsToParagraph above sets
    // appliedCharacterStyle on subranges via `range.appliedCharacterStyle =
    // styleObj` — InDesign treats a char-style assignment as resetting any
    // direct overrides on that range. So even though applyClusterStyleToParagraph
    // already restored direct overrides once, the emphasis pass just wiped
    // them on its emp-styled subranges. Replay AFTER emphasis so the
    // overrides are the last word. Idempotent for paragraphs that didn't
    // hit the emphasis path.
    // Two-pass: in pass 2 Step 1 never ran, so styleResult carries no ranges —
    // take them from deps.carryDirectOverrideRanges (handed over by pass 1) so the
    // replay still lands AFTER site 1's emphasis, which is the whole point of #27.
    var __dorRanges = (styleResult && styleResult.directOverrideRanges) ? styleResult.directOverrideRanges
        : ((emphasisOnly && deps && deps.carryDirectOverrideRanges) || null);
    if (__dorRanges && __dorRanges.length
            && typeof SA.restoreDirectCharOverrideRanges === "function") {
        try {
            var dor2 = SA.restoreDirectCharOverrideRanges(para, __dorRanges);
            applyResults.directOverridesReplayed = (applyResults.directOverridesReplayed || 0) + (dor2.restored || 0);
            if (dor2.failed && dor2.failed.length) {
                if (!applyResults.directOverridesReplayLost) applyResults.directOverridesReplayLost = [];
                for (var __dr = 0; __dr < dor2.failed.length; __dr++) {
                    applyResults.directOverridesReplayLost.push({ tid: tid, info: dor2.failed[__dr] });
                }
            }
        } catch (eDOR) {
            applyResults.clusterApplyFailures.push({
                tid: tid,
                reason: "directOverride_replay_failed: " + (eDOR && eDOR.message ? eDOR.message : eDOR)
            });
        }
    }

    // Step 3: apply annotations[] (Pass B). Skipped in reorganizeOnly mode.
    // (!emphasisOnly: annotations stay in pass 1 — they're layout-affecting
    //  (pointSize / position), so they must be in place BEFORE the save settles the
    //  layout. Re-applying them in pass 2 would re-dirty it. They already ran ahead
    //  of emphasis sites 2/3/4 in the old single-pass order, so nothing inverts.)
    var anns = (hasTarget && !reorganizeOnly && !emphasisOnly && translation) ? translation.annotations : null;
    // #DIAG: trace Step 3 gating for tids with annotations
    if (!emphasisOnly && translation && translation.annotations && translation.annotations.length) {
        if (!applyResults.annDiagTrace) applyResults.annDiagTrace = [];
        applyResults.annDiagTrace.push({
            tid: tid,
            hasTarget: hasTarget,
            reorganizeOnly: reorganizeOnly,
            annCount: translation.annotations.length,
            annsResolved: anns && anns.length ? anns.length : 0,
            paraCharCount: (function(){ try { return para.characters.length; } catch(e){ return -1; } })()
        });
    }
    if (anns && anns.length) {
        var ensureDeps = {
            colorSpace: deps.ColorSpace,
            position: deps.Position
        };
        var annResults = SA.applyAnnotationsToParagraph(
            para, anns, workDoc, sheet,
            {
                ensureAnnotationCharStyle: function (wd, sh, action, value) {
                    return SS.ensureAnnotationCharStyle(wd, sh, action, value, ensureDeps);
                },
                colorSpace: deps.ColorSpace,
                position: deps.Position
            }
        );
        for (var ai = 0; ai < annResults.length; ai++) {
            var ar = annResults[ai];
            // #DIAG (temporary): collect detail for every annotation result
            if (!applyResults.annResultDetail) applyResults.annResultDetail = [];
            applyResults.annResultDetail.push({
                tid: tid,
                action: ar.ann && ar.ann.action,
                offset: ar.ann && ar.ann.offset,
                length: ar.ann && ar.ann.length,
                applied: ar.applied,
                detail: ar.detail,
                reason: ar.reason,
                truncated: ar.truncatedRange
            });
            if (ar.applied) {
                applyResults.annotationsApplied++;
                // #E2E-9d: collect reuse diagnostics for inspection
                if (ar.reused && ar.reuseDiag) {
                    if (!applyResults.annotationReuseDiag) applyResults.annotationReuseDiag = [];
                    applyResults.annotationReuseDiag.push({
                        tid: tid,
                        offset: ar.ann.offset, length: ar.ann.length,
                        diag: ar.reuseDiag
                    });
                }
            } else {
                applyResults.annotationsSkipped++;
                // #E2E-DIAG: record EVERY skipped annotation reason (not just
                // failures) so we can diagnose silent skips like out-of-range.
                if (!applyResults.annotationSkipReasons) applyResults.annotationSkipReasons = [];
                applyResults.annotationSkipReasons.push({
                    tid: tid,
                    action: ar.ann && ar.ann.action,
                    offset: ar.ann && ar.ann.offset,
                    length: ar.ann && ar.ann.length,
                    reason: ar.reason || "(no reason)",
                    scanDiag: ar.scanDiag || null
                });
                if (ar.reason && ar.reason.indexOf("failed") >= 0) {
                    applyResults.clusterApplyFailures.push({
                        tid: tid,
                        reason: "annotation:" + ar.reason
                    });
                }
            }
        }
    }

    // Step 3.4: apply target_emphasis_runs as direct character overrides.
    // Translator (or webapp format-paint / AI codec) supplies target-side
    // emphasis runs with offsets indexed against the new target text. These
    // were never consumed by applyOnePara before — emphasis only ran in the
    // restyleUntranslated branch (Step 2c) or via runMinimalApply (the M5 /
    // skip_style_cleanup path, which import_translations_v2.idjs:1781 /
    // import_integrated.idjs:2034 DO select when ctx.skipStyleCleanup — the
    // old "doesn't use" note here was stale and caused the annotation/emphasis
    // _auto gate to miss the M5 path; both paths now gate via auto_format_gate).
    // #E2E-10: route them through applyEmphasisRunsAsOverrides here so
    // position / Bold / color diffs make it onto translated paragraphs.
    // #BRIDGE-24 Fix B1: promoted to outer scope so step 4's
    // format_mixed_not_restored gate can read the apply result.
    var temrSummary = null;
    var b1Summary = null;
    // #BRIDGE-39 + Phase 8C: gate auto target_emphasis_runs by faithfulness.
    //
    // `target_emphasis_runs_auto: true` now has TWO distinct producers
    // (see app-folio design-intent.md §2/§3/§4):
    //
    //   1. Overlay heuristic (BRIDGE-39): low-confidence char-position
    //      guesses derived from source emphasis positions × source/target
    //      length ratio. NOT translator-confirmed. Applying them produces
    //      visually wrong bold/italic spans — typical symptom on Client-A Whole
    //      Life p7 where AI-guessed "Medium" emphasis landed on
    //      "增强型股票敞口" + "固定收益敞口", but the translator never
    //      marked them. These MUST stay stripped (Client-A anti-guess intact).
    //
    //   2. Phase 8C codec marker clean-roundtrip: emphasis carried through
    //      the codec with aligned markers, so the target offsets are exact,
    //      not guessed. app.js stamps `target_emphasis_runs_faithful: true`
    //      on these. They ARE faithful format intent and must be applied
    //      without confirmation (else translated text silently loses bold).
    //
    // Gate = auto && !faithful: honor faithful codec-carried runs, keep
    // stripping overlay-guessed runs. Manually-set annotations
    // (target_emphasis_runs_auto === false, or field absent meaning the
    // translator UI populated it directly) are honored as before.
    //
    // Backward-compat: packages predating the faithful flag have it absent
    // → treated as !faithful → stripped (safe default). Any rollout order
    // of the app-folio / cjkweight halves is safe.
    //
    // Gate via _terIsAuto → the canonical AutoFormatGate SoT (faithful-aware
    // after the @integration drift-reconcile); same single gate as M5.
    var __terIsAuto = _terIsAuto(translation);
    // arch it-gate diag: count runs the gate STRIPS (auto without faithful). Lets
    // the "emphasis target-side:" summary distinguish "gate stripped them"
    // (gatedAutoNonFaithful>0, applied=0) from "no runs at all" (both 0). Independent
    // of the apply if/else below — pure counter, no behavior change.
    // (!emphasisOnly: counted once, in pass 1 — a pure counter, and both passes
    //  evaluate the same gate, so counting in both would double it.)
    if (__terIsAuto && hasTarget && !reorganizeOnly && !emphasisOnly && translation
        && Array.isArray(translation.target_emphasis_runs)
        && translation.target_emphasis_runs.length) {
        applyResults.terGatedAutoNonFaithful = (applyResults.terGatedAutoNonFaithful || 0) + 1;
    }
    // EMPHASIS SITE 2/4 — deferred to pass 2 (settled layout).
    if (hasTarget && !reorganizeOnly && translation
        && !__terIsAuto
        && !deferEmphasis
        && Array.isArray(translation.target_emphasis_runs)
        && translation.target_emphasis_runs.length) {
        // #E2E-11c: belt-and-braces — never let target_emphasis_runs crash
        // the per-paragraph apply. Pre-validate deps shape, wrap the call,
        // and surface reasons via clusterApplyFailures + per-run detail in
        // targetEmphasisRunFailures so a single bad run is debuggable
        // without bringing down the whole import.
        try {
            // #ac-overset-widen (part A): if applying this emphasis would land on an
            // OVERSET frame, permanently widen the frame FIRST so the tail chars are
            // in-frame and the char-style assignment actually lands (else it silently
            // drops on the overset region → failed:0 blind spot). No-op if not overset.
            _widenOversetFrameForEmphasis(para, workDoc, deps, applyResults, tid);
            // SPEC §14 refactor: apply faithful target_emphasis_runs as NAMED
            // combined per-script CHARACTER STYLES (was raw appliedFont
            // overrides). The new helper reads the UN-REMAPPED source diff
            // (§12.4): it derives the CJK family from the live (already
            // byPair-mapped) per-char appliedFont and the Latin family from the
            // source format_snapshot — so _remapEmphasisRunsForFallback's
            // diff.fontFamily rewrite is moot for it. We therefore pass the
            // ORIGINAL runs, not the fallback-remapped ones.
            var temrDeps = {};
            if (deps && deps.Position)   temrDeps.Position   = deps.Position;
            if (deps && deps.ColorSpace) temrDeps.ColorSpace = deps.ColorSpace;
            if (deps && deps.ColorModel) temrDeps.ColorModel = deps.ColorModel;
            // TODO#15 ②: pair-authoritative emphasis weight (Semibold→Xbold).
            if (deps && deps.cjkEmphasisWeight) temrDeps.cjkEmphasisWeight = deps.cjkEmphasisWeight;
            if (deps && deps.italicConfig) temrDeps.italicConfig = deps.italicConfig;
            temrSummary = SA.applyEmphasisRunsAsCharStyles(
                para,
                translation.target_emphasis_runs,
                workDoc,
                temrDeps,
                seg
            );
            applyResults.targetEmphasisRunsApplied = (applyResults.targetEmphasisRunsApplied || 0) + (temrSummary.applied || 0);
            applyResults.targetEmphasisRunsFailed  = (applyResults.targetEmphasisRunsFailed  || 0) + (temrSummary.skipped || 0);
            // Surface per-sub-run skip/surface detail (capped to keep report bounded).
            if (temrSummary.surfaced && temrSummary.surfaced.length) {
                if (!applyResults.targetEmphasisRunFailures) applyResults.targetEmphasisRunFailures = [];
                for (var rri = 0; rri < temrSummary.surfaced.length; rri++) {
                    var rr = temrSummary.surfaced[rri];
                    if (rr.reason) {
                        applyResults.targetEmphasisRunFailures.push({
                            tid: tid, start: rr.start, end: rr.end, reason: rr.reason
                        });
                        if (applyResults.targetEmphasisRunFailures.length >= 200) break;
                    }
                }
            }
        } catch (eTER) {
            applyResults.clusterApplyFailures.push({
                tid: tid,
                reason: "target_emphasis_runs_failed: " + (eTER && eTER.message ? eTER.message : eTER)
            });
        }
    }

    // #BRIDGE-24 Fix B1: when translator didn't supply target_emphasis_runs
    // AND the target text is byte-identical to source (identity / no-op
    // translation, or untranslated row that still got pushed through with
    // target=source), fall back to source-side emphasisRuns from the
    // segment's format_snapshot. Offsets line up 1:1 because the text is
    // the same string, so applying the source runs as direct overrides
    // restores per-char formatting (font / color / position / weight)
    // that would otherwise land in `format_mixed_not_restored`. This
    // path SHOULD NOT trigger when target ≠ source — char offsets shift
    // and a translator-supplied target_emphasis_runs is required.
    // SPEC §10.5 / P3: reflect the POST-GATE state, mirroring M5 (:3385 sets
    // targetRuns=[] after stripping auto-non-faithful runs so its source-side
    // fallback fires). When the faithfulness gate stripped the target runs
    // (__terIsAuto), Step3.4 applied NOTHING from them → B1 must NOT treat them
    // as present, else an auto-non-faithful identity row never gets its genuine
    // source format restored. (B1 currently reads snake_case
    // `seg.format_snapshot.emphasis_runs` while the producer emits camelCase
    // `emphasisRuns` — that's separate backlog, untouched here.)
    var hasTargetEmphRuns = !!(translation
        && !__terIsAuto
        && Array.isArray(translation.target_emphasis_runs)
        && translation.target_emphasis_runs.length);
    var sourceEmphasisRuns = (seg.format_snapshot
        && Array.isArray(seg.format_snapshot.emphasis_runs))
        ? seg.format_snapshot.emphasis_runs : null;
    // EMPHASIS SITE 3/4 — deferred to pass 2 (settled layout).
    if (hasTarget && !reorganizeOnly && !hasTargetEmphRuns && !deferEmphasis
        && sourceEmphasisRuns && sourceEmphasisRuns.length
        && translation && String(target) === String(seg.source_text || "")) {
        try {
            // #ac-overset-widen (part A): widen an overset frame before the identity
            // emphasis restore lands, so the whole run gets the char style (not just
            // the in-frame prefix). No-op if the frame isn't overset.
            _widenOversetFrameForEmphasis(para, workDoc, deps, applyResults, tid);
            // SPEC §14: B1 identity (target===source) is cleanup of the source's
            // real format (NOT auto-propagation) → same combined-char-style helper,
            // UN-remapped runs + seg. b1Deps must carry cjkEmphasisWeight or CJK
            // identity rows can't resolve their weight (§10.2 grounded).
            var b1Deps = {};
            if (deps && deps.Position)   b1Deps.Position   = deps.Position;
            if (deps && deps.ColorSpace) b1Deps.ColorSpace = deps.ColorSpace;
            if (deps && deps.ColorModel) b1Deps.ColorModel = deps.ColorModel;
            if (deps && deps.cjkEmphasisWeight) b1Deps.cjkEmphasisWeight = deps.cjkEmphasisWeight;
            if (deps && deps.italicConfig) b1Deps.italicConfig = deps.italicConfig;
            b1Summary = SA.applyEmphasisRunsAsCharStyles(para, sourceEmphasisRuns, workDoc, b1Deps, seg);
            applyResults.sourceEmphasisRunsApplied = (applyResults.sourceEmphasisRunsApplied || 0) + (b1Summary.applied || 0);
            applyResults.sourceEmphasisRunsFailed  = (applyResults.sourceEmphasisRunsFailed  || 0) + (b1Summary.skipped || 0);
            if (b1Summary.surfaced && b1Summary.surfaced.length) {
                if (!applyResults.sourceEmphasisRunFailures) applyResults.sourceEmphasisRunFailures = [];
                for (var b1ri = 0; b1ri < b1Summary.surfaced.length; b1ri++) {
                    var b1rr = b1Summary.surfaced[b1ri];
                    if (b1rr.reason) {
                        applyResults.sourceEmphasisRunFailures.push({
                            tid: tid, start: b1rr.start, end: b1rr.end, reason: b1rr.reason
                        });
                        if (applyResults.sourceEmphasisRunFailures.length >= 200) break;
                    }
                }
            }
        } catch (eSER) {
            applyResults.clusterApplyFailures.push({
                tid: tid,
                reason: "source_emphasis_runs_fallback_failed: " + (eSER && eSER.message ? eSER.message : eSER)
            });
        }
    }

    // ─── Step 3.4b (univ-italic ④): whole-paragraph uniform-italic CJK migration ───
    // Replaces carrier #2 / #ITALIC-SKEW-PARA (the paragraph-style skew=15 that
    // style_sheet_builder used to stamp for hasCjk + Italic-intent baselines). A
    // UNIFORMLY italic source paragraph is uniform=true → emphasis extraction skips
    // it (emphasis_extractor.js:785) → no emphasisRuns → it never reached the gated
    // CS-body emphasis path (carrier #1). Synthesize ONE whole-paragraph italic run
    // so the slant lands as config-gated, per-weight CS-body skew (乙-strict: faux@
    // angle / real / block / surface — identical to carrier #1). CS-body skew
    // survives clearOverrides (probe 20260625_01), so this is robust to normalize.
    //
    // The diff carries an italic-ONLY token ("Italic") so the realization KEEPS the
    // live (byPair-resolved) baseline weight — no cjkEmphasisWeight re-pairing — and
    // reads the resolved weight's config for the faux angle. Gated to CJK-takeover
    // paragraphs (target contains CJK, mirroring carrier #2's hasCjk): a pure-Latin
    // uniform-italic body paragraph keeps its paragraph-style real italic (out of the
    // faux-skew carrier scope — not a regression). Skipped when the translator
    // supplied target_emphasis_runs (those own the slant) to avoid double-apply.
    // EMPHASIS SITE 4/4 — deferred to pass 2 (settled layout).
    var __wpiBaseline = seg && seg.format_snapshot && seg.format_snapshot.baseline;
    if (hasTarget && !reorganizeOnly && !hasTargetEmphRuns && !deferEmphasis
        && seg.format_snapshot && seg.format_snapshot.uniform === true
        && !seg.format_snapshot.scriptByFont
        && __wpiBaseline && /italic/i.test(String(__wpiBaseline.fontStyle || ""))
        && _textHasCJK(target)) {
        try {
            // run.end is EXCLUSIVE; cover the whole paragraph minus the trailing
            // paragraph mark (\r). Read para.contents (NOT Character.contents — the
            // UXP tag-ification trap, CLAUDE.md gate #1) for the visible length.
            var __wpiPC = "";
            try { __wpiPC = String(para.contents || ""); } catch (ePC) {}
            var __wpiEnd = __wpiPC.length;
            if (__wpiEnd > 0 && __wpiPC.charCodeAt(__wpiEnd - 1) === 13) __wpiEnd -= 1;
            if (__wpiEnd > 0) {
                // #ac-overset-widen (part A): widen an overset frame before the
                // whole-paragraph italic run lands. No-op if the frame isn't overset.
                _widenOversetFrameForEmphasis(para, workDoc, deps, applyResults, tid);
                var wpiDeps = {};
                if (deps && deps.Position)   wpiDeps.Position   = deps.Position;
                if (deps && deps.ColorSpace) wpiDeps.ColorSpace = deps.ColorSpace;
                if (deps && deps.ColorModel) wpiDeps.ColorModel = deps.ColorModel;
                if (deps && deps.cjkEmphasisWeight) wpiDeps.cjkEmphasisWeight = deps.cjkEmphasisWeight;
                if (deps && deps.italicConfig) wpiDeps.italicConfig = deps.italicConfig;
                var wpiSummary = SA.applyEmphasisRunsAsCharStyles(
                    para,
                    // __wholeParaItalic: this is a whole-paragraph BASELINE italic at the
                    // live weight (not a Regular-weight per-run emphasis) — the flag tells
                    // the Latin sub-run resolver to keep the live weight (audit P2).
                    [{ start: 0, end: __wpiEnd, diff: { fontStyle: "Italic", __wholeParaItalic: true } }],
                    workDoc,
                    wpiDeps,
                    seg
                );
                applyResults.wholeParaItalicApplied = (applyResults.wholeParaItalicApplied || 0) + (wpiSummary.applied || 0);
                applyResults.wholeParaItalicSkipped = (applyResults.wholeParaItalicSkipped || 0) + (wpiSummary.skipped || 0);
                if (wpiSummary.italicBlocked) {
                    applyResults.wholeParaItalicBlocked = (applyResults.wholeParaItalicBlocked || 0) + wpiSummary.italicBlocked;
                }
                if (wpiSummary.surfaced && wpiSummary.surfaced.length) {
                    if (!applyResults.wholeParaItalicFailures) applyResults.wholeParaItalicFailures = [];
                    for (var __wpiri = 0; __wpiri < wpiSummary.surfaced.length; __wpiri++) {
                        var __wpirr = wpiSummary.surfaced[__wpiri];
                        if (__wpirr.reason) {
                            applyResults.wholeParaItalicFailures.push({
                                tid: tid, start: __wpirr.start, end: __wpirr.end, reason: __wpirr.reason
                            });
                            if (applyResults.wholeParaItalicFailures.length >= 200) break;
                        }
                    }
                }
            }
        } catch (eWPI) {
            applyResults.clusterApplyFailures.push({
                tid: tid,
                reason: "whole_para_italic_failed: " + (eWPI && eWPI.message ? eWPI.message : eWPI)
            });
        }
    }

    // Step 3.5: Phase 9 paragraph-level sB/sA overrides (format-preserving merge).
    // Set after cluster style + content rewrite + annotations so the new
    // paragraph carries its original spacing even though it shares a
    // _T_p_* style with paragraphs that had different sB/sA in source.
    // (!emphasisOnly: spacing is layout-affecting → belongs in pass 1, before the settle.)
    if (plan && plan.spaceOverridesBySegment && tid && !emphasisOnly && plan.spaceOverridesBySegment[tid]) {
        try {
            var spOv = SA.applySpaceOverridesToParagraph(para, plan, tid);
            if (spOv && spOv.applied) {
                applyResults.spaceOverridesApplied = (applyResults.spaceOverridesApplied || 0) + spOv.applied;
            }
            if (spOv && spOv.skipped) {
                applyResults.spaceOverridesSkipped = (applyResults.spaceOverridesSkipped || 0) + spOv.skipped;
            }
        } catch (eSpO) {
            applyResults.clusterApplyFailures.push({
                tid: tid,
                reason: "space_override_failed: " + eSpO.message
            });
        }
    }

    // #BRIDGE-25 Step 3.6: script-font enforcement — translation-agnostic.
    // The cluster paragraph style routes CJK chars to psFont and Latin
    // chars to a `_T_Latin_*` CS via nested GREP. That GREP doesn't fire
    // on chars carrying a designer character style (Hyperlink, etc.),
    // so designer-CS-wrapped CJK runs render with whatever Latin font
    // the cluster propagated to the CS — tofu. This pass walks each
    // designer-CS char and stamps the script-appropriate font as a
    // direct override (CS preserved for color/underline/position; font
    // alone gets corrected). Independent of source emphasis_runs and
    // independent of translation, so the fix holds under real
    // translation where offsets shift / target text changes shape.
    //
    // Runs for both translated AND reorganize-only paragraphs (anything
    // that's been touched by cluster apply). Skipped paragraphs naturally
    // bail out via the no-targets early return inside the enforcer.
    // 8D-ext-D step-3b: gated on deps.runEnforcer !== false (threaded from
    // ctx.runEnforcer via paraDeps — the importer's M4 checkbox). Default-on
    // semantics: bridge / direct callers that don't pass the field keep the
    // shipped always-run behavior.
    // (!emphasisOnly: font stamping is layout-affecting → pass 1, before the settle.
    //  Safe to run ahead of the deferred emphasis: the enforcer skips any char whose
    //  CS starts with `_T_` (script_font_enforcer.js:222), which is exactly what the
    //  emphasis sites apply, so the two never contend for the same chars.)
    if ((!deps || deps.runEnforcer !== false) && !emphasisOnly) {
        try {
            var sfeStats = ScriptFontEnforcer.enforceScriptFontsInParagraph(para);
            if (sfeStats) {
                applyResults.scriptFontCjkEnforced   = (applyResults.scriptFontCjkEnforced   || 0) + (sfeStats.cjkEnforced || 0);
                applyResults.scriptFontLatinEnforced = (applyResults.scriptFontLatinEnforced || 0) + (sfeStats.latinEnforced || 0);
                applyResults.scriptFontErrors        = (applyResults.scriptFontErrors        || 0) + (sfeStats.errors || 0);
            }
        } catch (eSFE) {
            applyResults.clusterApplyFailures.push({
                tid: tid,
                reason: "script_font_enforce_failed: " + (eSFE && eSFE.message ? eSFE.message : eSFE)
            });
        }
    }

    // Step 4: track format_mixed_not_restored (uniform=false; MVP no per-run restore)
    // #BRIDGE-24 Fix B1: don't flag as "not restored" when the target-emphasis
    // path or the source-fallback path actually applied at least one run for
    // this segment — formatting was preserved via direct overrides, even if
    // through a different channel than the canonical target_emphasis_runs.
    // (!deferEmphasis: this reads the site 2/3 summaries, so it can only be judged in
    //  the pass that actually applied them. Running it in pass 1 would see both null
    //  and report every mixed-format segment as not-restored — a false positive.)
    if (!deferEmphasis && seg.format_snapshot && seg.format_snapshot.uniform === false) {
        var restoredThisSeg = (b1Summary && b1Summary.applied > 0)
                           || (temrSummary && temrSummary.applied > 0);
        if (!restoredThisSeg) {
            applyResults.formatMixedNotRestored.push({
                tid: tid,
                sample: String(seg.source_text || "").substring(0, 40),
                runCount: (seg.format_snapshot.runs || []).length
            });
        }
    }

    // #ac-overset-widen AC2 top-up. The widen above was sized against the layout as
    // it stood BEFORE this paragraph's emphasis landed; emphasis makes glyphs heavier
    // (Regular→Bold/Xbold) and therefore WIDER, so a minimally-widened frame can tip
    // back into overset once the style is on. The char styles are already applied and
    // stay applied (a style is a character attribute — it survives a later overset;
    // only ASSIGNING onto overset chars silently fails), so this is purely geometry:
    // re-run the same minimal widen to bring the now-heavier text back inside.
    // AC2 wants overflows=false in the delivered doc, and "expand as little as
    // possible" (user, 20260714) — hence top-up-after rather than padding up front.
    // The dedup list is cleared for this frame first, or the widen would no-op on a
    // frame it already recorded; the record is then merged so the report shows ONE
    // entry per frame with the original width and the final width.
    if (emphasisOnly) {
        try {
            var __tuFrame = _firstTextFrame(para.parentTextFrames);
            if (!__tuFrame) { try { __tuFrame = _firstTextFrame(para.parentStory.textContainers); } catch (eTU0) {} }
            var __tuId = null; try { __tuId = __tuFrame && __tuFrame.id; } catch (eTU1) {}
            // #HANG-LOG (20260908): bracket the LIVE overflows read. It is a host call
            // OUTSIDE the widen, so a hang in it prints no `widen enter` line either —
            // without this pair the instrumentation one level down still sees nothing.
            var __tuLog = (deps && typeof deps.plog === "function") ? deps.plog : null;
            // The "about to read" line is the one that survives a hang, so it is gated on
            // the trace flag; the RESULT line stays always-on when the frame IS overset,
            // because that is rare and is what the widen lines below hang off.
            var __tuTrace = _traceSettle();
            if (__tuLog && __tuTrace) { try { __tuLog("ac2 topup: tid=" + tid + " frame=" + __tuId + " — read overflows"); } catch (eTL0) {} }
            var __tuOver = false; try { __tuOver = (__tuFrame && __tuFrame.overflows === true); } catch (eTU2) {}
            if (__tuLog && (__tuOver || __tuTrace)) { try { __tuLog("ac2 topup: tid=" + tid + " frame=" + __tuId + " overflows=" + __tuOver); } catch (eTL1) {} }
            // Overset NOW, after the style landed — regardless of whether this frame was
            // overset BEFORE. The earlier version only topped up frames already present in
            // framesWidened, which missed the case the comment above actually describes: a
            // frame that fit at Regular, was therefore never widened (and so has no record),
            // and tipped into overset only because the emphasis made its glyphs heavier.
            // That one shipped overset while the report read clean (impl-audit 20260715,
            // A-class). RED-LINE "never touch a non-overset frame" is intact: overflows is
            // read LIVE here, so we only ever widen a frame that IS overset right now.
            if (__tuOver && __tuId != null) {
                if (!applyResults.framesWidened) applyResults.framesWidened = [];
                var __prev = null, __pi = -1;
                for (var __ti = 0; __ti < applyResults.framesWidened.length; __ti++) {
                    if (applyResults.framesWidened[__ti].frameId === __tuId) { __prev = applyResults.framesWidened[__ti]; __pi = __ti; break; }
                }
                // Drop any existing record so the widen's own dedup lets it re-enter this
                // frame; restored below if the re-widen doesn't produce a new one.
                if (__prev) applyResults.framesWidened.splice(__pi, 1);
                var __again = _widenOversetFrameForEmphasis(para, workDoc, deps, applyResults, tid);
                if (__again) {
                    // Keep the TRUE original width when this frame was already widened once;
                    // with no prior record the frame's own pre-top-up width IS the original.
                    if (__prev) __again.origWidth = __prev.origWidth;
                    __again.toppedUpAfterEmphasis = true;
                } else if (__prev) {
                    applyResults.framesWidened.splice(__pi, 0, __prev);    // top-up failed → restore the record
                }
            }
        } catch (eTU) {}
    }

    // Pass-1 completed this paragraph → it is eligible for pass 2. Reached only by
    // falling off the bottom, so every early return above (including
    // write_target_failed) correctly leaves this false and the caller skips it —
    // exactly as the single-pass code skipped the emphasis sites on those rows.
    // The #27 replay ranges ride along here rather than in a tid-keyed map: pass 2
    // needs them (Step 1 doesn't run there, so styleResult is empty), and some rows
    // have no tid. Plain {start,end,props} data — no DOM refs.
    if (deferEmphasis) {
        applyResults.__deferParaCompleted = true;
        applyResults.__deferCarryRanges = (styleResult && styleResult.directOverrideRanges) || null;
    }
}

// ─── #ac-overset-widen: pass 2 (emphasis on the SETTLED layout) ────
//
// Every report field the emphasis sites feed. Built here, not inline in the report
// literal, because pass 2 finishes AFTER runPipeline has already materialized that
// literal — the caller merges this over it. One builder = the two can't drift.
function _emphasisReportFields(applyResults) {
    return {
        target_emphasis_runs_applied: applyResults.targetEmphasisRunsApplied || 0,
        target_emphasis_runs_failed:  applyResults.targetEmphasisRunsFailed  || 0,
        target_emphasis_run_failures: applyResults.targetEmphasisRunFailures || [],
        source_emphasis_runs_applied: applyResults.sourceEmphasisRunsApplied || 0,
        source_emphasis_runs_failed:  applyResults.sourceEmphasisRunsFailed  || 0,
        source_emphasis_run_failures: applyResults.sourceEmphasisRunFailures || [],
        untranslated_emphasis_applied: applyResults.untranslatedEmphasisApplied || 0,
        untranslated_emphasis_skipped: applyResults.untranslatedEmphasisSkipped || 0,
        whole_para_italic_applied:  applyResults.wholeParaItalicApplied  || 0,
        whole_para_italic_skipped:  applyResults.wholeParaItalicSkipped  || 0,
        whole_para_italic_blocked:  applyResults.wholeParaItalicBlocked  || 0,
        whole_para_italic_failures: applyResults.wholeParaItalicFailures || [],
        frames_widened: applyResults.framesWidened || [],
        format_mixed_not_restored: applyResults.formatMixedNotRestored.length,
        cluster_apply_failures: applyResults.clusterApplyFailures.length
    };
}

// PASS 2 — re-enter applyOnePara in emphasisOnly mode for every paragraph pass 1
// recorded, now that the caller's save has settled the layout. This is the half that
// actually fixes the bug: frame.overflows finally reads true here, so the widen is
// minimal and correct, and the char style lands on settled layout instead of being
// discarded by the settle that follows it.
//
// MUST run against pass 1's paragraph refs (refreshed), NOT a fresh locate: the
// locator matches segments by their SOURCE text, which pass 1 has already overwritten
// with the target — re-locating here would miss exactly the translated paragraphs
// this pass exists for.
//
// @param pending  runPipeline(...).__emphasisPending (null unless ctx.deferEmphasis)
// @returns {ok, parasApplied, skippedInvalid, throws, fields, error}
function runEmphasisSettlePass(workDoc, pending) {
    var out = { ok: false, parasApplied: 0, skippedInvalid: 0, throws: 0, fields: null, error: null };
    if (!pending || !pending.worklist || !pending.applyResults) {
        out.error = "no pending emphasis state (pass 1 did not run with ctx.deferEmphasis)";
        return out;
    }
    var applyResults = pending.applyResults;

    // Clone pass 1's paraDeps and flip the two flags — same lib/enum/config wiring,
    // so pass 2 resolves fonts, colors and italic config identically to pass 1.
    var d = {};
    for (var k in pending.paraDeps) {
        if (Object.prototype.hasOwnProperty.call(pending.paraDeps, k)) d[k] = pending.paraDeps[k];
    }
    d.deferEmphasis = false;
    d.emphasisOnly  = true;

    // Progress, on the same principle as the apply loop: a phase that can run for
    // minutes has to say so WHILE it runs, not once at the end.
    var __splog = (d && typeof d.plog === "function") ? d.plog : null;
    var __spTrace = _traceSettle();   // #HANG-LOG: the per-item lines are opt-in, see _traceSettle
    var __spNow = function () { return (typeof Date !== "undefined" && Date.now) ? Date.now() : 0; };
    var __spT0 = __spNow();
    if (__splog) { try { __splog("emphasis settle: begin worklist=" + pending.worklist.length); } catch (eS0) {} }
    // #HANG-LOG (20260908): hand the run's log to style_applier for the duration of this
    // pass, so the font-catalog scan (the one host cost in here that is a product of
    // catalog size x unresolved faces x sub-runs, and that has never appeared in any log)
    // can report itself. Cleared where the pass returns — a logger left pointing at a
    // finished run's plog would keep writing into it. (Every throw inside the pass is
    // already caught locally, so that single clear point is reached; if a future edit
    // adds an escaping throw, wrap this in a try/finally rather than adding a second
    // clear — two clear points is how one of them gets forgotten.)
    try {
        var __saMod = d && d.lib && d.lib.styleApplier;
        if (__saMod && typeof __saMod.setDiagLogger === "function") __saMod.setDiagLogger(__splog);
        // #FONT-SCAN (20260908): open the face-resolution cache for this pass. This is
        // the window in which the claim "the font catalog cannot change" is actually
        // true — one synchronous doScript — which is why the cache is opened by the
        // caller rather than being always-on inside style_applier. The cost it removes
        // is real and measured: this pass asked for one absent face once per Latin
        // script sub-run, 35 times over the document, at 8m18s each.
        if (__saMod && typeof __saMod.beginFaceCache === "function") __saMod.beginFaceCache();
    } catch (eSD) {}

    for (var i = 0; i < pending.worklist.length; i++) {
        var w = pending.worklist[i];
        var __spItem = __spNow();
        // #HANG-LOG (20260908): the enter line goes HERE — before the two `continue`s and
        // before _refreshParaWrapper — not next to the applyOnePara call. An item that
        // hits `continue` at the isValid check, or that hangs inside _refreshParaWrapper,
        // emits NOTHING at all, so an enter line placed after them leaves exactly the
        // paths that produce silence uncovered. (First placement of this line was after
        // the refresh; an adversarial read pointed out that it therefore covered neither
        // the slow-then-skipped item nor the refresh itself — the two shapes that look
        // identical to a stuck item from outside.) `s4` is the site-4 gate, computed from
        // data only: it says whether this row had emphasis work at all, which the failing
        // run could not answer without a second run.
        if (__splog && __spTrace) {
            var __seSeg = (w && w.lr && w.lr.seg) || null;
            var __seFs = (__seSeg && __seSeg.format_snapshot) || null;
            var __seBl = (__seFs && __seFs.baseline) || null;
            var __seS4 = !!(__seFs && __seFs.uniform === true && !__seFs.scriptByFont
                && __seBl && /italic/i.test(String(__seBl.fontStyle || "")));
            try {
                __splog("settle enter: " + (i + 1) + "/" + pending.worklist.length
                    + " tid=" + ((__seSeg && __seSeg.tid) || "-")
                    + " s4=" + __seS4
                    + " carry=" + (((w && w.carryDirectOverrideRanges) || []).length));
            } catch (eS2) {}
        }
        if (!w || !w.lr) continue;
        if (__splog && __spTrace) { try { __splog("settle " + (i + 1) + ": refresh wrapper"); } catch (eS3) {} }
        // Re-resolve the wrapper: the paragraph may have been split/merged since pass 1
        // (soft-break merge deletes paragraphs outright), and a leaked wrapper reads the
        // wrong char range (CLAUDE.md gate #12).
        //
        // NOT load-bearing for the overset fix — the 20260715 isolation probe applied
        // emphasis with a deliberately STALE handle and it landed in full, which is what
        // refuted the stale-handle hypothesis. Kept as cheap defence-in-depth per gate #12
        // (a fresh handle is never worse than a stale one), not as part of the mechanism.
        try { if (w.lr.para) w.lr.para = _refreshParaWrapper(w.lr.para); } catch (eRf) {}
        var alive = false;
        try { alive = !!(w.lr.para && w.lr.para.isValid); } catch (eV) { alive = false; }
        if (!alive) { out.skippedInvalid++; continue; }

        d.editTextOnly = w.editTextOnly;
        d.carryDirectOverrideRanges = w.carryDirectOverrideRanges || null;
        // #HANG-LOG (20260908): the last marker before the call, so the three regions of
        // one iteration — refresh / validity / apply — are separable in the log.
        if (__splog && __spTrace) { try { __splog("settle " + (i + 1) + ": applyOnePara"); } catch (eS4) {} }
        try {
            applyOnePara(workDoc, w.lr, pending.sheet, pending.plan, w.t, applyResults, d);
            out.parasApplied++;
            // Every 25, and ANY single item over a second - a slow phase is usually a
            // few slow items, and an every-N line hides exactly those. The widen lines
            // above then name the frame.
            if (__splog) {
                var __spMs = __spNow() - __spItem;
                if (__spMs > 1000 || (i % 25) === 0) {
                    try {
                        __splog("emphasis settle: " + (i + 1) + "/" + pending.worklist.length
                            + " (item +" + __spMs + "ms, phase +" + (__spNow() - __spT0) + "ms)");
                    } catch (eS1) {}
                }
            }
        } catch (eE) {
            out.throws++;
            applyResults.clusterApplyFailures.push({
                tid: w.lr.seg && w.lr.seg.tid,
                reason: "emphasis_settle_pass_throw: " + (eE && eE.message ? eE.message : eE)
            });
        }
    }
    // Re-run the #BRIDGE-41 annotation restamp — it must have the LAST WORD, and
    // deferring emphasis moved pass 2 AFTER its first run. The emphasis apply calls
    // spanRange.clearOverrides() (style_applier.js:1704) before assigning the CS, and
    // the compensating replay restores only underline/strikeThrough DETAIL, never the
    // `underline` / `strikeThrough` BOOLEANS (never captured — _readCharOverrides
    // :2453-2464). So without this, a translator underline annotation overlapping an
    // emphasis run is wiped by pass 2 and nothing puts it back, while every counter
    // still reports success (impl-audit 20260715, A-class). Same for a manual `bold`
    // annotation, whose font dim is deliberately never replayed.
    // #HANG-LOG (20260908): the loop above can also end SILENTLY — every remaining item
    // taking a `continue` emits nothing — and the restamp that follows emits nothing at
    // all while walking the whole locate plan. So "loop still running" and "loop finished,
    // stuck in the restamp" produced identical evidence: no line, either way. These two
    // lines separate them.
    if (__splog) { try { __splog("emphasis settle: loop done, applied=" + out.parasApplied + " skipped=" + out.skippedInvalid + " throws=" + out.throws + " +" + (__spNow() - __spT0) + "ms"); } catch (eS5) {} }
    if (pending.locatePlan && pending.translations) {
        if (__splog) { try { __splog("restamp: begin rows=" + (pending.locatePlan.length || 0)); } catch (eS6) {} }
        try {
            _restampAnnotationFormats(workDoc, pending.locatePlan, pending.translations, applyResults, d);
            if (__splog) { try { __splog("restamp: end +" + (__spNow() - __spT0) + "ms"); } catch (eS7) {} }
            out.restampedAfterEmphasis = true;
        } catch (eRs) {
            out.restampedAfterEmphasis = false;
            applyResults.clusterApplyFailures.push({
                tid: "<post-emphasis-restamp>",
                reason: "annotation_restamp_after_emphasis_failed: " + (eRs && eRs.message ? eRs.message : eRs)
            });
        }
    }

    out.fields = _emphasisReportFields(applyResults);
    out.ok = true;
    // #HANG-LOG (20260908): see the setDiagLogger call at the top of this pass.
    try {
        var __saMod2 = d && d.lib && d.lib.styleApplier;
        if (__saMod2 && typeof __saMod2.setDiagLogger === "function") __saMod2.setDiagLogger(null);
        if (__saMod2 && typeof __saMod2.endFaceCache === "function") __saMod2.endFaceCache();
    } catch (eSD2) {}
    return out;
}

// ─── #E2E-16 soft-break merge assembly ─────────────────────────────
//
// Assemble the merged head target for ONE soft-break group (merge path
// only — full-split groups skip the merge loop entirely and never reach
// this). Extracted from the runPipeline merge loop so the collapse rule
// below is Node-testable (tests/soft_break_merge_tests.js).
//
// Collapse rule (#E2E-16b): a member whose TARGET is empty while its
// SOURCE had real content is a translator-merged sub-line — the webapp's
// default format_aware_soft_break_merge emits exactly this shape for a
// uniform-format group (sb0 carries the whole translation, tails go out
// empty). Emitting its separator anyway leaves a dangling forced line
// break = a visible blank line after the merged paragraph (proven at
// runtime: merged bullet contents "…Account<LF><CR>" renders 2 lines).
// Such members contribute NEITHER separator NOR text. A member whose
// source is ALSO empty/whitespace-only is an intentional blank line
// ("TITLE\n\nSUBTITLE") — keep its separator + empty piece. (The current
// export drops whitespace-only source pieces before emitting sub-segments
// — see soft_break_orig_index — so that arm is defensive for other
// package producers / hand-edited packages.)
//
// The same rule covers the head's own piece: head target empty + head
// source non-empty → the base piece is not emitted, and the first emitted
// member gets no leading separator (no leading blank line). This also
// cleans the #BRIDGE-21 promotion path, where the row-less sb0 used to
// contribute a dangling separator before the promoted head's text.
//
// anyNonEmpty keeps the legacy meaning (some member target has content);
// the caller's all-empty guard behavior is unchanged. Suppression is NOT
// decided here — the caller marks every non-head member regardless.
function _sbAssembleMergedTarget(grp, headTid, baseTarget, seps, byTid) {
    function isCollapsed(targetTxt, seg) {
        if (targetTxt.length !== 0) return false;
        var src = seg ? seg.source_text : null;
        // Unknown source → keep the legacy emit (conservative).
        if (src == null) return false;
        // "Real content" mirrors the export's own piece-emptiness test
        // (whitespace-only pieces are dropped there).
        return String(src).replace(/\s+/g, "").length > 0;
    }
    var basePiece = String(baseTarget != null ? baseTarget : "");
    var headSeg = null;
    for (var hi = 0; hi < grp.length; hi++) {
        if (grp[hi].tid === headTid) { headSeg = grp[hi].seg; break; }
    }
    var pieces = [];
    var anyNonEmpty = (basePiece.length > 0);
    if (!isCollapsed(basePiece, headSeg)) pieces.push(basePiece);
    for (var mi = 0; mi < grp.length; mi++) {
        if (grp[mi].tid === headTid) continue;
        var memT = byTid[grp[mi].tid];
        // Prefer each sibling's saved original target if available —
        // otherwise a re-run after we suppressed the sibling (its
        // target_text might have been altered by some other writer
        // between runs) would degrade the merge.
        var memBase = (memT && memT.__sb_orig_target != null) ? memT.__sb_orig_target : (memT && memT.target_text);
        var memTxt = (memBase != null) ? String(memBase) : "";
        if (memTxt.length > 0) anyNonEmpty = true;
        if (isCollapsed(memTxt, grp[mi].seg)) continue;
        // Pick the separator at the gap between this member and the
        // previous merged piece. We index by sbIdx-1 (the gap following
        // the member at sbIdx-1) so the separator order tracks the
        // original document layout regardless of which member was
        // promoted as head.
        var sepIdx = Math.max(0, (grp[mi].sbIdx || 0) - 1);
        var sep = (sepIdx < seps.length) ? String(seps[sepIdx]) : "\n";
        // No separator before the FIRST emitted piece (possible only when
        // the head piece collapsed) — it would render a leading blank line.
        if (pieces.length > 0) pieces.push(sep);
        pieces.push(memTxt);
    }
    return { text: pieces.join(""), anyNonEmpty: anyNonEmpty };
}

// ─── runPipeline ───────────────────────────────────────────────────

function runPipeline(workDoc, ctx, deps) {
    if (!workDoc) throw new Error("runPipeline: workDoc required");
    if (!ctx || !ctx.report || !ctx.segments || !ctx.translations) {
        throw new Error("runPipeline: ctx requires { report, segments, translations }");
    }
    if (!deps || !deps.lib || !deps.findFont || !deps.hashFn) {
        throw new Error("runPipeline: deps requires { lib, findFont, hashFn, LinkStatus, ColorSpace, Position, getCollectionItem }");
    }

    // Reset the shared italic-availability probe cache at apply-stage entry, so
    // BOTH the normal commit path AND the edit-mode-bypass path (which skips
    // commitStylePlan, the other reset site) start each pass with a fresh cache
    // — the module-level cache persists for the V8 lifetime and could otherwise
    // bleed a prior doc's stale family→italic results into a bypass run. [audit P2]
    try { FontItalicProbe.resetItalicProbeCache(); } catch (eRPC) {}

    var report = ctx.report;
    var segments = ctx.segments;
    var translations = ctx.translations;

    // #E2E-12 (B): paragraph_index drift compensation. preclean's
    // splitSoftBreaksWithFormatChange inserts \r characters that bump the
    // story's paragraph count; segments.json was captured from a pre-preclean
    // doc snapshot, so seg.paragraph_index references the pre-split layout.
    // Apply each story's cumulative tailCount-shift here, BEFORE locate, so
    // segment_locator's by-story-paragraph-index strategy lines up with the
    // current work doc.
    //
    // Shift rule (mirrors cleanupConsecutiveBulletsWithFormatChange):
    // for each delta with paraIdx < seg.paragraph_index in the same story,
    // add its tailCount. paragraph_index == delta.paraIdx (the head portion
    // of a split paragraph) is unchanged — the head stays at its original
    // index. Audit-mode round-trips stay stable because preclean is
    // idempotent: once a soft-break gets promoted to \r, the second
    // import's preclean finds nothing to split → shift=0 → no drift.
    // #SOFTBREAK-SPLIT: soft-break groups the preclean FULLY split because the
    // lines differ in format (e.g. a 25pt-Semibold title + 15pt-Book subtitle).
    // These must stay as SEPARATE paragraphs: the per-segment shift below remaps
    // sibling sb_k onto the k-th preclean split-out paragraph (head+k), and the
    // re-join (#E2E-16) is skipped for them so each line keeps its own cluster
    // style. Uniform / partially-split groups keep the legacy merge. Visible to
    // the re-join loop further down.
    var __sbSplitGroups = {};
    if (ctx.splitDeltasByStoryId && segments && segments.length) {
        // Aggregation extracted to SoftBreakPlan.buildAggByStory so that EVERY
        // consumer of planSoftBreakSplits derives aggByStory from ONE implementation.
        // The copydeck-faithful re-run's preclean-only plan probe calls the same
        // function; a probe-side copy of this marshalling would agree only by luck.
        // Binding stays LOCAL — the #E2E-12 shift loop below reuses aggByStory.
        var aggByStory = SoftBreakPlan.buildAggByStory(ctx.splitDeltasByStoryId);
        // Decide which groups stay split BEFORE the per-segment shift mutates
        // indices (planSoftBreakSplits reads the pre-shift index via
        // _original_paragraph_index ?? paragraph_index, so it is correct on both
        // first run and re-run).
        __sbSplitGroups = SoftBreakPlan.planSoftBreakSplits(segments, aggByStory);

        var shiftStats = { stories: 0, segmentsShifted: 0, maxShift: 0, sbRemapped: 0 };
        for (var __seg = 0; __seg < segments.length; __seg++) {
            var s = segments[__seg];
            if (!s || typeof s.paragraph_index !== "number") continue;
            if (typeof s.story_id === "undefined" || s.story_id === null) continue;
            // #BRIDGE-11: idempotency. A previous runPipeline call on
            // the same segments array already mutated paragraph_index
            // and stashed the pre-shift value in _original_paragraph_index.
            // Restore from that backup so the second pass starts from a
            // clean baseline; otherwise repeated runs (tests, re-imports
            // sharing ctx, recovery flows) would compound the shift.
            if (typeof s._original_paragraph_index === "number") {
                s.paragraph_index = s._original_paragraph_index;
            }
            var sidKey = String(s.story_id);
            var agg = aggByStory[sidKey];
            if (!agg || !agg.length) continue;
            var shift = 0;
            for (var __ai = 0; __ai < agg.length; __ai++) {
                if (agg[__ai].paraIdx < s.paragraph_index) shift += agg[__ai].tailCount;
                else break;
            }
            // #SOFTBREAK-SPLIT remap: for a full-split group, sibling sb_k lands
            // on the k-th preclean split-out paragraph (head+k). sb0 (k=0) stays
            // on the head. This is ADDITIVE to the normal earlier-split shift.
            var sbOffset = 0;
            if (s.soft_break_group && __sbSplitGroups[String(s.soft_break_group)]
                && typeof s.soft_break_index === "number" && s.soft_break_index >= 1) {
                sbOffset = s.soft_break_index;
            }
            var totalShift = shift + sbOffset;
            if (totalShift > 0) {
                if (typeof s._original_paragraph_index !== "number") {
                    s._original_paragraph_index = s.paragraph_index;
                }
                s.paragraph_index = s.paragraph_index + totalShift;
                shiftStats.segmentsShifted++;
                if (sbOffset > 0) shiftStats.sbRemapped++;
                if (totalShift > shiftStats.maxShift) shiftStats.maxShift = totalShift;
            }
        }
        shiftStats.stories = Object.keys(aggByStory).length;
        report.paragraph_index_shift = shiftStats;
    }

    var FM = deps.lib.fontMapping;
    var SL = deps.lib.segmentLocator;
    var SS = deps.lib.styleSheetBuilder;
    var HE = deps.lib.hardErrors;
    var SMA = deps.lib.styleMergeAdvisor;   // optional

    // Force POINTS for measurement units throughout pipeline.
    // CRITICAL: segments.json captures all numeric paragraph properties
    // (spaceBefore/spaceAfter/indents/leading/pointSize) in POINTS during
    // export (export forces MeasurementUnits.POINTS before scanning).
    // If commit applies those numbers while doc has different units (e.g.
    // INCHES, the default for most templates), InDesign interprets them
    // as inches → spaceAfter:24 becomes 24 INCHES = 1728pt → frames
    // immediately overflow. Restore at end via try/finally below.
    var _origUnits = { h: null, v: null };
    var MU = deps.MeasurementUnits;
    if (MU && MU.POINTS !== undefined) {
        try { _origUnits.h = workDoc.viewPreferences.horizontalMeasurementUnits; } catch (eU0) {}
        try { _origUnits.v = workDoc.viewPreferences.verticalMeasurementUnits; } catch (eU1) {}
        try { workDoc.viewPreferences.horizontalMeasurementUnits = MU.POINTS; } catch (eU2) {}
        try { workDoc.viewPreferences.verticalMeasurementUnits = MU.POINTS; } catch (eU3) {}
    }
    function _restoreUnits() {
        if (_origUnits.h !== null) { try { workDoc.viewPreferences.horizontalMeasurementUnits = _origUnits.h; } catch (eUR0) {} }
        if (_origUnits.v !== null) { try { workDoc.viewPreferences.verticalMeasurementUnits = _origUnits.v; } catch (eUR1) {} }
    }

    // #DIAG-TIMING: per sub-phase timing (helps locate where the 17×
    // manual-vs-automated slowdown lands). Lightweight — just Date.now()
    // markers between phases, results surfaced in report.timings.
    var __timings = { _start: Date.now() };
    // #REALTIME-LOG (2026-05-26): plog handle passed from import entry.
    // Each __mark also flushes a log line so the .log file is current up
    // to the moment of any crash / hang. plog itself writeFileSync's the
    // whole buffer on every call — atomic from the caller's perspective.
    var __plog = (deps && typeof deps.plog === "function") ? deps.plog : null;

    // 2026-05-28: ProcessingDialog 进度条钩子。ctx.onProgress(percent, message)
    // 在每个内部里程碑被 __mark 时调用，让 UI 进度条贯穿 V2Pipeline.runPipeline
    // 这个原本是 single blob (~50s) 的过程。百分比根据实际三轮 import log
    // 的耗时分布定的：
    //   commit 阶段是大头（~70% 总时长）→ 18%→70% 在这段平滑
    //   apply loop 6s → 70%→80%
    //   post sweeps + label 0.5s → 80%→82%
    // 调用方（import_translations_v2）的 UI 区间在 V2Pipeline 之外用 15-82%。
    var __PROGRESS_MAP = {
        "stage1_analyze_start":        { pct: 15, msg: "Analyzing styles" },
        "buildStylePlan_done":         { pct: 16, msg: "Building style plan" },
        "locateAllSegments_done":      { pct: 17, msg: "Locating segments" },
        "stage3_commit_start":         { pct: 18, msg: "Committing styles" },
        "commitStylePlan_done":        { pct: 70, msg: "Applying translations to paragraphs" },
        "apply_loop_start":            { pct: 71, msg: "Applying translations to paragraphs" },
        "apply_loop_done":             { pct: 80, msg: "Running post-flight sweeps" },
        "post_sweeps_done":            { pct: 81, msg: "Running post-flight sweeps" },
        "postflight_done":             { pct: 81, msg: "Finalizing pipeline" },
        "import_state_label_written":  { pct: 82, msg: "Finalizing pipeline" }
    };
    var __onProgress = (ctx && typeof ctx.onProgress === "function") ? ctx.onProgress : null;
    function __mark(label) {
        var ms = Date.now() - __timings._start;
        __timings[label] = ms;
        if (__plog) { try { __plog("pipeline: " + label + " +" + ms + "ms"); } catch (e) {} }
        if (__onProgress) {
            var pe = __PROGRESS_MAP[label];
            if (pe) {
                try { __onProgress(pe.pct, pe.msg); } catch (eUP) {}
            }
        }
    }

    // ── Stage ① Analyze ──
    report.pipeline_stage = "analyze";
    __mark("stage1_analyze_start");

    var libDeps = {
        fontMapping: FM,
        findFont: deps.findFont,
        colorSpace: deps.ColorSpace,
        ColorSpace: deps.ColorSpace,           // commitStylePlan needs ColorSpace too
        ColorModel: deps.ColorModel,           // for synthesizing colors
        Justification: deps.Justification,     // for justification enum resolution
        Leading: deps.Leading,                 // for AUTO leading enum
        ListType: deps.ListType,               // for bullets/numbering enum resolution
        TabStopAlignment: deps.TabStopAlignment, // [indent-general] for _applyTabStops tab-alignment enum
        position: deps.Position,
        // #BRIDGE-26 Fix B: forward RuleWidth so _applyRuleSpec inside
        // commitStylePlan can resolve paragraph_snapshot.rule_above.width
        // ("TEXT_WIDTH" / "COLUMN_WIDTH") to the actual enum. Without
        // this, the resolved branch in style_sheet_builder.js skips
        // setting ruleAboveWidth and InDesign defaults to COLUMN_WIDTH
        // — visually "rule occupies the whole column" for paragraph
        // rules that designer intended to span text width only.
        RuleWidth: deps.RuleWidth,
        // #REALTIME-LOG (2026-05-26): forward plog so commitStylePlan
        // emits sub-step breadcrumbs to the log file as it goes.
        plog: __plog,
        // univ-italic ③ (audit P0 fix): thread the per-weight italic config to
        // commitStylePlan so _writeStyleFontNormalized config-gates the Latin CS.
        // Was omitted from libDeps → ③ saw null → every `_T_Latin_*` italic CS was
        // written upright regardless of config (config-gating silently inert).
        // Same source as the per-paragraph apply deps (ctx.preloadedFontMapping).
        italicConfig: (ctx.preloadedFontMapping && ctx.preloadedFontMapping.brandConfig) || null
    };

    // Phase 8A + 8B pre-passes. Both mutate seg.format_snapshot in place.
    // 8A folds CJK/Latin script-by-font paragraphs into uniform with GREP
    // routing; 8B promotes per-character overrides on remaining mixed-format
    // paragraphs into baseline + emphasisRuns. Optional libs (so the pipeline
    // still runs in environments that haven't bundled them).
    //
    // Idempotency restore: export_translation_package now runs 8A+8B at
    // export time and persists `emphasis_runs` (snake_case) in segments.json.
    // Restore the camelCase `emphasisRuns` field so downstream code reads
    // a single shape, and let the extractor's gate skip already-processed
    // segments (it skips when `emphasisRuns` is set).
    var preExtractedCount = 0;
    for (var ire = 0; ire < segments.length; ire++) {
        var fsRe = segments[ire] && segments[ire].format_snapshot;
        if (!fsRe) continue;
        if (fsRe.emphasis_runs && !fsRe.emphasisRuns) {
            fsRe.emphasisRuns = fsRe.emphasis_runs;
            preExtractedCount++;
        }
    }
    if (preExtractedCount > 0) {
        report.emphasis_pre_extracted = preExtractedCount;
    }

    var SC8A = deps.lib.scriptClassifier;
    var EX8B = deps.lib.emphasisExtractor;
    if (SC8A && typeof SC8A.applyScriptByFontDetection === "function") {
        try {
            var sbfStats = SC8A.applyScriptByFontDetection(segments);
            report.script_by_font = {
                detected: sbfStats.detected,
                skipped:  sbfStats.skipped,
                ids:      sbfStats.ids
            };
        } catch (e8A) {
            report.errors.push("scriptByFont threw: " + (e8A && e8A.message ? e8A.message : e8A));
        }
    }
    if (EX8B && typeof EX8B.applyEmphasisExtraction === "function") {
        try {
            var empStats = EX8B.applyEmphasisExtraction(segments, {
                targetLanguage: ctx.targetLanguage || null,
                editMode:       !!ctx.editMode
            });
            report.emphasis = {
                processed:                  empStats.processed,
                runs_total:                 empStats.runsEmphasisTotal,
                char_style_preserved:       empStats.runsSkippedExistingCharStyleTotal,
                target_language_override:   empStats.targetLanguageOverrideCount
            };
        } catch (e8B) {
            report.errors.push("emphasis extraction threw: " + (e8B && e8B.message ? e8B.message : e8B));
        }
    }

    // TODO#15 ②: pair-authoritative CJK weight. Build a lookup from the
    // PROJECTED byPair (already in ctx before runPipeline, :import wiring) so the
    // style builder's CJK psFont weight comes from the brand_config pair
    // (Whitney Semibold → MHei PRC Xbold) instead of a rank-nearest cross-font
    // guess. Fail-open: any error / empty byPair → null → today's rank behavior.
    var __cjkPairWeightLookup = null;
    try {
        var __pfm = ctx.preloadedFontMapping;
        if (__pfm && Array.isArray(__pfm.byPair) && __pfm.byPair.length) {
            __cjkPairWeightLookup = require("./font_mapping_pairs.js")
                .makeCjkWeightLookup(__pfm.byPair, __pfm.brandConfig || null);
        }
    } catch (eCwl) { __cjkPairWeightLookup = null; }

    // TODO#15 ②: same pair authority for the EMPHASIS apply path. Faithful CJK
    // emphasis runs carry the SOURCE weight name ("Semibold"); without this the
    // apply composes "MHei PRC\tSemibold" (no such face) → silent one-notch
    // downgrade to Bold. This resolver lets _applyDiffToRange recover the brand
    // target (Semibold→MHei Xbold) from (currentCjkFamily, srcWeight). Fail-open.
    var __cjkEmphasisWeightResolver = null;
    try {
        var __pfmE = ctx.preloadedFontMapping;
        if (__pfmE && Array.isArray(__pfmE.byPair) && __pfmE.byPair.length) {
            __cjkEmphasisWeightResolver = require("./font_mapping_pairs.js")
                .makeCjkEmphasisWeightResolver(__pfmE.byPair, __pfmE.brandConfig || null);
        }
    } catch (eCwr) { __cjkEmphasisWeightResolver = null; }

    var plan;
    try {
        plan = SS.buildStylePlan(segments, workDoc, {
            fontPolicy: ctx.fontPolicy || null,
            // TODO#15 ②: pair-authoritative CJK weight (null → rank fallback).
            cjkPairWeightLookup: __cjkPairWeightLookup,
            // Phase 9 default: format-preserving merge for sB/sA. Pulled
            // from ctx so the entry point (CLI flag, dialog checkbox, or
            // package field) can override.
            spacePreservingMerge: ctx.spacePreservingMerge !== false,
            // Reorganize-dialog-driven knobs (import flow surfaces the same
            // panel as reorganize_styles_inplace). null = include all
            // dimensions / 0 = strict color match — both no-ops compared
            // to the legacy behavior.
            fingerprintDimensions: ctx.fingerprintDimensions || null,
            colorTol: (typeof ctx.colorTol === "number") ? ctx.colorTol : 0,
            // #28: master-spread paragraphs cluster separately from body
            // paragraphs by default. ctx.splitMasterFromBody === false
            // opts back into single-pool clustering.
            splitMasterFromBody: ctx.splitMasterFromBody !== false
        }, libDeps);
    } catch (eBP) {
        report.errors.push("buildStylePlan failed: " + eBP.message);
        _restoreUnits(); return { aborted: true, stage: "analyze.buildStylePlan" };
    }
    __mark("buildStylePlan_done");
    // TODO#15 ②: surface CJK weight resolution — pair-mapped count + any
    // SURFACED rank fallbacks (no-pair source weights guessed cross-font).
    if (__plog && plan && plan.clusterReport && plan.clusterReport.cjk_weight_resolution) {
        try {
            var __cwr = plan.clusterReport.cjk_weight_resolution;
            var __fb = __cwr.fallbackRank || [];
            __plog("cjk-weight: pair-mapped=" + (__cwr.fromPair || 0)
                + " rank-fallback=" + __fb.length
                + (__fb.length
                    ? " [" + __fb.map(function (f) {
                        return f.srcFont + "/" + f.srcStyle + "→" + f.resolvedStyle + (f.count > 1 ? "×" + f.count : "");
                    }).join(", ") + "]"
                    : ""));
        } catch (eCwrLog) {}
    }
    // Auto-merge near-duplicate clusters (e.g. fontSize 7 vs 7.89 in same
    // source style) when ctx.autoMergeConfidence is set.
    //   "high"        — only merge HIGH-confidence groups (safest)
    //   "high+medium" — also include MEDIUM (more aggressive)
    //   "all"         — merge any near-dup group regardless of confidence
    //   "hybrid"      — KDE peak detection (recommended; uses ctx.hybridOpts)
    if (ctx.autoMergeConfidence && SMA && typeof SMA.mergeGroupsAtConfidence === "function") {
        try {
            var mergeResult = SMA.mergeGroupsAtConfidence(
                plan, segments, ctx.autoMergeConfidence, undefined, ctx.hybridOpts || undefined
            );
            report.style_plan_merge = {
                threshold: ctx.autoMergeConfidence,
                merge_count: mergeResult.mergeCount,
                paragraphs_affected: mergeResult.paragraphsAffected,
                style_count_before: mergeResult.styleCountBefore,
                style_count_after: mergeResult.styleCountAfter,
                summary: mergeResult.summary
            };
        } catch (eMerge) {
            report.errors.push("style merge advisor failed: " + (eMerge && eMerge.message ? eMerge.message : eMerge));
        }
    }

    // Build "which para styles share each Latin pool entry" breakdown so
    // the report shows visually how the dedup played out.
    var latinUsage = {};   // latinFingerprint → { name, paraStyleCount, samples[] }
    for (var lsI = 0; lsI < plan.latinStylesToCreate.length; lsI++) {
        var lsEntry = plan.latinStylesToCreate[lsI];
        latinUsage[lsEntry.fingerprint] = {
            name: lsEntry.name,
            fontFamily: lsEntry.fontFamily,
            fontStyle: lsEntry.fontStyle,
            origin: lsEntry.origin,
            substituted: !!lsEntry.substituted,
            para_style_count: 0,
            sample_para_styles: []
        };
    }
    for (var psI = 0; psI < plan.paraStylesToCreate.length; psI++) {
        var psEntry = plan.paraStylesToCreate[psI];
        if (psEntry.grepRule && psEntry.grepRule.latinStyleFingerprint) {
            var rec = latinUsage[psEntry.grepRule.latinStyleFingerprint];
            if (rec) {
                rec.para_style_count++;
                if (rec.sample_para_styles.length < 5) {
                    rec.sample_para_styles.push(psEntry.name);
                }
            }
        }
    }
    var latinBreakdown = [];
    for (var fp in latinUsage) {
        if (latinUsage.hasOwnProperty(fp)) latinBreakdown.push(latinUsage[fp]);
    }
    latinBreakdown.sort(function (a, b) { return b.para_style_count - a.para_style_count; });

    report.style_plan = {
        para_styles_count: plan.paraStylesToCreate.length,
        latin_pool_size: plan.latinStylesToCreate.length,
        latin_pool_breakdown: latinBreakdown,
        cluster_report: plan.clusterReport,
        cjk_resolution: plan.fontPlan.cjk
    };

    // ── #67 A0: READ-SIDE DISTRUST (arch 2026-08-22, option 乙) ──────────────
    //
    // Runs HERE — before locate — because this is the first place the sidecar is
    // consumed, and both consumers (locate's B② bypass below, and classify later)
    // must see the same cleaned state. One choke point, not two.
    //
    // A sidecar written before A0 can hold entries we can PROVE are false: an
    // `applied_hash` alongside `applied_paragraph_style === null` AND
    // `cluster_fingerprint === null` — a combination the label writer could only
    // ever produce for a row it never located (those two fields were assigned
    // inside `if (__lp2 && __lp2.para)`, the hash outside it). Such an entry
    // claims "I applied text X" about a paragraph that does not contain X.
    // classify would hash-match it straight to `noop` and skip the row, so the
    // first failure sealed itself in permanently.
    //
    // We do NOT rewrite the operator's document to repair this — changing their
    // file without saying so is the same disease. We decline, for this run, to
    // believe a record we can demonstrate is false.
    //
    // 🔴 CONVERGENCE INVARIANT — the point of the whole fix:
    //   An ignored row classifies `full`, so it is retried this run.
    //     · If it now locates and writes  → the label records a TRUE applied_hash.
    //     · If it still cannot be located → A0's gate writes `applied:false` with
    //       NO applied_hash → next run it classifies `full` again.
    //   Either branch moves the state toward truth and never back.
    //   ⇒ A false "success" could be recorded once, by a pre-A0 writer, and can
    //     never be recorded again. No path re-creates one.
    var __priorAppliedByTid = null;
    if (ctx.editImportMode && ctx.sidecarState) {
        try {
            var __ISS = require("./import_state_store.js");
            if (__ISS.findUnappliedEntries(ctx.sidecarState).length) {
                var __stripped = __ISS.stripUnappliedEntries(ctx.sidecarState);
                ctx.sidecarState = __stripped.state;
                report.sidecar_unapplied_ignored = {
                    count: __stripped.removed.length,
                    tids: __stripped.removed
                };
                // Ignoring them quietly would just be a different silence.
                if (__plog) {
                    try {
                        __plog("import_state: IGNORING " + __stripped.removed.length
                            + " sidecar entr" + (__stripped.removed.length === 1 ? "y" : "ies")
                            + " that record an applied_hash but were never actually applied"
                            + " (no paragraph style + no cluster fingerprint => the previous import"
                            + " never located these rows). They are treated as having no prior"
                            + " state, so this run RE-TRIES them instead of skipping them as done."
                            + "\n  ignored tids: " + __stripped.removed.join(","));
                    } catch (eSU) {}
                }
            }
            // #62 B②: index the SURVIVING entries by the tid the incoming
            // segments carry (the SOURCE tid). Entries are keyed by workDoc tid
            // after `_computeWorkDocTid` re-keying, but each one retains
            // `src_tid`; index by both and let src_tid win.
            var __pa = {};
            var __sk = Object.keys(ctx.sidecarState.segments || {});
            for (var __pi = 0; __pi < __sk.length; __pi++) {
                __pa[__sk[__pi]] = ctx.sidecarState.segments[__sk[__pi]];
            }
            for (var __pj = 0; __pj < __sk.length; __pj++) {
                var __pe = ctx.sidecarState.segments[__sk[__pj]];
                if (__pe && __pe.src_tid) __pa[__pe.src_tid] = __pe;
            }
            __priorAppliedByTid = __pa;
        } catch (eISS) {
            report.errors.push("sidecar unapplied-entry filter failed: "
                + (eISS && eISS.message ? eISS.message : eISS));
        }
    }

    var locatePlan;
    try {
        locatePlan = SL.locateAllSegments(workDoc, segments, {
            hashFn: deps.hashFn,
            getCollectionItem: deps.getCollectionItem,
            // #62 B②: lets tryStoryParagraphIndex recognise a paragraph as the
            // one THIS tid was written to last round, when the package's
            // source_hash can no longer match it. Absent (first import, or no
            // sidecar) → the strategy chain behaves exactly as before.
            priorAppliedByTid: __priorAppliedByTid,
            // require()d directly, NOT via the `DiffClassify` cache var — that
            // var is declared further down this function, so relying on `var`
            // hoisting to read it here would work only by accident.
            appliedHashMatchesText: require("./import_diff_classify.js").appliedHashMatchesText
        });
    } catch (eLP) {
        report.errors.push("locateAllSegments failed: " + eLP.message);
        _restoreUnits(); return { aborted: true, stage: "analyze.locate" };
    }
    __mark("locateAllSegments_done");
    var locatedCount = 0;
    var paraNotLocated = [];
    for (var li = 0; li < locatePlan.length; li++) {
        var lr0 = locatePlan[li];
        if (lr0.para) {
            locatedCount++;
        } else {
            // Phase 4: surface per-tid miss reason so translators / designers
            // can triage quickly. segment_locator emits reason on misses
            // (e.g. "not_located" when story+paragraph_index doesn't match).
            paraNotLocated.push({
                tid: lr0.seg && lr0.seg.tid,
                story_id: lr0.seg && lr0.seg.story_id,
                paragraph_index: lr0.seg && lr0.seg.paragraph_index,
                reason: lr0.reason || "unknown",
                translatable: !!(lr0.translatable !== false)
            });
        }
    }
    report.locate = {
        total: locatePlan.length,
        located: locatedCount,
        miss: locatePlan.length - locatedCount,
        para_not_located: paraNotLocated
    };
    // #62 C-1: this number was ALREADY computed here and only ever reached the
    // trailing summary dialog (`Located: N/total`) — never the log. On 2026-08-21
    // an entire debugging round was spent reconstructing a figure the pipeline had
    // already calculated: a second import into an already-translated doc located
    // 61/110 (the 49 misses were exactly the paragraphs round 1 had successfully
    // translated), and every log line stayed green. Print it, and print WHICH rows
    // missed — a bare count still can't tell an operator what was dropped.
    if (__plog) {
        try {
            // ONE plog call for the whole block, not one per miss: plog rewrites the
            // entire accumulated buffer to disk on every call
            // (import_integrated.idjs:511-514), so N calls cost O(N²) bytes written.
            // A package where everything misses would otherwise turn a diagnostic
            // into a slowdown. Same information, one write.
            var __ll = ["locate: located=" + locatedCount + "/" + locatePlan.length
                + " miss=" + (locatePlan.length - locatedCount)];
            for (var __mi = 0; __mi < paraNotLocated.length; __mi++) {
                var __m = paraNotLocated[__mi];
                __ll.push("  locate MISS: tid=" + (__m.tid || "?")
                    + " story_id=" + (__m.story_id === undefined ? "?" : __m.story_id)
                    + " paragraph_index=" + (__m.paragraph_index === undefined ? "?" : __m.paragraph_index)
                    + " translatable=" + (__m.translatable ? "yes" : "no")
                    + " reason=" + (__m.reason || "unknown"));
            }
            __plog(__ll.join("\n"));
        } catch (eLL) {}
    }

    var preflight;
    try {
        preflight = HE.runPreflight(workDoc, segments, translations.rows, plan.fontPlan, locatePlan, {
            LinkStatus: deps.LinkStatus,
            getCollectionItem: deps.getCollectionItem,
            severityRules: deps.severityRules || null   // null → uses HE.DEFAULT_SEVERITY
        });
    } catch (ePF) {
        report.errors.push("runPreflight failed: " + ePF.message);
        _restoreUnits(); return { aborted: true, stage: "analyze.preflight" };
    }
    report.preflight = preflight;

    // ── Stage ② Gate ──
    // ctx.continueOnBlocking = true bypasses the gate so the pipeline still
    // commits + applies whatever paragraphs DID locate. Matches v1 behavior
    // (write the located segments, leave the unlocateable ones at their
    // source values). The blocking[] array is retained on the report so
    // downstream tooling can flag the missing paragraphs even though the
    // doc was written. Use case: real translation packages where a few
    // paragraphs (table cells, soft-break sub-segments) can't be located
    // by the current strategies but the bulk of the work IS valid.
    if (preflight.blocking_count > 0 && !ctx.continueOnBlocking) {
        report.pipeline_stage = "gate_blocked";
        _restoreUnits(); return { aborted: false, blocked: true, plan: plan, locatePlan: locatePlan, preflight: preflight };
    }
    if (preflight.blocking_count > 0 && ctx.continueOnBlocking) {
        report.preflight_blocking_overridden = true;
        // #62 C-3: bypassing a BLOCKING gate used to be completely silent — the
        // flag was set on the report and nothing was logged or shown. On
        // 2026-08-21 that let 51 `para_not_located_translatable` blocking errors
        // (every one of them a paragraph the operator's edit would never reach)
        // pass without a single trace in the log. The gate itself is unchanged
        // (owner ruled: no ratio threshold) — it just has to say so out loud.
        if (__plog) {
            try {
                __plog("preflight: BLOCKING GATE OVERRIDDEN — " + preflight.blocking_count
                    + " blocking finding(s) bypassed because continueOnBlocking=true"
                    + " (located segments are still written; the rest keep their source values)");
            } catch (eBO) {}
        }
    }

    // ── Stage ② dry-run short-circuit ──
    // ctx.dryRun = true skips the commit + apply + postflight stages and
    // returns the plan + preflight intact, so the caller can serialize a
    // style_plan_report.json without touching the doc. Useful for previewing
    // what the pipeline would do (cluster sizes, emphasis pool, locate
    // coverage, font resolutions) before committing.
    if (ctx.dryRun) {
        report.pipeline_stage = "dry_run";
        _restoreUnits();
        return {
            aborted: false,
            blocked: false,
            dryRun: true,
            plan: plan,
            locatePlan: locatePlan,
            preflight: preflight
        };
    }

    // ── Stage ③ Commit ──
    //
    // EDIT-MODE BYPASS: when the source doc already carries the cluster pool
    // we want to keep (= in-place edit mode with a valid sidecar), skip
    // commitStylePlan entirely. Otherwise every re-import rebuilds the 27+
    // cluster styles from segments.json's EN-source snapshot — overwriting
    // any operator post-import style mutations (e.g. SHS→MHei swap done via
    // migrate_paragraph_styles_by_position). The classify path below then
    // sees fingerprint drift and escalates every row to `full`, completing
    // the edit-mode defeat.
    //
    // Concrete failure observed 2026-05-27 Client-A run: post-migrate label had
    // MHei fingerprints; commitStylePlan ran, rebuilt clusters with SHS;
    // classify compared MHei (label) vs SHS (live) → 11 fingerprint_changed
    // → 18/20 rows full → full pipeline reverted the entire migration.
    //
    // With the bypass: sheet maps are empty, the apply loop treats every
    // non-noop row as text-only (forced via the bucket router below), and
    // the cluster style definitions stay untouched.
    //
    // LEGACY-PROMOTION CASE: when editImportMode + legacyPromotion are set
    // but sidecarState hasn't been synthesized yet (it's built downstream at
    // ~line 1587 by reading live paragraph state), the bypass must STILL
    // fire here. Otherwise commit rebuilds the cluster pool from EN-source
    // snapshot first, then the synthesized sidecar captures those rebuilt
    // styles as the "live" baseline — destroying the very state legacy
    // promotion is meant to preserve. Snapshotting must happen against the
    // un-mutated styles, so commit has to be skipped on this path too.
    report.pipeline_stage = "commit";
    __mark("stage3_commit_start");
    var sheet;
    var __editModeBypassCommit = !!(ctx.editImportMode
        && (ctx.sidecarState || ctx.legacyPromotion));
    if (__editModeBypassCommit) {
        if (__plog) { try { __plog("commit: SKIPPED (edit mode active — preserving live cluster styles)"); } catch (e) {} }
        sheet = {
            paraStyleMap: {},
            latinStyleMap: {},
            cjkStyleMap: {},
            empCharStyleMap: {},
            annotationCharStyleCache: {},
            __editModeStub: true
        };
    } else {
        try {
            // continueOnBlocking already bypassed the gate above; route to the
            // unguarded commit so the second guard inside commitStylePlanGuarded
            // doesn't undo the override.
            if (ctx.continueOnBlocking && preflight.blocking_count > 0) {
                sheet = SS.commitStylePlan(workDoc, plan, libDeps);
            } else {
                sheet = SS.commitStylePlanGuarded(workDoc, plan, preflight, libDeps);
            }
        } catch (eC) {
            report.errors.push("commitStylePlanGuarded failed: " + eC.message);
            _restoreUnits(); return { aborted: true, stage: "commit", plan: plan, locatePlan: locatePlan, preflight: preflight };
        }
    }
    __mark("commitStylePlan_done");
    if (sheet && sheet._commitTimings) {
        __timings._commitInternal = sheet._commitTimings;
    }

    var applyResults = {
        clusterStylesApplied: 0,
        targetTextWritten: 0,
        annotationsApplied: 0,
        annotationsSkipped: 0,
        skippedNoPara: 0,
        skippedEmptyTarget: 0,
        untranslatedRestyled: 0,
        untranslatedEmphasisApplied: 0,
        untranslatedEmphasisSkipped: 0,
        clusterApplyFailures: [],
        formatMixedNotRestored: [],
        orphanSourceStylesCount: 0
    };

    var paraDeps = {
        // #REALTIME-LOG, again. The 2026-05-26 note in import_integrated.idjs says
        // why the top-level deps carries plog: without it a 160s sub-phase writes
        // nothing and the log is useless the moment the run freezes. paraDeps did
        // not copy it through, so everything downstream of here - applyOnePara, the
        // overset widen, the emphasis settle pass - was silent for exactly that
        // reason. Measured 2026-09-08: a real import sat at 100% of one core for
        // 8+ minutes between two log lines, with nothing from outside able to tell
        // it apart from a hang.
        plog: deps.plog,
        lib: deps.lib,
        ColorSpace: deps.ColorSpace,
        // SPEC §13.3.2: the combined-char-style emphasis helper's _resolveFillColor
        // synth branch needs ColorModel (was absent from paraDeps; new color
        // emphasis would otherwise degrade to the default model).
        ColorModel: deps.ColorModel,
        Position: deps.Position,
        reorganizeOnly: !!ctx.reorganizeOnly,
        // 8D-ext-D step-3b: importer M4 enforcer toggle (top-level ctx field).
        // undefined when the caller never set it → applyOnePara keeps the
        // shipped always-run behavior (gate is `!== false`).
        runEnforcer: ctx.runEnforcer,
        // In edit mode (commit bypassed), disable applyStyleToUntranslated
        // so untranslated paragraphs don't try to read from the empty sheet
        // stub. They keep their post-migrate styles, which is the goal.
        applyStyleToUntranslated: __editModeBypassCommit ? false : !!ctx.applyStyleToUntranslated,
        // #ac-overset-widen: two-pass settle-then-emphasis. When ctx.deferEmphasis is
        // set, this loop is PASS 1 — it skips every emphasis site and records a
        // worklist instead; the caller settles the layout with a save, then drives
        // PASS 2 via runEmphasisSettlePass(). Unset → the original single-pass
        // behavior (Node tests / any non-settle caller). See applyOnePara's note.
        deferEmphasis: !!ctx.deferEmphasis,
        // TODO#15 ②: pair-authoritative emphasis weight resolver (null → no-op).
        cjkEmphasisWeight: __cjkEmphasisWeightResolver,
        // univ-italic (task_plan §7): per-weight italic HOW config = the brand_config
        // (carries `italic_by_weight`). The emphasis apply path reads it via
        // italic_config.lookup to realize italic (faux@angle / real / surface / block).
        // null → no italic_by_weight → every italic-marked run surfaces (乙 strict).
        italicConfig: (ctx.preloadedFontMapping && ctx.preloadedFontMapping.brandConfig) || null
    };

    // #ac-overset-widen pass-2 worklist. Recorded INSIDE the apply loop below rather
    // than rebuilt afterwards so pass 2 lands on exactly the paragraphs pass 1 applied:
    // that loop's routing (soft-break suppression, merge_tail skips, edit-mode
    // noop/textOnly buckets) is intricate, and re-deriving it here would be a second
    // source of truth free to drift out of step with the first.
    var __emphasisWorklist = [];

    // #E2E-16: soft-break sub-segment merging. When export segmented a
    // single paragraph containing intra-paragraph U+2028 (soft breaks)
    // into N sub-segments (sb0..sbN-1), all share paragraph_index and
    // locate to the SAME InDesign paragraph. The legacy logic only
    // skipped status="merge_tail" rows, but the current export emits
    // every sub-segment with status="translated" — so multiple writes
    // hit one paragraph in arbitrary order and target_text is lost.
    //
    // Fix: for each soft_break_group, treat sb_index=0 as the head and
    // join its + all siblings' target_text using head.soft_break_separators
    // (falling back to "\n"). Apply the head once with the merged target;
    // suppress sb_index > 0 siblings entirely.
    //
    // Side-effect: head's translation.target_text is mutated in place
    // BEFORE applyOnePara reads it. We snapshot the original so a
    // re-run sees the same head row (idempotent under audit round-trip).
    var __sbSuppress = {};
    var __sbGroups = {};
    for (var __si0 = 0; __si0 < locatePlan.length; __si0++) {
        var __lr0 = locatePlan[__si0];
        if (!__lr0 || !__lr0.seg) continue;
        var __sg = __lr0.seg.soft_break_group;
        if (!__sg) continue;
        if (!__sbGroups[__sg]) __sbGroups[__sg] = [];
        __sbGroups[__sg].push({
            tid: __lr0.seg.tid,
            sbIdx: (typeof __lr0.seg.soft_break_index === "number") ? __lr0.seg.soft_break_index : 0,
            seg: __lr0.seg
        });
    }
    for (var __gk in __sbGroups) {
        if (!Object.prototype.hasOwnProperty.call(__sbGroups, __gk)) continue;
        var __grp = __sbGroups[__gk];
        if (__grp.length < 2) continue;
        // #SOFTBREAK-SPLIT: the preclean fully split this group (format-differing
        // lines) and the index shift above remapped each sibling onto its own
        // split-out paragraph (head+k). Do NOT collapse them back: skip the merge
        // + suppress entirely so every sibling writes to its own paragraph with
        // its own cluster style, and record NO merged head — so the orphan
        // cleanup leaves the split-out tail paragraphs in place.
        if (__sbSplitGroups[String(__gk)]) continue;
        __grp.sort(function (a, b) { return a.sbIdx - b.sbIdx; });
        var __head = __grp[0];
        var __headT = translations.byTid[__head.tid];
        // #BRIDGE-21: if the head translation row is missing entirely,
        // we previously `continue`d — leaving every sibling tail
        // un-suppressed. The main locatePlan loop would then write
        // each tail to the same physical paragraph (they all share
        // paragraph_index), and the last write would win — scrambling
        // the paragraph to a single sibling's translation. Even with
        // no head translation we should suppress all siblings to keep
        // the paragraph atomic, and if any sibling has target_text we
        // promote the first such sibling as the merge base so the
        // paragraph gets a coherent translation rather than nothing.
        if (!__headT) {
            var __promoted = null;
            for (var __pi0 = 1; __pi0 < __grp.length; __pi0++) {
                var __sibT = translations.byTid[__grp[__pi0].tid];
                if (__sibT && __sibT.target_text) { __promoted = __grp[__pi0]; break; }
            }
            if (!__promoted) {
                // No sibling has a target either — suppress all but
                // the head (which doesn't exist in byTid; nothing to
                // suppress for it) and skip the merge entirely.
                for (var __pi1 = 1; __pi1 < __grp.length; __pi1++) {
                    __sbSuppress[__grp[__pi1].tid] = true;
                }
                continue;
            }
            // Treat the promoted sibling as the head: its target
            // becomes piece[0], all OTHER members get suppressed.
            __head = __promoted;
            __headT = translations.byTid[__head.tid];
            // Re-sort so head is at index 0 only for separator/suppress
            // logic below; we don't actually mutate __grp ordering, just
            // skip __head in the sibling iteration below.
        }
        // Separators come from sb_index=0 (group's structural head, which
        // always carries the metadata even when its translation is
        // missing). Fall back to "\n" per separator when the array is
        // shorter than the join positions.
        var __seps = (__grp[0].seg && __grp[0].seg.soft_break_separators) || [];
        // #BRIDGE-11: idempotency. Use the saved un-merged head target
        // as the merge base instead of the current target_text — if
        // we already merged once before (re-run, shared ctx), the
        // current target_text starts with the previously merged blob,
        // and re-appending sibling targets would compound.
        if (!__headT.__sb_orig_target_saved) {
            __headT.__sb_orig_target = __headT.target_text;
            __headT.__sb_orig_target_saved = true;
        }
        var __baseTarget = (__headT.__sb_orig_target != null) ? __headT.__sb_orig_target : __headT.target_text;
        var __headTid = __head.tid;
        // #E2E-16b: piece assembly — including the empty-target collapse
        // rule (a translator-merged sub-line must not leave a dangling
        // separator = blank rendered line) — lives in
        // _sbAssembleMergedTarget above (Node-testable).
        var __merged = _sbAssembleMergedTarget(__grp, __headTid, __baseTarget, __seps, translations.byTid);
        // Every non-head member is suppressed regardless of whether its
        // piece was emitted or collapsed — no sibling may write to the
        // shared paragraph separately. (Skips whoever became the merge
        // head: sb0 normally, a promoted sibling under #BRIDGE-21.)
        for (var __mi = 0; __mi < __grp.length; __mi++) {
            if (__grp[__mi].tid === __headTid) continue;
            __sbSuppress[__grp[__mi].tid] = true;
        }
        // Only overwrite the head's target_text when at least one piece had
        // actual content. If every sub-segment was blank (translator left
        // them all empty), joining the separators would produce a "\n"-
        // only string that downstream classify reads as non-empty and
        // routes to textOnly → applyOnePara would write the separators
        // over a real Chinese heading and visually erase it. Leaving the
        // head's target_text untouched preserves the skip-row filter.
        if (__merged.anyNonEmpty) {
            __headT.target_text = __merged.text;
        }
        // #BRIDGE-10: record (story_id, head paragraph_index) so the
        // post-apply orphan cleanup only deletes tails for sb groups
        // that we actually merged. Without this set, the cleanup
        // walks every preclean split tail regardless of whether a
        // soft-break group was responsible.
        if (!__sbMergedHeads) var __sbMergedHeads = {};
        var __hsid = __head.seg && __head.seg.story_id;
        // #BRIDGE-14: prefer _original_paragraph_index (pre-shift) when
        // recording the head key. After #BRIDGE-11 the shift step
        // mutates seg.paragraph_index to the post-preclean coordinate,
        // but the orphan cleanup loop below keys lookups against
        // splitDeltasByStoryId[sid][i].paraIdx — which is recorded
        // PRE-shift. Without this alignment the lookup misses for any
        // sb head that sits in a story with earlier splits (story-internal
        // shift > 0), and the corresponding tail paragraphs survive →
        // visible duplicate content / frame overset.
        var __hpi = null;
        if (__head.seg) {
            if (typeof __head.seg._original_paragraph_index === "number") {
                __hpi = __head.seg._original_paragraph_index;
            } else if (typeof __head.seg.paragraph_index === "number") {
                __hpi = __head.seg.paragraph_index;
            }
        }
        if (typeof __hsid !== "undefined" && __hsid !== null && typeof __hpi === "number") {
            __sbMergedHeads[String(__hsid) + ":" + String(__hpi)] = true;
        }
    }
    if (typeof __sbMergedHeads === "undefined") var __sbMergedHeads = {};

    // #BRIDGE-30: reverse write order within each story.
    //
    // segment_locator caches a Paragraph DOM ref on every locateResult once,
    // before any writes. As the apply loop runs sequentially forward and
    // each `_writeParaPreserveMark` + `clearOverrides` reflows the story,
    // InDesign invalidates the cached wrappers for downstream paragraphs in
    // the same story — every later write throws "Object is invalid", and
    // the partial mutation occasionally consumes the paragraph mark on the
    // first failure (the next two paragraphs merge into one).
    //
    // Symptom in the 26-05-25 Client-A Product-1 Brochure: story 17081
    // dropped from 61 to 44 paragraphs after import; 41 "Object is invalid"
    // failures, 27 English originals left untouched, 9 mixed CN+EN
    // paragraphs from \r consumption.
    //
    // Fix: bucket locatePlan by story, sort each bucket by paragraph_index
    // descending, then process. Writing the LAST paragraph first leaves
    // earlier paragraph wrappers structurally unchanged (any reflow happens
    // after the wrappers we're about to use are no longer needed). Stories
    // still get processed in their original encounter order so report /
    // log ordering doesn't shift; only intra-story order is reversed.
    //
    // Stable tie-breaker by original index: soft-break sub-segments share
    // paragraph_index but rely on sb0 being processed before sb1+ (sb0
    // writes the merged text; sb1+ are suppressed via __sbSuppress).
    // Table cells have synthetic paragraph_index orders-of-magnitude
    // larger than regular paras, so they cluster at the top of their
    // bucket — safe because table-cell writes don't affect
    // story.paragraphs[] indexing.
    var __applyOrder = [];
    {
        var __storyOrder = [];
        var __storyBuckets = {};
        for (var __ai0 = 0; __ai0 < locatePlan.length; __ai0++) {
            var __alr = locatePlan[__ai0];
            var __key = "_nostory_" + __ai0;
            if (__alr && __alr.seg) {
                if (typeof __alr.seg.story_index === "number") __key = "si:" + __alr.seg.story_index;
                else if (typeof __alr.seg.story_id === "number") __key = "sid:" + __alr.seg.story_id;
            }
            if (!Object.prototype.hasOwnProperty.call(__storyBuckets, __key)) {
                __storyBuckets[__key] = [];
                __storyOrder.push(__key);
            }
            __storyBuckets[__key].push({ lr: __alr, origIdx: __ai0 });
        }
        for (var __so = 0; __so < __storyOrder.length; __so++) {
            var __bk = __storyBuckets[__storyOrder[__so]];
            __bk.sort(function (a, b) {
                function pi(x) {
                    if (!x || !x.lr || !x.lr.seg) return -1;
                    if (typeof x.lr.seg.paragraph_index === "number") return x.lr.seg.paragraph_index;
                    if (typeof x.lr.seg._original_paragraph_index === "number") return x.lr.seg._original_paragraph_index;
                    return -1;
                }
                var dp = pi(b) - pi(a);                // DESC by paragraph_index
                if (dp !== 0) return dp;
                return a.origIdx - b.origIdx;          // stable for ties (sb0 < sb1)
            });
            for (var __bi = 0; __bi < __bk.length; __bi++) __applyOrder.push(__bk[__bi].lr);
        }
    }

    __mark("apply_loop_start");
    __timings._applyBatches = []; // [{batch_end_idx, elapsed_ms_since_start}]
    var __applyLoopStartMs = Date.now();

    // ── EDIT MODE: classify rows into noop / textOnly / full ─────────
    // ctx.editImportMode + ctx.sidecarState are populated by import_translations_v2
    // when DocProvenance.classify(workDoc) returned "imported-with-state".
    // (Distinct from ctx.editMode, which controls emphasis_extractor's
    // target-language-override bypass — different feature, kept separate
    // so they can be combined freely.)
    // Without a sidecar the verdict stays null and the apply loop runs as
    // before (every row → full path).
    var DiffClassify = null;
    var __editVerdict = null;
    var __locResultByTid = {};
    for (var __lpi = 0; __lpi < locatePlan.length; __lpi++) {
        var __lp = locatePlan[__lpi];
        if (__lp && __lp.seg && __lp.seg.tid) __locResultByTid[__lp.seg.tid] = __lp;
    }

    // Pulls the LIVE applied paragraph style's properties off the DOM
    // (appliedParagraphStyle.fontSize / leading / ...) for fingerprinting.
    // Used both at classify-time (compare against sidecar.cluster_fingerprint)
    // and at label-write-time (store the new fingerprint). Same field set on
    // both sides so the hash round-trips.
    function _readLiveStyleProps(para) {
        if (!para) return null;
        var ps = null;
        try { ps = para.appliedParagraphStyle; } catch (e) {}
        if (!ps) return null;
        var props = {};
        try { props.fontFamily = (ps.appliedFont && (ps.appliedFont.fontFamily || ps.appliedFont.name)) || ps.appliedFont || ""; } catch (e) { props.fontFamily = ""; }
        if (typeof props.fontFamily === "object") {
            try { props.fontFamily = String(props.fontFamily.fontFamily || props.fontFamily.name || ""); } catch (e2) { props.fontFamily = ""; }
        }
        try { props.fontStyle = ps.fontStyle; } catch (e) {}
        try { props.pointSize = ps.pointSize; } catch (e) {}
        try {
            var fc = ps.fillColor;
            props.fillColor = fc && (fc.name || fc.colorValue && JSON.stringify(fc.colorValue)) || "";
        } catch (e) {}
        try { props.leading = ps.leading; } catch (e) {}
        try { props.justification = ps.justification; } catch (e) {}
        try { props.spaceBefore = ps.spaceBefore; } catch (e) {}
        try { props.spaceAfter = ps.spaceAfter; } catch (e) {}
        try { props.leftIndent = ps.leftIndent; } catch (e) {}
        try { props.rightIndent = ps.rightIndent; } catch (e) {}
        try { props.firstLineIndent = ps.firstLineIndent; } catch (e) {}
        return props;
    }

    // Legacy promotion: when ctx.editImportMode is set but no real sidecar
    // (because source doc is `imported-legacy` — has _T_p_* clusters from a
    // pre-label-write era), synthesize a sidecar from the work doc's current
    // state. This is the workflow protector: every existing translated doc
    // on operator machines is in this state after deploying the new code.
    // Without promotion they'd get full-pipeline → duplicate cluster pool
    // → paragraphs reassigned → fonts may not match new clusters' Latin
    // pool → CJK chars render as tofu / headings disappear.
    if (ctx.editImportMode && !ctx.sidecarState && ctx.legacyPromotion) {
        try {
            DiffClassify = require("./import_diff_classify.js");
            var __syntheticSidecar = { schema: 1, segments: {} };
            var __synthCount = 0;
            for (var __lpsi = 0; __lpsi < locatePlan.length; __lpsi++) {
                var __slp = locatePlan[__lpsi];
                if (!__slp || !__slp.para || !__slp.seg || !__slp.seg.tid) continue;
                var __curText = "";
                try {
                    __curText = String(__slp.para.contents || "")
                        .replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                    while (__curText.length > 0
                           && __curText.charCodeAt(__curText.length - 1) === 10) {
                        __curText = __curText.substring(0, __curText.length - 1);
                    }
                } catch (eCT) {}
                var __synthPsName = null;
                try { __synthPsName = String(__slp.para.appliedParagraphStyle.name); } catch (eSpn) {}
                var __synthProps = _readLiveStyleProps(__slp.para);
                var __synthFp = __synthProps ? DiffClassify.computeLiveStyleFingerprint(__synthProps) : null;
                __syntheticSidecar.segments[__slp.seg.tid] = {
                    applied_hash: DiffClassify.computeAppliedHash(__curText, []),
                    applied_paragraph_style: __synthPsName,
                    applied_target_text_len: __curText.length,
                    cluster_fingerprint: __synthFp,
                    applied_emphasis_run_count: 0   // history unknown — empty
                };
                __synthCount++;
            }
            ctx.sidecarState = __syntheticSidecar;
            report.edit_mode_legacy_promoted = {
                synthesized_segments: __synthCount,
                source: "live_paragraph_inspection"
            };
            if (__plog) {
                try { __plog("legacy promotion: synthesized sidecar from " + __synthCount + " located paragraphs"); } catch (e) {}
            }
            __mark("legacy_promotion_done");
        } catch (eLP) {
            report.errors.push("legacy promotion failed: " + (eLP && eLP.message ? eLP.message : eLP));
        }
    }

    if (ctx.editImportMode && ctx.sidecarState) {
        try {
            DiffClassify = DiffClassify || require("./import_diff_classify.js");
            __editVerdict = DiffClassify.classify({
                translations: translations.rows,
                sidecarState: ctx.sidecarState,
                liveLookupByTid: function (tid) {
                    var lr = __locResultByTid[tid];
                    if (!lr || !lr.para) return null;
                    var psName = null;
                    try { psName = String(lr.para.appliedParagraphStyle.name); } catch (e) {}
                    if (!psName) return null;
                    var liveProps = _readLiveStyleProps(lr.para);
                    var liveFp = liveProps ? DiffClassify.computeLiveStyleFingerprint(liveProps) : null;
                    return { paragraph_style_name: psName, live_fingerprint: liveFp };
                }
            });
            report.edit_mode = {
                enabled: true,
                noop: __editVerdict.stats.noop,
                textOnly: __editVerdict.stats.textOnly,
                full: __editVerdict.stats.full,
                skipped: __editVerdict.stats.skipped,
                ps_name_mismatch: __editVerdict.stats.psNameMismatch,
                live_lookup_failed: __editVerdict.stats.liveLookupFailed,
                fingerprint_changed: __editVerdict.stats.fingerprintChanged,
                missing_prev: __editVerdict.stats.missingPrev
            };
            if (__plog) {
                // #62 C-2: `full` is a MISLEADING headline on its own. A row whose
                // paragraph could not be located is counted as `full`
                // (import_diff_classify.js:281-288, reason "live lookup failed"),
                // so "full=109" reads like "109 rows will be fully applied" when it
                // actually means "109 rows could not be proven unchanged — and ~51
                // of them have no paragraph to write to at all". `skipped` makes a
                // reader suspicious; `full` makes them relaxed, which is exactly
                // backwards. The breakdown was already on the verdict — print it.
                try { __plog("edit-mode classify: noop=" + __editVerdict.stats.noop
                    + " textOnly=" + __editVerdict.stats.textOnly
                    + " full=" + __editVerdict.stats.full
                    + " skipped=" + __editVerdict.stats.skipped
                    + " | liveLookupFailed=" + __editVerdict.stats.liveLookupFailed
                    + " psNameMismatch=" + __editVerdict.stats.psNameMismatch
                    + " fingerprintChanged=" + __editVerdict.stats.fingerprintChanged
                    + " missingPrev=" + __editVerdict.stats.missingPrev
                    + " priorNotApplied=" + (__editVerdict.stats.priorNotApplied || 0)); } catch (eP) {}
                // Per-tid reasons (#64: "skipped=N with no identity and no reason").
                // Grouped so a 110-row package costs a handful of lines, not 110.
                try {
                    var __rTally = {};
                    var __pk = Object.keys(__editVerdict.perTid || {});
                    for (var __ri = 0; __ri < __pk.length; __ri++) {
                        var __pe = __editVerdict.perTid[__pk[__ri]];
                        var __rkey = (__pe.bucket || "?") + " / " + (__pe.reason || "-");
                        (__rTally[__rkey] = __rTally[__rkey] || []).push(__pk[__ri]);
                    }
                    var __rks = Object.keys(__rTally).sort();
                    var __rl = [];
                    for (var __rj = 0; __rj < __rks.length; __rj++) {
                        var __lst = __rTally[__rks[__rj]];
                        // Name the rows for the buckets an operator has to act on;
                        // "noop / hash match" is the healthy majority — count only.
                        var __nameThem = (__rks[__rj].indexOf("noop /") !== 0);
                        __rl.push("  classify: " + __lst.length + " x [" + __rks[__rj] + "]"
                            + (__nameThem ? "  tids=" + __lst.join(",") : ""));
                    }
                    // One write for the block (see the locate block above for why).
                    if (__rl.length) __plog(__rl.join("\n"));
                } catch (eRT) {}
            }
            __mark("edit_classify_done");
        } catch (eEC) {
            report.errors.push("edit-mode classify failed: " + (eEC && eEC.message ? eEC.message : eEC));
            __editVerdict = null;
        }
    }

    for (var i = 0; i < __applyOrder.length; i++) {
        // Per-batch timestamp every 25 paragraphs — surfaces in report so
        // we can see if slowdown is uniform or accumulates (memory / undo).
        if (i > 0 && (i % 25) === 0) {
            var __batchElapsed = Date.now() - __applyLoopStartMs;
            __timings._applyBatches.push({
                up_to_idx: i,
                elapsed_ms: __batchElapsed
            });
            // #REALTIME-LOG: flush batch progress to disk log
            if (__plog) {
                try { __plog("apply: " + i + "/" + __applyOrder.length + " paras (+" + __batchElapsed + "ms in apply loop)"); } catch (eBL) {}
            }
        }
        var lr = __applyOrder[i];
        if (!lr || !lr.translatable) continue;
        var t = lr.seg && lr.seg.tid ? translations.byTid[lr.seg.tid] : null;

        // #E2E-16: skip sub-segment tails (their target merged into head).
        if (lr.seg && __sbSuppress[lr.seg.tid]) {
            applyResults.skippedEmptyTarget++;
            continue;
        }

        // Skip merge_tail rows entirely. For soft-break sub-segments
        // (sb0 = head, sb1+ = tails), all sub-segments resolve to the SAME
        // InDesign paragraph (segment_locator only uses paragraph_index, no
        // soft-break awareness). The head row carries the merged target
        // text; processing tail rows would re-apply cluster style and
        // re-run emphasis runs on a paragraph the head already finalized,
        // potentially restoring stale character ranges or partial source
        // text. Explicitly bypassing tails keeps the single-paragraph
        // write atomic.
        if (t && (t.status || "").toLowerCase() === "merge_tail") {
            applyResults.skippedEmptyTarget++;
            continue;
        }

        // Edit-mode bucket routing:
        //   - noop / skipped → skip entirely (don't even enter applyOnePara,
        //     so applyStyleToUntranslated path doesn't reassign cluster style)
        //   - textOnly → set paraDeps.editTextOnly so applyOnePara bypasses
        //     Step 1 (cluster style assignment); Steps 2+ still run
        //   - default (full / no verdict) → runs as before
        //
        // When the edit-mode commit bypass fired upstream (sheet is the
        // empty stub), force editTextOnly=true for ALL non-skip rows. The
        // sheet has no styles to look up, so cluster reassignment would
        // fail silently anyway — being explicit here makes the behaviour
        // deterministic and prevents accidental restyleUntranslated paths
        // from running against the empty maps.
        paraDeps.editTextOnly = false;
        if (sheet && sheet.__editModeStub) {
            paraDeps.editTextOnly = true;
        }
        if (__editVerdict && lr.seg && lr.seg.tid) {
            var __v = __editVerdict.perTid[lr.seg.tid];
            if (__v) {
                if (__v.bucket === "noop" || __v.bucket === "skipped") {
                    applyResults.editNoop = (applyResults.editNoop || 0) + 1;
                    continue;
                }
                if (__v.bucket === "textOnly") paraDeps.editTextOnly = true;
            }
        }

        try {
            applyOnePara(workDoc, lr, sheet, plan, t, applyResults, paraDeps);
            // #ac-overset-widen pass-2 worklist: record only when pass 1 actually
            // COMPLETED this paragraph (see the eligibility handshake in applyOnePara).
            // An early return there — no paragraph, empty target, or a failed target-text
            // write — means the single-pass code would never have reached the emphasis
            // sites for this row, so pass 2 must not either: it skips the write and would
            // otherwise apply target-offset emphasis onto un-rewritten source text.
            // Recording here (rather than re-deriving later) also keeps pass 2 on this
            // loop's exact routing decisions — soft-break suppression, merge_tail skips,
            // edit-mode buckets — with no second source of truth free to drift.
            // editTextOnly is snapshotted BY VALUE: paraDeps is reused across iterations
            // and would otherwise leak the LAST row's flag onto every entry.
            if (paraDeps.deferEmphasis && applyResults.__deferParaCompleted) {
                __emphasisWorklist.push({
                    lr: lr, t: t, editTextOnly: paraDeps.editTextOnly,
                    carryDirectOverrideRanges: applyResults.__deferCarryRanges || null
                });
            }
        } catch (eA) {
            applyResults.clusterApplyFailures.push({
                tid: lr.seg && lr.seg.tid,
                reason: "applyOnePara_throw: " + eA.message
            });
        }
    }
    __mark("apply_loop_done");
    // arch it-gate diag: target-side emphasis summary. Discriminates the IT-gate
    // failure modes once the build-stamp confirms a fresh module loaded:
    //   gatedAutoNonFaithful=N applied=0  → gate stripped N auto-non-faithful runs
    //   gatedAutoNonFaithful=0  applied>0 → faithful runs LANDED (invisibility ⇒ H3)
    //   gatedAutoNonFaithful=0  applied=0 failed>0 → apply attempted but failed (H3 font)
    if (__plog) {
        try {
            __plog("emphasis target-side: gatedAutoNonFaithful=" + (applyResults.terGatedAutoNonFaithful || 0)
                + " applied=" + (applyResults.targetEmphasisRunsApplied || 0)
                + " failed=" + (applyResults.targetEmphasisRunsFailed || 0)
                + " firstFail=" + ((applyResults.targetEmphasisRunFailures
                    && applyResults.targetEmphasisRunFailures[0]
                    && applyResults.targetEmphasisRunFailures[0].reason) || "—"));
        } catch (eDiag) {}
    }
    // record final batch tail
    __timings._applyBatches.push({
        up_to_idx: __applyOrder.length,
        elapsed_ms: Date.now() - __applyLoopStartMs
    });

    // #E2E-13: post-apply orphan cleanup. preclean's split promotes
    // soft-breaks (``) to paragraph marks (`\r`) when adjacent
    // formats differ — creating extra paragraphs in stories. When an sb
    // sub-segment with `status="merge_tail"` (its content already merged
    // into sb_head's combined target_text) maps to one of those new
    // paragraphs, v2_pipeline skips it; the new paragraph keeps its
    // pre-preclean original content, producing a visible duplicate
    // ("<client copy>" appearing twice on Client-A cover page) and frame
    // overset (subtitle frame now holds two more paragraphs than designed).
    //
    // Cleanup: walk each story that had preclean splits. For each new
    // paragraph at a split-tail index, if the applied paragraph style is
    // NOT a `_T_p_*` cluster style (= no segment wrote/styled it), it's
    // an orphan — remove it (which removes the trailing `\r` too, merging
    // its absence back into the original layout).
    //
    // #BRIDGE-10: tighten the criterion. The original rule "remove
    // any non-`_T_p_*` paragraph at a tail index" was too aggressive:
    //   - applyStyleToUntranslated=false leaves real translated-skipped
    //     paragraphs at their original (non-_T_p_*) style;
    //   - partial-translation runs leave un-merged sb head paragraphs
    //     at original style;
    //   - any segment whose locate or apply failed leaves its target
    //     paragraph at original style.
    // Limit removal to (story, headParaIdx) pairs where we ACTUALLY
    // merged sb sub-segments AND wrote the merged target onto the
    // head — otherwise the "tail" might be designed content the
    // operator wants to keep.
    if (ctx.splitDeltasByStoryId) {
        var orphansRemoved = 0;
        var orphanDetail = [];
        var orphanFailures = [];
        var storiesArr = workDoc.stories;
        for (var ssi = 0; ssi < storiesArr.length; ssi++) {
            var oStory = null;
            try { oStory = storiesArr.item(ssi); } catch (eOS) { continue; }
            if (!oStory) continue;
            var oSid = ""; try { oSid = String(oStory.id); } catch (eOSid) {}
            if (!oSid) continue;
            var oDeltas = ctx.splitDeltasByStoryId[oSid];
            if (!oDeltas || !oDeltas.length) continue;

            // Aggregate by paraIdx (mirror the shift algorithm).
            var oByPara = {};
            for (var odi = 0; odi < oDeltas.length; odi++) {
                var od = oDeltas[odi];
                if (!od || typeof od.paraIdx !== "number") continue;
                oByPara[od.paraIdx] = (oByPara[od.paraIdx] || 0) + (od.tailCount || 1);
            }
            var oParaIdxs = Object.keys(oByPara).map(Number).sort(function (a, b) { return a - b; });

            // Compute post-shift tail paragraph indices = preclean-created
            // paragraphs. For each delta {paraIdx, tailCount}: the head sits
            // at paraIdx + cumulativeShift, tail paragraphs at
            // [head+1 ... head+tailCount].
            // #BRIDGE-10: emit tail indices ONLY for split heads that we
            // actually merged sb sub-segments onto. Keep the (story_id,
            // origIdx) pair so the lookup matches the source-side
            // paragraph_index that __sbMergedHeads was keyed on.
            var tailIdxList = [];
            var cumulShift = 0;
            for (var oki = 0; oki < oParaIdxs.length; oki++) {
                var origIdx = oParaIdxs[oki];
                var tailCnt = oByPara[origIdx];
                var __headKey = oSid + ":" + String(origIdx);
                var __headMerged = !!__sbMergedHeads[__headKey];
                if (__headMerged) {
                    for (var t = 1; t <= tailCnt; t++) {
                        tailIdxList.push(origIdx + cumulShift + t);
                    }
                }
                cumulShift += tailCnt;
            }
            // Descending removal order so each .remove() doesn't shift the
            // indices of the remaining candidates.
            tailIdxList.sort(function (a, b) { return b - a; });

            for (var tli = 0; tli < tailIdxList.length; tli++) {
                var orpIdx = tailIdxList[tli];
                try {
                    if (orpIdx >= oStory.paragraphs.length) continue;
                    var orpPara = oStory.paragraphs.item(orpIdx);
                    var orpPsName = "";
                    try { orpPsName = String(orpPara.appliedParagraphStyle.name); } catch (eN) {}
                    // Heuristic: untouched paragraph still carries the
                    // original designer paragraph style (anything not
                    // starting with `_T_p_`). Pipeline-created cluster
                    // styles always start with `_T_p_`. The
                    // __sbMergedHeads gate above already restricts the
                    // candidate set to split tails whose head we merged,
                    // so this check is now a belt-and-braces sanity
                    // filter rather than the primary criterion.
                    if (orpPsName.indexOf("_T_p_") !== 0) {
                        var orpContent = "";
                        try { orpContent = String(orpPara.contents).slice(0, 60); } catch (eC) {}
                        orpPara.remove();
                        orphansRemoved++;
                        orphanDetail.push({
                            story: ssi, paraIdx: orpIdx,
                            content: orpContent, originalStyle: orpPsName
                        });
                    }
                } catch (eOR) {
                    orphanFailures.push({
                        story: ssi, paraIdx: orpIdx,
                        error: (eOR && eOR.message) ? eOR.message : String(eOR)
                    });
                }
            }
        }
        report.preclean_orphans_removed = orphansRemoved;
        if (orphanDetail.length) report.preclean_orphans_detail = orphanDetail;
        if (orphanFailures.length) report.preclean_orphan_failures = orphanFailures;
    }

    // #BRIDGE-26: Underline / paragraph-rule overlap dedup. Same pass
    // reorganize_styles_inplace.idjs runs (UnderlineRuleDedup.apply...);
    // ports it to v2_pipeline so import-side flows that don't go through
    // the reorganize entry still get the dedup. Designer Hyperlink CS
    // re-applied to translated paragraphs carries underline=true; the
    // cluster paragraph style may also carry ruleAbove (a thin line at
    // the baseline used AS the link's underline). With both rendered,
    // visual shows two stacked lines. Dedup mode "suppress-underline"
    // matches the typical designer intent (keep rule, clear char-level
    // underline). Toggle via ctx.underlineOverlapMode; default suppress.
    try {
        var __dedupMode = (ctx && ctx.underlineOverlapMode) || "suppress-underline";
        var URD = null;
        try { URD = require("./underline_rule_dedup.js"); } catch (eURr) {}
        if (URD && URD.applyUnderlineRuleDedup) {
            var __dedupParas = [];
            try {
                var __stories2 = workDoc.stories;
                for (var __si2 = 0; __si2 < __stories2.length; __si2++) {
                    var __st2 = null;
                    try { __st2 = __stories2.item(__si2); } catch (e__) {}
                    if (!__st2) continue;
                    try {
                        var __pars = __st2.paragraphs;
                        for (var __pj = 0; __pj < __pars.length; __pj++) {
                            try { __dedupParas.push(__pars.item(__pj)); } catch (e__P) {}
                        }
                    } catch (e__S) {}
                }
            } catch (e__W) {}
            var __dedupStats = URD.applyUnderlineRuleDedup(__dedupParas, __dedupMode, null);
            applyResults.underlineDedupMode                = __dedupStats.mode;
            applyResults.underlineDedupParagraphsAffected  = __dedupStats.paragraphsAffected;
            applyResults.underlineDedupRangesAffected      = __dedupStats.rangesAffected;
            applyResults.underlineDedupParagraphsCleared   = __dedupStats.paragraphsCleared;
            applyResults.underlineDedupSkippedNoRule       = __dedupStats.skippedNoRule;
            applyResults.underlineDedupSkippedNoUnderline  = __dedupStats.skippedNoUnderline;
            applyResults.underlineDedupErrors              = __dedupStats.errors;
        }
    } catch (eUD) {
        applyResults.clusterApplyFailures.push({
            tid: "<global-underline-dedup>",
            reason: "underline_rule_dedup_failed: " + (eUD && eUD.message ? eUD.message : eUD)
        });
    }

    __mark("bridge35_start");
    // #BRIDGE-35: doc-wide post-apply italic→skew unification in
    // CJK-containing paragraphs.
    //
    // CJK fonts (Source Han Sans, MHei, MSung, YaHei, SimHei, Yu Gothic,
    // Hiragino...) have no italic variant. When a translated paragraph
    // mixes CJK and Latin and the Latin portion ends up with real
    // fontStyle="Italic" (e.g. inherited from source-side italic span),
    // the Latin chars slant via real italic while surrounding CJK stays
    // upright — visually inconsistent. Worse, any CJK char that ALSO
    // inherits fontStyle=Italic tries to resolve "<CJK family> | Italic"
    // and tofus.
    //
    // Fix: for each paragraph containing ANY CJK character, sweep its
    // textStyleRanges and convert italic-flavored fontStyle to
    // (weight-only fontStyle) + skew=15. Latin chars get faux italic via
    // skew (slight typographic compromise vs. real italic, but matches
    // the CJK slant); CJK chars stop trying to satisfy the missing
    // italic combination. Pure Latin paragraphs are untouched and keep
    // real italic.
    //
    // Two safety adjustments vs. the earlier per-applyOnePara version
    // that hung InDesign:
    //   1. Single doc-wide pass at the end of pipeline (not per-para).
    //   2. Collect all (range, weightOnly) targets FIRST, then mutate
    //      in reverse — avoids in-iteration tsr collection rebucketing
    //      after each fontStyle assignment.
    try {
        // Escapes, not literals: the literal for U+F900 NFD-decomposes to U+8C48, and
        // that is exactly how the sibling classes in emphasis_extractor /
        // script_font_enforcer / script_split silently acquired an over-wide range
        // that swallowed the surrogate block, the PUA and Yi/Vai. Same codepoints as
        // before — this rewrite is behaviour-neutral, it just disarms the trap.
        // NOTE: this class deliberately still differs from those three (no Hangul
        // \uAC00-\uD7AF). That gap is REAL and Korean-affecting — see
        // _HANDOFF_cdfaithful.md — but closing it changes behaviour, so it is a
        // separate decision, not part of a de-literalising pass.
        var __cjkRe = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
        var __ssAll = workDoc.stories;
        var __ssN = 0; try { __ssN = __ssAll.length; } catch (e) {}
        var __italicSkewTargets = [];
        var __italicSkewParaCount = 0;
        var __scanParagraphsItalic = function (paras) {
            var nP = 0; try { nP = paras.length; } catch (e) { return; }
            for (var __spi = 0; __spi < nP; __spi++) {
                var __sp = null;
                try { __sp = paras.item(__spi); } catch (e) { continue; }
                if (!__sp) continue;
                var __spRaw = "";
                try { __spRaw = String(__sp.contents || ""); } catch (e) {}
                if (!__cjkRe.test(__spRaw)) continue;
                var __tsr2 = null;
                try { __tsr2 = __sp.textStyleRanges; } catch (e) { continue; }
                var __nR2 = 0; try { __nR2 = __tsr2.length; } catch (e) {}
                var __paraHadHit = false;
                for (var __ri2 = 0; __ri2 < __nR2; __ri2++) {
                    var __rr = null;
                    try { __rr = __tsr2.item(__ri2); } catch (e) {}
                    if (!__rr) continue;
                    var __ffs = "";
                    try { __ffs = String(__rr.fontStyle || ""); } catch (e) {}
                    if (__ffs.toLowerCase().indexOf("italic") === -1) continue;
                    var __weight = __ffs.replace(/\s*Italic\s*/gi, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
                    // Capture current fontFamily so the mutate pass can
                    // re-stamp appliedFont when the Italic was inherited
                    // from a `_T_Latin_*_Italic` CS (range.fontStyle="Regular"
                    // alone gets reverted to the CS-defined Italic on
                    // recompose; we need to also force appliedFont to the
                    // family-only form so InDesign resolves to the Regular
                    // variant).
                    var __famForRange = "";
                    // object|string-aware family read (CLAUDE.md gate #10:
                    // appliedFont may be a "Family\tStyle" string) so a string
                    // form doesn't read empty → wrongly neutralize a real-italic
                    // Latin run. [audit P3]
                    try { __famForRange = FontItalicProbe.familyOf(__rr.appliedFont); } catch (eFam) {}
                    // fix-faux-latin-italic — THE fix: decide per-RANGE, not
                    // per-paragraph. A Latin font WITH a real italic variant
                    // (e.g. Whitney Book Italic) is left untouched → keeps its
                    // real italic. Only a font with NO italic variant (CJK
                    // MHei/SHS) is neutralized to weight-only + skew=15 (which
                    // also stops a CJK char from tofu-ing on a missing "Italic"
                    // at save — BRIDGE-35's original, still-needed job). The old
                    // code converted EVERY italic range in any CJK-containing
                    // paragraph, downgrading the Latin run too. Probe-fail / empty
                    // family → fall through to neutralize (legacy-safe: leaving a
                    // CJK italic blocks save with a missing-font dialog; over-
                    // skewing an unidentifiable font is the lesser harm).
                    if (__famForRange && FontItalicProbe.probeFontHasItalic(workDoc, __famForRange)) {
                        continue;
                    }
                    __italicSkewTargets.push({ range: __rr, weight: __weight, family: __famForRange });
                    __paraHadHit = true;
                }
                if (__paraHadHit) __italicSkewParaCount++;
            }
        };
        for (var __isi = 0; __isi < __ssN; __isi++) {
            var __sst = null;
            try { __sst = __ssAll.item(__isi); } catch (e) {}
            if (!__sst) continue;
            // Story-level paragraphs (regular text frames)
            try { __scanParagraphsItalic(__sst.paragraphs); } catch (eSP) {}
            // #BRIDGE-35b: table cells too — they live in
            // story.tables[].cells[].paragraphs, NOT in story.paragraphs.
            // Missing them leaves italic fontStyle on CJK cell text (e.g.
            // "Solid guarantees" table c5 "（以股息形式支付）" → Dax Pro
            // Italic on CJK → InDesign requests SHS Italic at save →
            // Missing Fonts dialog blocks save).
            var __tbls = null;
            try { __tbls = __sst.tables; } catch (eT) {}
            var __nT = 0; try { __nT = __tbls.length; } catch (eTN) {}
            for (var __ti = 0; __ti < __nT; __ti++) {
                var __tbl = null;
                try { __tbl = __tbls.item(__ti); } catch (eTI) {}
                if (!__tbl) continue;
                var __cellsColl = null;
                try { __cellsColl = __tbl.cells; } catch (eC) {}
                var __nC = 0; try { __nC = __cellsColl.length; } catch (eCN) {}
                for (var __cti = 0; __cti < __nC; __cti++) {
                    var __cell = null;
                    try { __cell = __cellsColl.item(__cti); } catch (eCI) {}
                    if (!__cell) continue;
                    try { __scanParagraphsItalic(__cell.paragraphs); } catch (eCP) {}
                }
            }
        }
        // Mutate in reverse — keeps earlier collected refs valid even if
        // the layout engine rebuckets tsr after fontStyle assignment.
        var __italicSkewRangeCount = 0;
        for (var __mi = __italicSkewTargets.length - 1; __mi >= 0; __mi--) {
            var __mt = __italicSkewTargets[__mi];
            var __targetStyle = (__mt.weight && __mt.weight.toLowerCase() !== "regular") ? __mt.weight : "Regular";
            // Order matters:
            //   1. Force appliedFont = <family-only string>. When the range
            //      inherits Italic from a `_T_Latin_*_Italic` char style,
            //      writing only `fontStyle = Regular` is silently reverted
            //      by the CS on the next recompose. Reassigning appliedFont
            //      via the family string clears the CS-inherited font-style
            //      half and lets the explicit fontStyle below stick.
            //   2. Stamp fontStyle (weight without Italic).
            //   3. Stamp skew = 15 for the visual slant.
            if (__mt.family) {
                try { __mt.range.appliedFont = __mt.family; } catch (eAF) {}
            }
            try { __mt.range.fontStyle = __targetStyle; } catch (eFS) {}
            try { __mt.range.skew = 15; } catch (eSk) {}
            __italicSkewRangeCount++;
        }
        applyResults.italicSkewFallback = __italicSkewRangeCount;
        applyResults.italicSkewParagraphs = __italicSkewParaCount;

        // #BRIDGE-35c (REVERTED — DISABLED): see policy note below.
        //
        // Previous behavior auto-applied skew=15 to ENTIRE translated
        // paragraph when source had italic anywhere but translation
        // didn't preserve it. Per user policy: when translator hasn't
        // manually annotated, don't auto-extend source formatting. Skip.
        if (false) {
        // #BRIDGE-35c: source-italic backfill for paragraphs that lost
        // italic intent during translation.
        //
        // When the source paragraph had italic spans (full or partial) but
        // the translated paragraph carries no italic fontStyle anywhere
        // (because the emphasis-run position mapping failed during apply —
        // happens when source/target length ratio shifts char positions
        // outside the captured emp run boundaries), the previous pass
        // sees no italic to convert → italic intent is silently dropped.
        //
        // Detected in Client-A Whole Life: table 2207 c4
        // "（按绩效奖金支付 绩效奖金）" + story 536 p39/p41/p55/p56 all
        // had italic source ranges but ended up upright after translation,
        // while their c5 / sibling counterparts kept italic-as-skew.
        //
        // Walk segments[]; for any seg whose format_snapshot indicates
        // italic intent (baseline.fontStyle="Italic" OR any emphasisRun
        // with diff.fontStyle="Italic"), find the located paragraph and
        // if it has zero italic+skew across its current ranges, apply
        // skew=15 to the visible chars (excluding trailing \r). The whole
        // paragraph slants — matches the most common designer intent for
        // short table cells / single-sentence footnotes. Over-application
        // on long paragraphs with mixed italic/regular is acceptable
        // because emp pipeline would have caught those normally; we only
        // hit this branch when emp mapping failed entirely.
        var __italicBackfillCount = 0;
        try {
            for (var __bi = 0; __bi < locatePlan.length; __bi++) {
                var __blr = locatePlan[__bi];
                if (!__blr || !__blr.para || !__blr.seg) continue;
                var __bSeg = __blr.seg;
                if (!__bSeg.format_snapshot) continue;
                var __bFs = __bSeg.format_snapshot;
                // Detect source italic intent via ANY available source-side
                // format signal. The export's `baseline.fontStyle` mis-captures
                // italic for paragraphs whose effective baseline differs from
                // the rendered visual (observed on Client-A Product-2 Sources
                // list p38/p39/p40/p42 — designer made entire footnote section
                // italic via per-char overrides, but baseline computation
                // resolved to Regular). Fall through to `runs[]` (visual
                // snapshot's diff-from-baseline ranges), `emphasisRuns[]`
                // (emphasis_extractor's processed runs), and `_allRanges[]`
                // (raw textStyleRange dump) so we don't miss italic captured
                // in any of these alternative locations.
                var __srcHadItalic = false;
                try {
                    var __bBl = __bFs.baseline;
                    if (__bBl && __bBl.fontStyle && String(__bBl.fontStyle).toLowerCase().indexOf("italic") !== -1) {
                        __srcHadItalic = true;
                    }
                } catch (e) {}
                if (!__srcHadItalic && __bFs.emphasisRuns && __bFs.emphasisRuns.length) {
                    for (var __ei = 0; __ei < __bFs.emphasisRuns.length; __ei++) {
                        var __er = __bFs.emphasisRuns[__ei];
                        if (__er && __er.diff && __er.diff.fontStyle &&
                            String(__er.diff.fontStyle).toLowerCase().indexOf("italic") !== -1) {
                            __srcHadItalic = true; break;
                        }
                    }
                }
                if (!__srcHadItalic && __bFs.runs && __bFs.runs.length) {
                    for (var __ri3 = 0; __ri3 < __bFs.runs.length; __ri3++) {
                        var __run = __bFs.runs[__ri3];
                        if (__run && __run.fontStyle &&
                            String(__run.fontStyle).toLowerCase().indexOf("italic") !== -1) {
                            __srcHadItalic = true; break;
                        }
                    }
                }
                if (!__srcHadItalic && __bFs._allRanges && __bFs._allRanges.length) {
                    for (var __ari = 0; __ari < __bFs._allRanges.length; __ari++) {
                        var __ar = __bFs._allRanges[__ari];
                        var __arFs = (__ar && __ar.props && __ar.props.fontStyle) || (__ar && __ar.fontStyle) || "";
                        if (String(__arFs).toLowerCase().indexOf("italic") !== -1) {
                            __srcHadItalic = true; break;
                        }
                    }
                }
                if (!__srcHadItalic) continue;
                // Check current translated paragraph for italic / skew
                var __bp = __blr.para;
                var __bpRaw = "";
                try { __bpRaw = String(__bp.contents || ""); } catch (e) {}
                if (!__cjkRe.test(__bpRaw)) continue;
                var __bRanges = null;
                try { __bRanges = __bp.textStyleRanges; } catch (e) { continue; }
                var __bnR = 0; try { __bnR = __bRanges.length; } catch (e) {}
                var __already = false;
                for (var __bri = 0; __bri < __bnR; __bri++) {
                    var __brr = null;
                    try { __brr = __bRanges.item(__bri); } catch (e) {}
                    if (!__brr) continue;
                    var __bfs = "";
                    try { __bfs = String(__brr.fontStyle || ""); } catch (e) {}
                    if (__bfs.toLowerCase().indexOf("italic") !== -1) { __already = true; break; }
                    var __bsk = 0;
                    try { __bsk = Number(__brr.skew); } catch (e) {}
                    if (Math.abs(__bsk) > 0.1) { __already = true; break; }
                }
                if (__already) continue;
                // Apply skew=15 to visible chars (exclude trailing \r)
                try {
                    var __bn = __bp.characters.length;
                    var __bEnd = (__bpRaw.length > 0 && __bpRaw.charCodeAt(__bpRaw.length - 1) === 13)
                        ? __bn - 2
                        : __bn - 1;
                    if (__bEnd >= 0) {
                        __bp.characters.itemByRange(0, __bEnd).skew = 15;
                        __italicBackfillCount++;
                    }
                } catch (eApp) {}
            }
        } catch (eBF) {}
        applyResults.italicSkewBackfilled = __italicBackfillCount;
        } // end if (false) — BRIDGE-35c disabled per policy update
    } catch (eIS) {
        applyResults.clusterApplyFailures.push({
            tid: "<global-italic-skew>",
            reason: "italic_skew_unify_failed: " + (eIS && eIS.message ? eIS.message : eIS)
        });
    }

    __mark("bridge39_start");
    // #BRIDGE-39: strip Hyperlink CS + char-level underline from translated
    // paragraphs whose source had hyperlinks but translator didn't manually
    // annotate target_links.
    //
    // Root cause: _writeParaPreserveMark replaces text via
    // `range.contents = newText`. InDesign preserves the existing
    // textStyleRanges by char position, so if source chars 0..34 carried
    // CS "Hyperlink" (underline=true), the first 34 chars of the translated
    // text inherit that CS — producing char-level underline on Latin/digit
    // glyphs (CJK glyphs hide underline due to font baseline differences),
    // and CS-coverage that no longer matches any semantic link range.
    //
    // Policy: 翻译器未手动设置 → 不传递任何源格式 (含 AI auto 标注也不应用).
    // When translator omitted target_links, treat the inherited Hyperlink
    // CS as source-format-bleed and strip it. Differs from old BRIDGE-38
    // by NOT applying any replacement styling (no uniform blue, no rule):
    // the paragraph ends up plain — matching translator intent.
    try {
        var __b39NoneCs = null;
        try { __b39NoneCs = workDoc.characterStyles.itemByName("[None]"); } catch (eN39) {}
        var __b39StripCount = 0;
        for (var __b39i = 0; __b39i < locatePlan.length; __b39i++) {
            var __b39lr = locatePlan[__b39i];
            if (!__b39lr || !__b39lr.para || !__b39lr.seg) continue;
            var __b39Seg = __b39lr.seg;
            if (!__b39Seg.source_links || !__b39Seg.source_links.length) continue;
            var __b39Tr = translations.byTid[__b39Seg.tid];
            // Reorganize-only (no translation): leave source styling intact.
            if (!__b39Tr || __b39Tr.target_text === undefined || __b39Tr.target_text === null || String(__b39Tr.target_text).length === 0) continue;
            // Collect translator-supplied underline ranges (link OR
            // explicit underline action). For chars inside these ranges
            // we preserve underline=true (translator intent); for chars
            // OUTSIDE we still reset because the underline came from
            // source CS=Hyperlink bleed, not the translator. CS named
            // "Hyperlink" is always stripped regardless — translator
            // links create `_T_c_link`, never reuse the source CS name.
            var __b39UlRanges = [];
            if (__b39Tr.annotations && __b39Tr.annotations.length) {
                for (var __b39ai = 0; __b39ai < __b39Tr.annotations.length; __b39ai++) {
                    var __b39a = __b39Tr.annotations[__b39ai];
                    // Cross-repo policy: only translator-confirmed underline/
                    // link annotations protect a range from the Hyperlink-CS /
                    // underline strip. An AI/heuristic (_auto) annotation must
                    // NOT preserve source underline bleed — that would re-
                    // propagate un-confirmed source format. See auto_format_gate.js.
                    if (__b39a && !AutoFormatGate.isAutoAnnotation(__b39a)
                        && __b39a.type === "format"
                        && (__b39a.action === "underline" || __b39a.action === "link")
                        && typeof __b39a.offset === "number" && typeof __b39a.length === "number") {
                        __b39UlRanges.push({ start: __b39a.offset, end: __b39a.offset + __b39a.length });
                    }
                }
            }

            var __b39para = __b39lr.para;
            try { __b39para = _refreshParaWrapper(__b39para); } catch (eRP39) {}

            try {
                var __b39paraStart = -1;
                try { __b39paraStart = __b39para.characters.item(0).index; } catch (eS0) {}

                var __b39rng = __b39para.textStyleRanges;
                var __b39nR = 0; try { __b39nR = __b39rng.length; } catch (e) {}
                var __b39Resets = [];
                for (var __b39ri = 0; __b39ri < __b39nR; __b39ri++) {
                    var __b39rr = null;
                    try { __b39rr = __b39rng.item(__b39ri); } catch (e) {}
                    if (!__b39rr) continue;
                    var __b39csN = "";
                    try { __b39csN = (__b39rr.appliedCharacterStyle && __b39rr.appliedCharacterStyle.name) || ""; } catch (e) {}
                    var __b39UL = false;
                    try { __b39UL = !!__b39rr.underline; } catch (e) {}
                    if (__b39csN !== "Hyperlink" && !__b39UL) continue;

                    // Resolve paragraph-relative offsets for overlap test
                    // with translator-supplied underline ranges.
                    var __b39rOff = -1;
                    try { __b39rOff = __b39rr.characters.item(0).index - __b39paraStart; } catch (eOf) {}
                    var __b39rLen = 0;
                    try { __b39rLen = __b39rr.characters.length; } catch (eLn) {}
                    var __b39rEnd = __b39rOff + __b39rLen;

                    // Check if range overlaps any translator underline range.
                    var __b39preserveUL = false;
                    if (__b39UL && __b39UlRanges.length) {
                        for (var __b39ui = 0; __b39ui < __b39UlRanges.length; __b39ui++) {
                            var __b39ur = __b39UlRanges[__b39ui];
                            if (!(__b39rEnd <= __b39ur.start || __b39rOff >= __b39ur.end)) {
                                __b39preserveUL = true; break;
                            }
                        }
                    }
                    __b39Resets.push({ ref: __b39rr, preserveUL: __b39preserveUL });
                }
                // Reverse order: tsr mutation can rebucket forward ranges.
                for (var __b39ti = __b39Resets.length - 1; __b39ti >= 0; __b39ti--) {
                    var __b39td = __b39Resets[__b39ti];
                    var __b39t = __b39td.ref;
                    if (__b39NoneCs) {
                        try {
                            var __b39tcs = "";
                            try { __b39tcs = (__b39t.appliedCharacterStyle && __b39t.appliedCharacterStyle.name) || ""; } catch (e) {}
                            if (__b39tcs === "Hyperlink") __b39t.appliedCharacterStyle = __b39NoneCs;
                        } catch (e) {}
                    }
                    if (!__b39td.preserveUL) {
                        try { __b39t.underline = false; } catch (e) {}
                    }
                    __b39StripCount++;
                }
            } catch (eStrip) {}
        }
        applyResults.hyperlinkCsStripped = __b39StripCount;
    } catch (eB39) {
        applyResults.clusterApplyFailures.push({
            tid: "<global-bridge-39>",
            reason: "hyperlink_cs_strip_failed: " + (eB39 && eB39.message ? eB39.message : eB39)
        });
    }

    __mark("bridge41_start");
    // #BRIDGE-41: final-pass re-stamp of annotation format properties
    // (fillColor / underline / skew / fontStyle) after BRIDGE-39 and any
    // other post-apply mutations have settled. Per-annotation apply in
    // applyAnnotationsToParagraph happens BEFORE these doc-wide passes,
    // and some property writes don't survive subsequent CS swaps / wrapper
    // refreshes — observed on the Client-A Product-2 "S&P 500" segment where
    // fillColor stamped during Step 3 reverted to Black by save time even
    // though the report claimed applied=true. Re-stamping here is the
    // belt-and-braces guarantee.
    _restampAnnotationFormats(workDoc, locatePlan, translations, applyResults, deps);

    // #BRIDGE-42 (MOVED OUT 2026-05-26): underline → paragraph ruleBelow
    // upgrade was previously here. Per user direction, removed from the
    // import pipeline so underline stays as a normal char-level fingerprint
    // through the round-trip. Operators who want the Client-A-style continuous
    // rule visual run the standalone script `convert_underline_to_rule.idjs`
    // against the saved .translated.indd as a post-step.

    // #BRIDGE-38 (REVERTED — DISABLED): see policy note at end of this block.
    //
    // Previous behavior automatically applied uniform link styling (entire
    // translated paragraph blue + ruleBelow) when source had hyperlinks
    // and translator didn't provide target_links. Per user policy update:
    // when translator hasn't manually annotated, don't auto-extend any
    // source formatting (including link styling). Skip this entire pass.
    if (false) {
    // #BRIDGE-38 (original logic, kept for reference if policy reverts):
    // uniform link styling for source-link paragraphs whose
    // translation didn't provide target_links.
    //
    // When source paragraph has hyperlinks but translations.json omits
    // target_links, the blind offset+length remap from source → target
    // produces wrong char ranges (link covers wrong portion — e.g. source
    // "Government of Canada 10-year bonds" link [0..34] of 71-char source
    // remaps to first 34 chars of the 35-char Chinese paragraph, leaking
    // into the non-link "2026 年 2 月 6 日，加拿大央行" portion). Worse,
    // the cluster pipeline strips the source's direct PANTONE 300 C color
    // override, leaving link chars rendered as plain Black with only the
    // Hyperlink CS providing underline=true.
    //
    // Design intent (per Client-A Product-2 Sources list): when translator
    // didn't differentiate link/non-link regions, apply UNIFORM link
    // styling to the entire translated paragraph — paragraph-level
    // ruleBelow (text-width) + paragraph-level link color across all
    // chars. Char-level Hyperlink CS + underline get stripped to avoid
    // double-rendering and partial-coverage artifacts.
    //
    // Honors translator-provided target_links: when present, the
    // translator (UI) has marked specific char ranges as links, so we
    // skip uniform styling and trust the translator's annotation.
    try {
        var __linkColor = null;
        try {
            var __pc = workDoc.swatches.itemByName("PANTONE 300 C");
            if (__pc && __pc.isValid) __linkColor = __pc;
        } catch (eLC) {}
        var __linkNoneCs = null;
        try { __linkNoneCs = workDoc.characterStyles.itemByName("[None]"); } catch (eLNc) {}
        var __linkRuleWidthEnum = null;
        try {
            var __idsn = require("indesign");
            __linkRuleWidthEnum = __idsn && __idsn.RuleWidth;
        } catch (eRW) {}

        var __linkUniformCount = 0;
        for (var __lui = 0; __lui < locatePlan.length; __lui++) {
            var __lulr = locatePlan[__lui];
            if (!__lulr || !__lulr.para || !__lulr.seg) continue;
            var __luSeg = __lulr.seg;
            if (!__luSeg.source_links || !__luSeg.source_links.length) continue;
            // Skip when translator annotated target_links explicitly.
            var __luTr = translations.byTid[__luSeg.tid];
            if (__luTr && __luTr.target_links && __luTr.target_links.length) continue;

            var __lup = __lulr.para;
            var __lupRaw = "";
            try { __lupRaw = String(__lup.contents || ""); } catch (e) {}
            var __lupN = 0;
            try { __lupN = __lup.characters.length; } catch (e) {}
            var __lupEnd = (__lupRaw.length > 0 && __lupRaw.charCodeAt(__lupRaw.length - 1) === 13)
                ? __lupN - 2
                : __lupN - 1;
            if (__lupEnd < 0) continue;

            // Step 1: strip residual Hyperlink CS + char-level underline.
            // Collect before mutating to avoid tsr collection invalidation.
            try {
                var __lurng = __lup.textStyleRanges;
                var __lunR = 0; try { __lunR = __lurng.length; } catch (e) {}
                var __luResets = [];
                for (var __luri = 0; __luri < __lunR; __luri++) {
                    var __lurr = null;
                    try { __lurr = __lurng.item(__luri); } catch (e) {}
                    if (!__lurr) continue;
                    var __lucsN = "";
                    try { __lucsN = (__lurr.appliedCharacterStyle && __lurr.appliedCharacterStyle.name) || ""; } catch (e) {}
                    var __luUL = false;
                    try { __luUL = !!__lurr.underline; } catch (e) {}
                    if (__lucsN === "Hyperlink" || __luUL) __luResets.push(__lurr);
                }
                for (var __luti = __luResets.length - 1; __luti >= 0; __luti--) {
                    var __lut = __luResets[__luti];
                    if (__linkNoneCs) {
                        try {
                            var __lutcs = "";
                            try { __lutcs = (__lut.appliedCharacterStyle && __lut.appliedCharacterStyle.name) || ""; } catch (e) {}
                            if (__lutcs === "Hyperlink") __lut.appliedCharacterStyle = __linkNoneCs;
                        } catch (e) {}
                    }
                    try { __lut.underline = false; } catch (e) {}
                }
            } catch (eReset) {}

            // Step 2: apply uniform link styling.
            // Refresh the wrapper after Step 1's CS resets in case the
            // textStyleRange rebucketing shifted the Paragraph wrapper
            // bounds (same UXP quirk that BRIDGE-34 handles for the writer).
            try { __lup = _refreshParaWrapper(__lup); } catch (eRP) {}

            // Detect source italic intent for this segment — same multi-
            // signal check BRIDGE-35c uses (baseline.fontStyle is often
            // mis-captured as Regular for italic-only paragraphs whose
            // chars carry the italic via direct overrides; fall through
            // to runs/_allRanges).
            //
            // We re-detect here (rather than rely on BRIDGE-35c having
            // already applied skew) because BRIDGE-38's Step 1 above
            // resets the Hyperlink CS to [None], which clears char-level
            // skew overrides as a side effect of CS reassignment. So
            // even if 35c set skew=15 earlier, Step 1 here wiped it.
            // Re-apply skew=15 AFTER the CS reset to make it stick.
            var __linkSrcItalic = false;
            try {
                var __luFs = __luSeg.format_snapshot;
                if (__luFs) {
                    var __luBl = __luFs.baseline;
                    if (__luBl && __luBl.fontStyle && String(__luBl.fontStyle).toLowerCase().indexOf("italic") !== -1) __linkSrcItalic = true;
                    if (!__linkSrcItalic && __luFs.runs) {
                        for (var __lri3 = 0; __lri3 < __luFs.runs.length; __lri3++) {
                            var __lrn = __luFs.runs[__lri3];
                            if (__lrn && __lrn.fontStyle && String(__lrn.fontStyle).toLowerCase().indexOf("italic") !== -1) { __linkSrcItalic = true; break; }
                        }
                    }
                    if (!__linkSrcItalic && __luFs._allRanges) {
                        for (var __lari = 0; __lari < __luFs._allRanges.length; __lari++) {
                            var __lar = __luFs._allRanges[__lari];
                            var __larFs = (__lar && __lar.props && __lar.props.fontStyle) || (__lar && __lar.fontStyle) || "";
                            if (String(__larFs).toLowerCase().indexOf("italic") !== -1) { __linkSrcItalic = true; break; }
                        }
                    }
                }
            } catch (eIsd) {}

            try {
                // Re-read range bounds since wrapper may have refreshed.
                var __lupN2 = 0;
                try { __lupN2 = __lup.characters.length; } catch (e) {}
                var __lupRaw2 = "";
                try { __lupRaw2 = String(__lup.contents || ""); } catch (e) {}
                var __lupEnd2 = (__lupRaw2.length > 0 && __lupRaw2.charCodeAt(__lupRaw2.length - 1) === 13)
                    ? __lupN2 - 2
                    : __lupN2 - 1;
                if (__lupEnd2 >= 0) {
                    var __lrng2 = null;
                    try { __lrng2 = __lup.characters.itemByRange(0, __lupEnd2); } catch (e) {}
                    if (__lrng2) {
                        if (__linkColor) {
                            try { __lrng2.fillColor = __linkColor; } catch (e) {}
                        }
                        if (__linkSrcItalic) {
                            // univ-italic ② (乙 STRICT): config-gated script-aware
                            // italic (faux@config-angle / real / block / surface;
                            // unconfigured never auto-slants). NOTE: this whole
                            // BRIDGE-38 block is DISABLED (`if (false)` above), so
                            // this is a DORMANT correct-mirror for a future re-enable
                            // — it ships no runtime behavior today. [audit note]
                            try {
                                ItalicApply.applyScriptAwareItalic({
                                    charContainer: __lup.characters,
                                    baseOffset: 0,
                                    endOffset: __lupEnd2,
                                    workDoc: workDoc,
                                    italicConfig: (deps && deps.italicConfig) || null
                                });
                            } catch (e) {}
                        }
                    }
                }
                try { __lup.ruleBelow = true; } catch (e) {}
                if (__linkColor) {
                    try { __lup.ruleBelowColor = __linkColor; } catch (e) {}
                }
                try { __lup.ruleBelowWeight = 0.5; } catch (e) {}
                if (__linkRuleWidthEnum && __linkRuleWidthEnum.TEXT_WIDTH) {
                    try { __lup.ruleBelowWidth = __linkRuleWidthEnum.TEXT_WIDTH; } catch (e) {}
                }
                __linkUniformCount++;
            } catch (eApply) {}
        }
        applyResults.linkUniformStyled = __linkUniformCount;
    } catch (eLU) {
        applyResults.clusterApplyFailures.push({
            tid: "<global-link-uniform>",
            reason: "link_uniform_styling_failed: " + (eLU && eLU.message ? eLU.message : eLU)
        });
    }
    } // end if (false) — BRIDGE-38 disabled per policy update

    report.apply = {
        cluster_styles_applied: applyResults.clusterStylesApplied,
        target_text_written: applyResults.targetTextWritten,
        annotations_applied: applyResults.annotationsApplied,
        annotations_skipped: applyResults.annotationsSkipped,
        annotation_skip_reasons: applyResults.annotationSkipReasons || [],
        annotation_reuse_diag: applyResults.annotationReuseDiag || [],
        target_emphasis_runs_applied: applyResults.targetEmphasisRunsApplied || 0,
        target_emphasis_runs_failed:  applyResults.targetEmphasisRunsFailed  || 0,
        target_emphasis_run_failures: applyResults.targetEmphasisRunFailures || [],
        // #ac-overset-widen (part A) — frames permanently widened before emphasis.
        // NOTE: under ctx.deferEmphasis these emphasis-fed fields are all still ZERO
        // here — pass 2 hasn't run yet. The caller merges runEmphasisSettlePass().fields
        // over this object once the save has settled the layout.
        frames_widened: applyResults.framesWidened || [],
        // Step 3.4b (univ-italic ④) — whole-paragraph uniform-italic CJK migration.
        whole_para_italic_applied:  applyResults.wholeParaItalicApplied  || 0,
        whole_para_italic_skipped:  applyResults.wholeParaItalicSkipped  || 0,
        whole_para_italic_blocked:  applyResults.wholeParaItalicBlocked  || 0,
        whole_para_italic_failures: applyResults.wholeParaItalicFailures || [],
        skipped_no_para: applyResults.skippedNoPara,
        skipped_empty_target: applyResults.skippedEmptyTarget,
        untranslated_restyled: applyResults.untranslatedRestyled || 0,
        untranslated_emphasis_applied: applyResults.untranslatedEmphasisApplied || 0,
        untranslated_emphasis_skipped: applyResults.untranslatedEmphasisSkipped || 0,
        cluster_apply_failures: applyResults.clusterApplyFailures.length,
        format_mixed_not_restored: applyResults.formatMixedNotRestored.length,
        space_overrides_applied: applyResults.spaceOverridesApplied || 0,
        space_overrides_skipped: applyResults.spaceOverridesSkipped || 0,
        applied_cluster_tids: applyResults.appliedClusterTids || [],
        // Designer character-style preservation (#3 fix). Should be:
        //   preserved_count > 0 implies restored_count == preserved_count
        //   AND lost == [] (any entry in lost is data loss).
        designer_char_styles_preserved_count: applyResults.designerCharStylesPreserved || 0,
        designer_char_styles_restored_count: applyResults.designerCharStylesRestored || 0,
        designer_char_styles_lost: applyResults.designerCharStylesLost || [],
        // #BRIDGE-24 Fix B1 — source emphasis_runs fallback under identity
        source_emphasis_runs_applied: applyResults.sourceEmphasisRunsApplied || 0,
        source_emphasis_runs_failed:  applyResults.sourceEmphasisRunsFailed  || 0,
        source_emphasis_run_failures: applyResults.sourceEmphasisRunFailures || [],
        // #BRIDGE-25 — script-font enforcer (translation-agnostic post-pass)
        script_font_cjk_enforced:   applyResults.scriptFontCjkEnforced   || 0,
        script_font_latin_enforced: applyResults.scriptFontLatinEnforced || 0,
        script_font_errors:         applyResults.scriptFontErrors        || 0,
        // #BRIDGE-26 — underline / paragraph-rule overlap dedup
        underline_dedup_mode:                  applyResults.underlineDedupMode               || "n/a",
        underline_dedup_paragraphs_affected:   applyResults.underlineDedupParagraphsAffected || 0,
        underline_dedup_ranges_affected:       applyResults.underlineDedupRangesAffected     || 0,
        underline_dedup_paragraphs_cleared:    applyResults.underlineDedupParagraphsCleared  || 0,
        underline_dedup_skipped_no_rule:       applyResults.underlineDedupSkippedNoRule      || 0,
        underline_dedup_skipped_no_underline:  applyResults.underlineDedupSkippedNoUnderline || 0,
        underline_dedup_errors:                applyResults.underlineDedupErrors             || 0,
        // #BRIDGE-35 — doc-wide CJK-paragraph italic→skew unification.
        italic_skew_ranges_converted:          applyResults.italicSkewFallback               || 0,
        italic_skew_paragraphs_affected:       applyResults.italicSkewParagraphs             || 0,
        // #BRIDGE-35c — backfill for source-italic paragraphs whose emphasis
        // run mapping failed and lost italic intent entirely.
        italic_skew_backfilled:                applyResults.italicSkewBackfilled             || 0,
        // #BRIDGE-38 — uniform link styling for source-link paragraphs
        // where translator didn't provide target_links.
        link_uniform_styled:                   applyResults.linkUniformStyled                || 0,
        // #BRIDGE-39 — Hyperlink CS + char-level underline stripped from
        // translated source-link paragraphs where translator didn't annotate.
        hyperlink_cs_stripped:                 applyResults.hyperlinkCsStripped              || 0,
        // #BRIDGE-41 — final-pass annotation property re-stamp count.
        annotation_final_restamped:            applyResults.annotationFinalRestamped         || 0,
        // #DIAG (temporary): trace of annotation-step gating
        ann_diag_trace:                        applyResults.annDiagTrace || [],
        ann_result_detail:                     applyResults.annResultDetail || []
    };

    __mark("post_sweeps_done");

    // #BRIDGE-30c (2026-06-09): post-pipeline trailing-\r strip.
    //
    // _writeParaPreserveMark's itemByRange(0, charCount-2) path preserves
    // whatever sits at position charCount-1 — and on last-in-story paragraphs
    // that position holds the story-end PHANTOM terminator (UXP exposes the
    // internal end-of-story state as code 13 via raw para.contents). The
    // preserve-mark behavior promotes the phantom to a real trailing \r,
    // which creates an extra empty paragraph at the end of the affected
    // frame. Try changing the in-write path is dangerous: any wider
    // itemByRange OR `para.contents = write` only replaces content up to
    // the first forced line break (U+2028) on multi-line paragraphs (UXP
    // quirk — `para.characters` only spans the first line on multi-line
    // paragraphs), so we get partial-replace artifacts (CJK head + leftover
    // EN tail) instead of full replacement.
    //
    // Safer: leave the magic write path untouched, do a single global pass
    // here AFTER all bridges & post-sweeps complete. Walk every story's
    // last paragraph; if its trailing char is code 13, remove that single
    // story-end char. Story-level char.remove() works (verified against
    // DOC-0000 master A-Master frame 3 footer: "长寿与退休新旅程\nAECSPAD...
    // 保留所有权利。\r" → 95 chars ending in "。" with no trailing \r).
    try {
        var __stripStories = workDoc.stories;
        var __stripCount = 0;
        for (var __sti = 0; __sti < __stripStories.length; __sti++) {
            var __stripS = __stripStories.item(__sti);
            try {
                var __stripChars = __stripS.characters;
                var __stripLen = __stripChars.length;
                if (__stripLen <= 0) continue;
                var __stripLast = __stripChars.item(__stripLen - 1);
                var __stripLastC = "";
                try { __stripLastC = String(__stripLast.contents); } catch (eC) {}
                if (__stripLastC.length > 0 && __stripLastC.charCodeAt(0) === 13) {
                    try { __stripLast.remove(); __stripCount++; } catch (eR) {}
                }
            } catch (eStory) {}
        }
        report.bridge30c_trailing_cr_stripped = __stripCount;
    } catch (eStrip) {
        report.errors.push("bridge30c strip failed: " + eStrip.message);
    }
    __mark("bridge30c_strip_done");

    // ── Stage ④ Postflight ──
    report.pipeline_stage = "postflight";
    var postflight;
    try {
        postflight = HE.runPostflight(workDoc, applyResults, {
            getCollectionItem: deps.getCollectionItem,
            severityRules: deps.severityRules || null
        });
    } catch (ePO) {
        report.errors.push("runPostflight failed: " + ePO.message);
        postflight = { blocking: [], warning: [], blocking_count: 0, warning_count: 0 };
    }
    report.postflight = postflight;
    __mark("postflight_done");

    // ── Write import-state label (edit-mode handoff) ────────────────
    // Always write — even first-time imports get a label so the NEXT
    // import can edit-mode. Disable via ctx.skipWriteImportState if
    // operator explicitly wants no label (e.g. trial run).
    //
    // IMPORTANT (tid alignment): segments[] must be keyed by the tid the
    // NEXT export will produce, NOT by translations.rows[i].tid. The
    // input translations.json's fallback tids encode the SOURCE doc's
    // paragraph character offsets (e.g. EN source: `_14` because the
    // English heading "Leverage Life Insurance" is 14 chars into the
    // story). After writing CJK translations into the workDoc, those
    // same paragraphs now start at DIFFERENT char offsets (CJK text is
    // shorter), so the next export's fallback tid is e.g. `_9` instead
    // of `_14`. If we key the label by the input tid (`_14`), the
    // next re-import's diff-classify finds 0 matches and routes every
    // row to `full` → edit mode silently degrades to a full pipeline.
    //
    // The fix: re-key by the workDoc's current `para.index` (= char
    // offset within story), matching `paragraphIndexHintForTid` in
    // export_translation_package.idjs:220–248. This identifier is
    // content-stable across close+reopen (depends only on text length +
    // story order, both file-persistent).
    //
    // (Note: in UXP, `para.id` returns undefined; export's fallback
    // chain therefore lands on `para.index` for every paragraph. We
    // match that behaviour here exactly so the two tids align.)
    //
    // Table-cell paragraphs use a different fallback encoding: export's
    // `paragraphIndexHintForTid` routes them through `tableCellSyntheticIndex`
    // (shared helper in translation_common.js) which yields a numeric index
    // derived from table_id/index + row + col + cell_para_index — stable
    // across content edits because it depends on table STRUCTURE, not on
    // paragraph offsets within a story. We mirror that branch using the
    // segment's own table-cell metadata fields (attached by export's
    // attachTableCellMetaToSegment).
    var __TCSI = (function () {
        try { return require("./translation_common.js").tableCellSyntheticIndex; } catch (e) { return null; }
    })();
    function _computeWorkDocTid(para, srcTid, seg) {
        if (!para) return srcTid;     // can't relocate; keep source tid
        // Only rewrite fallback-shaped source tids. Durable XML tids
        // (anything not matching `fallback_<storyId>_<paraIdx>`) are
        // re-emitted verbatim by next export — diff-classify looks up
        // the sidecar by exact tid, so rewriting them would orphan the
        // entry and force the row back to full pipeline.
        //
        // Preserve any `_sb<N>` subsegment suffix: export emits
        // `<parentTid>_sb<N>` for every soft-break-group member
        // (export_translation_package.idjs:2149). Tails (sb_index>0)
        // are already pruned by __sbSuppress before this point, so in
        // practice only the head's `_sb0` reaches us — but preserve
        // any `_sbN` defensively so the label key matches export's
        // emission shape regardless.
        var __sbMatch = /(_sb\d+)$/.exec(srcTid || "");
        var __sbSuffix = __sbMatch ? __sbMatch[1] : "";
        var __srcBase = __sbSuffix
            ? srcTid.slice(0, srcTid.length - __sbSuffix.length)
            : (srcTid || "");
        if (!/^fallback_\d+_\d+$/.test(__srcBase)) {
            // Durable XML tid (or unrecognized shape) — leave untouched.
            return srcTid;
        }
        var storyIdW = null;
        try { storyIdW = (para.parentStory && para.parentStory.id !== undefined) ? Number(para.parentStory.id) : null; } catch (e) {}
        if (!isFinite(storyIdW) || storyIdW === null) return srcTid;
        // Mirror export's paragraphIndexHintForTid: try para.id (almost
        // always undefined in UXP), then fall through to para.index.
        var paraIdxW = NaN;
        try { paraIdxW = Number(para.id); } catch (e) {}
        if (!isFinite(paraIdxW) || paraIdxW < 0) {
            try { paraIdxW = Number(para.index); } catch (e) {}
        }
        if (!isFinite(paraIdxW) || paraIdxW < 0) return srcTid;
        // Table-cell branch: if seg carries cell_row/cell_col (per
        // attachTableCellMetaToSegment), encode via tableCellSyntheticIndex.
        // Otherwise the raw para.index fallback below would NOT match the
        // tid the next export produces for the same cell paragraph.
        if (seg && __TCSI
            && isFinite(Number(seg.cell_row)) && Number(seg.cell_row) >= 0
            && isFinite(Number(seg.cell_col)) && Number(seg.cell_col) >= 0) {
            var syntheticIdx = __TCSI(seg, paraIdxW);
            return "fallback_" + storyIdW + "_" + syntheticIdx + __sbSuffix;
        }
        return "fallback_" + storyIdW + "_" + paraIdxW + __sbSuffix;
    }
    if (!ctx.skipWriteImportState) {
        try {
            var Store = require("./import_state_store.js");
            var DC = DiffClassify || require("./import_diff_classify.js");
            var newState = {
                schema: 1,
                document: { name: String(workDoc.name || ""), source_hash: null },
                package_path: ctx.packagePath || null,
                import_v2_rev: ctx.importV2Rev || null,
                segments: {},
                // tid_map records src_tid → workdoc_tid so a debugger /
                // tooling can recover the source-tid identity if needed.
                // Sparse: only entries where re-keying actually changed
                // the value end up here.
                tid_remap: {}
            };
            var rows2 = translations.rows || [];
            var __remapCount = 0;
            // #67 A0: this label must record WHAT THE DOCUMENT NOW CONTAINS, not
            // what this run intended to write. The per-row write outcome lives in
            // applyResults: a failed text write pushes {tid, reason:
            // "write_target_failed: …"} onto clusterApplyFailures (see
            // applyOnePara), and the apply loop's own catch pushes
            // "applyOnePara_throw: …" the same way. Index them so a row that threw
            // is not recorded as applied.
            var __applyFailedByTid = {};
            try {
                var __caf = applyResults.clusterApplyFailures || [];
                for (var __cfi = 0; __cfi < __caf.length; __cfi++) {
                    if (__caf[__cfi] && __caf[__cfi].tid) {
                        __applyFailedByTid[__caf[__cfi].tid] = __caf[__cfi].reason || "apply_failed";
                    }
                }
            } catch (eCAF) {}
            var __notAppliedCount = 0;
            // #73 counter — COUNT ONLY, changes no behaviour and no format.
            // See the write site below for what it answers and the registered
            // predictions.
            var __appliedKeyOverwrites = [];
            // Rows that were seen but not applied. Held back and written in a
            // SECOND pass (see below) so an applied row's re-keyed entry can never
            // be clobbered by — or clobber — a not-applied row that happens to
            // share the key.
            var __deferredNotApplied = [];
            for (var __rsi = 0; __rsi < rows2.length; __rsi++) {
                var __row = rows2[__rsi];
                if (!__row || !__row.tid) continue;
                // Skip non-translatable rows (matches diff-classify behaviour)
                if (__row.status === "skip" || __row.translatable === false) continue;
                // Soft-break tails (sb_index>0) locate to the SAME physical
                // paragraph as the head and share its workDoc tid. The head
                // row was applied with the merged target_text; writing a
                // tail's applied_hash here would clobber the head entry and
                // cause next round's classify to escalate the head back to
                // full pipeline against a stale hash.
                if (__sbSuppress[__row.tid]) continue;
                var __lp2 = __locResultByTid[__row.tid] || null;
                var __liveStyle = null;
                var __liveFp = null;
                var __workDocTid = __row.tid;
                if (__lp2 && __lp2.para) {
                    // CLAUDE.md "InDesign paragraph DOM ref → split → stale":
                    // locatePlan wrappers are captured BEFORE the apply loop.
                    // _writeParaPreserveMark / split / merge operations during
                    // apply can shift wrapper bounds so the original handle now
                    // straddles two paragraphs (or refers to the wrong one).
                    // Re-resolve to the paragraph containing the wrapper's
                    // first character before any reads — otherwise live style,
                    // fingerprint, and para.index are all read from the wrong
                    // paragraph and the label encodes a wrong workDocTid /
                    // applied_hash baseline that next round can't match.
                    var __fp2 = __lp2.para;
                    try { __fp2 = _refreshParaWrapper(__lp2.para); } catch (eRP2) {}
                    try { __liveStyle = String(__fp2.appliedParagraphStyle.name); } catch (e) {}
                    // Same live-style fingerprint scheme as classify-time so
                    // the next import's compare-vs-stored is meaningful.
                    var __liveProps = _readLiveStyleProps(__fp2);
                    __liveFp = __liveProps ? DC.computeLiveStyleFingerprint(__liveProps) : null;
                    __workDocTid = _computeWorkDocTid(__fp2, __row.tid, __lp2.seg);
                    if (__workDocTid !== __row.tid) {
                        newState.tid_remap[__row.tid] = __workDocTid;
                        __remapCount++;
                    }
                }
                // #67 A0: THE GATE. This assignment used to sit OUTSIDE the
                // `if (__lp2 && __lp2.para)` above, so every translatable row got
                // an `applied_hash` — including rows the locator never found and
                // rows whose write threw. Since the hash is computed from
                // `__row.target_text` and never from the paragraph, the next
                // import hash-matched it, classified the row `noop`
                // (import_diff_classify.js:270), and skipped it without even
                // entering applyOnePara — so the FIRST failure sealed itself in
                // permanently. Measured on a real document 2026-08-22: 48 of 107
                // entries were of this kind, and re-importing a corrected package
                // could never have fixed any of them.
                //
                // (The legacy-promotion synthesizer at :2677 always did this
                // correctly — it hashes `__curText`, read off the paragraph. This
                // path is now consistent with it.)
                var __notAppliedReason = null;
                if (!(__lp2 && __lp2.para)) {
                    __notAppliedReason = "not_located";
                } else if (Object.prototype.hasOwnProperty.call(__applyFailedByTid, __row.tid)) {
                    __notAppliedReason = __applyFailedByTid[__row.tid];
                }
                if (__notAppliedReason) {
                    // Record that the row was SEEN and NOT applied, deliberately
                    // WITHOUT an `applied_hash`: diff-classify compares
                    // `prev.applied_hash === newHash`, and an absent field can
                    // never match, so the row is guaranteed to route to `full` and
                    // be retried next round instead of silently going `noop`.
                    // Keeping the entry (rather than omitting it) preserves the
                    // diagnosis — `import_state_store.isUnappliedEntry` is the
                    // named predicate for this shape.
                    //
                    // 🔴 DEFERRED TO A SECOND PASS — see `__deferredNotApplied`
                    // below. An un-located row has no workDoc position, so its key
                    // here is its SOURCE tid, which is a guess; a LOCATED row can
                    // legitimately be re-keyed onto that same value. Writing both
                    // in one pass makes the winner depend on row order. Measured
                    // 2026-08-22: located row `fallback_17081_4798` was re-keyed to
                    // `fallback_17081_1563` and clobbered the un-located row that
                    // actually IS `fallback_17081_1563` — one "not applied" record
                    // silently lost, visible only as `not_applied=49` in the log
                    // against 48 entries on disk.
                    __deferredNotApplied.push({
                        key: __workDocTid,
                        src_tid: __row.tid,
                        reason: __notAppliedReason
                    });
                    continue;
                }
                // ── #73 COUNTER (count only; does NOT change the write) ──────
                //
                // WHAT IT ANSWERS. Pass 2 (`mergeNotAppliedEntries`) reports the
                // applied-vs-NOT-applied key clash. This pass has never reported
                // anything: the assignment below is unguarded, so when two APPLIED
                // rows compute the same `__workDocTid` the later one silently
                // replaces the earlier — no count, no log, no trace in the label
                // (a JSON object cannot hold two entries under one key, so the
                // artifact can never show it either).
                //
                // WHY A COUNTER AND NOT A FIX. Deciding what SHOULD happen on a
                // clash is `#73`'s open question. Counting is the part that does
                // not need that decision, and without it the frequency input to
                // that decision is a known-undercounting lower bound.
                //
                // 🔴 REGISTERED PREDICTIONS (pre-committed 2026-08-22, per the
                // "no prediction = noise" rule — do not restate these after the
                // fact):
                //   · Stays 0 across accumulated real imports
                //       => `#73` DOWNGRADES. The ambiguity is confined to the
                //          applied-vs-unapplied class, which pass 2 already
                //          handles; no key redesign is warranted.
                //   · Comes back NON-ZERO
                //       => `#73` UPGRADES, and THIS site must be fixed together
                //          with it — an applied row losing its record here is
                //          strictly worse than the pass-2 case, because pass 2 at
                //          least degrades to "re-tried next round" while this one
                //          discards a record describing text that IS in the
                //          document.
                //
                // ⚠ SCOPE — what this counter can and cannot see (measured
                // offline on the real fixture 2026-08-22, n=1 document):
                //   · both rows re-keyed        -> ALREADY answerable offline and
                //     measured 0: `tid_remap` is keyed by SOURCE tid, so unlike
                //     `segments` it loses nothing; two re-keys onto one target
                //     show up as a duplicate VALUE there.
                //   · one re-keyed, one not     -> 🔴 THIS is the blind spot this
                //     counter exists for. The loser vanishes from `segments`, and
                //     the survivor looks exactly the same in both worlds.
                //   · neither re-keyed          -> impossible while source tids
                //     are unique (assumption, not verified here).
                var __ow = Store.detectAppliedKeyOverwrite(newState.segments, __workDocTid, __row.tid);
                if (__ow) __appliedKeyOverwrites.push(__ow);
                newState.segments[__workDocTid] = {
                    applied_hash: DC.computeAppliedHash(__row.target_text, __row.target_emphasis_runs),
                    applied_paragraph_style: __liveStyle,
                    applied_target_text_len: (__row.target_text || "").length,
                    cluster_fingerprint: __liveFp,
                    applied_emphasis_run_count: (__row.target_emphasis_runs || []).length,
                    // Original source tid retained per-segment too — handy
                    // for diagnostics ("which input row produced this entry")
                    // and for the read-side to back-resolve if needed.
                    src_tid: __row.tid
                };
            }
            // ── PASS 2: the rows that were NOT applied ──────────────────────
            //
            // Runs after every APPLIED row has claimed its key, so the outcome no
            // longer depends on the order rows happen to appear in. An applied
            // entry describes text that is really in the document; a not-applied
            // entry is a note about a row we could not place. When both want the
            // same key the applied one is authoritative and keeps it.
            // The rule itself lives in import_state_store (it is a claim about the
            // state shape, and putting it there is what makes it testable —
            // tests/import_state_unapplied_tests.js).
            // #73: surface the pass-1 counter BEFORE pass 2 runs, so the two
            // numbers are never confused for each other. Reported even when zero
            // — a counter that only appears when it fires cannot be distinguished
            // from a counter that was never wired up.
            report.import_state_applied_key_overwrites = __appliedKeyOverwrites.length;
            if (__appliedKeyOverwrites.length && __plog) {
                try {
                    __plog("import_state: " + __appliedKeyOverwrites.length + " APPLIED row(s) overwrote"
                        + " another APPLIED row's record (both computed the same key). The overwritten row"
                        + " has NO entry => next import reports it as 'no prior state' => classifies `full`"
                        + " => re-applies it. See #73.");
                    for (var __ko = 0; __ko < __appliedKeyOverwrites.length; __ko++) {
                        var __kov = __appliedKeyOverwrites[__ko];
                        __plog("  key=" + __kov.key + "  overwritten=" + __kov.loser_src_tid
                            + "  kept=" + __kov.winner_src_tid);
                    }
                } catch (eKO) {}
            }
            var __merged = Store.mergeNotAppliedEntries(newState.segments, __deferredNotApplied);
            var __keyCollisions = __merged.collisions;
            __notAppliedCount += __merged.added;
            report.import_state_key_collisions = __keyCollisions.length;
            if (__keyCollisions.length && __plog) {
                // 🔴 Say what happens to the rows that end up with NO record at
                // all. "Silently recorded as done" was #62; "silently not recorded"
                // would be the same disease wearing a safer outcome. The direction
                // IS safe — no entry means diff-classify reports `missingPrev`,
                // which routes the row to `full` and retries it — but safe and
                // invisible is still invisible.
                try {
                    var __kc = ["import_state: " + __keyCollisions.length + " not-applied row(s) could NOT be"
                        + " recorded — their key is already held by a row that WAS applied and re-keyed onto it."
                        + " The applied record wins (it describes real document text)."
                        + "\n  Consequence for these rows: NO entry in the label => next import reports them as"
                        + " 'no prior state' => they classify `full` => they are RE-TRIED. Nothing is treated as done."];
                    for (var __kci = 0; __kci < __keyCollisions.length; __kci++) {
                        var __k = __keyCollisions[__kci];
                        __kc.push("  collision: row " + __k.src_tid + " (" + __k.reason + ") wanted key " + __k.key
                            + ", which is held by " + (__k.held_by || "?"));
                    }
                    __plog(__kc.join("\n"));
                } catch (eKC) {}
            }
            var wr = Store.write(workDoc, newState);
            report.import_state_label = {
                ok: wr.ok,
                bytes: wr.bytes || 0,
                segs: Object.keys(newState.segments).length,
                // #67 A0: how many entries record "seen but NOT applied". A
                // non-zero value here and a green log elsewhere is the exact
                // combination that hid #62 for a day.
                not_applied: __notAppliedCount,
                err: wr.err || null
            };
            if (__plog) {
                // #62 C: on failure this line used to print the word "FAIL" and
                // nothing else — `wr.err` was captured onto the report and never
                // shown. Observed live 2026-08-22: "import_state label: FAIL
                // bytes=28538 segs=108" with no way to tell WHY the label did not
                // persist, on the very run whose whole point was the label. Same
                // shape as everything else fixed here: the reason existed and was
                // dropped on the floor.
                try { __plog("import_state label: " + (wr.ok ? "OK" : "FAIL") + " bytes=" + (wr.bytes || 0)
                    + " segs=" + Object.keys(newState.segments).length
                    + " not_applied=" + __notAppliedCount
                    + (wr.ok ? "" : " err=" + (wr.err || "<none reported>")
                        + " — NOTHING WAS PERSISTED: the next import will see no prior state for this document")
                    + (__notAppliedCount > 0
                        ? " (these rows carry NO applied_hash on purpose — next import re-tries them instead of treating them as done)"
                        : "")); } catch (e) {}
            }
            __mark("import_state_label_written");
        } catch (eIS) {
            report.errors.push("import_state label write failed: " + (eIS && eIS.message ? eIS.message : eIS));
        }
    }

    // #DIAG-TIMING: surface sub-phase timings (ms since runPipeline entry)
    // so we can compare manual vs automated invocations and locate where
    // the slowdown actually lives.
    report.timings = __timings;

    // Restore original measurement units before returning (so save()
    // doesn't persist our temporary POINTS override).
    if (_origUnits.h !== null) { try { workDoc.viewPreferences.horizontalMeasurementUnits = _origUnits.h; } catch (eUR0) {} }
    if (_origUnits.v !== null) { try { workDoc.viewPreferences.verticalMeasurementUnits = _origUnits.v; } catch (eUR1) {} }

    return {
        aborted: false,
        blocked: false,
        plan: plan,
        locatePlan: locatePlan,
        preflight: preflight,
        sheet: sheet,
        applyResults: applyResults,
        postflight: postflight,
        // #ac-overset-widen: the handle the caller drives PASS 2 with, once it has
        // settled the layout with a save. null unless ctx.deferEmphasis — i.e. absent
        // for every single-pass caller, so ignoring it keeps the old behavior.
        // Carries live DOM refs (worklist[].lr.para): valid only while workDoc stays
        // open, which the import flow guarantees (the doc IS the deliverable).
        __emphasisPending: ctx.deferEmphasis ? {
            worklist: __emphasisWorklist,
            sheet: sheet,
            plan: plan,
            applyResults: applyResults,
            paraDeps: paraDeps,
            report: report,
            // For the #BRIDGE-41 re-stamp that pass 2 must re-run at its end (that pass
            // has to have the LAST WORD over annotation format props, and pass 2 now
            // lands after its first run). Same objects the first run used.
            locatePlan: locatePlan,
            translations: translations
        } : null
    };
}

// ─── runMinimalApply (skip-style-cleanup mode) ────────────────────
//
// Minimal import path for users who pick "don't reorganize styles" but
// still want emphasis preserved. Bypasses buildStylePlan / commitStylePlan /
// applyClusterStyleToParagraph / applySpaceOverridesToParagraph entirely.
// Per located paragraph it does only:
//
//   1. (idempotent) restore camelCase emphasisRuns from snake_case
//      emphasis_runs in segments.json
//   2. Run 8A + 8B if not already extracted (legacy packages)
//   3. Locate paragraphs via segment_locator
//   4. Write target_text WHERE the source text was preserved (i.e. when
//      target_text === source_text — translation is a no-op or untranslated)
//   5. Apply emphasis_runs as DIRECT character overrides via
//      applyEmphasisRunsAsOverrides (no _T_p_* / _T_c_emp_* style pool)
//
// For segments where target_text differs from source_text (real
// translation), emphasis_runs are SKIPPED — their offsets index source
// text and don't map to translated text without a separate alignment
// step (deferred to format-paint UI).
//
// Returns the same shape as runPipeline (minus plan/sheet) so callers
// can route based on { aborted, blocked, applyResults }.
function runMinimalApply(workDoc, ctx, deps) {
    // #62 C-1: this path had no logger of its own. Same source as runPipeline's
    // (`deps.plog`), so a caller that wires one gets both paths' diagnostics.
    var __plog = (deps && typeof deps.plog === "function") ? deps.plog : null;
    if (!workDoc) throw new Error("runMinimalApply: workDoc required");
    if (!ctx || !ctx.report || !ctx.segments || !ctx.translations) {
        throw new Error("runMinimalApply: ctx requires { report, segments, translations }");
    }
    if (!deps || !deps.lib) {
        throw new Error("runMinimalApply: deps requires { lib }");
    }

    var report = ctx.report;
    var segments = ctx.segments;
    var translations = ctx.translations;

    var SL = deps.lib.segmentLocator;
    var SA = deps.lib.styleApplier;
    var EX8B = deps.lib.emphasisExtractor;
    var SC8A = deps.lib.scriptClassifier;

    // Force POINTS for measurement units (same reason as runPipeline).
    var _origUnits = { h: null, v: null };
    var MU = deps.MeasurementUnits;
    if (MU && MU.POINTS !== undefined) {
        try { _origUnits.h = workDoc.viewPreferences.horizontalMeasurementUnits; } catch (e0) {}
        try { _origUnits.v = workDoc.viewPreferences.verticalMeasurementUnits; } catch (e1) {}
        try { workDoc.viewPreferences.horizontalMeasurementUnits = MU.POINTS; } catch (e2) {}
        try { workDoc.viewPreferences.verticalMeasurementUnits = MU.POINTS; } catch (e3) {}
    }
    function _restoreUnits() {
        if (_origUnits.h !== null) { try { workDoc.viewPreferences.horizontalMeasurementUnits = _origUnits.h; } catch (eR0) {} }
        if (_origUnits.v !== null) { try { workDoc.viewPreferences.verticalMeasurementUnits = _origUnits.v; } catch (eR1) {} }
    }

    report.pipeline_stage = "minimal_apply";
    report.skip_style_cleanup = true;

    // Step 1: idempotent restore — emphasis_runs (snake) → emphasisRuns (camel)
    var preExtracted = 0;
    for (var ire = 0; ire < segments.length; ire++) {
        var fsRe = segments[ire] && segments[ire].format_snapshot;
        if (!fsRe) continue;
        if (fsRe.emphasis_runs && !fsRe.emphasisRuns) {
            fsRe.emphasisRuns = fsRe.emphasis_runs;
            preExtracted++;
        }
    }
    if (preExtracted > 0) report.emphasis_pre_extracted = preExtracted;

    // Step 2: run 8A + 8B if needed (skipped per-segment via gates if already done)
    if (SC8A && typeof SC8A.applyScriptByFontDetection === "function") {
        try { SC8A.applyScriptByFontDetection(segments); } catch (eSBF) {
            report.errors.push("scriptByFont threw: " + (eSBF && eSBF.message ? eSBF.message : eSBF));
        }
    }
    if (EX8B && typeof EX8B.applyEmphasisExtraction === "function") {
        try {
            var empStats = EX8B.applyEmphasisExtraction(segments, {
                targetLanguage: ctx.targetLanguage || null,
                editMode:       !!ctx.editMode
            });
            report.emphasis = {
                processed:                  empStats.processed,
                runs_total:                 empStats.runsEmphasisTotal,
                already_extracted_skipped:  empStats.skippedAlreadyExtracted
            };
        } catch (eEX) {
            report.errors.push("emphasis extraction threw: " + (eEX && eEX.message ? eEX.message : eEX));
        }
    }

    // Step 3: locate
    //
    // #62 B②: same prior-applied bypass as runPipeline. This path runs whenever
    // skipStyleCleanup is on — and it turns on BY ITSELF: with no brand_config,
    // byPair flips the mode to M5 and sets `skipStyleCleanup false → true`
    // (import_integrated logs "mode override flips skipStyleCleanup"). So the
    // "minimal" path is not an exotic branch an operator opts into; a routine
    // missing-config run lands here. It needs the same locating power and the
    // same visibility as the main path.
    var __minPriorByTid = null;
    if (ctx.editImportMode && ctx.sidecarState) {
        try {
            var __minISS = require("./import_state_store.js");
            if (__minISS.findUnappliedEntries(ctx.sidecarState).length) {
                var __minStripped = __minISS.stripUnappliedEntries(ctx.sidecarState);
                ctx.sidecarState = __minStripped.state;
                report.sidecar_unapplied_ignored = {
                    count: __minStripped.removed.length,
                    tids: __minStripped.removed
                };
                if (__plog) {
                    try {
                        __plog("import_state: IGNORING " + __minStripped.removed.length
                            + " sidecar entr" + (__minStripped.removed.length === 1 ? "y" : "ies")
                            + " that record an applied_hash but were never actually applied"
                            + " — treated as no prior state, so this run RE-TRIES them."
                            + "\n  ignored tids: " + __minStripped.removed.join(","));
                    } catch (eMSU) {}
                }
            }
            var __mp = {};
            var __mk = Object.keys(ctx.sidecarState.segments || {});
            for (var __mi2 = 0; __mi2 < __mk.length; __mi2++) __mp[__mk[__mi2]] = ctx.sidecarState.segments[__mk[__mi2]];
            for (var __mj = 0; __mj < __mk.length; __mj++) {
                var __me = ctx.sidecarState.segments[__mk[__mj]];
                if (__me && __me.src_tid) __mp[__me.src_tid] = __me;
            }
            __minPriorByTid = __mp;
        } catch (eMISS) {
            report.errors.push("sidecar unapplied-entry filter failed (minimal): "
                + (eMISS && eMISS.message ? eMISS.message : eMISS));
        }
    }
    var locatePlan;
    try {
        locatePlan = SL.locateAllSegments(workDoc, segments, {
            hashFn: deps.hashFn,
            getCollectionItem: deps.getCollectionItem,
            priorAppliedByTid: __minPriorByTid,
            appliedHashMatchesText: require("./import_diff_classify.js").appliedHashMatchesText
        });
    } catch (eLP) {
        report.errors.push("locateAllSegments failed: " + (eLP && eLP.message ? eLP.message : eLP));
        _restoreUnits();
        return { aborted: true, stage: "minimal.locate" };
    }
    var locatedCount = 0, missCount = 0;
    var __minNotLocated = [];
    for (var li = 0; li < locatePlan.length; li++) {
        if (locatePlan[li].para) { locatedCount++; }
        else {
            missCount++;
            var __ml = locatePlan[li];
            __minNotLocated.push({
                tid: __ml.seg && __ml.seg.tid,
                story_id: __ml.seg && __ml.seg.story_id,
                paragraph_index: __ml.seg && __ml.seg.paragraph_index,
                reason: __ml.reason || "unknown",
                translatable: !!(__ml.translatable !== false)
            });
        }
    }
    report.locate = {
        total: locatePlan.length, located: locatedCount, miss: missCount,
        para_not_located: __minNotLocated
    };
    // #62 C-1: this path had NO locate logging at all — a run that lands here
    // (see the note above: a missing brand_config is enough) was completely
    // silent about how many of the operator's paragraphs it failed to find.
    // One plog call for the whole block: plog rewrites its entire buffer to
    // disk on every call, so N calls cost O(N²) bytes written.
    if (__plog) {
        try {
            var __mll = ["locate: located=" + locatedCount + "/" + locatePlan.length
                + " miss=" + missCount + " (minimal-apply path)"];
            for (var __mn = 0; __mn < __minNotLocated.length; __mn++) {
                var __mm = __minNotLocated[__mn];
                __mll.push("  locate MISS: tid=" + (__mm.tid || "?")
                    + " story_id=" + (__mm.story_id === undefined ? "?" : __mm.story_id)
                    + " paragraph_index=" + (__mm.paragraph_index === undefined ? "?" : __mm.paragraph_index)
                    + " translatable=" + (__mm.translatable ? "yes" : "no")
                    + " reason=" + (__mm.reason || "unknown"));
            }
            __plog(__mll.join("\n"));
        } catch (eMLL) {}
    }

    // Step 4 + 5: per-segment write text + apply emphasis as overrides
    var applyResults = {
        targetTextWritten: 0,
        textWriteSkipped: 0,
        emphasisApplied: 0,
        emphasisSkippedTextChanged: 0,
        emphasisFailed: 0,
        skippedNoPara: 0,
        failures: []
    };

    var byTid = (translations && translations.byTid) || {};

    // SPEC §10.5/§12.6: M5 must build the cjkEmphasisWeight resolver itself —
    // it's NOT carried on deps. runMinimalApply receives the same ctx as
    // runPipeline, so mirror the runPipeline ctor (:1231-1238) from
    // ctx.preloadedFontMapping. Without it the combined-char-style helper can't
    // resolve CJK weight (Semibold→Xbold) → silent drop (§9 #4a).
    var __m5CjkEmphasisWeightResolver = null;
    try {
        var __pfmM5 = ctx.preloadedFontMapping;
        if (__pfmM5 && Array.isArray(__pfmM5.byPair) && __pfmM5.byPair.length) {
            __m5CjkEmphasisWeightResolver = require("./font_mapping_pairs.js")
                .makeCjkEmphasisWeightResolver(__pfmM5.byPair, __pfmM5.brandConfig || null);
        }
    } catch (eM5cwr) { __m5CjkEmphasisWeightResolver = null; }

    var emphasisDeps = {
        ColorModel: deps.ColorModel || null,
        ColorSpace: deps.ColorSpace || null,
        // SPEC §10.5: complete the deps so the combined-char-style helper can
        // resolve CJK weight + position enums + swatches.
        Position: deps.Position || null,
        cjkEmphasisWeight: __m5CjkEmphasisWeightResolver,
        // univ-italic: per-weight italic HOW config (see :1566 note).
        italicConfig: (__pfmM5 && __pfmM5.brandConfig) || null
    };

    for (var pi = 0; pi < locatePlan.length; pi++) {
        var lr = locatePlan[pi];
        if (!lr || !lr.para) { applyResults.skippedNoPara++; continue; }

        var seg = lr.seg;
        var tid = seg && seg.tid;
        var translation = (tid && byTid[tid]) ? byTid[tid] : null;
        var target = (translation && translation.target_text !== undefined) ? translation.target_text : null;
        var hasTarget = (target !== null && target !== undefined && String(target).length > 0);
        var sourceText = String(seg.source_text || "");

        // Write target_text if present (skip-cleanup still does writes;
        // it just skips the style-pool side effects).
        // #BRIDGE-20: use shared _writeParaPreserveMark so this path
        // gets the same \r-handling + #E2E-17 safety net as the main
        // pipeline. Previously inline duplicated logic here lacked the
        // safety net, so short-paragraph writes in minimal mode could
        // eat the paragraph mark and merge with the next paragraph.
        var textWritten = false;
        if (hasTarget) {
            try {
                _writeParaPreserveMark(lr.para, target);
                applyResults.targetTextWritten++;
                textWritten = true;
            } catch (eW) {
                applyResults.failures.push({ tid: tid, reason: "write_target_failed: " + (eW && eW.message ? eW.message : eW) });
            }
        } else {
            applyResults.textWriteSkipped++;
        }

        // Apply emphasis as direct overrides. Two distinct sources, in order:
        //
        //   (a) translation.target_emphasis_runs[] — offsets index TARGET text.
        //       This is the format-paint / AI-codec output: translator (or
        //       LLM via lib/emphasis_codec.decode) supplied target-side
        //       emphasis aligned with the new text. Always safe regardless
        //       of whether source == target.
        //
        //   (b) seg.format_snapshot.emphasisRuns — offsets index SOURCE text.
        //       Used when target_emphasis_runs is absent AND text wasn't
        //       rewritten (or was rewritten to source itself, e.g. a
        //       reorganize-only run with status="skip").
        //
        // Source-side runs only fire when target was unchanged because
        // their offsets won't align with a different target text.
        var fs2 = seg && seg.format_snapshot;
        var sourceRuns = (fs2 && fs2.emphasisRuns) || [];
        var targetRuns = (translation && (translation.target_emphasis_runs || translation.targetEmphasisRuns)) || [];
        // SPEC §10.5(b): faithfulness gate symmetric with Step3.4. auto-non-faithful
        // target runs must NOT be applied (no-auto-propagation policy) — else the
        // helper-swap would build character styles for overlay-guessed runs.
        // The gate applies ONLY to the target-side branch; source-side (identity
        // restore) is cleanup and stays ungated. Via _terIsAuto → canonical
        // AutoFormatGate SoT (same single gate as Step 3.4; a package can carry
        // skip_style_cleanup:true AND target_emphasis_runs_auto:true — orthogonal,
        // and without this gate the Client-A red line reproduces fully in M5).
        if (targetRuns && targetRuns.length && _terIsAuto(translation)) {
            // Two behavior-neutral telemetry counters, different units, both with
            // consumers @integration: terGatedAutoNonFaithful += 1 (segments gated,
            // read by the "emphasis target-side:" summary); emphasisSkippedAuto +=
            // run count (read by run_minimal_apply_tests T8).
            applyResults.terGatedAutoNonFaithful = (applyResults.terGatedAutoNonFaithful || 0) + 1;
            applyResults.emphasisSkippedAuto = (applyResults.emphasisSkippedAuto || 0) + targetRuns.length;
            targetRuns = [];
        }
        var runsToApply = null;
        var runsAreTargetSide = false;
        if (targetRuns && targetRuns.length) {
            // targetRuns already cleared to [] above when auto-non-faithful (M5 gate).
            runsToApply = targetRuns;
            runsAreTargetSide = true;
        } else if (sourceRuns && sourceRuns.length) {
            // Source-side: only safe when text hasn't been rewritten OR
            // rewritten back to source itself.
            var safeToApplySource = !textWritten || (String(target) === sourceText);
            if (!safeToApplySource) {
                applyResults.emphasisSkippedTextChanged += sourceRuns.length;
                continue;
            }
            runsToApply = sourceRuns;
        } else {
            continue;  // no emphasis info at all
        }

        try {
            // #ac-overset-widen (part A): widen an overset frame before emphasis so
            // the char-style assignment lands on the whole run (M5 / skip-cleanup path).
            _widenOversetFrameForEmphasis(lr.para, workDoc, deps, applyResults, tid);
            // SPEC §14: M5 also routes through the combined-char-style helper
            // (UN-remapped runs + seg). M5 never remapped runs, so raw pass.
            var summary = SA.applyEmphasisRunsAsCharStyles(lr.para, runsToApply, workDoc, emphasisDeps, seg);
            applyResults.emphasisApplied += summary.applied;
            applyResults.emphasisFailed += summary.skipped;
            if (runsAreTargetSide) {
                applyResults.emphasisTargetSideApplied = (applyResults.emphasisTargetSideApplied || 0) + summary.applied;
            }
        } catch (eEm) {
            applyResults.emphasisFailed += runsToApply.length;
            applyResults.failures.push({ tid: tid, reason: "emphasis_charstyle_failed: " + (eEm && eEm.message ? eEm.message : eEm) });
        }
    }

    report.apply = applyResults;

    // #BRIDGE-19: skip-style-cleanup path historically returned
    // immediately after the text/emphasis writes, so locate misses,
    // missing fonts, missing links, and post-apply oversets never
    // surfaced as blocking. Translation packages opting into
    // skip_style_cleanup (a "minimal" path) would happily save a
    // doc with corrupted text-frame state. Run the same preflight /
    // postflight checks the main runPipeline path uses; gate the
    // pipeline as blocked on hard findings unless ctx.continueOnBlocking.
    var blocked = false;
    var HE2 = deps.lib && deps.lib.hardErrors;
    if (HE2 && typeof HE2.runPreflight === "function") {
        try {
            var preflight2 = HE2.runPreflight(workDoc, segments, translations, /*fontPlan*/ null, locatePlan, {
                continueOnBlocking: !!ctx.continueOnBlocking
            });
            report.preflight = preflight2;
            if (!ctx.continueOnBlocking && preflight2 && preflight2.blocking_count > 0) blocked = true;
        } catch (ePF) {
            report.errors.push("minimal preflight threw: " + (ePF && ePF.message ? ePF.message : ePF));
        }
    }
    if (HE2 && typeof HE2.runPostflight === "function") {
        try {
            var postflight2 = HE2.runPostflight(workDoc, applyResults, {});
            report.postflight = postflight2;
            if (!ctx.continueOnBlocking && postflight2 && postflight2.blocking_count > 0) blocked = true;
        } catch (ePoF) {
            report.errors.push("minimal postflight threw: " + (ePoF && ePoF.message ? ePoF.message : ePoF));
        }
    }
    _restoreUnits();

    return {
        aborted: false,
        blocked: blocked,
        skipStyleCleanup: true,
        locatePlan: locatePlan,
        applyResults: applyResults,
        preflight: report.preflight,
        postflight: report.postflight
    };
}

// ─── Build stamp (arch it-gate diag — prove WHICH v2_pipeline the host loaded) ───
// import_integrated logs V2Pipeline.__V2_BUILD_STAMP right after the begin line.
// BUMP the probe suffix per iteration. Discriminator:
//   • stamp ABSENT in host log  → loaded module predates this code = STALE /
//     wrong-checkout (require cache OR junction → another checkout). The 19364d7
//     faithful gate is NOT active. Then: restart InDesign + re-run — stamp now
//     appears ⇒ was require-cache (H1); stamp still absent ⇒ junction loads a
//     different on-disk file (H2).
//   • stamp PRESENT but bold still missing → gate loaded fine; read the
//     "emphasis target-side:" summary (applied=N): N>0 ⇒ runs landed → invisibility
//     is H3 (font face unresolved / script-font enforcer overwrite), NOT the gate.
var __V2_BUILD_STAMP = "19364d7-faithful-gate probeA";
var __V2_MODULE_DIR = (typeof __dirname !== "undefined" && __dirname) ? String(__dirname) : "<undef>";

module.exports = {
    runPipeline: runPipeline,
    runMinimalApply: runMinimalApply,
    applyOnePara: applyOnePara,
    // #ac-overset-widen: PASS 2 driver — call after settling the layout with a save.
    runEmphasisSettlePass: runEmphasisSettlePass,
    _shouldClearParaOverrides: _shouldClearParaOverrides,
    _sbAssembleMergedTarget: _sbAssembleMergedTarget,
    __V2_BUILD_STAMP: __V2_BUILD_STAMP,
    __V2_MODULE_DIR: __V2_MODULE_DIR
};
