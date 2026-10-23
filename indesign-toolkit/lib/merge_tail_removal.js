"use strict";

/**
 * lib/merge_tail_removal.js — owner 2026-10-04 (⑤B): when the translator merged two rows
 * that are two PARAGRAPHS, the tail's source paragraph is removed after the head's
 * translation is in the document.
 *
 * Why: the web app's merge means "treat as one continuous text"; it assumes the pipeline
 * makes the tail's source disappear. The pipeline only skips merge_tail rows — right for a
 * soft-break sub-segment (same paragraph as its head), wrong when the tail is its own
 * paragraph: that paragraph stayed, in the source language. DocX-1 Product-8 story 3713
 * shipped an English paragraph in the 9-29 and 10-01 PDFs (findings
 * #merge-tail-across-paragraphs-leaves-the-source-paragraph).
 *
 * This file is the DECISION (pure, tested) and the bookkeeping for the next import.
 * Removing the paragraph in the document is the host's part and is not in here yet: how a
 * paragraph (and a story's LAST paragraph) is removed in UXP has to be probed first
 * (probes/20261004_01_paragraph_remove_probe.idjs).
 *
 * A removal is refused — and reported for a person — unless every one of these holds:
 *   the row names its head, and the head row exists;
 *   the head's translation is in the document (written this run, or already there);
 *   the tail's paragraph was located, in its OWN paragraph (not the head's);
 *   that paragraph's text equals the row's source text, character for character
 *     (same normaliser as the import record) — a paragraph someone edited is not ours;
 *   the paragraph holds no anchored object.
 */

var DC = require("./import_diff_classify.js");
function _norm(t) { return DC._internal.normalizeLiveText(t); }

/**
 * planRemovals(segments, byTid, facts) -> { remove: [...], refuse: [...] }
 *   facts.headInDocument  { headTid: true }    the head's translation is in the document
 *   facts.tail            { tailTid: { located, story_id, ordinal, paragraph_count, text, has_anchor } }
 *                         ordinal = the paragraph's position in its story NOW (0-based)
 * remove: [{ tid, head_tid, story_id, ordinal, is_last, source_text }]
 *         ordered per story from the LAST paragraph to the first, so that removing one does
 *         not move the ones still to be removed.
 * refuse: [{ tid, head_tid, reason }]   reason ∈ no_head | head_not_in_document |
 *         not_located | text_differs | has_anchored_object | only_paragraph
 * Rows that are soft-break sub-segments, or that sit in the head's own paragraph, are not
 * this case and appear in neither list.
 */
function planRemovals(segments, byTid, facts) {
    var out = { remove: [], refuse: [], already_removed: [] };
    var segByTid = {};
    (segments || []).forEach(function (s) { if (s) segByTid[s.tid] = s; });
    facts = facts || {};
    var headOk = facts.headInDocument || {}, tails = facts.tail || {};
    (segments || []).forEach(function (seg) {
        var row = seg && byTid && byTid[seg.tid];
        if (!row || String(row.status || "") !== "merge_tail") return;
        if (seg.soft_break_group) return;                                  // same paragraph as its head by construction
        if (seg._removed_on_purpose) { out.already_removed.push({ tid: seg.tid, story_id: seg.story_id, paragraph_index: (typeof seg._original_paragraph_index === "number") ? seg._original_paragraph_index : seg.paragraph_index }); return; }   // an earlier import removed it
        var headTid = row.merge_head_tid ? String(row.merge_head_tid) : "";
        var headSeg = headTid ? segByTid[headTid] : null;
        if (headSeg && headSeg.story_id === seg.story_id && headSeg.paragraph_index === seg.paragraph_index) return;   // one paragraph
        function refuse(reason) { out.refuse.push({ tid: seg.tid, head_tid: headTid, reason: reason }); }
        if (!headTid || !headSeg || !byTid[headTid]) return refuse("no_head");
        if (!headOk[headTid]) return refuse("head_not_in_document");
        var f = tails[seg.tid];
        if (!f || !f.located) return refuse("not_located");
        if (_norm(f.text) !== _norm(seg.source_text)) return refuse("text_differs");
        if (f.has_anchor) return refuse("has_anchored_object");
        if (!(f.paragraph_count > 1)) return refuse("only_paragraph");     // a story must keep one paragraph
        out.remove.push({ tid: seg.tid, head_tid: headTid, story_id: f.story_id, ordinal: f.ordinal,
                          is_last: f.ordinal === f.paragraph_count - 1, source_text: String(seg.source_text || "") });
    });
    out.remove.sort(function (a, b) {
        if (String(a.story_id) !== String(b.story_id)) return String(a.story_id) < String(b.story_id) ? -1 : 1;
        return b.ordinal - a.ordinal;
    });
    return out;
}

/**
 * The record for the next import: which SOURCE paragraph indexes of which story are gone.
 * A later import of the same package still carries the old indexes; every row of that
 * story that came after a removed paragraph sits one paragraph earlier now.
 *   mergeRemovedRecord(prev, removedThisRun, segByTid) -> { storyId: [source paragraph_index, ...] } (sorted, unique)
 */
function mergeRemovedRecord(prev, removedThisRun, segByTid) {
    var out = {};
    Object.keys(prev || {}).forEach(function (sid) { out[sid] = (prev[sid] || []).slice(); });
    (removedThisRun || []).forEach(function (r) {
        var seg = segByTid && segByTid[r.tid];
        var idx = seg ? (typeof seg._original_paragraph_index === "number" ? seg._original_paragraph_index : seg.paragraph_index) : null;
        if (typeof idx !== "number") return;
        var sid = String(seg.story_id);
        out[sid] = out[sid] || [];
        if (out[sid].indexOf(idx) < 0) out[sid].push(idx);
    });
    Object.keys(out).forEach(function (sid) { out[sid].sort(function (a, b) { return a - b; }); });
    return out;
}

/** How many paragraphs before `paragraphIndex` (a SOURCE index) were removed from that story. */
function removedBefore(removedRecord, storyId, paragraphIndex) {
    var list = (removedRecord && removedRecord[String(storyId)]) || [], n = 0;
    for (var i = 0; i < list.length; i++) if (list[i] < paragraphIndex) n++;
    return n;
}

/**
 * applyRemovedShift(segments, removedRecord) -> number of rows shifted
 * Same package again after a removal: every row of that story that came after a removed
 * paragraph sits one earlier now. Mutates paragraph_index (keeping _original_paragraph_index
 * and the applied shift so a second pass over the same segments gives the same result).
 */
function applyRemovedShift(segments, removedRecord) {
    var shifted = 0;
    if (!removedRecord) return 0;
    (segments || []).forEach(function (s) {
        if (!s || typeof s.paragraph_index !== "number" || s.story_id === undefined || s.story_id === null) return;
        if (typeof s._removed_shift === "number") { s.paragraph_index += s._removed_shift; s._removed_shift = 0; }   // idempotent re-run
        var base = (typeof s._original_paragraph_index === "number") ? s._original_paragraph_index : s.paragraph_index;
        var n = removedBefore(removedRecord, s.story_id, base);
        if (n > 0) {
            if (typeof s._original_paragraph_index !== "number") s._original_paragraph_index = s.paragraph_index;
            s.paragraph_index -= n; s._removed_shift = n; shifted++;
        }
    });
    return shifted;
}

/** Was this row's own paragraph removed by an earlier import? (then it is neither located nor missed) */
function wasRemoved(removedRecord, seg) {
    if (!seg) return false;
    var idx = (typeof seg._original_paragraph_index === "number") ? seg._original_paragraph_index : seg.paragraph_index;
    var list = (removedRecord && removedRecord[String(seg.story_id)]) || [];
    return list.indexOf(idx) >= 0;
}

var REASON_TEXT = {
    no_head: "the package does not say which row it was merged into",
    head_not_in_document: "the row it was merged into was not written into the document this run",
    not_located: "the paragraph holding the source of this row was not found",
    text_differs: "that paragraph now differs from the source in the package (it was edited), so it is not deleted",
    has_anchored_object: "that paragraph holds an anchored object, deleting it would delete the object too",
    only_paragraph: "it is the only paragraph in this text flow"
};

module.exports = {
    planRemovals: planRemovals,
    mergeRemovedRecord: mergeRemovedRecord,
    removedBefore: removedBefore,
    applyRemovedShift: applyRemovedShift,
    wasRemoved: wasRemoved,
    REASON_TEXT: REASON_TEXT
};
