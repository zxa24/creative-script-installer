"use strict";

/**
 * lib/version_manifest.js — version-compare `versions/manifest.json` line-format
 * writer core (IT side of the cross-repo contract).
 *
 * SoT: audit-logs/version_compare_manifest_contract_v1.md (arch-owned·FROZEN).
 * This module is the PURE computation half — no host / DOM / fs. It takes raw
 * file BYTES + plain objects in and returns manifest structures out, so it runs
 * identically in UXP idjs (require) and Node (test runner). The host-side glue
 * (read prev package .zip, write versions/ dirs) lives in the export .idjs.
 *
 * Contract mapping:
 *   §2  buildManifest / version entry shape
 *   §3  makeVersionId / ensureUniqueVersionId  (unique + Windows dir-safe + ms)
 *   §4  contentHash  — raw-bytes SHA-256, two-file digest (★cross-repo byte-identity anchor)
 *   §5  validateChain — reader must-surface parity (integrity / chain / order)
 *   §6  carryForward — FLATTEN + append + recompute tip (bootstrap from no-versions/ pkg)
 *   AC8 checkIdentity — project_uid guard (mismatch → mustSurface; missing → unverifiable)
 *
 * ✅ HASH GATE PASSED (contract §4 impl-note + drift #3 / charter §8.5, arch
 * 2026-07-05): cross-repo byte-identity confirmed — vc-webapp measured
 * SHA256Pure == crypto.subtle == Node crypto over ascii/LF/CJK/BOM+CRLF/empty.
 * content_hash is FROZEN. MUST hash RAW on-disk bytes only (never
 * hex(decodedString): utf8Encode diverges from disk bytes on BOM/CRLF/non-UTF8
 * → AC6 false-positives). sha256HexOfBytes below takes raw bytes; contentHash
 * feeds it the files' raw bytes. The core is the same FIPS-180-4 algorithm as
 * the FROZEN lib/vendor/project_meta/sha256_pure.js (self-contained here because
 * that frozen copy exposes only hex(str)/bytes(str), no raw-bytes entry) and is
 * asserted byte-identical to BOTH that frozen core AND Node native crypto in
 * tests/version_manifest_tests.js. If arch re-syncs the frozen copy to add a
 * raw-bytes `hexBytes`, this can delegate to it and drop the local core.
 */

var MANIFEST_VERSION = 1;
var LINEAGE_FORMAT = "single-file-carryforward-v1";
var HASH_PREFIX = "sha256:";

// ---------------------------------------------------------------------------
// raw-bytes SHA-256 (FIPS 180-4) — hashes BYTES, not a string. This is the
// §4 requirement ("raw 字节…不得先 JSON.parse→re-stringify"). Byte-for-byte
// identical to sha256_pure.js's internal hashBytes (same K/H/rotr), verified
// in the unit test, so IT and the webapp (crypto.subtle over the same bytes)
// agree.
// ---------------------------------------------------------------------------

var _K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function _rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

// bytes: Uint8Array | Array<number> | ArrayBuffer. Returns 64-char lowercase hex.
function sha256HexOfBytes(bytes) {
    var padded;
    if (bytes instanceof ArrayBuffer) {
        padded = Array.prototype.slice.call(new Uint8Array(bytes));
    } else if (typeof Uint8Array !== "undefined" && bytes instanceof Uint8Array) {
        padded = Array.prototype.slice.call(bytes);
    } else if (bytes && typeof bytes.length === "number") {
        padded = Array.prototype.slice.call(bytes);
    } else {
        throw new Error("version_manifest.sha256HexOfBytes: unsupported bytes type");
    }

    var H = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];

    var bitLen = padded.length * 8;
    padded.push(0x80);
    while ((padded.length % 64) !== 56) padded.push(0);
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    padded.push((hi >>> 24) & 0xFF, (hi >>> 16) & 0xFF, (hi >>> 8) & 0xFF, hi & 0xFF);
    padded.push((lo >>> 24) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 8) & 0xFF, lo & 0xFF);

    var W = new Array(64);
    for (var off = 0; off < padded.length; off += 64) {
        for (var t = 0; t < 16; t++) {
            W[t] = ((padded[off + t * 4]) << 24)
                 | ((padded[off + t * 4 + 1]) << 16)
                 | ((padded[off + t * 4 + 2]) << 8)
                 | (padded[off + t * 4 + 3]);
        }
        for (t = 16; t < 64; t++) {
            var s0 = _rotr(7, W[t - 15]) ^ _rotr(18, W[t - 15]) ^ (W[t - 15] >>> 3);
            var s1 = _rotr(17, W[t - 2]) ^ _rotr(19, W[t - 2]) ^ (W[t - 2] >>> 10);
            W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
        }
        var a = H[0], b = H[1], c = H[2], d = H[3];
        var e = H[4], f = H[5], g = H[6], h = H[7];
        for (t = 0; t < 64; t++) {
            var S1 = _rotr(6, e) ^ _rotr(11, e) ^ _rotr(25, e);
            var ch = (e & f) ^ ((~e) & g);
            var T1 = (h + S1 + ch + _K[t] + W[t]) | 0;
            var S0 = _rotr(2, a) ^ _rotr(13, a) ^ _rotr(22, a);
            var mj = (a & b) ^ (a & c) ^ (b & c);
            var T2 = (S0 + mj) | 0;
            h = g; g = f; f = e;
            e = (d + T1) | 0;
            d = c; c = b; b = a;
            a = (T1 + T2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    var hex = "";
    for (var i = 0; i < 8; i++) {
        var v = H[i] >>> 0;
        hex += ("00000000" + v.toString(16)).slice(-8);
    }
    return hex;
}

// ASCII string → byte array (each char guaranteed < 128 for hex + ":" inputs).
function _asciiBytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xFF);
    return out;
}

// ---------------------------------------------------------------------------
// §4 content_hash — two-file raw-bytes digest.
//   h_seg   = sha256(bytes segments.json)
//   h_trans = sha256(bytes translations.json)
//   content_hash = "sha256:" + sha256( ascii(h_seg + ":" + h_trans) )
// ---------------------------------------------------------------------------

function contentHash(segBytes, transBytes) {
    if (segBytes == null || transBytes == null) {
        throw new Error("version_manifest.contentHash: both segBytes and transBytes required (§7 both files mandatory)");
    }
    var hSeg = sha256HexOfBytes(segBytes);
    var hTrans = sha256HexOfBytes(transBytes);
    var inner = sha256HexOfBytes(_asciiBytes(hSeg + ":" + hTrans));
    return HASH_PREFIX + inner;
}

// ---------------------------------------------------------------------------
// §3 version_id — "YYYYMMDDThhmmss-SSSZ" from an ISO-8601 UTC string.
// Takes an ISO string (e.g. utcIsoNow() = "2026-07-04T19:35:46.123Z") so the
// module stays free of Date.now() (testable + workflow-safe).
// ---------------------------------------------------------------------------

function makeVersionId(isoUtc) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(String(isoUtc || ""));
    if (!m) {
        throw new Error("version_manifest.makeVersionId: not an ISO-8601 UTC string: " + isoUtc);
    }
    var ms = (m[7] || "0");
    while (ms.length < 3) ms += "0";
    ms = ms.slice(0, 3);
    return m[1] + m[2] + m[3] + "T" + m[4] + m[5] + m[6] + "-" + ms + "Z";
}

// Windows dir-safe check (§3): no \ / : * ? " < > | and no trailing dot/space.
function isDirSafe(name) {
    if (typeof name !== "string" || name.length === 0) return false;
    if (/[\\\/:\*\?"<>\| -]/.test(name)) return false;
    if (/[ .]$/.test(name)) return false;
    return true;
}

// §3: never silently overwrite an existing dir name — suffix on collision.
// existingIds: array or object-set of ids already used.
function ensureUniqueVersionId(existingIds, candidate) {
    var have = {};
    if (existingIds) {
        if (typeof existingIds.length === "number") {
            for (var i = 0; i < existingIds.length; i++) have[existingIds[i]] = 1;
        } else {
            have = existingIds;
        }
    }
    if (!have[candidate]) return candidate;
    var n = 2;
    while (have[candidate + "-" + n]) n++;
    return candidate + "-" + n;
}

// ---------------------------------------------------------------------------
// version entry builder (§2). payload = filenames actually present in the dir.
// ---------------------------------------------------------------------------

function buildVersionEntry(opts) {
    opts = opts || {};
    if (opts.segBytes == null || opts.transBytes == null) {
        throw new Error("version_manifest.buildVersionEntry: segBytes + transBytes required");
    }
    var entry = {
        content_hash: contentHash(opts.segBytes, opts.transBytes),
        version_id: String(opts.versionId || ""),
        parent: (opts.parent == null ? null : String(opts.parent)),
        project_uid: (opts.projectUid == null ? "" : String(opts.projectUid)),
        project_id: (opts.projectId == null ? "" : String(opts.projectId)),
        exported_at: (opts.exportedAt == null ? "" : String(opts.exportedAt)),
        payload: (opts.payload && opts.payload.slice) ? opts.payload.slice() : []
    };
    return entry;
}

function buildManifest(versions, tipHash) {
    return {
        manifest_version: MANIFEST_VERSION,
        lineage_format: LINEAGE_FORMAT,
        tip: tipHash,
        versions: versions
    };
}

// ---------------------------------------------------------------------------
// §6 carry-forward — flatten prior versions + append the current version.
//
//   priorVersions : array of version entries ALREADY FLAT (from a prev
//                   manifest.versions, or [bootstrapEntry] for a no-versions/
//                   package). NEVER nest a whole prior package (§1 FLATTEN).
//   priorTipHash  : the carried tip's content_hash (= new version's parent).
//                   null → this is the first version in a fresh chain.
//   currentEntry  : the current export's version entry (parent overwritten here).
//
// Returns { manifest, versions, appended, warnings } — pure; caller writes dirs.
// ---------------------------------------------------------------------------

function carryForward(opts) {
    opts = opts || {};
    var warnings = [];
    var priorVersions = (opts.priorVersions && opts.priorVersions.slice) ? opts.priorVersions.slice() : [];
    var priorTipHash = (opts.priorTipHash == null) ? null : String(opts.priorTipHash);
    var current = opts.currentEntry;
    if (!current || !current.content_hash) {
        throw new Error("version_manifest.carryForward: currentEntry with content_hash required");
    }

    // Build the used-id + used-hash sets from prior (flat) versions.
    var usedIds = {}, byHash = {};
    for (var i = 0; i < priorVersions.length; i++) {
        var pv = priorVersions[i];
        if (pv && pv.version_id) usedIds[pv.version_id] = 1;
        if (pv && pv.content_hash) byHash[pv.content_hash] = pv;
    }

    // parent link = carried tip.
    var appended = {
        content_hash: current.content_hash,
        version_id: ensureUniqueVersionId(usedIds, current.version_id),
        parent: priorTipHash,
        project_uid: current.project_uid == null ? "" : current.project_uid,
        project_id: current.project_id == null ? "" : current.project_id,
        exported_at: current.exported_at == null ? "" : current.exported_at,
        payload: (current.payload && current.payload.slice) ? current.payload.slice() : []
    };
    if (appended.version_id !== current.version_id) {
        warnings.push("version_id collision resolved: " + current.version_id + " → " + appended.version_id);
    }

    // Defensive: identical content_hash already in chain. In practice segments.json
    // carries an export timestamp so this is unreachable, but surface if it ever
    // happens (would otherwise be an ambiguous double-identity in the manifest).
    if (byHash[appended.content_hash]) {
        warnings.push("content_hash already present in carried chain (" + appended.content_hash
            + ") — appending anyway; identity collision, reader may must-surface");
    }

    var versions = priorVersions.concat([appended]);
    var manifest = buildManifest(versions, appended.content_hash);
    return { manifest: manifest, versions: versions, appended: appended, warnings: warnings };
}

// ---------------------------------------------------------------------------
// §5 chain validation — parity with the webapp reader's must-surface set, used
// for the IT-side AC5/AC6 self-check. Returns { ok, issues[] }.
// ---------------------------------------------------------------------------

function validateChain(manifest) {
    var issues = [];
    if (!manifest || typeof manifest !== "object") {
        return { ok: false, issues: ["manifest not an object"] };
    }
    if (manifest.manifest_version > MANIFEST_VERSION) {
        issues.push("manifest_version " + manifest.manifest_version + " > reader " + MANIFEST_VERSION + " (newer tool)");
    }
    var versions = manifest.versions || [];
    if (!versions.length) {
        return { ok: false, issues: issues.concat(["no versions"]) };
    }

    var byHash = {};
    var roots = 0;
    var v, i;
    for (i = 0; i < versions.length; i++) {
        v = versions[i];
        if (!v || !v.content_hash) { issues.push("version[" + i + "] missing content_hash"); continue; }
        if (byHash[v.content_hash]) issues.push("duplicate content_hash: " + v.content_hash);
        byHash[v.content_hash] = v;
    }

    // parent resolution + root count + child map for linearity/cycle checks.
    var childOf = {};
    for (i = 0; i < versions.length; i++) {
        v = versions[i];
        if (!v || !v.content_hash) continue;
        if (v.parent == null) { roots++; continue; }
        if (!byHash[v.parent]) { issues.push("parent not found for " + v.content_hash + " → " + v.parent); continue; }
        childOf[v.parent] = (childOf[v.parent] || 0) + 1;
    }
    if (roots === 0) issues.push("no root (parent=null) — chain broken or cyclic");
    if (roots > 1) issues.push("multiple roots (" + roots + ") — not a single linear chain");

    // branching → non-linear
    for (var pk in childOf) {
        if (childOf.hasOwnProperty(pk) && childOf[pk] > 1) {
            issues.push("branch at " + pk + " (" + childOf[pk] + " children) — order not linear");
        }
    }

    // tip must be present + be the unique leaf (no children).
    if (!manifest.tip) issues.push("no tip");
    else if (!byHash[manifest.tip]) issues.push("tip not in versions: " + manifest.tip);
    else if (childOf[manifest.tip]) issues.push("tip has children — not the leaf: " + manifest.tip);

    // cycle detection via walk from tip to a null root.
    if (manifest.tip && byHash[manifest.tip] && roots >= 1) {
        var seen = {}, cur = manifest.tip, steps = 0, cyclic = false;
        while (cur != null) {
            if (seen[cur]) { cyclic = true; break; }
            seen[cur] = 1;
            var node = byHash[cur];
            if (!node) break;
            cur = node.parent;
            if (++steps > versions.length + 1) { cyclic = true; break; }
        }
        if (cyclic) issues.push("cycle detected walking parent chain from tip");
    }

    return { ok: issues.length === 0, issues: issues };
}

// ---------------------------------------------------------------------------
// AC8 identity guard — project_uid mismatch → mustSurface (block silent
// fake-ancestor append); missing on either side → unverifiable (proceed but
// surface, fall back to project_id display-name compare).
//
// Returns { ok, severity, mustSurface, block, reason }.
//   severity: "match" | "unverifiable" | "mismatch"
//   block: true → do NOT silently append (mismatch of two present-and-different uids)
// ---------------------------------------------------------------------------

function checkIdentity(currentUid, currentProjectId, prevManifest) {
    currentUid = (currentUid == null) ? "" : String(currentUid);
    currentProjectId = (currentProjectId == null) ? "" : String(currentProjectId);
    var versions = (prevManifest && prevManifest.versions) || [];

    // Collect prior uids (should be uniform across the chain).
    var prevUids = {}, prevIds = {};
    for (var i = 0; i < versions.length; i++) {
        var v = versions[i] || {};
        if (v.project_uid) prevUids[v.project_uid] = 1;
        if (v.project_id) prevIds[v.project_id] = 1;
    }
    var prevUidList = Object.keys(prevUids);
    var prevIdList = Object.keys(prevIds);

    // Internal inconsistency in the selected package itself.
    if (prevUidList.length > 1) {
        return { ok: false, severity: "mismatch", mustSurface: true, block: true,
            reason: "selected package has non-uniform project_uid across its versions (" + prevUidList.join(", ") + ")" };
    }
    var prevUid = prevUidList[0] || "";

    if (currentUid && prevUid) {
        if (currentUid === prevUid) {
            return { ok: true, severity: "match", mustSurface: false, block: false, reason: "project_uid matches" };
        }
        return { ok: false, severity: "mismatch", mustSurface: true, block: true,
            reason: "project_uid mismatch — current='" + currentUid + "' selected='" + prevUid
                + "'; selecting another project's package would forge a fake ancestor" };
    }

    // Missing on one/both sides → cannot verify via uid. Fall back to project_id
    // display-name compare (weak) and always surface.
    var idNote = "";
    if (prevIdList.length && currentProjectId) {
        idNote = (prevIds[currentProjectId])
            ? " project_id display-name matches (weak, collision-prone)"
            : " project_id display-name differs (current='" + currentProjectId + "' selected='" + prevIdList.join(", ") + "')";
    }
    return { ok: false, severity: "unverifiable", mustSurface: true, block: false,
        reason: "project_uid absent (current='" + currentUid + "' selected='" + prevUid
            + "') — identity unverifiable; NOT silently trusting ancestry." + idNote };
}

module.exports = {
    MANIFEST_VERSION: MANIFEST_VERSION,
    LINEAGE_FORMAT: LINEAGE_FORMAT,
    HASH_PREFIX: HASH_PREFIX,
    sha256HexOfBytes: sha256HexOfBytes,
    contentHash: contentHash,
    makeVersionId: makeVersionId,
    isDirSafe: isDirSafe,
    ensureUniqueVersionId: ensureUniqueVersionId,
    buildVersionEntry: buildVersionEntry,
    buildManifest: buildManifest,
    carryForward: carryForward,
    validateChain: validateChain,
    checkIdentity: checkIdentity
};
