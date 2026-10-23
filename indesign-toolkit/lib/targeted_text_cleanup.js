"use strict";
// lib/targeted_text_cleanup.js — owner 2026-10-01 ②b: after an edit-mode re-import,
// run cjk_style_apply's TEXT cleanup (CJK–Latin spaces, symbol/punctuation boundary
// spaces, optionally soft returns) on ONLY the paragraphs this import changed; every
// other paragraph is never touched.
//
// Paragraphs are named by their EXACT current text (trailing paragraph mark dropped),
// optionally narrowed by story id: { text, storyId?, all? } (all:true — the caller
// changed EVERY paragraph with this text — takes every match). Text, not position, because
// the caller knows what it just wrote and positions drift (CLAUDE.md gate #12). A
// spec matching no paragraph, or more than one, is reported and nothing is done for
// it — never a guess.
//
// Order: within one text flow, later paragraphs first (a removal only shifts what
// comes after it); table-cell paragraphs are their own flows (gate #11).
// Style-level CJK fields (composer, kinsoku, mojikumi) are NOT part of this: they
// live on shared paragraph styles, so changing them would touch unchanged paragraphs.
// Collapsing empty lines is not offered either (it removes paragraph marks).

function _items(coll) {
    if (!coll) return [];
    try { if (typeof coll.everyItem === "function") return coll.everyItem().getElements(); } catch (e) {}
    var out = [];
    try { for (var i = 0; i < coll.length; i++) out.push(typeof coll.item === "function" ? coll.item(i) : coll[i]); } catch (e2) {}
    return out;
}

function paraText(p) {
    var s = "";
    try { s = String(p.contents == null ? "" : p.contents); } catch (e) { s = ""; }
    while (s.length && s.charCodeAt(s.length - 1) === 13) s = s.substring(0, s.length - 1);
    return s;
}

// Every paragraph of the document (main flows + table cells), with a flow key and
// its position inside that flow.
function collectParagraphs(doc) {
    var out = [];
    _items(doc.stories).forEach(function (st) {
        var sid = null;
        try { sid = String(st.id); } catch (e) {}
        _items(st.paragraphs).forEach(function (p, pi) { out.push({ para: p, storyId: sid, flow: "s" + sid, pos: pi }); });
        _items(st.tables).forEach(function (tb, ti) {
            _items(tb.cells).forEach(function (c, ci) {
                _items(c.paragraphs).forEach(function (p, pi) {
                    out.push({ para: p, storyId: sid, flow: "s" + sid + ":t" + ti + ":c" + ci, pos: pi });
                });
            });
        });
    });
    return out;
}

// → { targets: [{spec, para, storyId, flow, pos}], problems: [{spec, reason}] }
function resolve(doc, specs) {
    var all = collectParagraphs(doc), targets = [], problems = [];
    (specs || []).forEach(function (spec) {
        if (!spec || typeof spec.text !== "string" || !spec.text.length) {
            problems.push({ spec: spec, reason: "no text given" });
            return;
        }
        var hits = all.filter(function (e) {
            if (spec.storyId != null && String(spec.storyId) !== e.storyId) return false;
            return paraText(e.para) === spec.text;
        });
        // all:true = the caller vouches that EVERY paragraph with this text is one it changed
        // (e.g. a heading repeated on two pages, both rewritten) ⇒ every match, not "ambiguous"
        if (hits.length === 1 || (spec.all === true && hits.length > 1)) {
            hits.forEach(function (h) { targets.push({ spec: spec, para: h.para, storyId: h.storyId, flow: h.flow, pos: h.pos }); });
        }
        else problems.push({ spec: spec, reason: hits.length === 0 ? "not found" : "ambiguous (" + hits.length + " paragraphs have this text)" });
    });
    // the same paragraph named twice ⇒ once
    var seen = {};
    targets = targets.filter(function (t) { var k = t.flow + "#" + t.pos; if (seen[k]) return false; seen[k] = true; return true; });
    return { targets: targets, problems: problems };
}

// opts: { removeSpaces, removeSoftReturns, collapseEmptyLines, skipSoftReturnStoryIds } (only what is
//   explicitly true runs; soft breaks in skipSoftReturnStoryIds, the header-bar product frames, stay even
//   when named, section 19.1; collapseEmptyLines acts INSIDE each paragraph only, owner 2026-10-19)
// TC: lib/text_cleanup.js (each function takes any object with findGrep).
function runTargets(targets, opts, TC) {
    opts = opts || {};
    var order = targets.slice().sort(function (a, b) {
        if (a.flow !== b.flow) return a.flow < b.flow ? -1 : 1;
        return b.pos - a.pos;                      // later paragraphs first
    });
    var skipSR = {}; (opts.skipSoftReturnStoryIds || []).forEach(function (id) { skipSR[String(id)] = true; });
    var processed = [], totals = { spaces: 0, symbol_punct_spaces: 0, soft_returns: 0, soft_returns_kept: 0, collapsed: 0 };
    order.forEach(function (t) {
        var rec = { text: t.spec.text, storyId: t.storyId, spaces: 0, symbol_punct_spaces: 0, soft_returns: 0, collapsed: 0, after: null };
        if (opts.removeSoftReturns === true) {
            if (skipSR[String(t.storyId)]) { rec.soft_returns = 0; rec.soft_returns_kept = true; totals.soft_returns_kept++; }   // header bar: the break stays
            else rec.soft_returns = TC.removeSoftReturns(t.para) || 0;
        }
        if (opts.collapseEmptyLines === true && typeof TC.collapseEmptyParagraphs === "function") rec.collapsed = TC.collapseEmptyParagraphs(t.para) || 0;
        if (opts.removeSpaces === true) {
            rec.spaces = TC.removeCjkAsciiSpaces(t.para) || 0;
            rec.symbol_punct_spaces = TC.removeSymbolPunctSpaces(t.para) || 0;
        }
        rec.after = paraText(t.para);
        totals.spaces += rec.spaces; totals.symbol_punct_spaces += rec.symbol_punct_spaces; totals.soft_returns += rec.soft_returns; totals.collapsed += rec.collapsed;
        processed.push(rec);
    });
    return { processed: processed, totals: totals };
}

function run(doc, specs, opts, TC) {
    var r = resolve(doc, specs);
    var out = runTargets(r.targets, opts, TC);
    return { processed: out.processed, problems: r.problems, totals: out.totals };
}

// entries = paragraphs from collectParagraphs (already chosen by the caller, e.g. written_paragraphs.selectScope)
function runEntries(entries, opts, TC) {
    var targets = (entries || []).map(function (e) {
        return { spec: { text: paraText(e.para) }, para: e.para, storyId: e.storyId, flow: e.flow, pos: e.pos };
    });
    return runTargets(targets, opts, TC);
}

module.exports = { paraText: paraText, collectParagraphs: collectParagraphs, resolve: resolve, run: run, runEntries: runEntries };
