"use strict";

/**
 * lib/work_copy.js
 *
 * Phase 1 + Phase 3 MVP — Document copy lifecycle helper
 *
 * Plan reference: task_plan.md "⓪ Setup ── 进入 workDoc, 源 doc 自此封闭"
 *                              "MVP 必含: 源 doc 不被原地覆盖 (PRD M4 100% 版本追溯)"
 *
 * Responsibility:
 *   Provide a single high-order helper `withDocumentCopy(sourceDoc, callback)`
 *   that:
 *     1. saveACopy of sourceDoc to a temp file
 *     2. opens the temp as workDoc (showingWindow=false)
 *     3. invokes callback(workDoc) — caller does all work on workDoc
 *     4. on caller's request OR error, close workDoc and clean up temp
 *
 *   Source doc is NEVER opened for write. workDoc is closed without saving
 *   by default; callers can saveAs the workDoc to a permanent location
 *   before close (see Phase 3 saveAs `<source>.translated.indd`).
 *
 * Why high-order helper:
 *   - Centralize cleanup (try/finally guarantees temp file removed even on
 *     exception)
 *   - Centralize "input must be sourceDoc" defensive check (防二次复制)
 *   - Single place to evolve the lifecycle (e.g., add provenance metadata
 *     stamping later)
 *
 * UXP / ExtendScript compatibility:
 *   - Defers all I/O + InDesign API to dependencies injected via `deps`:
 *       deps.app          — InDesign app object (open, etc.)
 *       deps.SaveOptions  — indesign.SaveOptions enum
 *       deps.getTempDir   — function returning temp dir string
 *       deps.removeFile   — function(path) → removes file (caller chooses
 *                           sync or async; UXP callers should pass a wrapper
 *                           around FileUtils.removeFileAsync; Node tests
 *                           pass a mock). Return value ignored.
 *   - Module source contains NO direct fs / unlinkSync / Folder API calls,
 *     keeping it on the right side of the UXP denylist.
 */

// ─── Path helpers (sep-agnostic) ──────────────────────────────────

function _detectSep(p) {
    if (typeof p !== "string") return "/";
    return (p.indexOf("\\") >= 0) ? "\\" : "/";
}

function _joinPath(dir, file) {
    var sep = _detectSep(dir);
    if (dir.charAt(dir.length - 1) === sep) return dir + file;
    return dir + sep + file;
}

// ─── Temp filename generation ─────────────────────────────────────
//
// Filename pattern: spike-style — easy to identify orphan temps later.
// Includes timestamp for uniqueness (multiple concurrent calls).

function _makeTempFilename(prefix) {
    var stamp = String(Number(new Date()));
    var rnd = Math.floor(Math.random() * 1e6);
    return (prefix || "translation_workcopy_") + stamp + "_" + rnd + ".indd";
}

// ─── Defensive checks ─────────────────────────────────────────────

function _validateSourceDoc(sourceDoc) {
    if (!sourceDoc) {
        throw new Error("withDocumentCopy: sourceDoc is null/undefined");
    }
    // Source doc must be saved (have a fullName / filePath) to copy from
    var fullName;
    try { fullName = sourceDoc.fullName; } catch (e) {}
    if (!fullName) {
        // saveACopy works even for unsaved docs (writes to temp), but the
        // *purpose* is to preserve the source. An unsaved source means
        // there's nothing to preserve. Caller probably made a mistake.
        throw new Error("withDocumentCopy: sourceDoc has no fullName (unsaved). Save it first.");
    }
}

function _isLikelyWorkDoc(doc) {
    // Heuristic: warn if caller passed a doc whose path matches our temp
    // pattern (suggests double-wrapping).
    var fullName;
    try { fullName = doc.fullName; } catch (e) {}
    if (!fullName) return false;
    var pathStr;
    try { pathStr = String(fullName); } catch (e) { return false; }
    return pathStr.indexOf("translation_workcopy_") >= 0;
}

// ─── Main entry: withDocumentCopy ─────────────────────────────────

/**
 * Run callback with a temporary working copy of sourceDoc.
 *
 * @param {Document} sourceDoc — InDesign Document (must be saved)
 * @param {Function} callback — function(workDoc, ctx) → result
 *                              workDoc is the open temp copy.
 *                              ctx exposes { tempPath, sourceDocPath } for
 *                              advanced use cases (e.g., naming output).
 * @param {Object} deps — dependency injection for testability:
 *                        { removeFile, getTempDir, app, SaveOptions,
 *                          [tempFilename], [warn] }
 *                        - removeFile:  function(path) — best-effort delete
 *                                       (UXP callers wrap FileUtils.removeFileAsync)
 *                        - getTempDir:  function returning temp dir path
 *                        - app:         InDesign app object
 *                        - SaveOptions: indesign.SaveOptions enum
 *                        - tempFilename: optional override for testing
 *                        - warn:        optional function(msg) for warnings
 * @returns {*} whatever callback returned
 *
 * Lifecycle:
 *   1. validateSourceDoc()
 *   2. tempPath = makeTempPath()
 *   3. sourceDoc.saveACopy(tempPath)
 *   4. workDoc = app.open(tempPath, false)
 *   5. try {
 *        return callback(workDoc, ctx)
 *      } finally {
 *        workDoc.close(SaveOptions.NO)
 *        fs.unlinkSync(tempPath)
 *      }
 *
 * If saveACopy or app.open fail, NO callback is invoked and the error
 * propagates. Source doc is never written.
 */
function withDocumentCopy(sourceDoc, callback, deps) {
    if (typeof callback !== "function") {
        throw new Error("withDocumentCopy: callback must be a function");
    }
    if (!deps || !deps.removeFile || !deps.getTempDir || !deps.app || !deps.SaveOptions) {
        throw new Error("withDocumentCopy: deps must include {removeFile, getTempDir, app, SaveOptions}");
    }

    _validateSourceDoc(sourceDoc);

    if (_isLikelyWorkDoc(sourceDoc)) {
        // Don't throw — could be legitimate (e.g., re-running on a translated.indd)
        // But surface a warning channel if available
        if (deps.warn) {
            try { deps.warn("withDocumentCopy: sourceDoc path matches workcopy pattern — possible double-wrap"); } catch (e) {}
        }
    }

    var tempDir = deps.getTempDir();
    var tempName = (deps.tempFilename) ? deps.tempFilename : _makeTempFilename("translation_workcopy_");
    var tempPath = _joinPath(tempDir, tempName);

    var sourceDocPath;
    try { sourceDocPath = String(sourceDoc.fullName); } catch (e) { sourceDocPath = "<unknown>"; }

    // Step 1: saveACopy (read-only on sourceDoc; new file written to temp)
    try {
        sourceDoc.saveACopy(tempPath);
    } catch (eSave) {
        throw new Error("withDocumentCopy: saveACopy failed → " + (eSave && eSave.message ? eSave.message : eSave));
    }

    // Step 2: open temp as workDoc
    var workDoc;
    try {
        workDoc = deps.app.open(tempPath, false);
    } catch (eOpen) {
        // saveACopy succeeded, open failed — clean up temp
        try { deps.removeFile(tempPath); } catch (eRm) {}
        throw new Error("withDocumentCopy: app.open(temp) failed → " + (eOpen && eOpen.message ? eOpen.message : eOpen));
    }

    // Step 3: invoke callback in try/finally for guaranteed cleanup
    var result;
    var callbackError;
    try {
        result = callback(workDoc, {
            tempPath: tempPath,
            sourceDocPath: sourceDocPath
        });
    } catch (eCb) {
        callbackError = eCb;
    } finally {
        // Cleanup workDoc — close NO (don't save back to temp)
        try {
            workDoc.close(deps.SaveOptions.NO);
        } catch (eClose) {
            // If callback already closed it (e.g., after saveAs to permanent
            // path), close() may throw — non-fatal
            if (deps.warn) {
                try { deps.warn("workDoc.close failed (may have been closed by callback) → " + eClose.message); } catch (e) {}
            }
        }
        // Cleanup temp file (best effort) — caller-injected removeFile
        // may be sync or async; we don't await
        try {
            deps.removeFile(tempPath);
        } catch (eRm) {
            if (deps.warn) {
                try { deps.warn("temp file cleanup failed → " + eRm.message); } catch (e) {}
            }
        }
    }

    if (callbackError) throw callbackError;
    return result;
}

// ─── Module exports ────────────────────────────────────────────────

module.exports = {
    withDocumentCopy: withDocumentCopy,
    _internal: {
        _detectSep: _detectSep,
        _joinPath: _joinPath,
        _makeTempFilename: _makeTempFilename,
        _validateSourceDoc: _validateSourceDoc,
        _isLikelyWorkDoc: _isLikelyWorkDoc
    }
};
