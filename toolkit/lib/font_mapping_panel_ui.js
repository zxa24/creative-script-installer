"use strict";
/*
 * lib/font_mapping_panel_ui.js
 *
 * CONFIG-ONLY re-host of font_apply_panel.idjs's React UI, for callers that
 * want the rich font-mapping panel to PRODUCE a brand_config WITHOUT applying
 * it to the doc (e.g. import_integrated's no-config branch: the import's own
 * byPair sweep does the apply later).
 *
 * This is a faithful copy of font_apply_panel's Step 1-8 (scan → load React/
 * Babel/CanvasPan → read panel.css → inject window.__fap → build <dialog> +
 * #root → compile/eval data/components/app.jsx → block until close). The ONLY
 * behavioural difference: onDone runs `panelDataToConfig` and RESOLVES the
 * returned brand_config instead of running the apply pipeline.
 *
 * font_apply_panel.idjs is left untouched (this is a copy, not an extraction
 * that re-points it). Shared deps (DocScan / PanelAdapter / vendored React /
 * panel.css / *.jsx) are the same files both consume.
 *
 * API:  await showFontMappingPanelForConfig(mvpDir)
 *         → { ok: true, config: <brand_config>|null, cancelled: <bool>,
 *             validateErrors: <string[]>|null }
 *         → { ok: false, error: "..." }   // panel unavailable (showModal /
 *                                          // JSX eval failed)
 *
 *   8D-ext-MM step 5 (on-reject contract): a validate-FAIL must be
 *   distinguishable from a cancel. Internally `onDone` resolves a wrapper
 *   { config, validateErrors }; this function then returns:
 *     • valid    → { ok:true, config:<cfg>, cancelled:false, validateErrors:null }
 *     • invalid  → { ok:true, config:null,  cancelled:false, validateErrors:[…] }
 *     • cancel   → { ok:true, config:null,  cancelled:true,  validateErrors:null }
 *   i.e. `cancelled` is true ONLY when there is no config AND no validateErrors
 *   (genuine Escape/close). An invalid config carries `validateErrors`; a panel
 *   that never loaded is `{ ok:false, error }` with no validateErrors. Callers
 *   key the non-silent NOTICE off `validateErrors`, not off `config == null`.
 */
var fs = require("fs");
var RuntimePaths = require("./runtime_paths.js");
var DocScan = require("./font_mapping_doc_scan.js");
var PanelAdapter = require("./font_mapping_panel_adapter.js");
var PickerOutcome = require("./picker_outcome.js");
var Enforcer = require("./script_font_enforcer.js");
// 8D-ext faux-CJK-opt-in r4-(Y): shared panel-bootstrap ENV — installGlobals (React/ReactDOM/
// CanvasPan/WireHitTest) + fillCommonFap (cjkLangs + scan-derived fap fields). Single source
// so this launcher and font_apply_panel.idjs are consistent BY CONSTRUCTION (no per-launcher
// global/fap drift — that drift was the WireHitTest + cjkLangs bugs).
var FontPanelEnv = require("./font_panel_env.js");
// #28e — face-level not-installed precompute: the probe passed to
// configToPanelData is the byPair Stage-1 gate itself (shared function).
var FaceMissing = require("./font_face_missing.js");

function joinAll() {
    var out = arguments[0];
    for (var i = 1; i < arguments.length; i++) out = RuntimePaths.joinPath(out, arguments[i]);
    return out;
}

async function showFontMappingPanelForConfig(mvpDir, opts) {
    opts = opts || {};
    if (typeof document === "undefined") return { ok: false, error: "document undefined (must run in UXP webview context)" };
    var app = require("indesign").app;
    var DEV_DIR = joinAll(mvpDir, "dev", "font_apply_panel");

    // ── Step 1a: enumerate installed families (everyItem().name batch) ──
    var installedFamilies = {};
    try {
        var allNames = app.fonts.everyItem().name;
        var arr = (allNames && allNames.length !== undefined) ? [].slice.call(allNames) : [];
        for (var i = 0; i < arr.length; i++) {
            var n = String(arr[i] || ""); if (!n) continue;
            var parts = n.split("\t"); var fam = parts[0]; if (!fam) continue;
            var style = parts[1] || "Regular";
            if (!installedFamilies[fam]) installedFamilies[fam] = [];
            if (installedFamilies[fam].indexOf(style) === -1) installedFamilies[fam].push(style);
        }
    } catch (eIF) { return { ok: false, error: "installed-font enumerate failed: " + (eIF && eIF.message || eIF) }; }

    // ── Step 1b: scan active doc ──
    var scanResult = null;
    try { scanResult = DocScan.scanActiveDoc({ installedFamilies: installedFamilies }); }
    catch (eScan) { return { ok: false, error: "scan threw: " + (eScan && eScan.message || eScan) }; }
    if (!scanResult || !scanResult.ok) return { ok: false, error: "scan failed: " + (scanResult && scanResult.reason || "unknown") };
    var panelData = scanResult.panelData;
    if (panelData) {
        // TODO#58: same field, different criterion — `equivalence_groups_auto` now
        // comes from face identity (Font.postscriptName), not from spelling. The
        // (5) readout rides along on fap.identityReadout via fillCommonFap.
        panelData.equivalence_groups = (scanResult.equivalence_groups_auto || []).slice();
        panelData._confirmable_merges = (scanResult.confirmable_merges || []).slice();
    }

    // ── Step 2: install shared globals (React/ReactDOM/CanvasPan/WireHitTest) + local Babel ──
    var Babel;
    try {
        Babel = require("./vendor/babel.min.js");   // LOCAL — used by compileAndEval below
        FontPanelEnv.installGlobals();              // React/ReactDOM/CanvasPan/WireHitTest (shared SoT)
    } catch (eReq) { return { ok: false, error: "React/Babel require failed: " + (eReq && eReq.message || eReq) }; }

    // ── Step 3: panel.css ──
    var cssText = "";
    try { cssText = fs.readFileSync(joinAll(DEV_DIR, "panel.css"), "utf-8"); }
    catch (eCss) { return { ok: false, error: "panel.css read failed: " + (eCss && eCss.message || eCss) }; }

    // ── Step 4: inject window.__fap (config-only onDone) ──
    var lfs; try { lfs = require("uxp").storage.localFileSystem; } catch (eLfs) { lfs = null; }
    async function importJson() {
        if (!lfs) return { ok: false, reason: "lfs unavailable" };
        try {
            // 🔴 Same fix as font_apply_panel.idjs. These two hosts are COPIES — the
            // comment over there calls them "single source, consistent-by-construction",
            // but nothing enforces that: it is an assertion, not a mechanism. Fixing only
            // one would leave the defect alive on whichever path owner did not test.
            // Two outcomes, two VALUES; see lib/picker_outcome.js for why neither of them
            // claims to know whether the operator cancelled.
            var f;
            try {
                f = await lfs.getFileForOpening({ types: ["json"], allowMultiple: false });
            } catch (ePick) {
                return { ok: false, reason: "picker-threw", detail: String(ePick && ePick.message || ePick) };
            }
            if (!f) return { ok: false, reason: "picker-returned-nothing" };
            var obj = JSON.parse(await f.read());
            var imported;
            if (obj && obj.brand_name && obj.fonts_by_language) {
                // includeDocFonts: keep doc-present fonts as nodes after import so
                // the tofu red-flag still fires (mirrors the seed-open path above).
                imported = PanelAdapter.configToPanelData(obj, scanResult, { includeDocFonts: true, installedFamilies: installedFamilies, probeFace: FaceMissing.gateProbeFace });
                if (!imported) return { ok: false, reason: "lib config → panelData failed" };
            } else if (obj && Array.isArray(obj.languages)) {
                var legCv = PanelAdapter.panelDataToConfig(obj);
                if (!legCv.ok) return { ok: false, reason: "legacy v2 panel data invalid: " + (legCv.errors || []).join("; ") };
                imported = PanelAdapter.configToPanelData(legCv.config, scanResult, { includeDocFonts: true, installedFamilies: installedFamilies, probeFace: FaceMissing.gateProbeFace });
            } else { return { ok: false, reason: "unrecognized JSON shape" }; }
            imported.equivalence_groups = imported.equivalence_groups || (scanResult.equivalence_groups_auto || []).slice();
            imported._confirmable_merges = (scanResult.confirmable_merges || []).slice();
            return { ok: true, data: imported, path: (f.nativePath || f.name || "?") };
        } catch (eImp) { return { ok: false, reason: String(eImp.message || eImp) }; }
    }
    async function exportJson(currentData) {
        if (!lfs) return { ok: false, reason: "lfs unavailable" };
        try {
            var cv = PanelAdapter.panelDataToConfig(currentData);
            if (!cv.ok) return { ok: false, reason: "config invalid: " + (cv.errors || []).join("; ") };
            var suggested = ("font_apply_" + (cv.config.brand_name || "panel") + ".json").replace(/[\\/:*?"<>|]/g, "_");
            // 🔴 Same sweep as the launcher — these two hosts are copies.
            var f;
            try {
                f = await lfs.getFileForSaving(suggested, { types: ["json"] });
            } catch (ePick) {
                return { ok: false, reason: "picker-threw", detail: String(ePick && ePick.message || ePick) };
            }
            if (!f) return { ok: false, reason: "picker-returned-nothing" };
            await f.write(JSON.stringify(cv.config, null, 2));
            return { ok: true, path: (f.nativePath || f.name || "?") };
        } catch (eExp) { return { ok: false, reason: String(eExp.message || eExp) }; }
    }
    var enforcerEligibility = null;
    try { enforcerEligibility = Enforcer.detectEnforcerEligibility(app.activeDocument); }
    catch (eElig) { enforcerEligibility = { eligible: false, reasons: ["eligibility check threw: " + (eElig.message || eElig)] }; }

    // 8D-ext-bypair-tofu-ux Phase 2: seed the panel from an existing brand_config
    // (config-selected import path) so it opens PRE-WIRED with the config's pairings
    // AND every doc-present font shows as a node — even ones the config doesn't cover
    // — so the source-present-unpaired (tofu-risk) ones can be red-flagged. The
    // doc-font union lives in PanelAdapter.configToPanelData behind includeDocFonts
    // (single SoT, shared with importJson below + font_apply_panel.idjs — was inline
    // here only → drift, which dropped doc fonts on in-panel import). The config's
    // pairs still become wires; the doc-extra fonts arrive unwired.
    var __initialData = panelData;
    if (opts.seedConfig && PanelAdapter && typeof PanelAdapter.configToPanelData === "function") {
        try {
            var __seeded = PanelAdapter.configToPanelData(opts.seedConfig, scanResult, { includeDocFonts: true, installedFamilies: installedFamilies, probeFace: FaceMissing.gateProbeFace });
            if (__seeded) {
                __seeded.equivalence_groups = __seeded.equivalence_groups || (scanResult.equivalence_groups_auto || []).slice();
                __seeded._confirmable_merges = (scanResult.confirmable_merges || []).slice();
                __initialData = __seeded;
            }
        } catch (eSeed) { /* fall back to bare scan panelData */ }
    }

    var resolveConfig, done = false;
    var configPromise = new Promise(function (r) { resolveConfig = r; });
    // per-launcher fields only; the shared common fields (cjkLangs + scan-derived +
    // libDocScan/Adapter + initialUnresolvedByLang) are filled by FontPanelEnv.fillCommonFap
    // below — single source, consistent-by-construction with font_apply_panel.idjs.
    var fap = {
        // 🔴 Same hand-over as font_apply_panel.idjs: app.jsx only sees `window.*`,
        // so the classifier travels on __fap. Both hosts must supply it — if only one
        // did, the panel would fall back to silence on the other path.
        classifyImportOutcome: PickerOutcome.classifyImportOutcome,
        classifyExportOutcome: PickerOutcome.classifyExportOutcome,
        initialData: __initialData,
        // 8D-ext-bypair-tofu-ux Phase 2: default the panel's primary-lang dropdown to
        // the import target (config-selected path passes opts.targetLang). Detection
        // uses cjkLangs (seeded by fillCommonFap), not this — this is dropdown polish.
        primaryLang: opts.targetLang || "",
        installedFamilies: installedFamilies,
        enforcerEligibility: enforcerEligibility,
        // #41: SOURCE faces with translator italic marks (import_integrated
        // computes via lib/annot_italic_demand from the loaded translations +
        // segments and threads it here). Absent (standalone / no package) →
        // the auto-faux feature stays dark.
        italicDemandFaces: opts.italicDemand || null,
        importJson: importJson,
        exportJson: exportJson,
        // CONFIG-ONLY onDone: produce the brand_config + resolve, NO apply.
        // 8D-ext-MM step 5 (on-reject surface 1): a validate-FAIL must be
        // distinguishable from a cancel downstream — onDone resolves a wrapper
        // { config, validateErrors } so the importer can emit a non-silent
        // "invalid_rejected" NOTICE instead of silently logging "cancelled".
        // (app.jsx handleDone already gates invalid configs + keeps the panel
        // open with an inline error, so this normally only carries a valid
        // config; the validateErrors arm is defense-in-depth for any caller
        // that reaches onDone with an invalid config.)
        onDone: function (currentData /*, skipDecisions, runEnforcer */) {
            if (done) return;
            done = true;
            var cv = null;
            try { cv = PanelAdapter.panelDataToConfig(currentData); } catch (eC) {}
            try { if (typeof globalThis !== "undefined" && globalThis.__fapDialog) globalThis.__fapDialog.close(); } catch (eCl) {}
            if (cv && cv.ok) {
                resolveConfig({ config: cv.config, validateErrors: null });
            } else {
                resolveConfig({ config: null, validateErrors: (cv && cv.errors) || ["config invalid"] });
            }
        }
    };
    FontPanelEnv.fillCommonFap(fap, scanResult, app);   // cjkLangs + scan-derived common fields
    if (typeof globalThis !== "undefined") globalThis.__fap = fap;
    if (typeof window !== "undefined") window.__fap = fap;

    // ── Step 5: build <dialog> + #root + showModal ──
    var stale = document.body.querySelectorAll("dialog");
    for (var s = 0; s < stale.length; s++) { try { stale[s].close(); } catch (e) {} try { stale[s].remove(); } catch (e) {} }
    var dlg = document.createElement("dialog");
    dlg.style.padding = "0"; dlg.style.border = "0"; dlg.style.background = "transparent";
    dlg.style.maxWidth = "none"; dlg.style.maxHeight = "none";
    var fontsLink = document.createElement("link");
    fontsLink.rel = "stylesheet";
    fontsLink.href = "https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;700;900&family=Noto+Sans+JP:wght@400;500;700;900&family=Noto+Sans+TC:wght@400;700&family=Noto+Sans+KR:wght@400;700&display=swap";
    dlg.appendChild(fontsLink);
    var style = document.createElement("style");
    style.textContent = cssText + "\n.app{max-width:none !important;max-height:none !important;height:706px !important;width:1180px !important;}";
    dlg.appendChild(style);
    var bodyWrap = document.createElement("div");
    bodyWrap.style.cssText = "width:1240px;height:780px;display:flex;align-items:center;justify-content:center;padding:12px;background:radial-gradient(1200px 700px at 50% -10%,#14161c 0%,#070809 60%);box-sizing:border-box;";
    var rootDiv = document.createElement("div");
    rootDiv.id = "root";
    rootDiv.style.cssText = "width:1180px;height:706px;display:flex;align-items:center;justify-content:center;";
    bodyWrap.appendChild(rootDiv);
    dlg.appendChild(bodyWrap);
    document.body.appendChild(dlg);
    if (typeof globalThis !== "undefined") globalThis.__fapDialog = dlg;
    // Escape / chrome-close without Apply → resolve cancel (no config, no
    // validateErrors → importer logs "cancelled", NOT "invalid_rejected").
    dlg.addEventListener("close", function () { if (!done) { done = true; resolveConfig({ config: null, validateErrors: null }); } }, { once: true });
    try { dlg.showModal(); } catch (eShow) { try { dlg.remove(); } catch (e) {} return { ok: false, error: "showModal failed: " + (eShow && eShow.message || eShow) }; }

    // ── Step 6: compile + eval data.jsx / components.jsx / app.jsx ──
    function compileAndEval(filename) {
        var src = fs.readFileSync(joinAll(DEV_DIR, filename), "utf-8");
        var compiled = Babel.transform(src, { presets: ["react"] }).code;
        (0, eval)(compiled);
    }
    try {
        compileAndEval("data.jsx");
        compileAndEval("components.jsx");
        compileAndEval("app.jsx");
    } catch (eJsx) {
        try { dlg.close(); } catch (e) {} try { dlg.remove(); } catch (e) {}
        return { ok: false, error: "JSX compile/eval failed: " + (eJsx && eJsx.message || eJsx) };
    }

    // ── Step 7: let React commit ──
    await new Promise(function (resolve) { setTimeout(resolve, 400); });

    // Smoke mode (automation): verify the React app mounted, then close +
    // return WITHOUT waiting for user interaction (no host operator to click).
    if (opts.smoke) {
        var rootEl = document.getElementById("root");
        var mounted = !!(rootEl && rootEl.children && rootEl.children.length > 0);
        try { if (!done) { done = true; resolveConfig({ config: null, validateErrors: null }); } } catch (e) {}
        try { dlg.close(); } catch (e) {}
        try { dlg.remove(); } catch (e) {}
        return { ok: true, smoke: true, mounted: mounted, root_child_count: rootEl ? rootEl.children.length : 0 };
    }

    // ── Step 8: block until onDone (config|validateErrors) OR close (cancel) ──
    var res = await configPromise;
    try { dlg.remove(); } catch (e) {}
    var _cfg = res ? res.config : null;
    var _vErrs = res ? res.validateErrors : null;
    // cancelled iff no config AND no validation errors (genuine Escape/close);
    // a config==null WITH validateErrors is an invalid-rejected, not a cancel.
    return { ok: true, config: _cfg, cancelled: (_cfg == null && !(_vErrs && _vErrs.length)), validateErrors: _vErrs || null };
}

module.exports = { showFontMappingPanelForConfig: showFontMappingPanelForConfig };
