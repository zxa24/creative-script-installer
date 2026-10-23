"use strict";
// lib/edit_minimal_write.js — D2 + D3 (owner 2026-10-01 ①A): an edit-mode re-import
// rewrites a paragraph by changing ONLY the characters that differ, so every
// unchanged character keeps what it carries (bold / the TM baseline shift / a local
// font) and emphasis moves WITH its text.
//
// Why: the whole-paragraph write (`range.contents = text`) hands the old text's
// character formatting to the new text BY POSITION (CLAUDE.md gate #6). DocX-1 ③:
// four characters inserted before Product-6's bold 「<client copy>」 left the bold on
// 「足加拿大」. The owner's rule: emphasis is located by its text; where the text it sat
// on was changed, report it — ⛔ never place it by offset.
//
// Pure part (Node-testable): diffOps / styleRuns / reviewRuns / insertSide.
// Host part: writeMinimal(para, targetText) — reads the paragraph, applies the edit
// script back to front (earlier offsets never move), returns what it did.
//
// Character formatting of NEW characters (InDesign gives inserted text the formatting
// of the character before the insertion point; a replaced range hands its formatting
// to the new text by position):
//   - replaced text: takes the replaced characters' formatting (a word changed inside
//     a bold phrase stays bold); a replaced range spanning a style change is reported;
//   - inserted text between two characters of the same style: that style;
//   - inserted text on a style boundary: the side WITHOUT a character style (an
//     insertion right after a bold run is not bold). Done by rewriting that neighbour
//     character together with the new text — a single-character source hands its
//     formatting to every new character, so nothing is copied property by property.
//     Reported ("boundary"), because the choice is a rule, not knowledge.

var FFFC = "￼";

// ── pure ────────────────────────────────────────────────────────────────────

// Edit script turning `a` into `b`: [{op:"equal"|"delete"|"insert"|"replace",
// aStart, aEnd (exclusive), text}] in a-order. Common prefix / suffix trimmed, LCS on
// the middle. Over `maxCells` the middle is one replace (reported by the caller).
function diffOps(a, b, maxCells) {
    a = String(a); b = String(b);
    maxCells = maxCells || 4000000;
    var p = 0;
    while (p < a.length && p < b.length && a.charAt(p) === b.charAt(p)) p++;
    var s = 0;
    while (s < a.length - p && s < b.length - p && a.charAt(a.length - 1 - s) === b.charAt(b.length - 1 - s)) s++;
    var am = a.substring(p, a.length - s), bm = b.substring(p, b.length - s);
    var ops = [];
    if (p > 0) ops.push({ op: "equal", aStart: 0, aEnd: p, text: a.substring(0, p) });
    var mid = [], coarse = false;
    if (am.length === 0 && bm.length === 0) {
        // nothing
    } else if (am.length === 0) {
        mid.push({ op: "insert", aStart: p, aEnd: p, text: bm });
    } else if (bm.length === 0) {
        mid.push({ op: "delete", aStart: p, aEnd: p + am.length, text: "" });
    } else if ((am.length + 1) * (bm.length + 1) > maxCells) {
        mid.push({ op: "replace", aStart: p, aEnd: p + am.length, text: bm });
        coarse = true;
    } else {
        mid = _lcsOps(am, bm, p);
    }
    for (var i = 0; i < mid.length; i++) ops.push(mid[i]);
    if (s > 0) ops.push({ op: "equal", aStart: a.length - s, aEnd: a.length, text: a.substring(a.length - s) });
    ops = _mergeOps(ops);
    ops.coarse = coarse;
    return ops;
}

function _lcsOps(a, b, base) {
    var n = a.length, m = b.length, W = m + 1;
    var L = new Uint16Array((n + 1) * W);   // suffix LCS lengths (paragraphs < 65535 chars)
    for (var i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
            L[i * W + j] = (a.charCodeAt(i) === b.charCodeAt(j)) ? L[(i + 1) * W + j + 1] + 1
                : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
        }
    }
    var raw = [], x = 0, y = 0;
    while (x < n || y < m) {
        if (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) { raw.push({ k: "e", ch: a.charAt(x), ai: x }); x++; y++; }
        else if (y < m && (x >= n || L[x * W + y + 1] >= L[(x + 1) * W + y])) { raw.push({ k: "i", ch: b.charAt(y), ai: x }); y++; }
        else { raw.push({ k: "d", ch: a.charAt(x), ai: x }); x++; }
    }
    // group: consecutive non-equal steps become one delete / insert / replace
    var out = [], k = 0;
    while (k < raw.length) {
        if (raw[k].k === "e") {
            var st = raw[k].ai, txt = "";
            while (k < raw.length && raw[k].k === "e") { txt += raw[k].ch; k++; }
            out.push({ op: "equal", aStart: base + st, aEnd: base + st + txt.length, text: txt });
        } else {
            var aS = raw[k].ai, dn = 0, ins = "";
            while (k < raw.length && raw[k].k !== "e") {
                if (raw[k].k === "d") dn++; else ins += raw[k].ch;
                k++;
            }
            var op = dn === 0 ? "insert" : (ins.length === 0 ? "delete" : "replace");
            out.push({ op: op, aStart: base + aS, aEnd: base + aS + dn, text: ins });
        }
    }
    return out;
}

function _mergeOps(ops) {
    var out = [];
    for (var i = 0; i < ops.length; i++) {
        var o = ops[i], last = out[out.length - 1];
        if (last && last.op === "equal" && o.op === "equal" && last.aEnd === o.aStart) {
            last.aEnd = o.aEnd; last.text += o.text;
        } else out.push({ op: o.op, aStart: o.aStart, aEnd: o.aEnd, text: o.text });
    }
    return out;
}

// Maximal runs of one non-"[None]" character style: [{start, end (excl), style}].
function styleRuns(styles) {
    var runs = [];
    for (var i = 0; i < styles.length; i++) {
        var st = styles[i];
        if (!st || st === "[None]") continue;
        var last = runs[runs.length - 1];
        if (last && last.end === i && last.style === st) last.end = i + 1;
        else runs.push({ start: i, end: i + 1, style: st });
    }
    return runs;
}

// Which side's formatting new text inserted between two characters should take.
// L / R / base are FORMAT KEYS (formatKey below; null = no character on that side;
// base = the paragraph style's plain look): character style + the local overrides
// that make emphasis (position, baseline shift, size, underline, colour).
// ⛔ No font / font style in the key: those differ between the CJK and Latin
// characters of one plain sentence (GREP, the pair table), so they would turn every
// script change into a "boundary". (Bold made by a LOCAL font-style override is
// therefore not seen here — it is inherited from the left, as InDesign does.)
// → { side: "left"|"right", boundary: bool, reason }
function insertSide(L, R, base) {
    if (L === null || L === undefined) return { side: "right", boundary: false };
    if (R === null || R === undefined) return { side: "left", boundary: false };
    if (L === R) return { side: "left", boundary: false };
    if (R === base) return { side: "right", boundary: true, reason: "after formatted text → plain" };
    if (L === base) return { side: "left", boundary: true, reason: "before formatted text → plain" };
    return { side: "left", boundary: true, reason: "between two different formats, neither plain → left" };
}

// FORMAT KEY of a character, or of the paragraph style (= the plain look).
function formatKey(csName, f) {
    f = f || {};
    return [csName, f.position, f.baselineShift, f.pointSize, f.underline, f.fillColor].join("|");
}

// For each styled run of the OLD text: did its text survive? → [{style, text, status:
// "kept"|"changed"|"removed", start, end}] — plus the edits that touched it.
function reviewRuns(oldText, styles, ops) {
    var runs = styleRuns(styles), res = [];
    runs.forEach(function (r) {
        var keptChars = 0, touched = false;
        ops.forEach(function (o) {
            var lo = Math.max(o.aStart, r.start), hi = Math.min(o.aEnd, r.end);
            if (o.op === "equal") { if (hi > lo) keptChars += hi - lo; return; }
            if (o.op === "insert") {
                if (o.aStart > r.start && o.aStart < r.end) touched = true;   // strictly inside
                return;
            }
            if (hi > lo) touched = true;
        });
        var len = r.end - r.start;
        var status = (keptChars === len && !touched) ? "kept" : (keptChars === 0 ? "removed" : "changed");
        res.push({ style: r.style, text: oldText.substring(r.start, r.end), start: r.start, end: r.end, status: status });
    });
    return res;
}

// ── host ────────────────────────────────────────────────────────────────────

function _isPlainChar(ch) {
    if (!ch) return false;
    var c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0xFFFC || c === 0xFEFF) return false;
    if (c >= 0xD800 && c <= 0xDFFF) return false;
    if (c >= 0x2028 && c <= 0x2029) return false;
    return true;
}

function _readStyles(para, n) {
    var out = [];
    try {
        var arr = para.characters.everyItem().appliedCharacterStyle;
        if (arr && arr.length >= n) {
            for (var i = 0; i < n; i++) out.push(String(arr[i] && arr[i].name));
            return out;
        }
    } catch (e) { out = []; }
    for (var k = 0; k < n; k++) {
        var nm = null;
        try { nm = String(para.characters.item(k).appliedCharacterStyle.name); } catch (e2) { nm = null; }
        out.push(nm);
    }
    return out;
}

function _charKey(para, i) {
    try {
        var c = para.characters.item(i);
        var fc = null; try { fc = String(c.fillColor.name); } catch (eF) {}
        return formatKey(String(c.appliedCharacterStyle.name),
            { position: String(c.position), baselineShift: Number(c.baselineShift), pointSize: Number(c.pointSize),
              underline: !!c.underline, fillColor: fc });
    } catch (e) { return "?" + i; }
}
function _baseKey(para) {
    try {
        var ps = para.appliedParagraphStyle;
        var fc = null; try { fc = String(ps.fillColor.name); } catch (eF) {}
        return formatKey("[None]", { position: String(ps.position), baselineShift: Number(ps.baselineShift),
            pointSize: Number(ps.pointSize), underline: !!ps.underline, fillColor: fc });
    } catch (e) { return "?base"; }
}

// → { ok, minimal: true|false, reason?, ops: n, review: [...], boundaries: [...],
//     mixedReplacements: [...], coarse, hadTrailingCR }
// minimal:false ⇒ nothing was written; the caller falls back to its whole-paragraph write.
function writeMinimal(para, targetText) {
    var write = String(targetText);
    while (write.length > 0 && write.charAt(write.length - 1) === "\r") write = write.substring(0, write.length - 1);
    var raw = String(para.contents || "");
    var hasCR = raw.length > 0 && raw.charCodeAt(raw.length - 1) === 13;
    var body = hasCR ? raw.substring(0, raw.length - 1) : raw;
    var nChars = para.characters.length;
    if (nChars !== body.length + (hasCR ? 1 : 0)) {
        return { ok: true, minimal: false, reason: "text and character counts differ (" + body.length + " vs " + nChars + ")" };
    }
    if (body.split(FFFC).length !== write.split(FFFC).length) {
        return { ok: true, minimal: false, reason: "anchored-object count differs" };
    }
    if (/[\uD800-\uDFFF]/.test(body) || /[\uD800-\uDFFF]/.test(write)) {
        return { ok: true, minimal: false, reason: "surrogate pairs (offsets would not line up)" };
    }
    if (body === write) return { ok: true, minimal: true, ops: 0, review: [], boundaries: [], mixedReplacements: [], hadTrailingCR: hasCR };

    // diff per anchored-object segment: an anchor character is never touched
    var oldParts = body.split(FFFC), newParts = write.split(FFFC), ops = [], acc = 0, coarse = false;
    for (var s = 0; s < oldParts.length; s++) {
        var d = diffOps(oldParts[s], newParts[s]);
        if (d.coarse) coarse = true;
        d.forEach(function (o) { ops.push({ op: o.op, aStart: o.aStart + acc, aEnd: o.aEnd + acc, text: o.text }); });
        acc += oldParts[s].length + 1;
    }
    var styles = _readStyles(para, body.length);
    var review = reviewRuns(body, styles, ops).filter(function (r) { return r.status !== "kept"; });
    var boundaries = [], mixed = [], edits = 0, baseKey = _baseKey(para);

    for (var i = ops.length - 1; i >= 0; i--) {
        var o = ops[i];
        if (o.op === "equal") continue;
        edits++;
        if (o.op === "delete") {
            para.characters.itemByRange(o.aStart, o.aEnd - 1).remove();
        } else if (o.op === "replace") {
            var seen = {};
            for (var q = o.aStart; q < o.aEnd; q++) seen[styles[q]] = true;
            if (Object.keys(seen).length > 1) {
                mixed.push({ old_text: body.substring(o.aStart, o.aEnd), new_text: o.text, styles: Object.keys(seen) });
            }
            para.characters.itemByRange(o.aStart, o.aEnd - 1).contents = o.text;
        } else {   // insert
            // read the neighbours NOW (every edit so far was at a higher offset)
            var Lk = o.aStart > 0 ? _charKey(para, o.aStart - 1) : null;
            var Rk = o.aStart < body.length ? _charKey(para, o.aStart) : null;
            var side = insertSide(Lk, Rk, baseKey);
            if (side.boundary) {
                boundaries.push({ at: o.aStart, text: o.text, left: Lk, right: Rk, took: side.side, reason: side.reason });
            }
            if (side.side === "right" && _isPlainChar(body.charAt(o.aStart))) {
                // the new text + the right neighbour, written over the neighbour: every new
                // character takes the neighbour's formatting (one source character)
                para.characters.itemByRange(o.aStart, o.aStart).contents = o.text + body.charAt(o.aStart);
            } else {
                if (side.boundary && side.side === "right") boundaries[boundaries.length - 1].took = "left (right neighbour is not a plain character)";
                para.insertionPoints.item(o.aStart).contents = o.text;
            }
        }
    }
    return { ok: true, minimal: true, ops: edits, review: review, boundaries: boundaries,
             mixedReplacements: mixed, coarse: coarse, hadTrailingCR: hasCR };
}

module.exports = {
    diffOps: diffOps,
    styleRuns: styleRuns,
    insertSide: insertSide,
    formatKey: formatKey,
    reviewRuns: reviewRuns,
    writeMinimal: writeMinimal,
    _isPlainChar: _isPlainChar
};
