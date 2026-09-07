"use strict";

/**
 * lib/font_face_missing.js — #28e face-level "this mapping will be skipped"
 * precompute for the font-mapping panel.
 *
 * WHAT THE WARNING PREDICTS: not "does this font exist in reality" but "will
 * the apply pipeline skip the mappings that use this face". The authority on
 * skipping is the byPair Stage-1 gate, so the predicate here IS that gate's
 * own function (byPair_script_coverage.checkDstFaceInstalled) — panel and
 * pipeline cannot drift because they share one implementation.
 *
 * Predicate choice ARCH-RULED 2026-08-12 (was provisional): mirror the byPair
 * gate. Reasons: ① the panel's pairings' consumer that decides skip-or-not IS
 * the byPair sweep (the other gate, style_applier.js:1600 via
 * _resolveInstalledFontName, judges emphasis landing — a different sentence);
 * ② probe 03 showed no false positive on the CJK targets; ③ over-warning is
 * the right bias for #28 (silent under-reporting is the disease); ④ gate A is
 * exact-name like the config's own face strings — same spelling system, no
 * third identity. The two gates DO diverge (live on this machine, probe 04:
 * Whitney/Book ↔ installed twin "Whitney Book"/Regular; Dax ↔ "Dax Pro") —
 * that divergence is TODO#34, owned by arch; do NOT try to unify it here.
 * A face this module flags may still APPLY through the emphasis path — the
 * red mark's claim is scoped to the byPair sweep.
 *
 * ⚠ KNOWN false-positive (UNTESTED hole — see checkDstFaceInstalled's header
 * and findings.md#fontstatus-not-available-misleading): document-installed
 * fonts render fine yet report NOT_AVAILABLE; the gate skips them too, so the
 * prediction stays truthful, but "not installed" may not mean "cannot render".
 *
 * ENUMERATION SOURCE: config.fonts_by_language ∪ config.pairs[].members —
 * i.e. only faces the config AUTHORS. Never the rendered roster: the panel's
 * roster unions doc-present fonts and installed styles into the node tree
 * (configToPanelData includeDocFonts + the installedFamilies style union,
 * app.jsx:1729-1732), so enumerating the roster would report faces the
 * operator never wrote — including the known §11 leak — as "missing config
 * fonts". pairs members are included so a face the operator can materialize
 * ("放到节点上", design F) already has a probed answer when its node appears.
 *
 * GUARD: reuses the SAME signal the W3 chip guards on — installedFamilies
 * empty means "we could not enumerate" (standalone web preview, no host),
 * not "nothing is installed". In that state this returns null and the panel
 * shows NOTHING (no red, no count, no popup line). No second
 * "did-we-read-anything" signal is computed anywhere.
 */

var SEP = "␟";   // same U+241F separator data.jsx fold-set keys use

function faceKey(font, weight) {
    return String(font) + SEP + String(weight);
}

// All faces the config authors, deduped, as [{font, weight}].
// fonts_by_language: { lang: [{font, weight}] }; pairs: [{members:[{lang,font,weight}]}].
function collectConfigFaces(config) {
    var out = [];
    var seen = {};
    function push(font, weight) {
        if (!font || !weight) return;
        var k = faceKey(font, weight);
        if (seen[k]) return;
        seen[k] = true;
        out.push({ font: String(font), weight: String(weight) });
    }
    if (!config || typeof config !== "object") return out;
    var fbl = config.fonts_by_language || {};
    for (var lang in fbl) {
        if (!Object.prototype.hasOwnProperty.call(fbl, lang)) continue;
        var entries = fbl[lang] || [];
        for (var i = 0; i < entries.length; i++) {
            if (entries[i]) push(entries[i].font, entries[i].weight);
        }
    }
    var pairs = config.pairs || [];
    for (var p = 0; p < pairs.length; p++) {
        var members = (pairs[p] && pairs[p].members) || [];
        for (var m = 0; m < members.length; m++) {
            if (members[m]) push(members[m].font, members[m].weight);
        }
    }
    return out;
}

// The precompute. Returns:
//   null  — cannot answer (guard tripped / no probe): panel must show NOTHING.
//   array — faceKey strings of config-authored faces the gate would skip
//           (possibly empty: everything installed).
// opts:
//   installedFamilies — the launcher's enumeration snapshot; empty/absent
//                       trips the guard (same guard as the W3 chip).
//   probeFace(font, weight) → true | false | null — injected. Host passes
//                       gateProbeFace below; Node tests pass a stub. Only an
//                       EXPLICIT false marks a face missing; null/undefined
//                       (unknown) marks nothing — never report what you did
//                       not measure.
function computeMissingFaceKeys(config, opts) {
    opts = opts || {};
    var inst = opts.installedFamilies;
    var known = false;
    if (inst && typeof inst === "object") {
        for (var k in inst) {
            if (Object.prototype.hasOwnProperty.call(inst, k)) { known = true; break; }
        }
    }
    if (!known) return null;
    if (typeof opts.probeFace !== "function") return null;
    var faces = collectConfigFaces(config);
    var missing = [];
    for (var i = 0; i < faces.length; i++) {
        var verdict = null;
        try { verdict = opts.probeFace(faces[i].font, faces[i].weight); }
        catch (eProbe) { verdict = null; }   // a probe that throws answered nothing
        if (verdict === false) missing.push(faceKey(faces[i].font, faces[i].weight));
    }
    return missing;
}

// ── #28e-rep (design-intent §12) — CARRIED, NOT YET DISPLAYED ───────────────
// owner 2026-08-12: same-lang multi-members are "同一个字体的多个身份…要选一个
// 代表" — so "this face is not installed" is a DIFFERENT severity for the
// representative (the pairing really lands on it → really skipped) than for a
// non-representative identity (never meant to land). owner has NOT yet said
// whether the red outline should distinguish them, so this classification is
// computed and carried on panelData (adapter: _faceRoles) but NO display reads
// it yet — when owner rules, the hookup is one wire, and NOT computing it now
// would mean recomputing installedness plumbing later.
//
// Role per config face key, mirroring resolve.js's EFFECTIVE landing semantics
// (font_mapping_resolve.js:60-104, read 2026-08-12):
//   "rep"           — the face some (pair, lang) actually lands on: a lang's
//                     single member (resolve IGNORES rep_by_lang for ≤1), OR
//                     representative_by_lang[lang] when that lang has ≥2
//                     members, OR the FIRST same-lang member when ≥2 but the
//                     rep entry is missing/invalid (resolve's fallback).
//   "nonrep_member" — appears in pairs only as a ≥2-same-lang NON-landing
//                     identity (per §12: never meant to be written into the doc).
//   "unpaired"      — in fonts_by_language but in no pair.
// Precedence rep > nonrep_member > unpaired (a face landing ANYWHERE is "rep").
function collectFaceRoles(config) {
    var roles = {};
    var faces = collectConfigFaces(config);
    for (var i = 0; i < faces.length; i++) {
        roles[faceKey(faces[i].font, faces[i].weight)] = "unpaired";
    }
    function mark(font, weight, role) {
        if (!font || !weight) return;
        var k = faceKey(font, weight);
        if (role === "rep") { roles[k] = "rep"; return; }
        if (roles[k] !== "rep") roles[k] = role;
    }
    var pairs = (config && config.pairs) || [];
    for (var p = 0; p < pairs.length; p++) {
        var pair = pairs[p] || {};
        var members = pair.members || [];
        var byLang = {};
        for (var m = 0; m < members.length; m++) {
            var mem = members[m];
            if (!mem || !mem.lang) continue;
            if (!byLang[mem.lang]) byLang[mem.lang] = [];
            byLang[mem.lang].push(mem);
        }
        for (var lang in byLang) {
            if (!Object.prototype.hasOwnProperty.call(byLang, lang)) continue;
            var ms = byLang[lang];
            if (ms.length === 1) { mark(ms[0].font, ms[0].weight, "rep"); continue; }
            var rep = pair.representative_by_lang && pair.representative_by_lang[lang];
            var repFont = (rep && rep.font && rep.weight) ? rep.font : ms[0].font;
            var repWeight = (rep && rep.font && rep.weight) ? rep.weight : ms[0].weight;
            for (var j = 0; j < ms.length; j++) {
                var isRep = (ms[j].font === repFont && ms[j].weight === repWeight);
                mark(ms[j].font, ms[j].weight, isRep ? "rep" : "nonrep_member");
            }
        }
    }
    return roles;
}

// ── #28e-alias — "missing" vs "known under another name" ───────────────────
// ⚠ CAPABILITY KEPT, DELIBERATELY UNWIRED (arch ruling 2026-08-12, post-#34):
// no panel plumbing consumes these two functions anymore. The byPair
// prediction path has no trigger set left — after #34 the gate itself runs
// the same ①-④ resolver, so "judged missing yet twin-resolvable" is
// constructively near-empty (the residual is exactly #34's unfixed fail-open
// half: resolver proposes a name whose status is unreadable, the gate's
// strict recheck rejects — that residual belongs to TODO#34). The question
// this answers ("does this face have another installed spelling?") is kept
// because it is cheap, independently tested, and pipeline-free; if TODO#38
// (resolveDocActions / resolvePanelActions bypass the gate) ever needs it,
// wire it ON THAT PATH — do not resurrect the panel plumbing.
// probe 04 measured that two of the faces the gate calls not-installed are
// actually INSTALLED under a twin spelling (Whitney/Book ↔ "Whitney Book"/
// Regular; Dax/Regular ↔ "Dax Pro"/Regular) — design-intent §12's "同一个字体
// …名字不一样" in the flesh. Telling the operator 本机没有 would send them off
// to install a font they already have. So: for each face ALREADY judged
// missing, ask whether an installed named-weight twin exists — REUSING the
// pipeline's own twin resolver (style_sheet_builder._internal
// ._resolveInstalledFontName, arch: 别重写) — and carry the twin spelling as a
// marker. The red on/off rule is NOT changed by this (alias faces stay red:
// the byPair gate still skips them); only the WORDING may differ, and that
// wording is pending owner approval.
//
// Returns { "font␟weight": "TwinFamily / TwinStyle" } for the alias subset
// ({} when none), or null when no probeTwin was injected (feature dark).
// A resolver hit that equals the as-specified spelling is NOT an alias (that
// would be a pure gate-A/gate-B status disagreement, TODO#34's business).
function computeAliasSpellings(missingKeys, opts) {
    opts = opts || {};
    if (!Array.isArray(missingKeys) || typeof opts.probeTwin !== "function") return null;
    var out = {};
    for (var i = 0; i < missingKeys.length; i++) {
        var k = String(missingKeys[i]);
        var sep = k.indexOf(SEP);
        if (sep < 0) continue;
        var font = k.substring(0, sep);
        var weight = k.substring(sep + SEP.length);
        var twin = null;
        try { twin = opts.probeTwin(font, weight); } catch (eT) { twin = null; }
        if (twin && twin.family && !(twin.family === font && twin.fontStyle === weight)) {
            out[k] = twin.family + " / " + (twin.fontStyle || "Regular");
        }
    }
    return out;
}

// Host probeTwin = the pipeline's own twin resolver, verbatim (as-specified →
// named-weight twin → base sub-family → curated legacy reverse twin; see
// style_sheet_builder.js:2209). Needs a workDoc to walk up to app.fonts.
// Returns {family, fontStyle} or null; never throws.
function makeTwinProbe(workDoc) {
    return function (font, weight) {
        var r = null;
        try {
            var SSB = require("./style_sheet_builder.js");
            r = SSB._internal._resolveInstalledFontName(workDoc, String(font), String(weight));
        } catch (eR) { r = null; }
        return (r && r.family) ? r : null;
    };
}

// Host probe = the byPair Stage-1 gate itself (shared function — see header).
// Mapped to the tri-state probeFace contract:
//   not verifiable (no host)      → null  (unknown; guard usually catches first)
//   lookup threw                  → false (the gate REJECTS the entry → skipped)
//   otherwise                     → installed verbatim
function gateProbeFace(font, weight) {
    var chk = require("./byPair_script_coverage.js").checkDstFaceInstalled(font, weight);
    if (!chk.verifiable) return null;
    if (chk.error !== null) return false;
    return chk.installed === true;
}

module.exports = {
    FACE_KEY_SEP: SEP,
    faceKey: faceKey,
    collectConfigFaces: collectConfigFaces,
    computeMissingFaceKeys: computeMissingFaceKeys,
    collectFaceRoles: collectFaceRoles,   // #28e-rep — carried, not yet displayed
    computeAliasSpellings: computeAliasSpellings,   // #28e-alias — wording marker
    makeTwinProbe: makeTwinProbe,
    gateProbeFace: gateProbeFace
};
