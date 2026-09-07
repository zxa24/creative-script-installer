"use strict";

/**
 * lib/import_state_store.js
 *
 * Read/write the per-document "import state" used by edit-mode imports.
 * Persists inside the InDesign document itself via Document.insertLabel
 * — a sync scripting API. See `probes/probe_label_io.idjs` for the
 * empirical contract this module relies on:
 *   - insertLabel + extractLabel are SYNC in UXP idjs (no Promise)
 *   - per-label payload tolerates ≥4 MB (Client-A 113-segs ≈ 15 KB → comfortable)
 *   - saveACopy preserves labels (critical for v2 pipeline workflow)
 *
 * This module is the ONLY caller of insertLabel/extractLabel for the
 * import-state key. Other code consumes it via:
 *
 *   var store = require("./lib/import_state_store.js");
 *   var state = store.read(doc);             // null if absent / corrupt
 *   store.write(doc, newState);              // overwrites the label
 *   store.clear(doc);                        // remove (sets empty)
 *   store.LABEL_KEY                          // shared with doc_provenance.js
 *
 * Schema v1 (also used as wire format inside the export package):
 *   {
 *     "schema": 1,
 *     "last_import_at": "ISO-8601 UTC",
 *     "import_v2_rev": "...",                  // import script rev that wrote
 *     "document": {
 *       "name": "<doc>.translated.indd",
 *       "source_hash": null                    // reserved for future doc-id
 *     },
 *     "package_path": "abs path to the package that produced this state",
 *     "segments": {
 *       "<TID>": {
 *         "applied_hash": "djb2-hex of (target_text + emphasis_runs)",
 *         "applied_paragraph_style": "_T_p_…",  // null if no cluster style
 *         "applied_target_text_len": 146,
 *         "cluster_fingerprint": "9c76",        // forward-compat for profile reuse
 *         "applied_emphasis_run_count": 1
 *       }, …
 *     }
 *   }
 *
 * The store does NOT compute the per-segment hash — that's edit-mode's job
 * via the diff-classify stage. The store only persists / retrieves.
 */

var LABEL_KEY = "translation_import_state_v1";
var SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _safeInsert(doc, key, value) {
    // probe_label_io.idjs confirmed sync. Defensive: if some future UXP
    // build flips to Promise, surface as a write error rather than silent
    // partial — caller can then route to a sidecar fallback.
    try {
        var r = doc.insertLabel(key, value || "");
        if (r && typeof r.then === "function") {
            return { ok: false, err: "insertLabel returned a Promise (UXP API change?)" };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, err: String(e && (e.message || e)) };
    }
}

function _safeExtract(doc, key) {
    try {
        var v = doc.extractLabel(key);
        if (v && typeof v.then === "function") return { ok: false, err: "extractLabel returned a Promise" };
        return { ok: true, value: v || "" };
    } catch (e) {
        return { ok: false, err: String(e && (e.message || e)) };
    }
}

function _validateStateShape(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (typeof obj.schema !== "number") return false;
    if (obj.segments && typeof obj.segments !== "object") return false;
    return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * read(doc) → state object | null
 *
 * Returns null when:
 *   - no label set
 *   - label payload doesn't parse as JSON
 *   - parsed object lacks `schema` field (defends against future label collisions)
 *
 * Never throws (UXP idjs errors from the underlying API are swallowed).
 */
function read(doc) {
    if (!doc) return null;
    var ext = _safeExtract(doc, LABEL_KEY);
    if (!ext.ok || !ext.value) return null;
    var raw = String(ext.value).replace(/^\s+|\s+$/g, "");
    if (!raw || raw.charAt(0) !== "{") return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    return _validateStateShape(parsed) ? parsed : null;
}

/**
 * write(doc, state) → { ok, bytes, err? }
 *
 * Stamps last_import_at automatically (overwrite any caller value to
 * guarantee monotonic ordering across runs). Other fields are passed
 * through; caller owns schema.
 *
 * Pre-validates shape and stringifies before insertLabel so a bad input
 * surfaces here rather than corrupting the label silently.
 */
function write(doc, state) {
    if (!doc) return { ok: false, err: "no doc" };
    if (!state || typeof state !== "object") return { ok: false, err: "state must be object" };

    var payload = {};
    for (var k in state) {
        if (Object.prototype.hasOwnProperty.call(state, k)) payload[k] = state[k];
    }
    if (typeof payload.schema !== "number") payload.schema = SCHEMA_VERSION;
    payload.last_import_at = new Date().toISOString();
    if (!payload.segments || typeof payload.segments !== "object") payload.segments = {};

    var json;
    try { json = JSON.stringify(payload); }
    catch (eS) { return { ok: false, err: "JSON.stringify: " + (eS && eS.message || eS) }; }

    var ins = _safeInsert(doc, LABEL_KEY, json);
    if (!ins.ok) return { ok: false, err: ins.err, bytes: json.length };
    return { ok: true, bytes: json.length };
}

/**
 * clear(doc) → { ok, err? }
 *
 * Setting the label to "" effectively removes it (extractLabel returns
 * empty string). Used by:
 *   - Operator "force full import next time" toolchain entry point
 *   - Bridge automation that explicitly wants to reset state
 */
function clear(doc) {
    if (!doc) return { ok: false, err: "no doc" };
    return _safeInsert(doc, LABEL_KEY, "");
}

/**
 * exportInjection(doc) → { jsonString | null, err? }
 *
 * Convenience for the export pipeline: read the raw label and return it
 * verbatim (string) if valid. Returns null when no state present (so the
 * caller can simply skip writing import_state.json into the package).
 */
function exportInjection(doc) {
    var state = read(doc);
    if (!state) return { jsonString: null };
    try { return { jsonString: JSON.stringify(state) }; }
    catch (e) { return { jsonString: null, err: String(e && (e.message || e)) }; }
}

// ---------------------------------------------------------------------------
// #67 — "never actually applied" entries
// ---------------------------------------------------------------------------

/**
 * isUnappliedEntry(entry) → bool
 *
 * THE DEFINITION of a segment entry that does NOT describe the document.
 * Lives here, with a name and a test, because it is a claim about the STATE
 * SHAPE — the moment A0 changes which fields a writer emits, this predicate
 * has to change with it, and a definition scattered inline across repair code
 * cannot be found to be updated.
 *
 * Two shapes qualify:
 *
 *  1. `applied === false` — written deliberately by a post-#67 writer that
 *     located nothing (or whose text write threw). Such an entry carries NO
 *     `applied_hash` at all, so diff-classify can never hash-match it into
 *     `noop`; it falls through to `full` and gets retried. This is the shape
 *     we want going forward.
 *
 *  2. 🔴 LEGACY POISON (pre-#67 writers, and the reason this predicate exists):
 *     an entry that carries an `applied_hash` while admitting
 *     `applied_paragraph_style === null` AND `cluster_fingerprint === null`.
 *     Those two fields were only ever assigned inside
 *     `if (__lp2 && __lp2.para)` in v2_pipeline's label writer, while
 *     `applied_hash` was assigned OUTSIDE it — so the combination is
 *     mechanically impossible for a row that was actually located and written.
 *     It means: "I recorded the hash of the text I INTENDED to write, and I
 *     never found a paragraph to write it into."
 *
 *     Why it matters: `applied_hash` is computed from `row.target_text`, never
 *     from the paragraph, so the next import hash-matches it, classifies the
 *     row `noop`, and skips it entirely — the first failure permanently seals
 *     itself in. Measured on a real document 2026-08-22: 48 of 107 entries,
 *     including the one heading the operator had actually edited.
 */
function isUnappliedEntry(entry) {
    if (!entry || typeof entry !== "object") return false;
    if (entry.applied === false) return true;
    return !!entry.applied_hash
        && entry.applied_paragraph_style === null
        && entry.cluster_fingerprint === null;
}

/**
 * findUnappliedEntries(state) → [tid, …]
 *
 * The tids whose entries fail isUnappliedEntry's contract. Read-only.
 */
function findUnappliedEntries(state) {
    var out = [];
    if (!state || !state.segments || typeof state.segments !== "object") return out;
    var keys = Object.keys(state.segments);
    for (var i = 0; i < keys.length; i++) {
        if (isUnappliedEntry(state.segments[keys[i]])) out.push(keys[i]);
    }
    return out;
}

/**
 * stripUnappliedEntries(state) → { state, removed: [tid, …] }
 *
 * Returns a NEW state with the never-applied entries dropped; the input is
 * not mutated. Dropping (rather than `clear()`-ing the whole label) is the
 * point: on the measured document, 48 entries are poison and 59 are genuine
 * records of applied text. `clear()` would throw away all 107 and force the
 * entire document back through the full pipeline — amputation where the
 * legitimate entries are individually identifiable.
 *
 * A dropped entry reads as "no prior state" next round → `full` → retried.
 *
 * PURE: no document I/O. The caller decides whether/when to persist it, and
 * how the operator triggers that.
 */
function stripUnappliedEntries(state) {
    var removed = [];
    if (!state || !state.segments || typeof state.segments !== "object") {
        return { state: state, removed: removed };
    }
    var next = {};
    var keys = Object.keys(state);
    for (var k = 0; k < keys.length; k++) {
        if (keys[k] !== "segments") next[keys[k]] = state[keys[k]];
    }
    next.segments = {};
    var segKeys = Object.keys(state.segments);
    for (var i = 0; i < segKeys.length; i++) {
        var tid = segKeys[i];
        if (isUnappliedEntry(state.segments[tid])) { removed.push(tid); continue; }
        next.segments[tid] = state.segments[tid];
    }
    return { state: next, removed: removed };
}

/**
 * mergeNotAppliedEntries(segments, deferred) → { added, collisions }   (#62/#67)
 *
 * Writes the "seen but NOT applied" notes into an ALREADY-POPULATED segments
 * map — every applied row must have claimed its key first. MUTATES `segments`.
 *
 * 🔴 Why this is a second pass and not an inline write:
 * an un-located row has no position in the workDoc, so the only key it can
 * offer is its SOURCE tid — a guess. A row that DID locate gets re-keyed by
 * `_computeWorkDocTid` to the tid the next export will produce for its
 * paragraph, and that value can legitimately equal some other row's source tid.
 * Written in one pass, whichever came later won, so the outcome depended on row
 * order. Measured on a real document 2026-08-22: located row
 * `fallback_17081_4798` was re-keyed to `fallback_17081_1563` and overwrote the
 * un-located row that actually IS `fallback_17081_1563` — one "not applied"
 * record silently lost, detectable only as `not_applied=49` in the log against
 * 48 entries on disk.
 *
 * Resolution: the APPLIED entry keeps the key. It describes text that is really
 * in the document; the not-applied note is only a remark about a row we could
 * not place.
 *
 * ⚠ A row reported in `collisions` therefore gets NO entry at all. That is the
 * safe direction — no entry means diff-classify sees "no prior state", routes
 * the row to `full`, and retries it, so nothing is ever mistaken for done — but
 * the caller MUST say so out loud. "Silently recorded as done" was #62;
 * "silently not recorded" is the same disease with a luckier outcome.
 *
 * ⚠ The underlying ambiguity is NOT fixed here: after this, key
 * `fallback_17081_1563` holds the LOCATED row's record while a different,
 * un-located row is also called `fallback_17081_1563`. Re-keying makes tids
 * non-unique; this function only stops that from eating records. See TODO #73.
 */
function mergeNotAppliedEntries(segments, deferred) {
    var added = 0, collisions = [];
    if (!segments || typeof segments !== "object" || !deferred || !deferred.length) {
        return { added: added, collisions: collisions };
    }
    for (var i = 0; i < deferred.length; i++) {
        var d = deferred[i];
        if (!d || !d.key) continue;
        if (Object.prototype.hasOwnProperty.call(segments, d.key)) {
            collisions.push({
                key: d.key,
                src_tid: d.src_tid,
                reason: d.reason,
                held_by: (segments[d.key] || {}).src_tid || null
            });
            continue;
        }
        segments[d.key] = {
            applied: false,
            not_applied_reason: d.reason,
            src_tid: d.src_tid
        };
        added++;
    }
    return { added: added, collisions: collisions };
}

/**
 * #73 counter predicate — pure, so the rule is testable.
 *
 * The pass-1 write in v2_pipeline is `segments[key] = {...}` with no guard: when
 * two APPLIED rows compute the same key, the later silently replaces the earlier.
 * `mergeNotAppliedEntries` above reports the applied-vs-unapplied clash; nothing
 * reported this one.
 *
 * 🔴 This function decides NOTHING about what should happen — the write proceeds
 * either way. It exists so the clash can be COUNTED before `#73` decides how to
 * key the label at all. It lives here, next to `mergeNotAppliedEntries`, because
 * it is the same kind of claim (about the state shape) and because a visibility
 * gate nobody can test is how the previous one stopped working.
 *
 * @returns {null|{key,loser_src_tid,winner_src_tid}} null when the key is free.
 */
function detectAppliedKeyOverwrite(segments, key, winnerSrcTid) {
    if (!segments || typeof segments !== "object" || !key) return null;
    if (!Object.prototype.hasOwnProperty.call(segments, key)) return null;
    return {
        key: key,
        loser_src_tid: (segments[key] || {}).src_tid || null,
        winner_src_tid: winnerSrcTid || null
    };
}

module.exports = {
    detectAppliedKeyOverwrite: detectAppliedKeyOverwrite,
    LABEL_KEY: LABEL_KEY,
    mergeNotAppliedEntries: mergeNotAppliedEntries,
    SCHEMA_VERSION: SCHEMA_VERSION,
    read: read,
    write: write,
    clear: clear,
    exportInjection: exportInjection,
    isUnappliedEntry: isUnappliedEntry,
    findUnappliedEntries: findUnappliedEntries,
    stripUnappliedEntries: stripUnappliedEntries,
    // exposed for unit tests
    _internal: {
        validateStateShape: _validateStateShape
    }
};
