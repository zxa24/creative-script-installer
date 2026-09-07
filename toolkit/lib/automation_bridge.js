"use strict";

// lib/automation_bridge.js — universal "skip-the-dialog" channel for
// MCP-driven runs of dialog-bearing scripts.
//
// THE PROBLEM: an InDesign DOM dialog blocks the host's main thread.
// The bridge UXP plugin runs *inside* InDesign, so while the dialog
// waits for a user click the plugin can't service any HTTP request.
// Every MCP call queues, then times out (TIMEOUT_MS in bridge/server.js).
//
// THE FIX: let the MCP caller pre-inject the would-be dialog answer.
// Each dialog-bearing script's entry consults this module BEFORE
// constructing the dialog. If a payload is present, use it and skip
// the dialog entirely; otherwise fall through to the manual UI.
//
// CHANNELS (async fallback ladder):
//   (1) app.scriptArgs.getValue(<scriptId>+":opts")
//       — host-native fast path, no FS hit. *** Caveat: scriptArgs
//       set by the bridge's prepended `setValue` runs INSIDE the
//       outer doScript, but the bundle's entry .idjs runs in an
//       AsyncFunction IIFE that resumes on the event loop AFTER
//       doScript returns. InDesign empirically clears scriptArgs at
//       the doScript boundary, so this fast path almost always
//       returns null in practice. Kept as a graceful upgrade path
//       for hosts where scriptArgs survives. ***
//
//   (2) <PluginData>/__auto_<scriptId>.json
//       — written by the bridge via Node fs BEFORE kickoff; read
//       here via `uxp.storage.localFileSystem.getDataFolder()` which
//       resolves to the SAME PluginsStorage folder (bundle_uxp.js
//       writes __bundle_result.json the same way; both ends agree).
//       Async (getEntry / read) so this whole helper is async.
//
// Both channels are CONSUME-ONCE: read clears/deletes so a subsequent
// manual run from Scripts Panel doesn't accidentally inherit a stale
// preseed. Malformed JSON throws (caller plogs + falls through to
// dialog) — silent fallback masks caller bugs.
//
// Entry-point usage (note `await`):
//   var auto = await AutomationBridge.readAutomationOptions("reorganize_styles_inplace");
//   var opts = auto || showGroupingDialog({ interactive: true });
//   if (!opts) return;
//   runCore(opts);

// Module-scoped set of scriptIds that successfully consumed an
// automation payload during this session. Used by isAutomatedRun()
// so other parts of the script (e.g. trailing showAlert) can see
// "we're being driven headlessly, do NOT block on DOM dialogs."
//
// This is per-process state. In bridge-driven runs, the bundle is
// rebuilt and re-loaded for every /run-uxp-script call, so the set
// starts empty each time — no cross-run contamination. In a long-
// lived plugin context the flag persists, which is the correct
// semantics: once a run is "automated", every subsequent dialog in
// THAT run should also be suppressed.
var _consumedScripts = {};

function _scriptArgsGet(name) {
    try {
        if (typeof app === "undefined" || !app || !app.scriptArgs) { return null; }
        var v = app.scriptArgs.getValue(name);
        if (v === undefined || v === null) { return null; }
        var s = String(v);
        return s.length ? s : null;
    } catch (e) { return null; }
}

function _scriptArgsClear(name) {
    try {
        if (typeof app === "undefined" || !app || !app.scriptArgs) { return; }
        app.scriptArgs.setValue(name, "");
    } catch (e) {}
}

async function _readPluginDataFile(scriptId) {
    var lfs = null;
    try { lfs = require("uxp").storage.localFileSystem; }
    catch (eUXP) { return null; }   // not in UXP host (test harness, etc.)
    if (!lfs || typeof lfs.getDataFolder !== "function") { return null; }

    var dataFolder, entry, raw;
    try { dataFolder = await lfs.getDataFolder(); }
    catch (eDF) { return null; }
    if (!dataFolder) { return null; }

    var fileName = "__auto_" + scriptId + ".json";
    try { entry = await dataFolder.getEntry(fileName); }
    catch (eGE) { return null; }    // ENOENT — no preseed
    if (!entry) { return null; }

    try { raw = await entry.read(); }
    catch (eR) { return null; }     // read failed — same as no preseed

    // consume-once: best-effort delete so a subsequent manual run from
    // Scripts Panel doesn't pick up the stale payload
    try { await entry.delete(); } catch (eD) { /* swallow */ }

    return raw && raw.length ? String(raw) : null;
}

/**
 * Read pre-injected automation options for a script. Async because the
 * fallback channel uses the UXP localFileSystem (await getDataFolder /
 * getEntry / read).
 *
 * @param {string} scriptId  Stable identifier (e.g. "reorganize_styles_inplace").
 * @param {Object} [deps]    Optional injection of `scriptArgsGet`,
 *                           `scriptArgsClear`, `readPluginDataFile` (used by
 *                           non-host tests to mock both channels).
 * @returns {Object|null}    Parsed options object with metadata stamps
 *                           `__automation_source` + `__automation_scriptId`,
 *                           or null if no preseed is pending.
 * @throws  {Error}          If a preseed is present but JSON parse fails.
 */
async function readAutomationOptions(scriptId, deps) {
    if (!scriptId) { return null; }
    var key = scriptId + ":opts";
    var get = (deps && deps.scriptArgsGet) || _scriptArgsGet;
    var clear = (deps && deps.scriptArgsClear) || _scriptArgsClear;
    var readFile = (deps && deps.readPluginDataFile) || _readPluginDataFile;

    // Channel 1 — scriptArgs (fast path; rarely populated in practice)
    var raw = get(key);
    var source = null;
    if (raw) { source = "scriptArgs"; clear(key); }

    // Channel 2 — PluginData fallback file (the channel that actually
    // works across the doScript boundary)
    if (!raw) {
        try { raw = await readFile(scriptId); }
        catch (eF) { raw = null; }   // read errors are non-fatal — same as absent
        if (raw) { source = "pluginDataFile"; }
    }

    if (!raw) { return null; }

    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (eP) {
        throw new Error("AutomationBridge: malformed JSON for scriptId=" + scriptId
            + " (source=" + source + "): " + (eP && eP.message ? eP.message : eP));
    }
    if (parsed && typeof parsed === "object") {
        parsed.__automation_source = source;
        parsed.__automation_scriptId = scriptId;
    }
    // Mark this scriptId as automated for the rest of the run, so
    // isAutomatedRun(scriptId) returns true and downstream alert /
    // dialog code can route to recordAutomationResult instead of
    // blocking on a DOM dialog (which would deadlock the bridge).
    _consumedScripts[scriptId] = true;
    return parsed;
}

/**
 * Synchronous boolean: was an automation payload consumed for this
 * scriptId during this run? Wrap any showAlert / progressDialog /
 * confirm() call site with this so the same script supports BOTH
 * manual and headless paths without restructuring control flow.
 */
function isAutomatedRun(scriptId) {
    if (!scriptId) { return false; }
    return !!_consumedScripts[scriptId];
}

/**
 * Reset the consumed flag (rare — useful only for tests that simulate
 * multiple runs in one process).
 */
function _resetConsumedFlag(scriptId) {
    if (scriptId) { delete _consumedScripts[scriptId]; }
    else { _consumedScripts = {}; }
}

/**
 * Async — write a result payload to <PluginData>/__auto_result_<scriptId>.json
 * for the bridge to pick up. Use this in place of a final showAlert
 * when isAutomatedRun(scriptId) is true. The payload should mirror
 * the alert text (summary, stats, error info, etc.) so the operator
 * gets the same information they would have seen in the dialog.
 *
 * Returns true on success, false otherwise (caller should plog the
 * failure but NOT fall back to a DOM dialog — that would deadlock).
 */
async function recordAutomationResult(scriptId, payload) {
    if (!scriptId) { return false; }
    var lfs = null;
    try { lfs = require("uxp").storage.localFileSystem; }
    catch (eUXP) { return false; }
    if (!lfs || typeof lfs.getDataFolder !== "function") { return false; }
    try {
        var df = await lfs.getDataFolder();
        var f = await df.createFile("__auto_result_" + scriptId + ".json", { overwrite: true });
        await f.write(JSON.stringify(payload, null, 2));
        return true;
    } catch (e) { return false; }
}

/**
 * Non-consuming probe: report whether a payload is pending without
 * reading/clearing it. Useful for plog preambles ("ran headless" vs
 * "showed dialog") — async to allow the file-channel statSync.
 */
async function peekAutomationOptions(scriptId, deps) {
    if (!scriptId) { return { present: false, channel: null }; }
    var get = (deps && deps.scriptArgsGet) || _scriptArgsGet;
    var v = get(scriptId + ":opts");
    if (v) { return { present: true, channel: "scriptArgs" }; }
    var lfs = null;
    try { lfs = require("uxp").storage.localFileSystem; } catch (e) {}
    if (lfs && typeof lfs.getDataFolder === "function") {
        try {
            var df = await lfs.getDataFolder();
            var entry = await df.getEntry("__auto_" + scriptId + ".json");
            if (entry) { return { present: true, channel: "pluginDataFile" }; }
        } catch (e) {}
    }
    return { present: false, channel: null };
}

module.exports = {
    readAutomationOptions: readAutomationOptions,
    peekAutomationOptions: peekAutomationOptions,
    isAutomatedRun: isAutomatedRun,
    recordAutomationResult: recordAutomationResult,
    _resetConsumedFlag: _resetConsumedFlag
};
