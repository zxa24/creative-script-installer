"use strict";

/**
 * lib/style_applier.js
 *
 * Phase 3 MVP — apply style sheet to paragraphs + cleanup
 *
 * Plan reference:
 *   task_plan.md "Phase 3: Import 端逐段套样式"
 *
 * Two main entry points:
 *
 *   applyClusterStyleToParagraph(para, sheet, locateResult, plan, deps)
 *     For ONE locate result whose para is non-null:
 *     - look up the matching _T_p_* style by paragraph fingerprint
 *     - assign para.appliedParagraphStyle
 *     Does NOT write text (caller does para.contents = target).
 *     Does NOT apply annotations[] (caller calls applyAnnotationsToRange).
 *     Returns {applied: bool, paraStyleName?, reason?}
 *
 *   applyAnnotationsToParagraph(para, annotations, sheet, deps)
 *     Apply translations.annotations[] (TODO #1 format) to a paragraph.
 *     For each annotation, JIT create _T_c_annotation_* via
 *     ensureAnnotationCharStyle and apply via characters.itemByRange.
 *     Translator-coordinate offsets — no source run offset hack.
 *     Returns [{ann, applied: bool, charStyleName?, reason?}, ...]
 *
 *   clearTranslationStyles(workDoc, options, deps)
 *     C15 / E5c undo tool: remove all _T_*-prefixed styles. Paragraphs
 *     that referenced removed styles fall back to options.fallbackStyle
 *     (default: [Basic Paragraph]).
 *     Returns {removedParaStyles: [...names], removedCharStyles: [...names],
 *              paragraphsReset: N}
 *
 * UXP / ExtendScript compatibility:
 *   - Pure module + deps injection
 *   - var only, no ES6+
 *   - deps:
 *       ensureAnnotationCharStyle  — from lib/style_sheet_builder.js
 *       fingerprintParagraph       — from lib/style_sheet_builder.js
 *       (both passed in, not require'd, to keep this lib decoupled)
 */

// fix-faux-latin-italic: shared script-aware italic applier (CJK→faux skew,
// Latin-with-real-italic→real italic). Pure-at-load leaf, safe to require here.
var ItalicApply = require("./italic_apply.js");
var FontItalicProbe = require("./font_italic_probe.js");   // univ-italic: weight-exact italic probe (OQ-2)
var ItalicConfig = require("./italic_config.js");          // univ-italic: per-weight italic HOW config
var AutoFormatGate = require("./auto_format_gate.js");

// emphasis→combined-char-style refactor (SPEC §14): the new
// applyEmphasisRunsAsCharStyles helper reuses pure-leaf splitter +
// style_sheet_builder font/props helpers (via its _internal namespace).
// Both are pure-at-load leaves, safe to require here (style_applier already
// requires italic_apply; cross-lib require has precedent).
var ScriptSplit = require("./script_split.js");
var SSB = require("./style_sheet_builder.js");

// ─── Helpers ──────────────────────────────────────────────────────

function _getCollectionItem(coll, idx) {
    if (!coll) return null;
    if (typeof coll.item === "function") return coll.item(idx);
    return coll[idx];
}

// ─── applyClusterStyleToParagraph ─────────────────────────────────

/**
 * Apply the matching _T_p_* style to a single paragraph.
 *
 * @param {Paragraph} para — workDoc Paragraph (must be non-null; caller filtered)
 * @param {Object} sheet — return value of commitStylePlan
 * @param {Object} locateResult — single LocateResult from segment_locator
 * @param {Object} plan — the StylePlan that produced the sheet
 * @param {Object} deps — { fingerprintParagraph } from style_sheet_builder
 * @returns {Object} {applied, paraStyleName?, reason?}
 */
function applyClusterStyleToParagraph(para, sheet, locateResult, plan, deps, opts) {
    if (!para) return { applied: false, reason: "para_null" };
    if (!sheet || !sheet.paraStyleMap) return { applied: false, reason: "no_paraStyleMap" };
    if (!locateResult || !locateResult.seg) return { applied: false, reason: "no_locateResult" };
    if (!deps || typeof deps.fingerprintParagraph !== "function") {
        return { applied: false, reason: "missing_fingerprint_dep" };
    }
    opts = opts || {};

    var seg = locateResult.seg;
    if (!seg.format_snapshot || !seg.paragraph_snapshot) {
        return { applied: false, reason: "missing_snapshots" };
    }

    var fp;
    try {
        // Use plan's fingerprint config so apply-time hashes match build-time
        // hashes when caller restricted dimensions (e.g. only font/size/color).
        var fpOpts = (plan && plan.fingerprintOpts) || { tolerance: undefined, dimensions: null };
        fp = deps.fingerprintParagraph(seg.paragraph_snapshot, seg.format_snapshot.baseline, fpOpts.tolerance, fpOpts.dimensions);
        // #28: when splitMasterFromBody is enabled, the build-time cluster
        // keys are prefixed with "M:" or "B:" based on seg.is_master.
        // Apply must prepend the same prefix so paraStyleMap lookup hits.
        if (fp && fpOpts.splitMasterFromBody) {
            fp = (seg.is_master ? "M:" : "B:") + fp;
        }
    } catch (e) {
        return { applied: false, reason: "fingerprint_failed: " + e.message };
    }

    var paraStyleObj = sheet.paraStyleMap[fp];
    if (!paraStyleObj) {
        return { applied: false, reason: "no_para_style_match", fingerprint: fp };
    }

    try {
        para.appliedParagraphStyle = paraStyleObj;
    } catch (e) {
        return { applied: false, reason: "appliedParagraphStyle_failed: " + e.message };
    }

    // Cascade normalization (opts.normalizeCascade — used by reorganize):
    // After assigning the new paragraph style, the source paragraph may
    // still have an applied character style (e.g. "Character Style 1") and
    // direct character overrides (font/size/color) layered on top. These
    // can leak through and contradict the new style — the canonical case
    // is the master-page "edwardjones.ca" issue where Character Style 1's
    // 13pt Black + cleared direct overrides made text become 13pt black
    // even though the new style defined 10pt Paper.
    //
    // Since the new style was BUILT from the captured visual (already the
    // resolved cascade output), normalizing chars to "[None]" + clearing
    // direct overrides yields a paragraph whose visual exactly matches
    // what was captured.
    //
    // Phase 8B: a uniform=false paragraph that was processed by
    // applyEmphasisExtraction now carries `emphasisRuns` describing the
    // per-character overrides that need to be restored AFTER cascade
    // normalize via applyEmphasisRunsToParagraph. So normalize is safe
    // when:
    //   - uniform === true (the only-pre-8B case), OR
    //   - emphasisRuns exists  (8B promoted overrides into char styles)
    // The remaining "uniform=false without emphasisRuns" branch is the
    // legacy-capture / failed-extraction case — keep the runs as-is.
    var fs = seg.format_snapshot;
    var canNormalize = !!opts.normalizeCascade && fs && (fs.uniform !== false || (fs.emphasisRuns !== undefined));
    var preserveStats = { captured: 0, restored: 0, failed: [] };
    var directOverrideStats = { captured: 0, restored: 0, failed: [] };
    if (canNormalize) {
        // Designer-applied character styles (anything NOT prefixed with `_T_`
        // and NOT `[None]`) MUST be preserved across normalize. The extractor
        // (lib/emphasis_extractor.js _isSelfMarkedHint) deliberately skips
        // these ranges so they're "preserve as-is" — which means our normalize
        // wipe followed by emphasisRuns re-apply would otherwise clobber them
        // (the runs only describe pipeline-managed _T_c_*, not designer
        // styles). Snapshot ranges before wipe + restore after.
        var preservedRanges = _captureDesignerCharStyleRanges(para);
        preserveStats.captured = preservedRanges.length;

        // #27: ALSO capture direct character overrides (capitalization /
        // fillColor / pointSize) before normalize wipes them. The cluster
        // pipeline doesn't carry these properties in fingerprintDimensions
        // → they fall through normalize+apply with no replacement. Without
        // this capture: ALL_CAPS char overrides on `[None]`-styled chars
        // become NORMAL after apply (lost the visual all-caps), and Paper
        // fillColor overrides on top of designer char styles fall back to
        // the char style's defined Black (lost the white-on-dark link).
        // See DEV_LOG fix #27 for the bottom-strip + edwardjones.ca cases.
        var directOverrideRanges = _captureDirectCharOverrideRanges(para);
        directOverrideStats.captured = directOverrideRanges.length;

        try {
            var doc = null;
            try { doc = para.parentStory.parent; } catch (eDoc) {}
            if (doc) {
                var noneCS = null;
                try { noneCS = doc.characterStyles.itemByName("[None]"); } catch (eCS) {}
                if (noneCS && noneCS.isValid) {
                    try { para.texts.everyItem().appliedCharacterStyle = noneCS; } catch (eAcs) {}
                }
            }
        } catch (eNorm1) {}
        try { para.texts.everyItem().clearOverrides(); } catch (eNorm2) {}

        // Restore designer ranges. Done AFTER clearOverrides so the
        // re-applied char style wins (clearOverrides also strips a freshly
        // assigned char style, hence the ordering).
        var restoreResult = _restoreDesignerCharStyleRanges(para, preservedRanges);
        preserveStats.restored = restoreResult.restored;
        preserveStats.failed = restoreResult.failed;

        // #27: replay direct char overrides AFTER designer char styles are
        // restored. Order matters because assigning a char style itself
        // resets per-char direct overrides on that range; replaying the
        // overrides last makes them stick. Note these are stamped as
        // character-level overrides on top of whatever char style the
        // restore just set (or [None]) — InDesign treats them as design-
        // intentional rather than auto-managed.
        var directRestoreResult = _restoreDirectCharOverrideRanges(para, directOverrideRanges);
        directOverrideStats.restored = directRestoreResult.restored;
        directOverrideStats.failed = directRestoreResult.failed;
    }
    // Note: caller may also call clearParaCharOverrides() AFTER content
    // rewrite (translation pipeline path) — same goal, different timing.

    return {
        applied: true,
        paraStyleName: paraStyleObj.name,
        designerCharStylesPreserved: preserveStats.captured,
        designerCharStylesRestored: preserveStats.restored,
        designerCharStylesFailed: preserveStats.failed,
        directOverridesPreserved: directOverrideStats.captured,
        directOverridesRestored: directOverrideStats.restored,
        directOverridesFailed: directOverrideStats.failed,
        // #27: surface captured override ranges so the caller (v2_pipeline)
        // can re-apply them AFTER applyEmphasisRunsToParagraph, which sets
        // appliedCharacterStyle on subranges and thereby resets the direct
        // overrides we just restored. Without this second-pass replay,
        // emp char styles silently wipe ALL_CAPS / Paper / pointSize.
        directOverrideRanges: (canNormalize ? directOverrideRanges : null)
    };
}

// Walk a paragraph and group consecutive characters by their applied
// character-style name. Yields ranges only for non-pipeline names, i.e.
// skip `[None]` and any `_T_*` (those are pipeline-managed and will be
// re-set by applyEmphasisRunsToParagraph or by normalize itself).
//
// Returns: [{startOffset, endOffset, styleName, styleRef}, ...]
//   - offsets are paragraph-relative (0..para.characters.length-1, inclusive)
//   - styleRef captured at scan time so later restore avoids itemByName lookup
function _captureDesignerCharStyleRanges(para) {
    var out = [];
    if (!para) return out;
    var chars;
    try { chars = para.characters; } catch (e) { return out; }
    var n;
    try { n = chars.length; } catch (e) { return out; }
    if (!n) return out;

    var run = null;  // { start, end, name, ref }
    for (var i = 0; i < n; i++) {
        var name = "";
        var ref = null;
        try {
            ref = chars.item(i).appliedCharacterStyle;
            name = String(ref && ref.name);
        } catch (eC) { name = ""; }

        var keep = name && name !== "[None]" && name.indexOf("_T_") !== 0;
        if (run && keep && name === run.name) {
            run.end = i;
            continue;
        }
        if (run) { out.push(run); run = null; }
        if (keep) {
            run = { start: i, end: i, name: name, ref: ref };
        }
    }
    if (run) out.push(run);
    return out;
}

// Re-apply each captured designer range to the paragraph. Uses
// itemByRange on para.characters with the saved offsets. Failures are
// captured per-range so the caller can surface them (they indicate
// data loss, not a benign warning).
function _restoreDesignerCharStyleRanges(para, ranges) {
    var stats = { restored: 0, failed: [] };
    if (!para || !ranges || !ranges.length) return stats;
    for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        if (!r || !r.ref) {
            stats.failed.push({ start: r ? r.start : -1, end: r ? r.end : -1, styleName: r ? r.name : "", reason: "no_ref" });
            continue;
        }
        try {
            var range = para.characters.itemByRange(r.start, r.end);
            range.appliedCharacterStyle = r.ref;
            stats.restored++;
        } catch (e) {
            stats.failed.push({ start: r.start, end: r.end, styleName: r.name, reason: (e && e.message) || String(e) });
        }
    }
    return stats;
}

// #27: Capture direct character-level overrides for properties the
// cluster pipeline doesn't carry through (fingerprintDimensions misses
// these; normalize wipes them; apply doesn't restore them).
//
// Properties tracked:
//   - capitalization  (NORMAL / ALL_CAPS / SMALL_CAPS / CAP_TO_SMALL_CAPS)
//   - fillColor       (Swatch ref — captured by reference so post-apply
//                      doesn't have to itemByName)
//   - pointSize       (Number — char-level size override on top of para)
//
// Group consecutive characters sharing the same {capitalization,
// fillColorId, pointSize} into one run. Ranges of "everything default"
// (NORMAL caps + para-style fillColor + para-style pointSize) are
// emitted too, but the restore is a no-op-equivalent (re-stamps same
// values) — cheap and safe. Returns [{ start, end, capitalization,
// fillColorRef, pointSize }, ...].
function _captureDirectCharOverrideRanges(para) {
    var out = [];
    if (!para) return out;
    var chars;
    try { chars = para.characters; } catch (e) { return out; }
    var n;
    try { n = chars.length; } catch (e) { return out; }
    if (!n) return out;

    function _read(i) {
        var caps = "", fcRef = null, fcId = "", pt = null;
        var ch = chars.item(i);
        try { caps = String(ch.capitalization); } catch (eCp) {}
        try {
            fcRef = ch.fillColor;
            if (fcRef && fcRef.isValid) {
                try { fcId = String(fcRef.id); } catch (eFid) { fcId = String(fcRef.name || ""); }
            }
        } catch (eFc) {}
        try { pt = ch.pointSize; } catch (ePt) {}
        return { caps: caps, fcRef: fcRef, fcId: fcId, pt: pt };
    }

    var run = null;
    for (var i = 0; i < n; i++) {
        var v = _read(i);
        var sigSame = run && run.caps === v.caps && run.fcId === v.fcId && run.pt === v.pt;
        if (sigSame) {
            run.end = i;
            continue;
        }
        if (run) out.push(run);
        run = { start: i, end: i, caps: v.caps, fcRef: v.fcRef, fcId: v.fcId, pt: v.pt };
    }
    if (run) out.push(run);
    return out;
}

// Re-apply captured direct char overrides AFTER normalize+apply (and
// AFTER designer char styles are restored, since assigning a char
// style resets character-level overrides on that range — replaying
// last makes overrides stick).
//
// Each property is set independently so a single failure (e.g.
// fillColor swatch became invalid) doesn't block the other two.
//
// Capitalization caveat: InDesign's `capitalization` property is a
// Capitalization enum, not a string. Setting `range.capitalization =
// "ALL_CAPS"` is silently rejected (or coerces to NORMAL) in UXP —
// the property writer requires the actual enum value. We resolve the
// enum lazily through `require("indesign").Capitalization`, falling
// back to a string assignment for environments where the require
// returns nothing (test harness mocks).
var _CapitalizationEnum = null;
function _resolveCapitalizationEnum() {
    if (_CapitalizationEnum) return _CapitalizationEnum;
    try {
        var idsn = require("indesign");
        if (idsn && idsn.Capitalization) { _CapitalizationEnum = idsn.Capitalization; return _CapitalizationEnum; }
    } catch (e) {}
    // Some UXP runtimes expose enums via app properties or globals
    try { if (typeof Capitalization !== "undefined" && Capitalization) { _CapitalizationEnum = Capitalization; return _CapitalizationEnum; } } catch (eG) {}
    return null;
}

function _restoreDirectCharOverrideRanges(para, ranges) {
    var stats = { restored: 0, failed: [] };
    if (!para || !ranges || !ranges.length) return stats;
    var capsEnum = _resolveCapitalizationEnum();
    for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        if (!r) continue;
        var range = null;
        try { range = para.characters.itemByRange(r.start, r.end); }
        catch (eIB) {
            stats.failed.push({ start: r.start, end: r.end, reason: "itemByRange:" + ((eIB && eIB.message) || String(eIB)) });
            continue;
        }
        var anyOk = false;
        var fails = [];
        if (r.caps) {
            // Resolve the enum value dynamically — the captured string
            // looks like "ALL_CAPS" / "NORMAL" / "SMALL_CAPS" /
            // "CAP_TO_SMALL_CAPS" and maps directly to enum keys.
            try {
                var enumVal = (capsEnum && capsEnum[r.caps]);
                if (enumVal !== undefined && enumVal !== null) {
                    range.capitalization = enumVal;
                    anyOk = true;
                } else {
                    // Fallback: try string assignment (works in some test mocks)
                    range.capitalization = r.caps;
                    anyOk = true;
                }
            } catch (eC) { fails.push("caps:" + ((eC && eC.message) || String(eC))); }
        }
        if (r.fcRef) {
            try {
                if (r.fcRef.isValid) { range.fillColor = r.fcRef; anyOk = true; }
            } catch (eF) { fails.push("fillColor:" + ((eF && eF.message) || String(eF))); }
        }
        if (r.pt !== null && r.pt !== undefined) {
            try { range.pointSize = r.pt; anyOk = true; }
            catch (ePt) { fails.push("pointSize:" + ((ePt && ePt.message) || String(ePt))); }
        }
        if (anyOk) { stats.restored++; }
        if (fails.length) {
            stats.failed.push({ start: r.start, end: r.end, reason: fails.join("; ") });
        }
    }
    return stats;
}

/**
 * Strip character-level overrides on a paragraph so the just-assigned
 * paragraph style's defaults (e.g. CJK appliedFont) actually take effect.
 *
 * Without this, source content's Latin font sticks on the new characters
 * via inherit-from-prior-run semantics → CJK chars render as tofu and
 * the line never breaks correctly (frame goes overset).
 *
 * Uses para.texts.everyItem().clearOverrides() rather than
 * para.clearOverrides() — the para-level call accepts an OverrideType
 * argument that requires an enum, while the text-collection call
 * unconditionally clears character overrides.
 */
function clearParaCharOverrides(para) {
    if (!para) return false;
    try {
        var texts = para.texts;
        if (texts && texts.length > 0) {
            texts.everyItem().clearOverrides();
            return true;
        }
    } catch (e) {}
    // Fallback: per-character clear (slow but reliable)
    try {
        var chars = para.characters;
        for (var i = 0; i < chars.length; i++) {
            try { chars.item(i).clearOverrides(); } catch (eC) {}
        }
        return true;
    } catch (e2) {}
    return false;
}

// ─── applyAnnotationsToParagraph ──────────────────────────────────

/**
 * Apply translations.annotations[] to a paragraph. annotation.offset/length
 * are in TARGET text coordinates (per TODO #1 design).
 *
 * @param {Paragraph} para — workDoc Paragraph (already has target text written)
 * @param {Array} annotations — array of {type, action, offset, length, value?}
 * @param {Document} workDoc — needed for ensureAnnotationCharStyle
 * @param {Object} sheet — return value of commitStylePlan
 * @param {Object} deps — { ensureAnnotationCharStyle, [colorSpace, position] }
 * @returns {Array} per-annotation result objects
 */
function applyAnnotationsToParagraph(para, annotations, workDoc, sheet, deps) {
    if (!annotations || annotations.length === 0) return [];
    if (!deps || typeof deps.ensureAnnotationCharStyle !== "function") {
        throw new Error("applyAnnotationsToParagraph: deps.ensureAnnotationCharStyle required");
    }

    var results = [];
    var paraCharCount;
    try { paraCharCount = para.characters.length; } catch (e) { paraCharCount = 0; }

    for (var i = 0; i < annotations.length; i++) {
        var ann = annotations[i];
        // Cross-repo policy gate: AI / heuristic annotations (ann._auto ===
        // true) are NOT translator-confirmed → never applied. The webapp
        // markers path projects marker-derived emphasis onto annotations[]
        // with _auto:true expecting the import pipeline to drop them. This is
        // the single chokepoint for the main annotation-apply path; the two
        // doc-wide passes (BRIDGE-39 / BRIDGE-41) gate via the same predicate.
        // See lib/auto_format_gate.js + CLAUDE.md「跨仓政策」.
        if (AutoFormatGate.isAutoAnnotation(ann)) {
            results.push({ ann: ann, applied: false, reason: "auto_skipped" });
            continue;
        }
        if (!ann || ann.type !== "format") {
            results.push({ ann: ann, applied: false, reason: "not_format_annotation" });
            continue;
        }
        // TODO#15 B2: cross-repo no-auto-propagation policy. Annotations the
        // translator did NOT manually mark carry `_auto: true` (an AI/heuristic
        // echo of the SOURCE format). Treat them as unset — the SAME gate the
        // emphasis path applies via `target_emphasis_runs_auto` (v2_pipeline.js
        // :683). Without this, an `_auto` size/format annotation leaks past the
        // policy (it was only ever "saved" by the size action being unimplemented;
        // once B1 makes size apply, an `_auto` size would WRONGLY override). The
        // per-annotation `_auto` field was previously never read anywhere.
        if (ann._auto === true) {
            results.push({ ann: ann, applied: false, reason: "auto_skipped" });
            continue;
        }
        if (typeof ann.offset !== "number" || typeof ann.length !== "number") {
            results.push({ ann: ann, applied: false, reason: "invalid_offset_length" });
            continue;
        }
        if (ann.length <= 0) {
            results.push({ ann: ann, applied: false, reason: "zero_length" });
            continue;
        }
        // Bound-check: offset must be within paragraph
        if (ann.offset < 0 || ann.offset >= paraCharCount) {
            results.push({
                ann: ann,
                applied: false,
                reason: "offset_out_of_range",
                offset: ann.offset,
                paraCharCount: paraCharCount
            });
            continue;
        }
        // Truncate range to paragraph length (translator may have miscounted)
        var safeEnd = Math.min(ann.offset + ann.length, paraCharCount);
        if (safeEnd <= ann.offset) {
            results.push({ ann: ann, applied: false, reason: "empty_safe_range" });
            continue;
        }

        // #33 (G1 import-side): "link" annotations from webapp are
        // doc-level Hyperlink objects, NOT character styles. Resolve
        // the text range, find / create a URL destination, create
        // HyperlinkTextSource + Hyperlink at that range. Skip the
        // ensureAnnotationCharStyle path entirely for this action.
        if (ann.action === "link") {
            var url = (ann.url || "").trim();
            if (!url) {
                results.push({ ann: ann, applied: false, reason: "link_missing_url" });
                continue;
            }
            var lnkRange = null;
            try { lnkRange = para.characters.itemByRange(ann.offset, safeEnd - 1); }
            catch (eLR) {}
            if (!lnkRange) {
                results.push({ ann: ann, applied: false, reason: "link_range_failed" });
                continue;
            }
            // Find / create URL destination (idempotent by URL string).
            var destObj = null;
            try {
                var dests = workDoc.hyperlinkURLDestinations;
                for (var __di = 0; __di < dests.length; __di++) {
                    try {
                        var dCand = dests.item(__di);
                        if (String(dCand.destinationURL) === url) { destObj = dCand; break; }
                    } catch (eDi) {}
                }
                if (!destObj) {
                    destObj = workDoc.hyperlinkURLDestinations.add({
                        destinationURL: url,
                        name: "_T_HL_dest_" + ((Date.now() + i) >>> 0)
                    });
                }
            } catch (eD) {
                results.push({ ann: ann, applied: false, reason: "link_dest_failed: " + (eD && eD.message ? eD.message : eD) });
                continue;
            }
            // Create source + hyperlink. Wrap each in its own try so we can
            // surface which step failed (range vs source vs link) for the
            // partial-failure summary.
            //
            // #E2E-9 idempotency: when the source doc already carries a
            // Hyperlink whose source covers (a superset of) our intended
            // range with the same URL, InDesign refuses
            // `hyperlinkTextSources.add(lnkRange)` with "The object you have
            // chosen is already in use by another hyperlink." This happens
            // on identity translations and on incremental re-imports where
            // a prior pass already created the hyperlink. Detect it and
            // reuse the existing source instead of failing the annotation.
            var srcObj = null;
            var reusedExisting = false;
            try {
                srcObj = workDoc.hyperlinkTextSources.add(lnkRange, {
                    name: "_T_HL_src_" + ((Date.now() + i) >>> 0)
                });
            } catch (eS) {
                // Try to find an existing HyperlinkTextSource overlapping
                // lnkRange with a matching URL. If found, reuse it (treat
                // the annotation as already applied — no Hyperlink needs
                // to be re-created).
                var existingHl = null;
                try {
                    // #E2E-9b: Derive range bounds directly from para start +
                    // annotation offset/length. The earlier approach used
                    // `lnkRange.characters.length` which silently returns 0
                    // in UXP for a freshly-created itemByRange ref, making
                    // rangeEnd = -1 and breaking the overlap test.
                    var rangeStart = -1, rangeEnd = -1;
                    try {
                        var paraStartIdx = para.characters.item(0).index;
                        rangeStart = paraStartIdx + ann.offset;
                        rangeEnd   = paraStartIdx + safeEnd - 1;
                    } catch (eIdx) {}
                    if (rangeStart >= 0 && rangeEnd >= rangeStart) {
                        // #E2E-9c: accept ANY same-URL hyperlink that
                        // overlaps our range. Source docs sometimes split
                        // one logical link into multiple Hyperlink objects
                        // (e.g., Client-A Product-3: "Client-A Product-3..." + "®*万事达卡®*"
                        // are two hyperlinks with the same URL). The merge
                        // step in export emits ONE combined source_link, so
                        // by the time we apply the annotation we hit BOTH
                        // existing hyperlinks — neither fully covers the
                        // merged range. Treat the presence of ANY same-URL
                        // hyperlink overlapping our range as "already
                        // linked"; we'll stamp underline + char style on
                        // the FULL range so the visual matches even at
                        // points the original hyperlinks didn't cover.
                        for (var __hi = 0; __hi < workDoc.hyperlinks.length; __hi++) {
                            var hCand = workDoc.hyperlinks.item(__hi);
                            var hUrl = "";
                            try { hUrl = String(hCand.destination.destinationURL); } catch (eHU) {}
                            if (hUrl !== url) continue;
                            var hSrc = null;
                            try { hSrc = hCand.source.sourceText; } catch (eHS) {}
                            if (!hSrc) continue;
                            var hStart = -1, hEnd = -1;
                            try {
                                hStart = hSrc.characters.item(0).index;
                                var hc = hSrc.characters.length;
                                hEnd = hSrc.characters.item(hc - 1).index;
                            } catch (eHIdx) {}
                            if (hStart < 0 || hEnd < hStart) continue;
                            // Any overlap with our range counts.
                            var overlapsAny = !(hEnd < rangeStart || hStart > rangeEnd);
                            if (overlapsAny) {
                                existingHl = hCand;
                                break;
                            }
                        }
                    }
                } catch (eScan) {}
                // #E2E-DIAG: capture scan diagnostics
                var scanDiag = { rangeStart: rangeStart, rangeEnd: rangeEnd, hyperlinkCount: 0, urlMatches: 0, rangeMatches: 0, candidates: [] };
                try {
                    scanDiag.hyperlinkCount = workDoc.hyperlinks.length;
                    for (var __hi2 = 0; __hi2 < workDoc.hyperlinks.length; __hi2++) {
                        var hCand2 = workDoc.hyperlinks.item(__hi2);
                        var hUrl2 = ""; try { hUrl2 = String(hCand2.destination.destinationURL); } catch(e){}
                        var hSrc2 = null; try { hSrc2 = hCand2.source.sourceText; } catch(e){}
                        var hStart2 = -1, hEnd2 = -1;
                        try {
                            hStart2 = hSrc2.characters.item(0).index;
                            var hc2 = hSrc2.characters.length;
                            hEnd2 = hSrc2.characters.item(hc2 - 1).index;
                        } catch(e){}
                        var urlMatch = hUrl2 === url;
                        var rangeCover = hStart2 <= rangeStart && hEnd2 >= rangeEnd;
                        if (urlMatch) scanDiag.urlMatches++;
                        if (rangeCover) scanDiag.rangeMatches++;
                        if (urlMatch || (hStart2 >= 0 && Math.abs(hStart2 - rangeStart) < 100)) {
                            scanDiag.candidates.push({ idx: __hi2, url: hUrl2.slice(0, 60), hStart: hStart2, hEnd: hEnd2, urlMatch: urlMatch, rangeCover: rangeCover });
                        }
                    }
                } catch(eDg) { scanDiag.error = String(eDg); }
                // Persist last diag for inspection
                try { workDoc._lastE2EScanDiag = scanDiag; } catch(eP) {}
                if (existingHl) {
                    // #E2E-9d: Re-resolve range fresh before stamping. The
                    // earlier lnkRange ref may have been invalidated by the
                    // failed `hyperlinkTextSources.add` attempt or by the
                    // characterStyles.add() inside this branch (UXP DOM
                    // refs can become stale across structural operations).
                    var freshRangeR = null;
                    try { freshRangeR = para.characters.itemByRange(ann.offset, safeEnd - 1); }
                    catch (eFR) {}
                    var reuseDiag = { csCreated: false, csApplied: false, underlineSet: false, errors: [] };
                    if (freshRangeR) {
                        // Ensure _T_c_link char style exists FIRST (before
                        // touching the range) so the add() can't invalidate
                        // the range we're about to write to.
                        var linkCsR = null;
                        try {
                            var csNameR = "_T_c_link";
                            try { linkCsR = workDoc.characterStyles.itemByName(csNameR); } catch (eCsLkR) {}
                            try { if (!linkCsR || !linkCsR.isValid) linkCsR = null; } catch (eCsLkR2) { linkCsR = null; }
                            if (!linkCsR) {
                                linkCsR = workDoc.characterStyles.add({ name: csNameR });
                                try { linkCsR.underline = true; reuseDiag.csCreated = true; }
                                catch (eUlR) { reuseDiag.errors.push("csUnderline: " + eUlR.message); }
                            }
                        } catch (eCsR) { reuseDiag.errors.push("csLookup: " + eCsR.message); }

                        // Re-fetch range AGAIN after potential char style add.
                        var freshRangeR2 = null;
                        try { freshRangeR2 = para.characters.itemByRange(ann.offset, safeEnd - 1); }
                        catch (eFR2) { reuseDiag.errors.push("refetchRange: " + eFR2.message); }
                        var targetRange = freshRangeR2 || freshRangeR;

                        if (linkCsR) {
                            try { targetRange.appliedCharacterStyle = linkCsR; reuseDiag.csApplied = true; }
                            catch (eAppCsR) { reuseDiag.errors.push("applyCs: " + eAppCsR.message); }
                        }
                        // Direct underline override AFTER char style — survives
                        // even if a later step swaps the char style.
                        try { targetRange.underline = true; reuseDiag.underlineSet = true; }
                        catch (eDirU2) { reuseDiag.errors.push("underline: " + eDirU2.message); }
                    } else {
                        reuseDiag.errors.push("no freshRangeR");
                    }
                    results.push({
                        ann: ann,
                        applied: true,
                        hyperlinkName: String(existingHl.name),
                        url: url,
                        reused: true,
                        reuseDiag: reuseDiag,
                        truncatedRange: (safeEnd < ann.offset + ann.length)
                    });
                    continue;
                }
                results.push({
                    ann: ann, applied: false,
                    reason: "link_source_failed: " + (eS && eS.message ? eS.message : eS),
                    scanDiag: scanDiag
                });
                continue;
            }
            try {
                var hlName = "_T_HL_" + ((Date.now() + i) >>> 0);
                var newHl = workDoc.hyperlinks.add(srcObj, destObj, { name: hlName });
                // #33: apply a visible char style to the source range —
                // InDesign Hyperlink objects DO NOT alter text appearance
                // by themselves (the URL is metadata for PDF/EPUB export
                // only). Without a char style assignment the translator
                // who marked the link in the webapp wouldn't see any
                // visual feedback. Find/create `_T_c_link` with
                // underline=true and assign to source range + to the
                // hyperlink's source.appliedCharacterStyle so future
                // reorganize / cluster-style passes preserve it via
                // the #3 designer-char-style preserve channel.
                var linkCs = null;
                try {
                    var csName = "_T_c_link";
                    try { linkCs = workDoc.characterStyles.itemByName(csName); } catch (eCsLk) {}
                    try { if (!linkCs || !linkCs.isValid) linkCs = null; } catch (eCsLk2) { linkCs = null; }
                    if (!linkCs) {
                        linkCs = workDoc.characterStyles.add({ name: csName });
                        try { linkCs.underline = true; } catch (eUl) {}
                    }
                } catch (eCs) {}
                if (linkCs) {
                    try { lnkRange.appliedCharacterStyle = linkCs; } catch (eAppCs) {}
                    // Also stamp on the hyperlink's source itself so it
                    // round-trips through any subsequent export/re-apply.
                    try { if (newHl && newHl.source) newHl.source.appliedCharacterStyle = linkCs; } catch (eHCs) {}
                }
                // #E2E-6: Belt-and-braces — also stamp underline directly on
                // the range as a character-level local override. If reorganize
                // later removes or renames `_T_c_link` (we saw this in the
                // Client-A e2e: the char style was absent post-import), the direct
                // property survives independently of char-style cleanup.
                // Without this, links lose their underline visual when their
                // paragraph cluster's winner is `under:false`.
                try { lnkRange.underline = true; } catch (eDirU) {}
                results.push({
                    ann: ann,
                    applied: true,
                    hyperlinkName: hlName,
                    url: url,
                    charStyleName: linkCs ? linkCs.name : null,
                    truncatedRange: (safeEnd < ann.offset + ann.length)
                });
            } catch (eH) {
                // Clean up the dangling source so we don't litter the doc.
                try { srcObj.remove(); } catch (eClean) {}
                results.push({ ann: ann, applied: false, reason: "link_add_failed: " + (eH && eH.message ? eH.message : eH) });
            }
            continue;
        }

        // #BRIDGE-40: apply non-link annotations as DIRECT character
        // overrides instead of single-CS-per-annotation. Previous strategy
        // (one CS per annotation, `range.appliedCharacterStyle = cs`)
        // OVERWROTE the prior CS on the same range — InDesign chars carry
        // exactly one appliedCharacterStyle. When the translator marked the
        // same range with multiple annotations (e.g. link + color +
        // underline + italic at chars 0..13), only the LAST CS survived;
        // the link's underline visual, the blue color, etc. were all lost.
        //
        // Direct overrides layer on top of whatever CS is present and on
        // top of each other, so multiple annotations on one range compose
        // naturally. The `link` action above still creates a Hyperlink
        // object + `_T_c_link` CS (kept for click-through + visible CS
        // signal in the Character Styles panel); subsequent color/
        // underline annotations on the same range now layer onto it as
        // direct overrides rather than wiping it.
        //
        // For `italic` (fix-faux-latin-italic): script-aware. CJK runs get
        // faux skew=15 (no fontStyle=Italic → no missing-font tofu); non-CJK
        // runs whose font has a real italic variant (e.g. Whitney Book Italic)
        // get REAL italic, the rest faux skew. The old code stamped skew on the
        // whole range — over-slanting / downgrading Latin in mixed CJK+Latin
        // annotations. See lib/italic_apply.js.
        try {
            var range = para.characters.itemByRange(ann.offset, safeEnd - 1);
            var applied = false;
            var detail = null;
            if (ann.action === "bold") {
                try { range.fontStyle = "Bold"; applied = true; detail = "fontStyle=Bold"; } catch (eB) { detail = "bold_failed: " + eB.message; }
            } else if (ann.action === "italic") {
                // univ-italic ② (乙 STRICT): config-gated. Unconfigured / block / desync
                // → upright + surfaced (non-silent), never auto-slant.
                var __itRes = ItalicApply.applyScriptAwareItalic({
                    charContainer: para.characters,
                    baseOffset: ann.offset,
                    endOffset: safeEnd - 1,
                    workDoc: workDoc,
                    italicConfig: (deps && deps.italicConfig) || null
                });
                applied = __itRes.ok;
                var __itSurf = (__itRes.surfaced && __itRes.surfaced.length) ? __itRes.surfaced.length : 0;
                detail = "italic(real=" + __itRes.realRuns + ",skew=" + __itRes.skewRuns +
                         (__itSurf ? ",surfaced=" + __itSurf : "") +
                         (__itRes.blocked ? ",blocked=" + __itRes.blocked : "") +
                         (__itRes.desync ? ",desync" : "") + ")";
            } else if (ann.action === "underline") {
                try { range.underline = true; applied = true; detail = "underline=true"; } catch (eU) { detail = "underline_failed: " + eU.message; }
            } else if (ann.action === "superscript") {
                if (deps && deps.position && deps.position.SUPERSCRIPT) {
                    try { range.position = deps.position.SUPERSCRIPT; applied = true; detail = "position=SUPERSCRIPT"; } catch (eSp) { detail = "superscript_failed: " + eSp.message; }
                } else {
                    detail = "no_position_enum";
                }
            } else if (ann.action === "color") {
                // Resolve / build the swatch (same logic as
                // ensureAnnotationCharStyle's color branch).
                var colorVal = ann.value || ann.color;
                if (colorVal && deps && deps.colorSpace) {
                    var swatch = null;
                    try { swatch = workDoc.swatches.itemByName(colorVal); } catch (eSw) {}
                    if (!swatch || !swatch.isValid) {
                        var hex = String(colorVal).replace(/^#/, "");
                        if (hex.length === 6) {
                            var r = parseInt(hex.substring(0, 2), 16);
                            var g = parseInt(hex.substring(2, 4), 16);
                            var b = parseInt(hex.substring(4, 6), 16);
                            var swatchName = "_T_c_color_" + hex;
                            try { swatch = workDoc.colors.itemByName(swatchName); } catch (eSwL) {}
                            if (!swatch || !swatch.isValid) {
                                try { workDoc.colors.add({ name: swatchName, space: deps.colorSpace.RGB, colorValue: [r, g, b] }); }
                                catch (eAdd) { detail = "color_create_failed: " + eAdd.message; }
                                // Re-fetch after add — fresh references from
                                // colors.add() can be silently rejected by
                                // range.fillColor when InDesign hasn't
                                // committed the swatch yet. itemByName /
                                // swatches lookup returns a stable handle.
                                try { swatch = workDoc.colors.itemByName(swatchName); } catch (eSwL2) {}
                                if ((!swatch || !swatch.isValid)) {
                                    try { swatch = workDoc.swatches.itemByName(swatchName); } catch (eSwL3) {}
                                }
                            }
                        }
                    }
                    if (swatch && swatch.isValid) {
                        try {
                            range.fillColor = swatch;
                            applied = true;
                            var __readBack = "?";
                            try {
                                var __ch0 = range.characters.item(0);
                                var __fc = __ch0.fillColor;
                                var __nm = "", __id = "", __sw = "";
                                try { __nm = String(__fc.name); } catch (eN) {}
                                try { __id = String(__fc.id); } catch (eI) {}
                                try { __sw = String(swatch.id); } catch (eS) {}
                                __readBack = "name=" + __nm + " id=" + __id + " swId=" + __sw + " match=" + (__id === __sw);
                            } catch (eRB) { __readBack = "err:" + eRB.message; }
                            detail = "fillColor=" + colorVal + " | " + __readBack;
                        } catch (eFc) { detail = "fillColor_set_failed: " + eFc.message; }
                    } else if (!detail) {
                        detail = "color_unresolved";
                    }
                } else {
                    detail = "color_missing_value_or_deps";
                }
            } else if (ann.action === "size") {
                // TODO#15 B1: per-run point-size override (e.g. a title run
                // bigger than its paragraph baseline). The value is in
                // `ann.size` (pt), NOT `ann.value` — the prior code fell into
                // the unknown-action fallback and called ensureAnnotationCharStyle
                // with `ann.value` (undefined) + no `size` branch → an EMPTY
                // `_T_c_annotation_size` char style (drift-hazards.md:21). Apply
                // directly as a character pointSize override (no char style).
                var __sz = Number(ann.size);
                if (isFinite(__sz) && __sz > 0) {
                    try { range.pointSize = __sz; applied = true; detail = "pointSize=" + __sz; }
                    catch (eSz) { detail = "size_failed: " + eSz.message; }
                } else {
                    detail = "size_missing_value";
                }
            } else {
                // Unknown action — fall back to the legacy CS path so we
                // don't silently drop annotations we haven't taught the
                // direct-override branch about yet.
                try {
                    var legacyCs = deps.ensureAnnotationCharStyle(workDoc, sheet, ann.action, ann.value, deps);
                    if (legacyCs) {
                        range.appliedCharacterStyle = legacyCs;
                        applied = true;
                        detail = "legacy_cs:" + legacyCs.name;
                    } else {
                        detail = "unknown_action_no_cs";
                    }
                } catch (eLegacy) {
                    detail = "unknown_action_cs_failed: " + eLegacy.message;
                }
            }
            results.push({
                ann: ann,
                applied: applied,
                reason: applied ? undefined : detail,
                detail: detail,
                truncatedRange: (safeEnd < ann.offset + ann.length)
            });
        } catch (e) {
            results.push({ ann: ann, applied: false, reason: "direct_override_failed: " + e.message });
        }
    }
    return results;
}

// ─── applyEmphasisRunsToParagraph (Phase 8B) ──────────────────────

/**
 * Re-apply Phase 8B emphasis character styles to a paragraph after the
 * paragraph style has been assigned and cascade-normalized.
 *
 * Reorganize flow only — the source paragraph text is unchanged so the
 * emphasisRun offsets (captured at export time) still index the same
 * characters. The translation flow must NOT call this: target text is
 * different from source, and translator-supplied annotations[] (handled
 * by applyAnnotationsToParagraph) carry the formatting intent for the
 * new text.
 *
 * @param {Paragraph} para       — workDoc paragraph
 * @param {Object}    sheet      — return value of commitStylePlan
 *                                 (must have empCharStyleMap)
 * @param {Object}    plan       — return value of buildStylePlan
 *                                 (must have empRunsBySegment)
 * @param {string}    segTid     — segment tid to look up apply records
 * @returns {Object} { applied: int, skippedNoStyle: int, skippedRangeFailed: int,
 *                     results: [{ start, end, charStyleName?, reason? }, ...] }
 */
function applyEmphasisRunsToParagraph(para, sheet, plan, segTid) {
    var summary = { applied: 0, skippedNoStyle: 0, skippedRangeFailed: 0, results: [] };
    if (!para) return summary;
    if (!sheet || !sheet.empCharStyleMap) return summary;
    if (!plan || !plan.empRunsBySegment) return summary;

    var apply = plan.empRunsBySegment[segTid];
    if (!apply || !apply.length) return summary;

    var paraCharCount;
    try { paraCharCount = para.characters.length; } catch (e) { paraCharCount = 0; }
    // The trailing CR is part of para.characters; emphasisRun ends never
    // include it (visual_snapshot strips trailing CR). itemByRange clamps
    // its right edge to characters - 1 so we just guard zero-len para.
    if (paraCharCount === 0) return summary;

    for (var i = 0; i < apply.length; i++) {
        var r = apply[i];
        var styleObj = sheet.empCharStyleMap[r.empFingerprint];
        if (!styleObj) {
            summary.skippedNoStyle++;
            summary.results.push({ start: r.start, end: r.end, reason: "no_emp_style", fingerprint: r.empFingerprint });
            continue;
        }
        var endIdx = Math.min(r.end - 1, paraCharCount - 1);
        if (endIdx < r.start) {
            summary.skippedRangeFailed++;
            summary.results.push({ start: r.start, end: r.end, reason: "range_collapsed_after_clamp" });
            continue;
        }
        try {
            var range = para.characters.itemByRange(r.start, endIdx);
            range.appliedCharacterStyle = styleObj;
            // read-back verify (#ac-overset-widen part B): appliedCharacterStyle=
            // SILENTLY no-ops on chars in a frame's overset region. Compare each
            // char's live CS by NAME (UXP: never === a host object); a mismatch or
            // read-throw is a silent drop. Mirrors _applyOneEmphasisSubRun.
            var dropCount = 0;
            var targetCsName = styleObj.name;
            for (var k = r.start; k <= endIdx; k++) {
                var got = "";
                try {
                    var liveCs = para.characters.item(k).appliedCharacterStyle;
                    got = (liveCs && liveCs.name) ? String(liveCs.name) : "";
                } catch (eRb) { got = ""; }
                if (got !== targetCsName) dropCount++;
            }
            summary.applied++;
            summary.results.push({ start: r.start, end: r.end, charStyleName: styleObj.name });
            if (dropCount > 0) {
                summary.skippedRangeFailed += dropCount;
                summary.results.push({ start: r.start, end: r.end, reason: "overset_silent_drop", droppedChars: dropCount });
            }
        } catch (e) {
            summary.skippedRangeFailed++;
            summary.results.push({ start: r.start, end: r.end, reason: "applyCharStyle_failed: " + (e && e.message ? e.message : e) });
        }
    }
    return summary;
}

// ─── applySpaceOverridesToParagraph (Phase 9) ─────────────────────

/**
 * Re-apply Phase 9 paragraph-level spaceBefore/spaceAfter overrides
 * after the paragraph style + cascade normalize.
 *
 * Format-preserving merge means: clusters that differ only in sB/sA
 * collapse into ONE _T_p_* style with the most-paragraphs-wins values.
 * Segments whose original sB/sA didn't match the winner have their
 * original values stored as paragraph-level overrides — InDesign shows
 * a "+" mark in the paragraph styles panel for those paragraphs, which
 * is correct semantics: the paragraph deviates from its style on these
 * dimensions only.
 *
 * Reorganize-flow + translation-flow both call this; offsets refer to
 * the paragraph itself (not text characters), so target-text rewrites
 * during translation don't break the apply.
 *
 * @param {Paragraph} para
 * @param {Object}    plan   — must have spaceOverridesBySegment
 * @param {string}    segTid
 * @returns {Object} { applied, skipped, fields: ["spaceBefore", ...] }
 */
function applySpaceOverridesToParagraph(para, plan, segTid) {
    var summary = { applied: 0, skipped: 0, fields: [] };
    if (!para) return summary;
    if (!plan || !plan.spaceOverridesBySegment) return summary;
    var override = plan.spaceOverridesBySegment[segTid];
    if (!override) return summary;
    if (override.spaceBefore !== undefined && override.spaceBefore !== null) {
        try {
            para.spaceBefore = override.spaceBefore;
            summary.fields.push("spaceBefore");
            summary.applied++;
        } catch (e) { summary.skipped++; }
    }
    if (override.spaceAfter !== undefined && override.spaceAfter !== null) {
        try {
            para.spaceAfter = override.spaceAfter;
            summary.fields.push("spaceAfter");
            summary.applied++;
        } catch (e) { summary.skipped++; }
    }
    return summary;
}

// ─── clearTranslationStyles ───────────────────────────────────────

/**
 * Remove all `_T_*`-prefixed styles. Paragraphs that referenced removed
 * styles fall back to options.fallbackStyle.
 *
 * Use cases:
 *   - C15 undo: rollback an import
 *   - E5c standalone tool: clean up before re-running with new config
 *
 * @param {Document} workDoc
 * @param {Object} options — { prefix?, fallbackStyle? }
 *                           prefix default: "_T_"
 *                           fallbackStyle default: try "[Basic Paragraph]"
 * @returns {Object} {removedParaStyles, removedCharStyles, paragraphsReset}
 */
function clearTranslationStyles(workDoc, options) {
    if (!workDoc) throw new Error("clearTranslationStyles: workDoc required");
    var opts = options || {};
    var prefix = opts.prefix || "_T_";
    var paraPrefix = opts.paraPrefix || prefix + "p_";
    var latinPrefix = opts.latinPrefix || prefix + "Latin_";
    var charAnnPrefix = opts.charAnnPrefix || prefix + "c_annotation_";
    var charEmpPrefix = opts.charEmpPrefix || prefix + "c_emp_";

    var removedParaStyles = [];
    var removedCharStyles = [];
    var paragraphsReset = 0;

    // Step 1: find fallback paragraph style for unset
    var fallback = null;
    try {
        var fbName = opts.fallbackStyle || "[Basic Paragraph]";
        fallback = workDoc.paragraphStyles.itemByName(fbName);
        if (fallback && !fallback.isValid) fallback = null;
    } catch (e) { fallback = null; }

    // Step 2: find all paragraphs whose style starts with paraPrefix → reset them
    if (fallback) {
        try {
            var stories = workDoc.stories;
            for (var s = 0; s < stories.length; s++) {
                var story = _getCollectionItem(stories, s);
                if (!story || !story.isValid) continue;
                var paras = story.paragraphs;
                if (!paras || typeof paras.length !== "number") continue;
                for (var p = 0; p < paras.length; p++) {
                    var para = _getCollectionItem(paras, p);
                    if (!para || !para.isValid) continue;
                    try {
                        var psName = String(para.appliedParagraphStyle.name || "");
                        if (psName.indexOf(paraPrefix) === 0) {
                            para.appliedParagraphStyle = fallback;
                            paragraphsReset++;
                        }
                    } catch (eP) {}
                }
            }
        } catch (eStories) {}
    }

    // Step 3: remove paragraph styles (in reverse to avoid index shift)
    try {
        var psList = workDoc.paragraphStyles.everyItem().getElements();
        for (var i = psList.length - 1; i >= 0; i--) {
            try {
                var name = String(psList[i].name || "");
                if (name.indexOf(paraPrefix) === 0) {
                    removedParaStyles.push(name);
                    psList[i].remove();
                }
            } catch (eRm) {}
        }
    } catch (eL) {}

    // Step 4: remove character styles (Latin + annotation_*)
    try {
        var csList = workDoc.characterStyles.everyItem().getElements();
        for (var j = csList.length - 1; j >= 0; j--) {
            try {
                var cname = String(csList[j].name || "");
                if (cname.indexOf(latinPrefix) === 0 ||
                    cname.indexOf(charAnnPrefix) === 0 ||
                    cname.indexOf(charEmpPrefix) === 0) {
                    removedCharStyles.push(cname);
                    csList[j].remove();
                }
            } catch (eRmC) {}
        }
    } catch (eC) {}

    return {
        removedParaStyles: removedParaStyles,
        removedCharStyles: removedCharStyles,
        paragraphsReset: paragraphsReset,
        fallback_used: fallback ? String(fallback.name) : null
    };
}

// ─── applyEmphasisRunsAsOverrides (skip-cleanup mode) ─────────────
//
// Apply emphasis runs as DIRECT character overrides — no cluster sheet,
// no _T_c_emp_* character style pool. Used when the import flow is set
// to "skip style cleanup": writes emphasis the way a designer would
// hand-tweak overrides on the paragraph.
//
// Compared to applyEmphasisRunsToParagraph which routes diffs through
// commitStylePlan-built character styles (deduped pool, named, listed
// in the panel), this path leaves no trace in the styles panel —
// emphasis lives only as character-level overrides on the run.
//
// Color resolution: swatches are looked up by name; RGB color values
// get a one-time `_T_emp_rgb_<r>_<g>_<b>` swatch created (or reused)
// so the same triplet across multiple runs deduplicates to one entry
// in the swatches panel.
//
// @param {Paragraph} para
// @param {Array}     emphasisRuns  — [{ start, end, diff: {...} }, ...]
// @param {Document}  workDoc
// @param {Object}    deps          — { ColorModel, ColorSpace } for swatch creation
// @returns {Object} { applied, failed, results: [{ start, end, reason? }, ...] }
function applyEmphasisRunsAsOverrides(para, emphasisRuns, workDoc, deps) {
    var summary = { applied: 0, failed: 0, results: [] };
    if (!para || !emphasisRuns || !emphasisRuns.length) return summary;
    var paraCharCount;
    try { paraCharCount = para.characters.length; } catch (e) { paraCharCount = 0; }
    // #E2E-11c: guard against malformed paraCharCount (UXP can return NaN
    // or non-finite values for stale refs). Without this, downstream Math.min
    // returns NaN and itemByRange(-Infinity, NaN) can crash InDesign's C++
    // layer (we saw it on the double-translated `.translated.translated.indd`
    // re-import path).
    if (!Number.isFinite(paraCharCount) || paraCharCount <= 0) return summary;

    for (var i = 0; i < emphasisRuns.length; i++) {
        var run = emphasisRuns[i];
        if (!run || !run.diff) continue;
        // #E2E-11c: strict offset validation BEFORE any DOM call. Reject
        // runs with non-finite start/end, negative offsets, or end<=start
        // — these would otherwise feed bad indices to itemByRange.
        if (typeof run.start !== "number" || typeof run.end !== "number") {
            summary.failed++;
            summary.results.push({ start: run.start, end: run.end, reason: "non_numeric_offsets" });
            continue;
        }
        if (!Number.isFinite(run.start) || !Number.isFinite(run.end)) {
            summary.failed++;
            summary.results.push({ start: run.start, end: run.end, reason: "non_finite_offsets" });
            continue;
        }
        // Negative start is unambiguous garbage — surface separately.
        if (run.start < 0) {
            summary.failed++;
            summary.results.push({ start: run.start, end: run.end, reason: "start_out_of_range", paraCharCount: paraCharCount });
            continue;
        }
        // Skip empty-diff runs (nothing to apply).
        var diffKeys = [];
        try {
            for (var dk in run.diff) {
                if (Object.prototype.hasOwnProperty.call(run.diff, dk)) diffKeys.push(dk);
            }
        } catch (eDK) {}
        if (diffKeys.length === 0) {
            // Not a failure, just nothing to do — don't pollute counters.
            continue;
        }
        // #BRIDGE-16: when start >= paraCharCount the run's range is
        // empty after clamping to the paragraph's last char. Surface as
        // "range_collapsed_after_clamp" rather than "start_out_of_range"
        // — the test suite expects the clamp-derived reason for any
        // post-clamp empty range, including starts beyond the
        // paragraph end, so the same diagnostic covers all collapse
        // shapes. (Negative start still uses "start_out_of_range"
        // above because that's a callsite bug, not a clamp outcome.)
        var startIdx = run.start;
        var endIdx = Math.min(run.end - 1, paraCharCount - 1);
        if (endIdx < startIdx || startIdx >= paraCharCount) {
            summary.failed++;
            summary.results.push({ start: run.start, end: run.end, reason: "range_collapsed_after_clamp", paraCharCount: paraCharCount });
            continue;
        }
        try {
            var range = para.characters.itemByRange(startIdx, endIdx);
            if (!range) {
                summary.failed++;
                summary.results.push({ start: run.start, end: run.end, reason: "itemByRange_null" });
                continue;
            }
            var propFails = _applyDiffToRange(range, run.diff, workDoc, deps);
            if (propFails.length === 0) {
                summary.applied++;
                summary.results.push({ start: run.start, end: run.end });
            } else {
                // Partial / total failure — caller wants to see WHICH dim
                // failed (commonly "fontStyle: not available" when the doc's
                // font catalog hasn't loaded that variant).
                summary.failed++;
                summary.results.push({
                    start: run.start, end: run.end,
                    reason: "property_write_failed",
                    failedProps: propFails
                });
            }
        } catch (e2) {
            summary.failed++;
            summary.results.push({ start: run.start, end: run.end, reason: "applyDiff_failed: " + (e2 && e2.message ? e2.message : e2) });
        }
    }
    return summary;
}

// ─── applyEmphasisRunsAsCharStyles (SPEC §14 net design v5) ────────
//
// Faithful CJK+Latin emphasis runs → NAMED COMBINED CHARACTER STYLES,
// one per per-script sub-run. The style encodes the run's full diff:
// the resolved (per-script) font weight PLUS every non-weight dim
// (fillColor / pointSize / underline / strikeThru / tracking /
// baselineShift / scale / skew / position). Never fabricates a ghost
// font (always validates the resolved face is INSTALLED, case-exact) and
// never silently drops a dim (route B: all diff dims land on the CS).
//
// This SUPERSEDES the raw-override path (applyEmphasisRunsAsOverrides,
// retained) for the faithful runPipeline / B1 / M5 call sites.
//
// Family source by script (SPEC §13.1/§14.1, two-sided grounded):
//   - CJK sub-run : live `para.characters.item(absIdx).appliedFont.name`
//                   (= the byPair-mapped target CJK psFont, A1 host-verified)
//                   → deps.cjkEmphasisWeight(family, srcWeight) → dstWeight.
//   - Latin sub-run: SOURCE root family (Latin isn't byPair-mapped), via
//                   precedence ① run.diff.fontFamily (codec-preserved, must
//                   be non-CJK) > ② _resolveLatinFontForCluster(seg)
//                   (scriptByFont.LATIN else baseline root) with _isCJKFont
//                   guard so a CJK-dominant baseline never feeds the Latin
//                   sub-run. weight = run.diff.fontStyle (un-remapped).
//
// @param {Paragraph} para     — workDoc paragraph (target text already written)
// @param {Array}     runs     — UN-remapped source-diff emphasis runs
//                               [{ start, end, diff: {...} }, ...]
// @param {Document}  workDoc
// @param {Object}    deps      — { cjkEmphasisWeight, ColorSpace, ColorModel, Position }
// @param {Object}    seg       — locate segment (for _resolveLatinFontForCluster)
// @returns {Object} { applied, skipped, surfaced, results:[{start,end,subRuns:[...]}] }
function applyEmphasisRunsAsCharStyles(para, runs, workDoc, deps, seg) {
    var summary = { applied: 0, skipped: 0, surfaced: [], results: [] };
    if (!para || !runs || !runs.length) return summary;
    deps = deps || {};

    var paraCharCount;
    try { paraCharCount = para.characters.length; } catch (e) { paraCharCount = 0; }
    if (!Number.isFinite(paraCharCount) || paraCharCount <= 0) return summary;

    var I = (SSB && SSB._internal) || {};

    for (var i = 0; i < runs.length; i++) {
        var run = runs[i];
        if (!run || !run.diff) continue;
        // Malformed offsets: surface + count (mirror applyEmphasisRunsAsOverrides),
        // don't drop silently — a bad codec offset must be debuggable.
        if (typeof run.start !== "number" || typeof run.end !== "number") {
            summary.skipped++;
            summary.surfaced.push({ start: run.start, end: run.end, reason: "non_numeric_offsets" });
            continue;
        }
        if (!Number.isFinite(run.start) || !Number.isFinite(run.end)) {
            summary.skipped++;
            summary.surfaced.push({ start: run.start, end: run.end, reason: "non_finite_offsets" });
            continue;
        }
        if (run.start < 0) {
            summary.skipped++;
            summary.surfaced.push({ start: run.start, end: run.end, reason: "start_out_of_range" });
            continue;
        }
        // Skip empty-diff runs (nothing to apply).
        var diffKeyCount = 0;
        try { for (var dk in run.diff) { if (Object.prototype.hasOwnProperty.call(run.diff, dk)) diffKeyCount++; } } catch (eDK) {}
        if (diffKeyCount === 0) continue;

        var startIdx = run.start;
        var endIdx = Math.min(run.end - 1, paraCharCount - 1);
        if (endIdx < startIdx || startIdx >= paraCharCount) {
            summary.skipped++;
            summary.surfaced.push({ start: run.start, end: run.end, reason: "range_collapsed_after_clamp" });
            continue;
        }

        var runResult = { start: run.start, end: run.end, subRuns: [] };
        summary.results.push(runResult);

        // ── per-script split (SPEC §12.1 step2) ──
        // Read the run's range contents as a STRING; if the length disagrees
        // with the offset span (UXP tag-ification / supplementary plane), do
        // NOT trust offsets → fall back to ONE whole-run sub-run (treated as
        // CJK iff first char classifies CJK; pure-Latin desync → skip+surface,
        // mirroring font_mapping_apply_to_doc.js:198 desync guard, SPEC §12.8.5).
        var contents = "";
        try { contents = String(para.characters.itemByRange(startIdx, endIdx).contents); } catch (eC0) {}
        var expectedLen = endIdx - startIdx + 1;
        var subRunsSplit;
        if (contents.length === expectedLen && contents.length > 0) {
            subRunsSplit = ScriptSplit.splitRunsByScript(contents);
        } else {
            // desync → whole-run; classify by first char (CJK safe).
            var firstIsCJK = false;
            try { firstIsCJK = ScriptSplit._isCJKChar(contents.charAt(0)); } catch (eFC) {}
            if (!firstIsCJK) {
                // pure-Latin desync: offsets untrusted → can't reliably source
                // the Latin family per-char → surface, don't guess.
                summary.skipped++;
                var surfDesync = { start: run.start, end: run.end, reason: "desync_latin_skip" };
                summary.surfaced.push(surfDesync);
                runResult.subRuns.push({ script: "LATIN", outcome: "skip", reason: "desync_latin_skip" });
                continue;
            }
            subRunsSplit = [{ startOffset: 0, len: expectedLen, isCJK: true }];
        }

        for (var si = 0; si < subRunsSplit.length; si++) {
            var sr = subRunsSplit[si];
            var subStart = startIdx + sr.startOffset;
            var subEnd = subStart + sr.len - 1;
            if (subEnd < subStart) continue;
            var subResult = _applyOneEmphasisSubRun(
                para, run.diff, sr.isCJK, subStart, subEnd, workDoc, deps, seg, I
            );
            runResult.subRuns.push(subResult);
            if (subResult.outcome === "applied") {
                summary.applied++;
                // SPEC §12.1c: a partially-collided sub-run still surfaces the
                // skipped (collided) char count so the report sees them.
                if (subResult.skippedCharCount > 0) {
                    summary.skipped += subResult.skippedCharCount;
                    summary.surfaced.push({
                        start: subStart, end: subEnd,
                        script: subResult.script,
                        reason: subResult.partialReason || "collision_skipped_chars",
                        skippedChars: subResult.skippedCharCount
                    });
                }
                // univ-italic (OQ-1 / 乙): an italic-marked run applied UPRIGHT because
                // its weight is unconfigured (surface) or real-but-no-exact-italic
                // (OQ-2 block) — surface it non-silently so the operator sees italic
                // intent that did not land. block also flags fail-closed (don't save).
                if (subResult.italicSurface) {
                    summary.surfaced.push({
                        start: subStart, end: subEnd, script: subResult.script,
                        reason: "italic_unconfigured_surface:" + subResult.italicSurface.reason,
                        italicWeight: subResult.italicSurface.weight
                    });
                }
                // univ-italic AC④': a run left on the real italic face it already had.
                // Counted, not surfaced — it is not a problem to report, but without a
                // counter the report cannot distinguish "N real italic runs preserved"
                // from "there were none", which is exactly the claim AC④' makes.
                if (subResult.italicKept) {
                    summary.italicKept = (summary.italicKept || 0) + 1;
                }
                if (subResult.italicBlock) {
                    summary.italicBlocked = (summary.italicBlocked || 0) + 1;
                    summary.surfaced.push({
                        start: subStart, end: subEnd, script: subResult.script,
                        reason: "italic_real_no_exact_BLOCK:" + subResult.italicBlock.reason,
                        italicWeight: subResult.italicBlock.weight, block: true
                    });
                }
            } else {
                summary.skipped++;
                summary.surfaced.push({
                    start: subStart, end: subEnd,
                    script: subResult.script, reason: subResult.reason
                });
            }
        }
    }
    return summary;
}

// Resolve a per-script sub-run to an INSTALLED face, build (or reuse) a
// combined `_T_c_emp_w_*` character style carrying the full run diff, and
// apply it to the sub-range with direct-override capture/replay (SPEC §12/§13/§14).
// Returns { script, family?, style?, styleName?, outcome, reason? }.
// Recover a weight token embedded in a Latin family NAME (H&Co naming: the weight
// lives in the family, e.g. "Whitney Semibold" = Semibold weight, style "Regular").
// Used by the CJK branch when an emphasis run swaps fontFamily (not fontStyle) to
// a heavier face — slide titles encode emphasis that way. Returns "" for single-word
// families (no embedded weight) and for trailing words not in the known weight set,
// so it fail-closes to current behavior. Italic token stripped first so
// "Whitney Semibold Italic" still yields "Semibold".
function _weightTokenFromFamily(family, I) {
    if (!family) return "";
    var stripIt = (I && typeof I._stripItalicForWeightOnly === "function")
        ? I._stripItalicForWeightOnly : function (s) { return String(s || ""); };
    var clean = stripIt(String(family)).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    var parts = clean.split(" ");
    if (parts.length < 2) return "";   // single-word family carries no embedded weight
    var cands = (I && Array.isArray(I._CANDIDATE_WEIGHTS)) ? I._CANDIDATE_WEIGHTS : [];
    var last = parts[parts.length - 1].toLowerCase();
    for (var i = 0; i < cands.length; i++) {
        if (String(cands[i]).toLowerCase() === last) return cands[i];
    }
    return "";
}

function _applyOneEmphasisSubRun(para, diff, isCJK, subStart, subEnd, workDoc, deps, seg, I) {
    var script = isCJK ? "CJK" : "LATIN";
    var out = { script: script, outcome: "skip" };

    // P0: only treat fontStyle as a SOURCE weight when the diff actually carries
    // it. emphasis_extractor.diffProps emits fontStyle ONLY when it differs from
    // baseline — a color-/underline-/size-/superscript-ONLY run has NO fontStyle.
    // For those, the run must NOT change the weight: we use the char's LIVE
    // weight as the face style (applied DIRECTLY, never via cjkEmphasisWeight,
    // because the live weight is already the resolved target — not a source).
    var hasSrcWeight = !!(diff && typeof diff.fontStyle === "string" && diff.fontStyle);
    var srcWeight = hasSrcWeight ? diff.fontStyle : "Regular";

    // CJK faux-italic (SPEC §6 revision — host bug 20260624, user "中文应斜体的部分未斜体"):
    // a source italic token on a CJK run has NO real italic face (MHei/SHS etc. ship
    // upright only). The weight branch keeps the live upright weight (italic stripped
    // off the weight resolve); THIS flag separately drives a faux-skew slant (per
    // writable span, below) so the source's italic intent stays visible — e.g. the
    // [FA] editorial notes. Latin runs keep REAL italic (resolved face), so the skew
    // is CJK-only. Detect on the raw srcWeight so "Italic" AND "Bold Italic" qualify.
    // TODO#26 part 2: include `oblique` — a source run on an "… Oblique" face carries
    // the same slant intent, and an oblique-blind gate here silently bypassed the
    // per-weight config (the run kept the oblique face verbatim, config never
    // consulted), diverging from italic_apply whose `_wasItalic` matches both. Also
    // flips `skipSkew` on for oblique runs (:1765) — the realization owns the slant,
    // so a stale captured skew must not be replayed on top (that WOULD double-slant).
    var isItalicSrc = hasSrcWeight && /italic|oblique/i.test(srcWeight);

    // ── (a) family source by script (SPEC §14.1) ──
    var family = null;
    var liveWeight = null;   // live face style for the weight-absent path
    if (isCJK) {
        // CJK: live per-char appliedFont.name (absolute index — A1 host-verified).
        try {
            var ch0 = para.characters.item(subStart);
            var af = ch0.appliedFont;
            if (af && typeof af === "object") {
                if (af.fontFamily) family = String(af.fontFamily);
                else if (af.name) family = String(af.name).split("\t")[0];
                // live weight = the style half of the Font object / its name.
                try { if (af.fontStyle) liveWeight = String(af.fontStyle); } catch (eLfsO) {}
                if (!liveWeight && af.name && String(af.name).indexOf("\t") >= 0) {
                    liveWeight = String(af.name).split("\t")[1];
                }
            } else if (typeof af === "string") {
                family = String(af).split("\t")[0];
                if (String(af).indexOf("\t") >= 0) liveWeight = String(af).split("\t")[1];
            }
        } catch (eCJK) {}
        if (!family) { out.reason = "cjk_family_unreadable"; return out; }
    } else {
        // Latin: source root family. ① run.diff.fontFamily (must be non-CJK)
        // > ② _resolveLatinFontForCluster(seg) (scriptByFont.LATIN else baseline).
        var isCJKFont = (typeof I._isCJKFont === "function") ? I._isCJKFont : function () { return false; };
        // Latin live weight (for the weight-absent path) ALWAYS comes from the
        // cluster's live Latin weight — Latin is GREP-routed, so it does NOT
        // surface on char.appliedFont (A3). Resolve it UNCONDITIONALLY so BOTH
        // family-source branches (① diff.fontFamily, ② _resolveLatinFontForCluster)
        // preserve the live weight when the run carries no source fontStyle.
        var latCluster = null;
        if (typeof I._resolveLatinFontForCluster === "function" && seg) {
            try { latCluster = I._resolveLatinFontForCluster(seg); } catch (eL) {}
        }
        if (latCluster && latCluster.fontStyle) liveWeight = String(latCluster.fontStyle);

        if (diff && diff.fontFamily && !isCJKFont(String(diff.fontFamily))) {
            family = String(diff.fontFamily);
        } else if (latCluster && latCluster.fontFamily) {
            // _isCJKFont guard: never feed a CJK family to a Latin sub-run.
            if (isCJKFont(String(latCluster.fontFamily))) {
                out.reason = "latin_family_resolved_cjk";
                return out;
            }
            family = String(latCluster.fontFamily);
        }
        if (!family) { out.reason = "latin_family_unresolved"; return out; }
    }
    out.family = family;

    // ── (b) resolve to an INSTALLED real face (case-tolerant; never ghost) ──
    var resolved = null;
    if (isCJK) {
        var dstWeight;
        // CJK has NO real italic — italic is faux-skew (SPEC §6, out-of-scope here).
        // So strip any italic token off the source style and resolve only the WEIGHT
        // component. An italic-ONLY run (fontStyle="Italic", common on [FA] designer
        // notes) has no weight component → it must NOT be run through cjkEmphasisWeight
        // (which would map "Italic"→a brand weight, e.g. Xbold, wrongly bolding the
        // whole italic note — host bug 20260624). Treat italic-only like weight-absent.
        var _stripIt = (I && typeof I._stripItalicForWeightOnly === "function")
            ? I._stripItalicForWeightOnly
            : function (s) { return String(s || "").replace(/\s*(?:italic|oblique)\s*/ig, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, ""); };
        var weightWord = hasSrcWeight ? _stripIt(srcWeight) : "";
        // host bug 20260624 (page-2 slide titles): a run with NO fontStyle but a
        // fontFamily swap to a HEAVIER Latin family ("Whitney Semibold") encodes its
        // weight in the family NAME, not fontStyle. Recover that token so the CJK side
        // still gets the brand-paired heavier weight. GATE: only when the family's
        // weight outranks the live baseline (a swap to a heavier face = emphasis; a
        // lighter/equal swap is NOT bolded — §1 lightest-wins). fontStyle-carrying
        // runs skip this entirely (their explicit weight already won above).
        var weightFromFamily = false;
        if (!weightWord && diff && diff.fontFamily &&
            I && typeof I._rankWeight === "function" && liveWeight) {
            var _famWeight = _weightTokenFromFamily(String(diff.fontFamily), I);
            if (_famWeight && I._rankWeight(_famWeight) > I._rankWeight(liveWeight)) {
                weightWord = _famWeight;
                weightFromFamily = true;
            }
        }
        if (weightWord) {
            // run carries a real SOURCE weight → resolve via brand pairing (Semibold→Xbold).
            dstWeight = weightWord;
            if (typeof deps.cjkEmphasisWeight === "function") {
                var bw = null;
                try { bw = deps.cjkEmphasisWeight(family, weightWord); } catch (eBW) {}
                if (bw) dstWeight = String(bw);
            }
            // §1 lightest-wins safety on the family-inferred path: the resolved brand
            // weight must never come out LIGHTER than the live baseline.
            if (weightFromFamily && liveWeight &&
                I._rankWeight(dstWeight) < I._rankWeight(liveWeight)) {
                dstWeight = liveWeight;
            }
        } else {
            // weight-absent OR italic-only run → KEEP the live weight (no brand-weight
            // change). Applied DIRECTLY (it's already the resolved target, not a source).
            dstWeight = (liveWeight && liveWeight !== "NOTHING") ? liveWeight : "Regular";
        }
        resolved = _resolveInstalledFaceCaseTolerant(workDoc, family, dstWeight, I);
    } else {
        // Latin: source weight as-is when present; else keep the live Latin weight.
        // EXCEPTION (audit P2): ④'s whole-paragraph baseline-italic synthesis tags its
        // diff `__wholeParaItalic` and carries a bare "Italic" token meaning "italic at
        // the LIVE baseline weight", NOT a Regular-weight per-run emphasis. Keep the live
        // Latin weight for it — else embedded non-regular Latin (e.g. Semibold ASCII in a
        // uniform Bold-Italic paragraph) collapses to Regular. Real per-run emphasis
        // (no flag) keeps its own source weight exactly as before.
        var latStyle;
        if (diff && diff.__wholeParaItalic) {
            latStyle = (liveWeight && liveWeight !== "NOTHING") ? liveWeight : "Regular";
        } else {
            latStyle = hasSrcWeight ? srcWeight
                : ((liveWeight && liveWeight !== "NOTHING") ? liveWeight : "Regular");
        }
        resolved = _resolveInstalledFaceCaseTolerant(workDoc, family, latStyle, I);
    }
    if (!resolved) {
        out.reason = "face_not_installed";   // skip + surface, NO ghost
        return out;
    }
    out.family = resolved.family;
    out.style = resolved.fontStyle;

    // ── univ-italic (task_plan §7 · 乙 STRICT): italic realization = operator-config-gated ──
    // Replaces the old unconditional carrier-#1 skew=15 (removed below). For an
    // italic-marked run, resolve HOW it slants from the per-weight brand_config
    // (italic_by_weight) and carry the decision in the emphasis CS BODY (faux skew /
    // real italic fontStyle) so it survives clearOverrides (probe 20260625_01).
    //   faux   → upright weight fontStyle + CS-body skew=angle
    //   real   → the weight-EXACT installed italic face + skew=0
    //   block  → OQ-2 fail-closed (real configured but no weight-exact italic): upright + surfaced
    //   surface→ 乙 unconfigured: upright + surfaced (THE Latin landmine cut — an unconfigured
    //            Latin italic run that today auto-resolves to "Book Italic" is overridden upright here)
    // Non-italic runs are untouched (_emphStyle = resolved.fontStyle, no skew).
    var _emphStyle = resolved.fontStyle;
    var _emphSkew = 0;
    if (isItalicSrc) {
        var _stripItWO = (I && typeof I._stripItalicForWeightOnly === "function")
            ? I._stripItalicForWeightOnly
            : function (s) { return String(s || "").replace(/\s*(?:italic|oblique)\s*/ig, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, ""); };
        var _baseWeight = _stripItWO(resolved.fontStyle) || "Regular";
        var _icfg = (deps && deps.italicConfig)
            ? ItalicConfig.lookup(deps.italicConfig, resolved.family, _baseWeight) : null;
        var _exactIt = null;
        try { _exactIt = FontItalicProbe.findExactItalicStyleName(workDoc, resolved.family, _baseWeight); } catch (eEx) {}
        // The run is ALREADY on a real italic face when its weight has that exact
        // face installed — a real italic is a WEIGHT the source already uses, not
        // an implementation the operator must authorise (charter §7.4 2026-08-07).
        // Unconfigured + already-italic → keep verbatim; unconfigured + no italic
        // face → still surfaced upright (乙-strict, narrowed to the case it was
        // written for).
        // CJK gate (symmetry with italic_apply, which gates its probe on !isCJK):
        // a CJK family shipping a probe-nameable face must not reach keep.
        var _isCjkFam2 = false;
        try {
            var _CJKRE = /[⺀-鿿豈-﫿]/;
            _isCjkFam2 = _CJKRE.test(String(resolved.family || ""))
                || /mhei|heiti|songti|mingti|gothic|kai|fangsong|source han|noto sans (sc|tc|jp|kr)|pingfang|yahei|simhei|simsun/i.test(String(resolved.family || ""));
        } catch (eCjk2) {}
        var _dec = ItalicConfig.resolveItalicRealization(_icfg, !!_exactIt, !!_exactIt && !_isCjkFam2);
        if (_dec.kind === "faux") {
            _emphStyle = _baseWeight; _emphSkew = _dec.angle;
        } else if (_dec.kind === "real" || _dec.kind === "keep") {
            _emphStyle = _exactIt || resolved.fontStyle; _emphSkew = 0;
            // A run that moves from `surface` to `keep` leaves the surfaced list. If
            // nothing counts it on the way in, the report cannot tell "7 real italic
            // runs were preserved" from "there were none" — and AC④' would only be
            // checkable by eye. Count it.
            if (_dec.kind === "keep") {
                out.italicKept = { family: resolved.family, weight: _baseWeight, face: _emphStyle, reason: _dec.reason };
            }
        } else if (_dec.kind === "block") {
            _emphStyle = _baseWeight; _emphSkew = 0;
            out.italicBlock = { family: resolved.family, weight: _baseWeight, reason: _dec.reason };
        } else { // surface (乙 unconfigured)
            _emphStyle = _baseWeight; _emphSkew = 0;
            out.italicSurface = { family: resolved.family, weight: _baseWeight, reason: _dec.reason };
        }
        out.style = _emphStyle;
        out.italicKind = _dec.kind;
    }

    // ── (c) collision gate (SPEC §12.1c) — PER-CHAR ──
    // A char already carrying a NON-_T_c_emp_ named appliedCharacterStyle
    // (annotation / designer / link CS) must NOT be clobbered. Rather than drop
    // the WHOLE sub-run, split it into maximal contiguous spans of NON-colliding
    // chars (mirrors _writeSpansSkippingEmp in font_mapping_apply_to_doc.js) and
    // apply the emphasis CS only to those; the colliding chars are skipped and
    // their count surfaced.
    var writableSpans = [];   // [{ s, e }, ...]
    var collidedChars = 0;
    var spanStart = -1;
    for (var ci = subStart; ci <= subEnd; ci++) {
        var csName = "";
        try {
            var cs = para.characters.item(ci).appliedCharacterStyle;
            csName = (cs && cs.name) ? String(cs.name) : "";
        } catch (eCs) { csName = ""; }
        var collide = !!(csName && csName !== "[None]" && csName.indexOf("_T_c_emp_") !== 0);
        if (collide) {
            collidedChars++;
            if (spanStart >= 0) { writableSpans.push({ s: spanStart, e: ci - 1 }); spanStart = -1; }
        } else {
            if (spanStart < 0) spanStart = ci;
        }
    }
    if (spanStart >= 0) writableSpans.push({ s: spanStart, e: subEnd });

    out.skippedCharCount = collidedChars;
    if (writableSpans.length === 0) {
        // every char collided → nothing writable.
        out.reason = "collision_existing_char_style";
        return out;
    }

    // ── (d) build the combined character style ONCE (span-independent) ──
    var styleObj = null;
    try {
        styleObj = _ensureEmphasisCharStyle(workDoc, diff, resolved.family, _emphStyle, deps, I, _emphSkew);
    } catch (eEns) {
        out.reason = "ensure_style_failed:" + (eEns && eEns.message ? eEns.message : eEns);
        return out;
    }
    if (!styleObj) { out.reason = "ensure_style_null"; return out; }
    out.styleName = styleObj.name;

    // ── (e) per span: capture overrides (FULL matrix) → apply CS → replay ──
    // (SPEC §13.2: appliedCharacterStyle= resets direct overrides on the range;
    //  capture via the full-matrix _readCharOverrides primitive, replay-filtered.)
    var anyApplied = false;
    var spanFailChars = 0;      // chars in spans whose CS write THREW (left unstyled)
    var readbackDropChars = 0;  // chars whose CS write SILENTLY dropped (overset region)
    var _targetCsName = styleObj.name;  // hoisted: one host read, not one per char
    for (var spi = 0; spi < writableSpans.length; spi++) {
        var sp = writableSpans[spi];
        var captured = _captureSubRangeOverrides(para, sp.s, sp.e);
        try {
            var spanRange = para.characters.itemByRange(sp.s, sp.e);
            // HOST-CONFIRMED root-cause fix (probe 20260624_03): a pre-existing
            // DIRECT font override on the range (the baseline cluster's MHei
            // Bold / Whitney byPair font) WINS over the emphasis character style
            // in InDesign's cascade (direct override > char style), so the char
            // style's resolved face (MHei Xbold / Whitney Semibold) never shows —
            // the char keeps rendering the baseline weight. clearOverrides() on
            // the span FIRST drops the competing direct override (the char style
            // assignment that follows survives it); then the char style's font
            // takes effect. The captured non-font dims are replayed below; the
            // FONT dim is intentionally NOT replayed (it now belongs to the CS).
            try { spanRange.clearOverrides(); } catch (eClr) {}
            spanRange.appliedCharacterStyle = styleObj;
        } catch (eApply) {
            // record the first failure reason but keep trying other spans. Count
            // the failed span's chars so a LATER successful span can't mask this
            // span's silent drop — the caller surfaces skippedCharCount.
            if (!out.reason) out.reason = "applyCharStyle_failed:" + (eApply && eApply.message ? eApply.message : eApply);
            spanFailChars += (sp.e - sp.s + 1);
            continue;
        }
        // ── read-back verify (SPEC #ac-overset-widen part B / AC3) ──
        // appliedCharacterStyle= SILENTLY fails (no throw) on chars pushed into a
        // frame's OVERSET region — the emphasis lands only on the in-frame prefix
        // while the report shows failed:0 and the tail keeps baseline weight. Read
        // each char's live appliedCharacterStyle back and compare by NAME (UXP:
        // never === a host object); a mismatch is a silent drop → count + surface
        // below as overset_silent_drop. The overset-widen pass (part A, v2_pipeline)
        // prevents these in the normal path; this net makes any residual drop honest.
        for (var vk = sp.s; vk <= sp.e; vk++) {
            var vGot = "";
            try {
                var vCs = para.characters.item(vk).appliedCharacterStyle;
                vGot = (vCs && vCs.name) ? String(vCs.name) : "";
            } catch (eVk) { vGot = ""; }
            if (vGot !== _targetCsName) readbackDropChars++;
        }
        // univ-italic: carrier #1 (the old `if (isCJK && isItalicSrc) skew=15`
        // direct override) is REMOVED — italic skew now lives in the emphasis CS
        // BODY (set in _ensureEmphasisCharStyle, angle from config). For an
        // italic-marked run the realization OWNS the skew, so the replay must NOT
        // restore any captured skew as a direct override (it would clobber the
        // CS-body skew for faux, or re-introduce a stale skew over a real/surface
        // run = double-slant). skipSkew = isItalicSrc.
        _replaySubRangeOverrides(para, sp.s, sp.e, captured, diff, isItalicSrc);
        anyApplied = true;
    }

    if (!anyApplied) {
        if (!out.reason) out.reason = "applyCharStyle_failed";
        return out;
    }
    out.outcome = "applied";
    // Surface partial span-apply failures + silent overset drops: a span whose CS
    // write threw (spanFailChars) or silently dropped in the overset region
    // (readbackDropChars) leaves its chars unstyled. Fold both into skippedCharCount
    // + a partialReason so the caller counts + surfaces them (otherwise a later
    // successful span returns "applied" and the failed / dropped chars vanish from
    // the report — the exact failed:0 blind spot #ac-overset-widen closes).
    var _extraSkip = spanFailChars + readbackDropChars;
    if (_extraSkip > 0) {
        out.skippedCharCount = (out.skippedCharCount || 0) + _extraSkip;
        var _reasons = [];
        if (readbackDropChars > 0) _reasons.push("overset_silent_drop");
        if (spanFailChars > 0) _reasons.push("applyCharStyle_failed_partial");
        out.partialReason = _reasons.join("+");
    } else if (collidedChars > 0) {
        // partial: some chars collided but others were styled.
        out.partialReason = "collision_skipped_chars";
    }
    return out;
}

// Case-tolerant resolution to a real installed face. First the standard
// _resolveInstalledFontName (as-specified / legacy↔twin / base sub-family);
// on null, a case-insensitive scan of workDoc.fonts → app.fonts recovers the
// exact-case ".name" (resolver gives "Xbold" but the real face may be
// "XBold"; itemByName is case-sensitive — SPEC §10.7). null → truly missing.
function _resolveInstalledFaceCaseTolerant(workDoc, family, style, I) {
    var st = (style !== null && style !== undefined && String(style)) ? String(style) : "Regular";
    if (typeof I._resolveInstalledFontName === "function") {
        var r = null;
        try { r = I._resolveInstalledFontName(workDoc, family, st); } catch (eR) {}
        if (r && r.family) return r;
    }
    // case-insensitive recovery: scan the SYSTEM catalog (app.fonts) ONLY —
    // NOT workDoc.fonts. A doc-embedded font can report INSTALLED under a name
    // while a family-string write still substitutes against the system catalog
    // (style_sheet_builder.js:2002), so scanning workDoc.fonts could recover a
    // doc-only ghost. Match _resolveInstalledFontName's system-only probe.
    var want = (String(family) + "\t" + st).toLowerCase();
    var hit = _scanFontsCaseInsensitive(workDoc, want);
    if (hit) {
        var tab = hit.indexOf("\t");
        if (tab >= 0) {
            return { family: hit.substring(0, tab), fontStyle: hit.substring(tab + 1) };
        }
        return { family: hit, fontStyle: "Regular" };
    }
    return null;
}

// Scan the SYSTEM font catalog (app.fonts) ONLY for a case-insensitive match,
// returning the exact-case ".name". Starts at workDoc.parent (skipping
// workDoc.fonts) and walks up to the app — mirroring _isSystemFontInstalled so
// case recovery can't return a doc-only embedded ghost (style_sheet_builder.js:2002).
function _scanFontsCaseInsensitive(workDoc, wantLower) {
    var ref = null;
    // skip workDoc.fonts — start at the parent (app or doc→app chain).
    try { ref = workDoc && workDoc.parent; } catch (e0) { return null; }
    for (var hop = 0; hop < 6 && ref; hop++) {
        var fonts = null;
        try { fonts = ref.fonts; } catch (eF) { fonts = null; }
        if (fonts) {
            var n = 0;
            try { n = fonts.length; } catch (eN) { n = 0; }
            for (var i = 0; i < n; i++) {
                var nm = "";
                try { nm = String(fonts.item(i).name); } catch (eNm) { nm = ""; }
                if (nm && nm.toLowerCase() === wantLower) {
                    // TODO#38 (owner 3A 2026-08-13): status must READ as installed —
                    // the old `!st ||` arm treated an unreadable status as installed
                    // (fail-open). Census 20260813_14: 0/631 unreadable — scoped to
                    // THIS machine's table at that moment (mid font-sync/activation
                    // elsewhere may differ); a live guard-rail, not dead code.
                    var st = "";
                    try { st = String(fonts.item(i).status); } catch (eSt) { st = ""; }
                    if (st === "INSTALLED" || st.indexOf("INSTALLED") >= 0 || st.indexOf("Installed") >= 0) {
                        return nm;
                    }
                }
            }
            // this level didn't have it → keep walking up.
        }
        var nxt = null;
        try { nxt = ref.parent; } catch (eP) { nxt = null; }
        if (!nxt || nxt === ref) break;
        ref = nxt;
    }
    return null;
}

// Build (or reuse) a combined emphasis character style. The style carries
// the run's FULL diff: resolved font (appliedFont=family + separate fontStyle,
// per the style-OBJECT contract — NOT "family\tstyle") PLUS every non-font
// dim from _empPropsSpec (color/size/underline/etc.). find-or-create by a
// deterministic name → re-import idempotent (SPEC §12.5/§13.2).
function _ensureEmphasisCharStyle(workDoc, diff, family, style, deps, I, italicSkew) {
    var sanitize = (typeof I._sanitize === "function") ? I._sanitize
        : function (s) { return String(s || "Unknown").replace(/[^A-Za-z0-9]+/g, "_"); };
    var _fauxSkew = (typeof italicSkew === "number" && italicSkew > 0) ? italicSkew : 0;
    var shortHash = (typeof I._shortHash === "function") ? I._shortHash : null;
    var empDescriptor = (typeof I._empDescriptor === "function") ? I._empDescriptor : null;
    var empPropsSpec = (typeof I._empPropsSpec === "function") ? I._empPropsSpec : null;
    var resolveFillColor = (typeof I._resolveFillColor === "function") ? I._resolveFillColor : null;

    // ── name: _T_c_emp_w_<family>_<style>[_it<angle>][_<hash(descriptor)>] ──
    var name = "_T_c_emp_w_" + sanitize(family) + "_" + sanitize(style);
    // univ-italic: encode the faux skew angle so a faux CS (CS-body skew>0) and an
    // upright CS for the SAME (family,style) don't collide on one name — the upright
    // weight token is identical; only the CS-body skew differs (the carrier-#1 fold).
    if (_fauxSkew > 0) name = name + "_it" + Math.round(_fauxSkew);
    // Multi-dim (anything beyond the font weight) → append a descriptor hash so
    // distinct diffs on the same face don't collapse to one style.
    var nonFontKeys = 0;
    try {
        for (var k in diff) {
            if (!Object.prototype.hasOwnProperty.call(diff, k)) continue;
            if (k === "fontFamily" || k === "fontStyle") continue;
            nonFontKeys++;
        }
    } catch (eK) {}
    if (nonFontKeys > 0 && shortHash && empDescriptor) {
        name = name + "_" + shortHash(empDescriptor(diff));
    }

    // find-or-create (mirror ensureAnnotationCharStyle:3172 add→on-dup itemByName).
    var styleObj = null;
    try { styleObj = workDoc.characterStyles.add({ name: name }); }
    catch (eAdd) {
        try { styleObj = workDoc.characterStyles.itemByName(name); }
        catch (eN) { styleObj = null; }
        if (styleObj) {
            var ok = false;
            try { ok = !!styleObj.isValid; } catch (eV) { ok = true; }
            if (!ok) styleObj = null;
        }
    }
    if (!styleObj) throw new Error("characterStyles add+itemByName both failed for '" + name + "'");

    // ── props: full diff MINUS raw font dims, PLUS resolved font + fillColor/position ──
    var props = empPropsSpec ? empPropsSpec(diff) : {};
    // drop the raw font dims (we set the RESOLVED installed face instead).
    try { delete props.appliedFontFamily; } catch (ePf) {}
    try { delete props.fontStyle; } catch (ePs) {}

    // [P2b Fix a — 4th APPLY-time sink] normalize the emphasis font to its
    // installed twin BEFORE writing. This runs AFTER the commit-time
    // _sweepManagedStyleFonts, so the sweep can NOT catch a legacy/cold family
    // baked here — normalize at the write instead. A legacy family resolves to its
    // installed twin (Dax Light→Dax Pro); a missing one resolves null → kept as-is
    // (no substitution — policy-aligned). Keep the BARE appliedFont+fontStyle form
    // (NOT the "family\tstyle" tab-name — it collides with the props-bag Font-object
    // form here, per the note below); cold-robustness is out of reach for this sink
    // by that constraint, but emphasis families come from the doc's own runs (warm).
    try {
        // Use I._resolveInstalledFontName — the resolver is exported ONLY under
        // SSB._internal (so `SSB._resolveInstalledFontName` is undefined and would
        // throw→swallow→silent no-op). I === SSB._internal here; typeof-guard mirrors
        // the existing use at :1731.
        if (typeof I._resolveInstalledFontName === "function") {
            var _instEmp = I._resolveInstalledFontName(workDoc, family, style);
            if (_instEmp) { family = _instEmp.family; style = _instEmp.fontStyle; }
        }
    } catch (eNormEmp) {}
    // resolved font via the style-OBJECT contract: appliedFont=family + fontStyle
    // separately (NOT "family\tstyle"). Set on the style object directly so the
    // properties bag doesn't collide with the Font-object form of appliedFont.
    try { styleObj.appliedFont = family; } catch (eAF) {}
    try { styleObj.fontStyle = style; } catch (eFS) {}
    // univ-italic: CS-body faux skew (the carrier-#1 fold). CS-body skew survives
    // clearOverrides — unlike a direct per-char override (host probe 20260625_01).
    // >0 = faux angle; 0 clears any stale skew (real italic / non-italic / surface).
    try { styleObj.skew = _fauxSkew; } catch (eSkewCS) {}

    // fillColorSpec → swatch (deps.ColorSpace + deps.ColorModel via _resolveFillColor).
    if (Object.prototype.hasOwnProperty.call(props, "fillColorSpec")) {
        var spec = props.fillColorSpec;
        try { delete props.fillColorSpec; } catch (eDel) {}
        if (resolveFillColor) {
            var sw = null;
            try { sw = resolveFillColor(workDoc, spec, deps); } catch (eRF) {}
            if (sw) props.fillColor = sw;
        }
    }
    // position string → DOM Position enum (deps.Position).
    if (Object.prototype.hasOwnProperty.call(props, "position")) {
        var posStr = String(props.position || "").toUpperCase();
        try { delete props.position; } catch (eDp) {}
        var posEnum = (deps && deps.Position) ? deps.Position[posStr] : null;
        if (posEnum) props.position = posEnum;
    }

    // apply the remaining (non-font, swatch/enum-resolved) props as a bag.
    try { styleObj.properties = props; } catch (eProps) {
        // fall back to per-key best-effort so one bad dim doesn't drop the rest.
        for (var pk in props) {
            if (!Object.prototype.hasOwnProperty.call(props, pk)) continue;
            try { styleObj[pk] = props[pk]; } catch (ePK) {}
        }
    }
    return styleObj;
}

// Capture full-matrix direct overrides per-char on a sub-range, keyed by
// paragraph-relative index. Mirrors _readCharOverrides (the full matrix used
// by captureDocDirectOverrides). Returns [{ idx, ov }, ...].
function _captureSubRangeOverrides(para, subStart, subEnd) {
    var out = [];
    var paraDef = _paragraphDefaults(para);
    for (var idx = subStart; idx <= subEnd; idx++) {
        var ch = null;
        try { ch = para.characters.item(idx); } catch (eCh) { ch = null; }
        if (!ch) continue;
        var ov = null;
        try { ov = _readCharOverrides(ch, paraDef); } catch (eRd) { ov = null; }
        if (ov) out.push({ idx: idx, ov: ov });
    }
    return out;
}

// Replay captured full-matrix overrides on a sub-range AFTER the char style
// was assigned — but ONLY the dims the run.diff did NOT set (the diff-set dims
// now belong to the emphasis CS; font dims NEVER replay; SPEC §13.2 filter).
function _replaySubRangeOverrides(para, subStart, subEnd, captured, diff, skipSkew) {
    if (!captured || !captured.length) return;
    var capsEnum = _resolveCapitalizationEnum();
    var posEnum = _resolvePositionEnumDoc();
    var diffHas = function (key) { return !!(diff && Object.prototype.hasOwnProperty.call(diff, key)); };
    // map diff keys → override dims they own (so we don't replay over them).
    var diffOwnsFill = diffHas("fillColor");
    var diffOwnsSize = diffHas("fontSize");
    var diffOwnsUnderline = diffHas("underline");
    var diffOwnsStrike = diffHas("strikeThrough");
    var diffOwnsTracking = diffHas("tracking");
    var diffOwnsBaseline = diffHas("baseline_shift");
    var diffOwnsHScale = diffHas("horizontal_scale");
    var diffOwnsVScale = diffHas("vertical_scale");
    var diffOwnsSkew = diffHas("skew");
    var diffOwnsPosition = diffHas("position");

    for (var i = 0; i < captured.length; i++) {
        var rec = captured[i];
        var ov = rec.ov;
        if (!ov) continue;
        var range = null;
        try { range = para.characters.itemByRange(rec.idx, rec.idx); } catch (eIB) { continue; }
        // caps: emphasis runs never carry capitalization → always replay.
        // Resolve to the Capitalization enum where available; fall back to the
        // captured string (works in test mocks; mirrors _restoreDirectCharOverrideRanges).
        if (ov.caps) {
            var cv = capsEnum ? capsEnum[ov.caps] : null;
            try { range.capitalization = (cv !== undefined && cv !== null) ? cv : ov.caps; } catch (eC) {}
        }
        // fillColor / pointSize: replay only if the diff didn't set them.
        if (ov.fcRef && !diffOwnsFill) {
            try { if (ov.fcRef.isValid) range.fillColor = ov.fcRef; } catch (eF) {}
        }
        if (ov.pt !== null && ov.pt !== undefined && !diffOwnsSize) {
            try { range.pointSize = ov.pt; } catch (ePt) {}
        }
        // typographic geometry (#27 wide matrix dims): replay unless diff owns.
        if (ov.tracking !== null && ov.tracking !== undefined && !diffOwnsTracking) {
            try { range.tracking = ov.tracking; } catch (eTr) {}
        }
        if (ov.horizontalScale !== null && ov.horizontalScale !== undefined && !diffOwnsHScale) {
            try { range.horizontalScale = ov.horizontalScale; } catch (eHs) {}
        }
        if (ov.verticalScale !== null && ov.verticalScale !== undefined && !diffOwnsVScale) {
            try { range.verticalScale = ov.verticalScale; } catch (eVs) {}
        }
        if (ov.kerningValue !== null && ov.kerningValue !== undefined) {
            try { range.kerningValue = ov.kerningValue; } catch (eKv) {}
        }
        // univ-italic: skipSkew (italic-marked run) → the emphasis CS BODY owns the
        // skew; never restore a captured skew as a direct override over it.
        if (ov.skew !== null && ov.skew !== undefined && !diffOwnsSkew && !skipSkew) {
            try { range.skew = ov.skew; } catch (eSk) {}
        }
        if (ov.baselineShift !== null && ov.baselineShift !== undefined && !diffOwnsBaseline) {
            try { range.baselineShift = ov.baselineShift; } catch (eBs) {}
        }
        if (ov.leading !== null && ov.leading !== undefined) {
            try { range.leading = ov.leading; } catch (eLd) {}
        }
        if (ov.position && posEnum && !diffOwnsPosition) {
            var pv = posEnum[ov.position];
            if (pv !== undefined && pv !== null) { try { range.position = pv; } catch (ePos) {} }
        }
        if (ov.fillTint !== null && ov.fillTint !== undefined && ov.fillTint >= 0 && !diffOwnsFill) {
            try { range.fillTint = ov.fillTint; } catch (eFt) {}
        }
        if (ov.noBreak !== null && ov.noBreak !== undefined) {
            try { range.noBreak = !!ov.noBreak; } catch (eNb) {}
        }
        // underline / strikeThrough visual detail (incl. GAP color/tint): replay
        // unless diff owns the toggle. The gap dims are part of the captured
        // matrix (_readCharOverrides ulGap*/stGap*) — replay them with the rest.
        if (!diffOwnsUnderline) {
            if (ov.ulColorRef) { try { if (ov.ulColorRef.isValid) range.underlineColor = ov.ulColorRef; } catch (e) {} }
            if (ov.ulTint !== null && ov.ulTint !== undefined) { try { range.underlineTint = ov.ulTint; } catch (e) {} }
            if (ov.ulWeight !== null && ov.ulWeight !== undefined) { try { range.underlineWeight = ov.ulWeight; } catch (e) {} }
            if (ov.ulOffset !== null && ov.ulOffset !== undefined) { try { range.underlineOffset = ov.ulOffset; } catch (e) {} }
            if (ov.ulGapColorRef) { try { if (ov.ulGapColorRef.isValid) range.underlineGapColor = ov.ulGapColorRef; } catch (e) {} }
            if (ov.ulGapTint !== null && ov.ulGapTint !== undefined) { try { range.underlineGapTint = ov.ulGapTint; } catch (e) {} }
        }
        if (!diffOwnsStrike) {
            if (ov.stColorRef) { try { if (ov.stColorRef.isValid) range.strikeThroughColor = ov.stColorRef; } catch (e) {} }
            if (ov.stTint !== null && ov.stTint !== undefined) { try { range.strikeThroughTint = ov.stTint; } catch (e) {} }
            if (ov.stWeight !== null && ov.stWeight !== undefined) { try { range.strikeThroughWeight = ov.stWeight; } catch (e) {} }
            if (ov.stOffset !== null && ov.stOffset !== undefined) { try { range.strikeThroughOffset = ov.stOffset; } catch (e) {} }
            if (ov.stGapColorRef) { try { if (ov.stGapColorRef.isValid) range.strikeThroughGapColor = ov.stGapColorRef; } catch (e) {} }
            if (ov.stGapTint !== null && ov.stGapTint !== undefined) { try { range.strikeThroughGapTint = ov.stGapTint; } catch (e) {} }
        }
        // appliedLanguage (#29 G6 — never a diff dim) → always replay. Prefer the
        // captured Language ref; emphasis runs never carry language so no filter.
        if (ov.langRef && typeof ov.langRef === "object") {
            try { if (ov.langRef.isValid) range.appliedLanguage = ov.langRef; } catch (eLang) {}
        }
        // stroke detail (never a diff dim) → always replay.
        if (ov.strokeColorRef) { try { if (ov.strokeColorRef.isValid) range.strokeColor = ov.strokeColorRef; } catch (e) {} }
        if (ov.strokeTint !== null && ov.strokeTint !== undefined) { try { range.strokeTint = ov.strokeTint; } catch (e) {} }
        if (ov.strokeWeight !== null && ov.strokeWeight !== undefined) { try { range.strokeWeight = ov.strokeWeight; } catch (e) {} }
        // NOTE: font/fontFamily/fontStyle dims NEVER replay — the emphasis CS owns the font.
    }
}

function _applyDiffToRange(range, diff, workDoc, deps) {
    var failures = [];
    if (!diff) return failures;

    // fontFamily + fontStyle: when both present in diff, set them together via
    // the "Family\tStyle" appliedFont form. This is more robust than two
    // separate assignments — InDesign resolves the full font in one shot
    // and avoids "fontStyle not available" errors caused by setting style
    // before family is materialized on the range.
    var hasFam = Object.prototype.hasOwnProperty.call(diff, "fontFamily");
    var hasStyle = Object.prototype.hasOwnProperty.call(diff, "fontStyle");
    if (hasFam && hasStyle) {
        try {
            range.appliedFont = String(diff.fontFamily) + "\t" + String(diff.fontStyle);
        } catch (e) {
            failures.push("appliedFont(family+style): " + (e && e.message ? e.message : e));
            // fall back to separate sets
            try { range.appliedFont = String(diff.fontFamily); } catch (e1) { failures.push("appliedFont: " + (e1 && e1.message ? e1.message : e1)); }
            try { range.fontStyle = String(diff.fontStyle); } catch (e2) { failures.push("fontStyle: " + (e2 && e2.message ? e2.message : e2)); }
        }
    } else if (hasFam) {
        try { range.appliedFont = String(diff.fontFamily); }
        catch (e) { failures.push("appliedFont: " + (e && e.message ? e.message : e)); }
    } else if (hasStyle) {
        // Compose with the run's CURRENT effective family so style requests
        // resolve against the right typeface even when the diff omits family.
        var currentFamily = null;
        try {
            var af = range.appliedFont;
            if (af && af.fontFamily) currentFamily = String(af.fontFamily);
            else if (af && af.name)  currentFamily = String(af.name).split("\t")[0];
        } catch (eF) {}
        if (currentFamily) {
            // TODO#15 ②: brand pair-authoritative emphasis weight. The run carries
            // the SOURCE weight name ("Semibold"); composing it raw against the
            // mapped CJK family yields a non-existent face ("MHei PRC\tSemibold")
            // that gets silently downgraded one notch (→Bold). When a resolver is
            // wired, recover the brand target weight (Semibold→Xbold) so a REAL
            // installed brand face is applied. Latin families return null → keep
            // the source weight verbatim. Fail-open.
            var __styleToApply = String(diff.fontStyle);
            if (deps && typeof deps.cjkEmphasisWeight === "function") {
                var __brandW = null;
                try { __brandW = deps.cjkEmphasisWeight(currentFamily, __styleToApply); } catch (eBW) {}
                if (__brandW) __styleToApply = String(__brandW);
            }
            try { range.appliedFont = currentFamily + "\t" + __styleToApply; }
            catch (e) { failures.push("appliedFont(currentFamily+style): " + (e && e.message ? e.message : e)); }
        } else {
            try { range.fontStyle = String(diff.fontStyle); }
            catch (e) { failures.push("fontStyle: " + (e && e.message ? e.message : e)); }
        }
    }

    if (Object.prototype.hasOwnProperty.call(diff, "fontSize")) {
        try { range.pointSize = Number(diff.fontSize); }
        catch (e) { failures.push("pointSize: " + (e && e.message ? e.message : e)); }
    }
    if (Object.prototype.hasOwnProperty.call(diff, "underline")) {
        try { range.underline = !!diff.underline; }
        catch (e) { failures.push("underline: " + (e && e.message ? e.message : e)); }
    }
    if (Object.prototype.hasOwnProperty.call(diff, "strikeThrough")) {
        try { range.strikeThru = !!diff.strikeThrough; }
        catch (e) { failures.push("strikeThru: " + (e && e.message ? e.message : e)); }
    }
    if (Object.prototype.hasOwnProperty.call(diff, "tracking")) {
        try { range.tracking = Number(diff.tracking); }
        catch (e) { failures.push("tracking: " + (e && e.message ? e.message : e)); }
    }
    if (Object.prototype.hasOwnProperty.call(diff, "baseline_shift")) {
        try { range.baselineShift = Number(diff.baseline_shift); }
        catch (e) { failures.push("baselineShift: " + (e && e.message ? e.message : e)); }
    }
    if (Object.prototype.hasOwnProperty.call(diff, "horizontal_scale")) {
        try { range.horizontalScale = Number(diff.horizontal_scale); }
        catch (e) { failures.push("horizontalScale: " + (e && e.message ? e.message : e)); }
    }
    if (Object.prototype.hasOwnProperty.call(diff, "vertical_scale")) {
        try { range.verticalScale = Number(diff.vertical_scale); }
        catch (e) { failures.push("verticalScale: " + (e && e.message ? e.message : e)); }
    }
    if (Object.prototype.hasOwnProperty.call(diff, "skew")) {
        try { range.skew = Number(diff.skew); }
        catch (e) { failures.push("skew: " + (e && e.message ? e.message : e)); }
    }
    if (Object.prototype.hasOwnProperty.call(diff, "fillColor")) {
        var color = _resolveOrCreateColor(diff.fillColor, workDoc, deps);
        if (color) {
            try { range.fillColor = color; }
            catch (e) { failures.push("fillColor: " + (e && e.message ? e.message : e)); }
        }
    }
    // #E2E-1 import side: apply position diff. Resolve the string ("SUPERSCRIPT"
    // etc.) into the DOM Position enum via deps.position. Without this branch,
    // emphasis_extractor's `{position: "SUPERSCRIPT"}` diff lands here as a
    // silent no-op — round-trip lost ®* superscripts on the Client-A card names.
    if (Object.prototype.hasOwnProperty.call(diff, "position")) {
        var posStr = String(diff.position || "").toUpperCase();
        var posEnum = (deps && deps.position) ? deps.position[posStr] : null;
        if (posEnum) {
            try { range.position = posEnum; }
            catch (e) { failures.push("position: " + (e && e.message ? e.message : e)); }
        } else if (posStr && posStr !== "NORMAL") {
            failures.push("position: unresolved enum " + posStr);
        }
    }
    return failures;
}

function _resolveOrCreateColor(c, workDoc, deps) {
    if (!c || !workDoc) return null;
    if (c.swatch) {
        try {
            var sw = workDoc.swatches.itemByName(String(c.swatch));
            if (sw && sw.isValid) return sw;
        } catch (e) {}
    }
    if (c.values && c.values.length === 3 && (!c.space || c.space === "RGB")) {
        var r = Math.max(0, Math.min(255, Math.round(c.values[0])));
        var g = Math.max(0, Math.min(255, Math.round(c.values[1])));
        var b = Math.max(0, Math.min(255, Math.round(c.values[2])));
        var name = "_T_emp_rgb_" + r + "_" + g + "_" + b;
        try {
            var existing = workDoc.colors.itemByName(name);
            if (existing && existing.isValid) return existing;
        } catch (eL) {}
        if (deps && deps.ColorModel && deps.ColorSpace) {
            try {
                return workDoc.colors.add({
                    name: name,
                    model: deps.ColorModel.PROCESS,
                    space: deps.ColorSpace.RGB,
                    colorValue: [r, g, b]
                });
            } catch (eA) {}
        }
    }
    return null;
}

// ─── Module exports ────────────────────────────────────────────────

// ─── #27 doc-wide direct char override preserver ──────────────────
// Per-paragraph capture inside applyClusterStyleToParagraph (above)
// captures POST-preclean values, which is too late: preclean's
// splitSoftBreaksWithFormatChange does `ch.contents = "\r"` to promote
// soft breaks to hard breaks, and InDesign's DOM as a side effect
// resets ALL direct character overrides on the affected paragraph.
// By the time apply runs, ALL_CAPS / Paper / pointSize overrides on
// the original paragraph's chars are already gone — capture sees
// NORMAL/Black/default-pt and restores those (no-op).
//
// Doc-wide capture BEFORE preclean fixes this: char offsets within
// each story are stable through preclean ((LS) → \r is 1-char-in /
// 1-char-out) and through pure reorganize apply (no para.contents
// rewrite). So the captured (storyId, charOffsetInStory) coordinates
// stay valid all the way to the post-apply restore call.
//
// Properties tracked: capitalization, fillColor (swatch ref + id),
// pointSize. Each is captured ONLY when it differs from the para
// style's value at capture time — so chars without "real" overrides
// don't get spurious "+" override flags after restore.

function _paragraphDefaults(para) {
    var def = { caps: "", fcId: "", pt: 0, fontFamily: "", fontStyle: "",
        position: "", fillTint: -1, noBreak: false, langName: "",
        // Client-A-regression-2026-05-28: per-char `tracking` override (negative
        // values used to tighten display headlines like "Life Insurance"
        // so they fit in narrow threaded frames) was previously dropped
        // by reorganize, causing 2-line titles to re-wrap to 3 lines and
        // overflow into the next frame in the thread. Capture + restore
        // it on the same path as caps/fc/pt/font.
        tracking: 0,
        // #31 G8/G9: stroke + underline-detail + strikeThrough-detail
        strokeColorId: "", strokeTint: -1, strokeWeight: 0,
        ulColorId: "", ulTint: -1, ulWeight: 0, ulOffset: 0,
        ulGapColorId: "", ulGapTint: -1,
        stColorId: "", stTint: -1, stWeight: 0, stOffset: 0,
        stGapColorId: "", stGapTint: -1 };
    try {
        var ps = para.appliedParagraphStyle;
        if (ps && ps.isValid) {
            try { def.caps = String(ps.capitalization); } catch (e) {}
            try { def.fcId = String(ps.fillColor.id); } catch (e) {}
            try { def.pt = ps.pointSize; } catch (e) {}
            try { def.tracking = ps.tracking; } catch (e) {}
            // Para style's effective font family (string, since accessing
            // .fontFamily on the Font object). fontStyle on the para style
            // can be the literal "NOTHING" string in UXP — treat as "".
            try {
                var psFont = ps.appliedFont;
                if (psFont && typeof psFont === "object") { def.fontFamily = String(psFont.fontFamily || ""); }
                else if (typeof psFont === "string") { def.fontFamily = String(psFont); }
            } catch (eFf) {}
            try {
                var fs = String(ps.fontStyle);
                if (fs && fs !== "NOTHING") def.fontStyle = fs;
            } catch (eFs) {}
            // #29 G2 / G5 / G6 / G7: para style's effective values for
            // position / fillTint / appliedLanguage / noBreak so the
            // capture step only records chars whose direct override
            // DIFFERS from para style (avoiding spurious "+" overrides
            // after restore).
            try { def.position = String(ps.position); } catch (eP1) {}
            try { def.fillTint = ps.fillTint; } catch (eFt) {}
            try { def.noBreak = !!ps.noBreak; } catch (eNb) {}
            try { def.langName = ps.appliedLanguage ? String(ps.appliedLanguage.name) : ""; } catch (eLn) {}
            // #31 G8: stroke + #31 G9: underline / strikeThrough visual detail
            try { def.strokeColorId = String(ps.strokeColor && ps.strokeColor.id); } catch (e) {}
            try { def.strokeTint = ps.strokeTint; } catch (e) {}
            try { def.strokeWeight = ps.strokeWeight; } catch (e) {}
            try { def.ulColorId = String(ps.underlineColor && ps.underlineColor.id); } catch (e) {}
            try { def.ulTint = ps.underlineTint; } catch (e) {}
            try { def.ulWeight = ps.underlineWeight; } catch (e) {}
            try { def.ulOffset = ps.underlineOffset; } catch (e) {}
            try { def.ulGapColorId = String(ps.underlineGapColor && ps.underlineGapColor.id); } catch (e) {}
            try { def.ulGapTint = ps.underlineGapTint; } catch (e) {}
            try { def.stColorId = String(ps.strikeThroughColor && ps.strikeThroughColor.id); } catch (e) {}
            try { def.stTint = ps.strikeThroughTint; } catch (e) {}
            try { def.stWeight = ps.strikeThroughWeight; } catch (e) {}
            try { def.stOffset = ps.strikeThroughOffset; } catch (e) {}
            try { def.stGapColorId = String(ps.strikeThroughGapColor && ps.strikeThroughGapColor.id); } catch (e) {}
            try { def.stGapTint = ps.strikeThroughGapTint; } catch (e) {}
        }
    } catch (eP) {}
    return def;
}

function _readCharOverrides(ch, paraDef) {
    var out = { caps: null, fcRef: null, fcId: null, pt: null,
        fontRef: null, fontFamily: null, fontStyle: null,
        tracking: null, horizontalScale: null, verticalScale: null,
        kerningValue: null, skew: null, baselineShift: null,
        leading: null,
        position: null, fillTint: null, noBreak: null, langRef: null, langName: null };
    try {
        var caps = String(ch.capitalization);
        if (caps && caps !== paraDef.caps) out.caps = caps;
    } catch (e) {}
    // Client-A-regression-2026-05-28: capture any non-default char-level
    // typographic geometry override. Reorganize's cluster-style builder
    // snaps these dims to "deadzone defaults" (tracking 0, scale 100,
    // kerningValue 0, skew 0, baselineShift 0) regardless of source PS,
    // so any non-default char.X that originally was inherited from the
    // source PS gets lost after re-cluster — causing body paragraphs to
    // re-wrap, headlines to break, and threaded frames to cascade-overflow.
    // Capture whenever the value is non-default, regardless of paraDef,
    // so the restore step pins the value back on the char range and
    // survives the cluster PS reset.
    try {
        var tr = ch.tracking;
        if (typeof tr === "number" && tr !== 0) out.tracking = tr;
    } catch (eTr) {}
    try {
        var hs = ch.horizontalScale;
        if (typeof hs === "number" && hs !== 100) out.horizontalScale = hs;
    } catch (eHs) {}
    try {
        var vs = ch.verticalScale;
        if (typeof vs === "number" && vs !== 100) out.verticalScale = vs;
    } catch (eVs) {}
    try {
        var kv = ch.kerningValue;
        if (typeof kv === "number" && kv !== 0) out.kerningValue = kv;
    } catch (eKv) {}
    try {
        var sk = ch.skew;
        if (typeof sk === "number" && sk !== 0) out.skew = sk;
    } catch (eSk) {}
    try {
        var bs = ch.baselineShift;
        if (typeof bs === "number" && bs !== 0) out.baselineShift = bs;
    } catch (eBs) {}
    // leading: same problem as pointSize. Cluster style averaging may
    // assign a different leading (e.g. source PS 9pt/12pt → cluster
    // 10.5pt/14pt), and chars that inherited the source leading lose
    // it after re-cluster. Capture always-readable, restore is idempotent.
    try {
        var ld = ch.leading;
        if (typeof ld === "number" && ld > 0) out.leading = ld;
    } catch (eLd) {}
    try {
        var fc = ch.fillColor;
        var fcId = "";
        if (fc && fc.isValid) {
            try { fcId = String(fc.id); } catch (eIdF) { fcId = String(fc.name || ""); }
        }
        if (fcId && fcId !== paraDef.fcId) {
            out.fcRef = fc;
            out.fcId = fcId;
        }
    } catch (e) {}
    // Client-A-regression-2026-05-28: same problem as tracking. The cluster
    // PS auto-merge can collapse paragraphs of different pointSizes into
    // a single cluster (e.g. 9pt body + 10.5pt body → 10.5pt cluster),
    // and chars that inherited from a source 9pt PS lose pointSize after
    // re-cluster. Capture char.pointSize whenever readable, not only
    // when it differs from paraDef.pt — restore is idempotent so pinning
    // a value that already matches the cluster does no harm.
    try {
        var pt = ch.pointSize;
        if (typeof pt === "number" && pt > 0) out.pt = pt;
    } catch (e) {}
    // #28b: capture appliedFont + fontStyle when they differ from
    // the paragraph style's effective values. These are the second
    // designer-override channel (after caps/fc/pt) — a designer who
    // set fontFamily=EJ Sans Text on a char-level override on top of
    // a Character Style that says fontFamily=Gotham loses the override
    // during apply's normalize, so the char style's Gotham wins. Capture
    // the live override now + replay after apply restores the char style.
    try {
        var fnt = ch.appliedFont;
        var fam = "";
        if (fnt && typeof fnt === "object") {
            try { fam = String(fnt.fontFamily || ""); } catch (eFamObj) {}
        } else if (typeof fnt === "string") {
            fam = String(fnt);
        }
        if (fam && fam !== paraDef.fontFamily) {
            out.fontRef = fnt;
            out.fontFamily = fam;
        }
    } catch (eFnt) {}
    try {
        var fst = String(ch.fontStyle);
        if (fst && fst !== "NOTHING" && fst !== paraDef.fontStyle) {
            out.fontStyle = fst;
        }
    } catch (eFst) {}
    // #29 G2: Position (NORMAL / SUPERSCRIPT / SUBSCRIPT / OT_SUPERSCRIPT etc.)
    try {
        var pos = String(ch.position);
        if (pos && pos !== paraDef.position) out.position = pos;
    } catch (ePos) {}
    // #29 G5: fillTint — InDesign returns -1 to mean "inherit", so any
    // numeric value 0..100 different from the para default IS an override.
    try {
        var ft = ch.fillTint;
        if (ft !== undefined && ft !== null && ft !== paraDef.fillTint) {
            // Treat -1 as "no override" — only record real tint values.
            if (ft >= 0) out.fillTint = ft;
        }
    } catch (eFt) {}
    // #29 G7: noBreak (keep word together)
    try {
        var nb = !!ch.noBreak;
        if (nb !== !!paraDef.noBreak) out.noBreak = nb;
    } catch (eNb) {}
    // #29 G6: appliedLanguage. Languages are doc-level objects; keep
    // both the ref (preferred for restore) and the name (fallback).
    try {
        var lang = ch.appliedLanguage;
        var lnm = "";
        if (lang) { try { lnm = String(lang.name || ""); } catch (eLn1) {} }
        if (lnm && lnm !== paraDef.langName) {
            out.langRef = lang;
            out.langName = lnm;
        }
    } catch (eL) {}
    // #31 G8 (stroke) + G9 (underline / strikeThrough visual detail).
    // Each property captured separately, only when it differs from
    // para style's effective value. Color refs preserved as objects.
    out.strokeColorRef = null; out.strokeColorId = null; out.strokeTint = null; out.strokeWeight = null;
    out.ulColorRef = null; out.ulColorId = null; out.ulTint = null; out.ulWeight = null; out.ulOffset = null;
    out.ulGapColorRef = null; out.ulGapColorId = null; out.ulGapTint = null;
    out.stColorRef = null; out.stColorId = null; out.stTint = null; out.stWeight = null; out.stOffset = null;
    out.stGapColorRef = null; out.stGapColorId = null; out.stGapTint = null;
    function _captureColor(propName, refKey, idKey, defaultId) {
        try {
            var sw = ch[propName];
            if (sw && sw.isValid) {
                var sid = "";
                try { sid = String(sw.id); } catch (eId) { sid = String(sw.name || ""); }
                if (sid && sid !== defaultId) { out[refKey] = sw; out[idKey] = sid; }
            }
        } catch (e) {}
    }
    function _captureNum(propName, key, defaultVal) {
        try {
            var v = ch[propName];
            if (v !== null && v !== undefined && v !== defaultVal) out[key] = v;
        } catch (e) {}
    }
    _captureColor("strokeColor", "strokeColorRef", "strokeColorId", paraDef.strokeColorId);
    _captureNum("strokeTint",   "strokeTint",   paraDef.strokeTint);
    _captureNum("strokeWeight", "strokeWeight", paraDef.strokeWeight);
    _captureColor("underlineColor",    "ulColorRef",    "ulColorId",    paraDef.ulColorId);
    _captureNum  ("underlineTint",     "ulTint",        paraDef.ulTint);
    _captureNum  ("underlineWeight",   "ulWeight",      paraDef.ulWeight);
    _captureNum  ("underlineOffset",   "ulOffset",      paraDef.ulOffset);
    _captureColor("underlineGapColor", "ulGapColorRef", "ulGapColorId", paraDef.ulGapColorId);
    _captureNum  ("underlineGapTint",  "ulGapTint",     paraDef.ulGapTint);
    _captureColor("strikeThroughColor",    "stColorRef",    "stColorId",    paraDef.stColorId);
    _captureNum  ("strikeThroughTint",     "stTint",        paraDef.stTint);
    _captureNum  ("strikeThroughWeight",   "stWeight",      paraDef.stWeight);
    _captureNum  ("strikeThroughOffset",   "stOffset",      paraDef.stOffset);
    _captureColor("strikeThroughGapColor", "stGapColorRef", "stGapColorId", paraDef.stGapColorId);
    _captureNum  ("strikeThroughGapTint",  "stGapTint",     paraDef.stGapTint);
    return out;
}

/**
 * Walk every story's every paragraph's every character; group consecutive
 * chars sharing the same {caps, fcId, pt} override signature into runs;
 * record (storyId, story-relative offset) so a later restore can find the
 * same chars even after preclean changes paragraph structure.
 *
 * Returns: { storyId: [{ start, end, caps, fcRef, fcId, pt }, ...] }
 */
function captureDocDirectOverrides(doc, plog, deps) {
    var deps2 = deps || {};
    var getColl = deps2.getCollectionItem || _getCollectionItem;
    var byStory = {};
    var totalRuns = 0;
    var storiesProcessed = 0;
    var stories;
    try { stories = doc.stories; } catch (eDS) { return byStory; }
    var n = 0;
    try { n = stories.length; } catch (e) {}
    for (var s = 0; s < n; s++) {
        var story = getColl(stories, s);
        if (!story) continue;
        try { if (!story.isValid) continue; } catch (eIv) { continue; }
        var sid = "";
        try { sid = String(story.id); } catch (eSid) { continue; }
        var paras;
        try { paras = story.paragraphs; } catch (ePs) { continue; }
        var pCount = 0;
        try { pCount = paras.length; } catch (e) {}
        if (!pCount) continue;
        var storyCharOffset = 0;
        var runs = [];
        var cur = null;
        for (var p = 0; p < pCount; p++) {
            var para = getColl(paras, p);
            if (!para) continue;
            try { if (!para.isValid) continue; } catch (eIp) { continue; }
            var paraDef = _paragraphDefaults(para);
            var pChars;
            try { pChars = para.characters; } catch (ePc) { continue; }
            var nChars = 0;
            try { nChars = pChars.length; } catch (e) {}
            for (var c = 0; c < nChars; c++) {
                var ch = pChars.item(c);
                var values = _readCharOverrides(ch, paraDef);
                var hasAny = (values.caps !== null) || (values.fcRef !== null) || (values.pt !== null)
                    || (values.fontRef !== null) || (values.fontStyle !== null)
                    || (values.tracking !== null) || (values.horizontalScale !== null)
                    || (values.verticalScale !== null) || (values.kerningValue !== null)
                    || (values.skew !== null) || (values.baselineShift !== null)
                    || (values.leading !== null)
                    || (values.position !== null) || (values.fillTint !== null)
                    || (values.noBreak !== null) || (values.langRef !== null)
                    || (values.strokeColorRef !== null) || (values.strokeTint !== null) || (values.strokeWeight !== null)
                    || (values.ulColorRef !== null) || (values.ulTint !== null) || (values.ulWeight !== null) || (values.ulOffset !== null)
                    || (values.ulGapColorRef !== null) || (values.ulGapTint !== null)
                    || (values.stColorRef !== null) || (values.stTint !== null) || (values.stWeight !== null) || (values.stOffset !== null)
                    || (values.stGapColorRef !== null) || (values.stGapTint !== null);
                if (!hasAny) {
                    if (cur) { runs.push(cur); cur = null; }
                    continue;
                }
                // Sig key: include all stripe-aware properties so any
                // change starts a new run. Empty string for nulls.
                function _sv(v) { return v === null || v === undefined ? "" : v; }
                var sig = _sv(values.caps) + "|" + _sv(values.fcId) + "|" + _sv(values.pt)
                    + "|" + _sv(values.fontFamily) + "|" + _sv(values.fontStyle)
                    + "|" + _sv(values.tracking) + "|" + _sv(values.horizontalScale)
                    + "|" + _sv(values.verticalScale) + "|" + _sv(values.kerningValue)
                    + "|" + _sv(values.skew) + "|" + _sv(values.baselineShift)
                    + "|" + _sv(values.leading)
                    + "|" + _sv(values.position) + "|" + _sv(values.fillTint)
                    + "|" + (values.noBreak === null ? "" : (values.noBreak ? "1" : "0"))
                    + "|" + _sv(values.langName)
                    + "|" + _sv(values.strokeColorId) + "|" + _sv(values.strokeTint) + "|" + _sv(values.strokeWeight)
                    + "|" + _sv(values.ulColorId) + "|" + _sv(values.ulTint) + "|" + _sv(values.ulWeight) + "|" + _sv(values.ulOffset)
                    + "|" + _sv(values.ulGapColorId) + "|" + _sv(values.ulGapTint)
                    + "|" + _sv(values.stColorId) + "|" + _sv(values.stTint) + "|" + _sv(values.stWeight) + "|" + _sv(values.stOffset)
                    + "|" + _sv(values.stGapColorId) + "|" + _sv(values.stGapTint);
                var globalOffset = storyCharOffset + c;
                if (cur && cur.sig === sig && globalOffset === cur.end + 1) {
                    cur.end = globalOffset;
                    continue;
                }
                if (cur) runs.push(cur);
                cur = {
                    sig: sig,
                    start: globalOffset,
                    end: globalOffset,
                    caps: values.caps,
                    fcRef: values.fcRef, fcId: values.fcId,
                    pt: values.pt,
                    fontRef: values.fontRef, fontFamily: values.fontFamily,
                    fontStyle: values.fontStyle,
                    tracking: values.tracking,
                    horizontalScale: values.horizontalScale,
                    verticalScale: values.verticalScale,
                    kerningValue: values.kerningValue,
                    skew: values.skew,
                    baselineShift: values.baselineShift,
                    leading: values.leading,
                    position: values.position,
                    fillTint: values.fillTint,
                    noBreak: values.noBreak,
                    langRef: values.langRef, langName: values.langName,
                    // #31: stroke + underline-detail + strikeThrough-detail
                    strokeColorRef: values.strokeColorRef, strokeTint: values.strokeTint, strokeWeight: values.strokeWeight,
                    ulColorRef: values.ulColorRef, ulTint: values.ulTint, ulWeight: values.ulWeight, ulOffset: values.ulOffset,
                    ulGapColorRef: values.ulGapColorRef, ulGapTint: values.ulGapTint,
                    stColorRef: values.stColorRef, stTint: values.stTint, stWeight: values.stWeight, stOffset: values.stOffset,
                    stGapColorRef: values.stGapColorRef, stGapTint: values.stGapTint
                };
            }
            storyCharOffset += nChars;
        }
        if (cur) runs.push(cur);
        if (runs.length) {
            byStory[sid] = runs;
            totalRuns += runs.length;
            storiesProcessed++;
        }
    }
    if (plog) plog("preserve: captured " + totalRuns + " override runs across " + storiesProcessed + " stories (pre-preclean)");
    return byStory;
}

var _CapitalizationEnumDoc = null;
function _resolveCapsEnumDoc() {
    if (_CapitalizationEnumDoc) return _CapitalizationEnumDoc;
    try { var idsn = require("indesign"); if (idsn && idsn.Capitalization) { _CapitalizationEnumDoc = idsn.Capitalization; return _CapitalizationEnumDoc; } } catch (e) {}
    try { if (typeof Capitalization !== "undefined" && Capitalization) { _CapitalizationEnumDoc = Capitalization; return _CapitalizationEnumDoc; } } catch (e2) {}
    return null;
}

// #29 G2: Position enum (NORMAL / SUPERSCRIPT / SUBSCRIPT / OT_SUPERSCRIPT
// / OT_SUBSCRIPT / OT_NUMERATOR / OT_DENOMINATOR). Like Capitalization,
// `range.position = "ALL_CAPS"` (string) is silently rejected — must be
// the enum value.
var _PositionEnumDoc = null;
function _resolvePositionEnumDoc() {
    if (_PositionEnumDoc) return _PositionEnumDoc;
    try { var idsn = require("indesign"); if (idsn && idsn.Position) { _PositionEnumDoc = idsn.Position; return _PositionEnumDoc; } } catch (e) {}
    try { if (typeof Position !== "undefined" && Position) { _PositionEnumDoc = Position; return _PositionEnumDoc; } } catch (e2) {}
    return null;
}

/**
 * Re-apply the captured overrides AFTER the apply pipeline finishes.
 * Story-relative offsets are stable through preclean (`(LS) → \r`
 * is 1-char-in / 1-char-out) and pure reorganize apply (no para.contents
 * rewrite), so itemByRange against the same story/offsets points at the
 * same characters that were captured.
 */
function restoreDocDirectOverrides(doc, captured, plog, deps) {
    var deps2 = deps || {};
    var getColl = deps2.getCollectionItem || _getCollectionItem;
    var stats = { restored: 0, failed: 0, storiesProcessed: 0,
        capsApplied: 0, fcApplied: 0, ptApplied: 0,
        fontApplied: 0, fontStyleApplied: 0,
        // Client-A-regression-2026-05-28: per-char geometry overrides
        trackingApplied: 0, horizontalScaleApplied: 0, verticalScaleApplied: 0,
        kerningValueApplied: 0, skewApplied: 0, baselineShiftApplied: 0,
        leadingApplied: 0,
        positionApplied: 0, fillTintApplied: 0, noBreakApplied: 0, langApplied: 0,
        // #31 stroke + underline-detail + strikeThrough-detail
        strokeApplied: 0, ulDetailApplied: 0, stDetailApplied: 0 };
    if (!captured) return stats;
    var capsEnum = _resolveCapsEnumDoc();
    var posEnum = _resolvePositionEnumDoc();
    var stories;
    try { stories = doc.stories; } catch (eDS) { return stats; }
    var n = 0;
    try { n = stories.length; } catch (e) {}
    for (var s = 0; s < n; s++) {
        var story = getColl(stories, s);
        if (!story) continue;
        try { if (!story.isValid) continue; } catch (eIv) { continue; }
        var sid = "";
        try { sid = String(story.id); } catch (eSid) { continue; }
        var runs = captured[sid];
        if (!runs || !runs.length) continue;
        stats.storiesProcessed++;
        var storyChars;
        try { storyChars = story.characters; } catch (eSC) { continue; }
        var storyLen = 0;
        try { storyLen = storyChars.length; } catch (e) {}
        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            if (!run) continue;
            // Clamp to current story length in case content shrank
            var endIdx = Math.min(run.end, storyLen - 1);
            if (endIdx < run.start) { stats.failed++; continue; }
            var range = null;
            try { range = storyChars.itemByRange(run.start, endIdx); }
            catch (eIR) { stats.failed++; continue; }
            if (run.caps && capsEnum) {
                var enumVal = capsEnum[run.caps];
                if (enumVal !== undefined && enumVal !== null) {
                    try { range.capitalization = enumVal; stats.capsApplied++; } catch (eC) {}
                }
            }
            if (run.fcRef) {
                try {
                    if (run.fcRef.isValid) { range.fillColor = run.fcRef; stats.fcApplied++; }
                } catch (eF) {}
            }
            if (run.pt !== null && run.pt !== undefined) {
                try { range.pointSize = run.pt; stats.ptApplied++; } catch (ePt) {}
            }
            // #28b: font-family direct override. Prefer Font-object ref
            // (faster, exact). Fall back to family-string (range.appliedFont
            // accepts both). Only set when captured value differs from
            // post-apply para style to avoid spurious "+" overrides.
            if (run.fontRef || run.fontFamily) {
                try {
                    if (run.fontRef && typeof run.fontRef === "object") {
                        try {
                            if (run.fontRef.isValid) { range.appliedFont = run.fontRef; stats.fontApplied++; }
                            else if (run.fontFamily) { range.appliedFont = run.fontFamily; stats.fontApplied++; }
                        } catch (eFR) {
                            if (run.fontFamily) { try { range.appliedFont = run.fontFamily; stats.fontApplied++; } catch (eFR2) {} }
                        }
                    } else if (run.fontFamily) {
                        try { range.appliedFont = run.fontFamily; stats.fontApplied++; } catch (eFF) {}
                    }
                } catch (eF2) {}
            }
            if (run.fontStyle) {
                try { range.fontStyle = run.fontStyle; stats.fontStyleApplied++; } catch (eFS) {}
            }
            // Client-A-regression-2026-05-28: per-char geometry overrides
            if (run.tracking !== null && run.tracking !== undefined) {
                try { range.tracking = run.tracking; stats.trackingApplied++; } catch (eTr) {}
            }
            if (run.horizontalScale !== null && run.horizontalScale !== undefined) {
                try { range.horizontalScale = run.horizontalScale; stats.horizontalScaleApplied++; } catch (eHs) {}
            }
            if (run.verticalScale !== null && run.verticalScale !== undefined) {
                try { range.verticalScale = run.verticalScale; stats.verticalScaleApplied++; } catch (eVs) {}
            }
            if (run.kerningValue !== null && run.kerningValue !== undefined) {
                try { range.kerningValue = run.kerningValue; stats.kerningValueApplied++; } catch (eKv) {}
            }
            if (run.skew !== null && run.skew !== undefined) {
                try { range.skew = run.skew; stats.skewApplied++; } catch (eSk) {}
            }
            if (run.baselineShift !== null && run.baselineShift !== undefined) {
                try { range.baselineShift = run.baselineShift; stats.baselineShiftApplied++; } catch (eBs) {}
            }
            if (run.leading !== null && run.leading !== undefined) {
                try { range.leading = run.leading; stats.leadingApplied++; } catch (eLd) {}
            }
            // #29 G2: position (enum-typed; string assignment silently rejected)
            if (run.position && posEnum) {
                var posVal = posEnum[run.position];
                if (posVal !== undefined && posVal !== null) {
                    try { range.position = posVal; stats.positionApplied++; } catch (ePos) {}
                }
            }
            // #29 G5: fillTint (numeric 0..100; -1 means inherit so we never restore that)
            if (run.fillTint !== null && run.fillTint !== undefined && run.fillTint >= 0) {
                try { range.fillTint = run.fillTint; stats.fillTintApplied++; } catch (eFt) {}
            }
            // #29 G7: noBreak (boolean)
            if (run.noBreak !== null && run.noBreak !== undefined) {
                try { range.noBreak = !!run.noBreak; stats.noBreakApplied++; } catch (eNb) {}
            }
            // #29 G6: appliedLanguage. Prefer the captured Language ref;
            // fall back to itemByName lookup on the doc for cases where
            // ref became invalid (rare).
            if (run.langRef || run.langName) {
                try {
                    if (run.langRef && typeof run.langRef === "object") {
                        try {
                            if (run.langRef.isValid) { range.appliedLanguage = run.langRef; stats.langApplied++; }
                            else if (run.langName) {
                                var lByName = doc.languagesWithVendors.itemByName(run.langName);
                                if (lByName && lByName.isValid) { range.appliedLanguage = lByName; stats.langApplied++; }
                            }
                        } catch (eLR) {
                            if (run.langName) {
                                try {
                                    var lByName2 = doc.languagesWithVendors.itemByName(run.langName);
                                    if (lByName2 && lByName2.isValid) { range.appliedLanguage = lByName2; stats.langApplied++; }
                                } catch (eLR2) {}
                            }
                        }
                    } else if (run.langName) {
                        try {
                            var lByName3 = doc.languagesWithVendors.itemByName(run.langName);
                            if (lByName3 && lByName3.isValid) { range.appliedLanguage = lByName3; stats.langApplied++; }
                        } catch (eLN) {}
                    }
                } catch (eL2) {}
            }
            // #31 G8: stroke (color/tint/weight)
            var anyStroke = false;
            if (run.strokeColorRef) { try { if (run.strokeColorRef.isValid) { range.strokeColor = run.strokeColorRef; anyStroke = true; } } catch (eSC) {} }
            if (run.strokeTint !== null && run.strokeTint !== undefined) { try { range.strokeTint = run.strokeTint; anyStroke = true; } catch (eST) {} }
            if (run.strokeWeight !== null && run.strokeWeight !== undefined) { try { range.strokeWeight = run.strokeWeight; anyStroke = true; } catch (eSW) {} }
            if (anyStroke) stats.strokeApplied++;
            // #31 G9: underline visual detail
            var anyUl = false;
            if (run.ulColorRef) { try { if (run.ulColorRef.isValid) { range.underlineColor = run.ulColorRef; anyUl = true; } } catch (e) {} }
            if (run.ulTint !== null && run.ulTint !== undefined) { try { range.underlineTint = run.ulTint; anyUl = true; } catch (e) {} }
            if (run.ulWeight !== null && run.ulWeight !== undefined) { try { range.underlineWeight = run.ulWeight; anyUl = true; } catch (e) {} }
            if (run.ulOffset !== null && run.ulOffset !== undefined) { try { range.underlineOffset = run.ulOffset; anyUl = true; } catch (e) {} }
            if (run.ulGapColorRef) { try { if (run.ulGapColorRef.isValid) { range.underlineGapColor = run.ulGapColorRef; anyUl = true; } } catch (e) {} }
            if (run.ulGapTint !== null && run.ulGapTint !== undefined) { try { range.underlineGapTint = run.ulGapTint; anyUl = true; } catch (e) {} }
            if (anyUl) stats.ulDetailApplied++;
            // #31 G9: strikeThrough visual detail
            var anySt = false;
            if (run.stColorRef) { try { if (run.stColorRef.isValid) { range.strikeThroughColor = run.stColorRef; anySt = true; } } catch (e) {} }
            if (run.stTint !== null && run.stTint !== undefined) { try { range.strikeThroughTint = run.stTint; anySt = true; } catch (e) {} }
            if (run.stWeight !== null && run.stWeight !== undefined) { try { range.strikeThroughWeight = run.stWeight; anySt = true; } catch (e) {} }
            if (run.stOffset !== null && run.stOffset !== undefined) { try { range.strikeThroughOffset = run.stOffset; anySt = true; } catch (e) {} }
            if (run.stGapColorRef) { try { if (run.stGapColorRef.isValid) { range.strikeThroughGapColor = run.stGapColorRef; anySt = true; } } catch (e) {} }
            if (run.stGapTint !== null && run.stGapTint !== undefined) { try { range.strikeThroughGapTint = run.stGapTint; anySt = true; } catch (e) {} }
            if (anySt) stats.stDetailApplied++;
            stats.restored++;
        }
    }
    if (plog) plog("preserve: restored " + stats.restored + " runs across " + stats.storiesProcessed + " stories"
        + " (caps=" + stats.capsApplied + " fc=" + stats.fcApplied + " pt=" + stats.ptApplied
        + " font=" + stats.fontApplied + " fontStyle=" + stats.fontStyleApplied
        + " tracking=" + stats.trackingApplied + " hscale=" + stats.horizontalScaleApplied
        + " vscale=" + stats.verticalScaleApplied + " kerning=" + stats.kerningValueApplied
        + " skew=" + stats.skewApplied + " bshift=" + stats.baselineShiftApplied
        + " pos=" + stats.positionApplied + " ft=" + stats.fillTintApplied
        + " nb=" + stats.noBreakApplied + " lang=" + stats.langApplied
        + " stroke=" + stats.strokeApplied + " ulDetail=" + stats.ulDetailApplied
        + " stDetail=" + stats.stDetailApplied
        + " failed=" + stats.failed + ")");
    return stats;
}

module.exports = {
    applyClusterStyleToParagraph: applyClusterStyleToParagraph,
    applyAnnotationsToParagraph: applyAnnotationsToParagraph,
    applyEmphasisRunsToParagraph: applyEmphasisRunsToParagraph,
    applyEmphasisRunsAsOverrides: applyEmphasisRunsAsOverrides,
    // SPEC §14: faithful emphasis → combined per-script character styles.
    applyEmphasisRunsAsCharStyles: applyEmphasisRunsAsCharStyles,
    applySpaceOverridesToParagraph: applySpaceOverridesToParagraph,
    clearParaCharOverrides: clearParaCharOverrides,
    clearTranslationStyles: clearTranslationStyles,
    // #27: exported for v2_pipeline second-pass replay after emphasis
    // runs have re-set appliedCharacterStyle (which silently wipes
    // direct char overrides on the affected ranges).
    restoreDirectCharOverrideRanges: _restoreDirectCharOverrideRanges,
    // #27 doc-wide preserver (the channel that actually catches preclean
    // wipes too — captures BEFORE preclean, restores AFTER apply, since
    // story-relative char offsets stay stable through both phases).
    captureDocDirectOverrides: captureDocDirectOverrides,
    restoreDocDirectOverrides: restoreDocDirectOverrides,
    _internal: {
        _getCollectionItem: _getCollectionItem,
        _applyDiffToRange: _applyDiffToRange,
        _resolveOrCreateColor: _resolveOrCreateColor,
        // SPEC §14 emphasis-charstyle helpers (exported for unit testing).
        _applyOneEmphasisSubRun: _applyOneEmphasisSubRun,
        _ensureEmphasisCharStyle: _ensureEmphasisCharStyle,
        _resolveInstalledFaceCaseTolerant: _resolveInstalledFaceCaseTolerant,
        _scanFontsCaseInsensitive: _scanFontsCaseInsensitive
    }
};
