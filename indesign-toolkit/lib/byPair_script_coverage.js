"use strict";

/**
 * lib/byPair_script_coverage.js — Phase 8D-ext-D pre-check (net-new, r11 P2)
 *
 * verifyDstFontScriptCoverage(byPairEntry, langScriptTable) — single policy
 * (task_plan 8D-ext-D r17 iter4/6 final + r25 P2#5 softening at facade):
 *
 *   Stage 1 (hard): dstFont not installed → { stage1Reject: true }.
 *     Caller (facade byPair_char_sweep) routes this to diagnostics.warnings
 *     with skip-entry semantics (r25 P2#5: all-mode softer), NOT blocked.
 *     Check = itemByName(family + "\t" + style) + isValid + status INSTALLED
 *     (itemByName can return an invalid specifier without throwing — r17
 *     iter3 P1#2; everyItem(callback) unsupported in UXP).
 *     TODO#34: when the exact spelling fails, the SAME font may be installed
 *     under another name — Stage 1 resolves via _resolveInstalledFontName
 *     (layers ①-④ only; ⑤ case-insensitive scan is style_applier-only) and
 *     STRICTLY re-verifies the proposed name (resolution borrowed, fail-closed
 *     verdict kept). Success → stage1Reject:false + resolvedDst:{font,weight};
 *     the caller MUST forward resolvedDst as a runtime entry copy (config is
 *     never rewritten).
 *
 *   Stage 2 (warning-only hint): dstFont.writingScript normalized classes
 *     ⊉ langScriptTable[dstLang].required_scripts → mismatch warning.
 *     Missing/lang_unsupported table entry, or unknown writingScript value
 *     → unknown warning (r17 iter7 P1 guard: never reject, never throw).
 *     No char.appliedFont sample probe (r17 iter2 P2: would leave direct
 *     override traces in the imported doc).
 *
 * Node tests: `app` unavailable → Stage 1 returns stage1Reject:false with
 * stage1Unverified:true (cannot check; pure-function paths still testable).
 *
 * Return shape (always all fields):
 *   { stage1Reject, stage1Unverified, stage2Warning, warningType,
 *     pairingId, dstFont, dstWeight, dstLang, resolvedDst, message }
 */

// MVP detail #2: isolated-module app resolution (Scripts Panel double-click
// gives each require() an isolated scope; require("indesign") is the only
// reliable accessor; Node tests throw → tolerate).
var app, FontStatus;
try {
    var _id = require("indesign");
    app = _id.app;
    FontStatus = _id.FontStatus;
} catch (eReq) {}

// writingScript → script-class set normalizer (task_plan r17 iter6).
// ASSUMPTION (断言纪律): Font.writingScript is an undocumented Number
// (indesign-18-dom Font/index.md:103 — "Number writingScript", no enum).
// Mapping below follows classic Mac ScriptCode conventions (smRoman=0,
// smJapanese=1, smTradChinese=2, smKorean=3, smArabic=4, smHebrew=5,
// smCyrillic=7, smDevanagari=9, smThai=21, smSimpChinese=25). Best-effort:
// Stage 2 is warning-only by design, and unmapped numbers fall through to
// the 'unknown' warning rather than a wrong verdict. Verify against a live
// probe before trusting specific non-Roman codes (probes/ pattern).
var WRITING_SCRIPT_CLASSES = {
    0:  ["latin"],            // Roman
    1:  ["han", "kana"],      // Japanese
    2:  ["han"],              // Traditional Chinese
    3:  ["hangul", "han"],    // Korean
    4:  ["arabic"],           // Arabic
    5:  ["hebrew"],           // Hebrew
    7:  ["cyrillic"],         // Cyrillic
    9:  ["devanagari"],       // Devanagari
    21: ["thai"],             // Thai
    25: ["han"]               // Simplified Chinese
};

function _writingScriptToClasses(ws) {
    if (typeof ws !== "number") return null; // unknown
    var classes = WRITING_SCRIPT_CLASSES[ws];
    return classes ? classes : null; // unmapped number → unknown
}

function _result(entry, fields) {
    var r = {
        stage1Reject: false,
        stage1Unverified: false,
        stage2Warning: false,
        warningType: null,
        pairingId: (entry && typeof entry.pairingId !== "undefined") ? entry.pairingId : null,
        dstFont: entry ? entry.dstFont : null,
        dstWeight: entry ? entry.dstWeight : null,
        dstLang: entry ? entry.dstLang : null,
        // TODO#34: non-null {font, weight} when Stage 1 passed via alias resolution
        // (the config spelling is not installed but resolver layers ①-④ found the
        // SAME font under its installed name, strictly re-verified). The caller
        // (byPair_char_sweep) must thread this into the entry it forwards, or the
        // apply path writes the config spelling and InDesign substitutes — a
        // green-but-ineffective shape. Config itself is NEVER written.
        resolvedDst: null,
        message: ""
    };
    for (var k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) r[k] = fields[k];
    }
    return r;
}

// CONTRACT (8D-ext-D step-3a, B-class): this entry point REQUIRES a canonical
// BCP-47 byPairEntry.dstLang. The Stage-2 langScriptTable lookup
// (lookupLangScriptEntry, exact-only) assumes the facade has already folded any
// raw region/script tag to canonical identity. The single enforcement point is
// applyByPairSweep (_canonicalizeSweepInputs in lib/byPair_char_sweep.js) — the
// choke-point is deliberate; do NOT add a per-consumer normalize here. A direct
// caller passing a raw tag (e.g. "zh-Hans-CN") is a contract violation.
// checkDstFaceInstalled — the ONE Stage-1 installedness + alias-resolution
// implementation, SHARED by the gate (verifyDstFontScriptCoverage below) and the
// panel's missing-face warning (#28e font_face_missing.gateProbeFace). Panel and
// gate cannot drift — they share this implementation. (panelfix extracted the
// strict check under this name; #34 folds alias resolution INSIDE it so both
// readers get the same answer. Contract superset — the four original fields keep
// their exact semantics; consumers of {verifiable, installed, error, fontObj}
// need no change.)
//
// Returns (always all fields):
//   verifiable     false ⇔ no host (Node tests) — caller must NOT treat as missing
//   installed      strict verdict (possibly via alias resolution, see below)
//   error          non-null ⇔ itemByName threw — entry will be rejected/skipped
//   fontObj        the INSTALLED Font object (the resolved face when aliased) —
//                  Stage 2's writingScript check reads it
//   resolvedFont / resolvedWeight   non-null ⇔ installed via ALIAS: the config
//                  spelling is not installed but the SAME font is, under this
//                  name (TODO#34, owner: "能准确合并的就自动合并不提示"). The gate
//                  threads these forward as a runtime entry copy; config is NEVER
//                  rewritten. null on an exact hit (no aliasing happened).
//   layer          1 exact · 2 named-weight twin · 3 base-subfamily · 4 curated/
//                  reverse-twin · null not installed. ②/③ attributed by comparing
//                  the resolved name to those layers' constructed forms, ④ by
//                  elimination — best-effort observability for future boundary
//                  tuning (arch 2026-08-12), NOT load-bearing.
//
// Resolution = _resolveInstalledFontName, layers ①-④ only (exact / named-weight
// twin / Regular→base-subfamily / curated reverse map). Layer ⑤ (case-insensitive
// whole-table scan) lives in style_applier, NOT in that resolver — structurally
// excluded here: a fuzzy hit nobody asked for stays "not installed" and the panel
// lists it (owner: 不能合并的就原样列出).
//
// ⚠ Resolution borrowed, verdict NOT: the resolver only PROPOSES a name; the
// SAME strict fail-closed check re-verifies it here. TODO#38 (owner 3A
// 2026-08-13) closed the resolver's own fail-open (_isSystemFontInstalled:2104
// now treats unreadable status as NOT installed), which also retired the #34
// "under-resolve" boundary: an unreadable-status face now just MISSES its layer
// and later layers still get probed, instead of the resolver locking onto an
// unverifiable name early. The strict re-verify stays — belt and braces, and it
// keeps this gate's verdict independent of resolver internals.
function checkDstFaceInstalled(family, weight) {
    var out = { verifiable: false, installed: false, error: null, fontObj: null,
                resolvedFont: null, resolvedWeight: null, layer: null };
    if (!(app && app.fonts && FontStatus)) return out;
    out.verifiable = true;
    // STRICT installed check — deliberately fail-CLOSED: itemByName exact name +
    // isValid + stringified status === "INSTALLED". (UXP enum objects are NOT
    // ===-comparable — a fresh wrapper is minted on every property access, so
    // `f.status !== FontStatus.INSTALLED` is ALWAYS true and Stage-1 would reject
    // EVERY font. Host-confirmed 2026-06-10. Compare stringified enum names
    // instead, same fix as hard_errors.js:186-189.)
    function _strictInstalled(fam, w) {
        var f = app.fonts.itemByName(String(fam) + "\t" + String(w));
        var _statusName = String(f && f.status || "");
        if (_statusName.indexOf(".") >= 0) _statusName = _statusName.split(".").pop();
        return (f && f.isValid && _statusName === "INSTALLED") ? f : null;
    }
    try {
        var f0 = _strictInstalled(family, weight);
        if (f0) {
            out.installed = true; out.fontObj = f0; out.layer = 1;
            return out;
        }
        // exact spelling not installed → alias resolution (①-④), then STRICT re-verify.
        var _r = null;
        try {
            var _ssbInt = require("./style_sheet_builder.js")._internal;
            if (_ssbInt && typeof _ssbInt._resolveInstalledFontName === "function") {
                // workDoc shim: the resolver only reads workDoc.parent to start its
                // walk-up to app.fonts (host-probed 20260812_05).
                _r = _ssbInt._resolveInstalledFontName({ parent: app }, family, weight);
            }
        } catch (eRes) { _r = null; }
        if (_r && _r.family) {
            var fR = _strictInstalled(_r.family, _r.fontStyle);
            if (fR) {
                out.installed = true; out.fontObj = fR;
                out.resolvedFont = _r.family; out.resolvedWeight = _r.fontStyle;
                out.layer = _attributeLayer(family, weight, _r);
                return out;
            }
        }
        return out;   // verifiable, not installed (layer ⑤-only / truly missing)
    } catch (eFont) {
        out.error = String(eFont && eFont.message || eFont);
        return out;
    }
}

// Best-effort layer attribution for checkDstFaceInstalled.layer (observability
// only — never load-bearing). Rebuilds layers ②/③'s NAME FORMS with the
// resolver's own exported strip helper and compares; anything else that resolved
// is ④ (curated map / reverse twin) by elimination.
function _attributeLayer(family, weight, resolved) {
    try {
        var _ssbInt = require("./style_sheet_builder.js")._internal;
        var weightWord = _ssbInt._stripItalicForWeightOnly(String(weight || ""));
        var lw = weightWord ? weightWord.toLowerCase() : "";
        if (weightWord && lw !== "regular" && lw !== "normal"
            && resolved.family === String(family) + " " + weightWord) return 2;
        if ((!weightWord || lw === "regular" || lw === "normal")
            && (resolved.family === String(family) + " Book"
                || resolved.family === String(family) + " Regular")) return 3;
    } catch (e) {}
    return 4;
}

function verifyDstFontScriptCoverage(byPairEntry, langScriptTable) {
    langScriptTable = langScriptTable || {};
    if (!byPairEntry || !byPairEntry.dstFont || !byPairEntry.dstWeight) {
        return _result(byPairEntry, {
            stage1Reject: true,
            message: "malformed byPair entry: dstFont/dstWeight required"
        });
    }

    // ---- Stage 1: installed-font check (hard; facade softens routing) ----
    // Single call, single resolution exit (arch 2026-08-12): checkDstFaceInstalled
    // is SHARED with the panel's missing-face warning (#28e gateProbeFace) — the
    // resolution must live inside it or the panel red-marks a mapping that the
    // gate would in fact apply (the two-readers-drift disease #34 exists to kill).
    var chk = checkDstFaceInstalled(byPairEntry.dstFont, byPairEntry.dstWeight);
    if (!chk.verifiable) {
        // Node test path — cannot verify installation; do not reject.
        return _stage2(byPairEntry, langScriptTable, null, true);
    }
    if (chk.error !== null) {
        return _result(byPairEntry, {
            stage1Reject: true,
            message: "dstFont lookup failed: " + chk.error
        });
    }
    if (!chk.installed) {
        return _result(byPairEntry, {
            stage1Reject: true,
            message: "dstFont not installed: " + byPairEntry.dstFont + "/" + byPairEntry.dstWeight
        });
    }
    var _out = _stage2(byPairEntry, langScriptTable, chk.fontObj, false);
    _out.resolvedDst = (chk.resolvedFont !== null)
        ? { font: chk.resolvedFont, weight: chk.resolvedWeight }
        : null;
    return _out;
}

// ---- Stage 2: target-language script hint (warning-only, never rejects) ----
function _stage2(entry, langScriptTable, fontObj, stage1Unverified) {
    // Guarded lookup (r17 iter7 P1): missing entry / lang_unsupported → unknown warning.
    // 8D-ext-D step-3a: use B2's lookupLangScriptEntry (proto-safe hasOwnProperty
    // + exact-only, per spec §2257) instead of a raw `langScriptTable[dstLang]`
    // index. entry.dstLang is already canonical — the facade (applyByPairSweep)
    // is the single normalize point for the apply path, so coverage trusts a
    // canonical key here and does NOT re-normalize (Node-test callers pass a
    // canonical dstLang directly).
    var tblEntry = require("./lang_script_table.js").lookupLangScriptEntry(entry.dstLang, langScriptTable);
    if (!tblEntry || tblEntry.lang_unsupported) {
        return _result(entry, {
            stage1Unverified: stage1Unverified,
            stage2Warning: true,
            warningType: "unknown",
            message: "unknown target script for lang=" + entry.dstLang +
                     (tblEntry && tblEntry.lang_unsupported ? " (lang_unsupported)" : " (no langScriptTable entry)")
        });
    }
    var required = tblEntry.required_scripts;
    if (!Array.isArray(required) || required.length === 0) {
        return _result(entry, { stage1Unverified: stage1Unverified }); // nothing to compare — no warning
    }

    var dstClasses = null;
    if (fontObj) {
        try { dstClasses = _writingScriptToClasses(fontObj.writingScript); } catch (eWs) {}
    }
    if (!dstClasses) {
        return _result(entry, {
            stage1Unverified: stage1Unverified,
            stage2Warning: true,
            warningType: "unknown",
            message: "dstFont writingScript unknown/unmapped for " + entry.dstFont
        });
    }

    // normalize(dstFont.writingScript) ⊇ required_scripts ?
    for (var i = 0; i < required.length; i++) {
        if (dstClasses.indexOf(required[i]) === -1) {
            return _result(entry, {
                stage1Unverified: stage1Unverified,
                stage2Warning: true,
                warningType: "mismatch",
                message: "dstFont " + entry.dstFont + " scripts [" + dstClasses.join(",") +
                         "] do not cover dstLang=" + entry.dstLang +
                         " required [" + required.join(",") + "]"
            });
        }
    }
    return _result(entry, { stage1Unverified: stage1Unverified }); // covered — no warning
}

module.exports = {
    verifyDstFontScriptCoverage: verifyDstFontScriptCoverage,
    checkDstFaceInstalled: checkDstFaceInstalled,   // #28e — shared with the panel warning; #34 — alias resolution lives inside
    _writingScriptToClasses: _writingScriptToClasses
};
