"use strict";

/**
 * lib/font_panel_env.js — single source of the font-mapping panel's shared bootstrap ENV.
 *
 * The font-mapping React app (dev/font_apply_panel/{data,components,app}.jsx) is mounted by
 * TWO launchers:
 *   - font_apply_panel.idjs            (standalone — applies the mapping to the active doc)
 *   - lib/font_mapping_panel_ui.js     (config-only re-host — used by import_integrated)
 * Each previously built its OWN window-globals + its OWN `fap` object → any field/global
 * one set and the other missed = a SILENT UX divergence. This actually happened twice:
 * `window.WireHitTest` (wire-click-delete) and `fap.cjkLangs` were present standalone but
 * absent in the import-hosted panel. (`cjkLangs` no longer drives an "+Italic affordance" —
 * that #17 button was cut with the Y-model; today it gates the tofu red-flag / CJK target
 * columns, and feeds the italic winner rule's CJK-vs-Latin test.) Patching each as found is
 * whack-a-mole. This module makes the divergence surface CONSISTENT BY CONSTRUCTION: both
 * launchers call installGlobals() + fillCommonFap(). The only per-launcher differences left
 * are genuinely different: `onDone` (apply vs config-only), `initialData`/`installedFamilies`
 * (built from each launcher's own scan), and `importJson`/`exportJson` (lfs-bound closures).
 * (The <dialog>/CSS/compileAndEval blocks are byte-identical in both launchers — a separate,
 * non-divergent duplication.)
 *
 * Babel is intentionally NOT installed here: it is a LOCAL var each launcher uses for its own
 * compileAndEval (it is not a window-global the React app reads).
 */

var DocScan = require("./font_mapping_doc_scan.js");
var PanelAdapter = require("./font_mapping_panel_adapter.js");
var Enforcer = require("./script_font_enforcer.js");
var CjkSweep = require("./byPair_char_sweep.js");
var ItalicKeys = require("./italic_variant_keys.js");
var IdentityGroups = require("./font_identity_groups.js");

// Install the window/globalThis globals the React app reads: React, ReactDOM, CanvasPan
// (canvas pan), WireHitTest (geometric wire-click hit-test → delete-pairing on click; UXP
// ignores pointer-events:stroke so this is required, not optional). Tolerant per-module so a
// missing optional vendor file degrades gracefully. Returns a summary for the caller's log.
// @bundle-include ./vendor/react.production.min.js
// @bundle-include ./vendor/react-dom.patched.umd.js
// @bundle-include ./canvas_pan.js
// @bundle-include ./wire_hit_test.js
//
// The four requires below go through tryReq(p), where the spec is a FUNCTION
// PARAMETER. The bundler's static analysis only sees literal require("…") and
// `var IDENT = "literal"` (bundle_uxp.js:89-97), so it never saw these — they
// were left out of the bundle, fell through to UXP's native require at runtime,
// and died as `Module not found` → the panel's JSX eval then reported the far
// less helpful "React is not defined". The directives above are the documented
// escape hatch for exactly this case.
//
// This does NOT make the panel automatable — it is still a modal dialog waiting
// for a human. What it buys: the panel can MOUNT under the bridge, so it can be
// smoke-tested at all, and the next failure here reports its real cause.
function installGlobals() {
    var out = {};
    var targets = [];
    if (typeof globalThis !== "undefined") targets.push(globalThis);
    if (typeof window !== "undefined" && (typeof globalThis === "undefined" || window !== globalThis)) targets.push(window);
    function set(name, mod) { for (var i = 0; i < targets.length; i++) targets[i][name] = mod; }
    function tryReq(p) { try { return require(p); } catch (e) { return null; } }

    var React = tryReq("./vendor/react.production.min.js");
    if (React) { set("React", React); out.react = React.version; }
    var ReactDOM = tryReq("./vendor/react-dom.patched.umd.js");
    if (ReactDOM) { set("ReactDOM", ReactDOM); out.reactDom = ReactDOM.version; }
    var CanvasPan = tryReq("./canvas_pan.js");
    if (CanvasPan) { set("CanvasPan", CanvasPan); out.canvasPan = !!(CanvasPan && typeof CanvasPan.attachPan === "function"); }
    var WireHitTest = tryReq("./wire_hit_test.js");
    if (WireHitTest) { set("WireHitTest", WireHitTest); out.wireHitTest = !!(WireHitTest && typeof WireHitTest.wireHitTest === "function"); }
    // TODO#82 — edge auto-pan arithmetic. app.jsx reads it as `window.EdgeAutoPan`
    // and skips the assist when it is absent, so a missing global would make the
    // feature do NOTHING and report nothing. The readout below is what makes that
    // visible: `out.edgeAutoPan === false` says the panel booted without it.
    var EdgeAutoPan = tryReq("./edge_autopan.js");
    if (EdgeAutoPan) { set("EdgeAutoPan", EdgeAutoPan); }
    out.edgeAutoPan = !!(EdgeAutoPan && typeof EdgeAutoPan.edgeAutoPanDelta === "function");
    return out;
}

// Bind the pipeline's installed-name resolver to the live document, for the italic winner
// key (univ-italic contract K · r3 note). `_writeStyleFontNormalized` rewrites a font's
// spelling at style-write time when the font IS installed under a different name
// ("Whitney"+"Book" → installed "Whitney Book"+"Regular"), so a key stored under the config
// spelling reads as unconfigured at apply time. italic_variant_keys.js stays pure and takes
// this as an injected (family, style) → {family, fontStyle}|null.
//
// Returns null — NOT a throwing stub — whenever the probe cannot run (no document, module or
// _internal export absent). resolveWinner then keeps the names as given, which is the
// pre-existing behaviour: a panel opened without a document must still work.
// Lazy require: style_sheet_builder is host-side and NOT otherwise in the config-only
// re-host's module graph; a resolve failure here must degrade, not break panel bootstrap.
function _makeInstalledFontResolver(app) {
    var workDoc = null;
    try { workDoc = app && app.activeDocument; } catch (e) { workDoc = null; }
    if (!workDoc) return null;
    var SSB = null;
    try { SSB = require("./style_sheet_builder.js"); } catch (e2) { SSB = null; }
    var fn = SSB && SSB._internal && SSB._internal._resolveInstalledFontName;
    if (typeof fn !== "function") return null;
    // MEMOIZED. _resolveInstalledFontName issues up to ~8 uncached
    // `fonts.itemByName` host calls per lookup (style_sheet_builder.js:2089 has no
    // memo of its own), and the panel calls this once per visible weight node on
    // every render — including every pointermove of an angle drag. Uncached that is
    // N-nodes x probes x frames of host round-trips inside a UXP webview. The answer
    // is constant for a given document, so one map keyed by family+TAB+style is both
    // safe and sufficient. Null results are cached too: "not installed under this
    // spelling" is just as stable, and re-probing it every frame is the same cost.
    var memo = {};
    return function (family, style) {
        var k = String(family) + "\t" + String(style);
        if (Object.prototype.hasOwnProperty.call(memo, k)) return memo[k];
        var r = null;
        try { r = fn(workDoc, family, style); } catch (e3) { r = null; }
        memo[k] = r;
        return r;
    };
}

// Bind the WEIGHT-EXACT italic probe to the live document (contract R / OQ-2).
// findExactItalicStyleName answers "does this family have THIS weight's own italic
// face" — not the family-level question, which is what let a Book `real` silently
// borrow Bold Italic. Returns a (family, weight) → bool; null when the probe cannot
// run, so callers can tell "no italic" apart from "could not ask" and stay quiet
// rather than warn wrongly.
//
// Memoized for the same reason as the installed-name resolver: the D2b hint asks
// per copy node per render, and itemByName is a host round-trip.
function _makeExactItalicProbe(app) {
    var workDoc = null;
    try { workDoc = app && app.activeDocument; } catch (e) { workDoc = null; }
    if (!workDoc) return null;
    var FIP = null;
    try { FIP = require("./font_italic_probe.js"); } catch (e2) { FIP = null; }
    if (!FIP || typeof FIP.findExactItalicStyleName !== "function") return null;
    var memo = {};
    return function (family, weight) {
        var k = String(family) + "\t" + String(weight);
        if (Object.prototype.hasOwnProperty.call(memo, k)) return memo[k];
        var face = null;
        try { face = FIP.findExactItalicStyleName(workDoc, family, weight); } catch (e3) { face = null; }
        memo[k] = face || null;
        return memo[k];
    };
}

// TODO#58 (1): face IDENTITY lookup, host-side — `(family, style)` STRINGS in,
// the font engine's own answer out. This is the injected `identityOf` that
// font_identity_groups.js needs.
//
// 🔴 It MOVED to font_mapping_doc_scan.makeIdentityLookup and is delegated to
// here rather than reimplemented, because the SCAN grades identity too. Two
// copies of this predicate would be two answers to "are these the same face",
// and they would diverge silently — which is the exact failure this module was
// created to stop (window.WireHitTest, fap.cjkLangs).
// The measured accessor rules (itemByName not a TSR Font ref; status read
// first; every property in its own try/catch; never enumerate app.fonts) are
// documented at the definition.
// Fill the COMMON fap fields onto `fap` from scanResult. The caller sets the per-launcher
// fields BEFORE calling: initialData, installedFamilies, onDone, importJson, exportJson
// (and may pre-set enforcerEligibility; otherwise it is computed from `app` here). Returns fap.
function fillCommonFap(fap, scanResult, app) {
    fap = fap || {};
    scanResult = scanResult || {};
    fap.cjkLangs = (CjkSweep && CjkSweep.CJK_LANG_SET) || {};
    fap.confirmableMerges = (scanResult.confirmable_merges || []).slice();
    // 🪦 `fap.recombinationCandidates` REMOVED (TODO#58, 2026-08-20). It carried the
    // A.1 name-heuristic candidates that the panel auto-merged on sight. The panel
    // now builds its own groups from face identity via `fap.fontIdentity`; keeping
    // this field would have left a second, name-based answer inside the same object.
    // TODO#58 (5): the scan's own three skip counters travel with it.
    fap.identityReadout = scanResult.identity_readout || null;
    fap.documentFonts = (scanResult.documentFonts || []).slice();
    fap.byFamilyHomeLang = scanResult.byFamilyHomeLang || {};
    fap.scanTsrMap = (scanResult.tsrMap || []).slice();
    if (!fap.initialUnresolvedByLang) fap.initialUnresolvedByLang = {};
    fap.libDocScan = DocScan;
    fap.libPanelAdapter = PanelAdapter;
    // univ-italic §7.4 ②: contract-K winner-key derivation for the italic copy
    // editor. Injected HERE rather than per launcher for the reason this module
    // exists — the React app must not silently lose the editor in one of the two
    // hosts (exactly how cjkLangs / WireHitTest diverged before).
    fap.libItalicKeys = ItalicKeys;
    // TODO#58: the deterministic identity grouper + its (5) readout helpers. Same
    // reason it is injected HERE and not required per launcher: the panel's merge
    // criterion must be one function in both hosts, not two that can drift.
    fap.libIdentityGroups = IdentityGroups;
    // univ-italic §7.4: ONE weight-exact italic probe, shared by the D2b capability
    // hint on a copy node and the Done gate that refuses to close on a `real` the
    // font cannot honour (OQ-2, panel layer). Same question both times — "does this
    // family have this weight's EXACT italic face" — so it must be one answer, not
    // a hint that can disagree with the gate that blocks on it.
    fap.hasExactItalic = _makeExactItalicProbe(app);
    // …and the doc-bound installed-name resolver the winner key must go through.
    // Same reason it lives HERE: wired per launcher, one of the two hosts would
    // eventually miss it and its keys would silently drift from the other's.
    if (!fap.resolveInstalledFont) fap.resolveInstalledFont = _makeInstalledFontResolver(app);
    if (!fap.fontIdentity) fap.fontIdentity = DocScan.makeIdentityLookup(app);
    if (!fap.enforcerEligibility) {
        try { fap.enforcerEligibility = Enforcer.detectEnforcerEligibility(app && app.activeDocument); }
        catch (e) { fap.enforcerEligibility = { eligible: false, reasons: ["eligibility check threw: " + (e && e.message || e)] }; }
    }
    return fap;
}

module.exports = { installGlobals: installGlobals, fillCommonFap: fillCommonFap };
