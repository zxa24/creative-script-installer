"use strict";

/**
 * lib/finish_walk_host.js — TODO #153: what [Show] does to InDesign, and nothing else: find the target object, select it,
 * bring its page forward, read back what actually happened. Same function shape as reviewtool's review_walk_host.js
 * (resolveTarget / pageOf / show / readBack; written separately on purpose, no cross-branch require; the two merge into one
 * lib after both branches land, TODO #153).
 *
 * Host readings it is built on (2026-10-21, a NON-MODAL dialog open, app.modalState false throughout):
 *   app.select(frame | paragraph | cell) works, win.activePage = page works, both read back. A table cell has no parentPage:
 *   its page comes from its text's parentTextFrames.
 * It runs while our window is open (non-modal). It never saves, never closes, never opens. Every host object is passed in,
 * so Node tests drive it with mocks. It NEVER throws: every step returns { ok:false, reason }.
 */

function _item(coll, i) { return (coll && typeof coll.item === "function") ? coll.item(i) : coll[i]; }
async function _val(v) { return (v && typeof v.then === "function") ? await v : v; }
function _isValid(o) { try { return !!o && o.isValid !== false; } catch (e) { return false; } }
function _msg(e) { return String(e && e.message ? e.message : e); }

/**
 * resolveTarget(doc, target) -> { ok, obj, range|null, reason }
 *   { frame }            doc.pageItems.itemByID, then allPageItems (frames inside groups are not in pageItems)
 *   { story, para }      the para-th paragraph of the story, counted from 0 (NOT paragraph.index, a character offset: CLAUDE.md #3)
 *   { story }            the story's first text frame
 *   { story, table, cell } cell number `cell` of table number `table` of the story (by position, from 0)
 */
function resolveTarget(doc, target) {
    try {
        if (target.frame !== undefined) {
            var o = null;
            try { o = doc.pageItems.itemByID(target.frame); } catch (e) { o = null; }
            if (!_isValid(o)) {
                o = null;
                var all = doc.allPageItems || [];
                for (var i = 0; i < all.length; i++) { var x = _item(all, i); try { if (x.id === target.frame) { o = x; break; } } catch (e2) {} }
            }
            return o ? { ok: true, obj: o, range: null } : { ok: false, reason: "no object with id " + target.frame + " in this document" };
        }
        var st = null;
        try { st = doc.stories.itemByID(target.story); } catch (e3) { st = null; }
        if (!_isValid(st)) return { ok: false, reason: "no story " + target.story + " in this document" };
        if (target.table !== undefined) {
            var tb = _item(st.tables, target.table);
            if (!_isValid(tb)) return { ok: false, reason: "story " + target.story + " has no table " + target.table };
            var cell = _item(tb.cells, target.cell);
            if (!_isValid(cell)) return { ok: false, reason: "table " + target.table + " has no cell " + target.cell };
            return { ok: true, obj: cell, range: null, cellText: true, table: tb };
        }
        if (target.para === undefined) {
            var tcs = st.textContainers;
            var fr = tcs && tcs.length ? _item(tcs, 0) : null;
            return fr ? { ok: true, obj: fr, range: null } : { ok: false, reason: "story " + target.story + " has no text frame" };
        }
        var paras = st.paragraphs, n = paras.length;
        if (target.para >= n) return { ok: false, reason: "story " + target.story + " has " + n + " paragraphs, no paragraph " + target.para };
        var p = _item(paras, target.para);
        var chars = p.characters, cn = chars.length;
        var start = _item(chars, 0).index, end = _item(chars, cn - 1).index + 1;
        return { ok: true, obj: p, range: { start: start, end: end } };
    } catch (e4) { return { ok: false, reason: "looking up the target failed: " + _msg(e4) }; }
}

// The page an object sits on. Text: its first frame's page ([[TextFrame]] wrapping, CLAUDE.md #3). A cell: its text's frame. null if unknown.
async function pageOf(obj, isCell, table) {
    try {
        var o = obj;
        if (isCell) { try { o = _item(obj.texts, 0); } catch (e0) { o = obj; } }
        var pg = null;
        if (o.parentTextFrames !== undefined) {
            var fr = o.parentTextFrames;
            fr = fr && fr.length ? fr[0] : null;
            if (Array.isArray(fr)) fr = fr[0];
            pg = fr ? await _val(fr.parentPage) : null;
        } else {
            pg = await _val(o.parentPage);
        }
        // a cell whose text is entirely hidden (overset) has no text frame of its own (host reading 2026-10-21: cell.contents is empty,
        // texts.item(0).parentTextFrames has length 0): the page is where the table sits, i.e. the frame at the table's story offset
        if (!(pg && pg.isValid !== false) && isCell && table) {
            try {
                var f2 = table.storyOffset.parentTextFrames;
                f2 = f2 && f2.length ? f2[0] : null;
                if (Array.isArray(f2)) f2 = f2[0];
                pg = f2 ? await _val(f2.parentPage) : null;
            } catch (e5) { pg = null; }
        }
        return pg && pg.isValid !== false ? pg : null;
    } catch (e) { return null; }
}

// Bring the document's layout window to the front.
function activate(app, doc) {
    var win = null;
    try { if (doc.layoutWindows && doc.layoutWindows.length) win = _item(doc.layoutWindows, 0); } catch (e) {}
    if (win) {
        try { if (typeof win.activate === "function") { win.activate(); return win; } } catch (e1) {}
        try { app.activeWindow = win; return win; } catch (e2) {}
    }
    try { app.activeDocument = doc; } catch (e3) {}
    try { return app.activeWindow || win; } catch (e4) { return win; }
}

/**
 * show(app, indesign, doc, res) -> { ok, steps:{ activated, selected, page }, reason }
 *   select (replace) + bring the page forward. No zoom: the page already holds the selection.
 */
async function show(app, indesign, doc, res) {
    var steps = { activated: false, selected: false, page: false }, why = [];
    var win = activate(app, doc);
    steps.activated = !!win;
    try { app.select(res.obj, indesign.SelectionOptions ? indesign.SelectionOptions.REPLACE_WITH : undefined); steps.selected = true; }
    catch (e) { why.push("select failed: " + _msg(e)); }
    var pg = await pageOf(res.obj, !!res.cellText, res.table);
    try {
        win = app.activeWindow || win;
        if (pg && win && "activePage" in win) { win.activePage = pg; steps.page = true; }
        else why.push(pg ? "no layout window to turn" : "could not tell the object's page");
    } catch (e2) { why.push("turning to the page failed: " + _msg(e2)); }
    return { ok: steps.selected && steps.page, steps: steps, reason: why.length ? why.join("; ") : null };
}

/**
 * readBack(app, res) -> what IS selected and which page the window shows, read independently of what show() reported.
 */
async function readBack(app, res) {
    var rb = { selection: [], objectPage: null, activePage: null };
    try {
        var sel = app.selection || [], n = sel.length || 0;
        for (var i = 0; i < n; i++) {
            var s = _item(sel, i), e = { id: null, kind: null };
            try { e.kind = s.constructor && s.constructor.name ? String(s.constructor.name) : String(s); } catch (x) {}
            try { e.id = s.id; } catch (x2) {}
            try { if (s.parentStory !== undefined) e.story = s.parentStory.id; } catch (x3) {}
            rb.selection.push(e);
        }
    } catch (e1) { rb.selectionError = _msg(e1); }
    try { var ap = app.activeWindow && app.activeWindow.activePage; ap = await _val(ap); rb.activePage = ap ? String(ap.name) : null; } catch (e2) {}
    var op = await pageOf(res.obj, !!res.cellText, res.table);
    rb.objectPage = op ? String(op.name) : null;
    return rb;
}

/**
 * showTarget(app, indesign, doc, target) -> { ok, reason, readback }
 * One call for the window's [Show]: resolve, show, read back, and say plainly whether it landed (selected something and
 * the window shows the object's page).
 */
async function showTarget(app, indesign, doc, target) {
    if (!target) return { ok: false, reason: "this item cannot be shown" };
    var res = resolveTarget(doc, target);
    if (!res.ok) return { ok: false, reason: res.reason };
    var s = await show(app, indesign, doc, res);
    var rb = await readBack(app, res);
    var landed = rb.selection.length > 0 && (rb.objectPage === null || rb.activePage === rb.objectPage);
    return { ok: s.ok && landed, reason: s.ok && landed ? null : (s.reason || "the window did not land on the item"), readback: rb };
}

/** pageForTarget(doc, target) -> page name or null (used to fill in the page column before the window opens). */
async function pageForTarget(doc, target) {
    if (!target) return null;
    var res = resolveTarget(doc, target);
    if (!res.ok) return null;
    var pg = await pageOf(res.obj, !!res.cellText, res.table);
    try { return pg ? String(pg.name) : null; } catch (e) { return null; }
}

/** fillPages(doc, win): every row whose page is unknown and that has a target gets its page from the document. */
async function fillPages(doc, win) {
    var groups = (win && win.groups) || [];
    for (var g = 0; g < groups.length; g++) {
        var rows = groups[g].rows || [];
        for (var r = 0; r < rows.length; r++) {
            if (rows[r].page == null && rows[r].target) { try { rows[r].page = await pageForTarget(doc, rows[r].target); } catch (e) { rows[r].page = null; } }
        }
    }
    return win;
}

module.exports = { resolveTarget: resolveTarget, pageOf: pageOf, activate: activate, show: show, readBack: readBack, showTarget: showTarget, pageForTarget: pageForTarget, fillPages: fillPages };
