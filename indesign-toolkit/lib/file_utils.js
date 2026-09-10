"use strict";

// lib/file_utils.js — Shared file I/O and path utilities

var fs = require("fs");
var utils = require("./utils.js");
var safe = utils.safe;

var lastFileUtilsError = null;

function clearLastFileUtilsError() {
    lastFileUtilsError = null;
}

function captureFileUtilsError(operation, pathValue, error, extra) {
    lastFileUtilsError = {
        operation: safe(operation),
        path: safe(pathValue),
        code: error && error.code ? safe(error.code) : "",
        message: error && error.message ? safe(error.message) : String(error || ""),
        details: extra || null
    };
}

function getLastFileUtilsError() {
    return lastFileUtilsError;
}

// ---------------------------------------------------------------------------
// Cross-platform path helpers (no separator replacement — works with / and \)
// ---------------------------------------------------------------------------

function getOutputDirectory(pathValue) {
    var p = safe(pathValue);
    var idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    if (idx < 0) { return ""; }
    return p.substring(0, idx);
}

function getOutputFileNameWithoutExtension(pathValue) {
    var p = safe(pathValue);
    var idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    var name = idx >= 0 ? p.substring(idx + 1) : p;
    var dot = name.lastIndexOf(".");
    if (dot > 0) { return name.substring(0, dot); }
    return name;
}

function getPathFileName(pathValue) {
    var p = safe(pathValue);
    var idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return idx >= 0 ? p.substring(idx + 1) : p;
}

// ---------------------------------------------------------------------------
// @node-only — sync delete/move (unlinkSync/renameSync not available in UXP)
// Retained for Node test compatibility. Do NOT use in .idjs or lib/*.js modules.
// ---------------------------------------------------------------------------

function removeFileIfPresent(pathValue) {
    clearLastFileUtilsError();
    try { fs.unlinkSync(pathValue); return true; } catch (e0) {
        captureFileUtilsError("unlink", pathValue, e0);
    }
    return false;
}

function moveFileSync(sourcePath, targetPath) {
    clearLastFileUtilsError();
    try { fs.renameSync(sourcePath, targetPath); return true; } catch (e0) {
        captureFileUtilsError("rename", sourcePath, e0, { targetPath: safe(targetPath) });
    }
    try {
        fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
        try { fs.unlinkSync(sourcePath); } catch (e1a) {
            captureFileUtilsError("unlink-after-copy", sourcePath, e1a, { targetPath: safe(targetPath) });
        }
        return true;
    } catch (e1) {
        captureFileUtilsError("copy-fallback", sourcePath, e1, { targetPath: safe(targetPath) });
    }
    return false;
}

// ---------------------------------------------------------------------------
// Cross-platform file URL helper
// ---------------------------------------------------------------------------

function toFileUrl(nativePath) {
    var p = safe(nativePath).replace(/\\/g, "/");
    // Remove leading / to avoid file://// on macOS (paths start with /)
    if (p.charAt(0) === "/") { p = p.substring(1); }
    return "file:///" + p;
}

// ---------------------------------------------------------------------------
// Async helpers (UXP-safe — use these instead of sync delete/move/mkdir)
// Best-effort semantics: missing file returns false (no throw), matching
// the contract of removeFileIfPresent/moveFileSync.
// ---------------------------------------------------------------------------

function ensureDirAsync(dirPath) {
    return new Promise(function (resolve, reject) {
        fs.mkdir(dirPath, { recursive: true }, function (err) {
            if (err) { reject(err); } else { resolve(); }
        });
    });
}

/**
 * ensureDirVerifiedAsync(dirPath) → Promise<{ ok, created?, error? }>
 *
 * 🔴 Use this, not `ensureParentDir()`, anywhere the directory actually has to
 * be there afterwards.
 *
 * Two things this exists for, both measured on 2026-08-28 (the AC9 backup-gate
 * bug):
 *   1. **`fs.mkdirSync` does not exist in UXP** — so `ensureParentDir()` is a
 *      no-op there that returns `false`, and every caller that ignored the
 *      boolean got a directory that was never created. The ASYNC `fs.mkdir`
 *      IS available (it is what creates `script_outputs/package` today).
 *   2. **"mkdir resolved" is not proof the directory exists** (#26/#67 family).
 *      So this re-resolves the path through UXP lfs and only says ok when the
 *      entry is really there AND is a folder.
 *
 * `fs.statSync` is deliberately NOT used for that readback: it has been
 * measured lying about existence in UXP (CLAUDE.md #26-补).
 *
 * Under Node (tests) `_resolveLfs()` throws unless a stub provider is
 * installed; that is reported as `ok:false` with a reason, never as success.
 */
async function ensureDirVerifiedAsync(dirPath, opts) {
    clearLastFileUtilsError();
    if (!dirPath) { return { ok: false, error: "no dirPath" }; }
    var mkdirErr = null;
    try { await ensureDirAsync(dirPath); }
    catch (eMk) {
        // EEXIST is not a failure — verification below is the real judge.
        mkdirErr = eMk;
    }
    var lfs;
    // `opts.lfs` is a PER-CALL seam. The module-global
    // `_setLfsProviderForTests` cannot be used here: the non-host suite starts
    // its async checks concurrently, so two suites sharing one global provider
    // stomp each other across await points (measured 2026-08-28 — this file's
    // tests passed alone and failed in the suite, every time).
    var __provider = opts && opts.lfs;
    try { lfs = (typeof __provider === "function") ? __provider() : (__provider || _resolveLfs()); }
    catch (eLfs) {
        captureFileUtilsError("ensureDirVerified-require-uxp", dirPath, eLfs);
        return { ok: false, error: "cannot verify dir (no lfs): " + String((eLfs && eLfs.message) || eLfs)
            + (mkdirErr ? " | mkdir said: " + String((mkdirErr && mkdirErr.message) || mkdirErr) : "") };
    }
    var entry = null;
    try { entry = await lfs.getEntryWithUrl(toFileUrl(dirPath)); }
    catch (eGet) { entry = null; }
    if (!entry) {
        captureFileUtilsError("ensureDirVerified-readback", dirPath,
            { message: "path does not resolve after mkdir" });
        return { ok: false, error: "directory does not exist after mkdir: " + dirPath
            + (mkdirErr ? " (mkdir said: " + String((mkdirErr && mkdirErr.message) || mkdirErr) + ")" : "") };
    }
    if (entry.isFolder === false) {
        return { ok: false, error: "path exists but is not a folder: " + dirPath };
    }
    return { ok: true };
}

function removeDirAsync(dirPath) {
    return new Promise(function (resolve, reject) {
        fs.rmdir(dirPath, function (err) {
            if (err) { reject(err); } else { resolve(); }
        });
    });
}

// Recursively delete a folder via UXP lfs entry walk. UXP `fs.rm` doesn't
// exist and `entry.delete()` rejects on non-empty folders, so this enumerates
// children, deletes each file / recurses into each subfolder, then deletes
// the now-empty parent. Idempotent: returns { ok:true, removed:0 } if the
// folder didn't exist.
//
// Returns { ok: boolean, removed: int, error?: string }.
//
// 2026-05-28: extracted from export_translation_package.idjs (was inline)
// so import_translations_v2 can use the same logic to clean up its zip-
// extracted folder at the end of a successful import.
async function deleteFolderRecursiveAsync(folderPath, logFn) {
    logFn = logFn || function () {};
    // #70: same test seam as removeFileAsync — otherwise this whole function is
    // unreachable from Node tests and its result-shape contract can't be pinned.
    var lfs = _resolveLfs();
    var removed = 0;
    async function _walk(entry) {
        var kids = [];
        try { kids = await entry.getEntries(); } catch (eK) { kids = []; }
        for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            if (k.isFolder) {
                await _walk(k);
            }
            try { await k.delete(); removed++; }
            catch (eD) { logFn("delete failed for " + k.nativePath + ": " + (eD && eD.message || eD)); }
        }
    }
    try {
        var url = "file:///" + folderPath.replace(/\\/g, "/").replace(/^\/+/, "");
        var rootEntry = null;
        // #70: "already absent" is an IDEMPOTENT SUCCESS for a delete, so ok:true
        // is right — but it used to be reported by stuffing a message into
        // `error`. A caller reading only `ok` saw success; a caller reading only
        // `error` saw a failure; both were looking at the same result object.
        // The condition gets its own field instead.
        try { rootEntry = await lfs.getEntryWithUrl(url); }
        catch (eRE) { return { ok: true, removed: 0, absent: true }; }
        if (!rootEntry) return { ok: true, removed: 0, absent: true };
        await _walk(rootEntry);
        try { await rootEntry.delete(); removed++; }
        catch (eR) { return { ok: false, removed: removed, error: "root delete failed: " + (eR && eR.message || eR) }; }
        return { ok: true, removed: removed };
    } catch (eT) {
        return { ok: false, removed: removed, error: String(eT && eT.message || eT) };
    }
}

// Test seam for the UXP filesystem provider (#70). Production resolves it from
// `require("uxp")`; Node tests inject a fake so the readback logic below can
// actually be exercised — without this, `require("uxp")` throws under Node and
// removeFileAsync short-circuits to `false`, i.e. **the branch we are fixing is
// unreachable from any test**.
var __lfsProviderForTests = null;
// ⚠ MODULE-GLOBAL, and the non-host suite starts its async checks
// CONCURRENTLY — two async tests both using this seam stomp each other across
// await points (measured 2026-08-28: a suite-only failure that never reproduced
// standalone). For anything async, prefer a PER-CALL seam
// (see ensureDirVerifiedAsync's `opts.lfs`) over this one.
function _setLfsProviderForTests(p) { __lfsProviderForTests = p; }
function _resolveLfs() {
    if (__lfsProviderForTests) return __lfsProviderForTests;
    return require("uxp").storage.localFileSystem;
}

/**
 * removeFileAsync(filePath) → Promise<boolean>
 *
 * 🔴 `true` now means **VERIFIED GONE**, not "delete() resolved".
 *
 * It used to return `true` the moment `entry.delete()` resolved, without ever
 * checking. Measured 2026-08-22 (#70 witness): an import logged
 * `translated cleanup DONE` while the file was **still on disk** — it had to be
 * deleted by hand afterwards. `delete()` resolving is a claim about the call,
 * not about the filesystem, and the whole #62/#67 line is the same disease:
 * **recording the intent instead of the result.**
 *
 * ⚠ Failure is still signalled by RETURNING false, never by throwing — a caller
 * that only writes `try/catch` sees nothing. Same shape as `ensureParentDir`
 * (#61). Prefer `removeFileVerified()`, which hands back a reason.
 *
 * ⚠ The readback is a SINGLE check with no retry and no sleep. For documents
 * we measured a real lag between "close() said ok" and "it is actually gone",
 * but no such lag has been observed for file deletion — so nothing is papered
 * over here. If one ever shows up, it must be surfaced and decided on, not
 * hidden behind a delay.
 */
function removeFileAsync(filePath) {
    clearLastFileUtilsError();
    var lfs;
    try {
        lfs = _resolveLfs();
    } catch (e) {
        captureFileUtilsError("removeFileAsync-require-uxp", filePath, e);
        return Promise.resolve(false);
    }
    var url = toFileUrl(filePath);
    return lfs.getEntryWithUrl(url).then(function (entry) {
        if (!entry || typeof entry.delete !== "function") {
            captureFileUtilsError("removeFileAsync-no-entry", filePath,
                { message: "path did not resolve to a deletable entry" });
            return false;
        }
        return entry.delete().then(function () {
            // ── READBACK (#70) ──────────────────────────────────────────
            // Re-resolve the path. Still resolvable ⇒ the delete did not take
            // effect, whatever delete() reported. Resolution failing is the
            // success signal here: the entry is gone.
            return lfs.getEntryWithUrl(url).then(function (still) {
                if (still) {
                    captureFileUtilsError("removeFileAsync-readback", filePath,
                        { message: "delete() resolved but the path is still resolvable" });
                    return false;
                }
                return true;
            }, function () {
                return true;   // cannot resolve any more ⇒ really gone
            });
        });
    }).catch(function (e) {
        captureFileUtilsError("removeFileAsync", filePath, e);
        return false;
    });
}

/**
 * removeFileVerified(filePath) → Promise<{ ok, err? }>   (#70)
 *
 * The form call sites should use. `removeFileAsync` reports failure by
 * returning `false`, and every site that mattered dropped that value on the
 * floor and printed success anyway — a boolean is too easy to ignore, a result
 * object with a reason is not.
 */
function removeFileVerified(filePath) {
    return removeFileAsync(filePath).then(function (gone) {
        if (gone) return { ok: true };
        var last = getLastFileUtilsError();
        return {
            ok: false,
            err: last
                ? (last.operation + ": " + (last.message || "(no message)"))
                : "delete did not take effect (path still resolvable)"
        };
    });
}

function moveFileAsync(sourcePath, targetPath) {
    clearLastFileUtilsError();
    return new Promise(function (resolve, reject) {
        fs.rename(sourcePath, targetPath, function (err) {
            if (err) { reject(err); } else { resolve(true); }
        });
    }).catch(function () {
        // Fallback: copy + delete source
        try {
            fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
        } catch (e1) {
            captureFileUtilsError("moveFileAsync-copy", sourcePath, e1, { targetPath: safe(targetPath) });
            return false;
        }
        return removeFileAsync(sourcePath).then(function (deleted) {
            if (!deleted) {
                captureFileUtilsError("moveFileAsync-delete-source", sourcePath,
                    { message: "copy succeeded but source delete failed" }, { targetPath: safe(targetPath) });
            }
            // Best-effort: copy succeeded, return true even if source delete failed
            return true;
        });
    });
}

// ---------------------------------------------------------------------------
// Best-effort UXP-safe file ops for SYNCHRONOUS call sites (no async ripple).
//
// Deletion in UXP is async-only (lfs entry.delete; the Node sync delete throws
// — provider has no such method), so these wrap removeFileAsync as
// fire-and-forget to preserve a synchronous caller's signature. The delete may
// not flush if the host tears the JS context down right after the script
// returns; in that case the file lingers — exactly the legacy @node-only sync
// behaviour (which ALWAYS threw in UXP), so never worse, often better.
//
// File copy uses writeFileSync(readFileSync(...)) which IS supported in UXP
// (that fallback already ran in production via the old moveFileSync path).
//
// Names deliberately avoid every denylist substring so call sites stay clean
// when lib/repair_after_apply.js is added to the denylist scan (TODO-0e-4b).
// ---------------------------------------------------------------------------

/**
 * removeFileBestEffort(pathValue) → void
 *
 * 🔴 THE NAME IS THE CONTRACT — read it before calling. This is fire-and-forget:
 * it starts a delete and **returns before knowing whether anything happened**.
 * It cannot fail, because it never looks. No return value, no readback, no log.
 *
 * ⚠ Deliberately kept (#70): sync call sites that must not grow an async ripple.
 * But do NOT reach for it just because it is the convenient one — if the caller
 * would ever say "cleaned up" out loud, or anything downstream depends on the
 * file being gone, it must use `removeFileVerified()` and consume the result.
 * A `cleanup DONE` line printed after THIS function is a lie by construction.
 */
function removeFileBestEffort(pathValue) {
    // removeFileAsync catches internally and resolves false (never rejects), so
    // the floating promise is safe to abandon.
    try { removeFileAsync(pathValue); } catch (e0) {}
}

function copyFileBytes(sourcePath, targetPath) {
    clearLastFileUtilsError();
    try {
        fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
        return true;
    } catch (e0) {
        captureFileUtilsError("copy-bytes", sourcePath, e0, { targetPath: safe(targetPath) });
    }
    return false;
}

function moveFileBestEffort(sourcePath, targetPath) {
    // UXP-safe "move": synchronous byte copy (overwrites target) + best-effort
    // source delete. Returns true when the copy — the move's load-bearing half
    // — succeeded; a failed source delete only leaves a temp behind, it never
    // loses the target.
    if (!copyFileBytes(sourcePath, targetPath)) {
        return false;
    }
    removeFileBestEffort(sourcePath);
    return true;
}

// Ensure the parent directory of `pathValue` exists. Best-effort:
// returns true on success or when parent already exists; false on hard
// failure. Tries fs.mkdirSync({recursive:true}) first (Node 10+/UXP),
// falls back to manual recursive walk for older runtimes.
function ensureParentDir(pathValue) {
    var parent = getOutputDirectory(pathValue);
    if (!parent) { return true; }
    try {
        fs.mkdirSync(parent, { recursive: true });
        return true;
    } catch (e0) {
        if (e0 && e0.code === "EEXIST") { return true; }
        // Older runtimes don't honor {recursive:true}: walk up manually.
        try {
            return _mkdirRecursiveManual(parent);
        } catch (e1) {
            return false;
        }
    }
}

function _mkdirRecursiveManual(dirPath) {
    if (!dirPath) { return true; }
    try {
        fs.mkdirSync(dirPath);
        return true;
    } catch (e) {
        if (e && e.code === "EEXIST") { return true; }
        if (e && e.code === "ENOENT") {
            var parent = getOutputDirectory(dirPath);
            if (parent && parent !== dirPath) {
                if (!_mkdirRecursiveManual(parent)) { return false; }
                try { fs.mkdirSync(dirPath); return true; }
                catch (e2) { return e2 && e2.code === "EEXIST"; }
            }
        }
        return false;
    }
}

function writeTextFile(pathValue, contents) {
    clearLastFileUtilsError();
    ensureParentDir(pathValue);
    try {
        fs.writeFileSync(pathValue, String(contents), "utf8");
        return true;
    } catch (e0) {
        captureFileUtilsError("write-text", pathValue, e0);
    }
    return false;
}

function writeJsonFile(pathValue, payload) {
    clearLastFileUtilsError();
    ensureParentDir(pathValue);
    fs.writeFileSync(pathValue, JSON.stringify(payload, null, 2), "utf8");
}

module.exports = {
    // Cross-platform path helpers
    getOutputDirectory: getOutputDirectory,
    getOutputFileNameWithoutExtension: getOutputFileNameWithoutExtension,
    getPathFileName: getPathFileName,
    toFileUrl: toFileUrl,
    // Error tracking
    getLastFileUtilsError: getLastFileUtilsError,
    clearLastFileUtilsError: clearLastFileUtilsError,
    // Sync write (UXP-safe — writeFileSync works)
    writeTextFile: writeTextFile,
    writeJsonFile: writeJsonFile,
    ensureParentDir: ensureParentDir,
    // @node-only sync delete/move (UXP: unlinkSync/renameSync not available)
    removeFileIfPresent: removeFileIfPresent,
    moveFileSync: moveFileSync,
    // Async helpers (UXP-safe)
    ensureDirAsync: ensureDirAsync,
    ensureDirVerifiedAsync: ensureDirVerifiedAsync,
    removeDirAsync: removeDirAsync,
    deleteFolderRecursiveAsync: deleteFolderRecursiveAsync,
    removeFileAsync: removeFileAsync,
    // #70: prefer this at call sites — it hands back a REASON, which a bare
    // boolean did not, and every site that mattered ignored the boolean.
    removeFileVerified: removeFileVerified,
    moveFileAsync: moveFileAsync,
    // Best-effort UXP-safe ops for sync call sites (no async ripple)
    removeFileBestEffort: removeFileBestEffort,
    copyFileBytes: copyFileBytes,
    moveFileBestEffort: moveFileBestEffort,
    // Test seam (#70): lets Node tests exercise the delete + readback path.
    // Without it `require("uxp")` throws under Node and the branch is untestable.
    _setLfsProviderForTests: _setLfsProviderForTests
};
