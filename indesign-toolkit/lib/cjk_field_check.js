"use strict";

// cjk_field_check.js — pure (non-host) predicates for verifying a donor
// paragraph style actually CARRIES CJK (kinsoku) configuration after import.
//
// Why: importStyles imports a named style but rebases its BasedOn to the target
// doc's Latin [No paragraph style], so any CJK config the donor only INHERITED
// from the source root is silently dropped. The donor CJK.idml is authored to
// self-define its CJK fields locally so the config survives import; this guard
// turns the otherwise-silent "merged N/0/0 but every field empty" failure LOUD
// if a future template edit reintroduces root inheritance.
//
// Kinsoku effectiveness requires BOTH a configured kinsokuSet AND a CJK-capable
// composer (the Latin composers ignore kinsokuSet), so the verdict gates on both.
//
// See findings.md#style-and-font (importStyles drops root-inherited config) and
// cjk_style_apply.idjs #CJK-IMPORT-GUARD.

// Normalize a raw InDesign style-field value (object-with-.name / enum / string
// / null) to a comparable string, or null. Mirrors probes/__probe_cjk_fields.idjs.
function normalizeFieldValue(v) {
    if (v === null || typeof v === "undefined") {
        return null;
    }
    if (typeof v === "object") {
        var n = null;
        try { n = v.name; } catch (e0) {}
        if (n === null || typeof n === "undefined") {
            return String(v);
        }
        return String(n);
    }
    return String(v);
}

// "Nothing"/empty sentinels that mean a field carries no real value.
function isEmptyOrNothing(normalized) {
    if (normalized === null || typeof normalized === "undefined") {
        return true;
    }
    var s = String(normalized).trim();
    if (s === "") {
        return true;
    }
    var low = s.toLowerCase();
    if (low === "null" || low === "undefined") {
        return true;
    }
    // KinsokuTable/MojikumiTable "Nothing", enum "NOTHING", "$ID/Nothing", etc.
    if (low === "nothing" || low === "$id/nothing") {
        return true;
    }
    return false;
}

// kinsokuSet is the authoritative gate: per Adobe DOM, kinsokuType only takes
// effect when kinsokuSet is defined. Returns true if kinsoku IS configured.
function isKinsokuConfigured(rawKinsokuSet) {
    return !isEmptyOrNothing(normalizeFieldValue(rawKinsokuSet));
}

// Chinese kinsoku line-break rules only execute under a CJK-capable composer;
// the Latin composers ignore kinsokuSet entirely. Returns true if the composer
// will honor kinsoku. CJK-capable: Japanese / World-Ready / "HL Composer J" etc.
function composerSupportsKinsoku(rawComposer) {
    var normalized = normalizeFieldValue(rawComposer);
    if (isEmptyOrNothing(normalized)) {
        return false;
    }
    var low = String(normalized).trim().toLowerCase();
    if (low === "adobe paragraph composer" || low === "adobe single-line composer") {
        return false;
    }
    return true;
}

// Given a map of raw CJK field values read from the imported donor style,
// decide whether the import looks BROKEN (lost its kinsoku config). Returns a
// structured verdict for loud logging.
function diagnoseCjkImport(rawFields) {
    rawFields = rawFields || {};
    var kinsokuOk = isKinsokuConfigured(rawFields.kinsokuSet);
    var composerOk = composerSupportsKinsoku(rawFields.composer);
    return {
        broken: !kinsokuOk || !composerOk,
        composerOk: composerOk,
        kinsokuSet: normalizeFieldValue(rawFields.kinsokuSet),
        composer: normalizeFieldValue(rawFields.composer),
        appliedLanguage: normalizeFieldValue(rawFields.appliedLanguage),
        mojikumi: normalizeFieldValue(rawFields.mojikumi)
    };
}

module.exports = {
    normalizeFieldValue: normalizeFieldValue,
    isEmptyOrNothing: isEmptyOrNothing,
    isKinsokuConfigured: isKinsokuConfigured,
    composerSupportsKinsoku: composerSupportsKinsoku,
    diagnoseCjkImport: diagnoseCjkImport
};
