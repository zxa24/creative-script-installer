"use strict";

/**
 * lib/header_two_cell_split_host.js — the host half of ②B (owner 2026-10-04): split a header
 * frame that holds two cells into two frames, as the production fix did by hand (Select p2:
 * company name into a new frame like page 1's 310, frame 3637 moved to where page 1's 332 is).
 *
 * Host readings this is built on (probes/20261004_01_structure_probes.idjs D, 2026-10-06):
 *   textFrame.duplicate(page) lands on that page at the SAME page-relative bounds as the
 *   original, with its layer, object style, insets, vertical justification, auto-size,
 *   paragraph style and text; new id, new story. Moving a frame = setting geometricBounds.
 *   After the move the header scan recognises the moved frame as the page's product frame.
 *
 * Decision: header_two_cell_split.planSplit (pure). This file:
 *   applySplit(doc, plan)  — duplicate the template company frame onto the page, place it at
 *                            the template's page-relative bounds, write the left cell's
 *                            translation into it; move the original frame to the template
 *                            product frame's bounds (its text is written by the pipeline as
 *                            the row's target, which the caller sets to the right cell's
 *                            translation). Every step is read back.
 *   rederive(record, ...)  — same package again: the row's target is cut the same way, and
 *                            the company frame gets a changed company translation.
 * Sizes are copied from the template and never adjusted here (layoutfit's).
 */

var Decide = require("./header_two_cell_split.js");

function _pageRel(frame, page) {
    var gb = frame.geometricBounds, pb = page.bounds;
    return [gb[1] - pb[1], gb[0] - pb[0], gb[3] - pb[1], gb[2] - pb[0]].map(function (v) { return Math.round(v * 100) / 100; });
}
function _toAbs(rel, page) {   // rel = [x0,y0,x1,y1] page-relative → geometricBounds [y0,x0,y1,x1]
    var pb = page.bounds;
    return [rel[1] + pb[0], rel[0] + pb[1], rel[3] + pb[0], rel[2] + pb[1]];
}
function _same(a, b) { for (var i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > 0.05) return false; return true; }
function _trim(t) { return String(t == null ? "" : t).replace(/^\s+|\s+$/g, ""); }

/**
 * applySplit(doc, plan, log) -> { ok, new_frame_id, new_story_id, steps: [...], error? }
 * plan = header_two_cell_split.planSplit(...).plan. Points are forced to POINTS by the caller.
 */
function applySplit(doc, plan, log) {
    var out = { ok: false, steps: [] };
    function say(s) { out.steps.push(s); if (typeof log === "function") { try { log(s); } catch (e) {} } }
    try {
        var frame = doc.textFrames.itemByID(Number(plan.frame_id));
        var tCompany = doc.textFrames.itemByID(Number(plan.template.company_frame_id));
        var tProduct = doc.textFrames.itemByID(Number(plan.template.product_frame_id));
        var page = frame.parentPage, tPage = tCompany.parentPage;
        if (!page || !tPage) { out.error = "frame or template has no page"; return out; }
        var companyRel = _pageRel(tCompany, tPage), productRel = _pageRel(tProduct, tPage);
        say("two-cell split: frame " + plan.frame_id + " on page " + page.name + "; template company " + plan.template.company_frame_id
            + " @" + companyRel.join(",") + " product " + plan.template.product_frame_id + " @" + productRel.join(","));
        // 1. the company frame: a copy of the template's, on this page, at the template's bounds
        var copy = tCompany.duplicate(page);
        copy.geometricBounds = _toAbs(companyRel, page);
        var copyRel = _pageRel(copy, page);
        if (!_same(copyRel, companyRel)) { out.error = "copied frame did not land where the template is (" + copyRel.join(",") + ")"; return out; }
        var copyStory = copy.parentStory;
        copyStory.contents = plan.left_target;
        var leftNow = _trim(copyStory.contents);
        if (leftNow !== _trim(plan.left_target)) { out.error = "left cell read back as 「" + leftNow + "」"; return out; }
        out.new_frame_id = copy.id; out.new_story_id = copyStory.id;
        say("two-cell split: company frame " + copy.id + " (story " + copyStory.id + ") = 「" + plan.left_target + "」");
        // 2. the original frame moves to the template product frame's place; its text is the pipeline's job
        frame.geometricBounds = _toAbs(productRel, page);
        var frameRel = _pageRel(frame, page);
        if (!_same(frameRel, productRel)) { out.error = "frame " + plan.frame_id + " did not move to the template's bounds (" + frameRel.join(",") + ")"; return out; }
        say("two-cell split: frame " + plan.frame_id + " moved to @" + frameRel.join(",") + "; its row " + plan.tid + " now carries only the right cell");
        out.ok = true;
    } catch (e) { out.error = String(e && e.message ? e.message : e); }
    return out;
}

/**
 * Same package again (edit mode): the row still carries the WHOLE translation. Cut it the same
 * way (the left cell's translation is looked up from the package again), and refresh the
 * company frame when that translation changed.
 *   record = { tid, frame_id, new_frame_id, new_story_id, left_source, right_source }
 * -> { ok, right_target?, left_target?, left_rewritten?, reason? }
 */
function rederive(doc, record, segments, byTid, log) {
    var row = byTid && byTid[record.tid];
    if (!row || row.target_text == null || !_trim(row.target_text)) return { ok: false, reason: "row_without_target" };
    var leftTargets = {};
    (segments || []).forEach(function (s) {
        if (!s || s.tid === record.tid || _trim(s.source_text) !== _trim(record.left_source)) return;
        var r = byTid[s.tid]; if (!r || r.target_text == null || !_trim(r.target_text)) return;
        leftTargets[_trim(r.target_text)] = true;
    });
    var lts = Object.keys(leftTargets);
    if (lts.length !== 1) return { ok: false, reason: lts.length ? "left_translation_ambiguous" : "left_translation_missing" };
    var whole = _trim(row.target_text), left = lts[0];
    if (whole.indexOf(left) !== 0) return { ok: false, reason: "target_not_prefixed" };
    var right = _trim(whole.slice(left.length));
    if (!right) return { ok: false, reason: "right_target_empty" };
    var res = { ok: true, right_target: right, left_target: left, left_rewritten: false };
    try {
        var st = doc.stories.itemByID(Number(record.new_story_id));
        if (!st || st.isValid === false) return { ok: false, reason: "company_frame_missing" };
        if (_trim(st.contents) !== left) {
            st.contents = left;
            res.left_rewritten = _trim(st.contents) === left;
            if (typeof log === "function") { try { log("two-cell split (again): company frame story " + record.new_story_id + " rewritten to 「" + left + "」" + (res.left_rewritten ? "" : " — READ-BACK FAILED")); } catch (e) {} }
        }
    } catch (e) { return { ok: false, reason: "company_frame_missing" }; }
    return res;
}

/**
 * runForImport(doc, scan, segments, byTid, sidecarState, deps) -> { scan, results, records }
 *   deps = { idsn, log, scanAgain(doc) }
 * First import: every two-cell frame the scan reports goes through planSplit → applySplit; the
 * row's target_text becomes the right cell's translation; the scan is re-run so the moved frame
 * is a product frame for the header rule. Edit mode (a record of earlier splits in the state):
 * each recorded split is re-derived instead (never split twice). Everything is reported.
 */
function runForImport(doc, scan, segments, byTid, sidecarState, deps) {
    deps = deps || {};
    var log = deps.log, results = { done: [], refused: [], failed: [], rederived: [] };
    var prev = (sidecarState && sidecarState.split_frames) || [];
    var records = prev.slice();
    var idsn = deps.idsn, app = idsn && idsn.app, MU = idsn && idsn.MeasurementUnits, prevMU = null, muSet = false;
    if (app && MU && MU.POINTS !== undefined) {
        try { prevMU = app.scriptPreferences.measurementUnit; app.scriptPreferences.measurementUnit = MU.POINTS; muSet = true; } catch (eM) {}
    }
    try {
        var recByTid = {};
        prev.forEach(function (r) { if (r && r.tid) recByTid[r.tid] = r; });
        // earlier splits: cut the row again, refresh the company frame
        prev.forEach(function (rec) {
            var r = rederive(doc, rec, segments, byTid, log);
            if (r.ok && byTid[rec.tid]) byTid[rec.tid].target_text = r.right_target;
            results.rederived.push({ tid: rec.tid, frame_id: rec.frame_id, new_frame_id: rec.new_frame_id, ok: r.ok, reason: r.reason || null, left_rewritten: !!r.left_rewritten });
        });
        // new two-cell frames
        var changed = false;
        ((scan && scan.two_cell) || []).forEach(function (cell) {
            var own = (segments || []).filter(function (sg) { return sg && String(sg.story_id) === String(cell.story_id); });
            if (own.length === 1 && recByTid[own[0].tid]) return;             // split by an earlier import: handled above
            var d = Decide.planSplit(cell, scan, segments, byTid);
            if (!d.ok) { results.refused.push({ frame_id: cell.frame_id, story_id: cell.story_id, page: cell.page, reason: d.reason }); return; }
            var a = applySplit(doc, d.plan, log);
            if (!a.ok) { results.failed.push({ frame_id: cell.frame_id, story_id: cell.story_id, page: cell.page, error: a.error, steps: a.steps }); return; }
            byTid[d.plan.tid].target_text = d.plan.right_target;
            var rec = { tid: d.plan.tid, frame_id: d.plan.frame_id, new_frame_id: a.new_frame_id, new_story_id: a.new_story_id,
                        left_source: d.plan.left_source, right_source: d.plan.right_source, left_target: d.plan.left_target, page: d.plan.page,
                        // the template pair (arch 2026-10-06): layoutfit restores geometry from these frames' English bounds,
                        // not from the split frame's own id (in English that id is the whole two-cell frame)
                        template_company_frame_id: d.plan.template.company_frame_id, template_product_frame_id: d.plan.template.product_frame_id,
                        template_page: d.plan.template.page };
            records.push(rec); results.done.push(rec); changed = true;
        });
        if (changed && typeof deps.scanAgain === "function") scan = deps.scanAgain(doc);
    } finally {
        if (muSet) { try { app.scriptPreferences.measurementUnit = prevMU; } catch (eR) {} }
    }
    return { scan: scan, results: results, records: records };
}

/**
 * settleStyles(doc, records, log) -> { settled: [...], failed: [...] }
 * arch 2026-10-06: the split-off company frame follows the TEMPLATE company frame's FINAL paragraph
 * style. The copy is made before the pipeline applies its styles (the template still carries the
 * source style then); after the apply loop the template's paragraphs wear the pipeline's style and
 * the copy does not (host run144: 7430 = "Paragraph Style 2", 310 = "_T_p_md_11pt/12.6pt_DP_B_e961").
 * So, after the writes: read the template's first paragraph style, apply it to every paragraph of
 * the copy's story, read back. Runs on every import that has a record (same package again too —
 * the template may have been restyled). The record keeps what was done (`style`).
 */
function settleStyles(doc, records, log) {
    var out = { settled: [], failed: [] };
    function say(t) { if (typeof log === "function") { try { log(t); } catch (e) {} } }
    (records || []).forEach(function (rec) {
        var r = { tid: rec.tid, frame_id: rec.frame_id, new_frame_id: rec.new_frame_id, template_company_frame_id: rec.template_company_frame_id || null };
        function fail(reason) { r.reason = reason; out.failed.push(r); rec.style = { ok: false, reason: reason }; }
        if (!rec.template_company_frame_id) { fail("record_without_template"); return; }
        try {
            var tpl = doc.textFrames.itemByID(Number(rec.template_company_frame_id)), copy = doc.textFrames.itemByID(Number(rec.new_frame_id));
            if (!tpl || tpl.isValid === false) { fail("template_frame_missing"); return; }
            if (!copy || copy.isValid === false) { fail("company_frame_missing"); return; }
            var tplStyle = tpl.parentStory.paragraphs.item(0).appliedParagraphStyle, want = String(tplStyle.name);
            var st = copy.parentStory, n = st.paragraphs.length, before = String(st.paragraphs.item(0).appliedParagraphStyle.name);
            for (var i = 0; i < n; i++) st.paragraphs.item(i).appliedParagraphStyle = tplStyle;
            var got = []; for (var k = 0; k < st.paragraphs.length; k++) got.push(String(st.paragraphs.item(k).appliedParagraphStyle.name));
            var ok = got.length > 0 && got.every(function (g) { return g === want; });
            r.template_style = want; r.before = before; r.after = got[0];
            if (!ok) { fail("read-back: " + got.join(",") + " ≠ " + want); say("two-cell split: company frame " + rec.new_frame_id + " paragraph style FAILED read-back: " + r.reason); return; }
            r.ok = true; out.settled.push(r);
            rec.style = { ok: true, template_style: want, before: before, after: got[0] };
            say("two-cell split: company frame " + rec.new_frame_id + " paragraph style " + (before === want ? "already" : "「" + before + "」 →") + " 「" + want + "」 (template frame " + rec.template_company_frame_id + ")");
        } catch (e) { fail(String(e && e.message ? e.message : e)); say("two-cell split: style settle threw: " + r.reason); }
    });
    return out;
}

module.exports = { applySplit: applySplit, rederive: rederive, runForImport: runForImport, settleStyles: settleStyles, _pageRel: _pageRel, _toAbs: _toAbs };
