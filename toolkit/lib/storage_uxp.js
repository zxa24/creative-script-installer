// storage_uxp.js — UXP (InDesign idjs/panel) storage adapter for
// project_meta _meta.json (8D-ext-A1, step 2a).
//
// Implements the project_meta core-lib adapter contract
// (readText / writeAtomic) — see app-folio vendor/project_meta.js header
// and the storage_node.js reference. Must be SEMANTICALLY EQUIVALENT to
// storage_node against the shared adapter_conformance suite (15 portable
// cases); durability mechanics below are UXP-specific and verified in-host.
//
// DESIGN — injected platform primitives (`io`) so the CAS / immutable /
// no-op / lock / backup / publish LOGIC is identical across runtimes and
// runs in Node (with a UXP-shaped shim) for conformance, and in-host with
// the real fs+lfs binding (makeUxpIo). The platform boundary is the `io`
// object; everything above it is shared logic.
//
//   io = {
//     stat(path)                  -> Promise<{exists, isFile, isDir, size, mtimeMs?}>
//     readText(path)              -> Promise<string>   (caller stat-size-caps first)
//     createExclusive(path, text) -> Promise<boolean>  (true=created/acquired,
//                                     false=already exists; the lock primitive)
//     writeOverwrite(path, text)  -> Promise<void>      (tmp / .bak writes)
//     move(src, dst)              -> Promise<void>      (publish; overwrite dst)
//     remove(path)                -> Promise<void>      (delete; fs.unlinkSync N/A)
//     listDir(dir)                -> Promise<string[]>  (.bak rotation)
//     sleep?(ms)                  -> Promise<void>      (lock retry; optional)
//   }
//
// PROBE-VALIDATED UXP RESIDUALS (2026-06-16, real network drive + temp; see
// spec §8.2). These are documented degradations vs storage_node, WITHIN the
// §3.5 single-cooperating-writer best-effort contract:
//   - No fd-level partial read; size-cap via lstatSync().size BEFORE read
//     (probe: .size available + correct). bounded-read intent partially
//     recovered, not full.
//   - No symlink type bit (lstat isSymbolicLink absent) -> symlink not
//     rejected (rare under UXP sandbox).
//   - fs.unlinkSync unavailable -> delete via lfs entry.delete().
//   - LOCK = createEntry(overwrite:false)+write token, NOT create-only
//     atomic: createEntry doesn't persist until write, so there is a tiny
//     create->write race window. Best-effort; the CAS hash-compare under
//     lock is the REAL integrity guard (matches storage_node), the lock
//     only shrinks the window. Stale reclaim is mtime-only (no pid-alive /
//     inode in UXP) — weaker than node's, documented.
//   - Publish via entry.moveTo (copy+remove, NOT OS-atomic). A crash mid-
//     publish can leave a half-written target; the .bak (keep 3) is the
//     only corruption backstop.
//
// UMD: window.StorageUxp | module.exports.

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.StorageUxp = factory();
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
    "use strict";

    var MAX_BYTE_SIZE = 64 * 1024;      // adapter byte cap (matches storage_node)
    var BACKUP_KEEP = 3;
    var LOCK_RETRY_MAX = 40;
    var LOCK_RETRY_DELAY_MS = 50;
    var STALE_LOCK_MS = 30000;
    var seq = 0;                         // monotonic suffix source (no Math.random/Date.now)

    function J(x) { try { return JSON.stringify(x); } catch (e) { return String(x); } }

    // path split that tolerates both separators (UXP native paths are
    // platform-native; resolver/caller pass a consistent sep).
    function splitPath(p) {
        var s = String(p);
        var iB = s.lastIndexOf("\\"), iF = s.lastIndexOf("/");
        var i = Math.max(iB, iF);
        if (i < 0) return { dir: ".", base: s, sep: "/" };
        return { dir: s.substring(0, i), base: s.substring(i + 1), sep: i === iB ? "\\" : "/" };
    }
    function lockPathOf(p) { return p + ".lock"; }
    function uniqSuffix(now) {
        // ISO string + monotonic counter; collision-free within a process
        // without Math.random / Date.now (UXP-safe + Workflow-sandbox-safe).
        // Seq is zero-padded to a FIXED width so the ISO-now prefix + seq sorts
        // lexically == time order even across a same-millisecond base36 rollover
        // (un-padded "z"(35) vs "10"(36) would invert and could evict the
        // NEWEST .bak; codex-audit A1).
        var s = (seq++).toString(36);
        while (s.length < 8) s = "0" + s;
        return String(now).replace(/[^0-9A-Za-z]/g, "") + "-" + s;
    }

    function withUpdatedAt(planned, nowStr) {
        var out = {};
        for (var k in planned) if (Object.prototype.hasOwnProperty.call(planned, k)) out[k] = planned[k];
        out.updated_at = nowStr;
        return out;
    }

    // Pure-JS strict UTF-8 decoder (RFC 3629). UXP has NO TextDecoder/TextEncoder
    // (in-host probe 2026-06-16), so the strict-reject behaviour storage_node gets
    // from TextDecoder({fatal:true}) is implemented here: throws on any malformed /
    // overlong / surrogate / out-of-range sequence instead of silently emitting
    // U+FFFD (which fs.readFileSync(p,"utf8") does). bytes: Uint8Array. codex-audit A1.
    function strictUtf8Decode(bytes) {
        var out = "", i = 0, n = bytes.length;
        while (i < n) {
            var b0 = bytes[i], cp, need;
            if (b0 < 0x80) { out += String.fromCharCode(b0); i += 1; continue; }
            if (b0 >= 0xC2 && b0 <= 0xDF) { cp = b0 & 0x1F; need = 1; }
            else if (b0 >= 0xE0 && b0 <= 0xEF) { cp = b0 & 0x0F; need = 2; }
            else if (b0 >= 0xF0 && b0 <= 0xF4) { cp = b0 & 0x07; need = 3; }
            else throw new Error("malformed UTF-8: invalid lead byte 0x" + b0.toString(16) + " at " + i);
            if (i + need >= n) throw new Error("malformed UTF-8: truncated sequence at " + i);
            for (var k = 1; k <= need; k++) {
                var bk = bytes[i + k];
                if (bk < 0x80 || bk > 0xBF) throw new Error("malformed UTF-8: bad continuation 0x" + bk.toString(16) + " at " + (i + k));
                cp = (cp << 6) | (bk & 0x3F);
            }
            if ((need === 1 && cp < 0x80) || (need === 2 && cp < 0x800) || (need === 3 && cp < 0x10000)) {
                throw new Error("malformed UTF-8: overlong encoding at " + i);
            }
            if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) throw new Error("malformed UTF-8: invalid codepoint at " + i);
            if (cp <= 0xFFFF) out += String.fromCharCode(cp);
            else { cp -= 0x10000; out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); }
            i += need + 1;
        }
        // Strip a leading UTF-8 BOM (U+FEFF) to match TextDecoder({ignoreBOM:false})
        // used by storage_node/storage_browser — else a BOM-prefixed _meta.json
        // would parse on web/Node but parse-error in UXP (codex re-audit B).
        if (out.charCodeAt(0) === 0xFEFF) out = out.substring(1);
        return out;
    }

    function createStorageUxp(io) {
        if (!io || typeof io.stat !== "function" || typeof io.createExclusive !== "function") {
            throw new Error("storage_uxp: io primitives required (stat/readText/createExclusive/writeOverwrite/move/remove/listDir)");
        }
        var sleep = io.sleep || function (ms) { return new Promise(function (r) {
            if (typeof setTimeout === "function") setTimeout(r, ms); else r();
        }); };

        // ── lock: best-effort mutual exclusion via createExclusive ──────
        async function acquireLock(lp, helpers) {
            var token = uniqSuffix(helpers.now());
            for (var i = 0; i < LOCK_RETRY_MAX; i++) {
                var got = false;
                try { got = await io.createExclusive(lp, JSON.stringify({ acquired_at: helpers.now(), token: token })); }
                catch (e) { got = false; }
                if (got) return { ok: true, token: token };
                // mtime-only stale reclaim (no pid-alive in UXP)
                if (i === 5 || i === 15 || i === 25) {
                    try {
                        var st = await io.stat(lp);
                        if (st.exists && typeof st.mtimeMs === "number" && (nowMs() - st.mtimeMs > STALE_LOCK_MS)) {
                            await io.remove(lp);
                        }
                    } catch (e2) { /* ignore */ }
                }
                await sleep(LOCK_RETRY_DELAY_MS);
            }
            return { ok: false };
        }
        function nowMs() {
            // local clock only used for stale-lock age; not part of stored
            // data. Falls back to 0 (never-stale) if Date unavailable.
            try { return (new Date()).getTime(); } catch (e) { return 0; }
        }
        async function releaseLock(lp, token) {
            // Token-checked release: only remove the lock if it still carries OUR
            // token — never delete a lock another writer created or reclaimed
            // (codex-audit A1; mirrors storage_node's token discipline, best-
            // effort here since UXP has no inode).
            try {
                if (token) {
                    var txt = null;
                    try { txt = await io.readText(lp); } catch (e) { txt = null; }
                    if (txt) {
                        var info = null; try { info = JSON.parse(txt); } catch (e) {}
                        if (info && info.token && info.token !== token) return; // not ours — leave it
                    }
                }
                await io.remove(lp);
            } catch (e) { /* best-effort */ }
        }

        // ── publish: tmp write + move (best-effort, non-atomic) ─────────
        async function publishWrite(path, text, helpers) {
            var tmp = path + ".tmp." + uniqSuffix(helpers.now());
            // Clean the tmp on EITHER a failed write or a failed move (a partial
            // tmp from a throwing writeOverwrite would otherwise orphan; codex-
            // audit A1).
            try {
                await io.writeOverwrite(tmp, text);
                await io.move(tmp, path);
            } catch (e) {
                try { await io.remove(tmp); } catch (e2) {}
                throw e;
            }
        }

        // ── backup-before-replace + rotation (keep newest BACKUP_KEEP) ──
        async function backupAndRotate(path, helpers) {
            var oldText;
            try { oldText = await io.readText(path); }
            catch (e) { throw new Error("backup failed (read): " + (e.message || e) + " (refusing to overwrite without backup)"); }
            var sp = splitPath(path);
            var bakName = sp.base + ".bak." + uniqSuffix(helpers.now());
            var bakPath = sp.dir + sp.sep + bakName;
            try { await io.writeOverwrite(bakPath, oldText); }
            catch (e) { throw new Error("backup failed (write): " + (e.message || e) + " (refusing to overwrite without backup)"); }
            // rotation: list dir, keep newest BACKUP_KEEP by name (uniqSuffix
            // begins with the ISO now-string so lexical sort == time order).
            try {
                var names = await io.listDir(sp.dir);
                var prefix = sp.base + ".bak.";
                var baks = names.filter(function (n) { return n.indexOf(prefix) === 0; }).sort();
                // keep last BACKUP_KEEP (newest); delete the rest. Never rotate
                // out the just-created backup even if the sort is somehow off
                // (defense-in-depth with the fixed-width uniqSuffix; codex-audit A1).
                for (var k = 0; k < baks.length - BACKUP_KEEP; k++) {
                    if (baks[k] === bakName) continue;
                    try { await io.remove(sp.dir + sp.sep + baks[k]); } catch (e) {}
                }
            } catch (e) { /* rotation best-effort */ }
        }

        // ── readText ────────────────────────────────────────────────────
        async function readText(path) {
            if (path === undefined || path === null || path === "") {
                return { ok: false, exists: false, kind: "io-error", errors: ["invalid path (undefined/null/empty)"] };
            }
            var st;
            try { st = await io.stat(path); }
            catch (e) { return { ok: false, exists: false, kind: "io-error", errors: [String(e.message || e)] }; }
            if (!st || !st.exists) return { ok: false, exists: false, kind: "missing", errors: ["file not found"] };
            // permission / io stat failure must surface as its own kind (not
            // "missing", which would drive a wrong init-write). codex-audit A1.
            if (st.error === "permission") return { ok: false, exists: true, kind: "permission", errors: st.errors || ["permission denied"] };
            if (st.error === "io-error") return { ok: false, exists: true, kind: "io-error", errors: st.errors || ["stat failed"] };
            if (st.isDir) return { ok: false, exists: true, kind: "directory", errors: ["path is a directory"] };
            if (st.isFile === false) return { ok: false, exists: true, kind: "io-error", errors: ["not a regular file"] };
            // size-cap BEFORE read (lstatSync().size — probe-verified available)
            if (typeof st.size === "number" && st.size > MAX_BYTE_SIZE) {
                return { ok: false, exists: true, kind: "io-error",
                    errors: ["file exceeds " + MAX_BYTE_SIZE + " byte limit (" + st.size + ")"] };
            }
            var text;
            try { text = await io.readText(path); }
            catch (e) { return { ok: false, exists: true, kind: "io-error", errors: [String(e.message || e)] }; }
            // residual: if size unavailable, fall back to read-all-then-length
            if (typeof st.size !== "number" && byteLen(text) > MAX_BYTE_SIZE) {
                return { ok: false, exists: true, kind: "io-error",
                    errors: ["file exceeds " + MAX_BYTE_SIZE + " byte limit (read-all fallback)"] };
            }
            return { ok: true, exists: true, kind: "file", text: text };
        }
        function byteLen(s) {
            // portable UTF-8 byte length (no Buffer guarantee in UXP)
            var n = 0;
            for (var i = 0; i < s.length; i++) {
                var c = s.charCodeAt(i);
                if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
                else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i++; }
                else n += 3;
            }
            return n;
        }

        // ── writeAtomic ──────────────────────────────────────────────────
        async function writeAtomic(path, plannedData, expected, helpers) {
            if (!expected) return { ok: false, errors: ["expected required"] };
            if (!helpers || typeof helpers.now !== "function") return { ok: false, errors: ["adapter helpers missing"] };
            if (path === undefined || path === null || path === "") return { ok: false, errors: ["invalid path (undefined/null/empty)"] };
            var lp = lockPathOf(path);
            var lock = await acquireLock(lp, helpers);
            if (!lock.ok) return { ok: false, errors: ["lock timeout: could not acquire " + lp + " within " + (LOCK_RETRY_MAX * LOCK_RETRY_DELAY_MS) + "ms"] };
            try {
                var st;
                try { st = await io.stat(path); }
                catch (e) { return { ok: false, errors: [String(e.message || e)] }; }
                if (st && st.error === "permission") return { ok: false, errors: ["permission denied: " + path] };
                if (st && st.error === "io-error") return { ok: false, errors: st.errors || ["stat failed: " + path] };
                var exists = !!(st && st.exists);
                if (exists && st.isDir) return { ok: false, errors: ["target is a directory"] };
                if (exists && st.isFile === false) return { ok: false, errors: ["target is not a regular file"] };
                // Size cap applies to ALL branches INCLUDING reset — storage_node
                // deliberately refuses to overwrite a >64 KiB existing file even on
                // reset ("no overwriting >64KB without confirming user read it";
                // see storage_node test N1b). reset recovers CORRUPT (small,
                // unparseable) files, NOT oversized ones. codex-audit A1
                // (corrected: the semantic voices misread node as bypassing here).
                if (exists && typeof st.size === "number" && st.size > MAX_BYTE_SIZE) {
                    return { ok: false, errors: ["existing file exceeds " + MAX_BYTE_SIZE + " byte limit (" + st.size + ")"] };
                }

                // ── absent ──
                if (expected === "absent") {
                    if (exists) return { ok: false, casError: true, errors: ["file already exists"] };
                    var nowA = helpers.now();
                    await publishWrite(path, helpers.serialize(withUpdatedAt(plannedData, nowA)), helpers);
                    return { ok: true, written: true, updated_at: nowA };
                }

                // ── reset (admin recovery) ──
                if (expected === "reset") {
                    if (exists) await backupAndRotate(path, helpers);
                    var nowR = helpers.now();
                    await publishWrite(path, helpers.serialize(withUpdatedAt(plannedData, nowR)), helpers);
                    return { ok: true, written: true, updated_at: nowR, reset: true };
                }

                // ── hash (CAS) ──
                if (!exists) return { ok: false, casError: true, errors: ["expected hash but file is missing"] };
                var diskText;
                try { diskText = await io.readText(path); }
                catch (e) { return { ok: false, casError: true, errors: ["disk read failed: " + (e.message || e)] }; }
                var pp = helpers.parse(diskText);
                if (!pp.ok) return { ok: false, casError: true, errors: ["disk content unparseable: " + pp.errors.join("; ")] };
                var diskData = pp.data;
                var diskHash = helpers.contentHash(diskData);
                if (expected !== diskHash) return { ok: false, casError: true, errors: ["CAS hash mismatch (disk changed since read)"] };
                // immutable invariants
                if (typeof diskData.created_at === "string" && typeof plannedData.created_at === "string"
                    && diskData.created_at !== plannedData.created_at) {
                    return { ok: false, errors: [{ path: "/created_at", keyword: "immutable", message: "created_at must not change" }] };
                }
                if (typeof diskData.project_id === "string" && typeof plannedData.project_id === "string"
                    && diskData.project_id !== plannedData.project_id) {
                    return { ok: false, errors: [{ path: "/project_id", keyword: "immutable", message: "project_id must not change" }] };
                }
                // schema downgrade refusal
                if (typeof diskData.schema_version === "number" && typeof plannedData.schema_version === "number"
                    && diskData.schema_version > plannedData.schema_version) {
                    return { ok: false, errors: [{ path: "/schema_version", keyword: "version", message: "disk schema_version > incoming; refuse to downgrade" }] };
                }
                // semantic no-op
                var plannedHash = helpers.contentHash(plannedData);
                if (plannedHash === diskHash) return { ok: true, written: false, noop: true, reason: "semantic-no-op" };
                // backup + write
                await backupAndRotate(path, helpers);
                var nowW = helpers.now();
                await publishWrite(path, helpers.serialize(withUpdatedAt(plannedData, nowW)), helpers);
                return { ok: true, written: true, updated_at: nowW };
            } catch (e) {
                return { ok: false, errors: [String(e.message || e)] };
            } finally {
                await releaseLock(lp, lock.token);
            }
        }

        return { readText: readText, writeAtomic: writeAtomic };
    }

    // ── Real UXP io binding (in-host) — maps to step-0 probe-verified
    // primitives. deps = { fs: require("fs"), lfs: uxp.storage.localFileSystem,
    // formats: uxp.storage.formats }. NOT exercised in Node (lfs absent);
    // verified by in-host smoke. ────────────────────────────────────────
    function makeUxpIo(deps) {
        var fs = deps.fs, lfs = deps.lfs, formats = deps.formats;
        function urlOf(p) { return "file:" + p; }
        async function folderOf(dir) { return await lfs.getEntryWithUrl(urlOf(dir)); }
        return {
            stat: async function (p) {
                try {
                    var st = fs.lstatSync(p);
                    return {
                        exists: true,
                        isFile: typeof st.isFile === "function" ? st.isFile() : true,
                        isDir: typeof st.isDirectory === "function" ? st.isDirectory() : false,
                        size: typeof st.size === "number" ? st.size : undefined,
                        mtimeMs: st.mtime ? (new Date(st.mtime)).getTime() : undefined
                    };
                } catch (e) {
                    // Distinguish missing from permission/other so readText returns
                    // the correct kind — a permission-denied read must NOT look like
                    // "missing" (which would drive a wrong init-write). codex-audit A1.
                    // UXP errors carry NO Node-style .code (in-host probe 2026-06-16:
                    // .code/.message both undefined); they surface as String(e) = a
                    // bare libuv numeric code. PROBE-VERIFIED 2026-06-16:
                    //   -4058 = ENOENT (missing)
                    //   -4048 = EPERM  (access denied — `C:\System Volume Information`
                    //                   and the locked SAM hive both yielded it)
                    //   -4082 = EBUSY  (locked/busy, e.g. pagefile) → io-error
                    // -4092 (EACCES) is the libuv value but was NOT triggered in the
                    // probe (Windows access-denied came back as -4048); kept as an
                    // inferred fallback only. Anything not matched → io-error
                    // (conservative: NOT "missing"). Match BOTH Node (.code) and UXP.
                    // EXACT match on the verified bare-numeric UXP format (String(e)
                    // is exactly "-4058" etc.) — NOT indexOf, which would misclassify
                    // a longer code or a message merely CONTAINING the substring
                    // (codex re-audit B: e.g. "-40580" or "EACCES … -4058" → missing).
                    var s = (String((e && e.message) || e)).trim();
                    var code = e && e.code;
                    if (code === "ENOENT" || s === "-4058") return { exists: false };
                    if (code === "EACCES" || code === "EPERM"
                        || s === "-4048"      // EPERM — verified in-host
                        || s === "-4092") {   // EACCES — inferred fallback
                        return { exists: true, error: "permission", errors: [s] };
                    }
                    return { exists: true, error: "io-error", errors: [s] };
                }
            },
            readText: async function (p) {
                // Strict UTF-8: read raw bytes + strict decode so malformed bytes
                // surface as an error instead of silently becoming U+FFFD (which
                // fs.readFileSync(p,"utf8") does) — matches storage_node. UXP has NO
                // TextDecoder (in-host probe 2026-06-16) and fs.readFileSync(p) with
                // no encoding returns an ArrayBuffer, so we use the pure-JS strict
                // decoder. codex-audit A1.
                var raw = fs.readFileSync(p); // no encoding → raw bytes (ArrayBuffer in UXP)
                var bytes;
                if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
                else if (raw && raw.buffer) bytes = new Uint8Array(raw.buffer, raw.byteOffset || 0, (raw.byteLength != null ? raw.byteLength : raw.length));
                else if (typeof raw === "string") return raw; // a lenient runtime handed back a string
                else bytes = new Uint8Array(raw);
                if (typeof TextDecoder !== "undefined") {
                    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
                }
                return strictUtf8Decode(bytes); // UXP path: no TextDecoder
            },
            createExclusive: async function (p, text) {
                var sp = splitPath(p);
                var folder = await folderOf(sp.dir);
                var entry;
                try { entry = await folder.createEntry(sp.base, { overwrite: false }); }
                catch (e) { return false; } // already exists (probe: throws "already exists")
                await entry.write(text, { format: formats.utf8 });
                return true;
            },
            writeOverwrite: async function (p, text) { fs.writeFileSync(p, text, "utf8"); },
            move: async function (src, dst) {
                var srcEntry = await lfs.getEntryWithUrl(urlOf(src));
                var sp = splitPath(dst);
                var dstFolder = await folderOf(sp.dir);
                await srcEntry.moveTo(dstFolder, { newName: sp.base, overwrite: true });
            },
            remove: async function (p) {
                var entry = await lfs.getEntryWithUrl(urlOf(p)); // fs.unlinkSync unavailable
                await entry.delete();
            },
            listDir: async function (dir) {
                var folder = await folderOf(dir);
                var entries = await folder.getEntries();
                return entries.map(function (e) { return e.name; });
            }
        };
    }

    return { createStorageUxp: createStorageUxp, makeUxpIo: makeUxpIo, _splitPath: splitPath, _strictUtf8Decode: strictUtf8Decode };
}));
