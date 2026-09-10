"use strict";

/**
 * lib/reorganize_dialog.js
 *
 * Shared style-reorganize grouping dialog. Extracted from
 * reorganize_styles_inplace.idjs so import_translations_v2.idjs can show
 * the same panel before its commit stage — same dimensions, same KDE
 * presets, same color tolerance ladder.
 *
 * The dialog uses InDesign host APIs (`app.dialogs.add`), so this lib is
 * only callable inside an .idjs entry point. Pure-Node tests should
 * mock `app` via deps.app injection.
 *
 * Public API:
 *   showGroupingDialog(app, opts) → {
 *       dimensions: { fontFamily, fontStyle, ..., underline, ... },
 *       autoMerge: "hybrid" | null,
 *       hybridOpts: { outlierBandwidthMul, outlierMaxAbsoluteRatio,
 *                     outlierMaxRelativeDiff },
 *       hybridPresetIndex: int,
 *       colorTol: int,
 *       runSafety: bool,
 *       splitSoftBreaks: bool,
 *       editMode: bool,
 *       spacePreservingMerge: bool
 *   } | null   (null = user cancelled)
 *
 *   opts (all optional):
 *     - title: string                         (default "Reorganize Styles — Grouping")
 *     - showRunSafety: bool                   (default true; off for translation flow)
 *     - showSplitSoftBreaks: bool             (default true)
 *     - showEditMode: bool                    (default true)
 *     - showImportModeOverride: bool          (default false; only shown by
 *                                              import_translations_v2 — toggles
 *                                              the "force full pipeline (skip
 *                                              edit-mode auto-detect)" override)
 *     - autoMergeFallback: string|null        (default "hybrid"; used when dialog construction fails)
 *
 *   Defaults match standalone reorganize:
 *     dimensions GROUPING_DIMENSIONS[].def + always-on rare dimensions
 *     autoMerge = "hybrid"   (KDE)
 *     hybridOpts = KDE_PRESETS[1] (2 strict)
 *     colorTol = COLOR_TOL_PRESETS[1].tol (delta<=1, ICC noise)
 *     runSafety = true
 *     splitSoftBreaks = true
 *     editMode = false
 *     spacePreservingMerge = true
 */

var GROUPING_DIMENSIONS = [
    { key: "fontFamily",      label: "Font family",                                          def: true  },
    { key: "fontStyle",       label: "Font weight / style",                                  def: true  },
    { key: "fontSize",        label: "Font size",                                            def: true  },
    { key: "fillColor",       label: "Fill color",                                           def: true  },
    { key: "underline",       label: "Underline",                                            def: true  },
    { key: "bullets",         label: "Bullets / numbering  (type / format / start / char)",  def: true  },
    { key: "leading",         label: "Leading",                                              def: true  },
    { key: "justification",   label: "Justification",                                        def: false },
    { key: "spaceBefore",     label: "Space before",                                         def: true  },
    { key: "spaceAfter",      label: "Space after",                                          def: true  },
    { key: "leftIndent",      label: "Left indent",                                          def: true  },
    { key: "rightIndent",     label: "Right indent",                                         def: false },
    { key: "firstLineIndent", label: "First-line indent",                                    def: true  },
    { key: "composer",        label: "Paragraph composer",                                   def: false },
    { key: "ruleAbove",       label: "Paragraph rule above  (weight / color / offset / width)", def: true  },
    { key: "ruleBelow",       label: "Paragraph rule below  (weight / color / offset / width)", def: false }
];

// Always-on rare dimensions (not exposed as checkboxes — distinct
// underlines / tracking / scale should never silently merge).
//
// `underline` was moved up to GROUPING_DIMENSIONS as a visible checkbox
// on 2026-05-26 — operators want to opt out of underline-as-fingerprint
// when running the standalone convert_underline_to_rule.idjs as the
// downstream cleanup step.
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

var KDE_PRESETS = [
    { label: "1 strictest  (bw x1.0 / abs <= 4% of size  / rel <= 8%)",  bw: 1.0, absRatio: 0.04, rel: 0.08 },
    { label: "2 strict     (bw x1.5 / abs <= 7% of size  / rel <= 14%)", bw: 1.5, absRatio: 0.07, rel: 0.14 },
    { label: "3 medium     (bw x2.0 / abs <= 10% of size / rel <= 20%)", bw: 2.0, absRatio: 0.10, rel: 0.20 },
    { label: "4 loose      (bw x3.0 / abs <= 15% of size / rel <= 30%)", bw: 3.0, absRatio: 0.15, rel: 0.30 },
    { label: "5 loosest    (bw x4.0 / abs <= 25% of size / rel <= 50%)", bw: 4.0, absRatio: 0.25, rel: 0.50 }
];
var KDE_DEFAULT_PRESET_INDEX = 1;   // 2 strict

var COLOR_TOL_PRESETS = [
    { label: "1 strictest  (delta=0,   exact swatch only)",                tol: 0 },
    { label: "2 strict     (delta<=1,  ICC noise, invisible delta-E < 1)", tol: 1 },
    { label: "3 medium     (delta<=2,  tiny render diff)",                 tol: 2 },
    { label: "4 loose      (delta<=5,  small visible diff)",               tol: 5 },
    { label: "5 loosest    (delta<=10, different gray shades merge)",      tol: 10 }
];
var COLOR_TOL_DEFAULT_INDEX = 1;

function _buildFallbackResult(autoMergeFallback) {
    var dims = {};
    for (var k = 0; k < GROUPING_DIMENSIONS.length; k++) {
        dims[GROUPING_DIMENSIONS[k].key] = GROUPING_DIMENSIONS[k].def;
    }
    _applyRareDimensions(dims);
    return {
        dimensions: dims,
        autoMerge: (autoMergeFallback === undefined) ? "hybrid" : autoMergeFallback,
        hybridOpts: null,
        hybridPresetIndex: KDE_DEFAULT_PRESET_INDEX,
        colorTol: COLOR_TOL_PRESETS[COLOR_TOL_DEFAULT_INDEX].tol,
        runSafety: true,
        splitSoftBreaks: true,
        editMode: false,
        // forceFullImport (only honored by import_translations_v2 when
        // showImportModeOverride was enabled). Default false → auto-detect
        // via DocProvenance (label present → edit-mode; absent → fresh full).
        forceFullImport: false,
        spacePreservingMerge: true,
        // #28 default ON: master-spread paragraphs cluster separately
        // from body-page paragraphs. Prevents body themes silently
        // absorbing brand-template master frames (footers, page numbers,
        // copyright strips, running heads, hyperlink callouts).
        splitMasterFromBody: true,
        // Underline/rule overlap dedup defaults to no-op (preserve-both)
        // as of 2026-05-26 — the UI option was removed and underline is
        // treated as a regular fingerprint dimension. Operators who want
        // to clean up overlap visually run the standalone
        // convert_underline_to_rule.idjs script.
        underlineOverlap: "preserve-both"
    };
}

function showGroupingDialog(app, opts) {
    opts = opts || {};
    var title = opts.title || "Reorganize Styles — Grouping";
    var showRunSafety = (opts.showRunSafety !== false);
    var showSplitSoftBreaks = (opts.showSplitSoftBreaks !== false);
    var showEditMode = (opts.showEditMode !== false);
    var showImportModeOverride = !!opts.showImportModeOverride;
    var autoMergeFallback = (opts.autoMergeFallback === undefined) ? "hybrid" : opts.autoMergeFallback;

    var dlg, ok = false, result = null;
    try {
        dlg = app.dialogs.add({ name: title, canCancel: true });
        var col = dlg.dialogColumns.add();
        col.staticTexts.add({ staticLabel: "Check the dimensions that should make styles DIFFERENT." });
        col.staticTexts.add({ staticLabel: "Unchecked dimensions are ignored (paragraphs differing only there get merged)." });
        col.staticTexts.add({ staticLabel: " " });

        var checkboxes = [];
        var colorTolDropdown = null;
        for (var i = 0; i < GROUPING_DIMENSIONS.length; i++) {
            var d = GROUPING_DIMENSIONS[i];
            var dimRow = col.dialogRows.add();
            var cb = dimRow.checkboxControls.add({ staticLabel: d.label, checkedState: d.def });
            checkboxes.push(cb);
            if (d.key === "fillColor") {
                var colorLabels = [];
                for (var ci = 0; ci < COLOR_TOL_PRESETS.length; ci++) colorLabels.push(COLOR_TOL_PRESETS[ci].label);
                colorTolDropdown = dimRow.dropdowns.add({
                    stringList: colorLabels,
                    selectedIndex: COLOR_TOL_DEFAULT_INDEX
                });
            }
        }

        var cbSplitSoft = null;
        if (showSplitSoftBreaks) {
            col.staticTexts.add({ staticLabel: " " });
            col.staticTexts.add({ staticLabel: "Pre-clean (text structure normalization):" });
            var splitRow = col.dialogRows.add();
            cbSplitSoft = splitRow.checkboxControls.add({
                staticLabel: "Split soft line breaks (Shift+Enter) into hard breaks when format changes across the break",
                checkedState: true
            });
        }

        var cbEditMode = null;
        if (showEditMode) {
            col.staticTexts.add({ staticLabel: " " });
            col.staticTexts.add({ staticLabel: "Emphasis extraction:" });
            var editModeRow = col.dialogRows.add();
            cbEditMode = editModeRow.checkboxControls.add({
                staticLabel: "Edit mode — bypass automatic winner overrides (show natural per-dim winners)",
                checkedState: false
            });
        }

        var cbForceFullImport = null;
        if (showImportModeOverride) {
            col.staticTexts.add({ staticLabel: " " });
            col.staticTexts.add({ staticLabel: "Import mode override (only meaningful when doc carries import-state label):" });
            var forceFullRow = col.dialogRows.add();
            cbForceFullImport = forceFullRow.checkboxControls.add({
                staticLabel: "Force full pipeline — ignore label, re-run cluster styles + reorganize fresh",
                checkedState: false
            });
        }

        col.staticTexts.add({ staticLabel: " " });
        col.staticTexts.add({ staticLabel: "Spacing merge mode:" });
        var spacePreservingRow = col.dialogRows.add();
        var cbSpacePreserving = spacePreservingRow.checkboxControls.add({
            staticLabel: "Format-preserving merge for spaceBefore/spaceAfter (cluster winner on style; per-paragraph overrides for the rest)",
            checkedState: true
        });

        var cbSafety = null;
        if (showRunSafety) {
            col.staticTexts.add({ staticLabel: " " });
            col.staticTexts.add({ staticLabel: "Pre-flight + post-flight (frame safety net):" });
            var safetyRow = col.dialogRows.add();
            cbSafety = safetyRow.checkboxControls.add({
                staticLabel: "Expand split frames + capture snapshot, then run repair after (recommended)",
                checkedState: true
            });
        }

        col.staticTexts.add({ staticLabel: " " });
        col.staticTexts.add({ staticLabel: "Auto-merge near-duplicates:" });
        var modeRow = col.dialogRows.add();
        var radioCol = modeRow.dialogColumns.add();
        var rbGroup = radioCol.radiobuttonGroups.add();
        var rbKde = rbGroup.radiobuttonControls.add({ staticLabel: "kde   (KDE peak detection - recommended)" });
        var rbOff = rbGroup.radiobuttonControls.add({ staticLabel: "off   (no merging - keep all distinct fingerprints)" });
        try { rbGroup.selectedButton = 0; } catch (eSB) {}

        var tunCol = modeRow.dialogColumns.add();
        var presetLabels = [];
        for (var pi = 0; pi < KDE_PRESETS.length; pi++) presetLabels.push(KDE_PRESETS[pi].label);
        var presetDropdown = tunCol.dropdowns.add({
            stringList: presetLabels,
            selectedIndex: KDE_DEFAULT_PRESET_INDEX
        });

        ok = dlg.show();
        if (ok) {
            result = {
                dimensions: {},
                autoMerge: "hybrid",
                hybridOpts: null,
                hybridPresetIndex: KDE_DEFAULT_PRESET_INDEX,
                colorTol: 0,
                runSafety: true,
                splitSoftBreaks: true,
                editMode: false,
                forceFullImport: false,
                spacePreservingMerge: true,
                // Underline / paragraph-rule overlap resolution is no longer
                // exposed in the dialog (removed 2026-05-26). Underline
                // becomes a regular fingerprint; the standalone
                // convert_underline_to_rule.idjs handles Client-A-style line
                // visuals as a post-step.
                underlineOverlap: "preserve-both"
            };
            if (cbSafety) {
                try { result.runSafety = !!cbSafety.checkedState; } catch (eSf) {}
            }
            if (cbSplitSoft) {
                try { result.splitSoftBreaks = !!cbSplitSoft.checkedState; } catch (eSp) {}
            }
            if (cbEditMode) {
                try { result.editMode = !!cbEditMode.checkedState; } catch (eEM) {}
            }
            if (cbForceFullImport) {
                try { result.forceFullImport = !!cbForceFullImport.checkedState; } catch (eFFI) {}
            }
            try { result.spacePreservingMerge = !!cbSpacePreserving.checkedState; } catch (eSPM) {}
            for (var j = 0; j < GROUPING_DIMENSIONS.length; j++) {
                result.dimensions[GROUPING_DIMENSIONS[j].key] = !!checkboxes[j].checkedState;
            }
            _applyRareDimensions(result.dimensions);
            try {
                var sel = rbGroup.selectedButton;
                if (sel === 1) result.autoMerge = null;
            } catch (eRB) {}
            try {
                if (colorTolDropdown) {
                    var ctIdx = colorTolDropdown.selectedIndex;
                    if (typeof ctIdx === "number" && ctIdx >= 0 && ctIdx < COLOR_TOL_PRESETS.length) {
                        result.colorTol = COLOR_TOL_PRESETS[ctIdx].tol;
                    }
                }
            } catch (eCT) {}
            try {
                var presetIdx = presetDropdown.selectedIndex;
                if (typeof presetIdx !== "number" || presetIdx < 0 || presetIdx >= KDE_PRESETS.length) {
                    presetIdx = KDE_DEFAULT_PRESET_INDEX;
                }
                var preset = KDE_PRESETS[presetIdx];
                result.hybridOpts = {
                    outlierBandwidthMul: preset.bw,
                    outlierMaxAbsoluteRatio: preset.absRatio,
                    outlierMaxRelativeDiff: preset.rel
                };
                result.hybridPresetIndex = presetIdx;
            } catch (eIn) {
                result.hybridOpts = null;
            }
        }
    } catch (eDlg) {
        // #10 fix: don't silently apply fallback defaults when caller
        // declared interactive intent (default). Only headless/bridge
        // callers (opts.interactive === false) want the fallback path —
        // for them dialog construction failure is expected and they're
        // OK with safe defaults. For an interactive Scripts Panel run
        // we abort instead so the user is never surprised by a doc that
        // got modified with parameters they never saw.
        var interactive = opts && opts.interactive !== false;
        if (interactive) {
            result = null;
            ok = false;
            try {
                var errDlg = app.dialogs.add({ name: "Reorganize Styles", canCancel: false });
                var errCol = errDlg.dialogColumns.add();
                errCol.staticTexts.add({ staticLabel: "Could not open the grouping options dialog." });
                errCol.staticTexts.add({ staticLabel: "Aborting (no doc changes made)." });
                errCol.staticTexts.add({ staticLabel: "Error: " + (eDlg && eDlg.message ? eDlg.message : String(eDlg)) });
                errDlg.show();
                errDlg.destroy();
            } catch (eAlert) {}
        } else {
            result = _buildFallbackResult(autoMergeFallback);
            ok = true;
        }
    }
    try { if (dlg) dlg.destroy(); } catch (eD) {}
    return ok ? result : null;
}

/**
 * P2.b helper: build the same fallback object that the dialog returns
 * on Cancel-equivalent paths, so AutomationBridge callers can merge a
 * partial payload onto guaranteed defaults instead of forcing every
 * field to be specified. Keeping the merge external to the dialog
 * (rather than inside _buildFallbackResult) makes the public API
 * obvious at the entry script.
 */
function buildDefaultGroupingChoice(autoMergeFallback) {
    return _buildFallbackResult(autoMergeFallback);
}

module.exports = {
    showGroupingDialog: showGroupingDialog,
    buildDefaultGroupingChoice: buildDefaultGroupingChoice,
    GROUPING_DIMENSIONS: GROUPING_DIMENSIONS,
    KDE_PRESETS: KDE_PRESETS,
    KDE_DEFAULT_PRESET_INDEX: KDE_DEFAULT_PRESET_INDEX,
    COLOR_TOL_PRESETS: COLOR_TOL_PRESETS,
    COLOR_TOL_DEFAULT_INDEX: COLOR_TOL_DEFAULT_INDEX
};
