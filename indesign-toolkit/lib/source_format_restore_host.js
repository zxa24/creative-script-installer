"use strict";

/**
 * lib/source_format_restore_host.js — host half of TODO #119 item 2 /
 * design-intent §17 (「格式看原文档」). Decisions live in the pure
 * lib/source_format_restore.js; this file only reads / writes the DOM.
 *
 *   captureSourceSpans(para)  — BEFORE the translation is written: the live
 *       English paragraph's formatted pieces (designer character style object +
 *       direct overrides relative to the paragraph style). Reads the document,
 *       NOT the package: the package is blind to designer character styles
 *       (findings #export-designer-cs-blind).
 *   restoreAfterWrite(para, cap, glossary, deps) — AFTER the write + override
 *       clear: strip the designer character styles `.contents=` carried over BY
 *       POSITION, place each span by text identity, re-apply the SAME style
 *       object + overrides there. CJK characters inside a restored span get the
 *       brand-paired CJK weight (deps.cjkEmphasisWeight, read-only reuse of the
 *       emphasis path's resolver) — the enforcer leaves a CJK-family font alone.
 *
 * Scope guard (arch to decide the rest): only a paragraph whose live text IS the
 * English source is captured. In an edit-mode re-import the paragraph holds the
 * previous translation (maybe with the operator's own fixes — TODO #123); not
 * touched here until that is decided.
 */

var SFR = require("./source_format_restore.js");

// baselineShift (2026-10-01, DocX-1 reimport ④ G1): the English TM/® legal line is 3.5pt raised by a
// baseline shift (+2.03 / +2.25), not superscript — without it only the size came back and the mark sat on
// the baseline.
var OVERRIDE_PROPS = ["fontStyle", "underline", "position", "pointSize", "strikeThru", "fillColor", "baselineShift"];

function _s(v) { try { return (v && v.name !== undefined) ? String(v.name) : String(v); } catch (e) { return ""; } }
function _num(v) { var n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : null; }
function _key(prop, v) {
    if (prop === "pointSize" || prop === "baselineShift") return _num(v);
    if (prop === "underline" || prop === "strikeThru") return !!v;
    return _s(v);
}
function _isCJK(ch) { return /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/.test(ch); }
function _stripCR(t) { return String(t || "").replace(/\r$/, ""); }

function captureSourceSpans(para, sourceText, baseline) {
    var live;
    try { live = _stripCR(para.contents); } catch (e) { return null; }
    if (typeof sourceText === "string" && live !== sourceText.replace(/\r$/, "")) return null;   // not the English source
    // Raw values only. What counts as an OVERRIDE is decided at restore time
    // against the paragraph's REBUILT style (finalizeSpans) — that is what the
    // rewritten text looks like; the source paragraph style is not (many
    // paragraphs carry uniform local formatting the rebuilt style reproduces).
    var ranges = [], tsr;
    try { tsr = para.textStyleRanges; } catch (e) { return null; }
    var n = 0; try { n = tsr.length; } catch (e) { n = 0; }
    for (var r = 0; r < n; r++) {
        var t; try { t = tsr.item(r); } catch (e) { return null; }
        var text = ""; try { text = String(t.contents); } catch (e) { text = ""; }
        text = text.replace(/\r/g, "");
        if (!text) continue;
        var cs = null, csName = ""; try { cs = t.appliedCharacterStyle; csName = _s(cs); } catch (e) {}
        if (csName === "[None]" || csName.indexOf("_T_") === 0) { csName = ""; cs = null; }
        var vals = {}, raw = {};
        for (var p = 0; p < OVERRIDE_PROPS.length; p++) {
            var prop = OVERRIDE_PROPS[p], v = null;
            try { v = t[prop]; } catch (e) { v = null; }
            vals[prop] = _key(prop, v); raw[prop] = v;
        }
        var fs = ""; try { fs = String(t.fontStyle); } catch (e) {}
        var fam = ""; try { fam = String(t.appliedFont.fontFamily || ""); } catch (e) {}
        if (!fam) { try { fam = String(t.appliedFont).split("\t")[0]; } catch (e) {} }
        ranges.push({ text: text, csName: csName, cs: cs, vals: vals, raw: raw, fontStyle: fs, fam: fam });
    }
    return { text: live, ranges: ranges, baseline: baseline || null };
}

// The look the REBUILT paragraph style reproduces = the segment's snapshot
// baseline (the rebuilt style was built from it). ⚠ Not the rebuilt style's own
// fontStyle: that is the CJK font's weight (MHeiHK Medium for a Regular body) —
// comparing a Latin "Regular" to it made whole paragraphs "different" (host
// 2026-09-29, Canadian). Falls back to the paragraph style when no baseline.
function _baselineVals(baseline, ps) {
    var v = {};
    if (baseline && typeof baseline === "object") {
        v.fontStyle = baseline.fontStyle != null ? String(baseline.fontStyle) : null;
        v.underline = !!baseline.underline;
        v.position = String(baseline.position || "NORMAL");
        v.pointSize = (baseline.fontSize != null) ? _num(baseline.fontSize) : null;
        v.strikeThru = !!baseline.strikeThrough;
        // snapshot key is baseline_shift; absent ⇒ 0 (a body sits on its baseline) — never undefined, or
        // finalizeSpans would skip the property and the shift would silently not come back
        v.baselineShift = _num(baseline.baseline_shift != null ? baseline.baseline_shift : 0);
        var fc = baseline.fillColor || {};
        v.fillColor = fc.swatch != null ? String(fc.swatch) : null;
        return v;
    }
    for (var i = 0; i < OVERRIDE_PROPS.length; i++) {
        try { v[OVERRIDE_PROPS[i]] = _key(OVERRIDE_PROPS[i], ps ? ps[OVERRIDE_PROPS[i]] : null); } catch (e) { v[OVERRIDE_PROPS[i]] = null; }
    }
    return v;
}

// At restore time: overrides relative to what the rebuilt paragraph looks like
// (snapshot baseline), colour within 1.5 per channel = equal; base = no style +
// no override.
function finalizeSpans(para, cap) {
    var ps = null; try { ps = para.appliedParagraphStyle; } catch (e) {}
    var styleVal = _baselineVals(cap.baseline, ps);
    var ranges = (cap.ranges || []).map(function (r) {
        var over = {}, raw = {};
        for (var p = 0; p < OVERRIDE_PROPS.length; p++) {
            var prop = OVERRIDE_PROPS[p], k = r.vals[prop];
            if (k === null || k === undefined || styleVal[prop] === null || styleVal[prop] === undefined) continue;
            if (prop === "fillColor" ? !SFR.sameLook({ over: { fillColor: k } }, { over: { fillColor: styleVal.fillColor } }) : k !== styleVal[prop]) {
                over[prop] = k; raw[prop] = r.raw[prop];
            }
        }
        return { text: r.text, csName: r.csName, cs: r.cs, over: over, raw: raw, fontStyle: r.fontStyle, fam: r.fam,
                 styleFill: styleVal.fillColor, base: !r.csName && Object.keys(over).length === 0 };
    });
    // "heavier than the paragraph" compares Latin weights: the baseline's
    var paraWeight = styleVal.fontStyle || "";
    return { spans: SFR.mergeRanges(ranges), paraWeight: paraWeight };
}

function _overrideCharOnly() {
    try { return require("indesign").OverrideType.CHARACTER_ONLY; } catch (e) { return undefined; }
}

// Strip designer character styles carried onto the new text by position
// (pipeline _T_* styles are left alone). Reverse order: tsr re-buckets (gate #5).
function stripCarriedDesignerStyles(para, noneCs) {
    var snap = [], n = 0, stripped = 0;
    try { n = para.textStyleRanges.length; } catch (e) { return 0; }
    for (var i = 0; i < n; i++) { try { snap.push(para.textStyleRanges.item(i)); } catch (e) {} }
    for (var j = snap.length - 1; j >= 0; j--) {
        var nm = ""; try { nm = _s(snap[j].appliedCharacterStyle); } catch (e) {}
        if (!nm || nm === "[None]" || nm.indexOf("_T_") === 0) continue;
        // Host 2026-09-29: removing the style leaves its attributes behind as
        // CHARACTER-level overrides (the rest of the old CS1 range stayed Regular),
        // and applyCharacterStyle([None], true) does NOT clear them — measured;
        // clearOverrides(CHARACTER_ONLY) does. Direct overrides were already
        // cleared by the pipeline before this step, so nothing legitimate is lost.
        try {
            snap[j].appliedCharacterStyle = noneCs;
            try { snap[j].clearOverrides(_overrideCharOnly()); } catch (eCo) { try { snap[j].clearOverrides(); } catch (eCo2) {} }
            stripped++;
        } catch (e) {}
    }
    return stripped;
}

function _sanitize(s) { return String(s || "Unknown").replace(/[^A-Za-z0-9]+/g, "_"); }

// A weight is only ever given through a CHARACTER STYLE, never by setting
// fontStyle / appliedFont on the text: a Dax weight set by hand (no style giving
// it) can render as MyriadPro while every property still reads Dax Bold
// (findings#manual-weight-without-char-style-can-render-as-myriad, arch
// 2026-09-30). Same naming as the pipeline's emphasis styles (_T_c_emp_w_
// <family>_<style>); when the piece carries a designer style the new style is
// BASED ON it, so the designer's other attributes stay and only the weight comes
// from ours (`_on_<designer style>` keeps the two apart). Find-or-create ⇒ a
// re-import reuses it.
function ensureWeightStyle(doc, baseCs, family, style) {
    var name = "_T_c_emp_w_" + _sanitize(family) + "_" + _sanitize(style) + (baseCs ? "_on_" + _sanitize(_s(baseCs)) : "");
    var st = null;
    try { st = doc.characterStyles.itemByName(name); if (st && !st.isValid) st = null; } catch (e) { st = null; }
    if (st) return st;
    st = doc.characterStyles.add({ name: name });
    if (baseCs) st.basedOn = baseCs;
    // style-object contract: family and style set separately (style_applier)
    st.appliedFont = family;
    st.fontStyle = style;
    return st;
}

// Apply a weight style to [a, b) of the paragraph.
function _applyWeight(para, a, b, doc, baseCs, family, style) {
    var st = ensureWeightStyle(doc, baseCs, family, style);
    para.characters.itemByRange(a, b - 1).appliedCharacterStyle = st;
    return st;
}

// Put ONE piece's format on [start, end) of the paragraph — shared by the
// import-time restore and the confirmed-suggestion step (applyConfirmed), so the
// two can never disagree on how a piece is applied.
//   sp  = { cs, csName, fam, over, raw, fontStyle }
//   ctx = { doc, live, cjkFam, weights(sp) -> { latin: weight|null, cjk: weight|null } }
// Weights first (they assign a style to sub-runs), then the other overrides on
// the whole range. Weights ONLY through a character style (ensureWeightStyle),
// based on the piece's designer style. Latin sub-runs: weights(sp).latin (the
// adopted rule raising a heavier-than-body piece to Medium), else the source's
// own override weight — in the source's Latin family (a Latin weight name on a
// CJK font throws — host 2026-09-29). CJK sub-runs: weights(sp).cjk.
function _applyPiece(para, start, end, sp, ctx, out) {
    var live = ctx.live, doc = ctx.doc;
    var W = ctx.weights(sp) || {};
    var latinW = W.latin || ((sp.over && sp.over.fontStyle) ? sp.raw.fontStyle : null);
    var rng = para.characters.itemByRange(start, end - 1);
    if (sp.cs) rng.appliedCharacterStyle = sp.cs;
    var a = start;
    while (a < end) {
        var cjk = _isCJK(live.charAt(a));
        var b = a; while (b < end && _isCJK(live.charAt(b)) === cjk) b++;
        var seg = live.substring(a, b);
        if (!cjk && latinW) {
            if (!/\S/.test(seg)) { a = b; continue; }   // spaces only: nothing to weigh
            if (sp.fam) {
                try { var stL = _applyWeight(para, a, b, doc, sp.cs, sp.fam, latinW); out.weightStyles.push(seg + "→" + _s(stL)); }
                catch (eFs) { out.errors.push("weight " + seg + ": " + eFs.message); }
            } else {
                out.errors.push("weight " + seg + ": no source Latin family");
            }
        } else if (cjk && sp.fontStyle) {
            var w = W.cjk;
            if (ctx.cjkFam && w) {
                try { var stC = _applyWeight(para, a, b, doc, sp.cs, ctx.cjkFam, w); out.cjkWeight.push(seg + "→" + ctx.cjkFam + " " + w); out.weightStyles.push(seg + "→" + _s(stC)); }
                catch (eA) { out.errors.push("cjk weight " + ctx.cjkFam + " " + w + ": " + eA.message); }
            } else {
                out.cjkWeight.push(seg + "→(" + (W.cjkHow === "conflict" ? "pair conflict" : "no pair") + " for " + ctx.cjkFam + " " + sp.fontStyle + ")");
                if (SFR.pairIssueOf(W)) _notePairIssue(out, sp, W, ctx.cjkFam, true);
            }
        }
        a = b;
    }
    // the other properties that DIFFER from the rebuilt look
    var props = Object.keys(sp.over || {});
    for (var q = 0; q < props.length; q++) {
        var pr = props[q];
        if (pr === "fontStyle") continue;   // done above, through a style
        if (!Object.prototype.hasOwnProperty.call(sp.raw || {}, pr)) { out.errors.push(pr + ": no value"); continue; }
        try { rng[pr] = sp.raw[pr]; } catch (eP) { out.errors.push(pr + ": " + eP.message); }
    }
}

// The CJK family is the PARAGRAPH style's (cluster psFont, e.g. MHeiHK) — read
// before anything is applied: a character's own font turns Latin the moment the
// source style (Latin font) lands on it (host 2026-09-29: looked up "Dax Pro").
function _cjkFamilyOf(para) {
    var f = ""; try { f = String(para.appliedParagraphStyle.appliedFont.fontFamily || ""); } catch (eF) {}
    if (!f) { try { f = String(para.appliedParagraphStyle.appliedFont).split("\t")[0]; } catch (eF2) {} }
    return f;
}

// One entry per piece (not per CJK segment): which source font / weight found no
// single CJK weight, and why — "conflict" lists the candidates per source family.
function _notePairIssue(out, sp, W, cjkFam, placed) {
    var issues = out.pairIssues || (out.pairIssues = []);
    for (var i = 0; i < issues.length; i++) if (issues[i].text === sp.text) return;
    issues.push({ text: sp.text, srcFont: sp.fam || "", srcWeight: W.basis || sp.fontStyle || "", cjkFamily: cjkFam || "",
                  how: W.cjkHow, candidates: W.cjkCandidates || null, placed: !!placed });
}

// owner 2026-10-01 (design-intent §8): a piece heavier than its body but lighter than
// Medium keeps the SOURCE weights and is reported for the owner to choose "follow the
// source" or "brand: bold it more". Fields = the shared contract (emphrel uses the same);
// `confirm` = what applyConfirmed needs to apply "brand" later. target = the placed
// translation, or null for an unplaced piece (its translation is confirmed separately).
function _noteLowContrast(out, sp, W, cjkFam, bodyWeight, target, live) {
    var lc = W.lowContrast;
    // `placed` (arch 2026-10-01, contract): did this piece land on the translation? An unplaced
    // piece has NO result on the page, so a reader must not say "now follows the source".
    out.lowContrast.push({ kind: "low_contrast_weight", placed: target != null, piece: target != null ? target : sp.text, body_weight: bodyWeight || "",
        piece_weight: sp.fontStyle || "", latin_family: sp.fam || "", cjk_family: cjkFam || "",
        follow_source: { latin: lc.follow_source.latin, cjk: lc.follow_source.cjk }, brand_bump: { latin: lc.brand_bump.latin, cjk: lc.brand_bump.cjk },
        confirm: { placed: target != null, source_piece: sp.text, paragraph_text: live, target_piece: target, charStyle: sp.csName || "", overrides: sp.over || {} } });
}

function restoreAfterWrite(para, cap, glossary, deps) {
    var out = { stripped: 0, placed: [], unplaced: [], cjkWeight: [], weightStyles: [], errors: [], liveText: "", pairIssues: [], lowContrast: [] };
    if (!cap || !cap.ranges || !cap.ranges.length) return out;
    var fin = finalizeSpans(para, cap);
    cap = { text: cap.text, spans: fin.spans, paraWeight: fin.paraWeight };
    if (!cap.spans.some(function (s) { return !s.base; })) return out;   // nothing differs from the rebuilt style
    var doc = deps && deps.workDoc;
    var noneCs = null; try { noneCs = doc.characterStyles.itemByName("[None]"); } catch (e) {}
    out.stripped = stripCarriedDesignerStyles(para, noneCs);
    var live = ""; try { live = _stripCR(para.contents); } catch (e) { out.errors.push("read"); return out; }
    out.liveText = live;
    var cjkFam = _cjkFamilyOf(para);
    // the adopted emphasis-weight default (transitional copy of emphrel's rule)
    // sp.fam = the piece's own source Latin family: the resolver needs it when two
    // Latin families pair to this CJK family with different weights (arch 2026-10-01).
    var weightsOf = function (sp) { return SFR.emphasisWeights(sp.fontStyle, cap.paraWeight, cjkFam, deps && deps.cjkEmphasisWeight, sp.fam); };
    // M2 must not use this paragraph's OWN pair (a span equal to the whole source
    // would "find" the whole translation)
    var gl = {}, own = String(cap.text || "").trim();
    Object.keys(glossary || {}).forEach(function (k) { if (k !== own) gl[k] = glossary[k]; });
    var res = SFR.placeSpans({ spans: cap.spans, target: live, glossary: gl });
    // Unplaced: everything the confirmation step needs to apply it later exactly
    // as it would have been applied here — including the weights decided NOW
    // (that step has no brand-pair resolver).
    for (var u = 0; u < res.unplaced.length; u++) {
        var us = cap.spans[res.unplaced[u]], uw = weightsOf(us) || {};
        out.unplaced.push({ text: us.text, csName: us.csName, over: us.over, fam: us.fam || "", fontStyle: us.fontStyle || "",
                            paraWeight: cap.paraWeight, cjkFamily: cjkFam, cjkWeight: uw.cjk || "", latinWeight: uw.latin || "",
                            lowContrast: uw.lowContrast || null });
        if (uw.lowContrast) _noteLowContrast(out, us, uw, cjkFam, cap.paraWeight, null, live);
        // the confirmation step has no resolver: a missing / conflicting pair must be said NOW
        if (SFR.pairIssueOf(uw)) _notePairIssue(out, us, uw, cjkFam, false);
    }
    var ctx = { doc: doc, live: live, cjkFam: cjkFam, weights: weightsOf };
    for (var k = res.placements.length - 1; k >= 0; k--) {   // reverse: later ranges first
        var pl = res.placements[k], sp = cap.spans[pl.span];
        try {
            _applyPiece(para, pl.start, pl.end, sp, ctx, out);
            out.placed.push({ text: pl.text, method: pl.method, csName: sp.csName, over: sp.over, start: pl.start, end: pl.end });
            var pw = weightsOf(sp) || {};
            if (pw.lowContrast) _noteLowContrast(out, sp, pw, cjkFam, cap.paraWeight, pl.text, live);
        } catch (eR) { out.errors.push("apply " + pl.text + ": " + eR.message); }
    }
    return out;
}

// ── confirmed suggestions (design-intent §17: AI suggests, the user confirms,
// THEN it is applied — never silently) ─────────────────────────────────────────
//
// item = one entry of report.apply.source_format_restore.unplaced plus the
// confirmed translation of the piece:
//   { tid, paragraph_text, target_piece, charStyle, overrides, source_font_family,
//     piece_weight, cjk_family, cjk_weight }
// The paragraph is found by its text (whitespace ignored: cjk_style_apply removes
// CJK↔ASCII spaces after the import), the piece by its text inside it — each
// must be found EXACTLY once, else the item is reported and nothing is applied.

function _compact(s) {
    var chars = [], map = [];
    for (var i = 0; i < s.length; i++) { if (!/\s/.test(s.charAt(i))) { chars.push(s.charAt(i)); map.push(i); } }
    return { text: chars.join(""), map: map };
}

// [start, end) of `piece` in `live` when it occurs exactly once (spaces ignored).
function locatePiece(live, piece) {
    var L = _compact(String(live || "")), P = _compact(String(piece || "")).text;
    if (!P) return { status: "empty_piece" };
    var first = L.text.indexOf(P);
    if (first < 0) return { status: "piece_not_found" };
    if (L.text.indexOf(P, first + 1) >= 0) return { status: "piece_ambiguous" };
    return { status: "ok", start: L.map[first], end: L.map[first + P.length - 1] + 1 };
}

// Every paragraph of the document, table-cell paragraphs included (gate #11).
function _allParagraphs(doc) {
    var out = [];
    var stories = doc.stories.everyItem().getElements();
    for (var i = 0; i < stories.length; i++) {
        try { var ps = stories[i].paragraphs.everyItem().getElements(); for (var p = 0; p < ps.length; p++) out.push(ps[p]); } catch (e) {}
        try {
            var tb = stories[i].tables.everyItem().getElements();
            for (var t = 0; t < tb.length; t++) {
                var cl = tb[t].cells.everyItem().getElements();
                for (var c = 0; c < cl.length; c++) {
                    try { var cp = cl[c].paragraphs.everyItem().getElements(); for (var q = 0; q < cp.length; q++) out.push(cp[q]); } catch (e2) {}
                }
            }
        } catch (eT) {}
    }
    return out;
}

// A character style by name, groups included (gate #2's lesson); must be unique.
function _charStyleByName(doc, name) {
    var all = []; try { all = doc.allCharacterStyles; } catch (e) { all = []; }
    var hits = [];
    for (var i = 0; i < (all ? all.length : 0); i++) { try { if (String(all[i].name) === name) hits.push(all[i]); } catch (e2) {} }
    return hits.length === 1 ? hits[0] : (hits.length ? "ambiguous" : null);
}

// Report values back to DOM values: fillColor is a swatch NAME, position an enum NAME.
function _rawFromReport(doc, over, enums) {
    var raw = {};
    Object.keys(over || {}).forEach(function (k) {
        var v = over[k];
        if (k === "fillColor") { try { var sw = doc.swatches.itemByName(String(v)); if (sw && sw.isValid) raw[k] = sw; } catch (e) {} return; }
        if (k === "position") { var P = enums && enums.Position; if (P && P[String(v)] !== undefined) raw[k] = P[String(v)]; return; }
        raw[k] = v;
    });
    return raw;
}

function applyConfirmed(doc, items, deps) {
    deps = deps || {};
    var paras = _allParagraphs(doc);
    var texts = paras.map(function (p) { var t = ""; try { t = _stripCR(p.contents); } catch (e) {} return _compact(t).text; });
    var results = [];
    (items || []).forEach(function (raw) {
        // owner 2026-10-01: a low_contrast_weight entry carries the owner's choice in
        // `weight_choice`: "brand" ⇒ Latin Medium + CJK = pair(Medium), via character
        // styles; "source" ⇒ nothing changes (the import already applied the source
        // weights); no choice ⇒ nothing applied (never a default bump).
        var it = raw || {};
        var choice = it.weight_choice || "";
        if (it.kind === "low_contrast_weight") {
            var cf = it.confirm || {};
            if (choice !== "brand") {
                results.push({ tid: it.tid || "", piece: String(it.piece || ""), status: choice === "source" ? "kept_source" : "no_choice",
                               cjkWeight: [], weightStyles: [], errors: [] });
                return;
            }
            it = { tid: it.tid, paragraph_text: cf.paragraph_text, target_piece: cf.target_piece != null ? cf.target_piece : it.target_piece,
                   charStyle: cf.charStyle, overrides: cf.overrides, source_font_family: it.latin_family, piece_weight: it.piece_weight,
                   cjk_family: it.cjk_family, latin_weight: it.brand_bump && it.brand_bump.latin, cjk_weight: it.brand_bump && it.brand_bump.cjk };
        } else if (choice === "brand" && it.low_contrast && it.low_contrast.brand_bump) {
            // an unplaced piece that is ALSO low-contrast: its translation confirmed + "brand" chosen
            var o = {}; for (var kk in it) if (Object.prototype.hasOwnProperty.call(it, kk)) o[kk] = it[kk];
            o.latin_weight = it.low_contrast.brand_bump.latin; o.cjk_weight = it.low_contrast.brand_bump.cjk; it = o;
        }
        var r = { tid: it.tid || "", piece: String(it.target_piece || ""), status: "", cjkWeight: [], weightStyles: [], errors: [] };
        if (choice) r.weightChoice = choice;
        results.push(r);
        var want = _compact(_stripCR(it.paragraph_text)).text;
        var hit = [];
        for (var i = 0; i < texts.length; i++) if (want && texts[i] === want) hit.push(i);
        if (hit.length !== 1) { r.status = hit.length ? "paragraph_ambiguous" : "paragraph_not_found"; return; }
        var para = paras[hit[0]], live = _stripCR(para.contents);
        var loc = locatePiece(live, it.target_piece);
        if (loc.status !== "ok") { r.status = loc.status; return; }
        var cs = null;
        if (it.charStyle) {
            cs = _charStyleByName(doc, String(it.charStyle));
            if (!cs || cs === "ambiguous") { r.status = cs ? "style_ambiguous" : "style_not_found"; return; }
        }
        var over = it.overrides || {};
        var sp = { cs: cs, csName: it.charStyle || "", fam: it.source_font_family || "", over: over,
                   raw: _rawFromReport(doc, over, deps.enums), fontStyle: it.piece_weight || "" };
        if (over.fontStyle) sp.raw.fontStyle = over.fontStyle;
        var fixedW = { latin: it.latin_weight || null, cjk: it.cjk_weight || null };   // decided at import
        var ctx = { doc: doc, live: live, cjkFam: it.cjk_family || _cjkFamilyOf(para), weights: function () { return fixedW; } };
        try {
            _applyPiece(para, loc.start, loc.end, sp, ctx, r);
            r.status = r.errors.length ? "applied_with_errors" : "applied"; r.start = loc.start; r.end = loc.end;
        } catch (e) { r.status = "failed"; r.errors.push(e.message); }
    });
    return results;
}

module.exports = { captureSourceSpans: captureSourceSpans, finalizeSpans: finalizeSpans, restoreAfterWrite: restoreAfterWrite, stripCarriedDesignerStyles: stripCarriedDesignerStyles,
    ensureWeightStyle: ensureWeightStyle, locatePiece: locatePiece, applyConfirmed: applyConfirmed };
