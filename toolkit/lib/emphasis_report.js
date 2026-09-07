"use strict";

// lib/emphasis_report.js
//
// Translator-facing HTML preview of every paragraph that has per-character
// emphasis (mixed-format runs). Renders runs in-place using <span> styled
// from the emphasis run's `diff` so a translator can see exactly which
// words are bolded / colored / underlined / sized before they touch the
// text.
//
// Pure module: no UXP / InDesign DOM dependencies. The export script
// requires this and writes the returned HTML straight to disk.

function escHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function fillColorToCss(c) {
    if (!c) return null;
    if (c.values && c.values.length === 3) {
        return "rgb(" + Math.round(c.values[0]) + "," +
                       Math.round(c.values[1]) + "," +
                       Math.round(c.values[2]) + ")";
    }
    if (c.swatch) {
        var lower = String(c.swatch).toLowerCase();
        if (lower === "red")    return "rgb(220,30,30)";
        if (lower === "blue")   return "rgb(25,80,200)";
        if (lower === "yellow") return "rgb(220,180,30)";
        if (lower === "green")  return "rgb(30,160,60)";
        if (lower === "cyan")   return "rgb(0,160,200)";
        if (lower === "magenta")return "rgb(200,0,160)";
        if (lower === "black")  return "rgb(0,0,0)";
        return "currentColor";
    }
    return null;
}

function diffToCss(diff) {
    if (!diff) return "";
    var parts = [];
    if (diff.fontStyle) {
        var fs = String(diff.fontStyle).toLowerCase();
        if (fs.indexOf("bold") >= 0)   parts.push("font-weight:700");
        if (fs.indexOf("italic") >= 0) parts.push("font-style:italic");
    }
    if (diff.fontSize) parts.push("font-size:" + diff.fontSize + "pt");
    if (diff.underline && diff.strikeThrough) {
        parts.push("text-decoration:underline line-through");
    } else if (diff.underline) {
        parts.push("text-decoration:underline");
    } else if (diff.strikeThrough) {
        parts.push("text-decoration:line-through");
    }
    var col = fillColorToCss(diff.fillColor);
    if (col) parts.push("color:" + col);
    if (diff.fontFamily) {
        parts.push("font-family:'" + String(diff.fontFamily).replace(/'/g, "") + "',sans-serif");
    }
    if (typeof diff.baseline_shift === "number" && diff.baseline_shift !== 0) {
        parts.push(diff.baseline_shift > 0 ? "vertical-align:super" : "vertical-align:sub");
    }
    return parts.join(";");
}

function paragraphHtml(text, runs) {
    if (!text) return "";
    if (!runs || !runs.length) return escHtml(text);
    var len = text.length;
    var sorted = runs.slice().sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
    var pos = 0, html = "";
    for (var i = 0; i < sorted.length; i++) {
        var r = sorted[i];
        var s = Math.max(0, Math.min(len, r.start || 0));
        var e = Math.max(s, Math.min(len, r.end || s));
        if (s > pos) html += escHtml(text.substring(pos, s));
        var css = diffToCss(r.diff);
        html += "<span class=\"emp\"" + (css ? " style=\"" + css + "\"" : "") + ">" +
                escHtml(text.substring(s, e)) + "</span>";
        pos = e;
    }
    if (pos < len) html += escHtml(text.substring(pos));
    return html;
}

function diffSummaryKeys(diff) {
    if (!diff) return "";
    var keys = [];
    for (var k in diff) {
        if (Object.prototype.hasOwnProperty.call(diff, k)) keys.push(k);
    }
    keys.sort();
    return keys.join(",");
}

function buildEmphasisReportHtml(docName, segments, stats) {
    var rows = [];
    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (!seg || !seg.format_snapshot) continue;
        var fs = seg.format_snapshot;
        var runs = fs.emphasis_runs || fs.emphasisRuns || [];
        if (!runs.length) continue;
        rows.push({
            tid:             seg.tid,
            story_id:        seg.story_id,
            paragraph_index: seg.paragraph_index,
            source_text:     seg.source_text || "",
            baseline:        fs.baseline,
            runs:            runs
        });
    }

    var lines = [];
    lines.push("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
    lines.push("<title>Emphasis report &mdash; " + escHtml(docName) + "</title>");
    lines.push("<style>");
    lines.push("body{font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;margin:24px;color:#222}");
    lines.push("h1{font-size:20px;margin:0 0 4px}");
    lines.push(".meta{color:#666;font-size:12px;margin-bottom:18px}");
    lines.push("table{border-collapse:collapse;width:100%;table-layout:fixed}");
    lines.push("th,td{border-bottom:1px solid #eee;padding:8px 10px;vertical-align:top;text-align:left;word-wrap:break-word}");
    lines.push("th{background:#fafafa;font-weight:600;font-size:12px;color:#555}");
    lines.push("col.tidcol{width:140px}");
    lines.push("col.locol{width:80px}");
    lines.push("col.bodycol{width:auto}");
    lines.push("col.runscol{width:220px}");
    lines.push(".tid{font-family:Consolas,monospace;font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}");
    lines.push(".st{font-family:Consolas,monospace;font-size:11px;color:#aaa}");
    lines.push(".body{font-size:14px;line-height:1.65}");
    lines.push(".body .emp{background:rgba(255,235,0,0.18);border-radius:2px;padding:0 1px}");
    lines.push(".runs{font-family:Consolas,monospace;font-size:11px;color:#666}");
    lines.push(".runs .row{margin:1px 0}");
    lines.push(".empty{color:#999;font-style:italic}");
    lines.push("</style></head><body>");
    lines.push("<h1>Emphasis report</h1>");
    lines.push("<div class=\"meta\">");
    lines.push("Document: <b>" + escHtml(docName) + "</b> &middot; ");
    lines.push("Mixed-format paragraphs: <b>" + rows.length + "</b> &middot; ");
    var runTotal = (stats && stats.emphasis_run_total) || 0;
    if (!runTotal) {
        runTotal = 0;
        for (var k = 0; k < rows.length; k++) runTotal += rows[k].runs.length;
    }
    lines.push("Total emphasis runs: <b>" + runTotal + "</b>");
    lines.push("</div>");
    if (rows.length === 0) {
        lines.push("<p class=\"empty\">No mixed-format paragraphs detected.</p>");
    } else {
        lines.push("<table>");
        lines.push("<colgroup><col class=\"tidcol\"><col class=\"locol\"><col class=\"bodycol\"><col class=\"runscol\"></colgroup>");
        lines.push("<thead><tr><th>TID</th><th>Story / &para;</th><th>Paragraph (emphasis highlighted)</th><th>Runs</th></tr></thead><tbody>");
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            var runHtml = "";
            for (var rj = 0; rj < row.runs.length; rj++) {
                var rn = row.runs[rj];
                runHtml += "<div class=\"row\">[" +
                    (rn.start || 0) + "&ndash;" + (rn.end || 0) + "] " +
                    escHtml(diffSummaryKeys(rn.diff)) +
                    "</div>";
            }
            lines.push("<tr>");
            lines.push("<td class=\"tid\">" + escHtml(row.tid || "") + "</td>");
            lines.push("<td class=\"st\">" + (row.story_id != null ? row.story_id : "?") + " / " +
                       (row.paragraph_index != null ? row.paragraph_index : "?") + "</td>");
            lines.push("<td class=\"body\">" + paragraphHtml(row.source_text, row.runs) + "</td>");
            lines.push("<td class=\"runs\">" + runHtml + "</td>");
            lines.push("</tr>");
        }
        lines.push("</tbody></table>");
    }
    lines.push("</body></html>");
    return lines.join("");
}

module.exports = {
    buildEmphasisReportHtml: buildEmphasisReportHtml,
    // exposed for tests
    _internal: {
        escHtml: escHtml,
        diffToCss: diffToCss,
        paragraphHtml: paragraphHtml,
        diffSummaryKeys: diffSummaryKeys,
        fillColorToCss: fillColorToCss
    }
};
