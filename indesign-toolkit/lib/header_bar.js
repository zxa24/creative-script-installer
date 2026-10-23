"use strict";

/**
 * lib/header_bar.js — TODO #136 ① ② / #137 (arch dispatch 2026-10-03).
 *
 * ① app-folio design-intent §19: in the header bar (the colour band at the top of
 *    the page) the English product name goes on the SECOND line, half-width
 *    brackets: 「Client-A「…」…⏎(Client-A Product-6)」. The break is a forced
 *    line break — text, not a format override.
 * ② One frame holding TWO cells: the English original of Select p2 frame 3637 is
 *    "Client-A" + one space carrying a manual kerning of 2168/1000 em
 *    (IDML KerningValue, ≈24pt at 11pt) + "Client-A Product-8" — the gap parks the
 *    product name to the right of the divider line. A translation has no gap, so the
 *    text runs across the line. This module only RECOGNISES that and reports it as
 *    must-fix-by-hand; splitting the frame is a separate proposal.
 *
 * Recognition is by STRUCTURE, never by what the text says (and not by paragraph
 * style name either: the five DocX-1 documents use "Paragraph Style 3/8/9" and
 * "[Basic Paragraph]" for the same frame). Measured on the package IDMLs, 8 pages,
 * all alike (page 612x792pt):
 *   bar      filled rectangle  x 18–593.6 (94% of the page width), y 18.4–60.1
 *   divider  white vertical line  x 160.1, y 18–63, 0.75pt
 *   company name frame left of the divider (x 45–150);
 *   product name frame = the first frame right of it (left edge 174, 14pt away);
 *   series / date frames further right (367+, 473+).
 * The thresholds below come from that ONE template family — so the scan reports how
 * many bars / dividers / product frames it recognised, 0 included: on another
 * template "not recognised" must not look like "this page has no header".
 *
 * Pure: findHeaderBar, straddles, gapVerdict, reshapeProductName, applyToTranslations.
 * Host: scanDocument.
 */

var CJK_RE = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;
function hasCJK(s) { return CJK_RE.test(String(s == null ? "" : s)); }

var BAR_TOP_MAX = 0.15;        // bar's top edge within the top 15% of the page
var BAR_MIN_WIDTH = 0.80;      // bar at least 80% of the page width
var BAR_MAX_HEIGHT = 0.12;     // bar at most 12% of the page height
var DIVIDER_MIN_OVERLAP = 0.5; // divider covers at least half the bar's height
var PRODUCT_MAX_GAP = 40;      // product frame's left edge within 40pt of the divider
var EDGE = 2;                  // pt of slack on edges

function _overlap(a0, a1, b0, b1) { return Math.min(a1, b1) - Math.max(a0, b0); }

/**
 * findHeaderBar(items, page) -> null | { bar, divider, company, product, inBar }
 *   items = [{ id, kind: "shape"|"vline"|"text", b: [x0, y0, x1, y1], filled, storyId }]
 *           page-relative points; `filled` = fill that is neither none nor white.
 *   page  = { w, h }
 * bar: topmost qualifying shape. divider: leftmost vertical line inside the bar
 * (null if none). company / product: null when not found. inBar: every text frame
 * whose TOP edge is inside the bar (a frame that grew downwards still counts).
 */
function findHeaderBar(items, page) {
    var bar = null;
    (items || []).forEach(function (it) {
        if (!it || it.kind !== "shape" || !it.filled) return;
        var w = it.b[2] - it.b[0], h = it.b[3] - it.b[1];
        if (it.b[1] > page.h * BAR_TOP_MAX) return;
        if (w < page.w * BAR_MIN_WIDTH) return;
        if (h <= 0 || h > page.h * BAR_MAX_HEIGHT) return;
        if (!bar || it.b[1] < bar.b[1]) bar = it;
    });
    if (!bar) return null;
    var barH = bar.b[3] - bar.b[1];
    var divider = null;
    items.forEach(function (it) {
        if (!it || it.kind !== "vline") return;
        var x = (it.b[0] + it.b[2]) / 2;
        if (x <= bar.b[0] + EDGE || x >= bar.b[2] - EDGE) return;
        if (_overlap(it.b[1], it.b[3], bar.b[1], bar.b[3]) < barH * DIVIDER_MIN_OVERLAP) return;
        if (!divider || x < (divider.b[0] + divider.b[2]) / 2) divider = it;
    });
    var inBar = items.filter(function (it) {
        if (!it || it.kind !== "text") return false;
        var cx = (it.b[0] + it.b[2]) / 2;
        return it.b[1] >= bar.b[1] - EDGE && it.b[1] < bar.b[3] && cx > bar.b[0] && cx < bar.b[2];
    });
    var company = null, product = null;
    if (divider) {
        var dx = (divider.b[0] + divider.b[2]) / 2;
        inBar.forEach(function (it) {
            if (it.b[2] <= dx + EDGE) { if (!company || it.b[2] > company.b[2]) company = it; return; }
            if (it.b[0] >= dx - EDGE && it.b[0] - dx <= PRODUCT_MAX_GAP) { if (!product || it.b[0] < product.b[0]) product = it; }
        });
    }
    return { bar: bar, divider: divider, company: company, product: product, inBar: inBar };
}

/**
 * straddles(items) -> [{ frame, line, x }] — text frames with a vertical line
 * strictly inside their width (EDGE of slack) and overlapping them vertically.
 * Geometry only: whether there is text on both sides is gapVerdict's question.
 */
function straddles(items) {
    var out = [];
    (items || []).forEach(function (f) {
        if (!f || f.kind !== "text") return;
        items.forEach(function (l) {
            if (!l || l.kind !== "vline") return;
            var x = (l.b[0] + l.b[2]) / 2;
            if (x <= f.b[0] + EDGE || x >= f.b[2] - EDGE) return;
            if (_overlap(f.b[1], f.b[3], l.b[1], l.b[3]) <= 1) return;
            out.push({ frame: f, line: l, x: x });
        });
    });
    return out;
}

/**
 * gapVerdict(spans, lineX, em) -> null | "two_cells" | "crossed"
 *   spans = [[x0, x1], ...] of the VISIBLE characters on the lines the vertical
 *           line passes; em = their point size.
 * null       text on one side only (or no text): nothing to report
 * two_cells  text on both sides and the line sits in a gap of at least half an em
 *            (the English original: the gap is the wide space)
 * crossed    a character sits on the line, or text on both sides with no real gap
 *            (a translation written into such a frame)
 */
function gapVerdict(spans, lineX, em) {
    var left = null, right = null, on = false;
    (spans || []).forEach(function (s) {
        if (!s || !(s[1] >= s[0])) return;
        if (s[1] <= lineX) { if (left === null || s[1] > left) left = s[1]; }
        else if (s[0] >= lineX) { if (right === null || s[0] < right) right = s[0]; }
        else on = true;
    });
    if (on) return "crossed";
    if (left === null || right === null) return null;
    return (right - left) >= 0.5 * (em > 0 ? em : 10) ? "two_cells" : "crossed";
}

/**
 * gapSplitIndex(spans, lineX) -> number | null
 *   spans = [[x0, x1, charIndex], ...] of the VISIBLE characters on the lines the vertical
 *           line passes (charIndex = position in the story text).
 * The index of the first character RIGHT of the line when the verdict is two_cells: the
 * left cell is text.slice(0, index), the right cell text.slice(index). null otherwise.
 */
function gapSplitIndex(spans, lineX) {
    var right = null;
    (spans || []).forEach(function (s) {
        if (!s || s.length < 3) return;
        if (s[0] >= lineX && (right === null || s[2] < right)) right = s[2];
    });
    return right;
}

// ── ① the product name's shape ───────────────────────────────────────────────

var BREAK = "\n";   // the pipeline's forced line break in target_text (soft-break merge joins with it)
var SP = "[ \\t\\u00a0\\u3000]*";
// head · optional break · ( or （ · a bracket-free, break-free name · ) or ） · trailing whitespace
var TAIL_RE = new RegExp("^([\\s\\S]*?)" + SP + "(\\n|\\u2028)?" + SP + "[(（]([^()（）\\n\\u2028]*)[)）](\\s*)$");

/**
 * reshapeProductName(target) -> { text, status }
 *   reshaped    was 「中文名 (英文名)」 / full-width brackets / spaces around the break
 *   already     is 「中文名⏎(英文名)」 — text returned unchanged
 *   no_english  no trailing bracketed name without CJK — text unchanged, to report
 *   untouched   empty, or no CJK before the bracket (not a translation) — unchanged
 * The English name is whatever the translator wrote in the last bracket pair; no
 * text is invented. Characters after the closing bracket (trailing spaces) are kept.
 */
function reshapeProductName(target) {
    var t = String(target == null ? "" : target);
    if (!t.replace(/\s+/g, "").length) return { text: t, status: "untouched" };
    var m = TAIL_RE.exec(t);
    if (!m || !/[A-Za-z]/.test(m[3]) || hasCJK(m[3])) {
        return { text: t, status: hasCJK(t) ? "no_english" : "untouched" };
    }
    if (!hasCJK(m[1])) return { text: t, status: "untouched" };
    var out = m[1] + BREAK + "(" + m[3].replace(/^\s+|\s+$/g, "") + ")" + m[4];
    // an existing U+2028 is the same break as "\n" (import_diff_classify compares them equal)
    if (out === t.replace(/\u2028/g, BREAK)) return { text: t, status: "already" };
    return { text: out, status: "reshaped" };
}

/**
 * applyToTranslations(scan, segments, byTid) -> [{ tid, story_id, status, from, to }]
 * Rewrites target_text of the rows that sit in a recognised product-name frame —
 * BEFORE the pipeline compares or writes anything, so "did the text change" is
 * judged on the shaped text: unchanged ⇒ the break already in the document stays
 * (TODO #130), changed ⇒ the paragraph is rewritten and the break comes with it.
 * Rows without a target, merge_tail rows and soft-break sub-segments (the document
 * already has the break; the group is joined by the pipeline) are not rewritten;
 * a sub-segment that is only a bracketed name still gets half-width brackets.
 */
function applyToTranslations(scan, segments, byTid) {
    var out = [], stories = {};
    ((scan && scan.product_frames) || []).forEach(function (p) { stories[String(p.story_id)] = true; });
    (segments || []).forEach(function (seg) {
        if (!seg || !stories[String(seg.story_id)]) return;
        var row = byTid && byTid[seg.tid];
        if (!row || row.target_text == null || String(row.status || "") === "merge_tail") return;
        var from = String(row.target_text);
        if (seg.soft_break_group) {
            var b = /^(\s*)（([^()（）\n\u2028]*)）(\s*)$/.exec(from);
            if (b && /[A-Za-z]/.test(b[2]) && !hasCJK(b[2])) {
                row.target_text = b[1] + "(" + b[2].replace(/^\s+|\s+$/g, "") + ")" + b[3];
                out.push({ tid: seg.tid, story_id: seg.story_id, status: "reshaped", from: from, to: row.target_text });
            } else {
                out.push({ tid: seg.tid, story_id: seg.story_id, status: "soft_break_group", from: from, to: from });
            }
            return;
        }
        var r = reshapeProductName(from);
        if (r.status === "reshaped") row.target_text = r.text;
        out.push({ tid: seg.tid, story_id: seg.story_id, status: r.status, from: from, to: r.text });
    });
    return out;
}

// ── host glue (InDesign UXP) ─────────────────────────────────────────────────

function _els(coll) {
    try { return coll.everyItem().getElements(); } catch (e) {}
    var out = [], n = 0;
    try { n = coll.length; } catch (e2) { n = 0; }
    for (var i = 0; i < n; i++) { try { out.push(coll.item(i)); } catch (e3) {} }
    return out;
}

// fill that is neither none nor white (Paper, RGB 255/255/255, CMYK 0/0/0/0)
function _filled(item) {
    try {
        var c = item.fillColor;
        if (!c || c.isValid === false) return false;
        var name = String(c.name || "");
        if (name === "None" || name === "Paper" || name === "[None]" || name === "[Paper]") return false;
        var v = c.colorValue, space = String(c.space || "");
        if (v && v.length) {
            var i, all = true;
            if (space.indexOf("RGB") >= 0) { for (i = 0; i < v.length; i++) if (v[i] < 250) all = false; if (all) return false; }
            else if (space.indexOf("CMYK") >= 0) { for (i = 0; i < v.length; i++) if (v[i] > 2) all = false; if (all) return false; }
        }
        return true;
    } catch (e) { return false; }
}

function _kindOf(item) {
    var n = "";
    try { n = String(item.constructor && item.constructor.name || ""); } catch (e) {}
    if (n === "TextFrame") return "text";
    if (n === "GraphicLine") return "line";
    if (n === "Rectangle" || n === "Polygon") return "shape";
    return null;
}

/**
 * scanDocument(doc, opts) -> {
 *   pages, bars, dividers,                         counts — printed even when 0
 *   product_frames: [{ page, frame_id, story_id }],
 *   two_cell:       [{ page, frame_id, story_id, line_id, line_x, verdict, text }],
 *   errors: [string] }
 * verdict: two_cells | crossed | unreadable (the frame straddles the line but the
 * character positions could not be read — reported, not dropped).
 * Read-only. opts.idsn = require("indesign") (measurement unit is forced to POINTS
 * for the read and put back).
 */
function scanDocument(doc, opts) {
    var res = { pages: 0, bars: 0, dividers: 0, product_frames: [], company_frames: [], two_cell: [], errors: [] };
    var idsn = (opts && opts.idsn) || null;
    if (!idsn) { try { idsn = require("indesign"); } catch (eI) {} }
    var app = idsn && idsn.app, MU = idsn && idsn.MeasurementUnits;
    var prevMU = null, muSet = false;
    if (app && MU && MU.POINTS !== undefined) {
        try { prevMU = app.scriptPreferences.measurementUnit; app.scriptPreferences.measurementUnit = MU.POINTS; muSet = true; } catch (eM) {}
    }
    try {
        var pages = _els(doc.pages);
        res.pages = pages.length;
        pages.forEach(function (page, pi) {
            try {
                var pb = page.bounds;   // [y1, x1, y2, x2]
                var pg = { w: pb[3] - pb[1], h: pb[2] - pb[0] };
                var raw = page.allPageItems, items = [], hostById = {};
                for (var i = 0; i < raw.length; i++) {
                    var it = raw[i], kind = _kindOf(it);
                    if (!kind) continue;
                    var gb; try { gb = it.geometricBounds; } catch (eG) { continue; }
                    var b = [gb[1] - pb[1], gb[0] - pb[0], gb[3] - pb[1], gb[2] - pb[0]];
                    var rec = { id: it.id, kind: kind, b: b };
                    if (kind === "line") {
                        if (Math.abs(b[2] - b[0]) >= 1 || !(b[3] - b[1] > 1)) continue;   // vertical lines only
                        var sw = 0; try { sw = Number(it.strokeWeight) || 0; } catch (eS) {}
                        if (!(sw > 0)) continue;
                        rec.kind = "vline";
                    } else if (kind === "shape") {
                        rec.filled = _filled(it);
                    } else {
                        try { rec.storyId = it.parentStory.id; } catch (eP) { rec.storyId = null; }
                        hostById[it.id] = it;
                    }
                    items.push(rec);
                }
                var hb = findHeaderBar(items, pg);
                if (hb) {
                    res.bars++;
                    if (hb.divider) res.dividers++;
                    if (hb.product) res.product_frames.push({ page: pi + 1, frame_id: hb.product.id, story_id: hb.product.storyId });
                    if (hb.company) res.company_frames.push({ page: pi + 1, frame_id: hb.company.id, story_id: hb.company.storyId });
                }
                straddles(items).forEach(function (s) {
                    var frame = hostById[s.frame.id], verdict = "unreadable", text = "", spans = [], em = 0;
                    try {
                        text = String(frame.contents || "");
                        var ch = frame.characters.everyItem();
                        var x0 = ch.horizontalOffset, x1 = ch.endHorizontalOffset, base = ch.baseline, cs = ch.contents, sz = ch.pointSize;
                        spans = []; em = 0;
                        for (var k = 0; k < x0.length; k++) {
                            var c = String(cs[k]);
                            if (c.length !== 1 || !/\S/.test(c)) continue;                       // spaces, tagged specials
                            var by = Number(base[k]) - pb[0];
                            if (by < s.line.b[1] - EDGE || by - Number(sz[k]) > s.line.b[3] + EDGE) continue;   // a line the rule does not pass
                            spans.push([Number(x0[k]) - pb[1], Number(x1[k]) - pb[1], k]);
                            if (Number(sz[k]) > em) em = Number(sz[k]);
                        }
                        verdict = gapVerdict(spans, s.x, em);
                    } catch (eC) { verdict = "unreadable"; res.errors.push("page " + (pi + 1) + " frame " + s.frame.id + ": " + (eC && eC.message ? eC.message : eC)); }
                    var splitAt = (verdict === "two_cells") ? gapSplitIndex(spans, s.x) : null;
                    if (verdict) res.two_cell.push({ page: pi + 1, frame_id: s.frame.id, story_id: s.frame.storyId, line_id: s.line.id, split_index: splitAt,
                                                     line_x: Math.round(s.x * 10) / 10, verdict: verdict, text: text });
                });
            } catch (ePg) { res.errors.push("page " + (pi + 1) + ": " + (ePg && ePg.message ? ePg.message : ePg)); }
        });
    } finally {
        if (muSet) { try { app.scriptPreferences.measurementUnit = prevMU; } catch (eR) {} }
    }
    return res;
}

function summaryLine(scan) {
    if (!scan) return "";
    return "header bar: pages=" + scan.pages + " bars=" + scan.bars + " dividers=" + scan.dividers
        + " product_frames=" + scan.product_frames.length + " two_cell_frames=" + scan.two_cell.length
        + (scan.errors.length ? " errors=" + scan.errors.length : "");
}

module.exports = {
    findHeaderBar: findHeaderBar,
    straddles: straddles,
    gapVerdict: gapVerdict,
    gapSplitIndex: gapSplitIndex,
    reshapeProductName: reshapeProductName,
    applyToTranslations: applyToTranslations,
    scanDocument: scanDocument,
    summaryLine: summaryLine
};
