"use strict";

/**
 * lib/auto_format_gate.js
 *
 * Single home for the cross-repo「translator 未手动标注 → pipeline 不沿用
 * 源格式」policy gate (CLAUDE.md「跨仓政策 — 不自动传播源格式到 target」;
 * DEV_LOG 2026-05-26 用户策略声明; app-folio CLAUDE.md「跨仓政策」).
 *
 * The webapp tags any AI / heuristic-generated formatting with an `_auto`
 * marker so the InDesign import pipeline can DROP it — only translator-
 * confirmed format is applied to the target. There are two carriers, and
 * for a long time only the first was gated:
 *
 *   1. translation.target_emphasis_runs  → PARENT-level flag
 *        translation.target_emphasis_runs_auto === true
 *      Gated since the 2026-05-26 Client-A hardening (v2_pipeline Step 3.4,
 *      BRIDGE-39 era). See isAutoEmphasisRuns().
 *
 *   2. translation.annotations[]          → PER-ELEMENT flag
 *        ann._auto === true
 *      The webapp markers path projects marker-derived emphasis onto
 *      annotations[] with `_auto: true` (app-folio app.js ~5619), and the
 *      package serializer preserves it (app.js normalizeAnnotationItem
 *      ~2522). This carrier was NEVER gated: the 2026-05-26 hardening only
 *      covered carrier #1, and the markers projection was added afterward,
 *      so `_auto` annotations slipped through and were applied anyway =
 *      replay of the Client-A incident (AI-guessed "Medium" emphasis landing on
 *      「增强型股票敞口」/「固定收益敞口」 the translator never marked). See
 *      isAutoAnnotation().
 *
 * Why a shared module: annotation application is NOT a single chokepoint —
 * v2_pipeline applies annotations at THREE sites (Step 3
 * applyAnnotationsToParagraph, BRIDGE-39 underline-preserve range
 * collection, BRIDGE-41 final re-stamp). Routing every `_auto` decision
 * through one predicate set is what stops the「_auto 判断散在多处、漏一处」
 * failure mode (the exact way this bug was born) from recurring.
 *
 * Pure ES5 module — UXP idjs + Node test compatible: var only, no deps,
 * no host API.
 */

/**
 * True when an annotation is AI / heuristic-generated (NOT translator-
 * confirmed) and must not be applied by the pipeline.
 *
 * @param {Object} ann — one entry of translation.annotations[]
 * @returns {boolean}
 */
function isAutoAnnotation(ann) {
    return !!(ann && ann._auto === true);
}

/**
 * True when a translation row's target_emphasis_runs were AI / heuristic-
 * generated (target_emphasis_runs_auto === true) and must not be applied.
 * Field absent / false → translator-confirmed (or directly populated) →
 * honored, matching the existing BRIDGE-39 semantics.
 *
 * @param {Object} translation — one translation row
 * @returns {boolean}
 */
function isAutoEmphasisRuns(translation) {
    // Gate = auto && !faithful: AI/heuristic-guessed runs are stripped, but
    // codec-carried FAITHFUL runs (target_emphasis_runs_faithful === true,
    // stamped by app-folio app.js) are HONORED — else translated text silently
    // loses bold (design-intent §4). Drift-reconcile @integration: this SoT
    // extraction (auto-gate line) predated the faithful flag; cjkweight's inline
    // gate had it. Canonical now encodes the FULL gate so every call site is
    // faithful-aware — a bare `auto`-only check here would re-strip faithful runs.
    return !!(translation
        && translation.target_emphasis_runs_auto === true
        && translation.target_emphasis_runs_faithful !== true);
}

/**
 * Split an annotations[] array into translator-confirmed vs auto buckets.
 * Non-array / empty input → empty buckets (never throws).
 *
 * @param {Array} annotations — translation.annotations[]
 * @returns {{confirmed: Array, auto: Array}}
 */
function partitionAnnotationsByAuto(annotations) {
    var confirmed = [];
    var auto = [];
    if (annotations && annotations.length) {
        for (var i = 0; i < annotations.length; i++) {
            if (isAutoAnnotation(annotations[i])) {
                auto.push(annotations[i]);
            } else {
                confirmed.push(annotations[i]);
            }
        }
    }
    return { confirmed: confirmed, auto: auto };
}

module.exports = {
    isAutoAnnotation: isAutoAnnotation,
    isAutoEmphasisRuns: isAutoEmphasisRuns,
    partitionAnnotationsByAuto: partitionAnnotationsByAuto
};
