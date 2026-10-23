"use strict";

/**
 * lib/font_name_identity.js — byPair fix F1 (arch 2026-09-30; app-folio
 * design-intent §8 "P2b exception": two NAMES of ONE physical font are the same
 * font — aligning them is not a substitution).
 *
 * The brand config says "Dax Pro"; the document says "Dax Pro (OTF)". Host
 * 2026-09-30: for Light / Regular / Medium / Bold both names are INSTALLED, report
 * the same PostScript name (DaxPro-Light / DaxPro / DaxPro-Medium / DaxPro-Bold) and
 * point at the same file. The byPair sweep matched by name only, so the first scan
 * paired nothing (swapped=0) and everything fell to the P2c corrective pass.
 *
 * Rule (arch): a config face and a document face of the same style are aliased
 * ONLY when both resolve to the SAME PostScript name, that name is a real answer
 * (font_identity_groups.looksLikeAnAnswer — not "" and not a degenerate "_-"), and
 * at least one side is INSTALLED. ⛔ No string surgery on the family name ("drop
 * the (OTF) suffix"), ⛔ no isValid as evidence (itemByName returns valid objects
 * for fonts that do not exist — CLAUDE.md #24, measured again 2026-09-30).
 * Anything that cannot be resolved is reported, never guessed.
 *
 * Pure: planNameAliases, applyAliasesToByPair. The identity lookup is injected
 * (host: font_mapping_doc_scan.makeIdentityLookup — single-point itemByName,
 * memoized, never enumerates app.fonts).
 */

var FIG = require("./font_identity_groups.js");

function _installed(id) { return !!id && /INSTALLED/.test(String(id.status || "")); }
function _ps(id) { return (id && id.postscriptName) ? String(id.postscriptName) : ""; }

function _uniqFaces(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (f) {
        if (!f || !f.family || !f.style) return;
        var k = f.family + "|" + f.style;
        if (seen[k]) return;
        seen[k] = true; out.push({ family: String(f.family), style: String(f.style) });
    });
    return out;
}

/**
 * planNameAliases(configFaces, docFaces, identityOf)
 *   configFaces / docFaces = [{ family, style }]
 *   identityOf(family, style) -> { status, postscriptName } | null   (may throw)
 * -> { aliases:  [{ configFamily, docFamily, style, postscriptName, installed: "both"|"config"|"document" }],
 *      rejected: [{ configFamily, docFamily, style, reason }] }
 * Only document faces that are NOT already spelled like a config face are examined
 * (a direct name match needs nothing), and only against config faces of the same style.
 */
function planNameAliases(configFaces, docFaces, identityOf) {
    var cfg = _uniqFaces(configFaces), doc = _uniqFaces(docFaces);
    var cfgKeys = {};
    cfg.forEach(function (c) { cfgKeys[c.family + "|" + c.style] = true; });
    var aliases = [], rejected = [];
    function idOf(fam, sty) { try { return identityOf(fam, sty); } catch (e) { return null; } }
    doc.forEach(function (d) {
        if (cfgKeys[d.family + "|" + d.style]) return;                    // already matches by name
        cfg.forEach(function (c) {
            if (c.style !== d.style || c.family === d.family) return;
            var ic = idOf(c.family, c.style), id = idOf(d.family, d.style);
            var pc = _ps(ic), pd = _ps(id);
            var why = null;
            if (!FIG._looksLikeAnAnswer(pc) || !FIG._looksLikeAnAnswer(pd)) why = "no usable PostScript name (config \"" + pc + "\", document \"" + pd + "\")";
            else if (pc !== pd) return;                                   // simply different fonts — not a candidate
            else if (!_installed(ic) && !_installed(id)) why = "same PostScript name but neither side is INSTALLED";
            if (why) { rejected.push({ configFamily: c.family, docFamily: d.family, style: d.style, reason: why }); return; }
            aliases.push({ configFamily: c.family, docFamily: d.family, style: d.style, postscriptName: pc,
                           installed: _installed(ic) && _installed(id) ? "both" : (_installed(ic) ? "config" : "document") });
        });
    });
    return { aliases: aliases, rejected: rejected };
}

/**
 * applyAliasesToByPair(byPair, aliases) -> byPair + one extra row per aliased
 * source face: the same row (same pairingId, same target) with srcFont = the
 * document's spelling, so a range reported under that spelling matches it. The
 * original rows stay. The extra row buckets under its own srcFont|srcWeight, so the
 * MM fan-out invariant (distinct source keys per pairingId) is kept.
 */
function applyAliasesToByPair(byPair, aliases) {
    var out = (byPair || []).slice();
    (aliases || []).forEach(function (a) {
        (byPair || []).forEach(function (e) {
            if (!e || e.srcFont !== a.configFamily || e.srcWeight !== a.style) return;
            var c = {};
            for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) c[k] = e[k];
            c.srcFont = a.docFamily;
            c.aliasOf = a.configFamily;
            c.aliasPostscriptName = a.postscriptName;
            out.push(c);
        });
    });
    return out;
}

/**
 * withNameIdentity(lookup, configFaces, identityOf) -> lookup'
 * The SAME rule for the other consumer of the pair table: the style builder's
 * paragraph-style CJK weight (style_sheet_builder: cjkPairWeightLookup(srcFam,
 * srcStyle)). Host 2026-10-01 (dev data): that lookup got the DOCUMENT spelling
 * "Dax Pro (OTF)", never matched the config's "Dax Pro" (cluster_report
 * cjk_weight_resolution.fromPair = 0 in every run), and fell back to the source
 * weight NAME — Dax Bold → MHeiHK Bold where the pair says Xbold; Dax Medium →
 * MHeiHK Medium where the pair says Bold.
 * On a miss, retry under a config family proven to be the same physical font
 * (planNameAliases — the one identity rule; no string surgery). lookup'.aliasesUsed
 * lists every alias that produced a hit (for the report); lookup'.rejected the
 * candidates that could not be proven.
 */
function withNameIdentity(lookup, configFaces, identityOf) {
    var cache = {}, used = [], usedKeys = {}, rejected = [], rejKeys = {};
    var wrapped = function (srcFont, srcStyle) {
        var hit = lookup(srcFont, srcStyle);
        if (hit || !srcFont) return hit;
        var k = String(srcFont) + "\t" + String(srcStyle);
        if (Object.prototype.hasOwnProperty.call(cache, k)) return cache[k];
        var plan = planNameAliases(configFaces, [{ family: srcFont, style: srcStyle == null ? "Regular" : srcStyle }], identityOf);
        var r = null;
        for (var i = 0; i < plan.aliases.length && !r; i++) {
            r = lookup(plan.aliases[i].configFamily, srcStyle) || null;
            if (r) {
                var uk = plan.aliases[i].configFamily + "|" + plan.aliases[i].docFamily + "|" + plan.aliases[i].style;
                if (!usedKeys[uk]) { usedKeys[uk] = true; used.push(plan.aliases[i]); }
            }
        }
        plan.rejected.forEach(function (x) {
            var rk = x.configFamily + "|" + x.docFamily + "|" + x.style;
            if (!rejKeys[rk]) { rejKeys[rk] = true; rejected.push(x); }
        });
        cache[k] = r;
        return r;
    };
    wrapped.aliasesUsed = used;
    wrapped.rejected = rejected;
    return wrapped;
}

/**
 * configFamilyFor(configFaces, family, style, identityOf) -> { family, alias, rejected }
 * For tools that look a font up in the brand config BY NAME (set_selection_weight:
 * langsOf / rosterOf / makeCjkWeightLookup). A family the config already lists is
 * returned unchanged. Otherwise it is replaced ONLY when exactly one config family
 * is proven the same physical font (planNameAliases); none or several ⇒ unchanged,
 * so the caller's existing "not in brand_config" stays loud instead of guessing.
 */
function configFamilyFor(configFaces, family, style, identityOf) {
    var faces = _uniqFaces(configFaces);
    for (var i = 0; i < faces.length; i++) if (faces[i].family === family) return { family: family, alias: null, rejected: [] };
    var plan = planNameAliases(faces, [{ family: family, style: style || "Regular" }], identityOf);
    var fams = {};
    plan.aliases.forEach(function (a) { fams[a.configFamily] = a; });
    var keys = Object.keys(fams);
    if (keys.length === 1) return { family: keys[0], alias: fams[keys[0]], rejected: plan.rejected };
    return { family: family, alias: null, rejected: plan.rejected, ambiguous: keys.length > 1 ? keys : undefined };
}

module.exports = { planNameAliases: planNameAliases, applyAliasesToByPair: applyAliasesToByPair, withNameIdentity: withNameIdentity, configFamilyFor: configFamilyFor };
