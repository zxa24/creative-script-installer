"use strict";

/**
 * lib/font_italic_probe.js — host-side SINGLE SOURCE OF TRUTH for the
 * faux-italic decision: "does this font family have a REAL italic / oblique
 * variant installed, and if so what is its exact installed style name?"
 *
 * WHY a shared leaf (root cause: fix-faux-latin-italic, 2026-06-15):
 *   The italic→faux-skew apply sites each decided independently whether to
 *   stamp skew=15:
 *     - v2_pipeline.js  BRIDGE-35 doc-wide italic→skew sweep (paragraph-gated)
 *     - v2_pipeline.js  BRIDGE-41 annotation restamp `italic`
 *     - v2_pipeline.js  link-uniform restyle (source-italic → skew)
 *     - style_applier.js direct-override `italic` annotation
 *     - style_sheet_builder.js  `_T_Latin_*` char-style builder
 *   Only the style_sheet_builder emphasis-pool builder gated on a real font
 *   probe; the rest blanket-stamped skew=15 on EVERY italic range in a
 *   CJK-containing context. So a mixed CJK+Latin paragraph had its Latin run
 *   (e.g. Whitney Book Italic — a font WITH a real italic variant) downgraded
 *   to upright + faux skew by the doc-wide sweep, overriding the byPair swap
 *   and emphasis CS that had it right. Centralizing the decision here makes
 *   every site agree: a CJK font (no italic variant) gets faux skew; a Latin
 *   font with a real italic keeps / gets real italic.
 *
 * RESOLUTION STRATEGY — itemByName-targeted, NOT full-catalog iteration
 * (univ-italic 2026-06-28, arch app-folio · supersedes the original scan):
 *   The original resolved a family's installed italic styles by ITERATING the
 *   whole font collection and reading each Font's fontFamily/fontStyleName. On
 *   app.fonts (the full installed catalog — 631 activated Adobe Fonts on the
 *   user's host) that iteration is a per-Font cross-bridge property read × N,
 *   runs SYNC on the V8 main thread, and FROZE InDesign uninterruptibly
 *   (CLAUDE.md gate #9) → the user had to force-restart (lost-work risk). It
 *   ALSO produced a host false-null: a real Font object does not report
 *   fontFamily/fontStyleName the way the Node mocks do, so the iteration missed
 *   an installed "Minion Pro Italic" and findExact returned null → a cfg-real
 *   Latin run was mis-classified BLOCK (rendered upright) — the exact mock↔host
 *   divergence host-verify exists to catch.
 *   FIX: resolve by CANONICAL `fonts.itemByName(family + "\t" + style).isValid`
 *   over a BOUNDED candidate set of style names. itemByName is a hash lookup —
 *   it never iterates the catalog (→ no gate-#9 freeze) and reads no Font
 *   properties (→ no host false-null; it matches on the canonical "Family\tStyle"
 *   name). TRADEOFF (documented, chosen by arch over the freeze): an italic face
 *   whose style name is spelled in an UNCOMMON way (an exotic weight word, an
 *   ALL-CAPS spelling, or a no-space form beyond the candidate list) won't be
 *   found — the prior substring/lowercase scan was case/spacing-tolerant but is
 *   forbidden (it is the freeze + the false-null source).
 *
 * Host-only: needs workDoc.fonts / app.fonts, but they are passed in at call
 * time and NEVER captured at module load, so this stays a Node-requirable leaf
 * (Node tests stub a plain { fonts: { length, item(i), itemByName(name) } }).
 * ES5 only (var / function declarations) for the UXP `new Function(source)`
 * syntax gate.
 *
 * Caching: per (mode, fontFamily, weightHint) — the installed catalog is stable
 * within a pass. Callers reset at the start of each commit/apply pass via
 * resetItalicProbeCache() so a freshly reopened doc never reads a stale result.
 */

// (mode\0family\0weightHint) -> resolved style name | null. Reset per pass.
var _resultCache = null;

function resetItalicProbeCache() { _resultCache = {}; }

/**
 * Extract a font family name from an appliedFont value that may be EITHER a
 * Font object (read `.fontFamily`) OR a string (CLAUDE.md gate #10:
 * `appliedFont` can resolve to a raw "Family\tStyle" string when the font
 * reference isn't a live Font object). Returns "" when neither yields a name.
 * Used so a string-form appliedFont doesn't read as empty-family and wrongly
 * trigger the neutralize fallback on a real-italic Latin run. [audit P3]
 *
 * @param {Font|string} appliedFont
 * @returns {string}
 */
function familyOf(appliedFont) {
    if (appliedFont == null) return "";
    if (typeof appliedFont === "string") {
        // Font canonical form is "Family\tStyle"; the family is before the tab.
        var tab = appliedFont.indexOf("\t");
        return tab === -1 ? appliedFont : appliedFont.slice(0, tab);
    }
    var fam = "";
    try { fam = String(appliedFont.fontFamily || ""); } catch (e) {}
    return fam;
}

/**
 * Collect the installed italic/oblique style names of a family from a font
 * collection by ITERATING it (substring match on the style name).
 *
 * ⚠️ NO LONGER ON THE RESOLUTION PATH (univ-italic 2026-06-28): iterating
 * app.fonts here is the gate-#9 freeze + host false-null source documented in
 * the file header — findExact/findItalic/probeFontHasItalic now resolve via
 * itemByName instead. Kept exported only as a small pure helper for tests /
 * diagnostics that want the raw shape; DO NOT call it on app.fonts in host code.
 *
 * @param {FontCollection|Array} fontColl
 * @param {string} fontFamily
 * @returns {string[]} matching style names (may be empty)
 */
function _collectItalicStyles(fontColl, fontFamily) {
    var out = [];
    if (!fontColl) return out;
    var len = 0;
    try { len = fontColl.length; } catch (eL) { return out; }
    for (var i = 0; i < len; i++) {
        try {
            var f = (typeof fontColl.item === "function") ? fontColl.item(i) : fontColl[i];
            if (!f) continue;
            var fam = "";
            try { fam = String(f.fontFamily); } catch (eFam) { continue; }
            if (fam !== fontFamily) continue;
            var st = "";
            try { st = String(f.fontStyleName || f.fontStyle || ""); } catch (eS) {}
            var lc = st.toLowerCase();
            if (lc.indexOf("italic") >= 0 || lc.indexOf("oblique") >= 0) out.push(st);
        } catch (eIt) {}
    }
    return out;
}

// Walk workDoc.parent up to the Application and return its `.fonts` collection
// (the full installed catalog), or null.
//
// ⚠️ UXP host objects are NEVER ===/!== comparable (every property access mints a
// fresh wrapper — CLAUDE.md "UXP host 对象不可 ===/!=="). The original fixed-point
// guard `app.parent !== app` therefore NEVER terminates on a real Application:
// `app.parent` keeps yielding a new wrapper, `!==` stays true, and each iteration
// allocates another wrapper → an infinite loop that ballooned InDesign to ~3 GB
// before host-verify caught it (Node tests stub plain objects whose `.parent`
// chain terminates, so they never reproduced it). Terminate by DEPTH CAP + a
// falsy-parent break instead of identity. Behaviour for Node stubs is unchanged
// (a parent-less stub → node falsy → returns null, same as before).
function _appFontsOf(workDoc) {
    try {
        var node = null;
        try { node = workDoc ? workDoc.parent : null; } catch (e0) { node = null; }
        for (var depth = 0; depth < 6 && node; depth++) {
            var parent = null;
            try { parent = node.parent; } catch (eP) {}
            if (!parent) break;          // reached the root (Application.parent is falsy)
            node = parent;               // climb; depth cap guarantees termination
        }
        if (node && node.fonts) return node.fonts;
    } catch (eApp) {}
    return null;
}

/**
 * Normalize a fontStyle token to a comparable weight: lowercase, drop the
 * italic/oblique words, collapse whitespace; map ""/"regular"/"roman" → ""
 * (the unweighted base). Combined no-space forms ("BookItalic") are NOT split
 * — same documented v1 gap as faux_italic._detectItalicProvenance; the font
 * catalog spells variants with a space, so this only matters for the hint.
 */
function _normWeight(s) {
    var w = String(s == null ? "" : s).toLowerCase()
        .replace(/\b(italic|oblique|ital)\b/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^\s+|\s+$/g, "");
    if (w === "regular" || w === "roman") w = "";
    return w;
}

// ── itemByName-targeted resolution (replaces the app.fonts full-scan) ──────

// Is "family\tstyle" INSTALLED in a font collection? itemByName is a canonical-
// name HASH LOOKUP — it never iterates the catalog (no gate-#9 freeze).
//
// ⚠️ The existence signal is `.status === FontStatus.INSTALLED`, NOT `.isValid`
// (host-verified 2026-06-28): on the host, `fonts.itemByName(name)` returns an
// ECHO SPECIFIER whose `.isValid` is ALWAYS true — true even for a bogus
// "Minion Pro\tZZ Italic" and for a bogus family — and whose `.fontStyleName`
// THROWS. Only `.status` discriminates: a real installed face → "INSTALLED",
// an absent one → "NOT_AVAILABLE". (This is also why the original false-null was
// not a bug: "Minion Pro Italic" is genuinely NOT installed on the host, so
// findExact correctly returned null; the isValid-based probe detection that
// "confirmed" it was installed was vacuous.) Compared as a string (tolerating a
// "FontStatus." prefix) so the leaf stays Node-requirable without the host enum.
function _faceExists(fontColl, family, style) {
    if (!fontColl || !family || !style) return false;
    try {
        var f = fontColl.itemByName(String(family) + "\t" + String(style));
        if (!f) return false;
        var s = "";
        try { s = String(f.status); } catch (eS) { return false; }
        return s.split(".").pop() === "INSTALLED";
    } catch (e) { return false; }
}

// Strip italic/oblique words from a style token, PRESERVING case (the canonical
// face name uses the font's own casing, e.g. "Book Italic"). "Book Italic" →
// "Book", "Regular" → "Regular", "" → "".
function _stripItalicWord(s) {
    return String(s == null ? "" : s)
        .replace(/(italic|oblique|ital)/gi, " ")
        .replace(/\s+/g, " ")
        .replace(/^\s+|\s+$/g, "");
}

// Ordered italic style-name candidates for a weight hint, WEIGHT-EXACT first
// then the unweighted ("Italic"/"Oblique") forms. Bounded — no catalog
// enumeration. Includes spaced + no-space variants ("Book Italic"/"BookItalic")
// to cover the documented no-space spelling gap. The caller decides exactness
// via _normWeight; this only orders the probe candidates.
function _italicCandidates(weightHint) {
    var base = _stripItalicWord(weightHint);
    var isReg = (base === "" || /^(regular|roman|normal)$/i.test(base));
    var cands = [];
    function push(x) { if (x && cands.indexOf(x) === -1) cands.push(x); }
    // 0) if the hint itself already spells an italic face, try it verbatim first
    if (weightHint && /(italic|oblique)/i.test(String(weightHint))) push(String(weightHint));
    // 1) weight-exact: "<base> Italic" / "<base> Oblique" (spaced + no-space)
    if (!isReg) {
        push(base + " Italic"); push(base + " Oblique");
        push(base + "Italic");  push(base + "Oblique");
    }
    // 2) unweighted (= the Regular-weight italic) — common spelling first
    push("Italic"); push("Oblique");
    // 2b) audit P1 fix: a regular-class hint spelled EXPLICITLY ("Regular"/"Normal"/
    // "Roman") may have a face literally named "Regular Italic" / "Normal Italic" in
    // some families. The isReg branch (step 1) skipped the weighted form, so a
    // configured-real Latin weight with such a face was falsely null → block →
    // upright. Probe it here (after the common bare "Italic"). base is "" only for a
    // truly-unweighted hint, which has no "<base> Italic" form, so it's excluded.
    if (isReg && base) {
        push(base + " Italic"); push(base + " Oblique");
        push(base + "Italic");  push(base + "Oblique");
    }
    return cands;
}

// Bounded common-weight italic style names for the weightless "any italic?"
// probe (probeFontHasItalic has no weight hint to derive candidates from).
// ~18 names × 2 collections = a few dozen itemByName hash lookups — fast, no
// freeze. An italic-bearing family almost always ships one of these; an exotic
// weight word outside the list is the documented tradeoff (see file header).
var _COMMON_ITALIC_STYLES = [
    "Italic", "Oblique",
    "Bold Italic", "Bold Oblique",
    "Book Italic", "Medium Italic", "Semibold Italic", "SemiBold Italic",
    "Light Italic", "Black Italic", "Regular Italic", "Semilight Italic",
    "Demi Italic", "Heavy Italic", "Thin Italic", "Extralight Italic",
    "Extrabold Italic", "Condensed Italic"
];

// Core resolver. mode:
//   "exact"   → return the WEIGHT-EXACT italic style name, else null.
//   "lenient" → weight-exact preferred, else the first unweighted italic, else null.
//   "any"     → any installed common-weight italic style name (truthiness probe), else null.
// Checks workDoc.fonts (doc-set, canonical) then app.fonts (installed catalog) —
// both via itemByName (no iteration, no property reads).
function _resolve(workDoc, fontFamily, weightHint, mode) {
    var docFonts = null;
    try { docFonts = workDoc ? workDoc.fonts : null; } catch (eD) { docFonts = null; }
    var appFonts = _appFontsOf(workDoc);
    function existsEither(style) {
        return _faceExists(docFonts, fontFamily, style) || _faceExists(appFonts, fontFamily, style);
    }
    if (mode === "any") {
        for (var k = 0; k < _COMMON_ITALIC_STYLES.length; k++) {
            if (existsEither(_COMMON_ITALIC_STYLES[k])) return _COMMON_ITALIC_STYLES[k];
        }
        return null;
    }
    var hint = _normWeight(weightHint);
    var cands = _italicCandidates(weightHint);
    var firstAny = null;
    for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        var isExact = (_normWeight(c) === hint);
        if (mode === "exact" && !isExact) continue;       // exact mode: only weight-exact candidates
        if (!existsEither(c)) continue;
        if (isExact) return c;                             // weight-exact installed face wins
        if (mode === "lenient" && firstAny === null) firstAny = c;  // remember first unweighted italic
    }
    return (mode === "lenient") ? firstAny : null;
}

function _resolveCached(workDoc, fontFamily, weightHint, mode) {
    if (!_resultCache) _resultCache = {};
    var key = mode + " " + String(fontFamily) + " " + String(weightHint == null ? "" : weightHint);
    if (Object.prototype.hasOwnProperty.call(_resultCache, key)) return _resultCache[key];
    var r = _resolve(workDoc, fontFamily, weightHint, mode);
    _resultCache[key] = r;
    return r;
}

/**
 * Does this font family have ANY italic-bearing variant? The faux-italic gate:
 * true → use real italic; false → faux skew. workDoc / fontFamily missing →
 * false (caller's legacy-safe default is faux skew, which never tofus a CJK
 * run at save).
 *
 * @param {Document} workDoc
 * @param {string} fontFamily
 * @returns {boolean}
 */
function probeFontHasItalic(workDoc, fontFamily) {
    if (!workDoc || !fontFamily) return false;
    return _resolveCached(workDoc, fontFamily, "", "any") !== null;
}

/**
 * Find the EXACT installed italic style name for a family that best matches a
 * weight hint, so the caller assigns a name InDesign will actually resolve
 * (fontStyle is spelling/case-sensitive — a guessed "Book Italic" the font
 * spells differently silently fails to apply). Returns null when the family
 * has no italic variant → caller falls back to faux skew.
 *
 * Matching priority:
 *   1. an italic style whose weight (italic words stripped) equals the hint's
 *   2. an unweighted italic ("Italic" / "Oblique")
 *
 * @param {Document} workDoc
 * @param {string}   fontFamily
 * @param {string}   [weightHint] e.g. current fontStyle "Book Italic" or "Book"
 * @returns {string|null}
 */
function findItalicStyleName(workDoc, fontFamily, weightHint) {
    if (!workDoc || !fontFamily) return null;
    return _resolveCached(workDoc, fontFamily, weightHint, "lenient");
}

/**
 * findExactItalicStyleName — like findItalicStyleName, but returns the installed
 * italic style name ONLY when it is WEIGHT-EXACT for `weightHint`; otherwise null.
 *
 * univ-italic contract R / OQ-2 (arch app-folio 2026-06-26): `findItalicStyleName`
 * silently falls back to an unweighted / first italic when the requested weight's
 * italic is absent — so it returns non-null even for "Book real" when only "Bold
 * Italic" is installed. The `cfg.real` realization MUST distinguish "has the
 * configured weight's real italic" (→ real) from "does not" (→ block, fail-closed),
 * so it needs the EXACT signal, not the lenient fallback.
 *
 * @returns {string|null} the weight-exact installed italic style name, or null.
 */
function findExactItalicStyleName(workDoc, fontFamily, weightHint) {
    if (!workDoc || !fontFamily) return null;
    return _resolveCached(workDoc, fontFamily, weightHint, "exact");
}

module.exports = {
    probeFontHasItalic:     probeFontHasItalic,
    findItalicStyleName:    findItalicStyleName,
    findExactItalicStyleName: findExactItalicStyleName,
    resetItalicProbeCache:  resetItalicProbeCache,
    familyOf:               familyOf,
    // exposed for unit tests / advanced callers
    _collectItalicStyles:   _collectItalicStyles,
    _normWeight:            _normWeight,
    _faceExists:            _faceExists,
    _italicCandidates:      _italicCandidates
};
