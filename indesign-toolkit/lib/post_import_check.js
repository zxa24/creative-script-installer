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
            // when the document was edited after the package was exported (26-0955
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

function _clip(s, n) { s = String(s == null ? "" : s).replace(/[\r\n]+/g, "⏎"); return s.length > n ? s.slice(0, n) + "…" : s; }

function toMarkdown(res) {
    var L = [];
    L.push("# 导入后自检 " + (res.generated_at || ""));
    L.push("");
    L.push("文档：" + (res.document || "?") + "　结论：**" + res.verdict + "**");
    L.push("");
    L.push("| 检查 | 发现 |");
    L.push("|---|---|");
    L.push("| 文字缺失（含软换行段丢字） | " + res.missing_text.length + " |");
    L.push("| 豆腐块风险（中文落在非中文字体） | " + res.tofu_risk.length + " |");
    L.push("| 溢流文字框 | " + res.overset.length + " |");
    L.push("| 格式待复核（原段混合格式、本轮被重写） | " + res.format_review.length + " |");
    L.push("| 本轮改动的段 | " + res.changed.length + " |");
    L.push("");
    L.push("覆盖范围：文字缺失只核对本轮写入了译文的段（含其所在软换行组）；未改动的段、合并掉的段（merge_tail）不核。"
        + "格式只列出候选、不判对错。断行 / 不断行、列表编号、下划线粗细不在检查范围内。");
    if (res.incomplete) L.push("\n⚠ 自检未完成：" + res.incomplete);
    if (res.missing_text.length) {
        L.push("\n## 文字缺失");
        res.missing_text.forEach(function (m) { L.push("- `" + m.tids.join(", ") + "`（story " + m.story_id + "）应有：「" + _clip(m.expected, 80) + "」 —— " + m.reason); });
    }
    if (res.tofu_risk.length) {
        L.push("\n## 豆腐块风险");
        res.tofu_risk.forEach(function (t) { L.push("- story " + t.story_id + (t.where ? "（" + t.where + "）" : "") + "：「" + _clip(t.text, 40) + "」中的「" + t.cjk_chars + "」用了 " + t.font); });
    }
    if (res.overset.length) {
        L.push("\n## 溢流");
        res.overset.forEach(function (o) { L.push("- 文字框 " + o.frame_id + "（" + o.where + "）：「" + _clip(o.text, 40) + "」"); });
    }
    if (res.format_review.length) {
        L.push("\n## 格式待复核");
        res.format_review.forEach(function (f) {
            L.push("- `" + f.tid + "`：" + (f.runs ? f.runs.map(function (r) {
                return "«" + _clip(r.text, 30) + "» " + r.family + (r.style ? " " + r.style : "") + (r.charStyle && r.charStyle !== "[None]" ? " [" + r.charStyle + "]" : "")
                    + (r.position && r.position !== "NORMAL" ? " " + r.position : "") + (r.underline ? " U" : "");
            }).join(" · ") : "（段落未找到）"));
        });
    }
    if (res.changed.length) {
        L.push("\n## 本轮改动");
        res.changed.forEach(function (c) { L.push("- `" + c.tid + "`：「" + _clip(c.from, 50) + "」→「" + _clip(c.to, 50) + "」"); });
    }
    return L.join("\n") + "\n";
}

function verdictOf(res) {
    if (res.incomplete) return "自检未完成";
    if (res.missing_text.length || res.tofu_risk.length) return "有问题";
    if (res.overset.length || res.format_review.length) return "需复核";
    return "未发现问题";
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
// the font: measured 2026-09-25 on 26-0955 TC, range 「1.5兆美元」 reported
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

function _where(frame) {
    try { return frame && frame.parentPage ? ("p" + frame.parentPage.name) : "粘贴板"; } catch (e) { return "?"; }
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
    var steps = [];
    try {
        // Story text incl. table cell text (cell paragraphs are not in story.contents).
        var storyText = {}, stories = doc.stories.everyItem().getElements();
        for (var i = 0; i < stories.length; i++) {
            var st = stories[i], txt = String(st.contents);
            try {
                var tbls = st.tables.everyItem().getElements();
                for (var t = 0; t < tbls.length; t++) {
                    var cells = tbls[t].cells.everyItem().getElements();
                    for (var c = 0; c < cells.length; c++) txt += "\r" + String(cells[c].contents);
                }
            } catch (eT) {}
            storyText[String(st.id)] = txt;
        }
        steps.push("text");
        res.missing_text = findMissing(expectedUnits(segments, byTid, notLoc), storyText);

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
                        _confirmTofu(__ct, tofuRuns(_runsOf(__ct), known), known).forEach(function (x) { x.story_id = String(s2.id); x.where = where + " 表格"; res.tofu_risk.push(x); });
                    }
                }
            } catch (eTb) {}
        }
        steps.push("tofu");

        var frames = doc.textFrames.everyItem().getElements();
        for (var f = 0; f < frames.length; f++) {
            try { if (frames[f].overflows) res.overset.push({ frame_id: frames[f].id, where: _where(frames[f]), text: String(frames[f].parentStory.contents).slice(0, 60) }); } catch (eO) {}
        }
        steps.push("overset");

        res.changed = changedSegments(segments, byTid);
        steps.push("changed");

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
        res.incomplete = "停在第 " + (steps.length + 1) + " 步（已完成：" + (steps.join(", ") || "无") + "）：" + (e && e.message ? e.message : String(e));
    }
    res.verdict = verdictOf(res);
    res.counts = { missing_text: res.missing_text.length, tofu_risk: res.tofu_risk.length, overset: res.overset.length,
                   format_review: res.format_review.length, changed: res.changed.length };
    return res;
}

function summaryLine(res) {
    if (!res) return "";
    return "Self-check: " + res.verdict + " — missing text " + res.counts.missing_text + ", tofu risk " + res.counts.tofu_risk
        + ", overset " + res.counts.overset + ", format review " + res.counts.format_review + ", changed " + res.counts.changed;
}

module.exports = {
    isCJKChar: isCJKChar,
    isCJKFamily: isCJKFamily,
    textKey: textKey,
    rowTarget: rowTarget,
    expectedUnits: expectedUnits,
    findMissing: findMissing,
    changedSegments: changedSegments,
    tofuRuns: tofuRuns,
    verdictOf: verdictOf,
    toMarkdown: toMarkdown,
    summaryLine: summaryLine,
    runHostCheck: runHostCheck
};
