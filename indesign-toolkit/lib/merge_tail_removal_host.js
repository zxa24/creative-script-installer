"use strict";

/**
 * lib/merge_tail_removal_host.js — the host half of ⑤B (owner 2026-10-04): gather the facts
 * merge_tail_removal.planRemovals needs from the live document, then remove the paragraphs
 * the plan allows and read the story back.
 *
 * Host readings this is built on (probes/20261004_01_structure_probes.idjs, 2026-10-06):
 *   paragraph.remove() on a middle paragraph: one paragraph fewer, the neighbours keep text
 *     and paragraph style;
 *   on the LAST paragraph: the story keeps a trailing paragraph mark (an empty line) — the
 *     story's last character has to go as well; the previous paragraph then ends without a
 *     mark and keeps its style.
 * Every removal is read back: the story must have exactly one paragraph fewer and the
 * paragraphs before and after must read as before; otherwise it is reported as failed (the
 * whole import is one undo step, so a person can revert it).
 */

var Plan = require("./merge_tail_removal.js");
var DC = require("./import_diff_classify.js");
function norm(t) { return DC._internal.normalizeLiveText(t); }

function _hasAnchor(para) {
    try { if (String(para.contents).indexOf("\uFFFC") >= 0) return true; } catch (e) {}
    try { if (para.pageItems && para.pageItems.length > 0) return true; } catch (e2) {}
    return false;
}

// the paragraph's position in its story NOW, by character offset (para.index is story-global)
function _ordinalOf(para, story) {
    var idx = null;
    try { idx = Number(para.index); } catch (e) { return null; }
    if (!isFinite(idx)) return null;
    try {
        var starts = story.paragraphs.everyItem().index;
        if (typeof starts === "number") starts = [starts];
        for (var i = 0; i < starts.length; i++) if (Number(starts[i]) === idx) return i;
    } catch (e2) {}
    return null;
}

/**
 * gatherFacts(locatePlan, segments, byTid, headTargetInDocument)
 *   headTargetInDocument(headTid) -> boolean : is the head row's translation in the document?
 * -> the `facts` planRemovals expects. Reads the located paragraph of every merge_tail row.
 */
function gatherFacts(locatePlan, segments, byTid, headTargetInDocument) {
    var facts = { headInDocument: {}, tail: {} };
    (locatePlan || []).forEach(function (lr) {
        var seg = lr && lr.seg, row = seg && byTid && byTid[seg.tid];
        if (!row || String(row.status || "") !== "merge_tail") return;
        var headTid = row.merge_head_tid ? String(row.merge_head_tid) : "";
        if (headTid && !(headTid in facts.headInDocument)) {
            var ok = false; try { ok = !!headTargetInDocument(headTid); } catch (eH) { ok = false; }
            facts.headInDocument[headTid] = ok;
        }
        var f = { located: false, story_id: null, ordinal: null, paragraph_count: 0, text: "", has_anchor: false };
        if (lr.para) {
            try {
                var para = lr.para, story = para.parentStory;
                f.story_id = story.id;
                f.text = String(para.contents);
                f.paragraph_count = story.paragraphs.length;
                f.ordinal = _ordinalOf(para, story);
                f.has_anchor = _hasAnchor(para);
                f.located = f.ordinal !== null;
            } catch (e) { f.located = false; f.error = String(e && e.message ? e.message : e); }
        }
        facts.tail[seg.tid] = f;
    });
    return facts;
}

/**
 * removeParagraphs(doc, plan, log) -> { removed: [...], failed: [...] }
 *   plan = merge_tail_removal.planRemovals(...).remove (already last-paragraph-first per story)
 * Each removal is verified before (text) and after (count, neighbours).
 */
function removeParagraphs(doc, plan, log) {
    var out = { removed: [], failed: [] };
    function say(s) { if (typeof log === "function") { try { log(s); } catch (e) {} } }
    (plan || []).forEach(function (r) {
        var rec = { tid: r.tid, head_tid: r.head_tid, story_id: r.story_id, ordinal: r.ordinal, source_text: r.source_text };
        try {
            var story = doc.stories.itemByID(Number(r.story_id));
            var paras = story.paragraphs, n = paras.length;
            if (r.ordinal < 0 || r.ordinal >= n) { rec.reason = "ordinal out of range (" + r.ordinal + " of " + n + ")"; out.failed.push(rec); return; }
            var para = paras.item(r.ordinal);
            if (norm(para.contents) !== norm(r.source_text)) { rec.reason = "text changed since the plan was made"; out.failed.push(rec); return; }
            var before = r.ordinal > 0 ? String(paras.item(r.ordinal - 1).contents) : null;
            var after = r.ordinal < n - 1 ? String(paras.item(r.ordinal + 1).contents) : null;
            para.remove();
            if (r.ordinal === n - 1) {
                // last paragraph: the story keeps a trailing mark (host 2026-10-06) — drop it
                var chars = story.characters, raw = String(story.contents);
                if (raw.length && raw.charCodeAt(raw.length - 1) === 13) chars.item(chars.length - 1).remove();
            }
            var n2 = story.paragraphs.length;
            var okCount = (n2 === n - 1);
            var okBefore = before === null || norm(story.paragraphs.item(r.ordinal - 1).contents) === norm(before);
            var okAfter = after === null || norm(story.paragraphs.item(r.ordinal).contents) === norm(after);
            rec.paragraphs_before = n; rec.paragraphs_after = n2;
            if (okCount && okBefore && okAfter) { out.removed.push(rec); say("merge-tail paragraph removed: story " + r.story_id + " paragraph " + (r.ordinal + 1) + " of " + n + " (" + r.tid + ")"); }
            else { rec.reason = "read-back after removal: count " + n + "→" + n2 + (okBefore ? "" : ", previous paragraph changed") + (okAfter ? "" : ", next paragraph changed"); out.failed.push(rec); say("merge-tail paragraph removal FAILED read-back: " + rec.reason); }
        } catch (e) { rec.reason = String(e && e.message ? e.message : e); out.failed.push(rec); say("merge-tail paragraph removal threw: " + rec.reason); }
    });
    return out;
}

module.exports = { gatherFacts: gatherFacts, removeParagraphs: removeParagraphs, _ordinalOf: _ordinalOf, _hasAnchor: _hasAnchor };
