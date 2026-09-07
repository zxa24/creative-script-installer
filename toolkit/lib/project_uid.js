"use strict";

/**
 * lib/project_uid.js — stable per-project identity label (AC8).
 *
 * Charter r1 AC8 + arch ruling 2026-07-05: the version-compare identity guard
 * needs a rename-robust project_uid on the document. The de-risk probe
 * (probes/20260621_01_project_uid_persistence.idjs) proved `doc.insertLabel
 * ("project_uid", …)` survives save + reopen + round-2 edit + Save-As(rename),
 * but NO production code writes it. Export is read-only (never saves the doc) so
 * it CANNOT persist a label; IMPORT already saves the doc (workDoc.save) and
 * writes the project_meta_v1 label — so import is where the uid is minted.
 *
 * `ensureUid(doc, opts)` mints a stable uid ONLY when absent (idempotent: an
 * existing uid is preserved verbatim across every re-import), and the save that
 * follows persists it. A later export reads it via `readUid` for the manifest +
 * AC8 checkIdentity.
 *
 * Label store mirrors project_meta_label.js (sync insertLabel/extractLabel,
 * survives saveACopy). Never throws — a label failure must not block the save.
 */

var LABEL_KEY = "project_uid";

function readUid(doc) {
    if (!doc || typeof doc.extractLabel !== "function") return "";
    try {
        var v = doc.extractLabel(LABEL_KEY);
        if (v && typeof v.then === "function") return "";   // UXP should be sync
        return String(v || "").replace(/^\s+|\s+$/g, "");
    } catch (e) { return ""; }
}

// djb2 → 12 hex chars. Pure, deterministic; enough entropy for a per-doc id
// (uniqueness is really carried by the timestamp; the hash just decorrelates
// same-millisecond docs by name).
function _shortHash(str) {
    var h = 5381 >>> 0;
    var s = String(str == null ? "" : str);
    for (var i = 0; i < s.length; i++) {
        h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
    }
    var hex = ("00000000" + h.toString(16)).slice(-8);
    // fold a second pass for a couple more chars of spread
    var h2 = 5381 >>> 0;
    for (var j = s.length - 1; j >= 0; j--) h2 = (((h2 << 5) + h2) ^ s.charCodeAt(j)) >>> 0;
    return hex + ("0000" + (h2 & 0xFFFF).toString(16)).slice(-4);
}

// Build a dir-safe, sortable-ish uid: "puid-<compactTs>-<12hex>".
function mintUid(opts) {
    opts = opts || {};
    var ts = String(opts.compactTs || "00000000000000").replace(/[^0-9A-Za-z]/g, "");
    var seed = String(opts.seed || "") + "|" + ts;
    return "puid-" + ts + "-" + _shortHash(seed);
}

/**
 * ensureUid(doc, opts) → { uid, minted, ok, err? }
 *   opts.compactTs : compact timestamp string (caller supplies; e.g. compactTimestampNow())
 *   opts.seed      : disambiguator (e.g. doc name) folded into the mint hash
 * Idempotent: returns the existing uid untouched when present; mints + writes
 * only when absent. Best-effort — never throws.
 */
function ensureUid(doc, opts) {
    var existing = readUid(doc);
    if (existing) return { uid: existing, minted: false, ok: true };
    if (!doc || typeof doc.insertLabel !== "function") {
        return { uid: "", minted: false, ok: false, err: "no doc/insertLabel" };
    }
    var uid = mintUid(opts);
    try {
        var r = doc.insertLabel(LABEL_KEY, uid);
        if (r && typeof r.then === "function") return { uid: uid, minted: true, ok: false, err: "insertLabel returned a Promise" };
        return { uid: uid, minted: true, ok: true };
    } catch (e) {
        return { uid: uid, minted: true, ok: false, err: String(e && (e.message || e)) };
    }
}

module.exports = {
    LABEL_KEY: LABEL_KEY,
    readUid: readUid,
    mintUid: mintUid,
    ensureUid: ensureUid,
    _shortHash: _shortHash
};
