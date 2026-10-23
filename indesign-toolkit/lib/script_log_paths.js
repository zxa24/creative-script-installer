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
 *     → creates <docDir>/script_outputs/log/ by delegating to
 *     `FileUtils.ensureDirVerifiedAsync` (async fs.mkdir + lfs readback).
 *     Returns true on success / already-exists, false otherwise.
 *     🔴 "Returns true" means the directory was RE-RESOLVED and is a folder —
 *     not merely that mkdir resolved (#26/#67 family).
 *     opts.lfs — per-call test seam, forwarded to ensureDirVerifiedAsync.
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
 * Why a separate lib instead of inline-each-script: UXP's fs surface is
 * missing most sync forms (`mkdirSync` / `statSync` / `readdirSync` are all
 * `undefined` — measured on host 2026-09-10), so directory work has to go
 * through async `fs.mkdir` + `uxp.storage.localFileSystem`. Sharing that
 * boilerplate keeps each entry script free of UXP-specific folder mechanics.
 * 🪦 This header used to say the two-level mkdir "has to go through
 * lfs.getEntryWithUrl + parent.createFolder". That was true when it was
 * written and is no longer: async `fs.mkdir({recursive:true})` works on this
 * host (lib/file_utils.js:118-121, 2026-08-28; re-measured end-to-end by
 * probes/20260910_03_logdir_ensure.idjs). The hand-rolled two-level dance was
 * removed so this concept has ONE implementation, not two (#27).
 */

var RuntimePaths;
try { RuntimePaths = require("./runtime_paths.js"); } catch (e) { RuntimePaths = null; }
// 目录创建 + 回读确认的唯一口径（见 ensureLogDirAsync 里那段说明）。
// ⚠ 无循环：file_utils 只 require fs + ./utils.js。
var FileUtils;
try { FileUtils = require("./file_utils.js"); } catch (eFU) { FileUtils = null; }

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
    var logDir = resolveLogDir(docDir);
    /* ── 🔴 2026-09-10：这里过去用 `fs.statSync` 判存在，而 UXP 的 fs 里
       **`statSync` 根本不存在**（本机实测 `typeof fs.statSync === "undefined"`，
       同 `mkdirSync`；CLAUDE.md `#26`）⇒ 那两处 `try { fs.statSync(...) }` **恒抛**：
         · 第一处（快路径）：`existed` 恒 false ⇒ 那行**从未起过作用**（死代码，无害）
         · 🔴 第二处（`createFolder("log")` 抛错后的恢复分支）：**不是**死代码 ——
           目录【确实存在】时它也判不出来 ⇒ `existed` 仍 false ⇒ **整个函数返回 false**，
           把一次成功谎报成失败。
       ⚠ 讽刺的是本模块自己在下方 `purgeOldLogsAsync` 的注释里就写着
       「UXP 里 `fs.statSync` / `fs.readdirSync` 是 undefined」—— **知识在文件里，
       离误用只有五十行**。这正是「同一个概念有两个真相来源」的形状（`#27`）。

       ⇒ 收口到**已在宿主上实测过**的那一个口径：`FileUtils.ensureDirVerifiedAsync`
       （async `fs.mkdir({recursive})` 建 + `lfs.getEntryWithUrl` 回读确认是文件夹）。
       宿主读数：`probes/20260910_03_logdir_ensure.idjs` 的腿 B —— 它**两级都缺**时
       建出来、写入成功、回读逐字相同；腿 A（不 ensure 直接写）抛
       *no such file or directory*，所以排除得掉「目录本来就在」。
       ⚠ 原先那套「从 docFolder 逐级 createFolder」是**更早的 workaround**，写在
       「async fs.mkdir 可用」这件事被测出来之前（`lib/file_utils.js:118-121`，2026-08-28）。
       删它不是图省事，是**消掉第二个真相来源**。
       ⚠ `opts.lfs` 是**逐次调用**的测试缝（不能用模块级全局：非宿主套件并发跑
       async 检查，共享全局会跨 await 互相踩 —— file_utils.js:142-146 实测过）。 */
    if (!FileUtils || typeof FileUtils.ensureDirVerifiedAsync !== "function") return false;
    var ok = false;
    try {
        var r = await FileUtils.ensureDirVerifiedAsync(
            logDir, (opts && opts.lfs) ? { lfs: opts.lfs } : undefined);
        ok = !!(r && r.ok);
    } catch (eEnsure) { ok = false; }
    if (!ok) return false;
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

// ── repair output: one set of files per run, the latest N runs kept (arch 2026-10-03) ──
//
// repair_after_apply writes `repair_after_apply_output_<YYYYMMDD_HHMMSS>.txt` plus, with
// the same prefix, its acceptance bundle (summary / watch-pages json, page png). One set
// per run, so that the per-frame lines of an earlier import are still there when someone
// asks why a frame grew — which also means the folder only ever grows. A RUN is the unit:
// every file carrying a purged run's stamp goes, whatever its suffix. Files without a
// stamp (the old fixed name and its bundle, anything else in the folder) are not touched.
var REPAIR_RUN_RE = /^repair_after_apply_output_(\d{8}_\d{6})(?:[._]|$)/;
var REPAIR_RUNS_KEPT = 20;

// Pure. names: file names in the log folder. -> { keepStamps, purge: [name] }
function selectRepairRunsToPurge(names, keep) {
    var n = (typeof keep === "number" && keep >= 0) ? keep : REPAIR_RUNS_KEPT;
    var byStamp = {};
    (names || []).forEach(function (name) {
        var m = REPAIR_RUN_RE.exec(String(name));
        if (!m) return;
        (byStamp[m[1]] = byStamp[m[1]] || []).push(String(name));
    });
    var stamps = Object.keys(byStamp).sort().reverse();   // the stamp sorts as text = by time
    var purge = [];
    stamps.slice(n).forEach(function (st) { purge = purge.concat(byStamp[st]); });
    return { keepStamps: stamps.slice(0, n), purge: purge };
}

// Host (UXP storage API: no sync readdir / unlink there). Never throws.
async function purgeOldRepairRunsAsync(logDir, keep) {
    var res = { ok: false, runsKept: 0, purged: 0, failed: 0, reason: "" };
    try {
        var lfs = require("uxp").storage.localFileSystem;
        var folder = await lfs.getEntryWithUrl("file:///" + String(logDir).replace(/\\/g, "/").replace(/^\/+/, ""));
        if (!folder || !folder.isFolder) { res.reason = "not a folder"; return res; }
        var entries = await folder.getEntries(), byName = {};
        entries.forEach(function (e) { if (e && e.isFile) byName[e.name] = e; });
        var sel = selectRepairRunsToPurge(Object.keys(byName), keep);
        res.runsKept = sel.keepStamps.length;
        for (var i = 0; i < sel.purge.length; i++) {
            try { await byName[sel.purge[i]].delete(); res.purged++; } catch (eD) { res.failed++; }
        }
        res.ok = true;
    } catch (e) { res.reason = String(e && e.message ? e.message : e); }
    return res;
}

module.exports = {
    compactTimestamp: compactTimestamp,
    resolveLogDir: resolveLogDir,
    resolveLogPath: resolveLogPath,
    ensureLogDirAsync: ensureLogDirAsync,
    purgeOldLogsAsync: purgeOldLogsAsync,
    selectRepairRunsToPurge: selectRepairRunsToPurge,
    purgeOldRepairRunsAsync: purgeOldRepairRunsAsync,
    REPAIR_RUNS_KEPT: REPAIR_RUNS_KEPT
};
