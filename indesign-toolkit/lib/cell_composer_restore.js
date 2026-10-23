"use strict";

/**
 * lib/cell_composer_restore.js — TODO #124 fix A (arch 2026-09-30, minimum scope).
 *
 * cjk_style_apply switches paragraphs to the Japanese composer. In a table cell
 * with little room that can push the text out of the cell: Select "$1,000" had
 * 9.18pt, fit under the Latin composer, overset under the Japanese one; nothing
 * reports it (findings #cell-overset-japanese-composer).
 *
 * Rule (arch): a cell that is overset AFTER the switch and contains NO CJK
 * character gets back the composer its paragraphs had BEFORE the switch — kinsoku
 * only acts on CJK characters, so nothing is lost. Reference = the composer
 * captured right before cjk_style_apply changes anything; host 2026-09-30 it
 * equals the English original's (English / after import / before switch all
 * "Adobe Paragraph Composer"). A cell WITH CJK characters is never changed —
 * reported only. If restoring does not make the cell fit, it is put back as it
 * was and reported. Growing the row is NOT done (it changes the table layout).
 *
 * Pure: planRestore. Host: snapshotCellComposers (before), restoreOversetLatinCells
 * (after). Cell text is read from cell.texts — an overset cell's contents read "".
 */

var CJK_RE = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

function hasCJK(s) { return CJK_RE.test(String(s == null ? "" : s)); }

/**
 * planRestore(cells) -> { restore: [...], reportOnly: [...] }
 *   cells = [{ key, overflows, text, paras: [{ now, before }] }]
 * restore:    [{ key, text, paras: [{ index, from, to }] }]
 * reportOnly: [{ key, text, reason: "has_cjk" | "no_reference" | "composer_unchanged" }]
 * Cells that are not overset are left out of both.
 */
function planRestore(cells) {
    var restore = [], reportOnly = [];
    (cells || []).forEach(function (c) {
        if (!c || c.overflows !== true) return;
        if (hasCJK(c.text)) { reportOnly.push({ key: c.key, text: c.text, reason: "has_cjk" }); return; }
        var paras = c.paras || [];
        if (!paras.length || paras.some(function (p) { return !p || !p.before; })) {
            reportOnly.push({ key: c.key, text: c.text, reason: "no_reference" }); return;
        }
        var changes = [];
        paras.forEach(function (p, i) { if (p.now !== p.before) changes.push({ index: i, from: p.now, to: p.before }); });
        if (!changes.length) { reportOnly.push({ key: c.key, text: c.text, reason: "composer_unchanged" }); return; }
        restore.push({ key: c.key, text: c.text, paras: changes });
    });
    return { restore: restore, reportOnly: reportOnly };
}

// ── host glue ────────────────────────────────────────────────────────────────

function _els(coll) {
    try { return coll.everyItem().getElements(); } catch (e) {}
    var out = [], n = 0;
    try { n = coll.length; } catch (e2) { n = 0; }
    for (var i = 0; i < n; i++) { try { out.push(coll.item(i)); } catch (e3) {} }
    return out;
}

function _cellText(cell) {
    try { return String(cell.texts.item(0).contents); } catch (e) {}
    try { return String(cell.contents); } catch (e2) { return ""; }
}

// Visit every table cell: fn(cell, key, where, loc). key = "<story id>|t<table>|<cell name>"
// (tables are not added or removed by cjk_style_apply, so the index is stable).
function _eachCell(doc, fn) {
    var stories = _els(doc.stories);
    for (var s = 0; s < stories.length; s++) {
        var sid = ""; try { sid = String(stories[s].id); } catch (e) {}
        var tables = []; try { tables = _els(stories[s].tables); } catch (e2) {}
        for (var t = 0; t < tables.length; t++) {
            var cells = []; try { cells = _els(tables[t].cells); } catch (e3) {}
            for (var c = 0; c < cells.length; c++) {
                var nm = ""; try { nm = String(cells[c].name); } catch (e4) {}
                fn(cells[c], sid + "|t" + t + "|" + nm, "表" + (t + 1) + " " + nm, { story: stories[s], table: t, name: nm });
            }
        }
    }
}

// Does the cell overflow NOW? Host 2026-09-30 (Select $1,000, measured): after a
// composer change a cell reference taken earlier keeps reading the OLD value, and
// inside app.doScript even a fresh reference does until the story is recomposed.
// So: recompose the story, then read through a FRESH reference.
function _overflowsNow(loc) {
    try { loc.story.recompose(); } catch (e) {}
    try { return loc.story.tables.item(loc.table).cells.itemByName(loc.name).overflows === true; } catch (e2) { return null; }
}

/** BEFORE the switch: { key: [composer of each paragraph] } for every table cell. */
function snapshotCellComposers(doc) {
    var snap = {};
    _eachCell(doc, function (cell, key) {
        var ps = []; try { ps = _els(cell.paragraphs); } catch (e) {}
        snap[key] = ps.map(function (p) { try { return String(p.composer); } catch (e) { return ""; } });
    });
    return snap;
}

/**
 * AFTER the switch: restore the pre-switch composer in overset cells without CJK.
 * -> { restored: [{cell, text, from, to}], notFitting: [{cell, text, from, to}],
 *      reportOnly: [{cell, text, reason}], errors: [] }
 * notFitting = restoring did not make it fit ⇒ put back as it was (no change kept).
 */
function restoreOversetLatinCells(doc, snap) {
    var out = { restored: [], notFitting: [], reportOnly: [], errors: [] };
    var byKey = {}, cells = [];
    _eachCell(doc, function (cell, key, label, loc) {
        var ov = false; try { ov = cell.overflows === true; } catch (e) {}
        if (!ov) return;
        var ps = []; try { ps = _els(cell.paragraphs); } catch (e2) {}
        var before = (snap && snap[key]) || [];
        byKey[key] = { cell: cell, paras: ps, label: label, loc: loc };
        cells.push({ key: key, overflows: true, text: _cellText(cell),
                     paras: ps.map(function (p, i) { var now = ""; try { now = String(p.composer); } catch (e) {} return { now: now, before: before[i] || "" }; }) });
    });
    var plan = planRestore(cells);
    plan.reportOnly.forEach(function (r) { out.reportOnly.push({ cell: byKey[r.key].label, text: r.text, reason: r.reason }); });
    plan.restore.forEach(function (r) {
        var ent = byKey[r.key], row = { cell: ent.label, text: r.text,
            from: r.paras.map(function (x) { return x.from; }).join(" / "), to: r.paras.map(function (x) { return x.to; }).join(" / ") };
        try {
            r.paras.forEach(function (x) { ent.paras[x.index].composer = x.to; });
            var still = _overflowsNow(ent.loc);
            if (still === false) { out.restored.push(row); return; }
            r.paras.forEach(function (x) { ent.paras[x.index].composer = x.from; });   // no gain ⇒ put back
            _overflowsNow(ent.loc);   // recompose after putting back too
            out.notFitting.push(row);
        } catch (eR) { out.errors.push(ent.label + ": " + (eR && eR.message ? eR.message : eR)); }
    });
    return out;
}

module.exports = { hasCJK: hasCJK, planRestore: planRestore, snapshotCellComposers: snapshotCellComposers, restoreOversetLatinCells: restoreOversetLatinCells };
