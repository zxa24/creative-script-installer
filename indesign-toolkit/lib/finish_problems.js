"use strict";

/**
 * lib/finish_problems.js — TODO #153 (owner 2026-10-21): what the end-of-import window says, as ONE table.
 *
 * Each entry of TYPES has the wording AND the collector that finds its rows in the report. The window opens when ANY
 * collector returns a row, and the lines it shows are those rows, so "does the window open" and "what does it say"
 * cannot drift apart again (the "Import finished with issues ()" bug of 2026-10-20 was exactly that: a predicate and a
 * reason list kept in two places). A new problem type = one entry here; no UI change.
 *
 *   buildWindow(report, reportPath) -> { shown, title, count, groups:[{ type, heading, consequence, advice, howToFix, rows }], reportPath }
 *   row = { text, page, target }     target = { frame } | { story, para } | { story } | { story, table, cell } | null (no Show)
 *   howToFix = { label, url, steps[] } | null   (the window EXPANDS it in place: a script cannot open a browser here, probe 2026-10-21)
 *
 * Wording is English, short, no dashes (owner: user-visible text). Docs URLs live ONLY in this table.
 */

// one constant for the docs address: the designer pastes the whole URL into a browser, a relative path is useless there (arch 2026-10-21)
var DOCS_BASE = "https://zxa24.github.io/creative-script-installer/folio/export-import";
function docs(anchor, steps) { return { label: "How to fix", url: DOCS_BASE + "#" + anchor, steps: steps }; }

// from website/folio/export-import.md, "Text is too long for its frame"
var OVERSET_STEPS = [
    "A frame with hidden text shows a red plus sign at its lower right.",
    "Make the frame larger, tighten the tracking a little, or ask the translator for a shorter wording.",
    "Then import again. The item leaves this list when the text fits."
];

function clip(s, n) {
    var t = String(s == null ? "" : s), out = "", sp = false;
    for (var i = 0; i < t.length; i++) {
        var c = t.charCodeAt(i);
        var white = c === 13 || c === 10 || c === 0x2028 || c === 7 || c === 32 || c === 9;   // line breaks, soft break, cell mark, spaces
        if (white) { sp = out.length > 0; continue; }
        if (sp) { out += " "; sp = false; }
        out += t.charAt(i);
    }
    return out.length > n ? out.slice(0, n) + "..." : out;
}
function pageName(where) {   // "p2" / "p2 table" -> "2" ; pasteboard / unknown -> null
    var m = /^p(\S+)/.exec(String(where || ""));
    return m ? m[1] : null;
}
function storyOfTid(tid) { var m = /^fallback_(\d+)_/.exec(String(tid || "")); return m ? Number(m[1]) : null; }
function num(v) { var n = Number(v); return isFinite(n) ? n : null; }

var POSTFLIGHT_WORDS = { missing_text: "text is missing", tofu_risk: "characters may show as boxes" };

// ---- the table ----------------------------------------------------------------------------------------------------
// order = display order. collect(report) -> rows. A type with no rows is not shown.
var TYPES = [
    {
        id: "overset_frame", heading: "Text does not fit its frame",
        consequence: "The part that does not fit is hidden, so it will be missing in print.",
        advice: "Make the frame larger or shorten the translation, then import again.",
        howToFix: docs("text-too-long", OVERSET_STEPS),
        collect: function (r) {
            var rows = [], seen = {};
            ((r.post_import_check && r.post_import_check.overset) || []).forEach(function (o) {
                if (!o || o.kind === "cell_overset" || o.cell !== undefined) return;
                if (o.frame_id !== undefined) seen[String(o.frame_id)] = true;
                rows.push({ text: clip(o.text, 40), page: o.page !== undefined ? o.page : pageName(o.where), target: o.frame_id !== undefined ? { frame: o.frame_id } : null });
            });
            var pf = (r.postflight && r.postflight.blocking) || [];
            (Array.isArray(pf) ? pf : []).forEach(function (b) {      // the final check saw it, the self-check list did not: still a row, found by id
                if (!b || b.kind !== "overset_text") return;
                if (b.frameId === undefined || b.frameId === null) { rows.push({ text: "", page: null, target: null }); return; }   // no id to go to: still a row
                if (!seen[String(b.frameId)]) { seen[String(b.frameId)] = true; rows.push({ text: "", page: null, target: { frame: Number(b.frameId) } }); }
            });
            return rows;
        }
    },
    {
        id: "overset_cell", heading: "Text does not fit its table cell",
        consequence: "The part that does not fit is hidden, so it will be missing in print.",
        advice: "Make the cell larger or shorten the translation, then import again.",
        howToFix: docs("text-too-long", OVERSET_STEPS),
        collect: function (r) {
            var rows = [];
            ((r.post_import_check && r.post_import_check.overset) || []).forEach(function (o) {
                if (!o || !(o.kind === "cell_overset" || o.cell !== undefined)) return;
                var ok = o.story_id !== undefined && o.table_index !== undefined && o.cell_index !== undefined;
                rows.push({ text: clip(o.text, 40), page: o.page !== undefined ? o.page : pageName(o.where), target: ok ? { story: num(o.story_id), table: o.table_index, cell: o.cell_index } : null });
            });
            return rows;
        }
    },
    {
        id: "not_located", heading: "Paragraph not updated",
        consequence: "The importer could not find this paragraph, so it still shows the old text.",
        advice: "Check that the paragraph was not edited by hand, or import the package again.",
        howToFix: null,
        collect: function (r) {
            var from = {};
            ((r.post_import_check && r.post_import_check.not_located) || []).forEach(function (n) { if (n && n.tid) from[n.tid] = n.from; });
            var rows = [];
            ((r.locate && r.locate.para_not_located) || []).forEach(function (m) {
                if (!m || m.translatable === false) return;                                  // a row nobody asked to translate is not a problem
                if (m.reason === "removed_by_earlier_import") return;                        // removed on purpose by an earlier import (merge tail)
                var ok = m.story_id !== undefined && m.story_id !== null && typeof m.paragraph_index === "number";
                rows.push({ text: clip(from[m.tid] || m.tid || "", 40), page: null, target: ok ? { story: num(m.story_id), para: m.paragraph_index } : null });
            });
            // a miss count the list does not describe (older report shapes): still a row, never silence
            var undescribed = Number(r.locate && r.locate.miss) - ((r.locate && r.locate.para_not_located) || []).length;
            if (undescribed > 0) rows.push({ text: undescribed + " paragraph(s), not listed", page: null, target: null });
            return rows;
        }
    },
    {
        id: "missing_text", heading: "Translated text is missing from the page",
        consequence: "The translation was not found where it should be, so the page may show old text or none.",
        advice: "Check the paragraph, then import again.",
        howToFix: null,
        collect: function (r) {
            return ((r.post_import_check && r.post_import_check.missing_text) || []).map(function (m) {
                return { text: clip(m && m.expected, 40), page: null, target: (m && m.story_id !== undefined) ? { story: num(m.story_id) } : null };
            });
        }
    },
    {
        id: "tofu_risk", heading: "Characters may print as empty boxes",
        consequence: "These characters use a font that does not contain them.",
        advice: "Set a font that has these characters, or add a font pair for it in the brand config.",
        howToFix: null,
        collect: function (r) {
            return ((r.post_import_check && r.post_import_check.tofu_risk) || []).map(function (t) {
                return { text: clip(t && (t.cjk_chars || t.text), 40), page: pageName(t && t.where), target: (t && t.story_id !== undefined) ? { story: num(t.story_id) } : null };
            });
        }
    },
    {
        id: "duplicate_text", heading: "Text appears twice in one story",
        consequence: "A paragraph repeats a line from another paragraph, so the page may print the same words twice.",
        advice: "Delete the repeated line by hand.",
        howToFix: null,
        collect: function (r) {
            return ((r.post_import_check && r.post_import_check.duplicate_text) || []).map(function (d) {
                return { text: clip(d && d.text, 40), page: null, target: (d && d.story_id !== undefined && typeof d.paragraph === "number") ? { story: num(d.story_id), para: d.paragraph } : null };
            });
        }
    },
    {
        id: "leftover_source", heading: "Original paragraph left on the page",
        consequence: "A whole paragraph of the original text is still there next to the translation.",
        advice: "Delete the paragraph, or translate it and import again.",
        howToFix: null,
        collect: function (r) {
            return ((r.post_import_check && r.post_import_check.leftover_source) || []).map(function (l) {
                return { text: clip(l && l.text, 40), page: null, target: (l && l.story_id !== undefined && typeof l.paragraph === "number") ? { story: num(l.story_id), para: l.paragraph } : null };
            });
        }
    },
    {
        id: "readback_mismatch", heading: "Written text differs from the translation",
        consequence: "After writing, the paragraph does not hold the translation, so the page may show different words.",
        advice: "Check the paragraph, then import again.",
        howToFix: null,
        collect: function (r) {
            return ((r.post_import_check && r.post_import_check.readback_mismatch) || []).map(function (m) {
                var s = storyOfTid(m && m.tid);
                return { text: clip(m && (m.expected || m.tid), 40), page: null, target: s !== null ? { story: s } : null };
            });
        }
    },
    {
        id: "postflight_other", heading: "Problem found in the final check",
        consequence: "The final check blocked on this item.",
        advice: "See the report for the details.",
        howToFix: null,
        collect: function (r) {
            var pf = (r.postflight && r.postflight.blocking) || [], by = {}, rows = [];
            (Array.isArray(pf) ? pf : []).forEach(function (b) {
                if (!b || b.kind === "overset_text") return;                                 // listed with the frames above
                var k = String(b.kind || "other");
                if (!by[k]) { by[k] = { text: POSTFLIGHT_WORDS[k] || k.replace(/_/g, " "), page: null, target: (b.frameId !== undefined && b.frameId !== null) ? { frame: Number(b.frameId) } : null, n: 0 }; rows.push(by[k]); }
                by[k].n++;
            });
            rows.forEach(function (x) { if (x.n > 1) x.text += " (" + x.n + ")"; delete x.n; });
            // a blocking count the list does not describe: still a row
            var undescribed = Number(r.postflight && r.postflight.blocking_count) - (Array.isArray(pf) ? pf.length : 0);
            if (!Array.isArray(pf) && Number(r.postflight && r.postflight.blocking_count) > 0) undescribed = Number(r.postflight.blocking_count);
            if (undescribed > 0) rows.push({ text: undescribed + " item(s), not listed", page: null, target: null });
            return rows;
        }
    },
    {
        id: "error", heading: "Import error",
        consequence: "Part of the import did not complete.",
        advice: "See the report for the details.",
        howToFix: null,
        collect: function (r) { return (r.errors || []).map(function (e) { return { text: clip(e, 90), page: null, target: null }; }); }
    },
    {
        id: "preflight_bypassed", heading: "A blocking preflight check was bypassed",
        consequence: "The import went on although a check before it had stopped it.",
        advice: "See the report for the details.",
        howToFix: null,
        // on its own this opens nothing (owner 2026-08-22, hard_errors 4A): it is listed only when the window opens for another reason
        listOnlyWithOthers: true,
        collect: function (r) { return r.preflight_blocking_overridden ? [{ text: "", page: null, target: null }] : []; }
    }
];

function buildWindow(report, reportPath) {
    report = report || {};
    var groups = [], count = 0, extra = null;
    TYPES.forEach(function (T) {
        var rows = T.collect(report);
        if (!rows.length) return;
        var g = { type: T.id, heading: T.heading + (rows.length > 1 || T.id.indexOf("overset") === 0 || T.id === "not_located" ? " (" + rows.length + ")" : ""),
                  consequence: T.consequence, advice: T.advice, howToFix: T.howToFix, rows: rows, listOnlyWithOthers: !!T.listOnlyWithOthers };
        if (T.listOnlyWithOthers) { extra = g; return; }
        groups.push(g); count += rows.length;
    });
    if (count > 0 && extra) { groups.push(extra); count += extra.rows.length; }
    return {
        shown: count > 0, count: count, groups: groups, reportPath: reportPath || null,
        title: "Import finished: " + (count === 1 ? "1 item needs attention" : count + " items need attention")
    };
}

// one line per group for the log (automation runs show no window; the log keeps what the window would have said)
function describe(win) {
    return (win.groups || []).map(function (g) { return g.heading + ": " + g.rows.map(function (r) { return (r.page ? "p" + r.page + " " : "") + (r.text || "-"); }).join(" | "); });
}

module.exports = { TYPES: TYPES, buildWindow: buildWindow, describe: describe, clip: clip, pageName: pageName, storyOfTid: storyOfTid, DOCS_BASE: DOCS_BASE };
