"use strict";

/**
 * lib/italic_apply.js — host-side SCRIPT-AWARE, CONFIG-GATED italic applier.
 *
 * The shared "make this span italic" primitive for the annotation / link sites:
 *   - style_applier.js  direct-override `italic` annotation
 *   - v2_pipeline.js    BRIDGE-41 annotation restamp `italic`
 *   - v2_pipeline.js    link-uniform restyle (source-italic → italic)
 *
 * univ-italic ② (乙 STRICT, 2026-06-28): italic realization is now operator-
 * config-gated, IDENTICAL to carrier #1 / ③ — the per-weight brand_config
 * (opts.italicConfig) decides HOW each (family, weight) subgroup slants. The
 * machine NEVER auto-slants an unconfigured weight (the old behavior — Latin
 * auto real italic / CJK + Latin-without-italic auto skew=15 — is removed).
 * It splits the span into CJK / non-CJK runs (lib/script_split.js), then
 * sub-splits each by homogeneous (family, fontStyle) and decides per subgroup:
 *   - configured faux        → range.skew = config angle (CJK + Latin)
 *   - configured real + exact → range.fontStyle = weight-exact installed italic
 *                               face (Latin only; CJK has no real italic) + skew 0
 *   - configured real + none  → BLOCK: upright, no slant, surfaced (fail-closed —
 *                               never fontStyle="Italic" on a font lacking it →
 *                               no save-time Missing Fonts dialog, CLAUDE.md #8)
 *   - unconfigured            → SURFACE: upright, no slant, surfaced (non-silent)
 *
 * This path stays DIRECT-OVERRIDE (not CS-body) deliberately: an `italic`
 * annotation composes with sibling direct-override annotations (color / underline
 * / bold) on the same range (style_applier.js "layer on top of each other"), and
 * the CS-body emphasis helper does clearOverrides() which would clobber those
 * siblings. clearOverrides survival is already handled by the BRIDGE-41 restamp.
 *
 * Host-coupled but app-free at LOAD: it receives DOM objects (a Characters
 * collection + a Document) as call args and never touches `app`/`require
 * ("indesign")` at module scope, so it stays a Node-requirable leaf (the
 * run_uxp_script bundler inlines the leaf requires below). ES5 only.
 */

var FIP = require("./font_italic_probe.js");
var ItalicConfig = require("./italic_config.js");
var _splitRunsByScript = require("./script_split.js").splitRunsByScript;

// Strip italic/oblique tokens → base weight, for the UPRIGHT literal this site writes.
//
// ⚠ Do NOT read this as "all four sites compute the same weight token". They do not,
// and they do not need to. Until TODO#26 (2026-08-12) this comment claimed exactly that
// ("matches carrier #1 / ③ normalization … contract K") — and it was FALSE: site ②③'s
// `_stripItalicToWeight` stripped only `Italic`, never `Oblique`. What actually holds is
// weaker and sufficient: every site hands its weight to `_ItalicConfig.lookup`, whose
// `_normWeight` folds italic AND oblique, so the sites agree on the RECORD they select
// even when their local tokens differ. Agreement lives in the lookup normaliser, not in
// these private helpers — which is why TODO#26 fixed the WRITE literal and left key
// derivation to `lookup`.
function _stripItForWeight(s) {
    return String(s || "")
        .replace(/\s*italic\s*/ig, " ")
        .replace(/\s*oblique\s*/ig, " ")
        .replace(/\s+/g, " ")
        .replace(/^\s+|\s+$/g, "");
}

function _pushItalicSurface(out, fam, weight, reason, isBlock) {
    if (!out.surfaced) out.surfaced = [];
    out.surfaced.push({ family: fam, weight: weight, reason: reason, block: !!isBlock });
    if (isBlock) out.blocked = (out.blocked || 0) + 1;
}

// Per-character homogeneity key = family + TAB + fontStyle (object|string-aware
// family — see FIP.familyOf / CLAUDE.md gate #10). A non-CJK script run is split
// wherever this key changes, so each sub-group is uniform in BOTH family AND
// weight — otherwise one weight's italic name (e.g. "Book Italic") would be
// stamped onto a different weight in the same family ("Bold" → wrong weight).
// TAB is a safe separator: font.name itself uses tab as the family/style
// delimiter, so neither sub-part can contain one. "" on read failure.
function _fontKeyAtChar(cc, idx) {
    try {
        var ch = cc.item(idx);
        var fam = FIP.familyOf(ch.appliedFont);
        var st = "";
        try { st = String(ch.fontStyle || ""); } catch (eS) {}
        return fam + "\t" + st;
    } catch (e) { return ""; }
}

// Realize italic on [gs, ge] of cc (homogeneous in family+style) by the operator
// config (乙-strict), IDENTICAL decision model to carrier #1 / ③. The caller
// guarantees [gs, ge] is one (family, fontStyle) subgroup, so reading family/style
// off the FIRST CHARACTER is reliable (a multi-char range's appliedFont is a lazily
// range-resolved Font whose .fontFamily reads "" on the host — the single-char read
// is the host-verified reliable form; see carrier #1 _applyOneEmphasisSubRun).
//   isCJK=true  → CJK has NO real italic; never probe (no tofu, no wasted itemByName).
//   isCJK=false → probe the WEIGHT-EXACT installed italic (OQ-2) for the real branch.
function _realizeItalicSubgroup(cc, gs, ge, isCJK, workDoc, italicConfig, out) {
    var sub;
    try { sub = cc.itemByRange(gs, ge); } catch (eR) { return; }
    var fam = "";
    try { fam = FIP.familyOf(cc.item(gs).appliedFont); } catch (eF) {}
    // Key on the RESOLVED installed face style (live appliedFont), NOT the requested
    // char.fontStyle (audit P1 fix). Carrier #1 / ③ key on the resolved face; a font
    // whose regular-class face is named "Normal"/"Book" reads "Regular" via
    // char.fontStyle but resolves to "Normal"/"Book" — so char.fontStyle keyed a
    // DIFFERENT italic_by_weight entry than the emphasis path for the same (family,
    // weight). Reading the live appliedFont is scan-free (no _resolveInstalledFaceCaseTolerant
    // → no cold-miss app.fonts scan). Falls back to char.fontStyle if appliedFont unreadable.
    var cur = "";
    try {
        var _af = cc.item(gs).appliedFont;
        if (_af && typeof _af === "object" && _af.fontStyle) cur = String(_af.fontStyle);
        else if (_af && _af.name && String(_af.name).indexOf("\t") >= 0) cur = String(_af.name).split("\t")[1];
        else if (typeof _af === "string" && String(_af).indexOf("\t") >= 0) cur = String(_af).split("\t")[1];
    } catch (eAf) {}
    if (!cur) { try { cur = String(cc.item(gs).fontStyle || ""); } catch (eC) {} }
    var baseW = _stripItForWeight(cur) || "Regular";
    var cfg = ItalicConfig.lookup(italicConfig || null, fam, baseW);
    // CJK never has a real italic face → pass hasReal=false WITHOUT probing (a CJK
    // family probe wastes itemByName calls and can only return null anyway).
    var exactIt = null;
    if (!isCJK && fam) { try { exactIt = FIP.findExactItalicStyleName(workDoc, fam, baseW); } catch (eP) {} }
    // Already-on-a-real-italic-face: the live char's own style says italic AND this
    // weight has that exact face. CJK is excluded by construction (exactIt stays
    // null, and a CJK family has no italic face to keep). Unconfigured + already
    // italic → leave it exactly as the document has it.
    var _wasItalic = /italic|oblique/i.test(String(cur || ""));
    var dec = ItalicConfig.resolveItalicRealization(cfg, !!exactIt, !!exactIt && _wasItalic);
    if (dec.kind === "faux") {
        try {
            try { sub.fontStyle = baseW; } catch (eFS) {}   // upright weight (idempotent: strip any stale italic)
            sub.skew = dec.angle; out.skewRuns++; out.ok = true;
        } catch (eF2) {}
    } else if (dec.kind === "real" || dec.kind === "keep") {
        try {
            sub.fontStyle = exactIt;
            try { sub.skew = 0; } catch (eZ) {}
            out.realRuns++; out.ok = true;
        } catch (eN) {
            // installed-name still didn't take → leave upright + surface (NO faux fallback:
            // 乙-strict never auto-slants).
            try { sub.skew = 0; } catch (eZ2) {}
            _pushItalicSurface(out, fam, baseW, "real_apply_failed", false); out.ok = true;
        }
    } else if (dec.kind === "block") {
        // configured real but no weight-exact italic → upright, fail-closed. Reset
        // fontStyle to the upright weight too (audit P1): clearing only skew would
        // leave a real italic face from a prior run / config change still slanted.
        try { sub.fontStyle = baseW; } catch (eFB) {}
        try { sub.skew = 0; } catch (eZ3) {}
        _pushItalicSurface(out, fam, baseW, dec.reason, true); out.ok = true;
    } else {
        // unconfigured (surface) → upright, no slant, non-silent. Reset fontStyle to
        // upright too (audit P1) so a prior-run real italic face doesn't persist.
        try { sub.fontStyle = baseW; } catch (eFS2) {}
        try { sub.skew = 0; } catch (eZ4) {}
        _pushItalicSurface(out, fam, baseW, dec.reason, false); out.ok = true;
    }
}

/**
 * Apply config-gated script-aware italic over [baseOffset, endOffset] (inclusive)
 * of a Characters collection (乙 STRICT — see file header).
 *
 * @param {Object} opts
 *   - charContainer {Characters}  e.g. para.characters or cell.texts[x].characters
 *   - baseOffset    {number}      container-relative start index
 *   - endOffset     {number}      container-relative end index (inclusive)
 *   - workDoc       {Document}    for the weight-exact installed-italic probe (real branch)
 *   - italicConfig  {Object}      per-weight brand_config (italic_by_weight); null →
 *                                 everything unconfigured → surface (no slant)
 * @returns {{ ok, realRuns, skewRuns, desync, surfaced?, blocked? }}
 *   surfaced[] = { family, weight, reason, block } for unconfigured / blocked /
 *   desync subgroups (乙-strict "surface 非静默").
 */
function applyScriptAwareItalic(opts) {
    opts = opts || {};
    var cc = opts.charContainer;
    var base = opts.baseOffset;
    var end = opts.endOffset;
    var workDoc = opts.workDoc;
    var italicConfig = opts.italicConfig || null;

    var out = { ok: false, realRuns: 0, skewRuns: 0, desync: false };
    if (!cc || typeof base !== "number" || typeof end !== "number" || end < base) return out;

    var contents = "";
    try { contents = String(cc.itemByRange(base, end).contents || ""); } catch (e) { return out; }

    // Offset-alignment guard (mirrors font_mapping_apply_to_doc): the per-run
    // sub-ranges assume contents is 1:1 with character offsets. UXP tag-ifies some
    // markers (CLAUDE.md gate #1) and supplementary-plane chars are 2 code units —
    // either desyncs offsets. 乙-strict + contract Q: FAIL-CLOSED — do NOT write at
    // untrusted positions, do NOT auto-slant; surface the skip so it's non-silent
    // (the old code auto-skewed the whole span here — an unconfigured auto-slant).
    var expected = end - base + 1;
    if (contents.length !== expected) {
        out.desync = true;
        _pushItalicSurface(out, "", "", "offset_desync_skipped", false);
        return out;
    }

    var runs = _splitRunsByScript(contents);
    for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        var s = base + r.startOffset;
        var e = s + r.len - 1;
        if (e < s) continue;

        // Sub-split EACH script run by homogeneous (family, fontStyle) so the config
        // lookup + weight-exact real-italic resolution is per subgroup — never stamp
        // one family/weight's italic face onto a different one, and never apply one
        // weight's config angle to another (CJK config is also per-weight). CJK runs
        // are sub-split too now (the config decision is family/weight-specific).
        var gs = s;
        var gKey = _fontKeyAtChar(cc, s);
        for (var j = s + 1; j <= e; j++) {
            var kj = _fontKeyAtChar(cc, j);
            if (kj !== gKey) {
                _realizeItalicSubgroup(cc, gs, j - 1, r.isCJK, workDoc, italicConfig, out);
                gs = j;
                gKey = kj;
            }
        }
        _realizeItalicSubgroup(cc, gs, e, r.isCJK, workDoc, italicConfig, out);
    }
    return out;
}

module.exports = {
    applyScriptAwareItalic: applyScriptAwareItalic,
    // TODO#26: exported READ-ONLY so the cross-site agreement test can compare the
    // REAL site-④ helper against site ②'s, instead of a transcribed copy (a test that
    // re-implements the thing it checks proves nothing). No production caller uses this.
    _internal: { _stripItForWeight: _stripItForWeight }
};
