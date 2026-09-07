"use strict";

/**
 * lib/cjk_preference.js — 8D-ext-UNIFY-core piece 1 (brand-CJK injection)
 *
 * Pure, Node-testable helper that derives the CJK font preference chain to
 * inject into `ctx.fontPolicy.cjk.preference` so M4 rebuild lands the BRAND
 * CJK family (= the byPair CJK target) directly, instead of force-SHS
 * (the "M4+CJK no-op" root cause, findings.md:1593-1601).
 *
 * Spec: audit-logs/unify_design_r1.md §3.1 (REV gate-1 F3/F5; gate-3 isolated).
 *
 * Contract:
 *   buildCjkPreference(brandConfig, targetLang, projectedByPair)
 *     → [familyName, ...] | null
 *
 * Returns null (→ no injection → SHS fallback, byte-identical to today) when:
 *   - targetLang is not a CJK lang (F5: canonicalize before the CJK_LANG_SET test)
 *   - the projection yields ≥2 DISTINCT CJK dst families (F3: rebuild applies ONE
 *     family to all CJK clusters, so multiple would silently drop all but one)
 *   - no brand CJK family can be derived (no CJK projected rows AND no
 *     fonts_by_language entry for the canonical CJK target lang)
 *
 * Host-free by construction: no require("indesign"), no fs. The font INSTALL
 * check (host `app.fonts`) is the CALLER's job (the .idjs `_brandFontAvailable`
 * probe) — keeping F3/F5 unit-testable.
 */

var CJK_LANG_SET = require("./byPair_char_sweep.js").CJK_LANG_SET;
var normalizeBcp47Identity = require("./lang_script_table.js").normalizeBcp47Identity;
var DEFAULT_FONT_POLICY = require("./font_mapping.js").DEFAULT_FONT_POLICY;

function buildCjkPreference(brandConfig, targetLang, projectedByPair) {
    // F5: canonicalize the arg-derived lang BEFORE the CJK_LANG_SET test AND
    // the fonts_by_language lookup. Projected-row dstLang is already canonical
    // (font_mapping_pairs.js:310-312), so the row filter below is safe as-is.
    var canonTgt = normalizeBcp47Identity(targetLang);
    if (!CJK_LANG_SET[canonTgt]) return null;   // not a CJK target

    // F3: collect the effective CJK dst FAMILIES from every projected row whose
    // dstLang ∈ CJK_LANG_SET. ≥2 distinct → null (the rebuild applies ONE
    // family globally; multiple would silently drop all but one).
    var brandCjkFamily = null;
    var rows = projectedByPair || [];
    var seen = {};
    var distinct = 0;
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || !r.dstFont) continue;
        if (!CJK_LANG_SET[r.dstLang]) continue;
        if (!seen[r.dstFont]) {
            seen[r.dstFont] = true;
            distinct++;
            brandCjkFamily = r.dstFont;
        }
    }
    if (distinct >= 2) return null;             // multiple distinct CJK families

    // No CJK projected rows → fall back to the brand config's fonts_by_language
    // entry for the CANONICAL CJK target lang (F5: keyed by canonTgt).
    if (!brandCjkFamily) {
        var fbl = brandConfig && brandConfig.fonts_by_language;
        var list = fbl && fbl[canonTgt];
        if (Array.isArray(list) && list.length && list[0] && list[0].font) {
            brandCjkFamily = list[0].font;
        }
    }
    if (!brandCjkFamily) return null;

    // brand first, then the SHS/雅黑/苹方/SimSun chain as graceful fallback.
    return [brandCjkFamily].concat(DEFAULT_FONT_POLICY.cjk.preference);
}

module.exports = {
    buildCjkPreference: buildCjkPreference
};
