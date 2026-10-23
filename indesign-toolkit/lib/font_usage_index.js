"use strict";
// font_usage_index.js: TODO #144 (owner 2026-10-10, 3A + 4A): "where is this face used in the document".
//
// What it builds: for every (family, style) that the document's text uses, the total number of ranges and the first
// `cap` of them, each with the words in that face, a little text before and after them, and the address
// (story, optional table cell, index range) the panel needs to jump to it later.
//
// ⚠ WHY IT IS ITS OWN PASS, NOT PART OF THE OPEN-TIME SCAN: the owner's rule is "the panel must not open slower
//   because of this". The scan (font_mapping_doc_scan.js) already runs before the panel shows and already
//   brushes the 25 s bridge heartbeat on big documents (its own comment, near :972). This pass starts AFTER the
//   panel is up, one story per turn of the event loop (`opts.yieldFn`), and hands the result over when it is done.
//   While it runs the panel shows "loading" at the usage chips.
//
// It reads the text the way the scan does: the same batched `everyItem()` arrays, the same alignment gate
// (alignTsrBatch voids a batch whose arrays do not line up: a wrong text under a wrong face is worse than none),
// the same table-cell walk. A story or cell that cannot be read is COUNTED in `skippedTsrs`, never guessed.
//
// ⛔ NOT MEASURED ON A HOST YET: time on a large document; that `yieldFn` really lets the dialog paint between
//   stories; the cell-local index convention for jumping. See DEV_LOG 2026-10-10.

var Scan = require("./font_mapping_doc_scan.js");

var DEFAULT_CAP = 200;
var DEFAULT_CONTEXT = 30;

function _clean(s) {
    // paragraph returns, line breaks, object markers: one space; runs of blanks: one
    return String(s === undefined || s === null ? "" : s).replace(/[\u0000-\u001f\u2028\u2029\ufffc]/g, " ").replace(/\s+/g, " ");
}
// the last n characters of `text`; when that cut lands inside a word, drop the partial word
function _tail(text, n) {
    var t = _clean(text);
    if (t.length <= n) return t;
    var cut = t.slice(t.length - n);
    if (t.charAt(t.length - n - 1) !== " " && cut.charAt(0) !== " ") cut = cut.replace(/^\S*\s?/, "");
    return cut;
}
function _head(text, n) {
    var t = _clean(text);
    if (t.length <= n) return t;
    var cut = t.slice(0, n);
    if (t.charAt(n) !== " " && cut.charAt(cut.length - 1) !== " ") cut = cut.replace(/\s?\S*$/, "");
    return cut;
}
function _clip(text, n) { var t = _clean(text); return t.length > n ? t.slice(0, n) + "…" : t; }

// `recs` = the aligned records of ONE range collection [{ idxStart, idxEnd, font, contents }]; adds to `byFace`.
function _addCollection(byFace, recs, storyIdx, cellPath, cap, ctxN) {
    for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        var fs = Scan.readTsrFontFamilyStyle({ appliedFont: r.font });   // the scan's own reader (readFontFamilyStyle is not exported)
        if (!fs.family) continue;
        var key = fs.family + "|" + fs.style;
        var f = byFace[key] || (byFace[key] = { family: fs.family, style: fs.style, total: 0, items: [] });
        f.total++;
        if (f.items.length >= cap) continue;
        if (!_clean(r.contents).trim()) { f.total--; continue; }   // a range of only blanks / returns is not "a place"
        var before = "", after = "", j;
        for (j = i - 1; j >= 0 && before.length < ctxN; j--) before = _clean(recs[j].contents) + before;
        for (j = i + 1; j < recs.length && after.length < ctxN; j++) after = after + _clean(recs[j].contents);
        f.items.push({ s: storyIdx, cell: cellPath || null, a: r.idxStart, b: r.idxEnd,
            text: _clip(r.contents, 80), before: _tail(before, ctxN), after: _head(after, ctxN) });
    }
}

function _prefetch(col, n) {
    if (!n) return null;
    try {
        return Scan.alignTsrBatch(n, col.everyItem().index, col.everyItem().length, col.everyItem().appliedFont, col.everyItem().contents);
    } catch (e) { return null; }
}
function _lenOf(col) { try { return Number(col.length) || 0; } catch (e) { return 0; } }

// @param doc   the open InDesign document (or a test double)
// @param opts  { cap, context, yieldFn: async () => void, onProgress(storiesDone, storiesTotal) }
// @returns { byFace, skippedTsrs, stories }
async function buildUsageIndex(doc, opts) {
    opts = opts || {};
    var cap = opts.cap > 0 ? opts.cap : DEFAULT_CAP, ctxN = opts.context > 0 ? opts.context : DEFAULT_CONTEXT;
    var yieldFn = typeof opts.yieldFn === "function" ? opts.yieldFn : async function () {};
    var byFace = {}, skipped = 0;
    var nStories = 0;
    try { nStories = doc.stories.length; } catch (e) { nStories = 0; }
    for (var s = 0; s < nStories; s++) {
        await yieldFn();
        var story;
        try { story = doc.stories.item(s); } catch (eS) { skipped++; continue; }
        var col = null, n = 0;
        try { col = story.textStyleRanges; n = _lenOf(col); } catch (eC) { n = 0; }
        if (n) {
            var recs = _prefetch(col, n);
            if (recs) _addCollection(byFace, recs, s, null, cap, ctxN); else skipped += n;
        }
        // table cell text is not part of the story's own ranges (CLAUDE.md gate 11): the same walk the scan does
        try {
            var tables = story.tables, nT = _lenOf(tables);
            for (var ti = 0; ti < nT; ti++) {
                var cells = tables.item(ti).cells, nC = _lenOf(cells);
                for (var ci = 0; ci < nC; ci++) {
                    var texts;
                    try { texts = cells.item(ci).texts; } catch (eX) { continue; }
                    var nX = _lenOf(texts);
                    for (var xi = 0; xi < nX; xi++) {
                        var ctsrs;
                        try { ctsrs = texts.item(xi).textStyleRanges; } catch (eY) { continue; }
                        var nR = _lenOf(ctsrs);
                        if (!nR) continue;
                        var crecs = _prefetch(ctsrs, nR);
                        if (crecs) _addCollection(byFace, crecs, s, { tableIdx: ti, cellIdx: ci, textIdx: xi }, cap, ctxN); else skipped += nR;
                    }
                }
            }
        } catch (eT) { /* no tables */ }
        if (typeof opts.onProgress === "function") { try { opts.onProgress(s + 1, nStories); } catch (eP) {} }
    }
    // arch 2026-10-11: the places are listed BY PAGE (then in the order they read). A page is looked up for every recorded
    // place (at most `cap` per face, in the background, yielding as it goes) so the order is right from the first row;
    // a place whose page cannot be read (pasteboard, overset) goes last. The recorded places are the first `cap` in story
    // order, so "the first three" are the lowest pages among those, not among every place in the document.
    var faces = Object.keys(byFace), looked = 0;
    for (var fi = 0; fi < faces.length; fi++) {
        var its = byFace[faces[fi]].items;
        for (var ii = 0; ii < its.length; ii++) {
            if (++looked % 25 === 0) await yieldFn();
            its[ii].page = await pageOf(doc, its[ii]);
        }
        byFace[faces[fi]].items = sortByPage(its);
    }
    return { byFace: byFace, skippedTsrs: skipped, stories: nStories, cap: cap };
}
// by page number (numeric when both are numbers, else text), unreadable last, ties in reading order (story, index)
function sortByPage(items) {
    var key = function (p) { var n = parseInt(p, 10); return { has: p !== null && p !== undefined, num: isFinite(n) && String(n) === String(p).replace(/^\s+|\s+$/g, "") ? n : null, str: String(p) }; };
    return items.slice().sort(function (x, y) {
        var a = key(x.page), b = key(y.page);
        if (a.has !== b.has) return a.has ? -1 : 1;
        if (a.has) {
            if (a.num !== null && b.num !== null) { if (a.num !== b.num) return a.num - b.num; }
            else if (a.num !== null) return -1;
            else if (b.num !== null) return 1;
            else if (a.str !== b.str) return a.str < b.str ? -1 : 1;
        }
        return (x.s - y.s) || (x.a - y.a);
    });
}

// The Text object a usage item points at, or null. A story-level range is addressed by its story index range;
// a cell range by its cell text (the range index inside a cell is cell-local, CLAUDE.md gate 11), so for a
// cell the whole cell text is returned and the caller selects that.
function resolveItem(doc, item) {
    try {
        var story = doc.stories.item(item.s);
        if (!item.cell) return story.characters.itemByRange(item.a, item.b);
        var c = item.cell;
        return story.tables.item(c.tableIdx).cells.item(c.cellIdx).texts.item(c.textIdx);
    } catch (e) { return null; }
}

// 🔴 HOST READING 2026-10-11 (Growth dev copy): `Text.parentTextFrames` is WRAPPED, [[TextFrame]] (CLAUDE.md gate 3), so
// `parentTextFrames[0].parentPage` was undefined and every page read null. The frame is one level down.
function _frameOf(t) {
    try {
        var frames = t.parentTextFrames, f0 = null;
        if (frames && frames.length) f0 = frames[0];
        if (Array.isArray(f0)) f0 = f0[0];
        return f0 || null;
    } catch (e) { return null; }
}
async function _pageObj(t) {
    var fr = _frameOf(t), pg = fr ? fr.parentPage : null;
    if (pg && typeof pg.then === "function") pg = await pg;
    return pg || null;
}

// Best effort: select the range and bring its page forward. Returns { ok, pageMoved, reason? }. NEVER throws.
// pageMoved is true only when the window's activePage reads back as that page.
// ⛔ unverified on a host (4A: if it does not work there, the panel falls back to "list + page", owner's rule).
async function jumpTo(app, doc, item) {
    var t = resolveItem(doc, item);
    if (!t) return { ok: false, reason: "range_not_found" };
    try { app.select(t); } catch (eSel) { return { ok: false, reason: "select_failed: " + String(eSel && eSel.message || eSel) }; }
    var moved = false;
    try {
        var pg = await _pageObj(t);
        if (pg && app.activeWindow && "activePage" in app.activeWindow) {
            app.activeWindow.activePage = pg;
            var now = app.activeWindow.activePage;
            moved = !!(now && String(now.name) === String(pg.name));
        }
    } catch (ePg) { /* selected, page not brought forward */ }
    return { ok: true, pageMoved: moved };
}

// The page name of an item, or null (parentPage may be a Promise in UXP: awaited here, never invented).
async function pageOf(doc, item) {
    try {
        var t = resolveItem(doc, item);
        var pg = t ? await _pageObj(t) : null;
        var nm = pg && pg.name;
        return (nm === undefined || nm === null || nm === "") ? null : String(nm);
    } catch (e) { return null; }
}

module.exports = { buildUsageIndex: buildUsageIndex, sortByPage: sortByPage, resolveItem: resolveItem, jumpTo: jumpTo, pageOf: pageOf,
    DEFAULT_CAP: DEFAULT_CAP, DEFAULT_CONTEXT: DEFAULT_CONTEXT, _internal: { _tail: _tail, _head: _head, _clean: _clean } };
