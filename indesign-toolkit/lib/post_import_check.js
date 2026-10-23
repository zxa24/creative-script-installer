"use strict";

/**
 * lib/post_import_check.js — read-only self-check run at the end of an import
 * (task_plan.md#ac-import-hardening P1, owner 2026-09-25).
 *
 * Why: on 2026-09-25 three imports reported `errors: 0` while the documents had
 *   · a paragraph whose soft-break tail was deleted (TODO #106),
 *   · a CJK comma that fell into a Latin bold run → tofu (TODO #105),
 *   · bold / superscript left on the wrong characters after a rewrite (#105/#109).
 * All of them were found only by hand. This module finds them mechanically and
 * NEVER modifies the document.
 *
 * Split: pure helpers (unit-tested in Node, tests/post_import_check_tests.js) +
 * one host function `runHostCheck(doc, segments, translations, opts)` that reads
 * the live InDesign document through the same helpers.
 */

// ── pure helpers ──────────────────────────────────────────────────────────────

var CJK_CHAR_RE = /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;
// Family names that are CJK fonts. The toolkit's fixed list
// (script_font_enforcer CJK_FAMILIES) misses e.g. "MHeiHK", so a name pattern is
// used here as well. A false "is CJK" only hides a finding; the pattern is
// deliberately conservative (named CJK families / explicit region tags).
var CJK_FAMILY_RE = /(^|\s)(MHei|MSung|MKai|Source Han|Noto (Sans|Serif)( CJK)? (SC|TC|HK|JP|KR)|PingFang|Hiragino|Heiti|Songti|Kaiti|SimSun|SimHei|NSimSun|SimKai|Microsoft (YaHei|JhengHei)|Yu (Gothic|Mincho)|Meiryo|MS (P)?(Gothic|Mincho)|Malgun|Gulim|Batang|Dotum|Gungsuh|Nanum|FZ|DFKai|STSong|STHeiti|STKaiti|STFangsong|Apple SD Gothic|Kozuka|KozGo|KozMin|Adobe (Song|Heiti|Fangsong|Kaiti|Ming|Myungjo|Gothic)|HYGothic|HYMyeongJo)/i;

function isCJKChar(ch) { return !!ch && CJK_CHAR_RE.test(ch); }
function hasCJK(s) { return CJK_CHAR_RE.test(String(s == null ? "" : s)); }

function isCJKFamily(family, knownSet) {
    var f = String(family == null ? "" : family);
    if (!f) return false;
    if (knownSet && Object.prototype.hasOwnProperty.call(knownSet, f)) return true;
    return CJK_FAMILY_RE.test(f);
}

// Comparison key: all whitespace (incl. \r \n tab NBSP U+2028/9), BOM, object
// replacement / InDesign marker control chars removed. Two texts that differ
// only in layout whitespace compare equal; a missing word does not.
function textKey(s) {
    return String(s == null ? "" : s)
        .replace(/[\u0000-\u0020\u007F\u00A0\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F\u2060\u3000\uFEFF\uFFFC]/g, "");
}

function _row(translationsByTid, tid) {
    return (translationsByTid && tid && translationsByTid[tid]) || null;
}

// The text a translation row intends to put on the page, or null (= keep source).
// __sb_orig_target: the pipeline overwrites a soft-break group head's target_text
// with the merged group text; the translator's own text is kept here.
function rowTarget(row) {
    if (!row) return null;
    var t = (row.__sb_orig_target != null) ? row.__sb_orig_target : row.target_text;
    if (t == null) return null;
    t = String(t);
    return t.replace(/\s+/g, "").length ? t : null;
}

/**
 * Expected on-page text units, grouped by story id.
 * One unit per ordinary segment; ONE unit per soft-break group (its parts joined),
 * because the group lives in one paragraph and a lost tail is exactly what must
 * show up. merge_tail rows are absorbed by their head and contribute nothing;
 * skip rows and not-located tids are left out.
 *
 * @returns {Object<string, Array<{tids:string[], expected:string, fromTarget:boolean}>>}
 */
function expectedUnits(segments, translationsByTid, notLocatedSet) {
    var byStory = {};
    var groups = {};
    var order = [];
    (segments || []).forEach(function (seg) {
        if (!seg || !seg.tid) return;
        if (notLocatedSet && notLocatedSet[seg.tid]) return;
        var row = _row(translationsByTid, seg.tid);
        var status = row ? String(row.status || "") : "";
        if (status === "skip") return;
        var sid = String(seg.story_id != null ? seg.story_id : "?");
        var g = (seg.soft_break_group != null) ? (sid + "|" + seg.soft_break_group) : null;
        var part = null;
        if (status !== "merge_tail") {
            var tgt = rowTarget(row);
            part = { text: (tgt != null) ? tgt : String(seg.source_text || ""), fromTarget: tgt != null };
        }
        if (g) {
            if (!groups[g]) { groups[g] = { sid: sid, tids: [], parts: [] }; order.push(g); }
            groups[g].tids.push(seg.tid);
            if (part) groups[g].parts.push({ idx: Number(seg.soft_break_index) || 0, p: part });
        } else if (part) {
            (byStory[sid] = byStory[sid] || []).push({ tids: [seg.tid], expected: part.text, fromTarget: part.fromTarget });
        }
    });
    order.forEach(function (g) {
        var G = groups[g];
        if (!G.parts.length) return;
        G.parts.sort(function (a, b) { return a.idx - b.idx; });
        (byStory[G.sid] = byStory[G.sid] || []).push({
            tids: G.tids,
            expected: G.parts.map(function (x) { return x.p.text; }).join("\n"),
            fromTarget: G.parts.some(function (x) { return x.p.fromTarget; })
        });
    });
    return byStory;
}

// Units whose text is not found in their story's current text.
function findMissing(unitsByStory, storyTextById) {
    var out = [];
    Object.keys(unitsByStory || {}).forEach(function (sid) {
        var hay = textKey(storyTextById[sid]);
        unitsByStory[sid].forEach(function (u) {
            // Only units this import wrote. A unit that is all source text was not
            // touched; its package source_text can legitimately differ from the page
            // when the document was edited after the package was exported (DocX-2
            // SC: semicolons made full-width at 15:55, package from 13:35).
            if (!u.fromTarget) return;
            var k = textKey(u.expected);
            if (!k) return;
            if (storyTextById[sid] == null || hay.indexOf(k) < 0) {
                out.push({ story_id: sid, tids: u.tids, expected: u.expected, from_target: u.fromTarget,
                           reason: storyTextById[sid] == null ? "story not found" : "text not found in story" });
            }
        });
    });
    return out;
}

// Rewritten segments: target present and different from the source.
/**
 * Rows the import could NOT locate although the package has text to write for them
 * (arch 2026-10-03). Their translation never reached the document, and nothing else
 * says so: the pipeline lists them as blocking, automation waves blocking through
 * (continueOnBlocking), and the missing-text check leaves not-located rows out.
 * Counted: a non-empty target, status not merge_tail / skip / todo. A row with nothing
 * to write is not a loss. Whether the document already holds the same text cannot be
 * told — a row that was not located has no paragraph to read — so every such row is
 * reported (arch: do not add a second way of locating just to report less).
 *
 * @returns {Array<{tid:string, from:string, to:string}>}
 */
function notLocatedRows(segments, translationsByTid, notLocatedSet, detailByTid) {
    var out = [];
    if (!notLocatedSet) return out;
    (segments || []).forEach(function (seg) {
        if (!seg || !notLocatedSet[seg.tid]) return;
        var row = _row(translationsByTid, seg.tid);
        if (!row) return;
        var st = String(row.status || "");
        if (st === "merge_tail" || st === "skip" || st === "todo") return;
        var t = rowTarget(row);
        if (t == null) return;
        var item = { tid: seg.tid, from: String(seg.source_text || ""), to: t };
        if (detailByTid && detailByTid[seg.tid]) item.detail = String(detailByTid[seg.tid]);
        out.push(item);
    });
    return out;
}

/**
 * A paragraph that holds, as one of its forced-line-break pieces, the WHOLE text of
 * another paragraph of the same story (arch 2026-10-03): the shape left when a
 * soft-break group's joined text is written into the head paragraph while the tail
 * still has its own paragraph (DocX-1 Product-8 story 380). Nothing else reports it —
 * no text is missing, nothing is overset.
 * Compared after trimming; the piece needs at least 6 non-space characters ("年期"
 * style labels repeat legitimately). The paragraph must have at least two pieces.
 * NOT detected: a repeat across two stories; a repeat of only part of a paragraph;
 * two plain paragraphs with the same text (tables and lists do that legitimately).
 *
 *   parasByStory = { storyId: [paragraph text, ...] }
 * @returns {Array<{story_id:string, paragraph:number, piece:number, other_paragraph:number, text:string}>}
 */
function findBreakPieceDuplicates(parasByStory) {
    var out = [];
    Object.keys(parasByStory || {}).forEach(function (sid) {
        var paras = (parasByStory[sid] || []).map(function (p) {
            return String(p == null ? "" : p).replace(/\u2028/g, "\n").replace(/[\r\n]+$/, "");
        });
        var whole = paras.map(function (p) { return p.replace(/^\s+|\s+$/g, ""); });
        paras.forEach(function (p, i) {
            if (p.indexOf("\n") < 0) return;
            p.split("\n").forEach(function (piece, k) {
                var t = piece.replace(/^\s+|\s+$/g, "");
                if (t.replace(/\s+/g, "").length < 6) return;
                for (var j = 0; j < whole.length; j++) {
                    if (j !== i && whole[j] === t) { out.push({ story_id: String(sid), paragraph: i, piece: k, other_paragraph: j, text: t }); break; }
                }
            });
        });
    });
    return out;
}

/**
 * A whole SOURCE paragraph still standing in a translated document (arch 2026-10-03).
 * DocX-1 Product-8 story 3713: the translator merged two rows that are two paragraphs;
 * the import writes the joined translation into the head's paragraph and skips the
 * merge_tail row, so the tail's English paragraph stayed — in the 9-29 and 10-01
 * production PDFs — and no check said so (findings
 * #merge-tail-across-paragraphs-leaves-the-source-paragraph).
 *
 * Reported: a paragraph that, trimmed, equals the source text of a row OF THE SAME STORY,
 * has no CJK character and at least 5 Latin words (so "$1,000", "09/00-0000-ACC", "Client-A"
 * — rows nobody translates — do not count). Only when the package's targets are CJK.
 *   merged          the row is a merge_tail: its translation went into the head row
 *                   (the head has a target, or the head is unknown)        → problem
 *   same_as_source  the row's own target equals its source                  → review
 * Not reported: a row still to be translated (empty target / todo) — untranslated, not
 * left over; a row whose target differs from the source (if that text is not in the
 * document, the missing-text check reports it).
 * NOT detected: a source paragraph changed by even one character; source text that is
 * only part of a paragraph; table cells (their paragraphs are not read here).
 *
 *   parasByStory = { storyId: [paragraph text, ...] }
 * @returns {Array<{story_id, paragraph, tid, kind, head_tid, text}>}
 */
function leftoverSourceParagraphs(parasByStory, segments, translationsByTid) {
    var out = [], byTid = translationsByTid || {};
    var cjkTarget = false;
    (segments || []).forEach(function (seg) { var r = seg && byTid[seg.tid]; if (r && hasCJK(r.target_text)) cjkTarget = true; });
    if (!cjkTarget) return out;
    function trim(x) { return String(x == null ? "" : x).replace(/\u2028/g, "\n").replace(/^\s+|\s+$/g, ""); }
    var bySrc = {};   // storyId -> { trimmed source -> seg }
    (segments || []).forEach(function (seg) {
        if (!seg || seg.story_id == null) return;
        var k = trim(seg.source_text);
        if (!k) return;
        var m = bySrc[String(seg.story_id)] = bySrc[String(seg.story_id)] || {};
        if (!m[k]) m[k] = seg;
    });
    Object.keys(parasByStory || {}).forEach(function (sid) {
        var m = bySrc[String(sid)];
        if (!m) return;
        (parasByStory[sid] || []).forEach(function (p, i) {
            var t = trim(p);
            if (!t || hasCJK(t)) return;
            if ((t.match(/[A-Za-z]+/g) || []).length < 5) return;
            var seg = m[t];
            if (!seg) return;
            var row = byTid[seg.tid];
            if (!row) return;
            if (String(row.status || "") === "merge_tail") {
                var headTid = row.merge_head_tid ? String(row.merge_head_tid) : "";
                if (headTid && rowTarget(byTid[headTid]) == null) return;   // the head has nothing either: untranslated, not left over
                out.push({ story_id: String(sid), paragraph: i, tid: seg.tid, kind: "merged", head_tid: headTid, text: t });
                return;
            }
            var tgt = rowTarget(row);
            if (tgt != null && trim(tgt) === t && String(row.status || "") !== "todo") {
                out.push({ story_id: String(sid), paragraph: i, tid: seg.tid, kind: "same_as_source", head_tid: "", text: t });
            }
        });
    });
    return out;
}
function leftoverLine(l) {
    var head = "- " + (l.kind === "merged" ? "🔴 " : "") + "`" + l.tid + "` (story " + l.story_id + " paragraph " + (l.paragraph + 1) + "): \"" + _clip(l.text, 60) + "\" | ";
    if (l.kind === "merged") return head + "the translation of this row was merged into " + (l.head_tid ? "`" + l.head_tid + "`" : "another row (the package does not say which)") + ", and this source paragraph is still in the document";
    return head + "the translation equals the source, the whole source paragraph stays in the document";
}

/**
 * Read-back (arch 2026-10-04): what the report calls written must be what the document
 * holds NOW. "changed" used to be computed from the package alone, and "missing text"
 * passes whenever the target is found anywhere in the row's story — so a target that is a
 * piece of the OLD text passes while the paragraph was never written (DocX-1 Product-8
 * frame 3637).
 *
 * No paragraph reference taken before the writes is used: a UXP reference is live, and
 * after a write that changes lengths or paragraph counts it can point at other text
 * (findings uxp-live-references-and-shifted-baselines). Instead the caller reads every
 * story's paragraphs AFTER all writes, and a row is confirmed when a paragraph of ITS
 * story equals this round's text — by content, not by position, so a paragraph that grew
 * or a paragraph added before it changes nothing.
 * Counted, not just found: two rows that expect the same text in one story need two such
 * paragraphs (one paragraph cannot confirm two rows).
 *
 *   changed      rows whose target differs from their source (changedSegments)
 *   unitsByStory { storyId: [paragraph text, ...] } read after the writes (table cell
 *                paragraphs included); a story missing here could not be read
 *   storyByTid   { tid: storyId } for LOCATED rows only (the story the row was located in);
 *                a row absent from it was not located and is reported by notLocatedRows
 * Compared with the record's normaliser (line ends unified, paragraph mark dropped, every
 * other character exact). A soft-break sub-segment after the first is not written on its
 * own: its text must be CONTAINED in a paragraph of the story. A soft-break head is
 * compared with the joined text the pipeline put into target_text.
 * @returns {{ confirmed: Array, mismatch: Array<{tid, expected, found}>, unreadable: Array<{tid}> }}
 *          `found` = what the story holds at the row's paragraph index now (for the reader;
 *          it is not what decided the verdict), "" when there is no such paragraph.
 */
/**
 * splitWritten(changed, writtenTids, segments) -> { written: [...], already: [...] }
 * arch 2026-10-06: "本轮改动" said 42 on a same-package re-import where nothing was written. The
 * confirmed rows are split by whether THIS run wrote their paragraph: `writtenTids` is the list the
 * pipeline kept at its write sites (report.apply.written_tids). A soft-break sub-row counts as
 * written when any row of its group was written (the group is one paragraph, written once).
 */
function splitWritten(changed, writtenTids, segments) {
    var w = {}, groups = {};
    (writtenTids || []).forEach(function (t) { w[String(t)] = true; });
    (segments || []).forEach(function (sg) { if (sg && sg.soft_break_group && w[sg.tid]) groups[String(sg.soft_break_group)] = true; });
    var segByTid = {}; (segments || []).forEach(function (sg) { if (sg) segByTid[sg.tid] = sg; });
    var out = { written: [], already: [] };
    (changed || []).forEach(function (c) {
        var sg = segByTid[c.tid];
        var isW = !!w[c.tid] || !!(sg && sg.soft_break_group && groups[String(sg.soft_break_group)]);
        (isW ? out.written : out.already).push(c);
    });
    return out;
}

function readbackChanged(changed, unitsByStory, storyByTid, segments, translationsByTid) {
    var DC = require("./import_diff_classify.js"), norm = DC._internal.normalizeLiveText;
    var segByTid = {}, out = { confirmed: [], mismatch: [], unreadable: [] }, used = {};
    (segments || []).forEach(function (sg) { if (sg) segByTid[sg.tid] = sg; });
    (changed || []).forEach(function (c) {
        if (!storyByTid || !Object.prototype.hasOwnProperty.call(storyByTid, c.tid)) return;   // not located: reported elsewhere
        var sid = String(storyByTid[c.tid]);
        var units = unitsByStory ? unitsByStory[sid] : null;
        if (!units) { out.unreadable.push({ tid: c.tid }); return; }
        var seg = segByTid[c.tid] || {}, row = (translationsByTid || {})[c.tid] || {};
        var isTail = !!seg.soft_break_group && typeof seg.soft_break_index === "number" && seg.soft_break_index >= 1;
        var i;
        if (isTail) {
            var piece = norm(c.to).replace(/^\s+|\s+$/g, "");
            for (i = 0; i < units.length; i++) { if (piece.length && norm(units[i]).indexOf(piece) >= 0) { out.confirmed.push(c); return; } }
            out.mismatch.push({ tid: c.tid, expected: String(c.to), found: "" });
            return;
        }
        // the head of a merged soft-break group carries the joined text in target_text
        var expected = (row.__sb_orig_target != null && row.target_text != null) ? row.target_text : c.to;
        var want = norm(expected), taken = used[sid] = used[sid] || {};
        for (i = 0; i < units.length; i++) {
            if (!taken[i] && norm(units[i]) === want) { taken[i] = true; out.confirmed.push(c); return; }
        }
        var pIdx = (typeof seg.paragraph_index === "number") ? seg.paragraph_index : 0;
        var at = (pIdx >= 0 && pIdx < units.length) ? String(units[pIdx]) : "";
        out.mismatch.push({ tid: c.tid, expected: String(expected), found: at });
    });
    return out;
}

// Diagnostics for the host run: does the paragraph reference taken before the writes still
// read this round's text where the fresh read says the row is confirmed (and the reverse)?
// Never part of the verdict.
function refDisagreements(rb, refTextByTid, translationsByTid) {
    var DC = require("./import_diff_classify.js"), norm = DC._internal.normalizeLiveText, out = [];
    function expectedOf(c) { var row = (translationsByTid || {})[c.tid] || {}; return (row.__sb_orig_target != null && row.target_text != null) ? row.target_text : (c.to != null ? c.to : c.expected); }
    function look(list, fresh) {
        (list || []).forEach(function (c) {
            if (!Object.prototype.hasOwnProperty.call(refTextByTid, c.tid)) return;
            var ref = refTextByTid[c.tid];
            var refSays = (ref === null || ref === undefined) ? "unreadable" : (norm(ref) === norm(expectedOf(c)) ? "equal" : "different");
            if ((fresh === "confirmed") !== (refSays === "equal")) out.push({ tid: c.tid, fresh: fresh, old_reference: refSays });
        });
    }
    look(rb.confirmed, "confirmed"); look(rb.mismatch, "mismatch");
    return out;
}

function changedSegments(segments, translationsByTid) {
    var out = [];
    (segments || []).forEach(function (seg) {
        var row = _row(translationsByTid, seg && seg.tid);
        if (!row || String(row.status || "") === "merge_tail") return;
        var t = rowTarget(row);
        if (t == null) return;
        if (textKey(t) === textKey(seg.source_text)) return;
        out.push({ tid: seg.tid, from: String(seg.source_text || ""), to: t,
                   mixed_source_format: !!(seg.format_snapshot && seg.format_snapshot.uniform === false) });
    });
    return out;
}

// Runs = [{text, family, style, charStyle, position, underline}] of one text container.
// A run is a tofu risk when it holds CJK characters and its font is not a CJK font.
function tofuRuns(runs, knownSet) {
    var out = [];
    (runs || []).forEach(function (r, i) {
        if (!r || !hasCJK(r.text)) return;
        if (isCJKFamily(r.family, knownSet)) return;
        var cjk = String(r.text).split("").filter(isCJKChar).join("");
        out.push({ run_index: i, text: String(r.text), cjk_chars: cjk, font: r.family + (r.style ? " " + r.style : "") });
    });
    return out;
}

// Table cells whose text does not fit. No text frame or story reports
// `overflows` for it — the value is simply not drawn (TODO #124: Select "$1,000"
// gone from the PDF while every frame/story read overflows=false).
// ⚠ Host-measured 2026-09-30: an overset cell's `cell.contents` reads "" — the
// text is only in `cell.texts.item(0).contents`. So pass the TEXTS content here
// (and use it for the missing-text haystack), never cell.contents.
// cells = [{ overflows, contents (from cell.texts), name, where }]
function oversetCells(cells) {
    var out = [];
    (cells || []).forEach(function (c) {
        if (!c || c.overflows !== true) return;
        // blocking (arch 2026-09-30): hidden text ⇒ must be handled before a final PDF
        var row = { cell: String(c.name == null ? "?" : c.name), where: String(c.where || ""), text: String(c.contents == null ? "" : c.contents),
                   kind: "cell_overset", severity: "blocking" };
        // where Show goes (#153): story, table and cell by position, and the page name when it is known
        ["story_id", "table_index", "cell_index", "page"].forEach(function (k) { if (c[k] !== undefined) row[k] = c[k]; });
        out.push(row);
    });
    return out;
}

// owner 2026-10-01 (design-intent §8, B1): when the brand config has NO pair for a
// Latin face (e.g. Arial, Minion Pro, or no config at all) the style builder falls
// back to the source weight name — allowed, but it MUST be listed as "config lacks
// a pair: <font>" so the owner can add the pair. ⛔ The pipeline never edits the
// config. fallbackRank = style_plan.cluster_report.cjk_weight_resolution.fallbackRank.
// -> [{ font, weight, cjk, styles: [{ name, segments }] }]
function configMissingPairs(fallbackRank) {
    return (fallbackRank || []).filter(function (f) { return f && f.srcFont; }).map(function (f) {
        return { font: String(f.srcFont), weight: String(f.srcStyle || ""), cjk: String(f.family || "") + " " + String(f.resolvedStyle || ""),
                 styles: (f.styles || []).map(function (s) { return { name: String(s.name), segments: s.segments || 0 }; }) };
    });
}

// Attach to each style the number of paragraphs that use it (counts from the live
// document: { styleName: n }). A style that exists but no paragraph uses gets 0
// and is said so explicitly.
function attachParagraphCounts(missing, countsByStyle) {
    (missing || []).forEach(function (m) {
        m.styles.forEach(function (s) { s.paragraphs = (countsByStyle && countsByStyle[s.name]) || 0; });
    });
    return missing;
}

// arch 2026-10-01: the font is also "in use" when it is set locally (a run inside a
// paragraph of some OTHER style — Select has Arial that way). Count those paragraphs
// too, else "no paragraph uses it" reads as "safe to ignore" while the font is used.
// A run with no VISIBLE character (only a table anchor U+0016 or other control /
// marker characters) does not count (arch 2026-10-01: Select's Minion Pro "use" was a
// lone table anchor in [Basic Paragraph]).
//   paras = [{ style: paragraphStyleName, runs: [{ font: "Family\tStyle", text }] }]
var _VISIBLE_RE = new RegExp("[^\\s\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\uFEFF\\uFFFC\\uFFFD]");
function hasVisibleChar(s) { return _VISIBLE_RE.test(String(s == null ? "" : s)); }
function attachLocalUseCounts(missing, paras) {
    (missing || []).forEach(function (m) {
        var own = {}, key = m.font + "\t" + m.weight, n = 0;
        m.styles.forEach(function (s) { own[s.name] = true; });
        (paras || []).forEach(function (p) {
            if (!p || own[p.style]) return;
            if ((p.runs || []).some(function (r) { return r && r.font === key && hasVisibleChar(r.text); })) n++;
        });
        m.localParagraphs = n;
    });
    return missing;
}

// One wording for the report and the import log (emphasis pieces whose CJK weight
// the brand pairs cannot decide — arch 2026-10-01, never silent):
//   "Config pairing conflict: <src font> <weight> -> <cjk family>, candidates Dax=Bold / Arial=Xbold | piece \"...\""
function pairIssueLine(p) {
    var cands = p.candidates && typeof p.candidates === "object"
        ? Object.keys(p.candidates).map(function (k) { return k + "=" + p.candidates[k]; }).join(" / ") : "";
    var head = p.how === "conflict" ? "Config pairing conflict" : (p.how === "error" ? "Pairing lookup failed" : "Config pairing missing");
    return head + ": " + (p.source_font_family || "?") + " " + (p.source_weight || "?") + " -> " + (p.cjk_family || "?")
        + (cands ? ", candidates " + cands : "") + " | piece \"" + _clip(p.piece, 30) + "\"" + (p.placed ? "" : " (piece not located, the confirm step will use it)");
}

// One wording for the report and the import log:
//   "paragraph styles N paragraphs | local overrides M paragraphs (styles X: n paragraphs; ...)"; both 0 => "not used (...)".
function missingPairUsage(m) {
    var N = 0, read = true;
    var st = (m.styles || []).map(function (s) {
        if (typeof s.paragraphs !== "number") { read = false; return s.name + ": paragraph count not read"; }
        N += s.paragraphs; return s.name + ": " + s.paragraphs + " paragraph(s)";
    }).join("; ");
    var M = m.localParagraphs;
    var head;
    if (!read || typeof M !== "number") head = "paragraph styles " + (read ? N + " paragraph(s)" : "not read") + " | local overrides " + (typeof M === "number" ? M + " paragraph(s)" : "not read");
    else head = (N === 0 && M === 0) ? "not used" : ("paragraph styles " + N + " paragraph(s) | local overrides " + M + " paragraph(s)");
    return head + (st ? " (styles " + st + ")" : "");
}

// I-5 italic_carried { realization, face, angle? } in words
function _italicCarriedText(c) {
    var f = String(c.face || "?").replace("\t", " ");
    if (c.realization === "faux") return f + " + slant " + c.angle + "°";
    if (c.realization === "real") return f + " (real italic)";
    if (c.realization === "keep") return f + " (existing real italic)";
    if (c.realization === "block") return f + " upright (a real italic is configured, but there is no italic face at this weight)";
    return f + " upright (no italic configured for this weight)";
}
function _clip(s, n) { s = String(s == null ? "" : s).replace(/[\r\n]+/g, "⏎"); return s.length > n ? s.slice(0, n) + "…" : s; }

// TODO #136 ① ② — header bar (lib/header_bar.js scan + reshaped rows). The first line
// is the recognition count and is printed even when everything is 0: on a template
// the rule does not know, "not recognised" must not read like "no header".
var REMOVAL_REASON = require("./merge_tail_removal.js").REASON_TEXT;
var SPLIT_REASON = (function () { var r = require("./header_two_cell_split.js").REASON_TEXT, o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k]; }); o.company_frame_missing = "the company name frame split off last time is gone"; o.template_frame_missing = "the template company name frame is gone"; o.record_without_template = "the record has no template frame (old record)"; return o; })();
var _HB_VERDICT = { two_cells: "one frame holds two cells (the original separates the two texts with a wide gap on both sides of the line)",
                    crossed: "the text crosses the line", unreadable: "the frame spans the line, the letter positions cannot be read" };
function headerBarLines(hb) {
    if (!hb) return [];
    if (hb.failed) return ["- ⚠ Header bar recognition did not finish: " + hb.failed + " (this run did not tidy the header product names by section 19 and did not check for one frame holding two cells)"];
    var L = [];
    L.push("- Recognition result: " + hb.pages + " page(s), " + hb.bars + " color bar(s), " + hb.dividers + " divider(s), "
        + (hb.product_frames || []).length + " product name frame(s)" + ((hb.bars === 0) ? " (no color bar recognized: this document was not handled by the header rule)" : ""));
    (hb.two_cell || []).forEach(function (c) {
        L.push("- 🔴 [Needs manual work] page " + c.page + " text frame " + c.frame_id + ": " + (_HB_VERDICT[c.verdict] || c.verdict)
            + " (line x=" + c.line_x + "pt) \"" + _clip(c.text, 50) + "\" | split it into two frames, one on each side of the line");
    });
    var sp = hb.split;
    if (sp) {
        (sp.done || []).forEach(function (d) { L.push("- Split: page " + d.page + " text frame " + d.frame_id + ": company name \"" + _clip(d.left_target, 30) + "\" went into new frame " + d.new_frame_id + ", the original frame moved to the product name position and keeps only the product name (frame size copied from the template, not adjusted afterwards)"); });
        (sp.refused || []).forEach(function (r) { L.push("- 🔴 [Needs manual work] page " + r.page + " text frame " + r.frame_id + " not split: " + (SPLIT_REASON[r.reason] || r.reason)); });
        (sp.failed || []).forEach(function (f) { L.push("- 🔴 Split failed: page " + f.page + " text frame " + f.frame_id + ": " + f.error + " | the whole import is one undo step, undo it as a whole"); });
        (sp.rederived || []).forEach(function (r) { L.push("- " + (r.ok ? "Frame split earlier " + r.frame_id + ": the translation was written as the product name only, as split last time" + (r.left_rewritten ? "; the company name translation changed and was written into frame " + r.new_frame_id : "") : "⚠ Frame split earlier " + r.frame_id + ": " + (SPLIT_REASON[r.reason] || r.reason) + ", please check by hand")); });
        var sty = sp.styles || null;   // arch 2026-10-06: the company frame follows the template's final paragraph style
        if (sty) {
            (sty.settled || []).forEach(function (r) { L.push("- Company name frame " + r.new_frame_id + " paragraph style " + (r.before === r.after ? "is already" : "changed from \"" + r.before + "\" to") + " \"" + r.after + "\" of template frame " + r.template_company_frame_id + " (confirmed by read-back)"); });
            (sty.failed || []).forEach(function (r) { L.push("- 🔴 Company name frame " + r.new_frame_id + " paragraph style did not follow the template: " + (SPLIT_REASON[r.reason] || r.reason)); });
        }
    }
    (hb.rows || []).forEach(function (r) {
        if (r.status === "no_english") L.push("- `" + r.tid + "`: header bar has no English name \"" + _clip(r.to, 50) + "\" (by the rule the English product name goes on the second line; the translation has none, the pipeline does not add text)");
        else if (r.status === "reshaped") L.push("- `" + r.tid + "`: set in two lines \"" + _clip(r.to, 60) + "\"");
    });
    (hb.errors || []).forEach(function (e) { L.push("- ⚠ Error while recognizing: " + e); });
    return L;
}
function headerBarNeeds(hb) {   // "" | "review" | "problem"
    if (!hb) return "";
    if (hb.failed) return "problem";
    var spl = hb.split || null;
    if (spl && (spl.failed.length || spl.refused.length)) return "problem";              // a two-cell frame that is still one frame
    if (!spl && hb.two_cell && hb.two_cell.length) return "problem";
    if (spl && spl.rederived.some(function (r) { return !r.ok; })) return "review";
    if (spl && spl.styles && spl.styles.failed && spl.styles.failed.length) return "review";   // the company frame did not take the template's style
    if ((hb.errors && hb.errors.length) || (hb.rows || []).some(function (r) { return r.status === "no_english"; })) return "review";
    return "";
}

// D2: one edit-mode review entry (report.apply.edit_text_review[i]) → markdown lines
var _EMP_STATUS = { removed: "the whole text was deleted, the emphasis went with it", changed: "the text was partly changed, the emphasis stays on the unchanged and changed characters in it" };
function editReviewLines(r) {
    var out = [];
    (r.emphasis || []).forEach(function (e) {
        out.push("- `" + r.tid + "`: «" + _clip(e.text, 40) + "» [" + e.style + "] | " + (_EMP_STATUS[e.status] || e.status));
    });
    (r.boundaries || []).forEach(function (b) {
        out.push("- `" + r.tid + "`: inserted \"" + _clip(b.text, 30) + "\" at a format boundary | the new text took the format of the " + (b.took === "right" ? "following" : "preceding") + " text (" + b.reason + ")");
    });
    (r.mixed_replacements || []).forEach(function (m) {
        out.push("- `" + r.tid + "`: \"" + _clip(m.old_text, 30) + "\" -> \"" + _clip(m.new_text, 30) + "\" spans different formats, the new text inherits by position");
    });
    if (r.coarse) out.push("- `" + r.tid + "`: the paragraph is too long, the middle was replaced as one block (not aligned character by character)");
    return out;
}

function toMarkdown(res) {
    var L = [];
    L.push("# Post-import self-check " + (res.generated_at || ""));
    L.push("");
    L.push("Document: " + (res.document || "?") + "  Verdict: **" + res.verdict + "**");
    L.push("");
    L.push("| Check | Found |");
    L.push("|---|---|");
    L.push("| Missing text (including lost text in soft-return paragraphs) | " + res.missing_text.length + " |");
    L.push("| Tofu risk (Chinese in a non-Chinese font) | " + res.tofu_risk.length + " |");
    L.push("| Overset text frames / table cells | " + res.overset.length + " |");
    L.push("| Format to review (mixed formats in the source paragraph, rewritten this run) | " + res.format_review.length + " |");
    if (res.written_known) {
        L.push("| Paragraphs written this run (confirmed by read-back) | " + res.written.length + " |");
        L.push("| Paragraphs already translated in the document (not written this run) | " + res.already_translated.length + " |");
    } else {
        L.push("| Paragraphs whose translation differs from the source and is in the document" + (res.changed_is_readback ? " (confirmed by read-back; whether written this run is not told apart)" : " (by the translation package, not read back)") + " | " + res.changed.length + " |");
    }
    L.push("| Read-back mismatch after writing | " + (res.readback_mismatch || []).length + " |");
    L.push("| Rows not located (translation not written) | " + (res.not_located || []).length + " |");
    L.push("| Duplicate text (a paragraph holds the whole text of another paragraph) | " + (res.duplicate_text || []).length + " |");
    L.push("| Leftover source paragraph | " + (res.leftover_source || []).length + " |");
    L.push("");
    L.push("Coverage: missing text is checked only for paragraphs that got a translation this run (with their soft-return group); unchanged paragraphs and merged-away paragraphs (merge_tail) are not checked. "
        + "Missing text is judged by whether the translation can be found in the full text of its story: when the translation happens to be a piece of the old text it passes falsely, and the read-back mismatch check covers that case. "
        + "Formats are only listed as candidates, not judged. Line breaks, list numbering and underline weight are not checked.");
    if (res.incomplete) L.push("\n⚠ Self-check did not finish: " + res.incomplete);
    if (res.soft_break_notice) L.push("\n⚠ " + res.soft_break_notice);
    if (res.missing_text.length) {
        L.push("\n## Missing text");
        res.missing_text.forEach(function (m) { L.push("- `" + m.tids.join(", ") + "` (story " + m.story_id + ") should have: \"" + _clip(m.expected, 80) + "\" | " + m.reason); });
    }
    if (res.readback_mismatch && res.readback_mismatch.length) {
        L.push("\n## Read-back mismatch after writing");
        L.push("These rows were located to a paragraph, but that paragraph now does not hold the translation of this run.");
        res.readback_mismatch.forEach(function (m) { L.push("- 🔴 `" + m.tid + "`: expected \"" + _clip(m.expected, 50) + "\" found \"" + _clip(m.found, 50) + "\""); });
    }
    if (res.readback_unreadable && res.readback_unreadable.length) {
        L.push("\n## Could not be read back (write not confirmed)");
        L.push("- " + res.readback_unreadable.map(function (u) { return "`" + u.tid + "`"; }).join(", "));
    }
    if (res.not_located && res.not_located.length) {
        L.push("\n## Rows not located (translation not written)");
        L.push("No matching paragraph was found in the document for these rows, so the translation of this run was not written and the document keeps its old text. "
            + "Without a location the existing text cannot be read, so some of these rows may have a translation equal to the existing text.");
        res.not_located.forEach(function (n) { L.push("- 🔴 `" + n.tid + "`: source \"" + _clip(n.from, 40) + "\" translation of this run \"" + _clip(n.to, 40) + "\"" + (n.detail ? " (" + n.detail + ")" : "")); });
    }
    if (res.duplicate_text && res.duplicate_text.length) {
        L.push("\n## Duplicate text");
        L.push("In one story, a piece of a paragraph (split by forced line breaks) equals the whole text of another paragraph. "
            + "Not detected: a duplicate across two stories; a duplicate of only half; two ordinary paragraphs with the same text (normal in tables and lists).");
        res.duplicate_text.forEach(function (d) {
            L.push("- 🔴 story " + d.story_id + ": piece " + (d.piece + 1) + " of paragraph " + (d.paragraph + 1) + " = the whole of paragraph " + (d.other_paragraph + 1) + " \"" + _clip(d.text, 50) + "\"");
        });
    }
    if (res.leftover_source && res.leftover_source.length) {
        L.push("\n## Leftover source paragraph");
        L.push("A paragraph in the document equals, letter for letter, the source of a row of the same story in the package, has no CJK text and at least 5 Latin words. "
            + "Not detected: a source paragraph changed by even one letter; a source that is only part of a paragraph; a paragraph inside a table cell. Rows still to be translated are not listed here.");
        res.leftover_source.forEach(function (l) { L.push(leftoverLine(l)); });
    }
    if (res.tofu_risk.length) {
        L.push("\n## Tofu risk");
        res.tofu_risk.forEach(function (t) { L.push("- story " + t.story_id + (t.where ? " (" + t.where + ")" : "") + ": \"" + t.cjk_chars + "\" in \"" + _clip(t.text, 40) + "\" uses " + t.font); });
    }
    if (res.overset.length) {
        L.push("\n## Overset");
        res.overset.forEach(function (o) {
            if (o.cell != null) L.push("- 🔴 [Blocks delivery] table cell " + o.cell + " (" + o.where + "): \"" + _clip(o.text, 40) + "\" | the cell cannot hold it, this text will not show; fix it before the final PDF");
            else L.push("- Text frame " + o.frame_id + " (" + o.where + "): \"" + _clip(o.text, 40) + "\"");
        });
    }
    if (res.format_review.length) {
        L.push("\n## Format to review");
        res.format_review.forEach(function (f) {
            L.push("- `" + f.tid + "`: " + (f.runs ? f.runs.map(function (r) {
                return "«" + _clip(r.text, 30) + "» " + r.family + (r.style ? " " + r.style : "") + (r.charStyle && r.charStyle !== "[None]" ? " [" + r.charStyle + "]" : "")
                    + (r.position && r.position !== "NORMAL" ? " " + r.position : "") + (r.underline ? " U" : "");
            }).join(" | ") : "(paragraph not found)"));
        });
    }
    if (res.config_missing_pairs && res.config_missing_pairs.length) {
        L.push("\n## Config pairing missing (the Chinese weight falls back to the source weight name until the owner adds the pairing to the brand config; the pipeline does not change the config)");
        res.config_missing_pairs.forEach(function (m) {
            L.push("- Config pairing missing: " + m.font + " " + m.weight + " -> Chinese falls back to " + m.cjk + " | " + missingPairUsage(m));
        });
    }
    if (res.emphasis_pair_issues && res.emphasis_pair_issues.length) {
        L.push("\n## Emphasis pieces: config pairing conflict / missing (the Chinese of these pieces got no weight; the pipeline does not change the config)");
        res.emphasis_pair_issues.forEach(function (p) { L.push("- " + pairIssueLine(p)); });
    }
    if (res.merge_tail_removals && (res.merge_tail_removals.removed.length || res.merge_tail_removals.refused.length || res.merge_tail_removals.failed.length || (res.merge_tail_removals.already_removed || []).length)) {
        L.push("\n## Cross paragraph merge: the source paragraph of the second row");
        L.push("When the translator merged two rows into one translation and the two rows are two paragraphs, the translation is written into the first paragraph and the import deletes the source of the second (owner 2026-10-04). The deleted ones are listed here, they change the document structure.");
        res.merge_tail_removals.removed.forEach(function (r) { L.push("- Deleted `" + r.tid + "`: story " + r.story_id + " original paragraph " + (r.ordinal + 1) + " \"" + _clip(r.source_text, 50) + "\" (its translation was merged into `" + r.head_tid + "`)"); });
        res.merge_tail_removals.refused.forEach(function (r) { L.push("- ⚠ Not deleted `" + r.tid + "`: " + (REMOVAL_REASON[r.reason] || r.reason) + " | the source paragraph is still there, handle it by hand"); });
        res.merge_tail_removals.failed.forEach(function (r) { L.push("- 🔴 Delete failed `" + r.tid + "`: " + r.reason + " | the whole import is one undo step, undo it as a whole"); });
        (res.merge_tail_removals.already_removed || []).forEach(function (r) { L.push("- Deleted by an earlier import `" + r.tid + "`: story " + r.story_id + " original paragraph " + (r.paragraph_index + 1) + ", left alone this time and not counted as not located"); });
    }
    if (res.header_bar) {
        L.push("\n## Header bar (the English product name goes on the second line; a frame holding two cells has to be split by hand)");
        headerBarLines(res.header_bar).forEach(function (s) { L.push(s); });
    }
    if (res.edit_text_review && res.edit_text_review.length) {
        L.push("\n## Edit mode: text carrying emphasis was changed (kept by text, not guessed by position; please check)");
        res.edit_text_review.forEach(function (r) { editReviewLines(r).forEach(function (s) { L.push(s); }); });
    }
    if (res.edit_minimal_fallback && res.edit_minimal_fallback.length) {
        L.push("\n## Edit mode: these paragraphs could only be rewritten whole (character formats inherit by position, please check)");
        res.edit_minimal_fallback.forEach(function (f) { L.push("- `" + f.tid + "`: " + f.reason); });
    }
    function changedLine(c) { return "- `" + c.tid + "`: \"" + _clip(c.from, 50) + "\" -> \"" + _clip(c.to, 50) + "\""; }
    if (res.written_known) {
        if (res.written.length) { L.push("\n## Written this run (confirmed by read-back)"); res.written.forEach(function (c) { L.push(changedLine(c)); }); }
        if (res.already_translated.length) { L.push("\n## Already translated in the document (not written this run)"); res.already_translated.forEach(function (c) { L.push(changedLine(c)); }); }
    } else if (res.changed.length) {
        L.push("\n## Paragraphs whose translation differs from the source and is in the document (whether written this run is not told apart)");
        res.changed.forEach(function (c) { L.push(changedLine(c)); });
    }
    if (res.emphasis_relations) L.push(emphasisRelationsMarkdown(res.emphasis_relations));
    return L.join("\n") + "\n";
}

// ── #ac-emphasis-relations batch 1: translator bold report ──────────────────
// One row per script sub-run of each translator bold annotation (the landing
// splits Chinese / Latin characters). A row needs review when it did not land in
// full, or landed without a relation ("照旧加粗"), or kept an existing style.
function _relRowNeedsReview(r) {
    // batch 4d: italic rows (R-7 italic dimension) — only a clean italic_relation landing passes
    if (r.dimension === "italic") return !r.landed || r.outcome_italic !== "italic_relation" || !!r.kept_style || r.readbackDrop > 0;
    // batch 5 ⓪: relation_direct is a landing (R-4 ④); carried_overlap_kept (incl. every
    // unranked weight, M5 — always bucket ③) is not landed ⇒ reported for the owner (OD-E11)
    // batch 5 ①: a source italic the new weight cannot carry (upright now) is a visible change
    if (r.source_italic && (r.source_italic.realization === "surface" || r.source_italic.realization === "block")) return true;
    return !r.landed || (r.rule !== "relation" && r.rule !== "relation_direct") || r.carriedKept > 0 || r.foreignKept > 0 || r.readbackDrop > 0;
}
function emphasisRelationsNeedReview(er) {
    if (!er) return false;
    if (er.issues && er.issues.length) return true;
    var ed = er.edit || {};
    if (ed.legacy_fmt_baseline_unknown || (ed.prior_direct_not_cleared && ed.prior_direct_not_cleared.length)) return true;
    if (ed.no_prior_state && ed.no_prior_state.length) return true;
    if (er.missing_pairs && er.missing_pairs.length) return true;   // owner B1: config gap ⇒ review
    if (er.low_contrast && er.low_contrast.length) return true;     // owner §8 acca722: owner must choose
    if (er.italic_migration && er.italic_migration.length) return true;   // legacy_italic_config: save it via the panel
    if (er.italic_derivation && er.italic_derivation.length) return true;
    return (er.rows || []).some(_relRowNeedsReview);
}
var _REL_OUTCOME_TEXT = {
    no_relation: "no bold line starts from the body card",
    projection_conflict: "the cards the body belongs to have bold lines pointing to different weights",
    projection_unmapped: "the card the bold line points to has no member for this script",
    body_key_unavailable: "the body weight of this source paragraph cannot be read",
    desync_skip: "character positions do not match, left unchanged",
    landing_threw: "error while landing",
    resolver_threw: "error while looking it up",
    settle_pass_not_run: "the settle step did not reach this mark, the final fallback set plain bold",
    apply_failed: "write failed"
};
var _ITALIC_OUTCOME_TEXT = {
    italic_no_relation: "needs a new italic line (the starting card has no italic line)",
    italic_projection_unmapped: "the card the italic line points to has no member for this script",
    italic_projection_conflict: "the starting cards have italic lines pointing to different italics",
    italic_face_not_installed: "the italic face is not installed on this machine",
    italic_fallback_face_missing: "the plain-bold face is not installed, so the italic has nothing to land on",
    foreign_family_undecided: "another font in the paragraph, the config has not decided how to handle it (as for bold)",
    settle_pass_not_run: "the settle step did not reach this mark (italic-only characters left as they were)",
    body_key_unavailable: "the body weight of this source paragraph cannot be read",
    apply_failed: "write failed"
};
function emphasisRelationsMarkdown(er) {
    var L = [];
    var allRows = er.rows || [], issues = er.issues || [], rules = er.rules || [];
    var rows = allRows.filter(function (r) { return r.dimension !== "italic"; });
    var itRows = allRows.filter(function (r) { return r.dimension === "italic"; });
    var isRel = function (r) { return r.rule === "relation" || r.rule === "relation_direct"; };
    var landed = rows.filter(function (r) { return r.landed && isRel(r); }).length;
    var fallback = rows.filter(function (r) { return r.landed && !isRel(r); }).length;
    var kept = rows.filter(function (r) { return r.rule === "carried_overlap_kept"; }).length;
    var undecided = rows.filter(function (r) { return r.rule === "foreign_family_undecided"; }).length;
    var notLanded = rows.filter(function (r) { return !r.landed && r.rule !== "carried_overlap_kept" && r.rule !== "foreign_family_undecided"; }).length;
    var undecidedAll = undecided + allRows.filter(function (r) { return r.dimension === "italic" && r.outcome_italic === "foreign_family_undecided"; }).length;
    L.push("\n## Bold (emphasis relations)");
    L.push("Bold / italic lines in effect in the config: " + rules.length + ", with problems: " + issues.length + " (" + (er.srcLang || "?") + " → " + (er.dstLang || "?") + ").");
    L.push("Translator bold: " + rows.length + " place(s) (Chinese and Latin counted separately): landed by a bold line " + landed + ", no line so plain bold " + fallback + (kept ? ", already bold in the source and kept " + kept : "")
        + (undecided ? ", another font in the paragraph, undecided " + undecided : "") + ", not landed " + notLanded + ".");
    // batch 5 ② (OD-E17): the import never answers this itself — the panel does (CTA)
    if (undecidedAll) L.push("⚠ **This config has not decided what to do when bold or italic falls on another font: choose it in the font panel** (" + undecidedAll + " place(s) not landed, bold and italic counted separately)");
    rules.forEach(function (u) { L.push("- Line: " + u.from + " → " + u.to + " (" + (u.dimension === "italic" ? "italic" : "bold") + (u.source === "migration" ? ", created by the migration" : "") + ")"); });
    issues.forEach(function (x) {
        if (x.code === "equivalence_group_mixed_italic") { L.push("- ⚠ An equivalence group mixes italic and upright weights, it is not used when comparing pairing members: " + x.reason); return; }
        if (x.key) { L.push("- ⚠ Config item `" + x.key + "` is invalid: " + x.reason); return; }
        L.push("- ⚠ Config line " + (x.entry === null || x.entry === undefined ? "?" : (x.entry + 1)) + " is invalid: " + x.reason);
    });
    if (rows.length) {
        L.push("");
        L.push("| Paragraph | Text | Body | Landed as | Basis | Notes |");
        L.push("|---|---|---|---|---|---|");
        rows.forEach(function (r) {
            var body = r.body ? (r.body.font + " " + (r.body.weight || "?")) : "?";
            var face = r.family ? (r.family + " " + (r.style || "")) : "—";
            var basis = isRel(r) ? ("bold line " + r.from + " → " + r.to)
                : r.rule === "settle_pass_not_run" ? "paragraph not located, not landed (the settle step did not reach this mark)"
                : r.rule === "foreign_family_undecided" ? ("another font in the paragraph (" + (r.family || "?") + ", body " + (r.body_family || "?") + "), the config has not decided how to handle it, not landed")
                : r.rule === "carried_overlap_kept" ? ("already bold in the source (" + (r.carriedKey ? (r.carriedKey.family + " " + (r.carriedKey.weight || "?")) : "?") + "), kept as it is, the translator bold is not added on top")
                : ("plain bold: " + (_REL_OUTCOME_TEXT[r.outcome] || r.outcome || "?"));
            var notes = [];
            if (r.rule === "relation_direct") notes.push("existing character style kept, the bold face set as a direct override");
            // batch 5 ① (R-5 arbitration 4): the source italic, re-implemented on the new weight
            if (r.source_italic) notes.push("source italic on the new weight: " + _italicCarriedText(r.source_italic));
            if (r.weight_unranked && r.weight_unranked.side === "body_key_family_tie") notes.push("body font families tie: " + (r.weight_unranked.families || []).map(function (f) { return f.family + " " + f.chars + " char(s)"; }).join(" / ") + " (not decided by order, the body key is unavailable)");
            else if (r.weight_unranked) notes.push("weight cannot be ranked: " + (r.weight_unranked.weight || (r.weight_unranked.weights ? r.weight_unranked.weights.join(" / ") : "(family swap, the weight cannot be read)")) + " (" + (r.weight_unranked.family || "?") + ", "
                + ({ "carried run": "carried from the source", "carried run (family swap)": "carried from the source", "designer style": "designer style", "body key": "body", "latin face": "source Latin face", "body_key_candidates": "body key candidates" }[r.weight_unranked.side] || r.weight_unranked.side) + ")");
            if (!r.landed && r.rule !== "carried_overlap_kept" && r.rule !== "foreign_family_undecided") notes.push("**not landed**" + (r.reason ? " (" + r.reason + ")" : ""));
            if (r.carriedKept) notes.push(r.carriedKept + " char(s) keep the source emphasis");
            if (r.foreignKept) notes.push(r.foreignKept + " char(s) keep their existing character style (link / designer style)");
            if (r.readbackDrop) notes.push(r.readbackDrop + " char(s) read back different after writing");
            L.push("| `" + r.tid + "` | «" + _clip(r.text, 30) + "» | " + body + " | " + face + " | " + basis + " | " + notes.join("; ") + " |");
        });
    }
    // batch 4d: translator italic (R-5 phase 3), one row per script sub-run / char group
    if (itRows.length) {
        var itOk = itRows.filter(function (r) { return r.landed && r.outcome_italic === "italic_relation"; }).length;
        var itFb = itRows.filter(function (r) { return r.landed && r.outcome_italic === "italic_on_fallback"; }).length;
        L.push("");
        L.push("## Italic (emphasis relations)");
        L.push("Translator italic: " + itRows.length + " place(s) (Chinese and Latin counted separately): landed by an italic line " + itOk + ", landed by an italic line on plain bold " + itFb
            + ", not landed " + itRows.filter(function (r) { return !r.landed; }).length + " (characters not landed stay as they were, they are not set upright).");
        L.push("");
        L.push("| Paragraph | Text | Start | Landed as | Basis | Notes |");
        L.push("|---|---|---|---|---|---|");
        itRows.forEach(function (r) {
            var startText = { "body": "body", "bold relation": "card reached by bold", "fallback Bold": "Bold of plain bold", "carried weight": "weight carried from the source" }[r.start_from] || r.start_from || "?";
            var face = (r.landed && r.family) ? (r.family + " " + (r.style || "") + (r.realization === "faux" ? " + slant " + r.angle + "° (italic copy)" : " (real italic)")) : "—";
            var basis = r.landed ? ("italic line " + (r.from || "?") + " → " + (r.to || "?"))
                : (r.outcome_italic === "body_key_unavailable" && r.weight_unranked && r.weight_unranked.side === "body_key_family_tie")
                    ? ("body key unavailable (body font families tie: " + (r.weight_unranked.families || []).map(function (f) { return f.family + " " + f.chars + " char(s)"; }).join(" / ") + ")")
                : (r.outcome_italic === "body_key_unavailable" && r.weight_unranked && r.weight_unranked.weights)
                    ? ("body key unavailable (the candidate weights cannot be ranked: " + r.weight_unranked.weights.join(" / ") + ")")
                : (_ITALIC_OUTCOME_TEXT[r.outcome_italic] || r.outcome_italic || "?");
            var notes = [];
            if (r.reason) notes.push(r.reason);
            if (r.kept_style) notes.push("existing character style " + r.kept_style + " kept, the italic face set as a direct override");
            if (r.readbackDrop) notes.push(r.readbackDrop + " char(s) read back different after writing");
            // I-5: both routes gave italic and they differ — the translator's wins, both shown
            // (a not-landed row keeps its source italic and reads like every other no-line row)
            if (r.landed && r.italic_carried) notes.push("source italic: " + _italicCarriedText(r.italic_carried) + " / translator italic (in effect): " + face);
            L.push("| `" + r.tid + "` | «" + _clip(r.text, 30) + "» | " + startText + " | " + face + " | " + basis + " | " + notes.join("; ") + " |");
        });
    }
    // I-4: the import migrated a legacy italic config in memory (legacy_italic_config)
    (er.italic_migration || []).forEach(function (m) {
        var r = m.report || {};
        L.push("");
        if (r.fellBack) {
            L.push("⚠ **Italic config not migrated** (" + m.where + "): the in-memory migration failed its check, this import used the config as it was: " + (r.fellBack.errors || []).join("; "));
            return;
        }
        L.push("**Italic config migrated in memory** (" + m.where + "; the config file is unchanged, open it in the panel and press Done once to save it): italic copies created " + (r.copies || []).length
            + ", italic pairings " + (r.pairs || []).length + ", added to existing pairings " + (r.joined || []).length + ", italic lines " + (r.relations || []).length + ".");
        (r.skipped || []).forEach(function (s) { L.push("- No italic line could be made for this card: " + s.card + ": " + s.reason); });
        (r.noNode || []).forEach(function (x) { L.push("- An old italic record has no matching weight, it still applies as recorded: " + x.entry.font + " " + x.entry.weight); });
        (r.angleFixed || []).forEach(function (x) { L.push("- The old record's angle is " + x.was + "; in the old config " + x.was + " was always applied as a " + x.now + "° slant, it is now a " + x.now + "° copy and the page looks the same: " + x.entry.font + " " + x.entry.weight); });
    });
    // I-4: what deriving the effective italic records had to say
    if ((er.italic_derivation || []).length) {
        L.push("");
        L.push("**Italic copy records**:");
        er.italic_derivation.forEach(function (d) {
            if (d.code === "derived_key_angle_conflict") {
                L.push("- ⚠ " + d.font + " " + d.weight + " has italic copies with different angles in different languages ("
                    + d.members.map(function (x) { return x.lang + " " + x.angle + "°"; }).join(" / ") + "); they take effect only once they match, this time the source italic at this weight is treated as not configured");
            } else if (d.code === "config_entry_invalid") {
                L.push("- ⚠ Italic copy is invalid and does not take effect (it is also skipped as a pairing member): " + d.lang + " " + d.font + " " + d.weight + ": " + d.reason);
            } else if (d.code === "italic_entry_no_node") {
                L.push("- An old italic record has no matching weight, it still applies as recorded: " + d.entry.font + " " + d.entry.weight);
            } else {
                L.push("- The italic record stored in the config differs from the copy (the copy wins): " + (d.note || "") + " · " + d.key.replace("␟", " "));
            }
        });
    }
    // owner 2026-10-01 (app-folio design-intent §8, acca722) — shared contract with
    // importfix, word for word: title + one line per low_contrast_weight entry.
    if ((er.low_contrast || []).length) {
        L.push("");
        L.push("## Weak weight contrast in the source document (owner to choose: follow the source / bold by the brand rule)");
        er.low_contrast.forEach(function (c) {
            var head = "- " + _clip(c.piece, 40) + " · body " + (c.latin_family || "?") + " " + (c.body_weight || "?")
                + " · emphasis " + (c.piece_weight || "?");
            var fl = (c.follow_source && c.follow_source.latin) || "?", fc = (c.follow_source && c.follow_source.cjk) || "—";
            var bc = (c.brand_bump && c.brand_bump.cjk) || "—";
            // arch 2026-10-01 (C1 ①): `placed` — false ⇒ the piece never reached the target text,
            // so "现按原文档" would describe a result that is not on the page. Absent ⇒ true.
            if (c.placed === false) {
                L.push(head + " → not placed on the translation (the Chinese is at the body weight now); once the matching translation is confirmed, choose: follow the source, English " + fl + ", Chinese " + fc
                    + " / brand rule, English Medium, Chinese " + bc);
            } else {
                L.push(head + " → now follows the source: English " + fl + ", Chinese " + fc + "; brand rule: English Medium, Chinese " + bc);
            }
        });
    }
    // owner 2026-10-01 B1 (design-intent §8): config gaps, listed for owner to fill
    if ((er.missing_pairs || []).length) {
        L.push("");
        L.push("**Emphasis Chinese weight and the pairing table** (owner to handle; the pipeline does not change the config):");
        er.missing_pairs.forEach(function (m) {
            var what = (m.srcFont || "?") + " " + (m.srcWeight || "?") + " (Chinese " + (m.cjkFamily || "?") + ")";
            var line;
            if (m.reason === "lighter_than_body") {
                line = "Pairing table result conflicts with §1 'emphasis ≥ body': " + what + " → Chinese " + (m.dstWeight || "?") + ", body Chinese " + (m.bodyWeight || "?") + " (landed as the table says, not raised)";
            } else if (m.reason === "conflict") {
                line = "Config pairing conflict: " + what + ": several pairings for this weight point to different Chinese weights, which one applies cannot be told (not landed)";
            } else if (m.reason === "no_config") {
                line = "No config: the emphasis Chinese weight was not paired: " + what + " (landed at the source weight)";
            } else {
                line = "Config pairing missing: " + what + " (landed at the source weight; add the pairing to the brand config)";
            }
            L.push("- " + line + " × " + m.count
                + (m.tids && m.tids.length ? " · " + m.tids.map(function (t) { return "`" + t + "`"; }).join(", ") : ""));
        });
    }
    // batch 2: edit-mode re-import (OD-E20 B · E21 / E22 / E23 default A · E18 A)
    var ed = er.edit;
    if (ed) {
        L.push("");
        L.push("Edit mode: rewritten because translator bold / italic marks changed: " + (ed.fmt_annotation_changed || 0) + " paragraph(s); rewritten because the emphasis config changed: "
            + (ed.emphasis_config_changed || 0) + " paragraph(s); paragraphs whose last emphasis styles were cleared when rewritten: " + (ed.cleared_rows || 0)
            + " (" + (ed.cleared_runs || 0) + " place(s)).");
        if (ed.legacy_fmt_baseline_unknown) {
            var lg = ed.legacy_fmt_baseline_unknown;
            var lgList = (lg.noop_with_manual_fmt || []).map(function (t) { return "`" + t + "`"; }).join(", ");
            L.push("- ⚠ **Old landing cannot be judged, not cleared**: the last record of " + lg.entries + " paragraph(s) comes from an older version with no record of marks, so this time only the text decides whether they changed. "
                + "Of these, paragraphs whose text did not change and that carry manual bold / italic now (the marks may have changed, please check): " + (lgList || "none")
                + ". Paragraphs that have no marks now cannot be listed ('all removed' and 'never marked' cannot be told apart).");
        }
        // arch 2026-09-30 (finding B → ③): kept, named row by row, never cleared (TODO #123)
        if ((ed.no_prior_state || []).length) {
            L.push("- ⚠ **Last landing unknown, not cleared** (these paragraphs are not in the last import's record and were rewritten whole as new paragraphs; the bold / italic the last import set stays where it was and may no longer line up with the new text, please check):");
            ed.no_prior_state.forEach(function (t) { L.push("  - `" + t + "`"); });
        }
        (ed.prior_direct_not_cleared || []).forEach(function (x) {
            L.push("- ⚠ `" + x.tid + "` (paragraph style " + (x.paragraph_style || "?") + "): direct overrides are not cleared in this kind of paragraph, the last translator formatting may remain as direct overrides, please check by hand.");
        });
    }
    return L.join("\n");
}
// Attach after runHostCheck: the pipeline report holds the rows, the check owns the verdict.
// batch 5 ② (OD-E17, plan A2): the top-level summary the standalone panel reads from the latest
// import report to decide whether to show the "foreign family" row. Same rows as the md.
function foreignFamilyUndecidedSummary(er) {
    var fams = [];
    ((er && er.rows) || []).forEach(function (r) {
        var isIt = r.dimension === "italic";
        if (isIt ? r.outcome_italic !== "foreign_family_undecided" : r.rule !== "foreign_family_undecided") return;
        fams.push({ tid: r.tid, text: r.text, family: r.family || null, body_family: r.body_family || null, dimension: isIt ? "italic" : "bold",
            // #144: the evidence the panel shows (bold rows only; the italic row does not carry it)
            style: r.foreign_style || null, page: r.page === undefined ? null : r.page,
            own_would_be: r.own_would_be || null, body_would_be: r.body_would_be || null });
    });
    return { count: fams.length, families: fams };
}
function attachEmphasisRelations(res, er) {
    if (!res || !er) return res;
    if (!er.rows) er.rows = [];
    if (!er.rules) er.rules = [];
    if (!er.issues) er.issues = [];
    res.emphasis_relations = er;
    if (res.counts) res.counts.emphasis_relations_review = (er.rows || []).filter(_relRowNeedsReview).length + (er.issues || []).length
        + (er.italic_derivation || []).length + (er.italic_migration || []).length;
    if (res.missing_text) res.verdict = verdictOf(res);
    return res;
}

function verdictOf(res) {
    if (res.incomplete) return "Self-check incomplete";
    if (res.missing_text.length || res.tofu_risk.length) return "Problems found";
    if ((res.leftover_source || []).some(function (l) { return l.kind === "merged"; })) return "Problems found";   // source paragraph left by a cross-paragraph merge
    if (res.readback_mismatch && res.readback_mismatch.length) return "Problems found";       // located, yet the paragraph does not hold the translation
    if (res.duplicate_text && res.duplicate_text.length) return "Problems found";            // the same text twice in one story
    if (res.not_located && res.not_located.length) return "Problems found";                // a translation that never reached the document
    if (res.merge_tail_removals && res.merge_tail_removals.failed.length) return "Problems found";   // a removal that did not read back
    if (headerBarNeeds(res.header_bar) === "problem") return "Problems found";               // #136 ②: must be fixed by hand
    if (res.overset.length || res.format_review.length) return "Needs review";
    if (res.config_missing_pairs && res.config_missing_pairs.length) return "Needs review";   // B1: must be seen
    if (res.emphasis_pair_issues && res.emphasis_pair_issues.length) return "Needs review";   // same rule for emphasis pieces
    if (emphasisRelationsNeedReview(res.emphasis_relations)) return "Needs review";   // emphrel: bold / italic landings to look at
    if (res.edit_text_review && res.edit_text_review.length) return "Needs review";            // D2: must be seen
    if (res.edit_minimal_fallback && res.edit_minimal_fallback.length) return "Needs review";
    if (res.readback_unreadable && res.readback_unreadable.length) return "Needs review";   // written or not: unknown
    if (res.merge_tail_removals && res.merge_tail_removals.refused.length) return "Needs review";   // a source paragraph left for a person
    if (res.leftover_source && res.leftover_source.length) return "Needs review";         // target equals source: a whole source paragraph kept
    if (headerBarNeeds(res.header_bar) === "review") return "Needs review";                // #136 ①: header without an English name
    return "No problems found";
}

// ── host glue (InDesign UXP) ─────────────────────────────────────────────────

function _fontParts(f) {
    try {
        var n = (f && f.name != null) ? String(f.name) : String(f || "");
        var i = n.indexOf("\t");
        return i >= 0 ? { family: n.slice(0, i), style: n.slice(i + 1) } : { family: n, style: "" };
    } catch (e) { return { family: "?", style: "" }; }
}
function _enumName(v) { var s = String(v == null ? "" : v); var i = s.lastIndexOf("."); return i >= 0 ? s.slice(i + 1) : s; }

function _runsOf(textObj) {
    var out = [];
    var tsrs = textObj.textStyleRanges.everyItem().getElements();
    for (var i = 0; i < tsrs.length; i++) {
        var r = tsrs[i], fp = _fontParts(r.appliedFont), cs = "";
        try { cs = String(r.appliedCharacterStyle.name); } catch (e) { cs = ""; }
        var pos = "", ul = false;
        try { pos = _enumName(r.position); } catch (e2) {}
        try { ul = !!r.underline; } catch (e3) {}
        out.push({ text: String(r.contents), family: fp.family, style: fp.style, charStyle: cs, position: pos, underline: ul });
    }
    return out;
}

// A textStyleRange does NOT split where a paragraph style's GREP style switches
// the font: measured 2026-09-25 on DocX-2 TC, range 「1.5兆美元」 reported
// "Dax Pro (OTF) Bold" while characters 兆美元 each report "MHeiHK Xbold".
// So a range-level hit is only a candidate; confirm per character.
function _confirmTofu(textObj, hits, known) {
    if (!hits.length) return hits;
    var tsrs = textObj.textStyleRanges.everyItem().getElements();
    var out = [];
    hits.forEach(function (h) {
        var r = tsrs[h.run_index], bad = {}, fonts = {};
        if (!r) return;
        var chs = r.characters.everyItem().getElements();
        for (var i = 0; i < chs.length; i++) {
            var c = String(chs[i].contents);
            if (!isCJKChar(c)) continue;
            var fp = _fontParts(chs[i].appliedFont);
            if (isCJKFamily(fp.family, known)) continue;
            bad[c] = true; fonts[fp.family + (fp.style ? " " + fp.style : "")] = true;
        }
        var cj = Object.keys(bad).join("");
        if (cj) { h.cjk_chars = cj; h.font = Object.keys(fonts).join(", "); out.push(h); }
    });
    return out;
}

// Per-character runs (effective font, see _confirmTofu) for the format-review
// dump — only a handful of paragraphs, so the per-character cost is fine.
function _charRunsOf(textObj) {
    var chs = textObj.characters.everyItem().getElements(), out = [], cur = null;
    for (var i = 0; i < chs.length; i++) {
        var c = chs[i], fp = _fontParts(c.appliedFont), cs = "", pos = "", ul = false;
        try { cs = String(c.appliedCharacterStyle.name); } catch (e) {}
        try { pos = _enumName(c.position); } catch (e2) {}
        try { ul = !!c.underline; } catch (e3) {}
        var key = fp.family + "|" + fp.style + "|" + cs + "|" + pos + "|" + ul;
        if (cur && cur._k === key) { cur.text += String(c.contents); continue; }
        cur = { _k: key, text: String(c.contents), family: fp.family, style: fp.style, charStyle: cs, position: pos, underline: ul };
        out.push(cur);
    }
    out.forEach(function (r) { delete r._k; });
    return out;
}

// All of a cell's text, overset part included (cell.contents drops it).
function _cellText(cell) {
    try { return String(cell.texts.item(0).contents); } catch (e) {}
    try { return String(cell.contents); } catch (e2) { return ""; }
}

// Every overset table cell of the document (read-only). Shared by this self-check
// and any later step that can change how cells lay out (cjk_style_apply —
// findings#cell-overset-japanese-composer).
function scanOversetCells(doc) {
    var rows = [], stories = doc.stories.everyItem().getElements();
    for (var sc = 0; sc < stories.length; sc++) {
        var swhere = "";
        try { var tc2 = stories[sc].textContainers; swhere = tc2 && tc2.length ? _where(tc2[0]) : ""; } catch (eW2) {}
        try {
            var tbs = stories[sc].tables.everyItem().getElements();
            for (var tq = 0; tq < tbs.length; tq++) {
                var cls = tbs[tq].cells.everyItem().getElements();
                for (var cq = 0; cq < cls.length; cq++) {
                    var ov = false, nm = "";
                    try { ov = cls[cq].overflows === true; } catch (eOv) { ov = false; }
                    if (!ov) continue;
                    try { nm = String(cls[cq].name); } catch (eNm) {}
                    rows.push({ overflows: true, name: "Table " + (tq + 1) + " " + nm, contents: _cellText(cls[cq]), where: swhere + " table",
                                story_id: stories[sc].id, table_index: tq, cell_index: cq, page: /^p/.test(swhere) ? swhere.slice(1) : null });
                }
            }
        } catch (eTc) {}
    }
    return oversetCells(rows);
}

function _where(frame) {
    try { return frame && frame.parentPage ? ("p" + frame.parentPage.name) : "pasteboard"; } catch (e) { return "?"; }
}

/**
 * @param doc          live InDesign Document (already saved by the import)
 * @param segments     sidecar segments (ctx.segments)
 * @param translations translations object with .byTid (ctx.translations)
 * @param opts         { notLocatedTids: string[], knownCjkFamilies: {name:true}, documentName }
 */
function runHostCheck(doc, segments, translations, opts) {
    opts = opts || {};
    var res = { generated_at: new Date().toISOString(), document: opts.documentName || (doc && String(doc.name)) || "",
                missing_text: [], tofu_risk: [], overset: [], format_review: [], changed: [], incomplete: "" };
    var byTid = (translations && translations.byTid) || {};
    var notLoc = {};
    (opts.notLocatedTids || []).forEach(function (t) { notLoc[t] = true; });
    var known = opts.knownCjkFamilies || null;
    // before the host steps, so it is reported even when the check itself stops half-way
    res.not_located = notLocatedRows(segments, byTid, notLoc, opts.notLocatedDetail || null);
    // intent until the read-back below replaces it (the report says which of the two it is)
    res.changed = changedSegments(segments, byTid);
    var steps = [];
    try {
        // Story text incl. table cell text (cell paragraphs are not in story.contents).
        var storyText = {}, unitsByStory = {}, stories = doc.stories.everyItem().getElements();
        for (var i = 0; i < stories.length; i++) {
            var st = stories[i], txt = String(st.contents), cellUnits = [];
            try {
                var tbls = st.tables.everyItem().getElements();
                for (var t = 0; t < tbls.length; t++) {
                    var cells = tbls[t].cells.everyItem().getElements();
                    // cell.texts, not cell.contents: an overset cell's contents read "" (host
                    // 2026-09-30) — that is reported as overset below, not as missing text
                    for (var c = 0; c < cells.length; c++) {
                        var cTxt = _cellText(cells[c]);
                        txt += "\r" + cTxt;
                        String(cTxt).split("\r").forEach(function (cp) { cellUnits.push(cp); });
                    }
                }
            } catch (eT) {}
            storyText[String(st.id)] = txt;
            // every paragraph of the story as it is NOW (after all writes) — the read-back's only source
            try {
                var stPs = st.paragraphs.everyItem().contents;
                unitsByStory[String(st.id)] = ((typeof stPs === "string") ? [stPs] : Array.prototype.slice.call(stPs)).concat(cellUnits);
            } catch (eU) { /* story left out ⇒ its rows are reported as unreadable */ }
        }
        steps.push("text");
        if (opts.locatedStoryByTid) {
            var rb = readbackChanged(res.changed, unitsByStory, opts.locatedStoryByTid, segments, byTid);
            res.changed = rb.confirmed;
            res.readback_mismatch = rb.mismatch;
            res.readback_unreadable = rb.unreadable;
            res.changed_is_readback = true;
            if (opts.writtenTids) {   // arch 2026-10-06: written this round vs already translated (same package again ⇒ written 0)
                var __sw = splitWritten(res.changed, opts.writtenTids, segments);
                res.written = __sw.written; res.already_translated = __sw.already; res.written_known = true;
            }
            // diagnostics only (arch): where the reference taken BEFORE the writes disagrees with the fresh read
            if (opts.refTextByTid) res.readback_ref_disagreements = refDisagreements(rb, opts.refTextByTid, byTid);
            steps.push("readback");
        }
        res.missing_text = findMissing(expectedUnits(segments, byTid, notLoc), storyText);
        // duplicate text: only stories that hold a forced line break can show the shape
        var parasByStory = unitsByStory;   // read once, above
        res.duplicate_text = findBreakPieceDuplicates(parasByStory);   // only paragraphs with a forced line break can match
        steps.push("duplicates");
        res.leftover_source = leftoverSourceParagraphs(parasByStory, segments, byTid);
        steps.push("leftover-source");

        for (var j = 0; j < stories.length; j++) {
            var s2 = stories[j], where = "";
            try { var tc = s2.textContainers; where = tc && tc.length ? _where(tc[0]) : ""; } catch (eW) {}
            _confirmTofu(s2, tofuRuns(_runsOf(s2), known), known).forEach(function (x) { x.story_id = String(s2.id); x.where = where; res.tofu_risk.push(x); });
            try {
                var tb = s2.tables.everyItem().getElements();
                for (var k = 0; k < tb.length; k++) {
                    var cl = tb[k].cells.everyItem().getElements();
                    for (var m = 0; m < cl.length; m++) {
                        var __ct = cl[m].texts.item(0);
                        _confirmTofu(__ct, tofuRuns(_runsOf(__ct), known), known).forEach(function (x) { x.story_id = String(s2.id); x.where = where + " table"; res.tofu_risk.push(x); });
                    }
                }
            } catch (eTb) {}
        }
        steps.push("tofu");

        var frames = doc.textFrames.everyItem().getElements();
        for (var f = 0; f < frames.length; f++) {
            try { if (frames[f].overflows) { var __wh = _where(frames[f]); res.overset.push({ frame_id: frames[f].id, where: __wh, page: /^p/.test(__wh) ? __wh.slice(1) : null, story_id: frames[f].parentStory.id, text: String(frames[f].parentStory.contents).slice(0, 60) }); } } catch (eO) {}
        }
        // table cells: overset there is invisible to frame / story `overflows`
        scanOversetCells(doc).forEach(function (x) { res.overset.push(x); });
        steps.push("overset");

        // (res.changed and its read-back are computed before the host steps, above)
        steps.push("changed");

        // B1: config lacks a pair — with how many paragraphs use each fallback style
        if (opts.fallbackRank && opts.fallbackRank.length) {
            var __miss = configMissingPairs(opts.fallbackRank), __cnt = {}, __paras = [], __want = {};
            __miss.forEach(function (m) { __want[m.font + "\t" + m.weight] = true; });
            for (var sp = 0; sp < stories.length; sp++) {
                var __ps = [];
                try { __ps = stories[sp].paragraphs.everyItem().getElements(); } catch (eP0) {}
                try {
                    var __tb = stories[sp].tables.everyItem().getElements();
                    for (var tq2 = 0; tq2 < __tb.length; tq2++) {
                        var __cl = __tb[tq2].cells.everyItem().getElements();
                        for (var cq2 = 0; cq2 < __cl.length; cq2++) { try { __ps = __ps.concat(__cl[cq2].paragraphs.everyItem().getElements()); } catch (eP1) {} }
                    }
                } catch (eT1) {}
                for (var pp = 0; pp < __ps.length; pp++) {
                    var __n = ""; try { __n = String(__ps[pp].appliedParagraphStyle.name); } catch (eN) {}
                    if (__n) __cnt[__n] = (__cnt[__n] || 0) + 1;
                    var __fs = [];
                    try {
                        var __rs = __ps[pp].textStyleRanges.everyItem().getElements();
                        for (var rq = 0; rq < __rs.length; rq++) {
                            var __f = null; try { __f = __rs[rq].appliedFont; } catch (eF) {}
                            var __fn = __f && __f.name != null ? String(__f.name) : String(__f || "");   // string or Font (CLAUDE.md #10)
                            if (!__want[__fn]) continue;
                            var __tx = ""; try { __tx = String(__rs[rq].contents); } catch (eTx) {}
                            __fs.push({ font: __fn, text: __tx });
                        }
                    } catch (eR) {}
                    __paras.push({ style: __n, runs: __fs });
                }
            }
            res.config_missing_pairs = attachLocalUseCounts(attachParagraphCounts(__miss, __cnt), __paras);
        }
        steps.push("config-pairs");
        // emphasis pieces whose CJK weight the pairs could not decide (apply.source_format_restore.pair_issues)
        if (opts.emphasisPairIssues && opts.emphasisPairIssues.length) res.emphasis_pair_issues = opts.emphasisPairIssues.slice();
        // D2 (owner 2026-10-01 ①A): edit-mode emphasis whose text changed — to review, never guessed
        if (opts.editTextReview && opts.editTextReview.length) res.edit_text_review = opts.editTextReview.slice();
        if (opts.editMinimalFallback && opts.editMinimalFallback.length) res.edit_minimal_fallback = opts.editMinimalFallback.slice();
        // TODO #136 ① ②: header-bar recognition counts (0 included), reshaped rows, two-cell frames
        if (opts.headerBar) res.header_bar = opts.headerBar;
        // ⑤B: paragraphs removed / refused by the cross-paragraph-merge cleanup (apply.merge_tail_removals)
        if (opts.mergeTailRemovals) res.merge_tail_removals = opts.mergeTailRemovals;
        // forced full import onto a translated document: the preclean splits CJK/Latin soft breaks (arch 2026-10-03)
        if (opts.softBreakNotice) res.soft_break_notice = String(opts.softBreakNotice);

        // Format review: rewritten segments whose SOURCE paragraph had mixed formatting.
        res.changed.filter(function (c) { return c.mixed_source_format; }).forEach(function (c) {
            var seg = null;
            for (var q = 0; q < (segments || []).length; q++) if (segments[q] && segments[q].tid === c.tid) { seg = segments[q]; break; }
            var runs = null;
            try {
                var story = doc.stories.itemByID(Number(seg.story_id)).getElements()[0];
                var want = textKey(c.to), paras = story.paragraphs.everyItem().getElements();
                for (var p = 0; p < paras.length; p++) {
                    if (textKey(paras[p].contents).indexOf(want) >= 0) { runs = _charRunsOf(paras[p]); break; }
                }
            } catch (eP) { runs = null; }
            res.format_review.push({ tid: c.tid, runs: runs });
        });
        steps.push("format");
    } catch (e) {
        res.incomplete = "stopped at step " + (steps.length + 1) + " (done: " + (steps.join(", ") || "none") + "): " + (e && e.message ? e.message : String(e));
    }
    res.verdict = verdictOf(res);
    res.counts = { missing_text: res.missing_text.length, tofu_risk: res.tofu_risk.length, overset: res.overset.length,
                   format_review: res.format_review.length, changed: res.changed.length,
                   written: res.written_known ? res.written.length : null, already_translated: res.written_known ? res.already_translated.length : null,
                   not_located: (res.not_located || []).length, duplicate_text: (res.duplicate_text || []).length,
                   leftover_source: (res.leftover_source || []).length,
                   readback_mismatch: (res.readback_mismatch || []).length };
    return res;
}

function summaryLine(res) {
    if (!res) return "";
    return "Self-check: " + res.verdict + " — missing text " + res.counts.missing_text + ", tofu risk " + res.counts.tofu_risk
        + ", overset " + res.counts.overset + ", format review " + res.counts.format_review
        + (res.counts.written === null || res.counts.written === undefined ? ", changed " + res.counts.changed : ", written " + res.counts.written + ", already translated " + res.counts.already_translated)
        + ", not located " + (res.counts.not_located || 0)   // printed when 0 as well
        + ", duplicate text " + (res.counts.duplicate_text || 0) + ", leftover source " + (res.counts.leftover_source || 0)
        + ", readback mismatch " + (res.counts.readback_mismatch || 0)
        + (res.counts.emphasis_relations_review ? ", bold review " + res.counts.emphasis_relations_review : "");
}

module.exports = {
    configMissingPairs: configMissingPairs,
    attachParagraphCounts: attachParagraphCounts,
    attachLocalUseCounts: attachLocalUseCounts,
    hasVisibleChar: hasVisibleChar,
    missingPairUsage: missingPairUsage,
    pairIssueLine: pairIssueLine,
    oversetCells: oversetCells,
    scanOversetCells: scanOversetCells,
    isCJKChar: isCJKChar,
    isCJKFamily: isCJKFamily,
    textKey: textKey,
    rowTarget: rowTarget,
    expectedUnits: expectedUnits,
    findMissing: findMissing,
    changedSegments: changedSegments,
    notLocatedRows: notLocatedRows,
    readbackChanged: readbackChanged,
    splitWritten: splitWritten,
    refDisagreements: refDisagreements,
    findBreakPieceDuplicates: findBreakPieceDuplicates,
    leftoverSourceParagraphs: leftoverSourceParagraphs,
    leftoverLine: leftoverLine,
    tofuRuns: tofuRuns,
    verdictOf: verdictOf,
    toMarkdown: toMarkdown,
    editReviewLines: editReviewLines,   // D2
    headerBarLines: headerBarLines,     // #136 ① ②
    headerBarNeeds: headerBarNeeds,
    summaryLine: summaryLine,
    runHostCheck: runHostCheck,
    emphasisRelationsMarkdown: emphasisRelationsMarkdown,
    emphasisRelationsNeedReview: emphasisRelationsNeedReview,
    attachEmphasisRelations: attachEmphasisRelations,
    foreignFamilyUndecidedSummary: foreignFamilyUndecidedSummary
};
