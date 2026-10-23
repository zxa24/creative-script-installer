"use strict";
/**
 * lib/project_meta_label.js — persist the project `_meta` object inside the
 * InDesign document via a KEYED label.
 *
 * Spec (project_meta_consolidated §10 OPEN-A/B, user-locked 2026-06-15): the
 * key is "project_meta_v1" — a SEPARATE keyed label, NOT the shared
 * `document.label` string the font-mapping per-project override uses, so there
 * is no double-occupancy / length-collision risk.
 *
 * Purpose: carry the webapp-origin `_meta` (especially `source_language`, which
 * InDesign cannot infer from a `.translated.indd`) forward through the
 * import→export round-trip, so the export can write a schema-valid `_meta.json`
 * with the designer's name added. Contributors-carry (Tier-3); NOT the deferred
 * version-lineage.
 *
 * insertLabel/extractLabel are sync in UXP idjs and survive saveACopy —
 * empirically established by lib/import_state_store.js + probes/probe_label_io.idjs,
 * which this module mirrors.
 *
 *   var Label = require("./lib/project_meta_label.js");
 *   Label.write(doc, metaObj);    // store (best-effort; caller owns validity)
 *   var meta = Label.read(doc);   // retrieve (null if absent/corrupt/foreign)
 */

var LABEL_KEY = "project_meta_v1";

function _safeInsert(doc, key, value) {
    try {
        var r = doc.insertLabel(key, value || "");
        if (r && typeof r.then === "function") return { ok: false, err: "insertLabel returned a Promise (UXP API change?)" };
        return { ok: true };
    } catch (e) { return { ok: false, err: String(e && (e.message || e)) }; }
}

function _safeExtract(doc, key) {
    try {
        var v = doc.extractLabel(key);
        if (v && typeof v.then === "function") return { ok: false, err: "extractLabel returned a Promise" };
        return { ok: true, value: v || "" };
    } catch (e) { return { ok: false, err: String(e && (e.message || e)) }; }
}

/**
 * read(doc) → meta object | null.
 * null when: no label / unparseable JSON / not a project_meta payload (the
 * schema_version-number check defends against label collisions). Never throws.
 */
function read(doc) {
    if (!doc) return null;
    var ext = _safeExtract(doc, LABEL_KEY);
    if (!ext.ok || !ext.value) return null;
    var raw = String(ext.value).replace(/^\s+|\s+$/g, "");
    if (!raw || raw.charAt(0) !== "{") return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed || typeof parsed !== "object" || typeof parsed.schema_version !== "number") return null;
    return parsed;
}

/**
 * write(doc, meta) → { ok, bytes, err? }.
 * Stores the meta object verbatim (caller owns validity; the export validates
 * before writing _meta.json). Best-effort — caller treats failure as non-fatal.
 */
function write(doc, meta) {
    if (!doc) return { ok: false, err: "no doc" };
    if (!meta || typeof meta !== "object") return { ok: false, err: "meta must be an object" };
    var json;
    try { json = JSON.stringify(meta); }
    catch (e) { return { ok: false, err: "JSON.stringify: " + (e && e.message || e) }; }
    var ins = _safeInsert(doc, LABEL_KEY, json);
    if (!ins.ok) return { ok: false, err: ins.err, bytes: json.length };
    return { ok: true, bytes: json.length };
}

function clear(doc) {
    if (!doc) return { ok: false, err: "no doc" };
    return _safeInsert(doc, LABEL_KEY, "");
}

/**
 * fillMissingKeysFromLabel(packageMeta, labelMeta) -> new object
 *
 * The import settings panel pre-fills from the PACKAGE's `_meta.json`. The doc
 * label is written by import and read only by export, so a value the operator
 * typed into that panel is stored but never shown back to him — "I set it, then
 * it was gone". This lets the panel fall back to the label for keys the package
 * does not carry.
 *
 * 🔴 The rule is KEY PRESENCE, deliberately — not "does the package have a
 * value". Two independent reasons:
 *   (a) `deadline` and `target_language` are `['string','null']` in the schema,
 *       so `null` is LEGAL content for them — "empty" is a real answer there.
 *   (b) 🔴 more importantly, a package's `_meta` is NOT guaranteed schema-valid
 *       at all. Measured 2026-08-23: a real doc label in the wild carried only
 *       `{workflow_mode, deadline, schema_version}` — 3 of 7 required keys. So
 *       "what does the schema allow" cannot be the deciding question; the only
 *       structural fact available is whether the key is there.
 * ⚠ CORRECTION (2026-08-23): an earlier version of this comment claimed
 * "`project_name` has no minLength". It does — `minLength: 1` — so `""` is
 * schema-INVALID for it, and `null` is too (`type: "string"`). The rule below is
 * unchanged; only the stated reason was wrong. Left visible on purpose: the
 * wrong reason would have made the next reader think `""` round-trips fine.
 * Asking "is that a value?" would be a product policy question (and the
 * existing pre-fill code already answers it two different ways: `x || ""` for
 * some fields, `(x == null) ? "" : x` for others). Key presence is a structural
 * fact, so this function never has to answer it — and the package always wins
 * whenever it says anything at all, including `null` and `""`.
 *
 * ⚠ `contributors` is treated as one key, not merged field-by-field: if the
 * package carries `contributors` at all (even `{}`), the package wins. Merging
 * inside it would re-introduce exactly the "does empty count" question this
 * function exists to avoid.
 *
 * ⚠ Never invents values: a key absent from BOTH stays absent.
 *
 * 🔴 There USED to be a SECOND emptiness predicate here:
 * `project_meta_uxp.assessCarriedMeta` treated an empty string as EMPTY, while this
 * function treats the key being PRESENT as decisive whatever the value is. They were
 * never inconsistent — they answered different questions:
 *   · here:              "which side wins?"   -> presence settles it
 *   · assessCarriedMeta: "must a human act?"  -> an empty string still means he has
 *                                                to type it
 * That second predicate was DELETED 2026-08-28 together with the export dialog's
 * metadata hint (owner ruling: that area no longer talks to the operator), so today
 * there is only one. The distinction stays written down because it is the answer to
 * "why doesn't this function just skip empty values?" — and because the pre-existing
 * `x || ""` vs `(x == null) ? "" : x` split in the import dialog became an
 * unexplained inconsistency nobody could safely touch for exactly the lack of it.
 */
function fillMissingKeysFromLabel(packageMeta, labelMeta) {
    var out = {};
    var k;
    if (packageMeta && typeof packageMeta === "object") {
        for (k in packageMeta) {
            if (Object.prototype.hasOwnProperty.call(packageMeta, k)) out[k] = packageMeta[k];
        }
    }
    if (!labelMeta || typeof labelMeta !== "object") return out;
    for (k in labelMeta) {
        if (!Object.prototype.hasOwnProperty.call(labelMeta, k)) continue;
        // package wins on PRESENCE, whatever the value is
        if (Object.prototype.hasOwnProperty.call(out, k)) continue;
        out[k] = labelMeta[k];
    }
    return out;
}

module.exports = {
    fillMissingKeysFromLabel: fillMissingKeysFromLabel,
    LABEL_KEY: LABEL_KEY,
    read: read,
    write: write,
    clear: clear
};
