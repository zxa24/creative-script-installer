"use strict";

/**
 * soft_break_plan.js — decide which soft-break sub-segment groups the import
 * should KEEP SPLIT (separate paragraphs, one per line) vs RE-JOIN (collapse
 * back to one paragraph).
 *
 * Background. Export splits a paragraph with intra-paragraph forced line breaks
 * into sub-segments (sb0..sbN, shared `soft_break_group`, shared
 * `paragraph_index`). The import preclean (`splitSoftBreaksWithFormatChange`)
 * promotes a forced break to a real `\r` paragraph ONLY when the formats on the
 * two sides differ — recording a split delta `{paraIdx, tailCount}` per
 * promotion. The legacy re-join (#E2E-16) then collapses every group back onto
 * the head paragraph (merge target_text + suppress siblings) and the orphan
 * cleanup deletes the preclean's split-out tails — which is CORRECT for a
 * uniform-format line wrap (all sub-segments are one visual paragraph) but WRONG
 * for a format-differing title ("Getting Ready" 25pt Semibold + "Preparing…"
 * 15pt Book), where the two lines must stay separate paragraphs to carry their
 * own cluster styles.
 *
 * A group is FULL-SPLIT when the preclean promoted EVERY inter-sibling break —
 * i.e. the number of split deltas recorded at the group's (pre-shift) head
 * paragraph equals `groupSize - 1`. Those groups should keep their N paragraphs:
 * skip the re-join, and remap sibling sb_k onto the k-th split-out paragraph
 * (P + k). Uniform groups (0 deltas) and PARTIALLY-split groups (some breaks
 * same-format) keep the legacy merge — partial is left to merge conservatively
 * because mixing kept + collapsed breaks inside one group is ambiguous.
 *
 * Using the preclean's split DELTAS (not per-sib baseline diffs) as the signal
 * makes this robust to `revertSplitsThatCausedOverflow`: a reverted split
 * removes its delta from `splitDeltasByStoryId`, so an overflow-reverted group
 * silently drops back to the merge path (its tail no longer exists).
 *
 * Pure + Node-testable: no DOM, no InDesign refs.
 */

// Pre-shift paragraph index of a segment: sub-segment siblings all share the
// parent paragraph_index, but an earlier in-story split may have mutated it via
// the #E2E-12 shift (stashing the pre-shift value in _original_paragraph_index).
// The split DELTAS are recorded in pre-split coordinates, so compare against the
// pre-shift index.
function _preShiftIndex(seg) {
    if (!seg) return null;
    if (typeof seg._original_paragraph_index === "number") return seg._original_paragraph_index;
    if (typeof seg.paragraph_index === "number") return seg.paragraph_index;
    return null;
}

/**
 * Aggregate the preclean's per-split deltas into the per-story, paraIdx-keyed,
 * ascending form `planSoftBreakSplits` consumes.
 *
 * Extracted verbatim from v2_pipeline's inline preamble so that EVERY caller of
 * planSoftBreakSplits derives `aggByStory` from ONE implementation. A second
 * consumer (the copydeck-faithful re-run's preclean-only plan probe) must arrive
 * at byte-identical decisions as the live import; re-implementing this marshalling
 * on the probe side would make that a runtime coincidence rather than a structural
 * guarantee. Pure: no DOM, no InDesign refs — same contract as this module's header.
 *
 * NOT interchangeable with the cleanup aggregation in reorganize_doc_ops.js
 * (~line 307): that one deliberately accepts BOTH the canonical {paraIdx,tailCount}
 * AND the legacy {position,delta} field names (#22 fix) — a WIDER contract. Do not
 * "de-duplicate" the two into this function; it would silently drop legacy-shaped
 * deltas and disable the demote pass. This one mirrors ONLY v2_pipeline's inline
 * preamble (canonical shape), because its second caller (the copydeck-faithful probe)
 * consumes the same POST-revert deltas the pipeline does.
 *
 * @param {Object} splitDeltasByStoryId  story_id -> [{paraIdx, tailCount}] as
 *                                       emitted by splitSoftBreaksWithFormatChange
 *                                       (POST-revert: revert splices its entries out).
 * @returns {Object} story_id(string) -> [{paraIdx, tailCount}] sorted by paraIdx,
 *                   one entry per paraIdx with tailCount summed. `{}` when input is falsy.
 */
function buildAggByStory(splitDeltasByStoryId) {
    var aggByStory = {};
    if (!splitDeltasByStoryId) return aggByStory;
    for (var __sid in splitDeltasByStoryId) {
        if (!Object.prototype.hasOwnProperty.call(splitDeltasByStoryId, __sid)) continue;
        var __list = splitDeltasByStoryId[__sid] || [];
        var __byPara = {};
        for (var __di = 0; __di < __list.length; __di++) {
            var __d = __list[__di];
            if (!__d || typeof __d.paraIdx !== "number") continue;
            __byPara[__d.paraIdx] = (__byPara[__d.paraIdx] || 0) + (__d.tailCount || 1);
        }
        var __agg = [];
        for (var __pk in __byPara) {
            if (Object.prototype.hasOwnProperty.call(__byPara, __pk)) {
                __agg.push({ paraIdx: Number(__pk), tailCount: __byPara[__pk] });
            }
        }
        __agg.sort(function (a, b) { return a.paraIdx - b.paraIdx; });
        aggByStory[__sid] = __agg;
    }
    return aggByStory;
}

/**
 * @param {Array}  segments    pipeline segments (need soft_break_group,
 *                             soft_break_index, story_id, paragraph_index,
 *                             _original_paragraph_index?)
 * @param {Object} aggByStory  story_id(string) -> sorted [{paraIdx, tailCount}]
 *                             (build it with buildAggByStory — do not hand-roll)
 * @returns {Object} splitGroups: soft_break_group(string) -> { headIdx, size }
 *                   for every FULL-SPLIT group. Empty object when nothing splits.
 */
function planSoftBreakSplits(segments, aggByStory) {
    var splitGroups = {};
    if (!segments || !segments.length || !aggByStory) return splitGroups;

    // 1. gather groups: size + shared (pre-shift) head index + story +
    //    max ORIGINAL piece index (which counts empty pieces the export dropped).
    var groups = {};
    for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        if (!s || !s.soft_break_group) continue;
        var g = String(s.soft_break_group);
        var rec = groups[g];
        if (!rec) {
            rec = groups[g] = { sid: null, headIdx: null, size: 0, maxOrigIndex: -1 };
        }
        rec.size++;
        if (rec.sid === null && s.story_id !== undefined && s.story_id !== null) {
            rec.sid = String(s.story_id);
        }
        // head = the shared pre-shift paragraph index; sb0 carries it like the
        // rest, so any member yields it.
        if (rec.headIdx === null) {
            var pidx = _preShiftIndex(s);
            if (pidx !== null) rec.headIdx = pidx;
        }
        // orig index counts empty pieces; fall back to soft_break_index for
        // packages exported before the field existed (no empty detection there).
        var oi = (typeof s.soft_break_orig_index === "number") ? s.soft_break_orig_index
               : (typeof s.soft_break_index === "number") ? s.soft_break_index : -1;
        if (oi > rec.maxOrigIndex) rec.maxOrigIndex = oi;
    }

    // 2. a group is full-split when split-delta count at its head == size-1
    //    AND no empty piece was dropped. EMPTY-PIECE GUARD: the export's `size`
    //    counts only NON-empty pieces but the preclean records one split delta
    //    per forced break — so a "TITLE\n\nSUBTITLE" (blank middle line) with one
    //    format-differing break gives splitCount===size-1 yet is NOT a clean
    //    full-split (the sb_k→head+k remap would land SUBTITLE on the blank
    //    paragraph). size distinct 0-based orig indices with max === size-1 ⟹
    //    they are exactly {0..size-1} = contiguous = no empties dropped.
    for (var gk in groups) {
        if (!Object.prototype.hasOwnProperty.call(groups, gk)) continue;
        var gi = groups[gk];
        if (gi.size < 2 || gi.sid === null || gi.headIdx === null) continue;
        if (gi.maxOrigIndex !== gi.size - 1) continue;   // empty piece(s) dropped → fall back to merge
        var agg = aggByStory[gi.sid] || [];
        var splitCount = 0;
        for (var a = 0; a < agg.length; a++) {
            if (agg[a] && agg[a].paraIdx === gi.headIdx) splitCount += (agg[a].tailCount || 1);
        }
        if (splitCount === gi.size - 1) {
            splitGroups[gk] = { headIdx: gi.headIdx, size: gi.size };
        }
    }
    return splitGroups;
}

module.exports = {
    planSoftBreakSplits: planSoftBreakSplits,
    buildAggByStory: buildAggByStory,
    _internal: { _preShiftIndex: _preShiftIndex }
};
