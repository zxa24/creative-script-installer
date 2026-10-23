"use strict";

/**
 * lib/written_paragraphs.js — TODO #147 (owner 2026-10-19): 2.2 Apply CJK Styles cleans only the
 * CHANGED content. "Changed" (D1) = a paragraph the LAST import wrote and nobody has touched since.
 *
 * The import records, per story, a hash of the text of every paragraph it wrote (not the text
 * itself: the label stays small). 2.2 hashes the paragraphs it finds NOW and takes the ones that
 * match; a paragraph edited by hand since (a hand-inserted soft break, a retyped word) no longer
 * matches and is left alone. After cleaning, 2.2 re-records the cleaned paragraphs' hashes, so a
 * second run still recognises them (cleaning again is then a no-op) and a hand edit after the first
 * run still drops the paragraph out of scope.
 *
 * The record lives in its OWN document label, not in translation_import_state_v1: that store stamps
 * last_import_at on every write, and 2.2 is not an import.
 *
 * Pure except read/write (document labels). Node-testable with a fake doc.
 */

var LABEL_KEY = "import_written_paragraphs_v1";
var SCHEMA = 1;

function _norm(t) {
    var s = (t === null || t === undefined) ? "" : String(t);
    var LF = String.fromCharCode(10), CR = String.fromCharCode(13);
    s = s.split(String.fromCharCode(0x2028)).join(LF);      // a soft break reads as a line break either way
    // exactly ONE trailing paragraph mark is not text; a soft break typed at the end of the paragraph IS (it must change the hash)
    if (s.length && s.charCodeAt(s.length - 1) === 13) s = s.substring(0, s.length - 1);
    s = s.split(CR + LF).join(LF).split(CR).join(LF);
    return s;
}

function _djb2(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
}

// length + djb2 of the normalised text: two paragraphs collide only if both agree
function textHash(text) {
    var n = _norm(text);
    return n.length + ":" + _djb2(n);
}

/** entries = [{ story_id, text }] → record { schema, at, stories: { "<sid>": [hash, ...] } } */
function buildRecord(entries, at, lang) {
    var stories = {}, count = 0;
    (entries || []).forEach(function (e) {
        if (!e || e.story_id === null || e.story_id === undefined) return;
        var sid = String(e.story_id);
        (stories[sid] = stories[sid] || []).push(textHash(e.text));
        count++;
    });
    var rec = { schema: SCHEMA, at: at || null, count: count, stories: stories };
    if (lang) rec.lang = String(lang);   // the target language this import was run for (#148)
    return rec;
}

function _valid(rec) {
    return !!(rec && typeof rec === "object" && rec.schema === SCHEMA && rec.stories && typeof rec.stories === "object");
}

/**
 * selectScope(record, paragraphs, textOf) → { entries: [...], matched, recorded, unmatched }
 *   paragraphs : [{ storyId, ... }] in document order (anything the caller needs rides along)
 *   textOf(p)  : the paragraph's current text
 * Per story the recorded hashes are a multiset: each recorded hash admits ONE paragraph (two identical
 * paragraphs written ⇒ two recorded hashes ⇒ both admitted; one recorded, two present ⇒ the first only).
 */
function selectScope(record, paragraphs, textOf) {
    var left = {}, recorded = 0;
    if (_valid(record)) {
        Object.keys(record.stories).forEach(function (sid) {
            var m = {};
            (record.stories[sid] || []).forEach(function (h) { m[h] = (m[h] || 0) + 1; recorded++; });
            left[sid] = m;
        });
    }
    var entries = [];
    (paragraphs || []).forEach(function (p) {
        var m = left[String(p.storyId)];
        if (!m) return;
        var h = textHash(textOf(p));
        if (m[h] > 0) { m[h]--; entries.push(p); }
    });
    return { entries: entries, matched: entries.length, recorded: recorded, unmatched: recorded - entries.length };
}

/** After cleaning: the record for the same paragraphs with their NEW text. */
// prevRecord + narrowedStoryId: a run narrowed to one story must not forget the other stories' records.
function rebuildAfterClean(entries, textOf, at, prevRecord, narrowedStoryId) {
    var rec = buildRecord((entries || []).map(function (p) { return { story_id: p.storyId, text: textOf(p) }; }), at, prevRecord && prevRecord.lang);
    if (narrowedStoryId !== null && narrowedStoryId !== undefined && _valid(prevRecord)) {
        var keep = String(narrowedStoryId);
        Object.keys(prevRecord.stories).forEach(function (sid) {
            if (sid === keep) return;
            rec.stories[sid] = (prevRecord.stories[sid] || []).slice(); rec.count += rec.stories[sid].length;
        });
    }
    return rec;
}

/**
 * mergeRecords(oldRecord, newRecord) -> record
 * An import ADDS to what is still waiting for cleanup: paragraphs written by an earlier import and not
 * cleaned yet must stay in scope when a later import writes more. Per story and hash the larger of the two
 * counts wins (the same paragraph written twice is still one paragraph; two identical paragraphs stay two).
 * Hashes that no longer match anything are harmless; the next cleanup rebuilds the record from what it cleaned.
 */
function mergeRecords(oldRec, newRec) {
    var out = { schema: SCHEMA, at: (newRec && newRec.at) || (oldRec && oldRec.at) || null, count: 0, stories: {} };
    var lang = (newRec && newRec.lang) || (oldRec && oldRec.lang) || null; if (lang) out.lang = lang;
    var acc = {};
    [oldRec, newRec].forEach(function (rec) {
        if (!_valid(rec)) return;
        Object.keys(rec.stories).forEach(function (sid) {
            var counts = {};
            (rec.stories[sid] || []).forEach(function (h) { counts[h] = (counts[h] || 0) + 1; });
            var cur = acc[sid] = acc[sid] || {};
            Object.keys(counts).forEach(function (h) { if (!(cur[h] >= counts[h])) cur[h] = counts[h]; });
        });
    });
    Object.keys(acc).forEach(function (sid) {
        var list = [];
        Object.keys(acc[sid]).sort().forEach(function (h) { for (var i = 0; i < acc[sid][h]; i++) list.push(h); });
        out.stories[sid] = list; out.count += list.length;
    });
    return out;
}

function read(doc) {
    if (!doc) return null;
    var v;
    try { v = doc.extractLabel(LABEL_KEY); } catch (e) { return null; }
    if (v && typeof v.then === "function") return null;
    var raw = String(v || "").replace(/^\s+|\s+$/g, "");
    if (!raw || raw.charAt(0) !== "{") return null;
    var o;
    try { o = JSON.parse(raw); } catch (e2) { return null; }
    return _valid(o) ? o : null;
}

function write(doc, record) {
    if (!doc) return { ok: false, err: "no doc" };
    var json;
    try { json = JSON.stringify(record); } catch (e) { return { ok: false, err: "JSON.stringify: " + (e && e.message || e) }; }
    try {
        var r = doc.insertLabel(LABEL_KEY, json);
        if (r && typeof r.then === "function") return { ok: false, err: "insertLabel returned a Promise", bytes: json.length };
    } catch (e2) { return { ok: false, err: String(e2 && (e2.message || e2)), bytes: json.length }; }
    return { ok: true, bytes: json.length };
}

/**
 * describeScope(info) → one line for the dialog and the log.
 *   info = { mode: "changed" | "document", matched, recorded, reason }
 */
/**
 * resolveScope(o) -> { info, entries, record }       (owner 2026-10-19: 2A 3B 4A, selection NARROWS)
 *   o.record          : the parsed import_written_paragraphs_v1 label, or null
 *   o.paragraphs      : every paragraph of the document, [{ storyId, ... }]
 *   o.textOf(p)       : its current text
 *   o.selectedStoryId : the story the selection is in, or null
 *   o.selectionMode   : "narrow" | "ignore"  (a selection plays no part under "ignore")
 *   o.wantDocument    : the caller asked for the whole document explicitly (cleanupScope: "document")
 * info.mode:
 *   "document" : the whole document (explicitly asked, or no import record; a selection does not matter then)
 *   "changed"  : the changed paragraphs; with a selection (narrow) only those in the selection's story
 */
function resolveScope(o) {
    o = o || {};
    var narrow = o.selectionMode === "narrow" && o.selectedStoryId !== null && o.selectedStoryId !== undefined && String(o.selectedStoryId) !== "";
    var sid = narrow ? String(o.selectedStoryId) : null;
    if (o.wantDocument === true) return { info: { mode: "document", reason: "requested" }, entries: null, record: null };
    if (_valid(o.record)) {
        var sel = selectScope(o.record, o.paragraphs, o.textOf);
        var entries = sel.entries, unmatched = sel.unmatched;
        if (narrow) {
            entries = entries.filter(function (p) { return String(p.storyId) === sid; });
            unmatched = 0;   // the remainder lives in other stories; it is not "edited since", it is out of the selection
        }
        return { info: { mode: "changed", matched: entries.length, recorded: sel.recorded, unmatched: unmatched, storyId: sid }, entries: entries, record: o.record };
    }
    // no import record: the whole document, whatever is selected (owner 2026-10-19: the selection is ignored here)
    return { info: { mode: "document", reason: "no import record" }, entries: null, record: null };
}

function describeScope(info) {
    if (!info || info.mode === "document") {
        return "Cleanup applies to the whole document" + (info && info.reason ? " (" + info.reason + ")." : ".");
    }
    var tail = info.unmatched > 0 ? " " + info.unmatched + " recorded paragraph(s) were edited since and are left alone." : "";
    var where = info.storyId ? " in the selected story" : "";
    return "Cleanup applies to " + info.matched + " paragraph(s) changed by the last import" + where + "." + tail;
}

module.exports = {
    LABEL_KEY: LABEL_KEY,
    textHash: textHash,
    buildRecord: buildRecord,
    selectScope: selectScope,
    resolveScope: resolveScope,
    rebuildAfterClean: rebuildAfterClean,
    mergeRecords: mergeRecords,
    describeScope: describeScope,
    read: read,
    write: write
};
