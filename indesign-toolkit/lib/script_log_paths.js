"use strict";

/**
 * lib/script_log_paths.js
 *
 * Resolves log-file paths under the unified `<docDir>/script_outputs/log/`
 * convention so every toolkit operator script writes logs into one place.
 *
 * Public API:
 *   resolveLogPath(docDir, scriptName, ext?)
 *     → <docDir>/script_outputs/log/<scriptName>_<YYYYMMDD_HHMMSS>.<ext|"log">
 *     Falls back to <tempDir>/<scriptName>_<ts>.<ext> when docDir is empty.
 *
 *   ensureLogDirAsync(docDir, opts?)
 *     → creates <docDir>/script_outputs/log/ via UXP lfs (two-level mkdir).
 *     Returns true on success / already-exists, false otherwise.
 *     opts.purgeOldLogs (optional retention object): when set, after the
 *     dir is ensured, runs `purgeOldLogsAsync(logDir, opts.purgeOldLogs)`
 *     so probe scripts can opt into automatic cleanup on every run.
 *
 *   purgeOldLogsAsync(logDir, opts?)
 *     → sweeps `logDir`, deletes files whose mtime is older than
 *     `retentionDays` (default 14) OR whose size exceeds `sizeCapBytes`
 *     (default 5 MB). Returns { ok, purged, kept, bytesFreed, dryRun }.
 *     Pass `dryRun: true` to count without deleting. Pass `prefixFilter`
 *     to limit which filenames are eligible (e.g. only `"probe_"`).
 *
 *   compactTimestamp() → "20260528_135022"
 *
 * Why a separate lib instead of inline-each-script: UXP `fs.mkdirSync` is
 * absent (see CLAUDE.md UXP-quirks), so the two-level mkdir has to go
 * through lfs.getEntryWithUrl + parent.createFolder, with idempotent
 * already-exists handling. Sharing that boilerplate keeps each entry script
 * free of UXP-specific folder mechanics.
 */

var RuntimePaths;
try { RuntimePaths = require("./runtime_paths.js"); } catch (e) { RuntimePaths = null; }

function compactTimestamp() {
    var d = new Date();
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
        + "_" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

function _sepOf(p) {
    return (p && p.indexOf("\\") >= 0) ? "\\" : "/";
}

function _tempDir() {
    if (RuntimePaths && typeof RuntimePaths.getTempDir === "function") {
        try { return RuntimePaths.getTempDir(); } catch (e) {}
    }
    return "C:\\temp";
}

// Returns the directory where logs SHOULD live. When docDir is empty
// (untitled doc), falls back to the system temp dir so the caller can
// still write something.
function resolveLogDir(docDir) {
    if (!docDir) return _tempDir();
    var sep = _sepOf(docDir);
    return docDir + sep + "script_outputs" + sep + "log";
}

function resolveLogPath(docDir, scriptName, ext) {
    var dir = resolveLogDir(docDir);
    var sep = _sepOf(dir);
    var ts = compactTimestamp();
    var fileExt = ext || "log";
    if (fileExt.charAt(0) === ".") fileExt = fileExt.substring(1);
    return dir + sep + String(scriptName || "script") + "_" + ts + "." + fileExt;
}

// UXP two-level mkdir for <docDir>/script_outputs/log/. Idempotent.
// Returns true if the dir exists after the call. When docDir is empty
// (temp-dir fallback path), returns true without creating anything —
// system temp dir always exists.
//
// opts.purgeOldLogs (optional): retention spec passed to
// purgeOldLogsAsync after the dir exists. Failure to purge does NOT
// fail the ensure step — log writes still work.
async function ensureLogDirAsync(docDir, opts) {
    if (!docDir) {
        // Even in temp-fallback mode honor opts.purgeOldLogs against the
        // temp dir, since callers running on untitled docs still want
        // their probe logs in that dir cleaned up.
        if (opts && opts.purgeOldLogs) {
            try { await purgeOldLogsAsync(_tempDir(), opts.purgeOldLogs); } catch (e) {}
        }
        return true;
    }
    var fs = require("fs");
    var logDir = resolveLogDir(docDir);
    var existed = false;
    try { fs.statSync(logDir); existed = true; } catch (e) {}
    if (!existed) {
        try {
            var uxp = require("uxp");
            var lfs = uxp && uxp.storage && uxp.storage.localFileSystem;
            if (!lfs) return false;
            var docUrl = "file:///" + docDir.replace(/\\/g, "/").replace(/^\/+/, "");
            var docFolder = await lfs.getEntryWithUrl(docUrl);
            if (!docFolder) return false;
            // Step 1: script_outputs/
            var soFolder = null;
            try { soFolder = await docFolder.getEntry("script_outputs"); } catch (e1) { soFolder = null; }
            if (!soFolder) {
                try { soFolder = await docFolder.createFolder("script_outputs"); }
                catch (eC1) {
                    try { soFolder = await docFolder.getEntry("script_outputs"); } catch (e2) {}
                    if (!soFolder) return false;
                }
            }
            // Step 2: log/
            var logFolder = null;
            try { logFolder = await soFolder.getEntry("log"); } catch (e3) { logFolder = null; }
            if (!logFolder) {
                try { await soFolder.createFolder("log"); }
                catch (eC2) {
                    try { fs.statSync(logDir); existed = true; } catch (e4) {}
                    if (!existed) return false;
                }
            }
        } catch (eM) { return false; }
    }
    // Optional retention sweep after ensuring dir exists. Failure here
    // is best-effort — don't fail the ensure step.
    if (opts && opts.purgeOldLogs) {
        try { await purgeOldLogsAsync(logDir, opts.purgeOldLogs); } catch (e) {}
    }
    return true;
}

// Sweep `logDir` and delete files older than retentionDays OR larger
// than sizeCapBytes. Both rules together — either triggers purge.
// Returns { ok, purged, kept, bytesFreed, dryRun, reason? }.
//
// Defaults: 14 days, 5 MB. Pass `prefixFilter` (string) to limit which
// filenames are eligible (matches at start of name). Pass `dryRun: true`
// to enumerate without deleting.
//
// Designed to be called from any toolkit script: standalone (e.g. the
// purge_old_logs.idjs entry script) or via ensureLogDirAsync(..., {
// purgeOldLogs: { retentionDays: 7 } }) at probe start. Safe on
// non-existent dirs (returns ok:false with reason, doesn't throw).
//
// UXP NOTE: this runs in UXP plugin context where `fs.statSync` and
// `fs.readdirSync` are undefined (see findings.md style-and-font ·
// "UXP fs surface" — only readFile/readFileSync/writeFile/
// writeFileSync are present sync-form). All directory + delete ops
// here go through `uxp.storage.localFileSystem` async API instead.
async function purgeOldLogsAsync(logDir, opts) {
    opts = opts || {};
    var retentionDays = Number(opts.retentionDays) > 0 ? Number(opts.retentionDays) : 14;
    var sizeCapBytes = Number(opts.sizeCapBytes) > 0 ? Number(opts.sizeCapBytes) : (5 * 1024 * 1024);
    var dryRun = opts.dryRun === true;
    var prefixFilter = (typeof opts.prefixFilter === "string" && opts.prefixFilter) ? opts.prefixFilter : null;

    var uxp;
    try { uxp = require("uxp"); } catch (eU) {
        return { ok: false, reason: "uxp module not available: " + (eU.message || String(eU)), purged: 0, kept: 0, bytesFreed: 0, dryRun: dryRun };
    }
    var lfs = uxp && uxp.storage && uxp.storage.localFileSystem;
    if (!lfs) {
        return { ok: false, reason: "uxp.storage.localFileSystem not available", purged: 0, kept: 0, bytesFreed: 0, dryRun: dryRun };
    }

    var folder;
    try {
        var dirUrl = "file:///" + logDir.replace(/\\/g, "/").replace(/^\/+/, "");
        folder = await lfs.getEntryWithUrl(dirUrl);
    } catch (e) {
        return { ok: false, reason: "dir not found: " + (e.message || String(e)), purged: 0, kept: 0, bytesFreed: 0, dryRun: dryRun };
    }
    if (!folder || !folder.isFolder) {
        return { ok: false, reason: "not a folder", purged: 0, kept: 0, bytesFreed: 0, dryRun: dryRun };
    }

    var entries;
    try { entries = await folder.getEntries(); }
    catch (e2) { return { ok: false, reason: "getEntries failed: " + (e2.message || String(e2)), purged: 0, kept: 0, bytesFreed: 0, dryRun: dryRun }; }

    var cutoffMs = Date.now() - retentionDays * 86400 * 1000;
    var purged = 0;
    var kept = 0;
    var bytesFreed = 0;
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isFile) { kept++; continue; }
        var name = e.name;
        if (prefixFilter && name.indexOf(prefixFilter) !== 0) { kept++; continue; }
        var meta;
        try { meta = await e.getMetadata(); } catch (e3) { continue; }
        // meta.size is bytes (Number); meta.dateModified is Date
        var sizeBytes = Number(meta && meta.size) || 0;
        var mtimeMs = (meta && meta.dateModified) ? meta.dateModified.getTime() : Date.now();
        var shouldPurge = (mtimeMs < cutoffMs) || (sizeBytes > sizeCapBytes);
        if (!shouldPurge) { kept++; continue; }
        if (dryRun) {
            purged++;
            bytesFreed += sizeBytes;
            continue;
        }
        try {
            await e.delete();
            purged++;
            bytesFreed += sizeBytes;
        } catch (e4) { /* benign — keep going */ }
    }

    return { ok: true, purged: purged, kept: kept, bytesFreed: bytesFreed, dryRun: dryRun };
}

module.exports = {
    compactTimestamp: compactTimestamp,
    resolveLogDir: resolveLogDir,
    resolveLogPath: resolveLogPath,
    ensureLogDirAsync: ensureLogDirAsync,
    purgeOldLogsAsync: purgeOldLogsAsync
};
