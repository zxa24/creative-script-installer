"use strict";

/**
 * lib/underline_rule_dedup.js
 *
 * Post-apply pass that deduplicates the "paragraph rule + character-style
 * underline" overlap pattern.
 *
 * Background:
 *   Designers sometimes use a paragraph rule (`ruleAbove` at offset=0,
 *   Width=Text, weight≈0.5pt) AS a continuous underline — because it
 *   draws at the paragraph baseline and is immune to per-run baseline
 *   shift (so it crosses superscripts ®/™/* without the stepping that
 *   character-level underline gets). They then ALSO apply a hyperlink-
 *   style character style (which sets `underline: true` on its definition).
 *
 *   Visually intended result: ONE continuous line, perceived as one.
 *   What actually happens in many render contexts: TWO lines, slightly
 *   offset — the rule sits at baseline, the char-style underline sits
 *   below baseline at the font's auto offset.
 *
 *   When the reorganize script preserves both layers (rule via the
 *   new ruleAbove dim, char style via designerCharStylesPreserved),
 *   the post-script visual shows the two-line stack clearly. This pass
 *   resolves the redundancy by per-run-overriding `r.underline = false`
 *   on every run inside a paragraph that has `ruleAbove` active AND
 *   currently has effective underline. The character style ITSELF is
 *   untouched (semantic "this run is a link" is preserved); only the
 *   visible underline is suppressed at the run level.
 *
 * Modes:
 *   "suppress-underline" — per-run override r.underline = false where
 *                          the run currently reads as underlined; rule
 *                          stays.  RECOMMENDED — matches typical designer
 *                          intent (the rule is the "real" underline).
 *   "suppress-rule"      — clear paragraph.ruleAbove on each affected
 *                          paragraph; char-style underline stays.
 *   "preserve-both"      — no-op; both layers remain (potentially two
 *                          visible lines).
 *
 * Granularity:
 *   per-run.  We walk textStyleRanges and only touch runs whose effective
 *   `underline` is currently true.  Runs that were already false stay
 *   untouched, so a per-line mix of underlined and non-underlined spans
 *   keeps its non-underlined spans intact.
 *
 * Returns:
 *   { paragraphsAffected, rangesAffected, paragraphsCleared, mode,
 *     skippedNoRule, skippedNoUnderline, errors }
 */

function _hasActiveRuleAbove(para) {
    try { return para.ruleAbove === true; } catch (e) { return false; }
}

function _runEffectiveUnderline(run) {
    // `run.underline` reads inconsistently in UXP — for the SAME character
    // style with `underline:true`, some textStyleRanges return true and
    // others return false (verified empirically on a paragraph where four
    // adjacent runs all carry cs=Hyperlink and csUL=true, but r.underline
    // was true/false/false/true). The reason isn't fully understood —
    // possibly a delta-from-paragraph-style serialization quirk. So we
    // can't rely on r.underline alone to decide whether a run is visually
    // underlined.
    //
    // Robust detection: a run is effectively underlined iff EITHER
    //   (a) r.underline === true (per-run override OR effective-true)
    //   (b) r.appliedCharacterStyle.underline === true (CS-inherited)
    // Either source produces a visible underline at render. Writing
    // r.underline = false in the suppress pass masks both because the
    // per-run override beats the CS-inherited value in the cascade.
    try {
        if (run.underline === true) return true;
    } catch (e) {}
    try {
        var cs = run.appliedCharacterStyle;
        if (cs && cs.underline === true) return true;
    } catch (e) {}
    return false;
}

function _suppressRunUnderlines(para, plog, paraId) {
    var rangesCleared = 0;
    var ranges;
    try { ranges = para.textStyleRanges; } catch (eR) { return 0; }
    if (!ranges || typeof ranges.length !== "number") return 0;
    var n = ranges.length;
    for (var i = 0; i < n; i++) {
        var r;
        try { r = ranges.item(i); } catch (eI) { continue; }
        if (!r) continue;
        if (!_runEffectiveUnderline(r)) continue;
        try {
            r.underline = false;
            rangesCleared++;
        } catch (eW) {
            if (plog) plog("dedup: para[" + paraId + "] range[" + i + "] write FAIL " + (eW && eW.message ? eW.message : eW));
        }
    }
    return rangesCleared;
}

function _suppressRuleAbove(para, plog, paraId) {
    try {
        para.ruleAbove = false;
        return true;
    } catch (e) {
        if (plog) plog("dedup: para[" + paraId + "] ruleAbove clear FAIL " + (e && e.message ? e.message : e));
        return false;
    }
}

/**
 * Walk every paragraph in `paraIterable` and apply the configured dedup.
 *
 * @param {Array<Paragraph>|Collection} paraIterable — explicit list of
 *        Paragraph DOM refs OR an InDesign collection-like object exposing
 *        `length` + `.item(i)`. Caller is responsible for filtering down
 *        to only paragraphs that were actually touched by the reorganize
 *        pass (e.g. the cluster-application result set) — passing the
 *        whole doc would re-process unrelated paragraphs and pollute
 *        stats.
 * @param {string} mode — "suppress-underline" | "suppress-rule" | "preserve-both"
 * @param {Function?} plog — optional progress logger; called as plog(line:String)
 */
function applyUnderlineRuleDedup(paraIterable, mode, plog) {
    var stats = {
        mode: mode || "preserve-both",
        paragraphsAffected: 0,
        rangesAffected: 0,
        paragraphsCleared: 0,
        skippedNoRule: 0,
        skippedNoUnderline: 0,
        errors: 0
    };
    if (!paraIterable) return stats;
    if (mode === "preserve-both" || !mode) {
        if (plog) plog("dedup: mode=preserve-both → no-op");
        return stats;
    }
    if (mode !== "suppress-underline" && mode !== "suppress-rule") {
        if (plog) plog("dedup: unknown mode '" + mode + "' → treating as preserve-both");
        return stats;
    }

    var paras = [];
    if (typeof paraIterable.length === "number") {
        // Collection or Array
        for (var k = 0; k < paraIterable.length; k++) {
            var p = null;
            try { p = (typeof paraIterable.item === "function") ? paraIterable.item(k) : paraIterable[k]; }
            catch (eA) {}
            if (p) paras.push(p);
        }
    }
    if (plog) plog("dedup: mode=" + mode + " paragraphs=" + paras.length);

    for (var j = 0; j < paras.length; j++) {
        var para = paras[j];
        var paraId = "?";
        try { paraId = String(para.id || j); } catch (eId) { paraId = String(j); }

        if (!_hasActiveRuleAbove(para)) {
            stats.skippedNoRule++;
            continue;
        }

        // Probe ANY run with effective underline — short-circuit on first hit
        var ranges;
        try { ranges = para.textStyleRanges; } catch (eRr) { stats.errors++; continue; }
        if (!ranges || typeof ranges.length !== "number") continue;
        var hasUnderline = false;
        for (var ri = 0; ri < ranges.length; ri++) {
            var r;
            try { r = ranges.item(ri); } catch (eR2) { continue; }
            if (r && _runEffectiveUnderline(r)) { hasUnderline = true; break; }
        }
        if (!hasUnderline) {
            stats.skippedNoUnderline++;
            continue;
        }

        if (mode === "suppress-underline") {
            var cleared = _suppressRunUnderlines(para, plog, paraId);
            if (cleared > 0) {
                stats.paragraphsAffected++;
                stats.rangesAffected += cleared;
                if (plog) plog("dedup: para[" + paraId + "] cleared " + cleared + " run-level underline(s)");
            }
        } else { // suppress-rule
            if (_suppressRuleAbove(para, plog, paraId)) {
                stats.paragraphsAffected++;
                stats.paragraphsCleared++;
                if (plog) plog("dedup: para[" + paraId + "] cleared ruleAbove");
            } else {
                stats.errors++;
            }
        }
    }

    if (plog) {
        plog("dedup: done — affected=" + stats.paragraphsAffected
             + " ranges=" + stats.rangesAffected
             + " paragraphsCleared=" + stats.paragraphsCleared
             + " skippedNoRule=" + stats.skippedNoRule
             + " skippedNoUnderline=" + stats.skippedNoUnderline
             + " errors=" + stats.errors);
    }
    return stats;
}

module.exports = {
    applyUnderlineRuleDedup: applyUnderlineRuleDedup,
    // Exported for unit-test reach-in.
    _internals: {
        hasActiveRuleAbove: _hasActiveRuleAbove,
        runEffectiveUnderline: _runEffectiveUnderline,
        suppressRunUnderlines: _suppressRunUnderlines,
        suppressRuleAbove: _suppressRuleAbove
    }
};
