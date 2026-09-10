"use strict";

/**
 * faux_italic.js — italic-provenance helper (font-finding only).
 *
 * HISTORY: this module once centralized a "faux italic" skew subsystem (the #17
 * Y-model variant machinery: DEFAULT_SKEW / clampSkew / fauxItalicSkew /
 * resolveSkew / buildVariantSlotKey and per-slot variant authorization). That
 * subsystem was SCRAPPED — byPair never auto-skews from source italic, and the
 * faithful CJK-italic carriers live elsewhere (lib/style_applier.js per-run
 * skew=15, lib/style_sheet_builder.js paragraph skew=15, lib/italic_apply.js
 * Latin real-italic). Only the pure italic-provenance leaf survives here, used by
 * resolve_core.js's tier-3 upright-rematch to FIND the non-italic byPair member
 * (font-finding — it stamps NO skew).
 *
 * Pure: no InDesign objects are touched.
 */

/**
 * _detectItalicProvenance — pure leaf. Given a STYLE token (e.g. "Book Italic",
 * "Italic", "Bold"), decide whether the style is italic and, if so, what the
 * corresponding UPRIGHT weight token is (used by resolve's 3rd-tier rematch to
 * find the non-italic byPair member).
 *
 * Contract (spec §2):
 *  - Input is the STYLE token only — never the family — so a family literally
 *    named "… Italic Display" cannot false-positive (resolve passes
 *    t.sourceWeight = fs.style).
 *  - italic is detected when the token contains an italic-class WORD as a
 *    whitespace-delimited token, case-insensitive: italic / oblique / ital.
 *    (Combined no-space forms like "BookItalic" are NOT split — same coverage
 *    the code has today; documented v1 gap.)
 *  - upright = the token with the italic word(s) removed, remainder preserved
 *    verbatim (casing + spacing), collapsed/trimmed. Empty remainder → "Regular"
 *    (the canonical upright default; A bridges Regular↔Book downstream).
 *  - Non-italic input → { isItalic:false, upright:<style unchanged> }.
 *  - null / undefined / "" → { isItalic:false, upright:"Regular" } (defensive).
 *
 * @param {string} style style token (NOT the family)
 * @returns {{ isItalic: boolean, upright: string }}
 */
function _detectItalicProvenance(style) {
    if (style === undefined || style === null || style === "") {
        return { isItalic: false, upright: "Regular" };
    }
    var s = String(style);
    // Inner whitespace is collapsed to a single space deliberately: split on
    // /\s+/ here + join(" ") below normalizes a stray-space source ("Demi  Bold
    // Italic") toward the canonical pair member ("Demi Bold"). InDesign style
    // tokens are canonically single-space, so this maps onto — never away from —
    // the configured member. NOT a logic choice to revisit; canonical-normalize.
    var tokens = s.split(/\s+/);
    var kept = [];
    var foundItalic = false;
    for (var i = 0; i < tokens.length; i++) {
        var tok = tokens[i];
        if (tok === "") { continue; }
        if (/^(italic|oblique|ital)$/i.test(tok)) {
            foundItalic = true;
            continue;
        }
        kept.push(tok);
    }
    if (!foundItalic) {
        return { isItalic: false, upright: s };
    }
    var upright = kept.join(" ");
    if (upright === "") { upright = "Regular"; }
    return { isItalic: true, upright: upright };
}

module.exports = {
    _detectItalicProvenance: _detectItalicProvenance
};
