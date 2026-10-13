"use strict";

/**
 * lib/package_seq.js — translation-package sequence prefix ("V01D_" / "V02T_").
 *
 * owner 2026-09-25 (task_plan.md#pkg-seq-prefix): every export — InDesign or
 * webapp — carries ONE shared, increasing number plus a role letter:
 *   D = designer export (InDesign), T = translator export (webapp).
 * A normal round trip reads V01D → V02T → V03D → V04T; all packages of a
 * project can live in one folder and sort by name = sort by time.
 * Interim design: the number lives ONLY in file / folder names (Phase 10
 * `versions/` will later become the source; the prefix format stays).
 *
 * Pure functions, no host / fs. The webapp keeps a byte-for-byte twin of
 * parseSeq / parseRole / formatPrefix / stripSeq / packageStem
 * (app-folio lib/package_seq.js) — change both together.
 */

// V<digits>, optional role letter, underscore. The role is optional only so a
// hand-renamed "V03_" still counts; every exporter writes a role.
var PREFIX_RE = /^V(\d+)([DT])?_/;
// Timestamp tails the two exporters append: _translation_package_YYYYMMDD_HHMMSS
// (InDesign) and _translated_YYYYMMDD_HHMMSS (webapp). Stripped repeatedly so a
// name that went through several round trips reduces to the document stem.
var TAIL_RE = /_(?:translation_package|translated)_\d{8}_\d{6}$/;

function _lastSegment(name) {
    var s = String(name);
    var cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return cut >= 0 ? s.substring(cut + 1) : s;
}

// "V03D_foo" → 3; no prefix → null. Accepts full paths (uses the last segment).
function parseSeq(name) {
    if (name == null) return null;
    var m = PREFIX_RE.exec(_lastSegment(name));
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isFinite(n) ? n : null;
}

// "V03D_foo" → "D"; "V03_foo" / no prefix → null.
function parseRole(name) {
    if (name == null) return null;
    var m = PREFIX_RE.exec(_lastSegment(name));
    return (m && m[2]) ? m[2] : null;
}

// (1, "D") → "V01D_", (12, "T") → "V12T_", (123, "D") → "V123D_".
function formatPrefix(n, role) {
    var k = Math.max(1, Math.floor(Number(n) || 0));
    var r = (role === "D" || role === "T") ? role : "";
    return "V" + (k < 10 ? "0" + k : String(k)) + r + "_";
}

// Remove one leading prefix.
function stripSeq(name) {
    return String(name == null ? "" : name).replace(PREFIX_RE, "");
}

// "V01D_Doc_translation_package_20260925_133248_translated_20260925_141345.zip" → "Doc"
function packageStem(name) {
    var s = stripSeq(_lastSegment(name == null ? "" : name).replace(/\.zip$/i, ""));
    var prev;
    do { prev = s; s = s.replace(TAIL_RE, ""); } while (s !== prev);
    return s || "package";
}

// Highest number among packages of THIS document (both roles) in `names`.
// A name counts only if it has a prefix AND a recognisable exporter tail AND its
// stem equals `stem` exactly (so "A" never picks up "A_B"'s packages).
function maxSeqForStem(names, stem) {
    var best = 0;
    for (var i = 0; i < (names || []).length; i++) {
        var nm = String(names[i]);
        var n = parseSeq(nm);
        if (n == null) continue;
        var bare = stripSeq(_lastSegment(nm)).replace(/\.zip$/i, "");
        if (!TAIL_RE.test(bare)) continue;
        if (packageStem(nm) !== String(stem)) continue;
        if (n > best) best = n;
    }
    return best;
}

// Next number = max(all known) + 1; unknown / none → 1.
function nextSeq(candidates) {
    var best = 0;
    for (var i = 0; i < (candidates || []).length; i++) {
        var n = Number(candidates[i]);
        if (isFinite(n) && n > best) best = Math.floor(n);
    }
    return best + 1;
}

module.exports = {
    PREFIX_RE: PREFIX_RE,
    TAIL_RE: TAIL_RE,
    parseSeq: parseSeq,
    parseRole: parseRole,
    formatPrefix: formatPrefix,
    stripSeq: stripSeq,
    packageStem: packageStem,
    maxSeqForStem: maxSeqForStem,
    nextSeq: nextSeq,
    LABEL_KEY: "package_seq_v1",
    ROLE_DESIGNER: "D",
    ROLE_TRANSLATOR: "T"
};
