"use strict";
// import_report_pick.js — #ac-emphasis-relations batch 5 ② (task_plan §7.6 第 5 批 · plan A2 +
// plan-audit pass-2 C): which import report the standalone font panel reads to decide whether
// to show the "bold on another font in a paragraph" (emphasis_foreign_family) row.
//
// The import writes <source doc dir>/script_outputs/writeback_v2_report_<YYYYMMDD_HHMMSS>.json
// on every run (never age-purged — it is not under log/). The panel takes the LATEST report for
// the open document and reads ONLY that one (⛔ never merges reports):
//   candidates  name matches the pattern, body parses as JSON, save_target_path == the open
//               document (separators unified to "/", case-insensitive on Windows)
//   order       generated_at_utc desc (missing / unparseable ⇒ oldest) → filename timestamp desc
//               → whole filename desc
// No report ⇒ the row is not shown (no guessing); a read failure counts as "no report".

var NAME_RE = /^writeback_v2_report_(\d{8}_\d{6})\.json$/;

function _normPath(p, ci) {
    var s = String(p || "").replace(/\\/g, "/");
    return ci ? s.toLowerCase() : s;
}

// @param cands [{ name, text }]   @param docPath the open document's full path
// @param opts  { caseInsensitive }   @returns { name, report } | null
function pickLatestReport(cands, docPath, opts) {
    var ci = !!(opts && opts.caseInsensitive);
    var want = _normPath(docPath, ci);
    var ok = [];
    (cands || []).forEach(function (c) {
        if (!c || !c.name) return;
        var m = NAME_RE.exec(String(c.name));
        if (!m) return;
        var rep = null;
        try { rep = JSON.parse(String(c.text)); } catch (e) { return; }
        if (!rep || typeof rep !== "object") return;
        if (_normPath(rep.save_target_path, ci) !== want) return;
        var t = Date.parse(String(rep.generated_at_utc));
        ok.push({ name: String(c.name), report: rep, t: isFinite(t) ? t : -Infinity, stamp: m[1] });
    });
    if (!ok.length) return null;
    ok.sort(function (a, b) {
        if (a.t !== b.t) return b.t > a.t ? 1 : -1;
        if (a.stamp !== b.stamp) return b.stamp > a.stamp ? 1 : -1;
        return b.name > a.name ? 1 : (b.name < a.name ? -1 : 0);
    });
    return { name: ok[0].name, report: ok[0].report };
}

// How many undecided "foreign family" landings the picked report recorded (0 = none / no report).
function foreignFamilyDemand(picked) {
    var f = picked && picked.report && picked.report.foreign_family_undecided;
    var c = f ? Number(f.count) : 0;
    return isFinite(c) && c > 0 ? c : 0;
}

// #144: the undecided marks themselves (text, fonts, page, what each answer would land on) —
// [] when there is no report or it predates the fields. Never invents a field.
function foreignFamilyItems(picked) {
    var f = picked && picked.report && picked.report.foreign_family_undecided;
    var a = f && Array.isArray(f.families) ? f.families : [];
    return a.filter(function (x) { return x && typeof x === "object"; }).map(function (x) {
        return { tid: x.tid || null, text: String(x.text === undefined || x.text === null ? "" : x.text), family: x.family || null,
            body_family: x.body_family || null, dimension: x.dimension || "bold", style: x.style || null,
            page: (x.page === undefined || x.page === null) ? null : String(x.page),
            own: x.own_would_be && typeof x.own_would_be === "object" ? x.own_would_be : null,
            body: x.body_would_be && typeof x.body_would_be === "object" ? x.body_would_be : null };
    });
}

// Host side (UXP): list <dir of docPath>/script_outputs, read every candidate, pick.
// @returns { picked: {name, report}|null, error: string|null }  — an error = "no report"
async function readLatestReportForDoc(docPath) {
    var out = { picked: null, error: null };
    try {
        var p = String(docPath || "");
        var cut = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
        if (cut <= 0) { out.error = "document has no folder"; return out; }
        var sep = p.lastIndexOf("\\") > p.lastIndexOf("/") ? "\\" : "/";
        var dir = p.substring(0, cut) + sep + "script_outputs";
        var lfs = require("uxp").storage.localFileSystem;
        var folder = await lfs.getEntryWithUrl("file:///" + dir.replace(/\\/g, "/").replace(/^\/+/, ""));
        if (!folder || !folder.isFolder) { out.error = "no script_outputs folder"; return out; }
        var entries = await folder.getEntries();
        var fs = require("fs"), cands = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e || !e.isFile || !NAME_RE.test(String(e.name))) continue;
            try { cands.push({ name: String(e.name), text: String(fs.readFileSync(dir + sep + e.name, "utf-8")) }); } catch (eR) {}
        }
        var ci = sep === "\\";
        out.picked = pickLatestReport(cands, p, { caseInsensitive: ci });
    } catch (eAll) {
        out.error = String(eAll && eAll.message || eAll);
    }
    return out;
}

module.exports = {
    pickLatestReport: pickLatestReport,
    foreignFamilyDemand: foreignFamilyDemand,
    foreignFamilyItems: foreignFamilyItems,
    readLatestReportForDoc: readLatestReportForDoc,
    NAME_RE: NAME_RE
};
