"use strict";

/**
 * lib/cjk_render_confirm.js — byPair save gate, fix F3 (arch 2026-09-30).
 *
 * The byPair sweep reads a font per TEXT STYLE RANGE. A range does not split
 * where a paragraph style's GREP style switches the font, so a range that starts
 * with a Latin character (a space, "100%", "Solactive") reports the Latin font
 * for the whole range — while its CJK characters are set in the paragraph's CJK
 * font. Host 2026-09-30 (Growth dev copy): all three runs that blocked the save as
 * "CJK in Dax Pro (OTF)" had every CJK character in MHeiHK, ascent/pointSize
 * 0.716 (findings #bypair-tsr-false-tofu).
 *
 * So before an "unowned CJK run" blocks the save, each of its CJK characters is
 * checked BY RENDERING, not only by its property:
 *   · its own appliedFont family must be a CJK font (post_import_check's list), and
 *   · its ascent / pointSize must NOT match a Latin signature — the ratio measured
 *     on the run's own Latin characters in the reported font (Dax 0.785–0.799) or
 *     the missing-font fallback Myriad (0.750). A Dax weight set by hand can read
 *     "Dax Pro (OTF) Bold, INSTALLED" and still render as Myriad
 *     (findings #manual-weight-without-char-style-can-render-as-myriad).
 * Only when EVERY CJK character passes is the run released (with a note "range
 * reported X, characters are Y"); anything else keeps it blocked. No CJK
 * character at all ⇒ not released (nothing proven).
 */

var PIC = require("./post_import_check.js");

var MYRIAD_RATIO = 0.750;      // missing-font fallback (MyriadPro-Regular), host 2026-09-30
var RATIO_TOL = 0.005;

function _near(a, b) { return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= RATIO_TOL; }

/**
 * decideCjkRun(chars, reported) -> { release, cjkCount, families, bad: [...], latinRatio, note }
 *   chars    = [{ ch, family, ratio }]   (ratio = ascent / pointSize, rendered)
 *   reported = { font, weight }         what the range said
 */
function decideCjkRun(chars, reported) {
    reported = reported || {};
    var latinRatios = [], fam = {}, bad = [], cjkCount = 0;
    (chars || []).forEach(function (c) {
        if (!c || PIC.isCJKChar(c.ch)) return;
        if (!/\S/.test(c.ch)) return;
        if (c.family === reported.font && typeof c.ratio === "number") latinRatios.push(c.ratio);
    });
    var latinRatio = latinRatios.length ? latinRatios[0] : null;
    (chars || []).forEach(function (c, i) {
        if (!c || !PIC.isCJKChar(c.ch)) return;
        cjkCount++;
        var why = null;
        if (!PIC.isCJKFamily(c.family)) why = "font is " + c.family;
        else if (typeof c.ratio !== "number") why = "no rendered metrics";
        else if (_near(c.ratio, MYRIAD_RATIO)) why = "renders like the Myriad fallback (" + c.ratio + ")";
        else if (latinRatios.some(function (r) { return _near(c.ratio, r); })) why = "renders like the range's Latin font (" + c.ratio + ")";
        if (why) bad.push({ index: i, ch: c.ch, why: why });
        else fam[c.family] = (fam[c.family] || 0) + 1;
    });
    var release = cjkCount > 0 && bad.length === 0;
    var famList = Object.keys(fam);
    return {
        release: release, cjkCount: cjkCount, families: fam, bad: bad, latinRatio: latinRatio,
        note: release ? ("range reported " + reported.font + " " + reported.weight + "; its " + cjkCount
            + " CJK character(s) are " + famList.join(" / ") + " by font and by rendering — not tofu") : null
    };
}

// ── host ─────────────────────────────────────────────────────────────────────

function _fam(f) {
    try { var n = (f && f.name != null) ? String(f.name) : String(f || ""); var i = n.indexOf("\t"); return i >= 0 ? n.slice(0, i) : n; }
    catch (e) { return ""; }
}

// The same addressing the apply step uses (font_mapping_apply_to_doc.js:150-157):
// story-relative offsets, or cell-text-relative when cellPath is set.
function _charsOf(doc, run) {
    var story = doc.stories.item(run.storyIdx);
    var container = run.cellPath
        ? story.tables.item(run.cellPath.tableIdx).cells.item(run.cellPath.cellIdx).texts.item(run.cellPath.textIdx).characters
        : story.characters;
    return container.itemByRange(run.idxStart, run.idxEnd);
}

function _style(f) {
    try { var n = (f && f.name != null) ? String(f.name) : String(f || ""); var i = n.indexOf("\t"); return i >= 0 ? n.slice(i + 1) : ""; }
    catch (e) { return ""; }
}

// `ascent` comes back in the script measurement unit — with the default AUTO_VALUE
// that is the document's ruler unit (PICAS in the Client-A files) — while `pointSize` reads
// in points under AUTO (but follows an EXPLICIT script unit too: PICAS 13pt ⇒ 1.083,
// host probe 2026-10-01). Host 2026-10-01 (Select, fresh InDesign session): Arial 0.0607 vs
// MHeiHK 0.0597 in picas ⇒ within RATIO_TOL ⇒ the CJK was judged "renders like the
// Latin font" and 5 false positives stayed blocked; in points the same characters
// read 0.728 vs 0.716. (Earlier the same day they were released: some script had
// left the unit at POINTS — the result depended on session state.) So the ratio is
// read with the unit forced to POINTS and restored afterwards.
function _hostApi() {
    try { var ID = require("indesign"); return ID && ID.app && ID.MeasurementUnits ? { app: ID.app, MeasurementUnits: ID.MeasurementUnits } : null; }
    catch (e) { return null; }
}
function _inPoints(host, fn) {
    var prev, set = false;
    if (host) {
        try { prev = host.app.scriptPreferences.measurementUnit; host.app.scriptPreferences.measurementUnit = host.MeasurementUnits.POINTS; set = true; } catch (e) {}
    }
    try { return fn(); }
    finally { if (set) { try { host.app.scriptPreferences.measurementUnit = prev; } catch (e2) {} } }
}

/** readChars(textObj[, host]) -> [{ ch, family, style, ratio }] — each character's own font and
 *  rendered ascent/pointSize, measured in points. `host` = { app, MeasurementUnits } (tests). */
function readChars(textObj, host) {
    return _inPoints(host || _hostApi(), function () {
        var els = textObj.characters.everyItem().getElements(), out = [];
        for (var i = 0; i < els.length; i++) {
            var c = els[i], ratio = null, f = null;
            try { var ps = Number(c.pointSize); ratio = ps > 0 ? Math.round(Number(c.ascent) / ps * 1000) / 1000 : null; } catch (eR) { ratio = null; }
            try { f = c.appliedFont; } catch (eF) { f = null; }
            out.push({ ch: String(c.contents), family: _fam(f), style: _style(f), ratio: ratio });
        }
        return out;
    });
}

/**
 * hanFontOfRange(reportedFamily, reportedStyle, chars) — for a tool that reads the
 * font of a text-style RANGE: what font are its CJK characters really in?
 *   { kind: "none" }                       no CJK character
 *   { kind: "cjk", family, style, ... }    CJK characters confirmed (font + rendering)
 *   { kind: "tofu", bad: [...] }           CJK characters really in a Latin font / fallback
 * A range whose reported font is already a CJK family is taken as is (nothing to confirm).
 */
function hanFontOfRange(reportedFamily, reportedStyle, chars) {
    var hasCjk = (chars || []).some(function (c) { return c && PIC.isCJKChar(c.ch); });
    if (!hasCjk) return { kind: "none" };
    if (PIC.isCJKFamily(reportedFamily)) return { kind: "cjk", family: reportedFamily, style: reportedStyle, confirmed: false };
    var d = decideCjkRun(chars, { font: reportedFamily, weight: reportedStyle });
    if (!d.release) return { kind: "tofu", bad: d.bad };
    var first = null;
    for (var i = 0; i < chars.length && !first; i++) if (PIC.isCJKChar(chars[i].ch)) first = chars[i];
    var fams = Object.keys(d.families);
    return { kind: "cjk", family: first.family, style: first.style || "", confirmed: true, families: fams,
             note: "range reported " + reportedFamily + " " + reportedStyle + "; its CJK characters are " + fams.join(" / ") };
}

/**
 * latinFontsOfRange(chars, isLatin) -> [{ family, style }] — the distinct fonts of the
 * range's Latin characters, each read from the character itself. Needed when a range
 * reports a CJK font: its Latin letters may be set in the Latin font by a GREP style.
 */
function latinFontsOfRange(chars, isLatin) {
    var seen = {}, out = [];
    (chars || []).forEach(function (c) {
        if (!c || !isLatin(c.ch)) return;
        var k = c.family + "\t" + (c.style || "");
        if (seen[k]) return;
        seen[k] = true; out.push({ family: c.family, style: c.style || "" });
    });
    return out;
}

/**
 * confirmUnownedRuns(doc, unowned) -> { stillUnowned: [...], released: [...], errors: [...] }
 * A run that cannot be read stays blocked (fail-closed).
 */
function confirmUnownedRuns(doc, unowned) {
    var out = { stillUnowned: [], released: [], errors: [] };
    (unowned || []).forEach(function (run) {
        try {
            var chars = readChars(_charsOf(doc, run));     // the one character reader
            var d = decideCjkRun(chars, { font: run.sourceFont, weight: run.sourceWeight });
            if (d.release) {
                var rel = {}; for (var k in run) if (Object.prototype.hasOwnProperty.call(run, k)) rel[k] = run[k];
                rel.confirmedFamilies = d.families; rel.note = d.note;
                out.released.push(rel);
            } else {
                out.stillUnowned.push(run);
            }
        } catch (e) {
            out.errors.push("s" + run.storyIdx + ":" + run.idxStart + "-" + run.idxEnd + ": " + (e && e.message ? e.message : e));
            out.stillUnowned.push(run);
        }
    });
    return out;
}

module.exports = { decideCjkRun: decideCjkRun, confirmUnownedRuns: confirmUnownedRuns, readChars: readChars, hanFontOfRange: hanFontOfRange, latinFontsOfRange: latinFontsOfRange, MYRIAD_RATIO: MYRIAD_RATIO };
