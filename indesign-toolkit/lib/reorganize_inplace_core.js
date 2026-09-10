"use strict";

/**
 * reorganize_styles_inplace.idjs — minimal-friction style reorganization
 *
 * Differences from reorganize_styles_v2.idjs:
 *   - NO source file picker — captures visual snapshots directly from
 *     app.activeDocument
 *   - NO segments.json required (synthesized in memory)
 *   - NO output file (.reorganized.indd) — modifies activeDocument
 *     in place, wrapped in ENTIRE_SCRIPT undo so Cmd/Ctrl+Z reverts
 *     the whole reorganization (preflight + apply + repair) in one step
 *   - NO CJK font policy (preserves original Latin fontFamily) — this
 *     is pure style consolidation, not translation prep. If you want
 *     CJK prep + GREP rules later, use reorganize_styles_v2.idjs instead.
 *
 * What this script DOES open / write:
 *   - ONE grouping options dialog at start (dimensions / colorTol /
 *     auto-merge preset / safety / soft-break / edit-mode). Cancel
 *     aborts cleanly with no doc changes.
 *   - One progress log file alongside the doc (or temp dir if unsaved):
 *     `<docname>_reorganize_progress_<timestamp>.log` — used for
 *     post-mortem triage when something looks wrong.
 *   - One alert at end summarizing results.
 *   - When safety is on: a before-snapshot JSON in lib/runtime_paths
 *     dataDir (used by post-flight repair).
 *
 * Workflow:
 *   1. Open the doc you want to consolidate in InDesign
 *   2. Double-click this script
 *   3. Pick grouping options in the dialog (or Cancel to abort)
 *   4. Wait ~30s (no further prompts)
 *   5. Alert shows results — read carefully, especially any "⚠" warnings
 *   6. Inspect, then either save (if happy) or Edit → Undo (if not)
 *
 * What it does:
 *   - Walks every paragraph in every story
 *   - Captures effective visual properties (font/size/color/leading/
 *     indents/spacing/keep options/bullets/...)
 *   - Clusters paragraphs by visual fingerprint
 *   - Creates _T_p_<hash> paragraph style per cluster (with the captured
 *     properties baked in) — N paragraphs → typically a much smaller M
 *     fingerprint-based styles
 *   - Reassigns each paragraph to its cluster's canonical style
 *
 * Source doc IS modified. Caveats:
 *   - Original paragraph style names (BULLETS, BODY COPY, etc.) remain
 *     in the doc but become orphaned (no paragraphs reference them).
 *     Use Paragraph Styles panel → "Select All Unused" → delete to clean.
 *   - Character-level overrides (designer-applied bold, color, etc.)
 *     are PRESERVED — we only swap paragraph style assignments, not
 *     character properties.
 */

var indesign = require("indesign");
var app = indesign.app;
var ScriptLanguage = indesign.ScriptLanguage;
var UndoModes = indesign.UndoModes;
var SaveOptions = indesign.SaveOptions;
var FontStatus = indesign.FontStatus;
var ColorSpace = indesign.ColorSpace;
var ColorModel = indesign.ColorModel;
var Justification = indesign.Justification;
var Leading = indesign.Leading;
var ListType = indesign.ListType;
var RuleWidth = indesign.RuleWidth;
var TabStopAlignment = indesign.TabStopAlignment;   // [indent-general] tab-stop enum for _applyTabStops
var MeasurementUnits = indesign.MeasurementUnits;
var UserInteractionLevels = indesign.UserInteractionLevels;

var common = require("./translation_common.js");
var utils = require("./utils.js");
var getCollectionItem = utils.getCollectionItem;
var safe = utils.safe;
var VisualSnapshot = require("./visual_snapshot.js");
var FontMapping = require("./font_mapping.js");
var StyleSheetBuilder = require("./style_sheet_builder.js");
var StyleApplier = require("./style_applier.js");
var UnderlineRuleDedup = require("./underline_rule_dedup.js");
var StyleMergeAdvisor = require("./style_merge_advisor.js");
var ScriptClassifier = require("./script_classifier.js");
var EmphasisExtractor = require("./emphasis_extractor.js");
// 2026-05-28: v2 dialog (5-radio strictness ladder + advanced panel) is
// opt-in via the USE_V2_DIALOG constant. Set to false to fall back to v1
// (which preserved the 16-checkbox layout exactly as it shipped before).
var USE_V2_DIALOG = true;
var ReorganizeDialog = USE_V2_DIALOG
    ? require("./reorganize_dialog_v2.js")
    : require("./reorganize_dialog.js");
var ReorganizeDocOps = require("./reorganize_doc_ops.js");
var RuntimePaths = require("./runtime_paths.js");
var ScriptLogPaths = require("./script_log_paths.js");
var AutomationBridge = require("./automation_bridge.js");
// Snapshot + repair pipeline (optional, dialog-toggled)
var SnapshotUtils = require("./snapshot_utils.js");
var SnapshotWriter = require("./snapshot_writer.js");
var StoryUtils = require("./story_utils.js");
var FileUtils = require("./file_utils.js");
var RepairAfterApply = require("./repair_after_apply.js");
var HyperlinkPreserver = require("./hyperlink_preserver.js");

var hashDjb2Hex = common.hashDjb2Hex;
var compactTimestampNow = common.compactTimestampNow;

// Progress checkpoint stride — emit a plog line every N paragraphs in the
// capture and apply loops. Smaller = more diagnosable but more disk writes.
var PROGRESS_STRIDE = 20;

// Pure-reorganize font policy: empty CJK preference → resolveCJKFont returns
// {source:"missing"} → buildStylePlan uses baseline.fontFamily as default
// (preserves original Latin font) AND skips GREP rules (no CJK fallback
// to escape from). Result: visually-identical reassignment.
var REORGANIZE_FONT_POLICY = {
    cjk: { preference: [] },
    latin: { mode: "preserve_source", fallback_chain: ["Helvetica", "Arial"] }
};

// Auto-merge fallback default — used only if the grouping dialog fails to
// construct (rare). Normal path: user picks via dialog (default = hybrid).
// Other allowed values: "high" / "high+medium" / "all" / null.
var AUTO_MERGE_CONFIDENCE = "hybrid";

// ─── Font helpers (same as other entries) ─────────────────────────

var _fontIndex = null;

function buildFontIndex() {
    if (_fontIndex) return;
    _fontIndex = {};
    try {
        var allNames = app.fonts.everyItem().name;
        var allFamilies = app.fonts.everyItem().fontFamily;
        if (typeof allNames === "string") allNames = [allNames];
        if (typeof allFamilies === "string") allFamilies = [allFamilies];
        for (var i = 0; i < allNames.length; i++) {
            var nk = allNames[i].toLowerCase();
            var fk = allFamilies[i].toLowerCase();
            if (!_fontIndex[nk]) _fontIndex[nk] = i;
            if (!_fontIndex[fk]) _fontIndex[fk] = i;
        }
    } catch (e) {}
}

function findFontByName(name) {
    if (!name) return null;
    var tries = [name, name + "\tRegular", name + "\tNormal", name + "\tBook", name + "\tMedium"];
    for (var t = 0; t < tries.length; t++) {
        try {
            var f = app.fonts.item(tries[t]);
            // UXP enum identity is NOT ===-comparable (fresh wrapper per access) →
            // `f.status !== FontStatus.NOT_AVAILABLE` was ALWAYS true, so a substituted/
            // unavailable font would be returned instead of trying the next candidate.
            // Compare stringified enum name (host-confirmed 2026-06-10, see
            // byPair_script_coverage.js:108 + hard_errors.js:186-189).
            var _fsName = String(f && f.status || "");
            if (_fsName.indexOf(".") >= 0) _fsName = _fsName.split(".").pop();
            if (f.isValid && _fsName !== "NOT_AVAILABLE") return f;
        } catch (e) {}
    }
    buildFontIndex();
    var key = String(name).toLowerCase();
    var idx = _fontIndex.hasOwnProperty(key) ? _fontIndex[key] : -1;
    if (idx < 0) {
        for (var k in _fontIndex) { if (k.indexOf(key) >= 0) { idx = _fontIndex[k]; break; } }
    }
    if (typeof idx === "number" && idx >= 0) {
        try { return app.fonts[idx]; } catch (e2) {}
    }
    return null;
}

// ─── Walk + snapshot paragraphs in-place (no segments.json needed) ──
//
// Doc-mutating ops (preclean / overflow snapshot / preflight snapshot)
// live in lib/reorganize_doc_ops.js so import_translations_v2.idjs can
// share them. Below are thin wrappers that bind this entry point's
// shared deps (getCollectionItem / safe / ListType / RuntimePaths /
// SnapshotWriter / SnapshotUtils / StoryUtils / FileUtils).

var _docOpsDeps = {
    getCollectionItem: getCollectionItem,
    safe:              safe,
    ListType:          ListType,
    RuntimePaths:      RuntimePaths,
    SnapshotWriter:    SnapshotWriter,
    SnapshotUtils:     SnapshotUtils,
    StoryUtils:        StoryUtils,
    FileUtils:         FileUtils
};

function splitSoftBreaksWithFormatChange(doc, dimensions, plog) {
    return ReorganizeDocOps.splitSoftBreaksWithFormatChange(doc, dimensions, plog, _docOpsDeps);
}
function revertSplitsThatCausedOverflow(doc, splitRefsByStoryId, splitDeltasByStoryId, beforeState, plog) {
    return ReorganizeDocOps.revertSplitsThatCausedOverflow(doc, splitRefsByStoryId, splitDeltasByStoryId, beforeState, plog, _docOpsDeps);
}
function cleanupConsecutiveBulletsWithFormatChange(doc, dimensions, plog, beforeOverflowState, splitDeltasByStoryId) {
    return ReorganizeDocOps.cleanupConsecutiveBulletsWithFormatChange(
        doc, dimensions, plog, beforeOverflowState, splitDeltasByStoryId, _docOpsDeps);
}
function snapshotOverflowState(doc) {
    return ReorganizeDocOps.snapshotOverflowState(doc, _docOpsDeps);
}
function diffOverflowState(beforeState, afterState) {
    return ReorganizeDocOps.diffOverflowState(beforeState, afterState);
}
function runPreflightSnapshot(doc, plog) {
    return ReorganizeDocOps.runPreflightSnapshot(doc, plog, _docOpsDeps);
}


// Build convertToRGB closure using doc.colorTransform + the document's
// ICC profile. Called from captureColor to populate fillColor.displayedRGB
// with the InDesign-rendered sRGB equivalent (rather than a naive math
// formula). Critical for CMYK swatches whose displayed appearance differs
// substantially from raw CMYK math.
function makeConvertToRGB(doc) {
    return function (values, spaceName) {
        if (!values || !values.length) return null;
        if (spaceName === "RGB" && values.length >= 3) {
            return [Math.round(values[0]), Math.round(values[1]), Math.round(values[2])];
        }
        if (spaceName === "CMYK" && values.length >= 4) {
            try {
                var norm = [values[0] / 100, values[1] / 100, values[2] / 100, values[3] / 100];
                var rgbN = doc.colorTransform(norm, ColorSpace.CMYK, ColorSpace.RGB);
                if (rgbN && rgbN.length >= 3) {
                    return [
                        Math.max(0, Math.min(255, Math.round(rgbN[0] * 255))),
                        Math.max(0, Math.min(255, Math.round(rgbN[1] * 255))),
                        Math.max(0, Math.min(255, Math.round(rgbN[2] * 255)))
                    ];
                }
            } catch (e) {}
        }
        return null;
    };
}

// #28: walk masterSpreads → allPageItems → parentStory.id, return a Set
// of story IDs that originate on master spreads. Used to tag captured
// segments with `is_master` so the cluster builder can keep master
// paragraphs in their own pool (default ON).
function collectMasterStoryIds(doc, plog) {
    var ids = {};
    var count = 0;
    var ms;
    try { ms = doc.masterSpreads; } catch (e) { return ids; }
    var nMs = 0;
    try { nMs = ms.length; } catch (e) {}
    for (var i = 0; i < nMs; i++) {
        var spread = null;
        try { spread = ms.item(i); } catch (eS) { continue; }
        if (!spread) continue;
        var items = null;
        try { items = spread.allPageItems; } catch (eI) { continue; }
        if (!items) continue;
        for (var j = 0; j < items.length; j++) {
            var item = items[j];
            try {
                var story = item.parentStory;
                if (!story) continue;
                var sid = String(story.id);
                if (sid && !ids[sid]) { ids[sid] = true; count++; }
            } catch (ePS) {}
        }
    }
    if (plog) plog("master-scope: " + count + " stories belong to " + nMs + " master spread(s)");
    return ids;
}

function captureAllParagraphSnapshots(doc, plog, opts) {
    opts = opts || {};
    var masterStoryIds = opts.masterStoryIds || {};
    var segments = [];
    var paraRefs = [];   // parallel array of direct paragraph refs (skip locator)
    var stories = doc.stories;
    var storyCount = stories.length;
    var totalParas = 0, captureFails = 0;
    var masterSegCount = 0;
    var convertToRGB = makeConvertToRGB(doc);
    if (plog) plog("capture: storyCount=" + storyCount);
    for (var s = 0; s < storyCount; s++) {
        var story = getCollectionItem(stories, s);
        if (!story || !story.isValid) continue;
        var sidStr = "";
        try { sidStr = String(story.id); } catch (eSid) {}
        var isMasterStory = !!(sidStr && masterStoryIds[sidStr]);
        var paras = story.paragraphs;
        if (!paras || typeof paras.length !== "number") continue;
        if (plog) plog("capture: story[" + s + "] paragraphs=" + paras.length + (isMasterStory ? " (MASTER)" : ""));
        for (var p = 0; p < paras.length; p++) {
            var para = getCollectionItem(paras, p);
            if (!para || !para.isValid) continue;
            totalParas++;
            if (plog && (totalParas % PROGRESS_STRIDE) === 0) {
                plog("capture: totalParas=" + totalParas + " kept=" + segments.length + " story=" + s + " p=" + p);
            }
            var fmtSnap = null, paraSnap = null;
            try { fmtSnap = VisualSnapshot.captureFormatSnapshot(para, convertToRGB); } catch (eF) {}
            try { paraSnap = VisualSnapshot.captureParagraphSnapshot(para, convertToRGB); } catch (eP) {}
            if (!fmtSnap || !paraSnap) { captureFails++; continue; }
            var srcText = "";
            try { srcText = String(para.contents || "").replace(/\r+$/, ""); } catch (eC) {}
            // Skip empty / control-only paragraphs (no useful clustering)
            if (!srcText || srcText.length === 0) continue;
            var srcHash = hashDjb2Hex(srcText);
            var tid = "rg_" + s + "_" + p;
            // #32 G4: capture the originating paragraph style's name.
            // commitStylePlan uses this to copy designer-added (non-`_T_*`)
            // nested GREP rules from the source para style to the new
            // `_T_p_*` style — preserves designer-defined GREP-driven
            // formatting (URLs, brand names, registered marks, etc.)
            // that would otherwise be lost when the para's style is
            // swapped to the cluster style.
            var sourcePsName = "";
            try { sourcePsName = String(para.appliedParagraphStyle.name); } catch (eSps) {}
            segments.push({
                tid: tid,
                story_id: s,
                paragraph_index: p,
                source_text: srcText,
                source_hash: srcHash,
                translatable: true,
                format_snapshot: fmtSnap,
                paragraph_snapshot: paraSnap,
                // #28: tag origin so buildStylePlan can keep master and
                // body paragraphs in separate cluster pools (when
                // splitMasterFromBody is enabled).
                is_master: isMasterStory,
                source_paragraph_style_name: sourcePsName
            });
            if (isMasterStory) masterSegCount++;
            paraRefs.push(para);
        }
    }
    if (plog) plog("capture: DONE totalParas=" + totalParas + " kept=" + segments.length
        + " (master=" + masterSegCount + " body=" + (segments.length - masterSegCount) + ")"
        + " fails=" + captureFails);
    return { segments: segments, paraRefs: paraRefs, totalParas: totalParas, captureFails: captureFails, masterSegCount: masterSegCount };
}

// Filter latinPool down to entries actually referenced by any GREP rule.
// In pure-reorganize mode (empty CJK preference) NO grepRule is created,
// so the entire pool would be unused. This drops them to keep the doc clean.
function filterUnusedLatinStyles(plan) {
    var referenced = {};
    for (var i = 0; i < plan.paraStylesToCreate.length; i++) {
        var ps = plan.paraStylesToCreate[i];
        if (ps.grepRule && ps.grepRule.latinStyleFingerprint) {
            referenced[ps.grepRule.latinStyleFingerprint] = true;
        }
    }
    plan.latinStylesToCreate = plan.latinStylesToCreate.filter(function (ls) {
        return referenced[ls.fingerprint] === true;
    });
    return plan;
}

// Grouping dialog (dimensions / auto-merge / colorTol / safety) lives in
// lib/reorganize_dialog.js so import_translations_v2.idjs can show the
// same panel before its commit stage.

// ─── Entry point ─────────────────────────────────────────────────

async function main(opts) {
    // 8D-ext-D M3 (RR1.1 + r20 P1): in-process callers (font_apply_panel)
    // pass opts; double-click + bridge entries pass nothing. Capture
    // presence BEFORE defaulting — `opts = opts || {}` alone would make
    // opts always-truthy and (a) never call readAutomationOptions (breaks
    // bridge preseed), (b) skip showGroupingDialog on double-click.
    var __inProcess = (opts != null);
    opts = opts || {};
    if (app.documents.length === 0) {
        showAlert("Please open the document you want to reorganize first.");
        return;
    }

    var doc = app.activeDocument;
    var docName = "";
    try { docName = String(doc.name); } catch (e) {}

    // Anchor scratch dirs (.scratch/temp_data, .scratch/log) to the doc's
    // folder. Two reasons:
    //   1) Scripts Panel double-click loses __dirname inside CommonJS
    //      modules → DEFAULT_BASE_DIR is "" → getDataDir() resolves to
    //      a relative ".scratch/temp_data" that fs.writeFileSync rejects
    //      with ENOENT.  Setting baseDir here makes the path absolute.
    //   2) Keeps each run's snapshot/log next to its source doc instead
    //      of polluting the toolkit install dir (which lives in Program
    //      Files for default installs).
    // doc.filePath is a Promise<Folder> in InDesign 2026 UXP (Link.filePath
    // is sync; Document.filePath is not — verified in CLAUDE.md). Must
    // await, then read .nativePath from the resolved Folder. On platforms
    // where it already resolves to a plain string, accept that too.
    try {
        var __dfp = await doc.filePath;
        var __dfpStr = "";
        if (typeof __dfp === "string") {
            __dfpStr = __dfp;
        } else if (__dfp && typeof __dfp.nativePath === "string") {
            __dfpStr = __dfp.nativePath;
        }
        if (__dfpStr && (__dfpStr.indexOf("\\") >= 0 || __dfpStr.indexOf("/") >= 0)) {
            RuntimePaths.setBaseDir(__dfpStr);
        }
    } catch (eSBD) {}

    // Pre-create scratch dirs from this async context. Sync ensureParentDir
    // (lib/file_utils.js:170) tries fs.mkdirSync({recursive:true}), but UXP's
    // fs module ONLY exposes async fs.mkdir — sync mkdirSync is undefined.
    // So the catch sees TypeError (e.code === undefined, neither EEXIST nor
    // ENOENT), _mkdirRecursiveManual returns false silently, and the later
    // writeFileSync inside doScript fails with ENOENT.  Pre-creating the
    // dirs here (using FileUtils.ensureDirAsync, which is a Promise wrapper
    // around fs.mkdir) lets the snapshot/log writes inside doScript succeed
    // unmodified — ensureParentDir's failure becomes a no-op against an
    // already-existing dir.
    try {
        await FileUtils.ensureDirAsync(RuntimePaths.getDataDir());
        await FileUtils.ensureDirAsync(RuntimePaths.getLogDir());
    } catch (eED) {}

    // #6 fix: capture the TRULY-original userInteractionLevel BEFORE the
    // first forced override below. Previously this was captured at line
    // ~360 — but by then we've already forced INTERACT_WITH_ALL once,
    // so finally would "restore" to the forced value, not the user's
    // setting. Capture at the absolute earliest point.
    var origInteractionLevel = null;
    try { origInteractionLevel = app.scriptPreferences.userInteractionLevel; } catch (eRO0) {}

    // Ensure interactive dialogs are allowed — this session may have set
    // NEVER_INTERACT earlier (e.g. by the bridge runner). Restore for the
    // grouping dialog, then suppress modals again before doScript.
    try { app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL; } catch (eUI) {}

    // #26: AutomationBridge — let MCP / bridge / parent script pre-inject
    // the dialog answer via app.scriptArgs (channel 1) or a JSON file
    // (channel 2). Skipping the dialog is the only reliable way to drive
    // this script from the bridge, because a DOM dialog blocks InDesign's
    // main thread → bridge plugin can't service HTTP → caller times out.
    // Manual UX path is preserved: with no preseed, fall through to
    // showGroupingDialog().
    var groupingChoice = null;
    var __autoOpts = null;
    if (__inProcess) {
        // 8D-ext-D M3 (r9 P3 + r20 P1): in-process opts ARE the automation
        // payload — flow through the SAME merge/normalize below (no bypass
        // of the :438-497 defaults/dimensions/type-validation block).
        // byPair / skipDecisions / runEnforcer / brandConfig /
        // langScriptTable / showSummaryDialog ride along as extra keys
        // (shallow-merge branch) and are read from `opts` directly at the
        // facade call site.
        __autoOpts = opts;
    } else {
        try {
            __autoOpts = await AutomationBridge.readAutomationOptions("reorganize_styles_inplace");
        } catch (eAB) {
            // Malformed JSON: surface in alert + log, then fall back to dialog
            // so the operator isn't silently locked out.
            try { showAlert("AutomationBridge: " + (eAB && eAB.message ? eAB.message : eAB)); } catch (eA) {}
        }
    }
    if (__autoOpts) {
        // P2.b fix: merge automation payload over the dialog's
        // fallback defaults so a partial payload (e.g. just
        // `{ runSafety: false }`) doesn't lose autoMerge / colorTol /
        // dimensions / splitMasterFromBody / etc. Without this merge,
        // any field the caller omitted comes through as `undefined`
        // and silently disables that feature (autoMerge=undefined →
        // no auto-merge run; dimensions=undefined → for-in iterates
        // zero times → all dim flags lost).
        var __defaults = ReorganizeDialog.buildDefaultGroupingChoice(AUTO_MERGE_CONFIDENCE);
        groupingChoice = {};
        for (var __dk in __defaults) {
            if (Object.prototype.hasOwnProperty.call(__defaults, __dk)) groupingChoice[__dk] = __defaults[__dk];
        }
        // P2 fix: deep-merge `dimensions` (and any other nested object)
        // instead of wholesale replacement. A partial payload like
        // `{ dimensions: { fillColor: false } }` should ONLY override
        // fillColor; without deep merge it would replace the entire
        // dims map and silently drop fontFamily/fontStyle/fontSize/...
        // → cluster grouping collapses to a near-trivial pool.
        for (var __ak in __autoOpts) {
            if (!Object.prototype.hasOwnProperty.call(__autoOpts, __ak)) continue;
            var __av = __autoOpts[__ak];
            if (__av === undefined) continue;
            if (__ak === "dimensions" && __av && typeof __av === "object") {
                // Start from a shallow clone of the default dims so the
                // merge doesn't mutate buildDefaultGroupingChoice's return.
                var mergedDims = {};
                var defDims = __defaults.dimensions || {};
                for (var __dd in defDims) {
                    if (Object.prototype.hasOwnProperty.call(defDims, __dd)) mergedDims[__dd] = defDims[__dd];
                }
                for (var __pd in __av) {
                    if (Object.prototype.hasOwnProperty.call(__av, __pd) && __av[__pd] !== undefined) {
                        mergedDims[__pd] = __av[__pd];
                    }
                }
                groupingChoice.dimensions = mergedDims;
            } else {
                // Other fields (autoMerge / colorTol / hybridOpts /
                // booleans) intentionally use shallow override —
                // nested objects in those fields, when present, are
                // expected to be passed atomically (e.g. hybridOpts is
                // either null or a complete tuning object).
                groupingChoice[__ak] = __av;
            }
        }
        // Light type validation — coerce/normalize so downstream code
        // doesn't have to defensively check each field. Reject obvious
        // wrong types loudly instead of silently no-op'ing later.
        if (typeof groupingChoice.dimensions !== "object" || groupingChoice.dimensions === null) {
            groupingChoice.dimensions = __defaults.dimensions;
        }
        if (typeof groupingChoice.colorTol !== "number") groupingChoice.colorTol = __defaults.colorTol;
        if (typeof groupingChoice.autoMerge !== "string" && groupingChoice.autoMerge !== null) groupingChoice.autoMerge = __defaults.autoMerge;
        groupingChoice.runSafety        = (groupingChoice.runSafety === false) ? false : true;
        groupingChoice.splitSoftBreaks  = (groupingChoice.splitSoftBreaks === false) ? false : true;
        groupingChoice.spacePreservingMerge = (groupingChoice.spacePreservingMerge === false) ? false : true;
        groupingChoice.splitMasterFromBody  = (groupingChoice.splitMasterFromBody === false) ? false : true;
        groupingChoice.editMode         = !!groupingChoice.editMode;
    } else {
        // v2 dialog (HTMLDialogElement-based) is async — showGroupingDialog
        // returns a Promise that resolves on OK / Cancel / advanced-panel
        // dismissal. v1 was synchronous; the await here is harmless for v1
        // (await of a non-Promise resolves to the value).
        groupingChoice = await ReorganizeDialog.showGroupingDialog(app, {
            title: "Reorganize Styles — Grouping",
            autoMergeFallback: AUTO_MERGE_CONFIDENCE,
            interactive: true   // #10: dialog failure → abort, not silent fallback
        });
    }
    if (!groupingChoice) {
        // #9 fix: user cancelled (or dialog failed). Restore interaction
        // level we forced INTERACT_WITH_ALL on line 301 — otherwise a
        // session that started in NEVER_INTERACT (e.g. bridge runner) gets
        // permanently flipped just by running + cancelling reorg.
        try {
            if (origInteractionLevel !== null) {
                app.scriptPreferences.userInteractionLevel = origInteractionLevel;
            }
        } catch (eRC) {}
        return;
    }

    // ── Progress log (writes per major step + every PROGRESS_STRIDE paras) ──
    // If the doc is saved, write alongside it; otherwise fall back to temp dir.
    // Same pattern as import_translations_v2.idjs: in-memory buffer + full
    // rewrite each call (UXP fs.appendFileSync isn't reliable).
    // Note: in InDesign 2026 UXP, Document.filePath resolves to a Folder
    // object asynchronously (not a string) — must await and read .nativePath.
    // 2026-05-28: unified log location at <docDir>/script_outputs/log/.
    // ScriptLogPaths handles two-level mkdir + timestamp suffix; falls back
    // to system tempDir when doc has no path.
    var __docDirForLog = "";
    try {
        var fp = await doc.filePath;
        if (typeof fp === "string") {
            __docDirForLog = fp;
        } else if (fp && typeof fp.nativePath === "string") {
            __docDirForLog = fp.nativePath;
        }
        if (__docDirForLog && __docDirForLog.indexOf("\\") < 0 && __docDirForLog.indexOf("/") < 0) {
            __docDirForLog = "";
        }
    } catch (eDP) {}
    try { await ScriptLogPaths.ensureLogDirAsync(__docDirForLog); } catch (eED) {}
    var progressLogPath = ScriptLogPaths.resolveLogPath(__docDirForLog, "reorganize_styles_inplace");
    var logDir = ScriptLogPaths.resolveLogDir(__docDirForLog);
    var sep = (logDir.indexOf("\\") >= 0) ? "\\" : "/";
    // #16 fix: amortize the rewrite-whole-buffer cost so plog stays
    // O(1) per call for typical docs (was O(n²) total because each
    // call re-wrote the cumulative buffer). For 1000+ paragraph docs
    // this turns into significant disk I/O. Strategy: keep in-memory
    // buffer, flush every PLOG_FLUSH_INTERVAL calls + always flush at
    // script end. Crash mid-run loses at most INTERVAL log lines, but
    // the alert summary still surfaces counts.
    var _logBuffer = "";
    var _logSinceFlush = 0;
    var PLOG_FLUSH_INTERVAL = 50;
    var _fsRef = require("fs");
    function _plogFlush() {
        _logSinceFlush = 0;
        try { _fsRef.writeFileSync(progressLogPath, _logBuffer, "utf-8"); } catch (e) {}
    }
    function plog(msg) {
        _logBuffer += "[" + new Date().toISOString() + "] " + msg + "\n";
        _logSinceFlush++;
        if (_logSinceFlush >= PLOG_FLUSH_INTERVAL) { _plogFlush(); }
    }
    plog("=== reorganize_styles_inplace begin ===");
    plog("doc=" + docName);
    plog("auto_merge=" + (groupingChoice.autoMerge || "(disabled)"));
    var dimSummary = [];
    for (var dk in groupingChoice.dimensions) {
        if (groupingChoice.dimensions[dk]) dimSummary.push(dk);
    }
    plog("dimensions_on=" + dimSummary.join(","));

    var stats = {
        captured: 0,
        emptySkipped: 0,
        captureFailed: 0,
        paraStylesCreated: 0,
        latinStylesCreated: 0,
        clusterStylesApplied: 0,
        applyFailures: 0,
        error: null,
        progress_log_path: progressLogPath
    };

    var libDeps = {
        fontMapping: FontMapping,
        findFont: findFontByName,
        ColorSpace: ColorSpace,
        ColorModel: ColorModel,
        Justification: Justification,
        Leading: Leading,
        ListType: ListType,
        TabStopAlignment: TabStopAlignment,   // [indent-general] for _applyTabStops
        RuleWidth: RuleWidth
    };

    // Note: origInteractionLevel was already captured at top of function
    // (line ~292) — BEFORE the first forced INTERACT_WITH_ALL on line 293.
    // Don't re-capture here, which would overwrite with the post-dialog
    // value (#6 fix).
    // Suppress modal dialogs (font fallback / link prompts)
    try { app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT; } catch (e) {}
    plog("userInteractionLevel: was=" + String(origInteractionLevel) + " (truly original), set NEVER_INTERACT");

    // ── Pre-flight + Main Reorg + Post-Repair (single undo block) ─
    // EVERYTHING that touches the doc goes inside one ENTIRE_SCRIPT
    // undo block — user reverts the whole pipeline (preflight geom-
    // expand + reorg + repair) with a single Cmd/Ctrl+Z. Previously
    // preflight ran outside the undo block (orphaned geometry expand
    // not undone) and repair opened a SECOND ENTIRE_SCRIPT undo (so
    // user needed two Cmd+Z to revert reorg + repair). Both fixed
    // by moving them INSIDE this single doScript and switching repair
    // call to runRepairCore (no nested doScript).
    var snapshotInfo = null;   // populated if pre-flight ran successfully
    // #11 fix: capture original enableRedraw so finally can restore the
    // user's setting (not blindly force true). If a parent script has
    // intentionally turned it off, we shouldn't undo that.
    var origEnableRedraw = null;
    try { origEnableRedraw = app.scriptPreferences.enableRedraw; } catch (eER0) {}
    app.scriptPreferences.enableRedraw = false;
    var origUnits = { h: null, v: null };
    plog("about to call app.doScript (ENTIRE_SCRIPT undo, enableRedraw=false, includes preflight + repair)");
    try {
        app.doScript(function () {
            try {
                plog("doScript: enter");
                // Force POINTS so spaceBefore/spaceAfter/indents/leading
                // numeric values match what buildStylePlan/commitStylePlan
                // expect (POINTS at capture, POINTS at commit).
                try { origUnits.h = doc.viewPreferences.horizontalMeasurementUnits; } catch (eU0) {}
                try { origUnits.v = doc.viewPreferences.verticalMeasurementUnits; } catch (eU1) {}
                try { doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS; } catch (eU2) {}
                try { doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS; } catch (eU3) {}
                plog("doScript: units forced to POINTS");

                // ── Pre-flight (optional, inside main undo block — #1 fix) ──
                // Captures a "before" snapshot AND joins any geometry-split
                // frames so style application can't break frame fits. The
                // geometry expand mutates the doc; placing it inside this
                // ENTIRE_SCRIPT block makes it part of the single Cmd+Z
                // undo (previously it ran outside, leaving an orphan
                // geometry change after Undo).
                if (groupingChoice.runSafety) {
                    plog("preflight: begin (safety net ON, INSIDE undo block)");
                    try {
                        snapshotInfo = runPreflightSnapshot(doc, plog);
                        plog("preflight: end stories=" + (snapshotInfo ? snapshotInfo.storyCount : "?")
                            + " path=" + (snapshotInfo ? snapshotInfo.snapshotPath : "?"));
                        // #13 + #17 contract:
                        //   - snapshotInfo truthy  → snapshot written OK
                        //   - snapshotInfo === null → benign "no repairable
                        //     stories" (empty doc / all stories non-repairable)
                        //   - snapshot WRITE FAILURE → runPreflightSnapshot
                        //     throws (caught below) so we never silently treat
                        //     a write failure as "no stories"
                        stats.preflight_status = snapshotInfo
                            ? "ok (" + snapshotInfo.storyCount + " stories snapshotted)"
                            : "no repairable stories";
                    } catch (ePF) {
                        // Preflight threw (snapshot write failed, story
                        // enumeration crashed, etc.). With safety on, the
                        // user explicitly opted into the protection — fail
                        // closed by setting an error so subsequent apply +
                        // alert know the safety net was promised but not
                        // delivered.
                        var __pfMsg = ePF && ePF.message ? ePF.message : String(ePF);
                        stats.preflight_status = "FAILED: " + __pfMsg;
                        stats.preflight_failed = true;
                        stats.error = "Preflight snapshot failed (safety on): " + __pfMsg;
                        plog("preflight: FAIL " + __pfMsg + " — aborting before doc mutation");
                        // Stop the script body — fall through to outer
                        // try-catch which will surface the error in the
                        // final summary alert.
                        throw new Error("Preflight failed with safety on; aborting to protect doc: " + __pfMsg);
                    }
                } else {
                    plog("preflight: SKIPPED (safety checkbox unchecked)");
                    stats.preflight_status = "skipped (safety off)";
                }

                // Capture overflow snapshot at script entry. Used by Phase 2
                // (revert decisions) and post-phase diagnostics to localize
                // which phase introduced any new overflow.
                var beforeOverflow = snapshotOverflowState(doc);
                plog("doScript: pre-script overflow snapshot captured ("
                    + Object.keys(beforeOverflow).length + " stories)");

                // #27: doc-wide capture of direct character overrides BEFORE
                // any mutation. preclean's `splitSoftBreaksWithFormatChange`
                // does `ch.contents = "\r"` which (as a DOM side effect)
                // resets ALL direct character overrides on the affected
                // paragraph — so the per-paragraph capture inside applyCluster-
                // StyleToParagraph sees only the post-wipe state. By
                // capturing here (BEFORE preclean) and restoring AFTER the
                // apply loop, we preserve ALL_CAPS / Paper / point-size
                // designer overrides through the entire pipeline. Story-
                // relative char offsets are stable through preclean (1-char-
                // in / 1-char-out substitution) and through pure reorganize
                // apply (no para.contents rewrite), so the captured offsets
                // still point at the right characters at restore time.
                var __preDocOverrides = null;
                try {
                    __preDocOverrides = StyleApplier.captureDocDirectOverrides(doc, plog, { getCollectionItem: getCollectionItem });
                } catch (ePD) {
                    plog("preserve: capture FAIL " + (ePD && ePD.message ? ePD.message : ePD));
                }

                // #30 G1: capture all doc-level hyperlinks BEFORE any
                // mutation. Pure reorganize doesn't usually delete them
                // (story chars + offsets stay intact), but the channel
                // exists as a safety net for edge cases (e.g. a
                // hyperlink whose source range happened to span a soft-
                // break that gets promoted to hard-break, splitting the
                // range across paragraphs). For import_v2 where contents
                // are rewritten this is essential.
                var __preDocHyperlinks = null;
                try {
                    __preDocHyperlinks = HyperlinkPreserver.captureDocHyperlinks(doc, plog);
                } catch (ePH) {
                    plog("hyperlinks: capture FAIL " + (ePH && ePH.message ? ePH.message : ePH));
                }

                // Step 0: pre-clean — split soft-break-with-format-change
                // into hard breaks. Mutates the doc; keeping this inside
                // the same doScript means it shares the single ENTIRE_SCRIPT
                // undo with the rest of the reorganize work.
                if (groupingChoice.splitSoftBreaks) {
                    plog("doScript: pre-clean phase 0 (overflow snapshot)");

                    // Phase 1: split soft breaks (no bullet/indent yet)
                    plog("doScript: pre-clean phase 1 (split soft breaks)");
                    var splitResult = null;
                    try {
                        splitResult = splitSoftBreaksWithFormatChange(doc, groupingChoice.dimensions, plog);
                        stats.softBreakSplits = splitResult.split;
                        stats.softBreakFound = splitResult.found;
                        stats.paragraphsBefore = splitResult.paragraphsBefore;
                        stats.paragraphsAfter = splitResult.paragraphsAfter;
                        plog("doScript: phase 1 end (found=" + splitResult.found + " split=" + splitResult.split + ")");
                    } catch (eSC) {
                        plog("doScript: phase 1 FAIL " + (eSC && eSC.message ? eSC.message : eSC));
                    }

                    // Phase 2: revert any of OUR splits that caused new
                    // overflow in stories that previously fit.
                    if (splitResult && splitResult.splitRefsByStoryId) {
                        plog("doScript: pre-clean phase 2 (revert overflow-causing splits)");
                        try {
                            var revertResult = revertSplitsThatCausedOverflow(doc, splitResult.splitRefsByStoryId, splitResult.splitDeltasByStoryId, beforeOverflow, plog);
                            stats.softBreakReverted = revertResult.revertedTotal;
                            stats.storiesFixed = revertResult.storiesFixed;
                            stats.storiesUnfixable = revertResult.storiesUnfixable;
                            plog("doScript: phase 2 end (reverted=" + revertResult.revertedTotal
                                + " storiesFixed=" + revertResult.storiesFixed
                                + " unfixable=" + revertResult.storiesUnfixable + ")");
                        } catch (eRV) {
                            plog("doScript: phase 2 FAIL " + (eRV && eRV.message ? eRV.message : eRV));
                        }
                    }

                    // Phase 3: bullet/indent cleanup on FINAL paragraph
                    // structure (after split + selective revert).
                    // #18 fix: pass splitDeltasByStoryId so cleanup
                    // ONLY touches paragraphs we ourselves produced via
                    // soft-break split this run. Without this scoping,
                    // legitimate consecutive list items (with intentionally
                    // varied font/color across rows) get demoted.
                    plog("doScript: pre-clean phase 3 (bullet+indent cleanup, scoped to this-run splits)");
                    try {
                        var splitDeltas = splitResult ? splitResult.splitDeltasByStoryId : null;
                        var cleanResult = cleanupConsecutiveBulletsWithFormatChange(doc, groupingChoice.dimensions, plog, beforeOverflow, splitDeltas);
                        stats.bulletDemoted = cleanResult.demoted;
                        stats.bulletExamined = cleanResult.examined;
                        stats.indentInherited = cleanResult.indentInherited;
                        stats.cleanupRevertedStories = cleanResult.revertedStories;
                        stats.cleanupRevertedChanges = cleanResult.revertedChanges;
                        plog("doScript: phase 3 end (examined=" + cleanResult.examined
                            + " demoted=" + cleanResult.demoted
                            + " indentInherited=" + cleanResult.indentInherited
                            + " revertedStories=" + cleanResult.revertedStories + ")");
                    } catch (eBC) {
                        plog("doScript: phase 3 FAIL " + (eBC && eBC.message ? eBC.message : eBC));
                    }
                } else {
                    plog("doScript: pre-clean SKIPPED (checkbox unchecked)");
                }

                // Write para_deltas_latest.json so post-flight RepairAfterApply
                // can shift snapshot ordinals by the splits that survived
                // Phase 2 revert. Without this, repair sees a paragraph-count
                // mismatch (snapshot=N, live=N+k) and either skips ordinal
                // matching (pure reorganize w/o splits) or wildly resizes
                // frames trying to match wrong ordinals (when splits did
                // happen). Writing {} when no splits survived is also valid
                // and signals "no para deltas" to repair.
                if (groupingChoice.runSafety) {
                    // Shared canonical writer (reorganize_doc_ops.writeParaDeltasForRepair)
                    // — the SAME writer the import path now uses (Bug#1 / 1A), so the
                    // file format + snapshotCapturedAt binding can never drift between
                    // the reorganize and import callers. #23 staleness binding lives
                    // inside the helper.
                    try {
                        var __pdRes = ReorganizeDocOps.writeParaDeltasForRepair(
                            doc,
                            (splitResult && splitResult.splitDeltasByStoryId) || {},
                            snapshotInfo,
                            { RuntimePaths: RuntimePaths, FileUtils: FileUtils, generatedBy: "reorganize_styles_inplace" }
                        );
                        stats.paraDeltasStoriesWritten = __pdRes.storiesWritten;
                        stats.paraDeltasWriteOk = __pdRes.ok;
                        if (!__pdRes.ok) {
                            stats.paraDeltasWriteFailed = true;
                            stats.paraDeltasWriteError = __pdRes.error
                                ? (__pdRes.error.message || __pdRes.error.code || JSON.stringify(__pdRes.error))
                                : "writeTextFile returned false";
                            plog("preclean: para_deltas write FAIL — " + stats.paraDeltasWriteError
                                + " (any prior para_deltas_latest.json is now stale; repair will reject via snapshotCapturedAt mismatch)");
                        } else {
                            plog("preclean: wrote para_deltas_latest.json with " + __pdRes.storiesWritten + " stories"
                                + " (bound to snapshotCapturedAt=" + (__pdRes.snapshotCapturedAt || "null") + ")");
                        }
                    } catch (ePD) {
                        stats.paraDeltasWriteFailed = true;
                        stats.paraDeltasWriteError = ePD && ePD.message ? ePD.message : String(ePD);
                        plog("preclean: para_deltas write THREW " + stats.paraDeltasWriteError);
                    }
                }

                // Diagnostic: snapshot overflow after preclean (vs pre-script).
                // Identifies whether preclean alone introduced new overflow.
                var afterPreclean = snapshotOverflowState(doc);
                var preDiff = diffOverflowState(beforeOverflow, afterPreclean);
                stats.overflowNewAfterPreclean = preDiff.newlyOverflowing.length;
                if (preDiff.newlyOverflowing.length > 0) {
                    plog("doScript: WARN preclean introduced overflow in "
                        + preDiff.newlyOverflowing.length + " stories: "
                        + preDiff.newlyOverflowing.join(","));
                } else {
                    plog("doScript: OK no new overflow after preclean");
                }

                // Step 1: walk + capture
                // #28: precompute master story IDs so capture can tag each
                // segment. Default ON: master paragraphs cluster separately.
                // groupingChoice.splitMasterFromBody === false opts back into
                // single-pool clustering.
                var splitMasterFromBody = (groupingChoice.splitMasterFromBody === false) ? false : true;
                var masterStoryIds = splitMasterFromBody ? collectMasterStoryIds(doc, plog) : {};
                plog("doScript: capture begin (splitMasterFromBody=" + splitMasterFromBody + ")");
                var captured = captureAllParagraphSnapshots(doc, plog, { masterStoryIds: masterStoryIds });
                stats.captured = captured.segments.length;
                stats.captureFailed = captured.captureFails;
                stats.emptySkipped = captured.totalParas - captured.segments.length - captured.captureFails;
                stats.masterSegmentsCount = captured.masterSegCount || 0;
                stats.bodySegmentsCount = captured.segments.length - (captured.masterSegCount || 0);
                stats.splitMasterFromBody = splitMasterFromBody;
                plog("doScript: capture end (segments=" + captured.segments.length
                    + " master=" + stats.masterSegmentsCount
                    + " body=" + stats.bodySegmentsCount
                    + " fails=" + captured.captureFails + " empty=" + stats.emptySkipped + ")");

                if (captured.segments.length === 0) {
                    stats.error = "no paragraphs with content found";
                    plog("doScript: ABORT — no paragraphs with content");
                    return;
                }

                // Step 1.5: Phase 8A — script-by-font detection on uniform=false
                // segments. When a paragraph's char-level overrides express the
                // CJK/Latin font split (rather than via GREP rules), fold it
                // into "uniform with CJK baseline + Latin GREP" so cluster +
                // apply treat it visually identically. Mutates segments in-place.
                try {
                    var sbfStats = ScriptClassifier.applyScriptByFontDetection(captured.segments);
                    stats.scriptByFontDetected = sbfStats.detected;
                    stats.scriptByFontSkipped = sbfStats.skipped;
                    plog("doScript: scriptByFont detected=" + sbfStats.detected
                        + " skipped=" + sbfStats.skipped);
                } catch (eSbf) {
                    plog("doScript: scriptByFont FAIL " + (eSbf && eSbf.message ? eSbf.message : eSbf));
                }

                // Step 1.6: Phase 8B — emphasis extraction on remaining
                // uniform=false segments (those 8A did not handle). Promotes
                // per-character overrides into emphasisRuns so cluster pairs
                // by visual baseline + style_applier can re-apply emphasis as
                // _T_c_emp_* character styles after cascade normalize.
                // reorganize flow does NOT consume targetLanguage (preserves
                // source-document language semantics — pure style consolidation).
                try {
                    var empStats = EmphasisExtractor.applyEmphasisExtraction(
                        captured.segments,
                        { editMode: !!groupingChoice.editMode }
                    );
                    stats.emphasisProcessed = empStats.processed;
                    stats.emphasisRunsTotal = empStats.runsEmphasisTotal;
                    stats.emphasisCharStylePreserved = empStats.runsSkippedExistingCharStyleTotal;
                    plog("doScript: emphasis processed=" + empStats.processed
                        + " runsEmp=" + empStats.runsEmphasisTotal
                        + " runsCharStylePreserved=" + empStats.runsSkippedExistingCharStyleTotal);
                } catch (eEmp) {
                    plog("doScript: emphasis FAIL " + (eEmp && eEmp.message ? eEmp.message : eEmp));
                }

                // Step 2: build plan (pure reorganize — no CJK prep)
                plog("doScript: buildStylePlan begin");
                var plan = StyleSheetBuilder.buildStylePlan(captured.segments, doc, {
                    fontPolicy: REORGANIZE_FONT_POLICY,
                    fingerprintDimensions: groupingChoice.dimensions,
                    colorTol: groupingChoice.colorTol,
                    spacePreservingMerge: groupingChoice.spacePreservingMerge !== false,
                    // #28: keep master-spread paragraphs in their own
                    // cluster pool so a body theme cannot silently absorb
                    // master headers/footers/page-numbers/copyright strips.
                    splitMasterFromBody: splitMasterFromBody
                }, libDeps);
                stats.spaceOverridesCount = (plan.clusterReport && plan.clusterReport.space_overrides_count) || 0;
                stats.spacePreservingMerge = plan.spacePreservingMerge !== false;
                filterUnusedLatinStyles(plan);
                stats.paraStylesBeforeMerge = plan.paraStylesToCreate.length;
                plog("doScript: buildStylePlan end (paraStyles=" + plan.paraStylesToCreate.length
                    + " latinStyles=" + plan.latinStylesToCreate.length + ")");

                // Auto-merge near-duplicate clusters at the user-selected mode.
                if (groupingChoice.autoMerge) {
                    plog("doScript: auto-merge begin (" + groupingChoice.autoMerge
                        + (groupingChoice.hybridOpts
                            ? " bw×" + groupingChoice.hybridOpts.outlierBandwidthMul
                              + " absRatio≤" + Math.round(groupingChoice.hybridOpts.outlierMaxAbsoluteRatio * 100) + "%"
                              + " rel≤" + Math.round(groupingChoice.hybridOpts.outlierMaxRelativeDiff * 100) + "%"
                            : "")
                        + ")");
                    try {
                        var mergeResult = StyleMergeAdvisor.mergeGroupsAtConfidence(
                            plan, captured.segments, groupingChoice.autoMerge,
                            undefined, groupingChoice.hybridOpts
                        );
                        stats.mergeGroupCount = mergeResult.mergeCount;
                        stats.mergeParagraphsAffected = mergeResult.paragraphsAffected;
                        plog("doScript: auto-merge end (groups=" + mergeResult.mergeCount
                            + " parasAffected=" + mergeResult.paragraphsAffected + ")");
                    } catch (eMA) {
                        stats.mergeError = eMA && eMA.message ? eMA.message : String(eMA);
                        plog("doScript: auto-merge FAIL " + stats.mergeError);
                    }
                }
                stats.paraStylesCreated = plan.paraStylesToCreate.length;
                stats.latinStylesCreated = plan.latinStylesToCreate.length;

                // Step 3: commit (creates _T_p_<hash> styles in doc)
                plog("doScript: commitStylePlan begin (paraStyles=" + plan.paraStylesToCreate.length
                    + " latinStyles=" + plan.latinStylesToCreate.length + ")");
                var sheet = StyleSheetBuilder.commitStylePlan(doc, plan, libDeps);
                plog("doScript: commitStylePlan end");

                // Step 4: apply each paragraph's cluster style. We have the
                // direct para refs from capture, so no locator needed.
                plog("doScript: apply loop begin (" + captured.segments.length + " paragraphs)");
                var SS_dep = { fingerprintParagraph: StyleSheetBuilder.fingerprintParagraph };
                for (var i = 0; i < captured.segments.length; i++) {
                    if ((i % PROGRESS_STRIDE) === 0) {
                        plog("apply: " + i + "/" + captured.segments.length
                            + " applied=" + stats.clusterStylesApplied
                            + " fails=" + stats.applyFailures);
                    }
                    var seg = captured.segments[i];
                    var pRef = captured.paraRefs[i];
                    var pseudoLocate = { seg: seg, para: pRef, translatable: true };
                    try {
                        var r = StyleApplier.applyClusterStyleToParagraph(pRef, sheet, pseudoLocate, plan, SS_dep, { normalizeCascade: true });
                        if (r.applied) {
                            stats.clusterStylesApplied++;
                            // #7 fix: aggregate designer-char-style preserve
                            // metrics from the applier. Failures here mean
                            // a designer's char style range couldn't be
                            // re-applied after the normalize wipe → silent
                            // format loss unless surfaced.
                            if (typeof r.designerCharStylesPreserved === "number") {
                                stats.designerCharStylesPreserved = (stats.designerCharStylesPreserved || 0) + r.designerCharStylesPreserved;
                                stats.designerCharStylesRestored = (stats.designerCharStylesRestored || 0) + (r.designerCharStylesRestored || 0);
                                if (r.designerCharStylesFailed && r.designerCharStylesFailed.length) {
                                    if (!stats.designerCharStylesLost) stats.designerCharStylesLost = [];
                                    for (var __di = 0; __di < r.designerCharStylesFailed.length; __di++) {
                                        var __df = r.designerCharStylesFailed[__di];
                                        stats.designerCharStylesLost.push({
                                            tid: seg && seg.tid,
                                            charStart: __df.start,
                                            charEnd: __df.end,
                                            styleName: __df.styleName,
                                            reason: __df.reason
                                        });
                                    }
                                }
                            }
                            // Phase 8B: re-apply emphasis char styles for runs
                            // captured at export. Reorganize-only — text is
                            // unchanged so the offsets still index correctly.
                            if (seg.tid && plan.empRunsBySegment && plan.empRunsBySegment[seg.tid]) {
                                try {
                                    var empResult = StyleApplier.applyEmphasisRunsToParagraph(pRef, sheet, plan, seg.tid);
                                    stats.emphasisApplied = (stats.emphasisApplied || 0) + empResult.applied;
                                    stats.emphasisSkippedNoStyle = (stats.emphasisSkippedNoStyle || 0) + empResult.skippedNoStyle;
                                    stats.emphasisSkippedRangeFailed = (stats.emphasisSkippedRangeFailed || 0) + empResult.skippedRangeFailed;
                                } catch (eEmpA) {
                                    stats.emphasisApplyFailures = (stats.emphasisApplyFailures || 0) + 1;
                                }
                            }
                            // #27: SECOND-PASS replay of direct char overrides
                            // (capitalization / fillColor / pointSize). The
                            // emphasis pass above sets appliedCharacterStyle
                            // on subranges via `range.appliedCharacterStyle =
                            // styleObj` — InDesign treats char-style assignment
                            // as resetting any direct overrides on that range.
                            // applyClusterStyleToParagraph already restored
                            // overrides ONCE before normalize, but emphasis
                            // just re-wiped them on its emp-styled subranges.
                            // Replay AFTER emphasis so the overrides are the
                            // last word. Without this, ALL_CAPS / Paper /
                            // pointSize overrides get silently lost in any
                            // paragraph that has an emp range over them.
                            // #27 per-para second-pass replay (kept as a
                            // belt-and-suspenders for paras with non-empty
                            // directOverrideRanges from the per-para capture).
                            // The doc-wide restore at the end of the apply
                            // loop is the actual fix for preclean-wiped
                            // overrides; this just covers a hypothetical
                            // case where a per-para emp pass clobbered
                            // direct overrides AFTER doc-wide capture but
                            // BEFORE doc-wide restore.
                            if (r.directOverrideRanges && r.directOverrideRanges.length
                                    && typeof StyleApplier.restoreDirectCharOverrideRanges === "function") {
                                try {
                                    var dor2 = StyleApplier.restoreDirectCharOverrideRanges(pRef, r.directOverrideRanges);
                                    stats.directOverridesReplayed = (stats.directOverridesReplayed || 0) + (dor2.restored || 0);
                                    if (dor2.failed && dor2.failed.length) {
                                        if (!stats.directOverridesReplayLost) stats.directOverridesReplayLost = [];
                                        for (var __dor = 0; __dor < dor2.failed.length; __dor++) {
                                            stats.directOverridesReplayLost.push({ tid: seg && seg.tid, info: dor2.failed[__dor] });
                                        }
                                    }
                                } catch (eDOR) {
                                    stats.directOverridesReplayFailures = (stats.directOverridesReplayFailures || 0) + 1;
                                }
                            }
                            // Phase 9: per-paragraph sB/sA override (format-preserving merge)
                            if (seg.tid && plan.spaceOverridesBySegment && plan.spaceOverridesBySegment[seg.tid]) {
                                try {
                                    var spOv = StyleApplier.applySpaceOverridesToParagraph(pRef, plan, seg.tid);
                                    stats.spaceOverridesApplied = (stats.spaceOverridesApplied || 0) + spOv.applied;
                                    stats.spaceOverridesSkipped = (stats.spaceOverridesSkipped || 0) + spOv.skipped;
                                } catch (eSpO) {
                                    stats.spaceOverrideFailures = (stats.spaceOverrideFailures || 0) + 1;
                                }
                            }
                        } else {
                            stats.applyFailures++;
                            // #12 fix: capture failure detail so summary can
                            // surface real reasons + counts. r.applied=false
                            // path returns r.reason from style_applier.
                            if (!stats.applyFailureDetails) stats.applyFailureDetails = [];
                            if (stats.applyFailureDetails.length < 50) {
                                stats.applyFailureDetails.push({
                                    tid: seg && seg.tid,
                                    story_id: seg && seg.story_id,
                                    paragraph_index: seg && seg.paragraph_index,
                                    reason: r && r.reason || "(no reason)",
                                    fingerprint: r && r.fingerprint
                                });
                            }
                        }
                    } catch (eA) {
                        stats.applyFailures++;
                        if (!stats.applyFailureDetails) stats.applyFailureDetails = [];
                        if (stats.applyFailureDetails.length < 50) {
                            stats.applyFailureDetails.push({
                                tid: seg && seg.tid,
                                story_id: seg && seg.story_id,
                                paragraph_index: seg && seg.paragraph_index,
                                reason: "throw: " + (eA && eA.message ? eA.message : eA)
                            });
                        }
                    }
                }
                plog("doScript: apply loop end (applied=" + stats.clusterStylesApplied
                    + " fails=" + stats.applyFailures + ")");

                // #27: doc-wide restore of direct character overrides
                // captured pre-preclean. Story-relative offsets remained
                // stable through preclean + apply, so itemByRange against
                // the same (storyId, offset) reaches the same characters.
                // Stamps caps/fillColor/pointSize as direct overrides on
                // top of whatever char style the apply pipeline assigned;
                // values that matched the para style at capture time were
                // skipped, so this only re-applies LEGITIMATE designer
                // overrides (no spurious "+" override flags).
                if (__preDocOverrides) {
                    try {
                        var __postDocStats = StyleApplier.restoreDocDirectOverrides(doc, __preDocOverrides, plog, { getCollectionItem: getCollectionItem });
                        stats.docDirectOverridesRestored = __postDocStats.restored;
                        stats.docDirectOverridesCapsApplied = __postDocStats.capsApplied;
                        stats.docDirectOverridesFcApplied = __postDocStats.fcApplied;
                        stats.docDirectOverridesPtApplied = __postDocStats.ptApplied;
                        // #28b: also surface font / fontStyle restore counts.
                        stats.docDirectOverridesFontApplied = __postDocStats.fontApplied;
                        stats.docDirectOverridesFontStyleApplied = __postDocStats.fontStyleApplied;
                        stats.docDirectOverridesTrackingApplied = __postDocStats.trackingApplied || 0;
                        // #29: position / fillTint / noBreak / appliedLanguage counts.
                        stats.docDirectOverridesPositionApplied = __postDocStats.positionApplied;
                        stats.docDirectOverridesFillTintApplied = __postDocStats.fillTintApplied;
                        stats.docDirectOverridesNoBreakApplied = __postDocStats.noBreakApplied;
                        stats.docDirectOverridesLangApplied = __postDocStats.langApplied;
                        // #31: stroke + underline/strikeThrough visual detail counts.
                        stats.docDirectOverridesStrokeApplied = __postDocStats.strokeApplied;
                        stats.docDirectOverridesUlDetailApplied = __postDocStats.ulDetailApplied;
                        stats.docDirectOverridesStDetailApplied = __postDocStats.stDetailApplied;
                        stats.docDirectOverridesFailed = __postDocStats.failed;
                    } catch (ePR) {
                        plog("preserve: restore FAIL " + (ePR && ePR.message ? ePR.message : ePR));
                    }
                }

                // ── Underline / paragraph-rule overlap dedup ──
                // Runs AFTER doc-wide direct-override restore so it wins
                // over any per-run underline restore from preserve-state.
                // Designer-intended "two-layer trick" (rule as continuous
                // baseline + char-style underline) appears as two visible
                // lines once both layers survive reorganization; this pass
                // resolves the redundancy per groupingChoice.underlineOverlap.
                //   "suppress-underline" (default) → keep rule, clear r.underline
                //   "suppress-rule"                → keep char underline, clear ruleAbove
                //   "preserve-both"                → no-op
                try {
                    var __dedupMode = (groupingChoice && groupingChoice.underlineOverlap) || "suppress-underline";
                    plog("dedup: begin mode=" + __dedupMode + " paragraphs=" + captured.paraRefs.length);
                    var __dedupStats = UnderlineRuleDedup.applyUnderlineRuleDedup(
                        captured.paraRefs,
                        __dedupMode,
                        plog
                    );
                    stats.underlineDedupMode = __dedupStats.mode;
                    stats.underlineDedupParagraphsAffected = __dedupStats.paragraphsAffected;
                    stats.underlineDedupRangesAffected     = __dedupStats.rangesAffected;
                    stats.underlineDedupParagraphsCleared  = __dedupStats.paragraphsCleared;
                    stats.underlineDedupSkippedNoRule      = __dedupStats.skippedNoRule;
                    stats.underlineDedupSkippedNoUnderline = __dedupStats.skippedNoUnderline;
                    stats.underlineDedupErrors             = __dedupStats.errors;
                    plog("dedup: end affected=" + __dedupStats.paragraphsAffected
                        + " ranges=" + __dedupStats.rangesAffected
                        + " errors=" + __dedupStats.errors);
                } catch (eDD) {
                    stats.underlineDedupError = eDD && eDD.message ? eDD.message : String(eDD);
                    plog("dedup: FAIL " + stats.underlineDedupError);
                }

                // #30: hyperlink restore — verify each captured doc-level
                // hyperlink is still present + source still resolves. If
                // a hyperlink got dropped or its range drifted (e.g. due
                // to soft-break promotion), recreate it at the original
                // story+offset.
                if (__preDocHyperlinks) {
                    try {
                        var __postHyperlinks = HyperlinkPreserver.restoreDocHyperlinks(doc, __preDocHyperlinks, plog);
                        stats.hyperlinksChecked = __postHyperlinks.checked;
                        stats.hyperlinksPresent = __postHyperlinks.present;
                        stats.hyperlinksRecreated = __postHyperlinks.recreated;
                        stats.hyperlinksMissingSource = __postHyperlinks.missingSource;
                        stats.hyperlinksDropped = __postHyperlinks.dropped;
                    } catch (ePRH) {
                        plog("hyperlinks: restore FAIL " + (ePRH && ePRH.message ? ePRH.message : ePRH));
                    }
                }
                // Diagnostic: snapshot overflow after apply (vs pre-script).
                // Identifies whether apply (cascade normalize + new style)
                // introduced overflow in stories that were fine pre-script.
                var afterApply = snapshotOverflowState(doc);
                var applyDiff = diffOverflowState(beforeOverflow, afterApply);
                stats.overflowNewAfterApply = applyDiff.newlyOverflowing.length;
                stats.overflowFixedAfterApply = applyDiff.newlyFixed.length;
                if (applyDiff.newlyOverflowing.length > 0) {
                    plog("doScript: WARN apply introduced overflow in "
                        + applyDiff.newlyOverflowing.length + " stories: "
                        + applyDiff.newlyOverflowing.join(","));
                } else {
                    plog("doScript: OK no new overflow after apply");
                }

                // ── Post-flight repair (#2 fix: now inside same undo) ──
                // Repair was previously called OUTSIDE doScript, opening
                // its own ENTIRE_SCRIPT — two undo items, single Cmd+Z
                // would only undo one. runRepairCore() runs main()
                // directly without nested doScript so it joins this undo
                // block. Skipped when safety unchecked OR preflight
                // produced no snapshot.
                if (groupingChoice.runSafety && snapshotInfo) {
                    plog("postflight: begin (runRepairCore — inside same undo block)");
                    try {
                        var repairResult = RepairAfterApply.runRepairCore({});
                        stats.repair_status = repairResult && repairResult.statusLine ? repairResult.statusLine : "ok";
                        plog("postflight: end status=" + stats.repair_status);
                    } catch (eRP) {
                        stats.repair_status = "FAIL " + (eRP && eRP.message ? eRP.message : eRP);
                        plog("postflight: FAIL " + stats.repair_status);
                    }
                } else if (groupingChoice.runSafety && !snapshotInfo) {
                    plog("postflight: SKIPPED (preflight produced no snapshot)");
                } else {
                    plog("postflight: SKIPPED (safety checkbox unchecked)");
                }

                // ── 8D-ext-D M3: byPair char-level font sweep (facade) ──
                // LAST step before doScript close — pinned AFTER #27
                // restoreDocDirectOverrides (its re-stamp of pre-preclean
                // direct overrides would silently revert byPair swaps on
                // designer direct-override chars, r14 P2) and AFTER the
                // underline/rule dedup. Inside this same doScript closure
                // so the sweep shares the single ENTIRE_SCRIPT undo (r12).
                // Facade RETURNS {blocked} rather than throwing (uniform
                // shape) — the explicit throw below is what routes us into
                // catch(eIn), whose byPairBlocked re-throw escapes the
                // closure and triggers the ENTIRE_SCRIPT rollback (r21/r22).
                var __sweepAppliedActions = [];
                if (opts.byPair && opts.byPair.length) {
                    plog("byPair: begin sweep entries=" + opts.byPair.length + " mode=M3");
                    try {
                        var ByPairSweep = require("./byPair_char_sweep.js");
                        var __sweepOut = ByPairSweep.applyByPairSweep(doc, opts.byPair, {
                            mode: "M3",
                            skipDecisions: opts.skipDecisions || {},
                            brandConfig: opts.brandConfig || {},
                            langScriptTable: opts.langScriptTable || {}
                        });
                        stats.byPairBlocked = !!__sweepOut.blocked;
                        stats.byPairSwapped = __sweepOut.swapped;
                        stats.byPairErrors = __sweepOut.errors;
                        stats.byPairDiagnostics = __sweepOut.diagnostics;
                        stats.byPairErrorSamples = __sweepOut.errorSamples;
                        __sweepAppliedActions = __sweepOut.appliedActions || [];
                        plog("byPair: end swapped=" + __sweepOut.swapped
                            + " errors=" + __sweepOut.errors
                            + " blocked=" + __sweepOut.blocked
                            + " warnings=" + (__sweepOut.diagnostics.warnings || []).length);
                        if (__sweepOut.blocked) {
                            throw new Error("M3 byPair blocked: "
                                + (__sweepOut.reason || "see stats.byPairDiagnostics"));
                        }
                    } catch (eFacade) {
                        // r22 P1: exception path (activeDocument assertion /
                        // scan failure / internal throw) must ALSO set the
                        // flag so catch(eIn)'s guarded re-throw fires and
                        // ENTIRE_SCRIPT rolls back — otherwise the swallow
                        // commits a half-swept doc.
                        stats.byPairBlocked = true;
                        stats.byPairException = eFacade && eFacade.message ? eFacade.message : String(eFacade);
                        throw eFacade;
                    }
                }

                // ── 8D-ext-D M3: script-font enforcer (net-new site, DR4) ──
                // INDEPENDENT of byPair (codex step-2 P1#1: runEnforcer is its
                // own M3 toggle — nesting it under non-empty opts.byPair
                // silently dropped the requested designer-CS font correction
                // whenever brand config / byPair was empty). Gated on
                // __inProcess so plain double-click / bridge reorganize keeps
                // its shipped zero-enforcer behavior (those entries pass no
                // opts → __inProcess === false).
                //
                // Full-document scope (codex step-2 P2#2): walks EVERY story
                // paragraph + table-cell paragraph (gate-11 #11), not just
                // reorganize's captured.paraRefs — the facade scans/sweeps the
                // whole doc, so snapshot-failed paras (dropped from paraRefs)
                // could otherwise miss post-sweep enforcement. The enforcer
                // itself skips [None]/_T_* chars, so a full walk is safe.
                //
                // `preserve` (codex step-2 P1#2) is built from the facade's
                // appliedActions — the dst fonts ACTUALLY swept, with
                // skipDecisions-skipped + coverage-rejected pairs excluded —
                // so a skipped/rejected pair can't exempt fonts doc-wide.
                // Font-key (not swept-range) exclusion is deliberate: a
                // same-script designer-CS char whose current font happens to
                // == an applied dstFont is almost certainly designer intent,
                // so preserving it is correct; range-exclusion would
                // re-enforce it and risk violating that intent. Same-script
                // swaps are also already skipped by the enforcer's own
                // script-match check; preserve only guards the residual
                // non-CJK_FAMILY_RE CJK-font edge (e.g. AdobeMing).
                if (__inProcess && opts.runEnforcer !== false) {
                    var __BPS = require("./byPair_char_sweep.js");
                    // Full-doc paragraph collection (stories + table cells).
                    var __allParas = [];
                    try {
                        var __stories = doc.stories;
                        for (var __si = 0; __si < __stories.length; __si++) {
                            var __story = getCollectionItem(__stories, __si);
                            if (!__story || !__story.isValid) continue;
                            var __sp = __story.paragraphs;
                            for (var __pp = 0; __pp < __sp.length; __pp++) {
                                var __pr = getCollectionItem(__sp, __pp);
                                if (__pr) __allParas.push(__pr);
                            }
                            var __tbls = __story.tables;
                            for (var __ti = 0; __ti < __tbls.length; __ti++) {
                                var __tbl = getCollectionItem(__tbls, __ti);
                                if (!__tbl) continue;
                                var __cells = __tbl.cells;
                                for (var __ci = 0; __ci < __cells.length; __ci++) {
                                    var __cell = getCollectionItem(__cells, __ci);
                                    if (!__cell) continue;
                                    var __cps = __cell.paragraphs;
                                    for (var __cpi = 0; __cpi < __cps.length; __cpi++) {
                                        var __cpr = getCollectionItem(__cps, __cpi);
                                        if (__cpr) __allParas.push(__cpr);
                                    }
                                }
                            }
                        }
                    } catch (eCollect) {
                        plog("enforcer: para-collect partial: " + (eCollect && eCollect.message ? eCollect.message : eCollect));
                    }
                    plog("enforcer: begin (post-facade, full-doc paras=" + __allParas.length + ")");
                    try {
                        var __enf = require("./script_font_enforcer.js");
                        var __preserve = [];
                        var __seenPreserve = {};
                        for (var __ai = 0; __ai < __sweepAppliedActions.length; __ai++) {
                            var __act = __sweepAppliedActions[__ai];
                            if (!__act || !__act.dstFamily) continue;
                            var __key = __act.dstFamily + "|" + __act.dstStyle;
                            var __isCjkAct = !!(__BPS.CJK_LANG_SET[__act.sourceLang]
                                              || __BPS.CJK_LANG_SET[__act.dstLang]);
                            var __pk = __key + "|" + __isCjkAct;
                            if (__seenPreserve[__pk]) continue;
                            __seenPreserve[__pk] = true;
                            __preserve.push({ key: __key, cjk: __isCjkAct });
                        }
                        var __enfTotals = { cjkEnforced: 0, latinEnforced: 0, preserved: 0, errors: 0 };
                        for (var __ei = 0; __ei < __allParas.length; __ei++) {
                            var __ep = __allParas[__ei];
                            if (!__ep || !__ep.isValid) continue;
                            var __es = __enf.enforceScriptFontsInParagraph(__ep, { preserve: __preserve });
                            __enfTotals.cjkEnforced += __es.cjkEnforced;
                            __enfTotals.latinEnforced += __es.latinEnforced;
                            __enfTotals.preserved += (__es.skippedPreservedFont || 0);
                            __enfTotals.errors += __es.errors;
                        }
                        stats.enforcerCjkEnforced = __enfTotals.cjkEnforced;
                        stats.enforcerLatinEnforced = __enfTotals.latinEnforced;
                        stats.enforcerPreservedSwept = __enfTotals.preserved;
                        stats.enforcerErrors = __enfTotals.errors;
                        plog("enforcer: end cjk=" + __enfTotals.cjkEnforced
                            + " latin=" + __enfTotals.latinEnforced
                            + " preserved=" + __enfTotals.preserved
                            + " errors=" + __enfTotals.errors);
                    } catch (eEnf) {
                        stats.enforcerError = eEnf && eEnf.message ? eEnf.message : String(eEnf);
                        plog("enforcer: FAIL " + stats.enforcerError);
                    }
                } else if (opts.runEnforcer === false) {
                    plog("enforcer: SKIPPED (opts.runEnforcer === false)");
                }
            } catch (eIn) {
                stats.error = eIn && eIn.message ? eIn.message : String(eIn);
                plog("doScript: INNER THROW " + stats.error);
                // 8D-ext-D M3 (r21 iter2): a blocked/failed byPair sweep must
                // escape this closure so app.doScript discards the
                // ENTIRE_SCRIPT transaction — a swallowed throw here would
                // commit a partially-swept doc. The re-thrown error is
                // caught by the outer catch(eDS); the panel surfaces the
                // failure via the RETURNED stats (byPairBlocked +
                // byPairDiagnostics), not via the exception.
                if (stats.byPairBlocked) {
                    plog("doScript: re-throw for ENTIRE_SCRIPT rollback (byPairBlocked)");
                    throw eIn;
                }
            } finally {
                // #4 fix: restore units regardless of success/throw.
                try { if (origUnits.h !== null) doc.viewPreferences.horizontalMeasurementUnits = origUnits.h; } catch (eUR0) {}
                try { if (origUnits.v !== null) doc.viewPreferences.verticalMeasurementUnits = origUnits.v; } catch (eUR1) {}
                plog("doScript: finally — units restored, exiting");
            }
        }, ScriptLanguage.JAVASCRIPT, undefined, UndoModes.ENTIRE_SCRIPT, "Reorganize Styles (in-place + preflight + repair)");
        plog("doScript: returned to outer scope");
    } catch (eDS) {
        stats.error = "doScript wrapper: " + (eDS && eDS.message ? eDS.message : eDS);
        plog("doScript: OUTER THROW " + stats.error);
    } finally {
        // Always re-enable redraw and restore userInteractionLevel even
        // on outer throw (#5 fix). showAlert below uses dialogs.show
        // which is silently swallowed under NEVER_INTERACT.
        try {
            // #11 fix: restore caller's enableRedraw setting (default true)
            // instead of unconditionally setting true.
            if (origEnableRedraw !== null) {
                app.scriptPreferences.enableRedraw = origEnableRedraw;
            } else {
                app.scriptPreferences.enableRedraw = true;
            }
        } catch (eRD) {}
        try {
            if (origInteractionLevel !== null) {
                app.scriptPreferences.userInteractionLevel = origInteractionLevel;
                plog("userInteractionLevel: restored to " + String(origInteractionLevel));
            }
        } catch (eIR) {}
    }

    // #14 fix: failures inside doScript are caught locally so the outer
    // try/catch sees "success" — but apply failures, designer-lost
    // ranges, preflight failures, and inner throws all leave the doc
    // partially mutated. Synthesize a "partial failure" flag that the
    // alert below uses to make this LOUD instead of looking normal.
    // P2.a fix: broaden failure detection. Previously only checked 4
    // gauges (inner throw / apply failures / designer loss / repair_status
    // starting with "FAIL"); the script could SAY "Reorganized: ..." in
    // green tone while N hyperlinks were dropped, M direct overrides
    // failed, paraDeltas write silently corrupted, etc. Use a unified
    // isFailureStatus helper (matches both "FAIL ..." and "ERROR: ...")
    // and roll up every preservation/repair/write/drop counter.
    function isFailureStatus(s) {
        if (!s) return false;
        return /^(FAIL|ERROR)\b/i.test(String(s));
    }
    var hadInnerThrow = !!stats.error;
    var hadApplyFailures = (stats.applyFailures || 0) > 0;
    var hadDesignerLoss = !!(stats.designerCharStylesLost && stats.designerCharStylesLost.length);
    var hadRepairFail = isFailureStatus(stats.repair_status);
    // Newly-tracked failure modes (each = some user-visible degradation
    // we used to silently report as success):
    var hadPreflightFail            = !!stats.preflight_failed;
    var hadParaDeltasFail           = !!stats.paraDeltasWriteFailed;
    var hadDocOverrideFail          = (stats.docDirectOverridesFailed || 0) > 0;
    var hadHyperlinksDropped        = (stats.hyperlinksDropped || 0) > 0;
    var hadHyperlinksMissingSource  = (stats.hyperlinksMissingSource || 0) > 0;
    var hadEmphasisApplyFailures    = (stats.emphasisApplyFailures || 0) > 0;
    var hadDirectOverrideReplayFail = (stats.directOverridesReplayFailures || 0) > 0
                                   || !!(stats.directOverridesReplayLost && stats.directOverridesReplayLost.length);
    var hadNewOverflow              = (stats.overflowNewAfterApply || 0) > 0;
    // 8D-ext-D (codex step-2 P2#1): enforcer per-char failures + a thrown
    // enforcer pass were recorded but omitted from partialFailure — partial
    // font corrections could commit while ok:true was returned.
    var hadEnforcerError            = (stats.enforcerErrors || 0) > 0 || !!stats.enforcerError;
    var partialFailure = hadInnerThrow || hadApplyFailures || hadDesignerLoss || hadRepairFail
        || hadPreflightFail || hadParaDeltasFail || hadDocOverrideFail
        || hadHyperlinksDropped || hadHyperlinksMissingSource
        || hadEmphasisApplyFailures || hadDirectOverrideReplayFail
        || hadNewOverflow || hadEnforcerError;

    plog("=== reorganize_styles_inplace end ("
        + "error=" + (stats.error || "none")
        + " applyFailures=" + (stats.applyFailures || 0)
        + " designerLost=" + (hadDesignerLoss ? stats.designerCharStylesLost.length : 0)
        + " partial=" + partialFailure + ") ===");
    // Final flush — ensures any buffered lines hit disk before alert
    // (PLOG_FLUSH_INTERVAL only flushes every 50 lines, so the tail
    // could be in-memory only).
    _plogFlush();

    // Build summary alert
    var summary = (partialFailure ? "⚠ Reorganized WITH ERRORS: " : "Reorganized: ") + docName + "\n\n";
    if (stats.byPairBlocked) {
        // 8D-ext-D (codex step-2 P2#3): a blocked byPair sweep re-threw out
        // of the doScript closure, so ENTIRE_SCRIPT discarded the WHOLE
        // transaction — the doc is UNCHANGED (probe 20260609_06 confirms
        // throw → full rollback). The generic stats.error branch below would
        // say "PARTIALLY MODIFIED → Edit → Undo", which is wrong + dangerous
        // here: there is nothing to undo, and an Undo would revert the
        // user's PRIOR edit instead.
        summary += "byPair font swap BLOCKED — reorganize was ROLLED BACK.\n\n";
        summary += "✓ The document is UNCHANGED (the whole reorganize transaction\n";
        summary += "  was discarded — no _T_p_* styles, no swaps committed).\n";
        summary += "✗ Do NOT Edit → Undo (nothing to revert; an Undo would hit\n";
        summary += "  your PREVIOUS edit). Fix the byPair issue and re-run.\n";
        if (stats.byPairException) summary += "  Reason: " + stats.byPairException + "\n";
    } else if (stats.error) {
        summary += "ERROR: " + stats.error + "\n\n";
        summary += "⚠ The document has been PARTIALLY MODIFIED.\n";
        summary += "  Recommended: Edit → Undo immediately to revert,\n";
        summary += "  OR File → Save As to a new file before further edits.\n";
    } else if (partialFailure) {
        // No fatal error but counted-failure aggregations indicate the
        // doc isn't in the all-good state user expects.
        summary += "⚠ Some operations failed even though the script reached the end.\n";
        summary += "  See per-row counts below + the progress log.\n";
        summary += "  Recommended: Edit → Undo and re-run with adjusted settings,\n";
        summary += "  OR review failures + decide whether the partial result is OK.\n\n";
    }
    if (!stats.error) {
        var clusterRatio = stats.captured > 0
            ? (stats.captured / Math.max(1, stats.paraStylesCreated)).toFixed(1)
            : "0";
        summary += "Paragraphs reorganized: " + stats.clusterStylesApplied
                + " / " + stats.captured + "\n";
        summary += "New paragraph styles: " + stats.paraStylesCreated
                + "  (avg " + clusterRatio + "× clustering)\n";
        if (stats.paraStylesBeforeMerge && stats.paraStylesBeforeMerge !== stats.paraStylesCreated) {
            summary += "Auto-merge (" + (groupingChoice.autoMerge || "off") + "): "
                + stats.paraStylesBeforeMerge + " → " + stats.paraStylesCreated + " styles "
                + "(merged " + (stats.mergeGroupCount || 0) + " near-dup groups, "
                + (stats.mergeParagraphsAffected || 0) + " paras absorbed)\n";
        }
        if (stats.latinStylesCreated > 0) {
            summary += "New character styles: " + stats.latinStylesCreated + "\n";
        }
        if (stats.captureFailed > 0) summary += "Capture failures (skipped): " + stats.captureFailed + "\n";
        if (stats.emptySkipped > 0) summary += "Empty / control paragraphs (skipped): " + stats.emptySkipped + "\n";
        if (stats.applyFailures > 0) {
            summary += "⚠ Apply failures: " + stats.applyFailures
                + " paragraphs (these were NOT reorganized — see log for tids/reasons)\n";
            // Log each failure detail (#12 fix)
            if (stats.applyFailureDetails && stats.applyFailureDetails.length) {
                for (var __afi = 0; __afi < stats.applyFailureDetails.length; __afi++) {
                    var __af = stats.applyFailureDetails[__afi];
                    plog("APPLY FAIL: tid=" + __af.tid
                        + " story=" + __af.story_id
                        + " para=" + __af.paragraph_index
                        + " reason=" + __af.reason
                        + (__af.fingerprint ? " fp=" + __af.fingerprint : ""));
                }
                if (stats.applyFailures > stats.applyFailureDetails.length) {
                    plog("APPLY FAIL: " + (stats.applyFailures - stats.applyFailureDetails.length) + " more (truncated at 50)");
                }
            }
        }
        if (stats.mergeError) summary += "Merge advisor error: " + stats.mergeError + "\n";
        // #7 fix: surface designer-char-style preserve metrics. Lost > 0
        // means actual data loss (a designer's character style range
        // could not be re-applied after the normalize wipe).
        if (stats.designerCharStylesPreserved > 0) {
            summary += "Designer character styles preserved: "
                + (stats.designerCharStylesRestored || 0) + " / " + stats.designerCharStylesPreserved
                + " ranges across paragraphs\n";
        }
        if (stats.designerCharStylesLost && stats.designerCharStylesLost.length) {
            summary += "⚠ DESIGNER CHAR STYLE LOSSES: "
                + stats.designerCharStylesLost.length + " range(s) failed to restore "
                + "(see log for details — this is data loss)\n";
            // Also log each failure for triage
            for (var __li = 0; __li < stats.designerCharStylesLost.length; __li++) {
                var __ll = stats.designerCharStylesLost[__li];
                plog("DESIGNER CHAR STYLE LOST: tid=" + __ll.tid
                    + " chars=[" + __ll.charStart + "," + __ll.charEnd + "]"
                    + " styleName='" + __ll.styleName + "' reason=" + __ll.reason);
            }
        }
        // Underline / paragraph-rule overlap dedup summary
        if (stats.underlineDedupMode && stats.underlineDedupMode !== "preserve-both") {
            var __dedupLabel = (stats.underlineDedupMode === "suppress-underline")
                ? "suppress char underline (keep rule)"
                : "suppress rule (keep char underline)";
            if ((stats.underlineDedupParagraphsAffected || 0) > 0) {
                summary += "Underline / rule dedup [" + __dedupLabel + "]: "
                        + stats.underlineDedupParagraphsAffected + " paragraphs";
                if (stats.underlineDedupMode === "suppress-underline") {
                    summary += " (" + (stats.underlineDedupRangesAffected || 0) + " ranges)";
                }
                summary += "\n";
            }
            if (stats.underlineDedupErrors > 0) {
                summary += "⚠ Underline / rule dedup errors: " + stats.underlineDedupErrors + " (see log)\n";
            }
        }
        summary += "\nNew styles named _T_p_<hash>. Original styles remain in\n";
        summary += "the doc as orphans — clean up via Paragraph Styles panel\n";
        summary += "→ Select All Unused → delete.\n\n";
        summary += "Doc NOT saved. Inspect, then File → Save (or Edit → Undo).";
    }
    if (groupingChoice && groupingChoice.splitSoftBreaks && (stats.softBreakSplits || stats.softBreakFound)) {
        summary += "\nPre-clean soft breaks: found " + (stats.softBreakFound || 0)
                + ", promoted to hard breaks " + (stats.softBreakSplits || 0)
                + " (paragraphs " + (stats.paragraphsBefore || 0) + " → " + (stats.paragraphsAfter || 0) + ").";
    }
    if (typeof stats.overflowNewAfterPreclean === "number" || typeof stats.overflowNewAfterApply === "number") {
        summary += "\nOverflow diagnostic: +" + (stats.overflowNewAfterPreclean || 0) + " after preclean, +"
                + (stats.overflowNewAfterApply || 0) + " after apply (vs pre-script). See log for story IDs.";
    }
    if (groupingChoice && groupingChoice.runSafety) {
        summary += "\nPre-flight: " + (snapshotInfo ? (snapshotInfo.storyCount + " stories snapshotted") : "no repairable stories")
                + ".  Post-repair: " + (stats.repair_status || "skipped") + ".";
    }
    summary += "\n\nProgress log: " + progressLogPath;
    // #19 fix: the apply-failure / designer-loss detail plogs above
    // happen AFTER the early _plogFlush() — without a second flush
    // they'd stay in memory and the alert's "see log for details" would
    // mislead. Final flush guarantees details hit disk before alert.
    _plogFlush();

    // #26: skip the trailing summary dialog when running headless.
    // The dialog blocks InDesign's main thread until the operator
    // clicks OK — bridge sees __bundle_result.json appear and reports
    // "done", but the plugin is still locked. Capture the same content
    // to <PluginData>/__auto_result_reorganize_styles_inplace.json so
    // the caller can fetch it via the bridge response.
    if (__inProcess && !opts.showSummaryDialog) {
        // 8D-ext-D M3 (branch X, r21 P2#6): in-process callers consume the
        // RETURNED stats and render their own unified feedback — a modal
        // here would double-prompt. Gated on __inProcess (NOT bare opts —
        // opts is always-truthy after defaulting, which would eat the
        // double-click dialog too). Panel surfaces byPair failures via
        // stats.byPairBlocked + byPairDiagnostics (the rollback throw is
        // swallowed by the outer catch above and never reaches us).
        plog("in-process: summary dialog suppressed; returning stats");
    } else if (AutomationBridge.isAutomatedRun("reorganize_styles_inplace")) {
        plog("automation: suppressing summary dialog (headless run); writing __auto_result file");
        try {
            await AutomationBridge.recordAutomationResult("reorganize_styles_inplace", {
                // P2.a fix: automation ok now mirrors the user-facing
                // partialFailure flag — any preservation/repair/write/
                // drop counter that triggered the in-app ⚠ alert also
                // forces ok=false in the bridge response so callers
                // (CI, batch runners) don't treat partial-loss runs as
                // green.
                ok: !partialFailure,
                partialFailure: partialFailure,
                summary: summary,
                stats: stats,
                progressLogPath: progressLogPath
            });
        } catch (eAR) {
            plog("automation: recordAutomationResult failed: " + (eAR && eAR.message ? eAR.message : eAR));
        }
    } else {
        showAlert(summary);
    }

    // 8D-ext-D M3: uniform result for in-process callers (double-click /
    // bridge ignore the return value).
    return {
        ok: !partialFailure,
        partialFailure: partialFailure,
        summary: summary,
        stats: stats,
        progressLogPath: progressLogPath
    };
}

function showAlert(msg) {
    // #26: any showAlert call (intermediate warnings + the trailing
    // summary handled above) gets routed to plog when running headless,
    // since DOM dialogs block the bridge plugin.
    if (AutomationBridge.isAutomatedRun("reorganize_styles_inplace")) {
        try { plog("alert (suppressed in automation): " + String(msg).replace(/\r?\n|\r/g, " | ")); } catch (eP) {}
        return;
    }
    try {
        var dlg = app.dialogs.add({ name: "Reorganize Styles", canCancel: false });
        var col = dlg.dialogColumns.add();
        var parts = String(msg).split(/\r?\n|\r/);
        for (var i = 0; i < parts.length; i++) {
            col.staticTexts.add({ staticLabel: parts[i] });
        }
        dlg.show();
        dlg.destroy();
    } catch (e) {}
}

// ── 8D-ext-D M3: requirable-module seam (probe 20260609_01 revision) ──
// This file IS the implementation; reorganize_styles_inplace.idjs is now a
// thin double-click/bridge launcher. In-process callers (font_apply_panel
// M3 path) require THIS lib and `await ReorganizeCore.main(opts)` — no
// globalThis flag protocol needed (libs never self-execute).
//
// Why not the RR1-spec'd guard-on-the-entry pattern: both the bridge
// bundle resolver (synthRequire) and native UXP require eval required
// modules as CommonJS factories, where a top-level `await main()` is a
// PARSE error — the globalThis guard can't help because parsing fails
// before any code runs (probe 20260609_01 T1: "await is only valid in
// async functions"). gate11b's contract probe had never actually been
// run against the require path (results.txt missing — the a.2
// pre-condition the plan itself required before locking).
module.exports = { main: main };
