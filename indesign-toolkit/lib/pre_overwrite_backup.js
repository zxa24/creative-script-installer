"use strict";

/**
 * lib/pre_overwrite_backup.js — AC9 fail-closed "back up before overwrite" gate.
 *
 * Charter r1 §6.5 D6 / AC9 / R4: in-place import overwrites a generated
 * `*.translated.indd` (NEVER the source .indd — findings.md#bridge-32b). An
 * in-place overwrite is IRREVERSIBLE (the pre-edit on-disk state is gone), so
 * before any overwrite we MUST:
 *   1. back up the current on-disk file, and
 *   2. VERIFY the backup by read-back + hash (a write that "returns success" is
 *      not proof — a truncated/corrupt backup + overwrite = both the live doc
 *      and the only safe copy destroyed = silent data loss), and
 *   3. warn that native edits in the on-disk file are about to be REPLACED.
 * Only a VERIFIED backup permits the overwrite. Backup or verify failure →
 * ABORT (fail-closed), never overwrite.
 *
 * Deps are injected so this is Node-testable with a stub fs (no host):
 *   runBackupGate({ fs, hashBytesHex, targetPath, backupDir, sep, baseName,
 *                   timestamp, ensureDir, log })
 *
 * hashBytesHex(bytes) → hex — pass lib/version_manifest.js#sha256HexOfBytes.
 * The backup dir is a PURE user-facing safety copy (charter F2): it is NOT part
 * of the version-compare / carry-forward mechanism and is never read back into
 * lineage.
 */

// ENOENT across Node + UXP fs (UXP error objects don't always carry .code).
function _isNotFound(err) {
    if (!err) return false;
    if (err.code === "ENOENT") return true;
    var m = String((err && err.message) || err);
    return /ENOENT|no such file|not\s*found|cannot find/i.test(m);
}

function _errStr(err) {
    return String((err && err.message) || err);
}

// backupDir + sep + <baseName>.<timestamp>.bak.indd
function computeBackupPath(backupDir, sep, baseName, timestamp) {
    var safeBase = String(baseName || "translated").replace(/[\\\/:\*\?"<>\|]/g, "_");
    var safeTs = String(timestamp || "0").replace(/[\\\/:\*\?"<>\|]/g, "_");
    return backupDir + sep + safeBase + "." + safeTs + ".bak.indd";
}

/**
 * @returns {
 *   required: bool,   // was a backup needed (i.e. target existed)?
 *   ok: bool,         // safe to proceed with overwrite?
 *   backupPath: str,  // where the verified backup landed (when required+ok)
 *   bytes: number,    // backed-up byte count
 *   srcHash, bakHash: str,
 *   warn: str,        // AC9 disclosure ("native edits will be replaced")
 *   error: str        // set when !ok
 * }
 */
function runBackupGate(opts) {
    opts = opts || {};
    var fs = opts.fs;
    var hashBytesHex = opts.hashBytesHex;
    var log = opts.log || function () {};
    var targetPath = opts.targetPath;

    if (!fs || typeof fs.readFileSync !== "function" || typeof fs.writeFileSync !== "function") {
        return { required: true, ok: false, error: "no usable fs (readFileSync/writeFileSync)" };
    }
    if (typeof hashBytesHex !== "function") {
        return { required: true, ok: false, error: "no hashBytesHex fn" };
    }
    if (!targetPath) {
        return { required: true, ok: false, error: "no targetPath" };
    }

    // 1. Read the current on-disk bytes (the thing about to be overwritten).
    var srcBytes;
    try {
        srcBytes = fs.readFileSync(targetPath);
    } catch (eRead) {
        if (_isNotFound(eRead)) {
            // Target doesn't exist yet → overwrite creates a fresh file, there is
            // nothing to lose. Not required; safe to proceed.
            log("pre-overwrite backup: target absent (" + targetPath + ") — nothing to back up; overwrite is a create");
            return { required: false, ok: true, backupPath: "", bytes: 0 };
        }
        // Can't read the file we're about to overwrite → unsafe. Fail-closed.
        return { required: true, ok: false, error: "cannot read target for backup: " + _errStr(eRead) };
    }

    var srcU8 = _toU8(srcBytes);
    if (!srcU8 || srcU8.length === 0) {
        // A zero-byte / unreadable source is itself suspicious; refuse to treat a
        // 0-byte "backup" as valid. Fail-closed.
        return { required: true, ok: false, error: "target read as 0 bytes — refusing to overwrite without a real backup" };
    }
    var srcHash = hashBytesHex(srcU8);

    // 2. Ensure the backup dir, then write the backup.
    var backupDir = opts.backupDir;
    if (!backupDir) {
        return { required: true, ok: false, error: "no backupDir" };
    }
    if (typeof opts.ensureDir === "function") {
        // 🔴 This used to call ensureDir and THROW ITS ANSWER AWAY, on the
        // assumption that a creator which fails will throw. The one in this
        // codebase does not: FileUtils.ensureParentDir is best-effort and
        // RETURNS false — and in UXP it returns false every single time,
        // because `fs.mkdirSync` does not exist there. So the backup dir was
        // never created, and the only trace was an opaque
        //   "backup write failed: no such file or directory"
        // four lines below (2026-08-28 owner run; every in-place re-import).
        // A creator that cannot say "yes" is not evidence of success:
        // anything other than a truthy answer is fail-closed here.
        var dirOk;
        try { dirOk = opts.ensureDir(backupDir); } catch (eDir) {
            return { required: true, ok: false, error: "cannot create backup dir: " + _errStr(eDir) };
        }
        if (!dirOk) {
            return { required: true, ok: false,
                error: "backup dir could not be created (ensureDir answered " + String(dirOk) + "): " + backupDir };
        }
    }
    var backupPath = computeBackupPath(backupDir, opts.sep || "\\", opts.baseName, opts.timestamp);
    try {
        fs.writeFileSync(backupPath, srcBytes);
    } catch (eWrite) {
        return { required: true, ok: false, backupPath: backupPath, error: "backup write failed: " + _errStr(eWrite) };
    }

    // 3. VERIFY by read-back + hash (write success is NOT proof — AC9).
    var bakBytes;
    try {
        bakBytes = fs.readFileSync(backupPath);
    } catch (eReadBack) {
        return { required: true, ok: false, backupPath: backupPath, error: "backup read-back failed: " + _errStr(eReadBack) };
    }
    var bakU8 = _toU8(bakBytes);
    if (!bakU8 || bakU8.length !== srcU8.length) {
        return { required: true, ok: false, backupPath: backupPath,
            error: "backup size mismatch (src=" + srcU8.length + " bak=" + (bakU8 ? bakU8.length : "?") + ") — corrupt/truncated backup" };
    }
    var bakHash = hashBytesHex(bakU8);
    if (bakHash !== srcHash) {
        return { required: true, ok: false, backupPath: backupPath,
            error: "backup hash mismatch (src=" + srcHash + " bak=" + bakHash + ") — corrupt backup" };
    }

    var warn = "In-place overwrite: the current on-disk translated document will be REPLACED by this import — "
        + "any native InDesign edits saved in that file are superseded. A verified backup was written to: " + backupPath;
    log("pre-overwrite backup VERIFIED: " + backupPath + " (" + srcU8.length + " bytes, sha256=" + srcHash.slice(0, 12) + "…)");
    return { required: true, ok: true, backupPath: backupPath, bytes: srcU8.length, srcHash: srcHash, bakHash: bakHash, warn: warn };
}

function _toU8(b) {
    if (b == null) return null;
    if (typeof Uint8Array !== "undefined" && b instanceof Uint8Array) return b;
    if (typeof ArrayBuffer !== "undefined" && b instanceof ArrayBuffer) return new Uint8Array(b);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(b)) return new Uint8Array(b);
    if (b && typeof b.length === "number") return new Uint8Array(Array.prototype.slice.call(b));
    return null;
}

module.exports = {
    runBackupGate: runBackupGate,
    computeBackupPath: computeBackupPath,
    _isNotFound: _isNotFound
};
