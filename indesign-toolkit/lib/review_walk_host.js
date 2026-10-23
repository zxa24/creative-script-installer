"use strict";

/**
 * lib/review_walk_host.js — what the document eye-check walk (TODO #151) does to InDesign, and nothing else:
 * find or open the item's document, find its target object, select it, bring its page forward, read back what
 * actually happened. The judgement over the read-back is `review_round_core.judgeTarget` (pure, tested there).
 *
 * Every host object is passed in (app, indesign), so Node tests drive it with mocks.
 *
 * RULES IT IS WRITTEN AGAINST
 *   · It runs ONLY while no dialog of ours is open (the walk closes the card, waits for app.modalState to read false,
 *     then calls here). `app.open` is refused while modalState is true (CLAUDE.md #30), and selecting under a modal
 *     dialog has never been measured on this host.
 *   · Opening a document happens under NEVER_INTERACT with font auto-activation off (CLAUDE.md #8 / #39,
 *     host_env_guard's two settings), restored in `finally` — written async here because `app.open` returns a
 *     Promise in UXP and host_env_guard.withSafeHostEnv restores before a returned Promise settles.
 *   · It never saves and never closes. `modified` is read before and after so the walk can prove it changed nothing.
 *   · `fullName` / `parentPage` may be Promises (CLAUDE.md #3): always awaited.
 *   · NEVER throws: every step returns { ok:false, reason } so the card can say what failed.
 */

function _norm(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
function _item(coll, i) { return (coll && typeof coll.item === "function") ? coll.item(i) : coll[i]; }
async function _val(v) { return (v && typeof v.then === "function") ? await v : v; }
function _isValid(o) { try { return !!o && o.isValid !== false; } catch (e) { return false; } }
function _msg(e) { return String(e && e.message ? e.message : e); }

async function docPath(doc) {
    try { var fn = await _val(doc.fullName); return fn ? String(fn.nativePath || fn.fsName || fn) : null; } catch (e) { return null; }
}

// An open document whose file is `path` (slashes and case ignored), or null.
async function findOpenDoc(app, path) {
    var want = _norm(path);
    var n = 0;
    try { n = app.documents.length; } catch (e) { return null; }
    for (var i = 0; i < n; i++) {
        var d = _item(app.documents, i);
        var p = await docPath(d);
        if (p && _norm(p) === want) return d;
    }
    return null;
}

// Open `path` with interaction suppressed and font auto-activation off; both restored whatever happens.
async function openQuietly(app, indesign, path) {
    var prevUIL = null, hadUIL = false, prevAuto = null, hadAuto = false;
    try {
        try { prevUIL = app.scriptPreferences.userInteractionLevel; app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT; hadUIL = true; } catch (e1) {}
        try { var fsp = app.fontSyncPreferences; if (fsp && typeof fsp.autoActivateFont === "boolean") { prevAuto = fsp.autoActivateFont; fsp.autoActivateFont = false; hadAuto = true; } } catch (e2) {}
        var d = await _val(app.open(path, true));
        if (Array.isArray(d)) d = d[0];
        return d || null;
    } finally {
        if (hadAuto) { try { app.fontSyncPreferences.autoActivateFont = prevAuto; } catch (e3) {} }
        if (hadUIL) { try { app.scriptPreferences.userInteractionLevel = prevUIL; } catch (e4) {} }
    }
}

/**
 * ensureDoc(app, indesign, path, opts) → { ok, doc, opened, modifiedBefore, reason }
 *   opts.exists(path) → Promise<bool> (UXP's statSync lies, #26-补: the caller passes a getEntryWithUrl check)
 */
async function ensureDoc(app, indesign, path, opts) {
    opts = opts || {};
    try {
        var doc = await findOpenDoc(app, path), opened = false;
        if (!doc) {
            if (opts.exists && !(await opts.exists(path))) return { ok: false, reason: "file not found: " + path };
            doc = await openQuietly(app, indesign, path);
            if (!doc) return { ok: false, reason: "InDesign did not open " + path };
            opened = true;
        }
        var mod = null;
        try { mod = !!doc.modified; } catch (e) {}
        return { ok: true, doc: doc, opened: opened, modifiedBefore: mod };
    } catch (e) { return { ok: false, reason: "opening " + path + " failed: " + _msg(e) }; }
}

// Bring the document's layout window to the front (same ladder as cjk_style_apply.restoreTargetDocumentFocus).
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
 * resolveTarget(doc, target) → { ok, obj, range:{start,end}|null, reason }
 *   frame: doc.pageItems.itemByID, then allPageItems (frames inside groups are not in pageItems).
 *   story + para: the para-th paragraph of the story, counted from 0 (NOT paragraph.index, which is a character
 *   offset — CLAUDE.md #3). range = the paragraph's character offsets in the story, for the selection check.
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
        var paras = st.paragraphs, n = paras.length;
        if (target.para >= n) return { ok: false, reason: "story " + target.story + " has " + n + " paragraphs, no paragraph " + target.para };
        var p = _item(paras, target.para);
        var chars = p.characters, cn = chars.length;
        var start = _item(chars, 0).index, end = _item(chars, cn - 1).index + 1;
        return { ok: true, obj: p, range: { start: start, end: end } };
    } catch (e4) { return { ok: false, reason: "looking up the target failed: " + _msg(e4) }; }
}

// The page an object sits on (text: its first frame's page; [[TextFrame]] wrapping per CLAUDE.md #3). null if unknown.
async function pageOf(obj) {
    try {
        var pg = null;
        if (obj.parentTextFrames !== undefined) {
            var fr = obj.parentTextFrames;
            fr = fr && fr.length ? fr[0] : null;
            if (Array.isArray(fr)) fr = fr[0];
            pg = fr ? await _val(fr.parentPage) : null;
        } else {
            pg = await _val(obj.parentPage);
        }
        return pg && pg.isValid !== false ? pg : null;
    } catch (e) { return null; }
}

/**
 * show(app, indesign, doc, res, target) → { ok, steps:{ selected, page, zoom }, reason }
 *   select (replace), bring the page forward, zoom to fit the page. The zoom does not move the selection out of view
 *   (the page holds it); a closer "fit the selection" zoom is a later step once measured on the host.
 */
async function show(app, indesign, doc, res, target) {
    var steps = { activated: false, selected: false, page: false, zoom: false }, why = [];
    var win = activate(app, doc);
    steps.activated = !!win;
    try { app.select(res.obj, indesign.SelectionOptions ? indesign.SelectionOptions.REPLACE_WITH : undefined); steps.selected = true; }
    catch (e) { why.push("select failed: " + _msg(e)); }
    var pg = await pageOf(res.obj);
    try {
        win = app.activeWindow || win;
        if (pg && win && "activePage" in win) { win.activePage = pg; steps.page = true; }
        else why.push(pg ? "no layout window to turn" : "could not tell the object's page");
    } catch (e2) { why.push("turning to the page failed: " + _msg(e2)); }
    try {
        if (win && typeof win.zoom === "function" && indesign.ZoomOptions) { win.zoom(indesign.ZoomOptions.FIT_PAGE); steps.zoom = true; }
    } catch (e3) { why.push("zoom failed: " + _msg(e3)); }
    return { ok: steps.selected && steps.page, steps: steps, reason: why.length ? why.join("; ") : null };
}

/**
 * readBack(app, doc, res) → the rb object judgeTarget wants: what IS selected, which page the window shows,
 * which page the object is on. Read independently of what show() reported doing.
 */
async function readBack(app, doc, res) {
    var rb = { found: true, selection: [], objectPage: null, activePage: null,
        targetStart: res.range ? res.range.start : null, targetEnd: res.range ? res.range.end : null };
    try {
        var sel = app.selection || [];
        var n = sel.length || 0;
        for (var i = 0; i < n; i++) {
            var s = _item(sel, i), e = { id: null, kind: null };
            try { e.kind = s.constructor && s.constructor.name ? String(s.constructor.name) : String(s); } catch (x) {}
            try { e.id = s.id; } catch (x2) {}
            try {
                if (s.parentStory !== undefined && s.characters) {
                    e.storyId = s.parentStory.id;
                    var cn = s.characters.length;
                    if (cn) { e.start = _item(s.characters, 0).index; e.end = _item(s.characters, cn - 1).index + 1; }
                }
            } catch (x3) {}
            rb.selection.push(e);
        }
    } catch (e1) { rb.selectionError = _msg(e1); }
    try { var ap = app.activeWindow && app.activeWindow.activePage; ap = await _val(ap); rb.activePage = ap ? String(ap.name) : null; } catch (e2) {}
    var op = await pageOf(res.obj);
    rb.objectPage = op ? String(op.name) : null;
    try { rb.activeDoc = await docPath(app.activeDocument); } catch (e3) {}
    return rb;
}

function modifiedOf(doc) { try { return !!doc.modified; } catch (e) { return null; } }

module.exports = {
    docPath: docPath, findOpenDoc: findOpenDoc, openQuietly: openQuietly, ensureDoc: ensureDoc, activate: activate,
    resolveTarget: resolveTarget, pageOf: pageOf, show: show, readBack: readBack, modifiedOf: modifiedOf
};
