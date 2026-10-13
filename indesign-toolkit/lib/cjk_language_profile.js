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
// 2026-09-22 (Client-A 26-0955):
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

module.exports = {
    PROFILES: PROFILES,
    LANGUAGES: LANGUAGES,
    resolve: resolve,
    readBackMatches: readBackMatches,
    enumOrName: enumOrName,
    donorFileTag: donorFileTag
};
