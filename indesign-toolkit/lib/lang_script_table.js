"use strict";

/**
 * lib/lang_script_table.js — Phase 8D-ext-B2 vendored minimal deliverable
 *
 * The langScriptTable + BCP-47 canonicalizer that 8D-ext-D's byPair paths
 * hard-consume (projection match + coverage Stage-2 + collision
 * disambiguator). Committed as NAMED EXPORTS so D's importer/facade can
 * `require` them (B2 fresh-verification-round A-class fix, 2026-06-10:
 * canonical-on-producer / raw-on-consumer asymmetry — D must canonicalize
 * BOTH sides of every lang comparison via normalizeBcp47Identity).
 *
 * This is the VENDORED MINIMAL slice — the data table + the two helpers D
 * needs. The full B2 scan engine (classifyFontScript / pickHomeLang /
 * identityAmbiguities, the empty-column auto-prompt) lands later as a
 * brand_config authoring aid; it is NOT a D runtime dependency.
 *
 * Public (named) API — per task_plan 8D-ext-B2 "两阶段架构":
 *   normalizeBcp47Identity(tag): string
 *     Pure key normalizer. NO table lookup. Returns canonical identity key
 *     (region dropped, script subtag preserved, Chinese shortcuts applied).
 *   lookupLangScriptEntry(identityKey, table): entry | undefined
 *     Exact-only table lookup (no strip-script fallback — that would silent-
 *     collide e.g. sr-Latn → sr's Cyrillic default). Caller passes an
 *     already-normalized key. undefined sentinel = lang_unsupported.
 *   LANG_SCRIPT_TABLE: { lang → { required_scripts: string[], lang_unsupported? } }
 *     Built-in minimal table, seeded with the project's real target langs
 *     (en/fr/es/de + zh-CN/zh-TW/zh-HK/ja/ko + th/ar — B2 verification-round
 *     P2#2/P2#3: es/de/ar added, zh-HK reconciled with D's CJK_LANG_SET).
 */

// required_scripts use the fine script-class vocabulary (han/kana/hangul/
// latin/thai/arabic/...). D's coverage compares these against a font's
// writingScript; D's disambiguator collapses them to coarse classes.
var LANG_SCRIPT_TABLE = {
    "en":    { required_scripts: ["latin"] },
    "fr":    { required_scripts: ["latin"] },
    "es":    { required_scripts: ["latin"] },
    "de":    { required_scripts: ["latin"] },
    "zh-CN": { required_scripts: ["han"] },
    "zh-TW": { required_scripts: ["han"] },
    "zh-HK": { required_scripts: ["han"] },
    "ja":    { required_scripts: ["han", "kana"] },
    "ko":    { required_scripts: ["hangul"] },  // codex B2-impl P2#1: spec 1449 = hangul-only (han 可选, require both 误排 hangul-only fonts)
    "th":    { required_scripts: ["thai"] },
    "ar":    { required_scripts: ["arabic"] }
};

// latn → Latn (BCP-47 script subtags are title-case).
function _titleCaseScript(s) {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function normalizeBcp47Identity(tag) {
    if (!tag || typeof tag !== "string") return "";
    var trimmed = tag.trim();  // codex B2-impl P2#2: leading/trailing ws → noncanonical key
    if (trimmed === "") return "";
    var subtags = trimmed.toLowerCase().split("-").filter(function (s) { return s.length > 0; });
    if (subtags.length === 0) return "";
    var lang = subtags[0];
    var rest = subtags.slice(1);

    // Stop at the first singleton subtag (x / u / t ...) — everything after
    // is an extension / private-use section, NOT script/region (fixture
    // ja-JP-x-priv must not read "priv" as a script).
    var coreRest = [];
    for (var i = 0; i < rest.length; i++) {
        if (rest[i].length === 1) break;
        coreRest.push(rest[i]);
    }

    // Detect script (4-char alpha) + region (2-char alpha or 3-digit) — both
    // needed so zh-Hant-HK keeps its HK region (codex B2-impl P1#1: a
    // script-only shortcut collapsed every Hant to zh-TW, silently losing
    // Hong Kong projections).
    var script = null, region = null;
    for (var j = 0; j < coreRest.length; j++) {
        var st = coreRest[j];
        if (!script && /^[a-z]{4}$/.test(st)) { script = st; continue; }
        if (!region && (/^[a-z]{2}$/.test(st) || /^[0-9]{3}$/.test(st))) { region = st; continue; }
    }

    // Chinese canonical shortcuts — script + region together.
    if (lang === "zh") {
        if (script === "hans") return "zh-CN";   // Simplified (CN/SG/...) unify → CN
        if (script === "hant") {
            // Traditional varies by region (TW/HK/MO). TW or unspecified
            // → zh-TW; HK → zh-HK. Other regions (MO/001/CN) keep the region:
            // "zh-Hant-" + REGION — a LOSSLESS conservative miss. The key has
            // no table entry → lookup returns undefined → lang_unsupported
            // (graceful skip), NOT a silent wrong-match onto zh-TW (codex
            // B2-impl iter1 P2). Region preservation makes this branch a
            // FIXPOINT: re-normalizing "zh-Hant-MO" re-parses script=hant
            // region=mo and lands here again unchanged — the previous
            // region-dropping form ("zh-Hant") was NOT idempotent (bare
            // zh-Hant → zh-TW below), so a facade re-normalize of producer
            // output silently rewrote the conservative miss into zh-TW
            // (step-3a audit P1).
            if (region === "hk") return "zh-HK";
            if (region === "tw" || !region) return "zh-TW";
            return "zh-Hant-" + region.toUpperCase();
        }
        if (!script) {
            // ASYMMETRY (deliberate): a SCRIPT subtag is authoritative across
            // regions — zh-Hans-SG → zh-CN, zh-Hant-MO → conservative miss
            // (above). But a region-ONLY Chinese tag is trusted for the three
            // mapped regions only; script-less zh-SG / zh-MO / zh-001 fall to
            // bare "zh" → lookup miss → lang_unsupported, rather than guessing
            // Simplified vs Traditional from region alone.
            if (region === "cn") return "zh-CN";
            if (region === "tw") return "zh-TW";
            if (region === "hk") return "zh-HK";  // B2 P2#3: reconcile w/ D CJK_LANG_SET
            return "zh"; // bare zh (no table entry → lang_unsupported)
        }
    }

    // Script subtag present → preserve as lossless identity key (lang-Script).
    if (script) return lang + "-" + _titleCaseScript(script);

    // No script → drop region → bare lang.
    return lang;
}

function lookupLangScriptEntry(identityKey, table) {
    if (!identityKey || !table) return undefined;
    // Exact-only. The key is assumed already canonicalized by
    // normalizeBcp47Identity; a strip-script fallback here would silent-
    // collide script-bearing identities onto their default-script entry.
    return Object.prototype.hasOwnProperty.call(table, identityKey)
        ? table[identityKey] : undefined;
}

module.exports = {
    LANG_SCRIPT_TABLE: LANG_SCRIPT_TABLE,
    normalizeBcp47Identity: normalizeBcp47Identity,
    lookupLangScriptEntry: lookupLangScriptEntry
};
