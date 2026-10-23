"use strict";

// lib/cluster_grep_repair.js — pure logic for the neutral-punctuation GREP repair.
//
// Why this exists:
//   The cluster paragraph-style architecture routes Latin chars in [None] runs
//   to a `_T_Latin_*` CS via a nested GREP rule. The OLD Latin GREP excluded
//   neutral "smart punctuation" (French curly apostrophe U+2019 etc.), so such a
//   mark fell to the CJK psFont and rendered FULL-WIDTH (the bilingual-doc bug).
//   The enforcer only touches designer-CS runs, so it never fixed these [None]
//   marks. The forward fix updates style_sheet_builder's GREP_LATIN_PATTERN /
//   GREP_CJK_PATTERN (context-aware neutral join). This repair MIGRATES the
//   baked-in GREP expressions of EXISTING docs' managed `_T_p_*` styles to those
//   new patterns; `doc.recompose()` then re-routes already-orphaned marks AND
//   prevents newly-typed ones from re-orphaning. Host-proven: on the real bug
//   doc, migrating 7 `_T_Latin_` rules + recompose moved all 10 apostrophes
//   MHeiHK → Dax Pro.
//
// This module owns the per-rule DECISION + the tally SHAPE (host-agnostic,
// unit-testable). The `.idjs` entry owns the DOM walk / recompose / read-back.

var SSB;
try { SSB = require("./style_sheet_builder.js"); } catch (e) { SSB = null; }

var GREP_LATIN_PATTERN = SSB ? SSB.GREP_LATIN_PATTERN : null;
var GREP_CJK_PATTERN = SSB ? SSB.GREP_CJK_PATTERN : null;

// Target routing pattern for a nested-GREP rule, keyed on its applied character
// style NAME: `_T_Latin_*` → Latin pattern, `_T_CJK_*` → CJK pattern, anything
// else (designer CS, other `_T_*`) → null (leave untouched).
function targetPatternFor(csName) {
    if (typeof csName !== "string") return null;
    if (csName.indexOf("_T_Latin_") === 0) return GREP_LATIN_PATTERN;
    if (csName.indexOf("_T_CJK_") === 0) return GREP_CJK_PATTERN;
    return null;
}

/**
 * Decide the action for one nested-GREP rule.
 *   csName        — rule.appliedCharacterStyle.name
 *   currentExpr   — rule.grepExpression (as read back from the host)
 * Returns:
 *   { action: "skip",    reason: "not-managed" }  — CS not _T_Latin_/_T_CJK_
 *   { action: "skip",    reason: "no-target" }    — managed CS but the builder
 *                                                    pattern is unavailable (SSB
 *                                                    require failed) — fail safe
 *   { action: "current", target }                 — expr already === target (no-op)
 *   { action: "migrate", target }                 — expr differs → rewrite
 *
 * Match is by CS-NAME PREFIX (the pipeline-ownership guarantee — `_T_*` is the
 * managed marker), NOT an exact-string test against the OLD pattern. Exact-OLD
 * is brittle: it fails closed if the host round-trips the expression with any
 * normalization, and silently skips older-vintage docs whose OLD pattern differs
 * (codex/xhigh finding). Idempotency comes from the `expr === target` "current"
 * branch, so a re-run rewrites nothing.
 */
function decideRule(csName, currentExpr) {
    var target = targetPatternFor(csName);
    if (typeof csName !== "string" ||
        (csName.indexOf("_T_Latin_") !== 0 && csName.indexOf("_T_CJK_") !== 0)) {
        return { action: "skip", reason: "not-managed" };
    }
    if (!target) return { action: "skip", reason: "no-target" };
    if (String(currentExpr) === target) return { action: "current", target: target };
    return { action: "migrate", target: target };
}

/**
 * Fresh tally. The `.idjs` accumulates into this; kept here so the shape is one
 * source of truth + assertable in Node tests. The CHAR-LEVEL counters
 * (neutralOnCJKAfter / neutralReroutedToLatin) are the REAL success signal —
 * `rulesMigrated` alone is a proxy (a rule can migrate yet a mark stay orphaned
 * behind a direct override). A residual `neutralOnCJKAfter > 0` after recompose
 * means the repair did NOT fully take (fail-closed: do not report success).
 */
function newTally() {
    return {
        stylesScanned: 0,
        rulesScanned: 0,             // _T_Latin_/_T_CJK_ nested-GREP rules seen
        rulesMigrated: 0,            // expr differed from target → rewritten
        rulesAlreadyCurrent: 0,      // expr already === target (idempotent no-op)
        rulesSkippedUnmanaged: 0,    // nested-GREP rules whose CS wasn't managed
        rulesFailed: 0,              // grepExpression write threw (host-rejected) — surfaced, NOT hidden
        // char-level (findGrep read-back, before/after recompose):
        // An ORPHAN = a neutral mark that is LATIN-LETTER-FLANKED on both immediate
        // sides yet still renders on a CJK font. A CJK-flanked / space-flanked mark
        // on a CJK font is CORRECT (that is what GREP_CJK_PATTERN keeps full-width)
        // and is NOT counted — else a perfect repair on a doc with real SC quotes
        // would false-report residuals (impl-audit n1/xhigh).
        orphansBefore: 0,
        orphansAfter: 0,             // residual orphans — MUST be 0 for a clean repair
        reroutedToLatin: 0           // orphans fixed (before − after)
    };
}

// Fail-closed success predicate (unit-testable — the .idjs must not inline its
// own). A repair is CLEAN iff no residual Latin-letter-flanked orphan survived
// AND no GREP write failed. A partial repair (some orphans left) or any failed
// write is NOT clean, per the tally contract.
function isRepairClean(orphansAfter, tally) {
    if (orphansAfter !== 0) return false;
    if (tally && tally.rulesFailed && tally.rulesFailed > 0) return false;
    return true;
}

// Roll one decideRule() result into a tally (used by both the .idjs and tests).
function applyDecisionToTally(tally, decision) {
    if (!tally || !decision) return tally;
    if (decision.action === "migrate") { tally.rulesScanned++; tally.rulesMigrated++; }
    else if (decision.action === "current") { tally.rulesScanned++; tally.rulesAlreadyCurrent++; }
    else if (decision.action === "skip" && decision.reason === "not-managed") { tally.rulesSkippedUnmanaged++; }
    // "skip"/"no-target" on a managed CS is a genuine miss — count as scanned so
    // it isn't silently invisible.
    else if (decision.action === "skip") { tally.rulesScanned++; }
    return tally;
}

module.exports = {
    targetPatternFor: targetPatternFor,
    decideRule: decideRule,
    newTally: newTally,
    isRepairClean: isRepairClean,
    applyDecisionToTally: applyDecisionToTally,
    GREP_LATIN_PATTERN: GREP_LATIN_PATTERN,
    GREP_CJK_PATTERN: GREP_CJK_PATTERN
};
