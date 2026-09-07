"use strict";

/**
 * lib/italic_config.js — per-(font,weight) italic HOW config reader (pure leaf).
 *
 * univ-italic (task_plan §7, arch app-folio 2026-06-25): the operator declares,
 * per resolved (font family, weight), HOW that weight realizes italic —
 * { mode: "real" | "faux", angle? }. WHAT-is-italic stays translator/source
 * emphasis (untouched); only HOW is read here. This leaf reads that config out
 * of brand_config. An unconfigured (font,weight) → null = an unpaired weight,
 * surfaced via byPair_script_coverage (ignore = tofu, same as any unpaired
 * weight); the apply path NEVER silently substitutes a faux default (OQ-1).
 *
 * Pure: touches no InDesign objects, app-free at load → Node-requirable leaf
 * (the run_uxp_script bundler inlines it). ES5 only.
 *
 * Config shape (brand_config.json — OQ-3 "斜体变体 = 一种配对·同生命周期"):
 *   italic_by_weight: [
 *     { font: "<family str>", weight: "<style str>",
 *       mode: "real" | "faux", angle: <number, faux only> }
 *   ]
 *
 * Key match = (font exact) AND (_normWeight(weight) === _normWeight(charStyle)).
 * The weight is canonicalized through the SAME `_normWeight` the apply path uses
 * (contract K), so a panel-stored key and an apply-time char's fontStyle match
 * despite case/spacing/trailing-"Italic" differences (e.g. config "Bold" matches
 * an apply-time "bold" or "Bold Italic").
 *
 * Angle (OQ-4) is a per-weight attribute set only in the pairing panel; faux
 * realization paths read `angle` from here. Default 15 when absent/0/non-finite.
 */

var _normWeight = require("./font_italic_probe.js")._normWeight;

var DEFAULT_FAUX_ANGLE = 15;

/**
 * lookup — resolve the italic HOW config for a resolved (family, weight).
 * @param {Object} brandConfig  the brand_config object (may be null)
 * @param {string} family       resolved font family (post-byPair, contract K)
 * @param {string} weightStyle  the run's fontStyle / weight token
 * @returns {{mode:"real"}|{mode:"faux",angle:number}|null}
 *          null = unconfigured (→ no italic landed, coverage-surfaced; OQ-1).
 */
function lookup(brandConfig, family, weightStyle) {
    if (!brandConfig || family === null || family === undefined || family === "") return null;
    var list = brandConfig.italic_by_weight;
    if (!list || !list.length) return null;
    var fam = String(family);
    var nw = _normWeight(weightStyle);
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || String(e.font) !== fam) continue;
        if (_normWeight(e.weight) !== nw) continue;
        // real = use the font's real italic variant (apply path enforces
        // weight-exact via contract R / OQ-2 fail-closed block). faux = synthetic
        // skew. A matched-but-MALFORMED mode (neither "real" nor "faux") = a
        // config ERROR, not a legal state → return null = treat as unconfigured
        // → coverage-surfaced (OQ-1). We do NOT silently fall to faux: that would
        // quietly turn an operator's intended `real` into faux = exactly the
        // silent failure this design surfaces everywhere else (arch app-folio
        // 2026-06-25). surface ≠ tofu — coverage is the existing surface mechanism.
        if (e.mode === "real") return { mode: "real" };
        if (e.mode === "faux") {
            var a = Number(e.angle);
            return { mode: "faux", angle: (isFinite(a) && a !== 0) ? a : DEFAULT_FAUX_ANGLE };
        }
        return null;
    }
    return null;
}

/**
 * resolveItalicRealization — decide HOW an italic-marked run realizes, given its
 * per-weight config (the `lookup` result), whether the run's font has a
 * WEIGHT-EXACT real italic, and whether the run is ALREADY sitting on that face.
 * Pure: the host probe is resolved by the caller (contract R / OQ-2 weight-exact —
 * findExactItalicStyleName, NOT the family-level probe) and passed in here.
 *
 * Decision (charter §7.4; the unconfigured arm rewritten by the user 2026-08-07):
 *   cfg.faux                  → faux at cfg.angle. Wins over everything below —
 *                               asking for more slant than the real face is a
 *                               legitimate intent, not a downgrade to be blocked.
 *   cfg.real + real           → real italic (skew=0)
 *   cfg.real + !real          → BLOCK (fail-closed · a misconfig must not reach save)
 *   no cfg + already-on-face  → KEEP: leave the run exactly as the document has it
 *   no cfg + not on a face    → SURFACE: upright + reported, never a silent slant
 *
 * WHY `keep` EXISTS (it is the 2026-08-07 correction): "真斜体不是一种实现方式" —
 * a real italic face is a WEIGHT the document already uses, not an implementation
 * the operator must authorise. The previous rule surfaced (i.e. stripped to
 * upright) EVERY unconfigured italic weight, which destroyed typography nobody
 * asked to change — it is what turned 7 real italic runs in the test fixture
 * upright. 乙-STRICT survives NARROWED: it still owns the case it was written for,
 * an italic intent whose weight has no italic face, where the machine must not
 * invent a slant.
 *
 * ⚠ `runAlreadyOnItalicFace` IS NOT OPTIONAL. Omitting it (a 2-arg call) yields
 * `undefined` → falsy → the old destructive behaviour, silently. Every caller must
 * pass it, and each derives it slightly differently because the fact lives in a
 * different place at each site — that asymmetry is deliberate, not drift:
 *   • style_sheet_builder:2318  `!!_exactIt`      — italic-ness is in the enclosing
 *                                                   `_isSlantFontStyle(sty)` branch
 *   • style_sheet_builder:3379  `!!_emExact`      — italic-ness is in the enclosing
 *                                                   `es.hasItalicIntent` guard
 *   • style_applier:1628        `!!_exactIt`      — italic-ness is in `if (isItalicSrc)`
 *   • italic_apply:114          `!!exactIt && _wasItalic` — no enclosing guard: that
 *                                                   leaf reads the LIVE char, whose
 *                                                   own style may be upright while a
 *                                                   translator asks for italic. That
 *                                                   run must SURFACE (it is not yet
 *                                                   on a face), not be kept.
 *
 * @param {{mode:string,angle?:number}|null} cfg  lookup() result
 * @param {boolean} hasRealItalic          the weight's EXACT italic face is installed
 * @param {boolean} runAlreadyOnItalicFace the run is ALREADY on that face (see above)
 * @returns {{kind:'real'|'faux'|'block'|'keep'|'surface', angle?:number, reason:string}}
 */
function resolveItalicRealization(cfg, hasRealItalic, runAlreadyOnItalicFace) {
    if (cfg && cfg.mode === "faux") {
        return { kind: "faux", angle: cfg.angle, reason: "configured-faux" };
    }
    if (cfg && cfg.mode === "real") {
        // The panel no longer authors `real` (charter §7.4, 2026-08-07). This arm
        // survives as the SAFETY FLOOR for a hand-edited config: reachable, and it
        // must still refuse to slant a weight whose exact italic face is missing
        // rather than borrow another weight's (contract R).
        return hasRealItalic
            ? { kind: "real", reason: "configured-real" }
            : { kind: "block", reason: "configured-real-but-no-weight-exact-italic" };
    }
    // ── unconfigured ──
    // A run that is ALREADY sitting on a real italic face is left exactly as it is.
    // "真斜体不是一种实现方式" (user 2026-08-07): a real italic face is a WEIGHT the
    // document already uses, not an implementation the operator has to authorise.
    // Stripping it to upright — which is what 乙-STRICT did to every such run — was
    // destroying typography nobody asked to change, and it is why the fixture's 7
    // Whitney italic runs came back upright.
    //
    // 乙-STRICT is hereby NARROWED, not abandoned: it still governs the case it was
    // written for — a run marked italic whose weight has NO italic face. There the
    // machine must not invent a slant; it stays upright and is surfaced.
    // `&& hasRealItalic`: "already on a real italic face" is only coherent when that
    // face exists. Without the conjunct, an inconsistent (false, true) would return
    // keep and italic_apply would then assign sub.fontStyle = null (exactIt) and throw
    // into real_apply_failed, while the other sites quietly fell back to the incoming
    // style — one bad input, three different degradations. Unreachable today because
    // every caller derives arg 3 from the probe, but cheaper to make impossible than
    // to rely on that staying true.
    if (runAlreadyOnItalicFace && hasRealItalic) {
        return { kind: "keep", reason: "already-real-italic-face" };
    }
    return { kind: "surface", reason: "unconfigured" };
}

module.exports = {
    lookup: lookup,
    resolveItalicRealization: resolveItalicRealization,
    DEFAULT_FAUX_ANGLE: DEFAULT_FAUX_ANGLE
};
