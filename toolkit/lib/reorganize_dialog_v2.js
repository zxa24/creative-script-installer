"use strict";

/**
 * lib/reorganize_dialog_v2.js
 *
 * Reorganize-Styles grouping dialog — UXP HTML dialog implementation.
 *
 * Unlike v1 (lib/reorganize_dialog.js), which uses the legacy
 * `app.dialogs.add()` DOM API (no body buttons, no reactive widgets), v2
 * builds the dialog from HTML `<dialog>` + `showModal()`. This unlocks:
 *   - real <button> elements with dynamic `disabled` state
 *   - reactive event listeners (change → enable/disable other widgets)
 *   - CSS styling
 *   - Promise-based modal flow that integrates with async main()
 *
 * Cognitive-load goals:
 *   - Main panel = ONE decision: 5-radio strictness ladder, last radio is
 *     "Custom" which (when selected) enables the "Advanced Parameters..."
 *     button next to it. Button stays disabled for the 4 preset radios.
 *   - 4 named ladder positions snap to a curated bundle of dim / KDE preset
 *     / colorTol settings. The "Custom" radio + button closes the main
 *     dialog and opens the advanced panel.
 *   - Advanced panel: regrouped v1-style controls (font / decoration /
 *     spacing / rare) plus the expanded 9-step KDE preset dropdown.
 *
 * Public API (identical to v1, drop-in replacement):
 *   showGroupingDialog(app, opts) → groupingChoice | null
 *
 * Returned shape (same as v1):
 *   { dimensions, autoMerge, hybridOpts, hybridPresetIndex, colorTol,
 *     runSafety, splitSoftBreaks, editMode, forceFullImport,
 *     spacePreservingMerge, splitMasterFromBody, underlineOverlap,
 *     __sourceLadder (diagnostic) }
 *
 * The `app` parameter is unused in v2 (kept for signature compatibility
 * with v1 — HTML dialogs use `document` global, not the InDesign app).
 */

var LabelDelegate = require("./dialog_label_delegate.js");

var GROUPING_DIMENSIONS = [
    { key: "fontFamily",      label: "Font family",                                                 def: true,  group: "font"    },
    { key: "fontStyle",       label: "Font weight / style",                                         def: true,  group: "font"    },
    { key: "fontSize",        label: "Font size",                                                   def: true,  group: "font"    },
    { key: "fillColor",       label: "Fill color",                                                  def: true,  group: "font"    },
    { key: "underline",       label: "Underline",                                                   def: true,  group: "font"    },
    { key: "leading",         label: "Leading",                                                     def: true,  group: "font"    },
    { key: "bullets",         label: "Bullets / numbering  (type / format / start / char)",         def: true,  group: "deco"    },
    { key: "ruleAbove",       label: "Paragraph rule above  (weight / color / offset / width)",     def: true,  group: "deco"    },
    { key: "ruleBelow",       label: "Paragraph rule below  (weight / color / offset / width)",     def: false, group: "deco"    },
    { key: "spaceBefore",     label: "Space before",                                                def: true,  group: "spacing" },
    { key: "spaceAfter",      label: "Space after",                                                 def: true,  group: "spacing" },
    { key: "leftIndent",      label: "Left indent",                                                 def: true,  group: "spacing" },
    { key: "rightIndent",     label: "Right indent",                                                def: false, group: "spacing" },
    { key: "firstLineIndent", label: "First-line indent",                                           def: true,  group: "spacing" },
    { key: "justification",   label: "Justification",                                               def: false, group: "rare"    },
    { key: "composer",        label: "Paragraph composer",                                          def: false, group: "rare"    }
];

function _applyRareDimensions(dimensions) {
    dimensions.strikeThrough     = true;
    dimensions.tracking          = true;
    dimensions.baselineShift     = true;
    dimensions.horizontalScale   = true;
    dimensions.verticalScale     = true;
    dimensions.keepWithNext      = false;
    dimensions.keepLinesTogether = false;
    return dimensions;
}

// KDE preset table (advanced panel). 9 steps interpolating between v1's
// 5 anchor points. Each entry's payload-facing shape (bw / absRatio / rel)
// matches v1's KDE_PRESETS exactly — downstream code (style_merge_advisor)
// only reads outlierBandwidthMul / outlierMaxAbsoluteRatio /
// outlierMaxRelativeDiff.
var KDE_PRESETS = [
    { label: "1 strictest+    (bw x0.8 / abs <= 3% of size  / rel <= 6%)",  bw: 0.8, absRatio: 0.03, rel: 0.06 },
    { label: "2 strictest     (bw x1.0 / abs <= 4% of size  / rel <= 8%)",  bw: 1.0, absRatio: 0.04, rel: 0.08 },
    { label: "3 strict        (bw x1.5 / abs <= 7% of size  / rel <= 14%)", bw: 1.5, absRatio: 0.07, rel: 0.14 },
    { label: "4 strict+       (bw x1.8 / abs <= 8% of size  / rel <= 17%)", bw: 1.8, absRatio: 0.08, rel: 0.17 },
    { label: "5 medium        (bw x2.0 / abs <= 10% of size / rel <= 20%)", bw: 2.0, absRatio: 0.10, rel: 0.20 },
    { label: "6 medium+       (bw x2.5 / abs <= 13% of size / rel <= 25%)", bw: 2.5, absRatio: 0.13, rel: 0.25 },
    { label: "7 loose         (bw x3.0 / abs <= 15% of size / rel <= 30%)", bw: 3.0, absRatio: 0.15, rel: 0.30 },
    { label: "8 loose+        (bw x3.5 / abs <= 20% of size / rel <= 40%)", bw: 3.5, absRatio: 0.20, rel: 0.40 },
    { label: "9 loosest       (bw x4.0 / abs <= 25% of size / rel <= 50%)", bw: 4.0, absRatio: 0.25, rel: 0.50 }
];
var KDE_DEFAULT_PRESET_INDEX = 2;
var KDE_PRESET_V1_TO_V2_INDEX = [1, 2, 4, 6, 8];

var COLOR_TOL_PRESETS = [
    { label: "1 strictest  (delta=0,   exact swatch only)",                tol: 0 },
    { label: "2 strict     (delta<=1,  ICC noise, invisible delta-E < 1)", tol: 1 },
    { label: "3 medium     (delta<=2,  tiny render diff)",                 tol: 2 },
    { label: "4 loose      (delta<=5,  small visible diff)",               tol: 5 },
    { label: "5 loosest    (delta<=10, different gray shades merge)",      tol: 10 }
];
var COLOR_TOL_DEFAULT_INDEX = 1;

var STRICTNESS_LADDER = [
    {
        key: "preserve_all",
        title: "Preserve all",
        sub:   "Every numeric difference stays a distinct style",
        dims: "all_on", kdeIdx: 0, colorTolIdx: 0
    },
    {
        key: "strict",
        title: "Strict",
        sub:   "Tolerate 0.5pt quantization noise",
        dims: "default", kdeIdx: 2, colorTolIdx: 1
    },
    {
        key: "standard",
        title: "Standard (recommended)",
        sub:   "Merge minor numeric neighbors + similar sizes",
        dims: "default", kdeIdx: 4, colorTolIdx: 2
    },
    {
        key: "loose",
        title: "Loose",
        sub:   "Wider tolerance for size / leading",
        dims: "drop_size_leading", kdeIdx: 6, colorTolIdx: 3
    }
];
var STRICTNESS_DEFAULT_INDEX = 2;
var CUSTOM_RADIO_VALUE = "custom";

// ---- dim composition helpers ----
function _dimsAllOn() {
    var d = {};
    for (var i = 0; i < GROUPING_DIMENSIONS.length; i++) d[GROUPING_DIMENSIONS[i].key] = true;
    _applyRareDimensions(d);
    return d;
}
function _dimsDefault() {
    var d = {};
    for (var i = 0; i < GROUPING_DIMENSIONS.length; i++) d[GROUPING_DIMENSIONS[i].key] = GROUPING_DIMENSIONS[i].def;
    _applyRareDimensions(d);
    return d;
}
function _dimsDropSizeLeading() {
    var d = _dimsDefault();
    d.fontSize = false;
    d.leading  = false;
    return d;
}
function _dimsFromComposition(name) {
    if (name === "all_on")            return _dimsAllOn();
    if (name === "drop_size_leading") return _dimsDropSizeLeading();
    return _dimsDefault();
}

function buildPayloadFromLadder(ladderIdx) {
    if (typeof ladderIdx !== "number" || ladderIdx < 0 || ladderIdx >= STRICTNESS_LADDER.length) {
        ladderIdx = STRICTNESS_DEFAULT_INDEX;
    }
    var entry = STRICTNESS_LADDER[ladderIdx];
    var preset = KDE_PRESETS[entry.kdeIdx];
    return {
        dimensions: _dimsFromComposition(entry.dims),
        autoMerge: "hybrid",
        hybridOpts: {
            outlierBandwidthMul: preset.bw,
            outlierMaxAbsoluteRatio: preset.absRatio,
            outlierMaxRelativeDiff: preset.rel
        },
        hybridPresetIndex: entry.kdeIdx,
        colorTol: COLOR_TOL_PRESETS[entry.colorTolIdx].tol,
        runSafety: true,
        splitSoftBreaks: true,
        editMode: false,
        forceFullImport: false,
        spacePreservingMerge: true,
        splitMasterFromBody: true,
        underlineOverlap: "preserve-both",
        __sourceLadder: entry.key
    };
}

function _buildFallbackResult(autoMergeFallback) {
    var p = buildPayloadFromLadder(STRICTNESS_DEFAULT_INDEX);
    if (autoMergeFallback !== undefined) p.autoMerge = autoMergeFallback;
    delete p.__sourceLadder;
    return p;
}

// ---- HTML escape helper ----
function _esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- common dialog styles (dark theme) ----
// Adobe Spectrum dark palette approximation:
//   surface          #2e2e2e   panel/card background
//   background       #1f1f1f   dialog overall
//   border           #494949   divider lines
//   text primary     #e6e6e6
//   text secondary   #9b9b9b
//   accent           #2680eb   Adobe blue (focused / selected hint)
// `color-scheme: dark` cues UXP's Chromium to draw native input/checkbox
// widgets with dark backgrounds where supported.
// TODO#53 (2026-08-14 #14a): fixed dialog ids are a time bomb — persistent
// plugin context keeps a native-shell registration PER ID; same-id reuse can
// inherit a corrupted ghost shell's geometry (proc-dlg measured 6339x128 while
// DOM read green). Selectors moved to stable CLASSES; ids unique per show.
var _dlgSeq = 0;
var DIALOG_STYLES = [
    'dialog.reorg-v2-dlg, dialog.reorg-v2-adv-dlg {',
    '  padding: 0; border: 1px solid #494949; min-width: 460px;',
    '  background: #1f1f1f; color: #e6e6e6; color-scheme: dark;',
    '}',
    '.reorg-body {',
    '  font-family: "Adobe Clean", sans-serif; padding: 18px 22px;',
    '  background: #1f1f1f; color: #e6e6e6;',
    '}',
    '.reorg-body h2 { margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: #f0f0f0; }',
    '.reorg-body h3 { margin: 14px 0 8px 0; font-size: 12px; font-weight: 600; color: #9b9b9b; }',
    '.reorg-body p { margin: 4px 0 12px 0; font-size: 12px; color: #9b9b9b; }',
    '.reorg-body label { font-size: 12px; color: #e6e6e6; }',
    '.reorg-body .radio-row { display: flex; align-items: baseline; margin: 5px 0; }',
    '.reorg-body .radio-row input { margin-right: 8px; accent-color: #2680eb; }',
    '.reorg-body .radio-row .title { font-weight: 500; min-width: 200px; color: #e6e6e6; }',
    '.reorg-body .radio-row .sub { color: #9b9b9b; margin-left: 8px; font-size: 11px; }',
    '.reorg-body .radio-row .inline-btn { margin-left: 14px; padding: 3px 10px; font-size: 11px; }',
    '.reorg-body button {',
    '  background: #393939; color: #e6e6e6; border: 1px solid #5a5a5a;',
    '  border-radius: 3px; cursor: pointer;',
    '}',
    '.reorg-body button:hover:not([disabled]) { background: #464646; border-color: #6f6f6f; }',
    '.reorg-body button[disabled] { opacity: 0.35; cursor: not-allowed; }',
    '.reorg-body .footer { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }',
    '.reorg-body .footer button { padding: 5px 16px; font-size: 12px; }',
    '.reorg-body .footer button.primary { background: #2680eb; border-color: #2680eb; color: #fff; }',
    '.reorg-body .footer button.primary:hover { background: #378ef0; border-color: #378ef0; }',
    '.reorg-body .dim-group {',
    '  border: 1px solid #3a3a3a; border-radius: 3px; padding: 8px 12px; margin: 6px 0;',
    '  background: #2a2a2a;',
    '}',
    '.reorg-body .dim-group .group-title { font-weight: 600; font-size: 12px; margin-bottom: 6px; color: #c8c8c8; }',
    '.reorg-body .dim-group .dim-row { display: flex; align-items: baseline; margin: 3px 0; padding-left: 8px; }',
    '.reorg-body .dim-group .dim-row input { margin-right: 6px; accent-color: #2680eb; }',
    '.reorg-body .control-row { display: flex; align-items: center; margin: 8px 0; }',
    '.reorg-body .control-row label { min-width: 220px; }',
    '.reorg-body .control-row select {',
    '  padding: 3px 6px; font-size: 11px; flex: 1;',
    '  background: #2a2a2a; color: #e6e6e6; border: 1px solid #5a5a5a; border-radius: 2px;',
    '}',
    '.reorg-body .main-edit-row {',
    '  margin: 14px 0 4px 0; padding: 8px 10px;',
    '  background: #2a2a2a; border: 1px solid #3a3a3a; border-radius: 3px;',
    '  display: flex; align-items: baseline;',
    '}',
    '.reorg-body .main-edit-row input { margin-right: 8px; accent-color: #2680eb; }',
    '.reorg-body .main-edit-row .opt-sub { color: #9b9b9b; font-size: 11px; margin-left: 6px; }',
    '.reorg-body .other-options { padding: 4px 0; }',
    '.reorg-body .other-options .opt-row { margin: 4px 0; }',
    '.reorg-body .other-options .opt-row input { margin-right: 6px; accent-color: #2680eb; }'
].join("\n");

// ---- main panel ----
// opts.initialState (optional): persists user selection when looping back
// from a cancelled advanced panel. Shape:
//   { ladderIdx: int|null, openCustom: bool, editMode: bool }
// When provided, the radio + checkbox start in that state instead of the
// defaults (ladderIdx=STRICTNESS_DEFAULT_INDEX, custom unchecked,
// editMode unchecked).
async function showMainPanel(opts) {
    if (typeof document === "undefined") return { cancelled: true, error: "no document global" };
    opts = opts || {};
    var showEditMode = (opts.showEditMode !== false);
    var init = opts.initialState || {};
    var initLadderIdx = (typeof init.ladderIdx === "number" && init.ladderIdx >= 0 && init.ladderIdx < STRICTNESS_LADDER.length)
        ? init.ladderIdx
        : STRICTNESS_DEFAULT_INDEX;
    var initCustomChecked = !!init.openCustom;
    var initEditMode = !!init.editMode;

    var dlg = document.createElement("dialog");
    dlg.id = "reorg-v2-dlg-" + (++_dlgSeq) + "-" + Date.now().toString(36);   // TODO#53
    dlg.className = "reorg-v2-dlg";

    var radiosHtml = "";
    for (var i = 0; i < STRICTNESS_LADDER.length; i++) {
        var entry = STRICTNESS_LADDER[i];
        var radioChecked = !initCustomChecked && (i === initLadderIdx);
        radiosHtml += '<div class="radio-row">'
            + '  <input type="radio" name="strictness" id="strictness-' + i + '" value="' + i + '"'
            + (radioChecked ? ' checked' : '') + '>'
            + '  <label for="strictness-' + i + '">'
            + '    <span class="title">' + _esc(entry.title) + '</span>'
            + '    <span class="sub">' + _esc(entry.sub) + '</span>'
            + '  </label>'
            + '</div>';
    }
    // Custom row with inline button (disabled until Custom radio selected).
    radiosHtml += '<div class="radio-row">'
        + '  <input type="radio" name="strictness" id="strictness-custom" value="' + CUSTOM_RADIO_VALUE + '"'
        + (initCustomChecked ? ' checked' : '') + '>'
        + '  <label for="strictness-custom">'
        + '    <span class="title">Custom</span>'
        + '  </label>'
        + '  <button id="advanced-btn" class="inline-btn"' + (initCustomChecked ? '' : ' disabled') + '>Advanced Parameters…</button>'
        + '</div>';

    var editModeRow = "";
    if (showEditMode) {
        editModeRow = '<div class="main-edit-row">'
            + '  <input type="checkbox" id="main-edit-mode"' + (initEditMode ? ' checked' : '') + '>'
            + '  <label for="main-edit-mode">Edit mode'
            + '    <span class="opt-sub">— skip automatic winner overrides (show natural per-dim winners)</span>'
            + '  </label>'
            + '</div>';
    }

    dlg.innerHTML = '<style>' + DIALOG_STYLES + '</style>'
        + '<div class="reorg-body">'
        + '  <h2>Reorganize Styles</h2>'
        + '  <p>Merge strictness:</p>'
        + '  <form id="reorg-main-form">' + radiosHtml + '</form>'
        + editModeRow
        + '  <div class="footer">'
        + '    <button id="reorg-cancel-btn" type="button">Cancel</button>'
        + '    <button id="reorg-ok-btn" type="button" class="primary">OK</button>'
        + '  </div>'
        + '</div>';

    document.body.appendChild(dlg);
    LabelDelegate.wireLabelClicks(dlg);   // 让点击 radio/checkbox 文本也生效

    var advBtn = dlg.querySelector("#advanced-btn");
    var customRadio = dlg.querySelector("#strictness-custom");
    var radios = dlg.querySelectorAll('input[name="strictness"]');

    // Reactive disabled-toggle. Use both `change` (HTML-spec when a radio
    // selection switches) and `click` (safety net for UXP event-system
    // quirks observed in probe_html_dialog.idjs where synthetic
    // dispatchEvent("change") didn't fire — real user clicks should still
    // hit `change`, but click is cheap insurance).
    function _syncAdvBtn() {
        try { advBtn.disabled = !customRadio.checked; } catch (e) {}
    }
    for (var ri = 0; ri < radios.length; ri++) {
        radios[ri].addEventListener("change", _syncAdvBtn);
        radios[ri].addEventListener("click", _syncAdvBtn);
    }

    // Routing: button click + OK both produce the same result, computed
    // from the radio selection at the moment of click.
    // resolveOuter is wrapped to be idempotent so the cancel/close event
    // listeners below (which fire on Escape and on dlg.close() called from
    // button handlers) don't overwrite the button-supplied result with a
    // generic cancellation.
    var resolveOuter = null;
    var __resolved = false;
    var resultPromise = new Promise(function (res) {
        resolveOuter = function (value) {
            if (__resolved) return;
            __resolved = true;
            res(value);
        };
    });

    function _readEditMode() {
        var el = dlg.querySelector("#main-edit-mode");
        return el ? !!el.checked : false;
    }
    function _readSelection() {
        var sel = dlg.querySelector('input[name="strictness"]:checked');
        if (!sel) return { ladderIdx: STRICTNESS_DEFAULT_INDEX, openCustom: false };
        if (sel.value === CUSTOM_RADIO_VALUE) {
            return { ladderIdx: STRICTNESS_DEFAULT_INDEX, openCustom: true };
        }
        var idx = parseInt(sel.value, 10);
        return { ladderIdx: (isNaN(idx) ? STRICTNESS_DEFAULT_INDEX : idx), openCustom: false };
    }

    // Resolve BEFORE dlg.close(): UXP may fire the "close" event
    // synchronously, and the idempotency guard would then make the
    // button's value lose to the fallback cancellation handler. The
    // wrap ensures the resolved value sticks regardless of close
    // event timing.
    dlg.querySelector("#reorg-ok-btn").addEventListener("click", function () {
        var sel = _readSelection();
        resolveOuter({ cancelled: false, ladderIdx: sel.ladderIdx, openCustom: sel.openCustom, editMode: _readEditMode() });
        try { dlg.close("ok"); } catch (e) {}
    });
    dlg.querySelector("#reorg-cancel-btn").addEventListener("click", function () {
        resolveOuter({ cancelled: true });
        try { dlg.close("cancel"); } catch (e) {}
    });
    advBtn.addEventListener("click", function () {
        // Selecting the Custom radio + clicking the button = same as
        // Custom + OK. Always route to advanced.
        resolveOuter({ cancelled: false, ladderIdx: STRICTNESS_DEFAULT_INDEX, openCustom: true, editMode: _readEditMode() });
        try { dlg.close("custom"); } catch (e) {}
    });

    // Native <dialog> close paths (Escape key fires "cancel"; any close()
    // call — including from the button handlers above — fires "close").
    // Without these listeners, showModal() doesn't reliably return a
    // promise that resolves on close, so an Escape dismiss leaves the
    // outer `await resultPromise` hanging forever. The resolveOuter wrap
    // above makes the explicit-button path win over these fallbacks.
    dlg.addEventListener("cancel", function () { resolveOuter({ cancelled: true }); });
    dlg.addEventListener("close", function () { resolveOuter({ cancelled: true }); });

    // showModal returns a Promise that resolves when dlg.close() is called.
    // We don't strictly need to await it (our resolveOuter does the same job
    // via the button click), but awaiting catches Escape-key dismiss.
    try {
        var sm = dlg.showModal();
        if (sm && typeof sm.then === "function") {
            sm.catch(function () { resolveOuter({ cancelled: true }); });
        }
    } catch (eShow) {
        resolveOuter({ cancelled: true, error: String(eShow && eShow.message || eShow) });
    }

    var result = await resultPromise;
    try { dlg.remove(); } catch (eRm) {}
    return result;
}

// ---- advanced panel ----
async function showAdvancedPanel(opts, initialPayload) {
    if (typeof document === "undefined") return null;
    opts = opts || {};
    var showRunSafety = (opts.showRunSafety !== false);
    var showSplitSoftBreaks = (opts.showSplitSoftBreaks !== false);
    // editMode moved to MAIN panel (2026-05-28). Advanced no longer exposes
    // it — initialPayload.editMode carries the main-panel selection through.
    var showImportModeOverride = !!opts.showImportModeOverride;

    var initDims = (initialPayload && initialPayload.dimensions) ? initialPayload.dimensions : _dimsDefault();
    var initKdeIdx = (initialPayload && typeof initialPayload.hybridPresetIndex === "number"
        && initialPayload.hybridPresetIndex >= 0 && initialPayload.hybridPresetIndex < KDE_PRESETS.length)
        ? initialPayload.hybridPresetIndex
        : KDE_DEFAULT_PRESET_INDEX;
    var initColorTolIdx = COLOR_TOL_DEFAULT_INDEX;
    if (initialPayload && typeof initialPayload.colorTol === "number") {
        for (var ci = 0; ci < COLOR_TOL_PRESETS.length; ci++) {
            if (COLOR_TOL_PRESETS[ci].tol === initialPayload.colorTol) { initColorTolIdx = ci; break; }
        }
    }

    var GROUP_TITLES = {
        "font":    "Font (visual identity)",
        "deco":    "Paragraph decoration",
        "spacing": "Spacing & indentation",
        "rare":    "Rare properties"
    };
    var GROUP_ORDER = ["font", "deco", "spacing", "rare"];

    var groupsHtml = "";
    for (var gi = 0; gi < GROUP_ORDER.length; gi++) {
        var gkey = GROUP_ORDER[gi];
        var rowsHtml = "";
        for (var di = 0; di < GROUPING_DIMENSIONS.length; di++) {
            var d = GROUPING_DIMENSIONS[di];
            if (d.group !== gkey) continue;
            var checked = initDims[d.key] !== false;
            rowsHtml += '<div class="dim-row">'
                + '  <input type="checkbox" id="dim-' + _esc(d.key) + '" data-dim="' + _esc(d.key) + '"' + (checked ? " checked" : "") + '>'
                + '  <label for="dim-' + _esc(d.key) + '">' + _esc(d.label) + '</label>'
                + '</div>';
        }
        groupsHtml += '<div class="dim-group">'
            + '  <div class="group-title">' + _esc(GROUP_TITLES[gkey]) + '</div>'
            + rowsHtml
            + '</div>';
    }

    var kdeOptsHtml = "";
    for (var ki = 0; ki < KDE_PRESETS.length; ki++) {
        kdeOptsHtml += '<option value="' + ki + '"' + (ki === initKdeIdx ? " selected" : "") + '>'
            + _esc(KDE_PRESETS[ki].label) + '</option>';
    }
    var colorOptsHtml = "";
    for (var coi = 0; coi < COLOR_TOL_PRESETS.length; coi++) {
        colorOptsHtml += '<option value="' + coi + '"' + (coi === initColorTolIdx ? " selected" : "") + '>'
            + _esc(COLOR_TOL_PRESETS[coi].label) + '</option>';
    }

    var otherOptsHtml = '';
    if (showSplitSoftBreaks) {
        otherOptsHtml += '<div class="opt-row"><input type="checkbox" id="opt-split-soft" checked>'
            + '<label for="opt-split-soft">Split soft line breaks (Shift+Enter) when format differs across the break</label></div>';
    }
    otherOptsHtml += '<div class="opt-row"><input type="checkbox" id="opt-space-preserving" checked>'
        + '<label for="opt-space-preserving">Format-preserving merge for space before / after (cluster winner + per-paragraph overrides)</label></div>';
    otherOptsHtml += '<div class="opt-row"><input type="checkbox" id="opt-split-master" checked>'
        + '<label for="opt-split-master">Split master spread from body (prevent master paragraphs merging into body clusters)</label></div>';
    if (showRunSafety) {
        otherOptsHtml += '<div class="opt-row"><input type="checkbox" id="opt-safety" checked>'
            + '<label for="opt-safety">Pre/post-flight safety net (expand split frames + snapshot + repair)</label></div>';
    }
    if (showImportModeOverride) {
        otherOptsHtml += '<div class="opt-row"><input type="checkbox" id="opt-force-full">'
            + '<label for="opt-force-full">Force full pipeline (ignore import-state label, re-run cluster + reorganize)</label></div>';
    }

    var dlg = document.createElement("dialog");
    dlg.id = "reorg-v2-adv-dlg-" + (++_dlgSeq) + "-" + Date.now().toString(36);   // TODO#53
    dlg.className = "reorg-v2-adv-dlg";
    dlg.innerHTML = '<style>' + DIALOG_STYLES + '</style>'
        + '<div class="reorg-body">'
        + '  <h2>Reorganize Styles — Advanced Parameters</h2>'
        + '  <p>Checked properties keep paragraphs as distinct styles; unchecked = differences in that property are ignored (merged).</p>'
        + groupsHtml
        + '  <div class="control-row">'
        + '    <label for="kde-preset">Numeric tolerance preset (font size / leading KDE):</label>'
        + '    <select id="kde-preset">' + kdeOptsHtml + '</select>'
        + '  </div>'
        + '  <div class="control-row">'
        + '    <label for="color-tol">Color tolerance preset:</label>'
        + '    <select id="color-tol">' + colorOptsHtml + '</select>'
        + '  </div>'
        + '  <h3>Other options:</h3>'
        + '  <div class="other-options">' + otherOptsHtml + '</div>'
        + '  <div class="footer">'
        + '    <button id="adv-cancel-btn" type="button">Cancel</button>'
        + '    <button id="adv-ok-btn" type="button">OK</button>'
        + '  </div>'
        + '</div>';
    document.body.appendChild(dlg);
    LabelDelegate.wireLabelClicks(dlg);

    // Idempotent resolve so cancel/close listeners (added below) can't
    // overwrite the OK-button result with a null cancellation.
    var resolveOuter = null;
    var __resolved = false;
    var resultPromise = new Promise(function (res) {
        resolveOuter = function (value) {
            if (__resolved) return;
            __resolved = true;
            res(value);
        };
    });

    function _checkboxState(id) {
        var el = dlg.querySelector("#" + id);
        return el ? !!el.checked : false;
    }
    function _readResult() {
        var dims = {};
        var cbs = dlg.querySelectorAll('[data-dim]');
        for (var i = 0; i < cbs.length; i++) {
            var key = cbs[i].getAttribute("data-dim");
            dims[key] = !!cbs[i].checked;
        }
        _applyRareDimensions(dims);

        var kdeIdx = Number(dlg.querySelector("#kde-preset").value);
        if (!isFinite(kdeIdx) || kdeIdx < 0 || kdeIdx >= KDE_PRESETS.length) kdeIdx = KDE_DEFAULT_PRESET_INDEX;
        var preset = KDE_PRESETS[kdeIdx];

        var ctIdx = Number(dlg.querySelector("#color-tol").value);
        if (!isFinite(ctIdx) || ctIdx < 0 || ctIdx >= COLOR_TOL_PRESETS.length) ctIdx = COLOR_TOL_DEFAULT_INDEX;

        return {
            dimensions: dims,
            autoMerge: "hybrid",
            hybridOpts: {
                outlierBandwidthMul: preset.bw,
                outlierMaxAbsoluteRatio: preset.absRatio,
                outlierMaxRelativeDiff: preset.rel
            },
            hybridPresetIndex: kdeIdx,
            colorTol: COLOR_TOL_PRESETS[ctIdx].tol,
            runSafety: showRunSafety ? _checkboxState("opt-safety") : true,
            splitSoftBreaks: showSplitSoftBreaks ? _checkboxState("opt-split-soft") : true,
            // editMode comes through from main panel via initialPayload —
            // advanced no longer surfaces its own checkbox.
            editMode: !!(initialPayload && initialPayload.editMode),
            forceFullImport: showImportModeOverride ? _checkboxState("opt-force-full") : false,
            spacePreservingMerge: _checkboxState("opt-space-preserving"),
            splitMasterFromBody: _checkboxState("opt-split-master"),
            underlineOverlap: "preserve-both",
            __sourceLadder: "custom"
        };
    }

    // Resolve BEFORE dlg.close() — same rationale as showMainPanel:
    // UXP may fire "close" synchronously, and the idempotency wrap
    // would otherwise lock in the fallback null instead of the
    // button's value.
    dlg.querySelector("#adv-ok-btn").addEventListener("click", function () {
        var r = _readResult();
        resolveOuter(r);
        try { dlg.close("ok"); } catch (e) {}
    });
    dlg.querySelector("#adv-cancel-btn").addEventListener("click", function () {
        resolveOuter(null);
        try { dlg.close("cancel"); } catch (e) {}
    });

    // Escape / native close fallback — see same-named handlers in
    // showMainPanel above for rationale. resolveOuter is idempotent so
    // these only fire if no button supplied a value first.
    dlg.addEventListener("cancel", function () { resolveOuter(null); });
    dlg.addEventListener("close", function () { resolveOuter(null); });

    try {
        var sm = dlg.showModal();
        if (sm && typeof sm.then === "function") {
            sm.catch(function () { resolveOuter(null); });
        }
    } catch (eShow) {
        resolveOuter(null);
    }

    var result = await resultPromise;
    try { dlg.remove(); } catch (eRm) {}
    return result;
}

async function showGroupingDialog(app, opts) {
    opts = opts || {};
    var autoMergeFallback = (opts.autoMergeFallback === undefined) ? "hybrid" : opts.autoMergeFallback;
    var interactive = opts.interactive !== false;

    // 2026-05-28: cancel-from-advanced now returns to main panel (loop)
    // instead of exiting the whole flow. Only Cancel from main panel exits.
    // State preservation: the main panel re-opens with the user's previous
    // ladder/custom/editMode selection still highlighted so they can
    // adjust without re-picking from scratch.
    var carryoverState = null;
    var loopGuard = 0;
    while (loopGuard++ < 16) {  // defensive ceiling — pathological loop = bug somewhere
        var mainOpts = {};
        for (var k in opts) {
            if (Object.prototype.hasOwnProperty.call(opts, k)) mainOpts[k] = opts[k];
        }
        if (carryoverState) mainOpts.initialState = carryoverState;

        var mainRes;
        try {
            mainRes = await showMainPanel(mainOpts);
        } catch (eMain) {
            mainRes = { cancelled: true, error: String(eMain && eMain.message || eMain) };
        }

        if (mainRes.cancelled) {
            if (!interactive) return _buildFallbackResult(autoMergeFallback);
            return null;
        }

        if (mainRes.openCustom) {
            var initialPayload = buildPayloadFromLadder(mainRes.ladderIdx);
            initialPayload.editMode = !!mainRes.editMode;
            var advRes = await showAdvancedPanel(opts, initialPayload);
            if (advRes) return advRes;
            // Cancel from advanced → loop back to main panel with the same
            // selection (Custom radio still highlighted, editMode preserved).
            carryoverState = {
                ladderIdx: mainRes.ladderIdx,
                openCustom: true,
                editMode: !!mainRes.editMode
            };
            continue;
        }

        var payload = buildPayloadFromLadder(mainRes.ladderIdx);
        payload.editMode = !!mainRes.editMode;
        return payload;
    }
    // Loop guard exhausted — should not happen, fail closed.
    return interactive ? null : _buildFallbackResult(autoMergeFallback);
}

function buildDefaultGroupingChoice(autoMergeFallback) {
    return _buildFallbackResult(autoMergeFallback);
}

module.exports = {
    showGroupingDialog: showGroupingDialog,
    buildDefaultGroupingChoice: buildDefaultGroupingChoice,
    buildPayloadFromLadder: buildPayloadFromLadder,
    GROUPING_DIMENSIONS: GROUPING_DIMENSIONS,
    KDE_PRESETS: KDE_PRESETS,
    KDE_DEFAULT_PRESET_INDEX: KDE_DEFAULT_PRESET_INDEX,
    KDE_PRESET_V1_TO_V2_INDEX: KDE_PRESET_V1_TO_V2_INDEX,
    COLOR_TOL_PRESETS: COLOR_TOL_PRESETS,
    COLOR_TOL_DEFAULT_INDEX: COLOR_TOL_DEFAULT_INDEX,
    STRICTNESS_LADDER: STRICTNESS_LADDER,
    STRICTNESS_DEFAULT_INDEX: STRICTNESS_DEFAULT_INDEX,
    CUSTOM_RADIO_VALUE: CUSTOM_RADIO_VALUE
};
