"use strict";

/**
 * lib/source_format_restore.js — TODO #119 item 2 / design-intent §17 (owner
 * 2026-09-29: 「格式看原文档」). Where does each formatted piece of the SOURCE
 * paragraph land in the TRANSLATION — decided by TEXT IDENTITY only:
 *
 *   M2 same-document translation — the span's text is another segment's source
 *      in this package, and that segment's translation occurs in the target
 *      (Client-A Product-8 p2 title ← the two p1 frames "Client-A" /
 *      "Client-A Product-8")
 *   M1 verbatim — the span's text occurs unchanged in the target (URLs, "®",
 *      English product names). k-th occurrence in the source ↔ k-th in the
 *      target, and only when both have the SAME number of occurrences.
 *   M3 the only one left — after M2/M1, exactly ONE span unplaced AND exactly
 *      ONE non-blank stretch of the target uncovered ⇒ they belong together
 *      ("Visit us online at " ↔ "瀏覽").
 *
 * ⛔ Never by character position, length ratio, fuzzy match or AI (§17). What
 * stays unplaced is returned as such — the caller asks the user (owner: AI
 * suggestion + user confirmation), it is never applied silently.
 *
 * Pure: no host. The caller reads the source spans off the live English
 * paragraph (before the translation is written) and applies the placements.
 */

function _trimRange(text, start, end) {
    while (start < end && /\s/.test(text.charAt(start))) start++;
    while (end > start && /\s/.test(text.charAt(end - 1))) end--;
    return [start, end];
}

function _occurrences(hay, needle) {
    var out = [], i = hay.indexOf(needle);
    while (needle && i >= 0) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
    return out;
}

function _free(covered, s, e) {
    for (var i = s; i < e; i++) if (covered[i]) return false;
    return true;
}

/**
 * placeSpans(o) -> { placements, unplaced }
 *   o.spans    [{ text, base }] in source order (the caller already merged
 *              adjacent spans of the same visible format; blank spans are
 *              skipped here). base = same format as the paragraph style.
 *   o.target   translation text (no trailing paragraph mark)
 *   o.glossary { "<source text>": ["<its translation>", ...] } — this package's
 *              other segments (trimmed keys)
 * placements: [{ span: i, start, end, method: "M2"|"M1"|"M3", text }]
 * unplaced:   [i]  (non-blank spans with no identity-proven place)
 */
function placeSpans(o) {
    o = o || {};
    var spans = o.spans || [], target = String(o.target || ""), gloss = o.glossary || {};
    var covered = new Array(target.length);
    var placed = {}, placements = [];

    function take(i, s, e, method) {
        for (var k = s; k < e; k++) covered[k] = true;
        placed[i] = true;
        placements.push({ span: i, start: s, end: e, method: method, text: target.substring(s, e) });
    }

    // M2 — same-document translation; the longest translation that fits wins
    for (var i = 0; i < spans.length; i++) {
        var key = String(spans[i].text || "").trim();
        if (!key || !Object.prototype.hasOwnProperty.call(gloss, key)) continue;
        var cands = (gloss[key] || []).map(function (s) { return String(s || "").trim(); })
            .filter(Boolean).sort(function (a, b) { return b.length - a.length; });
        for (var c = 0; c < cands.length; c++) {
            var occ = _occurrences(target, cands[c]).filter(function (p) { return _free(covered, p, p + cands[c].length); });
            if (occ.length === 1) { take(i, occ[0], occ[0] + cands[c].length, "M2"); break; }
        }
    }

    // M1 — verbatim, k-th ↔ k-th, equal counts only. k = how many times the
    // text occurs in the WHOLE source before this span (it may also occur inside
    // another span, e.g. "Note" inside "Acme Select Note").
    var srcFull = spans.map(function (s) { return String(s.text || ""); }).join("");
    var spanStart = [], acc = 0;
    for (var ss = 0; ss < spans.length; ss++) { spanStart.push(acc); acc += String(spans[ss].text || "").length; }
    for (var j = 0; j < spans.length; j++) {
        if (placed[j]) continue;
        var kj = String(spans[j].text || "").trim();
        if (!kj) continue;
        var myPos = spanStart[j] + String(spans[j].text || "").indexOf(kj);
        var srcOcc = _occurrences(srcFull, kj);
        var kth = srcOcc.indexOf(myPos);
        if (kth < 0) continue;
        var srcCount = srcOcc.length;
        var tgtOcc = _occurrences(target, kj);
        if (tgtOcc.length !== srcCount || kth >= tgtOcc.length) continue;
        var p = tgtOcc[kth];
        if (_free(covered, p, p + kj.length)) take(j, p, p + kj.length, "M1");
    }

    // M3 — the only one left
    var left = [];
    for (var m = 0; m < spans.length; m++) if (!placed[m] && String(spans[m].text || "").trim()) left.push(m);
    if (left.length === 1) {
        var gaps = [], a = 0;
        while (a < target.length) {
            if (covered[a]) { a++; continue; }
            var b = a;
            while (b < target.length && !covered[b]) b++;
            var t = _trimRange(target, a, b);
            if (t[1] > t[0]) gaps.push(t);
            a = b;
        }
        if (gaps.length === 1) { take(left[0], gaps[0][0], gaps[0][1], "M3"); left = []; }
    }

    // A span with the paragraph style's own format (`base`) needs no placing —
    // it is what the rewritten paragraph already looks like — but it still
    // counted above: M3 may only fire when NOTHING else is left, or a freely
    // translated paragraph would hand its whole text to one emphasis span.
    placements = placements.filter(function (pl) { return !spans[pl.span].base; });
    placements.sort(function (x, y) { return x.start - y.start; });
    var unplaced = [];
    for (var u = 0; u < spans.length; u++) {
        if (!placed[u] && !spans[u].base && String(spans[u].text || "").trim()) unplaced.push(u);
    }
    return { placements: placements, unplaced: unplaced };
}

/**
 * buildGlossary(segments, byTid) -> { "<source text>": ["<translation>", ...] }
 * This package's own segment pairs, for M2. Trimmed; empty / untranslated rows
 * skipped; duplicates removed.
 */
function buildGlossary(segments, byTid) {
    var g = {};
    for (var i = 0; i < (segments || []).length; i++) {
        var s = segments[i];
        if (!s) continue;
        var src = String(s.source_text || "").trim();
        var tr = byTid && byTid[s.tid];
        var tgt = tr && tr.target_text != null ? String(tr.target_text).trim() : "";
        if (!src || !tgt || tgt === src) continue;
        if (!g[src]) g[src] = [];
        if (g[src].indexOf(tgt) < 0) g[src].push(tgt);
    }
    return g;
}

/**
 * mergeGroupSources(segments, byTid) -> { headTid: "full source text" }
 * A soft-break paragraph whose sub-segments the translator merged (head = the row the tails point to,
 * tails = status "merge_tail") stays ONE live paragraph: head + tails joined by the forced line break.
 * The head's own source_text is only the first piece, so capture compared the whole paragraph with a
 * fragment and gave up — the paragraph's source formatting was silently lost (2026-10-01, DocX-1 ④ G2:
 * Product-8 "Client-A Markets®" superscript). Pieces in SEGMENT order; a group whose head is missing
 * is left out (capture then falls back to the head's text and refuses as before).
 */
function mergeGroupSources(segments, byTid) {
    var tails = {}, order = {}, out = {};
    (segments || []).forEach(function (s, i) { if (s && s.tid) order[s.tid] = i; });
    (segments || []).forEach(function (s) {
        if (!s || !s.tid) return;
        var tr = byTid && byTid[s.tid];
        if (tr && String(tr.status || "").toLowerCase() === "merge_tail" && tr.merge_head_tid) {
            (tails[tr.merge_head_tid] = tails[tr.merge_head_tid] || []).push(s);
        }
    });
    Object.keys(tails).forEach(function (head) {
        if (!(head in order)) return;
        var hs = segments[order[head]];
        var parts = [String(hs.source_text || "")].concat(tails[head].sort(function (a, b) { return order[a.tid] - order[b.tid]; })
            .map(function (t) { return String(t.source_text || ""); }));
        out[head] = parts.join("\n");
    });
    return out;
}

/**
 * spanSignature(span) — two adjacent source ranges with the same signature are
 * one visible format span. Colour channels within 1.5 count as equal upstream
 * (the caller rounds), mirroring the 1-unit swatch jitter seen in Client-A packages.
 */
function spanSignature(sp) {
    return JSON.stringify([sp.csName || "", sp.over || {}]);
}

// "R=0 G=121 B=193" → [0,121,193]; anything else → null.
function _rgb(name) {
    var m = /R=(\d+(?:\.\d+)?)\s+G=(\d+(?:\.\d+)?)\s+B=(\d+(?:\.\d+)?)/.exec(String(name || ""));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * sameLook(a, b) — two ranges look the same: same designer style and the same
 * overrides, where colours within 1.5 per channel count as equal (host
 * 2026-09-29: "R=0 G=120 B=192" vs "R=0 G=121 B=193" split one heading into
 * "Pr" + "oduct Features" and flooded the unplaced list).
 */
function sameLook(a, b) {
    if ((a.csName || "") !== (b.csName || "")) return false;
    var oa = a.over || {}, ob = b.over || {};
    var keys = {};
    Object.keys(oa).forEach(function (k) { keys[k] = 1; });
    Object.keys(ob).forEach(function (k) { keys[k] = 1; });
    return Object.keys(keys).every(function (k) {
        if (oa[k] === ob[k]) return true;
        if (k === "fillColor") {
            var ca = _rgb(oa[k]), cb = _rgb(ob[k]);
            if (ca && cb) return Math.abs(ca[0] - cb[0]) <= 1.5 && Math.abs(ca[1] - cb[1]) <= 1.5 && Math.abs(ca[2] - cb[2]) <= 1.5;
            // one side has no colour override (= the style's): equal only if the other is within 1.5 of it
            var styleRgb = a.styleFill || b.styleFill;
            var only = ca || cb, sr = _rgb(styleRgb);
            if (only && sr) return Math.abs(only[0] - sr[0]) <= 1.5 && Math.abs(only[1] - sr[1]) <= 1.5 && Math.abs(only[2] - sr[2]) <= 1.5;
        }
        return false;
    });
}

// Merge adjacent same-look ranges; whitespace-only ranges join the previous
// span (a lone space in another style is not a visible span).
function mergeRanges(ranges) {
    var out = [];
    for (var i = 0; i < (ranges || []).length; i++) {
        var r = ranges[i];
        if (!r || !r.text) continue;
        var last = out[out.length - 1];
        if (last && (!String(r.text).trim() || (last.base === !!r.base && sameLook(last, r)))) {
            last.text += r.text;
            continue;
        }
        out.push({ text: r.text, csName: r.csName || "", over: r.over || {}, base: !!r.base, cs: r.cs, fontStyle: r.fontStyle, fam: r.fam, styleFill: r.styleFill, raw: r.raw || {} });
    }
    return out;
}

// Weight rank for "heavier than the paragraph's own weight". Unknown ⇒ null.
var WEIGHT_RANK = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
    regular: 400, normal: 400, book: 400, roman: 400, medium: 500, semibold: 600, demibold: 600,
    bold: 700, extrabold: 800, xbold: 800, ultrabold: 800, heavy: 900, black: 900 };
function weightRank(style) {
    var k = String(style || "").toLowerCase().replace(/[\s_-]+/g, "").replace(/italic|oblique/g, "");
    return Object.prototype.hasOwnProperty.call(WEIGHT_RANK, k) ? WEIGHT_RANK[k] : null;
}

/**
 * emphasisWeights(pieceWeight, paraWeight, cjkFamily, pairResolver, srcFont)
 *   -> { heavier, latin: null (= keep the source's), cjk, basis, cjkHow, cjkCandidates, lowContrast }
 *
 * ⚠ TRANSITIONAL copy of emphrel's rule (one emphasis-weight rule, owned by emphrel).
 * Shared contract, owner 2026-10-01 (app-folio design-intent §8, acca722) — the 9-30
 * default "heavier than the body ⇒ Latin at least Medium" is WITHDRAWN:
 *   default = the SOURCE weights: Latin as the source, CJK = the brand pair of the
 *     piece's own weight. ⛔ never bumped.
 *   piece heavier than the body BUT lighter than Medium (rank(piece) > rank(body) and
 *     rank(piece) < 500; e.g. Regular in a Light body — the Canadian lead) ⇒
 *     lowContrast = { follow_source: { latin, cjk }, brand_bump: { latin: "Medium",
 *     cjk: pair(Medium) } } — REPORTED for the owner to choose; nothing changes until
 *     the confirmation step applies "brand".
 * Unknown weight or no pair ⇒ cjk null (reported, never guessed).
 *
 * srcFont = the piece's own SOURCE Latin family: emphrel's resolver (53ceecf) needs it
 * when two Latin families pair to the same CJK family with different weights (arch
 * 2026-10-01). With .explain, how / candidates come back too, so a conflict or a
 * missing pair is REPORTED (cjkHow "conflict" | "none"), never a silent null.
 */
function _resolvePair(pairResolver, cjkFamily, weight, srcFont) {
    var r = { cjk: null, how: null, cands: null };
    if (typeof pairResolver !== "function") return r;
    try {
        if (typeof pairResolver.explain === "function") {
            var ex = pairResolver.explain(cjkFamily, weight, srcFont) || {};
            r.cjk = ex.weight || null; r.how = ex.how || (r.cjk ? "resolved" : "none"); r.cands = ex.candidates || null;
        } else {
            r.cjk = pairResolver(cjkFamily, weight, srcFont) || null; r.how = r.cjk ? "resolved" : "none";
        }
    } catch (e) { r.cjk = null; r.how = "error"; }
    return r;
}
function emphasisWeights(pieceWeight, paraWeight, cjkFamily, pairResolver, srcFont) {
    var rp = weightRank(pieceWeight), rb = weightRank(paraWeight);
    var heavier = rp !== null && rb !== null && rp > rb;
    var basis = pieceWeight;
    var p = _resolvePair(pairResolver, cjkFamily, basis, srcFont);
    var low = null;
    if (heavier && rp < WEIGHT_RANK.medium) {
        low = { follow_source: { latin: pieceWeight, cjk: p.cjk },
                brand_bump: { latin: "Medium", cjk: _resolvePair(pairResolver, cjkFamily, "Medium", srcFont).cjk } };
    }
    return { heavier: heavier, latin: null, cjk: p.cjk, basis: basis, cjkHow: p.how, cjkCandidates: p.cands, lowContrast: low };
}

// CJK half of emphasisWeights (kept for callers that only need that).
function cjkWeightForPiece(pieceWeight, paraWeight, cjkFamily, pairResolver, srcFont) {
    return emphasisWeights(pieceWeight, paraWeight, cjkFamily, pairResolver, srcFont).cjk;
}

// A pair problem worth reporting: the resolver ran and gave no weight.
function pairIssueOf(w) {
    return !!w && w.cjk == null && (w.cjkHow === "conflict" || w.cjkHow === "none" || w.cjkHow === "error");
}

module.exports = { placeSpans: placeSpans, buildGlossary: buildGlossary, mergeGroupSources: mergeGroupSources, mergeRanges: mergeRanges, spanSignature: spanSignature,
    weightRank: weightRank, emphasisWeights: emphasisWeights, cjkWeightForPiece: cjkWeightForPiece, pairIssueOf: pairIssueOf, sameLook: sameLook };
