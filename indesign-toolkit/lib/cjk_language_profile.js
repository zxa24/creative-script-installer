"use strict";

// cjk_language_profile.js
// Per-target-language kinsoku / mojikumi overrides for cjk_style_apply.
//
// lib/CJK.idml carries ONE donor style (CJK_Simplified_Chinese). Its kinsoku
// set and mojikumi table are Simplified-Chinese; applied unchanged to a
// Traditional-Chinese / Japanese / Korean document they give the wrong
// line-breaking rules. This table overrides just those two fields on the
// imported donor before it is merged into the target styles.
//
// WHERE the override is written matters (TODO #118, host-verified 2026-09-29):
// a kinsokuSet / mojikumi assignment only takes effect if the document already
// holds that kinsoku / mojikumi table. CJK.idml holds all of them; a target
// document usually holds only what the imported donor dragged in (the SC ones).
// So the caller writes the override on the donor INSIDE the donor document,
// saves it as a carrier .indd, and imports from that — the table travels with
// the style. Writing it on the donor after import is a silent no-op.
//
// Values are enum NAMES (KinsokuSet / MojikumiTableDefaults), resolved against
// require("indesign") by the caller — keeps this module pure + unit-testable.
//
// appliedLanguage is NOT overridden: on a Roman-build InDesign the CJK
// languages are absent from app.languagesWithVendors and a string assignment
// throws (findings.md#cjk-language-tag-unsettable-on-roman-build).
//
// 2026-09-22 (Client-A DocX-2):
//   ko mojikumi NOTHING — MojikumiTableDefaults has no Korean table (only
//     JIS presets + TRAD/SIMP_CHINESE_DEFAULT; indesign-18-dom docs).
//   ja mojikumi LINE_END_ALL_ONE_HALF_EM_ENUM (行末約物半角) — owner-confirmed
//     2026-09-22 (no primary source states the Japanese-build default; this is
//     the owner's choice, not a verified platform default).
//   ko: owner decision — Korean needs NO Hangul↔Roman aki (mojikumi stays
//     NOTHING; a 1/4-em Hangul→digit/letter GREP aki was tried and reverted).

var PROFILES = {
    "zh-CN": null, // donor as-is
    "zh-HK": { kinsokuSet: "TRADITIONAL_CHINESE_KINSOKU", mojikumi: "TRAD_CHINESE_DEFAULT" },
    "zh-TW": { kinsokuSet: "TRADITIONAL_CHINESE_KINSOKU", mojikumi: "TRAD_CHINESE_DEFAULT" },
    "ja":    { kinsokuSet: "HARD_KINSOKU", mojikumi: "LINE_END_ALL_ONE_HALF_EM_ENUM" },
    "ko":    { kinsokuSet: "KOREAN_KINSOKU", mojikumi: "NOTHING" }
};

var LANGUAGES = ["zh-CN", "zh-HK", "zh-TW", "ja", "ko"];

// Returns { known: bool, profile: {kinsokuSet, mojikumi} | null }.
// Unknown language => known:false so the caller can say so instead of
// silently falling back to Simplified-Chinese rules.
function resolve(lang) {
    var key = String(lang || "zh-CN");
    if (!Object.prototype.hasOwnProperty.call(PROFILES, key)) return { known: false, profile: null };
    return { known: true, profile: PROFILES[key] };
}

// Did the profile actually land? ksBack / mjBack are the normalized read-back
// values (enum names). InDesign accepts a kinsokuSet / mojikumi assignment
// WITHOUT error and silently keeps the old value when the document has no
// matching kinsoku / mojikumi table (TODO #118) — so only a read-back proves it.
// A null profile (zh-CN: donor as-is) has nothing to check.
function readBackMatches(profile, ksBack, mjBack) {
    if (!profile) return true;
    return String(ksBack).indexOf(profile.kinsokuSet) >= 0
        && String(mjBack).indexOf(profile.mojikumi) >= 0;
}

// Value to ASSIGN for an enum NAME. Host-verified 2026-09-29 (TODO #118):
// MojikumiTableDefaults.NOTHING exists (an object printing "NOTHING") but
// assigning it is silently ignored — the style keeps SIMP_CHINESE_DEFAULT, so
// ko never had its mojikumi cleared — while the STRING "NOTHING" clears it.
// So "NOTHING" is assigned as a string; everything else as the enum member
// (or the name string when the enum lacks it).
function enumOrName(enumObj, name) {
    if (String(name) === "NOTHING") return "NOTHING";
    var v;
    try { v = enumObj ? enumObj[name] : undefined; } catch (e) { v = undefined; }
    return (v === undefined || v === null) ? String(name) : v;
}

// Safe file-name fragment for the per-language donor carrier (.indd).
function donorFileTag(lang) {
    return String(lang || "zh-CN").replace(/[^A-Za-z0-9_-]/g, "_");
}

// ── #148 (owner 2026-10-19, option A): the dropdown starts at the document's own target language.
// normalizeLanguage maps the spellings that occur in labels / _meta.json to a LANGUAGES entry or
// null (unknown language: the caller says so and falls back to zh-CN, never silently).
function normalizeLanguage(raw) {
    if (raw === null || raw === undefined) return null;
    var k = String(raw).replace(/^\s+|\s+$/g, "").replace(/_/g, "-").toLowerCase();
    if (!k) return null;
    if (k === "zh-cn" || k === "zh-hans" || k === "zh-hans-cn" || k === "zh" || k === "zh-sg" || k === "zh-hans-sg") return "zh-CN";
    if (k === "zh-hk" || k === "zh-hant-hk" || k === "zh-mo" || k === "zh-hant-mo") return "zh-HK";
    if (k === "zh-tw" || k === "zh-hant-tw" || k === "zh-hant") return "zh-TW";
    if (k === "ja" || k.indexOf("ja-") === 0) return "ja";
    if (k === "ko" || k.indexOf("ko-") === 0) return "ko";
    return null;
}

// defaultFromLabels({ projectMeta, packageSeq }) → { lang, source, raw, known, note }
//   projectMeta : the parsed project_meta_v1 label (written by every import; .target_language)
//   packageSeq  : the parsed package_seq_v1 label (written when the package carried a prefix; .target_language)
//   written     : the parsed import_written_paragraphs_v1 label (every import; .lang = the language the import ran for;
//                 host 2026-10-20: an automated import without _meta.json writes neither of the two labels above)
// The first label whose language is one of LANGUAGES wins. Anything else ⇒ zh-CN with
// source "default" and a note saying why, so the dialog can show that it is a default.
function defaultFromLabels(o) {
    o = o || {};
    var cands = [
        { source: "import record (project_meta)", raw: o.projectMeta && o.projectMeta.target_language },
        { source: "import record (package sequence)", raw: o.packageSeq && o.packageSeq.target_language },
        { source: "import record (target language of the last import)", raw: o.written && o.written.lang }
    ];
    var seenUnknown = null;
    for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (c.raw === null || c.raw === undefined || String(c.raw).replace(/\s+/g, "") === "") continue;
        var n = normalizeLanguage(c.raw);
        if (n) return { lang: n, source: c.source, raw: String(c.raw), known: true, note: "" };
        if (!seenUnknown) seenUnknown = { raw: String(c.raw), source: c.source };
    }
    return {
        lang: "zh-CN", source: "default", raw: seenUnknown ? seenUnknown.raw : null, known: false,
        note: seenUnknown
            ? "The target language recorded in this document (" + seenUnknown.raw + ") is not in this list."
            : "No target language is recorded in this document."
    };
}

module.exports = {
    normalizeLanguage: normalizeLanguage,
    defaultFromLabels: defaultFromLabels,
    PROFILES: PROFILES,
    LANGUAGES: LANGUAGES,
    resolve: resolve,
    readBackMatches: readBackMatches,
    enumOrName: enumOrName,
    donorFileTag: donorFileTag
};
