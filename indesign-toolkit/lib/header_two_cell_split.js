"use strict";

/**
 * lib/header_two_cell_split.js — owner 2026-10-04 (②B): a header frame that holds TWO cells
 * (company name | product name, kept apart by a wide space, with the divider line in the gap)
 * is split into two frames at import, when — and only when — every piece of evidence lines up.
 *
 * This file is the DECISION (pure, tested). Copying / moving the frames is the host's part
 * and waits for probes/20261004_01_structure_probes.idjs (section D).
 *
 * Refused — and reported as "必须人工处理", as today — unless all of these hold:
 *   the scan found the split point (verdict two_cells with a character index);
 *   the frame's story has exactly one row in the package, with a translation;
 *   the LEFT cell's source text is, trimmed, the source of another row of the same package
 *     that has a translation, and every such row has the same translation (= the company
 *     name's translation); the whole translation starts with it ⇒ the rest is the right cell;
 *   another page of the same document shows the pattern already separated — a company frame
 *     whose source equals the left cell and a product frame whose source equals the right
 *     cell (the template for position, size, layer and styles).
 * Nothing is guessed from positions, and no text is invented.
 */

function _trim(t) { return String(t == null ? "" : t).replace(/^\s+|\s+$/g, ""); }

/**
 * planSplit(twoCell, scan, segments, byTid) -> { ok, reason?, plan? }
 *   twoCell  one entry of scan.two_cell ({ page, frame_id, story_id, split_index, verdict })
 *   scan     header_bar.scanDocument result (product_frames / company_frames with story ids)
 * plan = { frame_id, story_id, page, tid, left_source, right_source, left_target, right_target,
 *          template: { page, company_frame_id, product_frame_id } }
 * reason ∈ no_split_point | no_row | row_without_target | left_translation_missing |
 *          left_translation_ambiguous | target_not_prefixed | right_target_empty | no_template
 */
function planSplit(twoCell, scan, segments, byTid) {
    function no(reason) { return { ok: false, reason: reason }; }
    if (!twoCell || twoCell.verdict !== "two_cells" || typeof twoCell.split_index !== "number" || twoCell.split_index <= 0) return no("no_split_point");
    var segs = segments || [], rows = byTid || {};
    var own = segs.filter(function (s) { return s && String(s.story_id) === String(twoCell.story_id); });
    if (own.length !== 1) return no("no_row");
    var seg = own[0], row = rows[seg.tid];
    var target = row && row.target_text != null ? String(row.target_text) : "";
    if (!_trim(target)) return no("row_without_target");
    var src = String(seg.source_text || "");
    var leftSrc = _trim(src.slice(0, twoCell.split_index)), rightSrc = _trim(src.slice(twoCell.split_index));
    if (!leftSrc || !rightSrc) return no("no_split_point");
    // the left cell's translation: from the rows whose source is the left cell's text
    var leftTargets = {};
    segs.forEach(function (s) {
        if (!s || s.tid === seg.tid || _trim(s.source_text) !== leftSrc) return;
        var r = rows[s.tid]; if (!r || r.target_text == null || !_trim(r.target_text)) return;
        leftTargets[_trim(r.target_text)] = true;
    });
    var lts = Object.keys(leftTargets);
    if (lts.length === 0) return no("left_translation_missing");
    if (lts.length > 1) return no("left_translation_ambiguous");
    var leftTarget = lts[0], whole = _trim(target);
    if (whole.indexOf(leftTarget) !== 0) return no("target_not_prefixed");
    var rightTarget = _trim(whole.slice(leftTarget.length));
    if (!rightTarget) return no("right_target_empty");
    // the template: a page where the two cells are two frames with those very source texts
    var srcByStory = {};
    segs.forEach(function (s) { if (s && s.paragraph_index === 0 && !(String(s.story_id) in srcByStory)) srcByStory[String(s.story_id)] = _trim(s.source_text); });
    var template = null;
    ((scan && scan.product_frames) || []).forEach(function (p) {
        if (template || p.page === twoCell.page) return;
        if (srcByStory[String(p.story_id)] !== rightSrc) return;
        ((scan && scan.company_frames) || []).forEach(function (c) {
            if (template || c.page !== p.page) return;
            if (srcByStory[String(c.story_id)] === leftSrc) template = { page: p.page, company_frame_id: c.frame_id, product_frame_id: p.frame_id };
        });
    });
    if (!template) return no("no_template");
    return { ok: true, plan: { frame_id: twoCell.frame_id, story_id: twoCell.story_id, page: twoCell.page, tid: seg.tid,
             left_source: leftSrc, right_source: rightSrc, left_target: leftTarget, right_target: rightTarget, template: template } };
}

var REASON_TEXT = {
    no_split_point: "could not measure after which letter the gap between the two cells is",
    no_row: "the text of this frame is not exactly one row in the package",
    row_without_target: "this row has no translation",
    left_translation_missing: "the source of the left cell has no row of its own with a translation in the package",
    left_translation_ambiguous: "the source of the left cell has several different translations in the package",
    target_not_prefixed: "the whole translation does not start with the translation of the left cell",
    right_target_empty: "no text is left for the right cell after cutting the left cell translation",
    no_template: "no other page has a template with the company name frame and the product name frame set apart"
};

module.exports = { planSplit: planSplit, REASON_TEXT: REASON_TEXT };
