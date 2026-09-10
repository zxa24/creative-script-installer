"use strict";

/**
 * lib/hard_errors.js
 *
 * Phase 4 MVP — Preflight + Postflight 硬错误闸门
 *
 * Plan reference:
 *   task_plan.md "硬错误闸门: preflight + postflight 两阶段"
 *   PRD.md:46 (S4): 硬错误拦截 - 溢出 / 缺字 / 缺链接 / 导出预设
 *   PRD.md:59 (M3): 接近 100% 拦截率
 *
 * Two-phase architecture:
 *
 *   runPreflight(workDoc, segments, translations, fontPlan, locatePlan, deps)
 *     Pass A.5 之后, Pass B 之前. 检查可在写入前拦截的错误:
 *     blocking:
 *       - cjk_missing      (font_policy 全链失败)
 *       - latin_missing    (font_policy 全链失败 for source font)
 *       - missing_link     (doc.links.everyItem().status != NORMAL)
 *       - replacement_char_in_source (segments.json source_text U+FFFD 等)
 *       - replacement_char_in_target (translations.json target_text)
 *       - export_preset_invalid (声明的 preset 不在 doc.pdfExportPresets)
 *       - para_not_located_translatable (有 target_text + 非 skip 但 locate 失败)
 *     warning:
 *       - latin_substituted (fallback 启用)
 *       - export_preset_diff
 *       - para_not_located_nontranslatable (control_only/skip)
 *
 *   runPostflight(workDoc, applyResults, deps)
 *     Pass B 之后, saveAs 之前. 检查写入后才能判定的错误:
 *     blocking:
 *       - overset_text  (textFrame.overflows = true; 译文加长 / 字号变化)
 *       - cluster_apply_failure (Pass B try/catch 收集)
 *     warning:
 *       - format_mixed_not_restored
 *       - orphan_source_styles_count
 *
 *   categorize(errors, rules)
 *     按 kind 把错误分到 blocking/warning. rules 可配置 (E17 follow-up).
 *
 * UXP / ExtendScript compatibility:
 *   - Pure module + deps injection
 *   - var only, no ES6+
 *   - All InDesign API access via deps:
 *       deps.LinkStatus    — indesign.LinkStatus enum
 *       deps.getCollectionItem (optional)
 */

// ─── Constants ────────────────────────────────────────────────────

// Replacement / sentinel chars typically indicating encoding loss
var REPLACEMENT_CHARS = [
    "�",   // U+FFFD REPLACEMENT CHARACTER
    "□",   // U+25A1 WHITE SQUARE (often font fallback artifact)
    "¿½",   // ¿½ pattern from broken encoding
    "?¿"
];

// Default kind → severity mapping (categorize function uses this)
var DEFAULT_SEVERITY = {
    // Preflight blocking
    cjk_missing: "blocking",
    latin_missing: "blocking",
    missing_link: "blocking",
    replacement_char_in_source: "blocking",
    replacement_char_in_target: "blocking",
    export_preset_invalid: "blocking",
    para_not_located_translatable: "blocking",
    // Preflight warning
    latin_substituted: "warning",
    export_preset_diff: "warning",
    para_not_located_nontranslatable: "warning",
    // Postflight blocking
    overset_text: "blocking",
    cluster_apply_failure: "blocking",
    // Postflight warning
    format_mixed_not_restored: "warning",
    orphan_source_styles_count: "warning"
};

// ─── Helpers ──────────────────────────────────────────────────────

function _getCollectionItem(coll, idx) {
    if (!coll) return null;
    if (typeof coll.item === "function") return coll.item(idx);
    return coll[idx];
}

function _hasReplacementChar(text) {
    if (!text) return false;
    var s = String(text);
    for (var i = 0; i < REPLACEMENT_CHARS.length; i++) {
        if (s.indexOf(REPLACEMENT_CHARS[i]) >= 0) return true;
    }
    return false;
}

// ─── categorize ────────────────────────────────────────────────────

/**
 * Split a flat list of errors {kind, ...} into {blocking, warning}.
 *
 * @param {Array} errors
 * @param {Object} rules — optional override of kind → severity
 * @returns {Object} {blocking, warning}
 */
function categorize(errors, rules) {
    var sev = rules || DEFAULT_SEVERITY;
    var blocking = [];
    var warning = [];
    if (!errors || errors.length === 0) return { blocking: blocking, warning: warning };
    for (var i = 0; i < errors.length; i++) {
        var err = errors[i];
        if (!err || !err.kind) continue;
        var s = sev[err.kind] || "warning";   // unknown kinds default to warning
        if (s === "blocking") blocking.push(err);
        else warning.push(err);
    }
    return { blocking: blocking, warning: warning };
}

// ─── Individual checks ────────────────────────────────────────────

/**
 * Check fonts using fontPlan from buildStylePlan (already resolved).
 */
function checkFontsFromPlan(fontPlan) {
    var errors = [];
    if (!fontPlan) return errors;
    if (fontPlan.cjk && fontPlan.cjk.source === "missing") {
        errors.push({
            kind: "cjk_missing",
            attempted: fontPlan.cjk.attempted || []
        });
    }
    if (fontPlan.latin) {
        for (var fontName in fontPlan.latin) {
            if (!fontPlan.latin.hasOwnProperty(fontName)) continue;
            var resolution = fontPlan.latin[fontName];
            if (resolution.source === "missing") {
                errors.push({
                    kind: "latin_missing",
                    font: fontName,
                    attempted: resolution.attempted || []
                });
            } else if (resolution.source === "fallback") {
                errors.push({
                    kind: "latin_substituted",
                    original: resolution.original || fontName,
                    used: resolution.name
                });
            }
        }
    }
    return errors;
}

/**
 * Check workDoc.links for any link not in NORMAL status.
 *
 * @param {Document} workDoc
 * @param {Object} deps — { LinkStatus, [getCollectionItem] }
 *
 * Compares by stringified status name rather than enum identity:
 * `link.status !== deps.LinkStatus.NORMAL` (===) was producing false-positive
 * "missing_link" for every healthy link in the live UXP context (likely
 * because deps.LinkStatus.NORMAL resolves to undefined / a different enum
 * instance than link.status). String("LinkStatus.NORMAL") → "NORMAL" reliably.
 *
 * Treats NORMAL and LINK_EMBEDDED as healthy (embedded means the file is
 * inside the doc); flags everything else (LINK_MISSING / LINK_OUT_OF_DATE /
 * unknown).
 */
function checkMissingLinks(workDoc, deps) {
    var errors = [];
    if (!workDoc) return errors;
    var get = (deps && deps.getCollectionItem) || _getCollectionItem;
    try {
        var links = workDoc.links;
        if (!links || typeof links.length !== "number") return errors;
        for (var i = 0; i < links.length; i++) {
            var link = get(links, i);
            if (!link) continue;
            try {
                var statusStr = String(link.status || "");
                // Normalize "ColorSpace.CMYK"-style enum-toString → "CMYK"
                if (statusStr.indexOf(".") >= 0) statusStr = statusStr.split(".").pop();
                if (statusStr !== "NORMAL" && statusStr !== "LINK_EMBEDDED") {
                    errors.push({
                        kind: "missing_link",
                        linkPath: String(link.filePath || link.name || "?"),
                        status: statusStr
                    });
                }
            } catch (eL) {}
        }
    } catch (e) {}
    return errors;
}

/**
 * Scan source/target text in segments/translations for replacement chars.
 */
function checkReplacementChars(segments, translations) {
    var errors = [];
    if (segments && segments.length) {
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            if (!seg) continue;
            if (_hasReplacementChar(seg.source_text)) {
                errors.push({
                    kind: "replacement_char_in_source",
                    tid: seg.tid,
                    sample: String(seg.source_text || "").substring(0, 40)
                });
            }
        }
    }
    if (translations && translations.length) {
        for (var j = 0; j < translations.length; j++) {
            var t = translations[j];
            if (!t) continue;
            if (_hasReplacementChar(t.target_text)) {
                errors.push({
                    kind: "replacement_char_in_target",
                    tid: t.tid,
                    sample: String(t.target_text || "").substring(0, 40)
                });
            }
        }
    }
    return errors;
}

/**
 * Categorize locatePlan results into translatable_failed (blocking) vs
 * nontranslatable_failed (warning).
 */
function checkLocateResults(locatePlan) {
    var errors = [];
    if (!locatePlan || locatePlan.length === 0) return errors;
    for (var i = 0; i < locatePlan.length; i++) {
        var lr = locatePlan[i];
        if (!lr || lr.para) continue;   // located OK or no entry
        if (lr.translatable) {
            errors.push({
                kind: "para_not_located_translatable",
                tid: lr.seg && lr.seg.tid,
                reason: lr.reason || "not_located"
            });
        } else {
            errors.push({
                kind: "para_not_located_nontranslatable",
                tid: lr.seg && lr.seg.tid,
                reason: lr.reason || "not_located"
            });
        }
    }
    return errors;
}

/**
 * Check workDoc.stories for overset textFrames.
 */
function checkOversetText(workDoc, deps) {
    var errors = [];
    if (!workDoc) return errors;
    var get = (deps && deps.getCollectionItem) || _getCollectionItem;
    try {
        var stories = workDoc.stories;
        if (!stories || typeof stories.length !== "number") return errors;
        for (var s = 0; s < stories.length; s++) {
            var story = get(stories, s);
            if (!story || !story.isValid) continue;
            try {
                var frames = story.textContainers;
                if (!frames || typeof frames.length !== "number") continue;
                for (var f = 0; f < frames.length; f++) {
                    var tf = get(frames, f);
                    if (!tf) continue;
                    try {
                        if (tf.overflows === true) {
                            errors.push({
                                kind: "overset_text",
                                storyIndex: s,
                                frameIndex: f,
                                frameId: (tf.id !== undefined) ? String(tf.id) : null
                            });
                        }
                    } catch (eOf) {}
                }
            } catch (eF) {}
        }
    } catch (e) {}
    return errors;
}

// ─── runPreflight ─────────────────────────────────────────────────

/**
 * Run all preflight checks. Aggregate into {blocking, warning} via categorize.
 *
 * @param {Document} workDoc
 * @param {Array} segments — segments.json
 * @param {Array} translations — translations.json target_text rows
 * @param {Object} fontPlan — from buildStylePlan
 * @param {Array} locatePlan — from locateAllSegments
 * @param {Object} deps — { LinkStatus, [getCollectionItem, severityRules] }
 * @returns {Object} {blocking, warning, raw_errors}
 */
function runPreflight(workDoc, segments, translations, fontPlan, locatePlan, deps) {
    if (!workDoc) throw new Error("runPreflight: workDoc required");
    deps = deps || {};

    var raw = [];
    raw = raw.concat(checkFontsFromPlan(fontPlan));
    raw = raw.concat(checkMissingLinks(workDoc, deps));
    raw = raw.concat(checkReplacementChars(segments, translations));
    raw = raw.concat(checkLocateResults(locatePlan));

    var grouped = categorize(raw, deps.severityRules || DEFAULT_SEVERITY);
    return {
        blocking: grouped.blocking,
        warning: grouped.warning,
        raw_errors: raw,
        blocking_count: grouped.blocking.length,
        warning_count: grouped.warning.length
    };
}

// ─── runPostflight ────────────────────────────────────────────────

/**
 * Run all postflight checks. applyResults is the aggregate of Pass B
 * application outcomes (cluster_apply_failure list, format_mixed_not_restored
 * list, orphan_source_styles_count, etc.).
 *
 * @param {Document} workDoc
 * @param {Object} applyResults — {clusterApplyFailures: [], formatMixedNotRestored: [], orphanSourceStylesCount: N}
 * @param {Object} deps — { [getCollectionItem, severityRules] }
 * @returns {Object} {blocking, warning, raw_errors}
 */
function runPostflight(workDoc, applyResults, deps) {
    if (!workDoc) throw new Error("runPostflight: workDoc required");
    deps = deps || {};
    applyResults = applyResults || {};

    var raw = [];
    // Overset detection
    raw = raw.concat(checkOversetText(workDoc, deps));

    // cluster_apply_failure (collected during Pass B by caller)
    if (applyResults.clusterApplyFailures && applyResults.clusterApplyFailures.length) {
        for (var i = 0; i < applyResults.clusterApplyFailures.length; i++) {
            raw.push({
                kind: "cluster_apply_failure",
                detail: applyResults.clusterApplyFailures[i]
            });
        }
    }

    // format_mixed_not_restored
    if (applyResults.formatMixedNotRestored && applyResults.formatMixedNotRestored.length) {
        for (var j = 0; j < applyResults.formatMixedNotRestored.length; j++) {
            var entry = applyResults.formatMixedNotRestored[j];
            raw.push({
                kind: "format_mixed_not_restored",
                tid: entry.tid,
                sample: entry.sample,
                runCount: entry.runCount,
                hint: entry.hint || "Use translator_app annotations UI to mark emphasis"
            });
        }
    }

    // orphan_source_styles count (single warning entry if non-zero)
    if (applyResults.orphanSourceStylesCount && applyResults.orphanSourceStylesCount > 0) {
        raw.push({
            kind: "orphan_source_styles_count",
            count: applyResults.orphanSourceStylesCount
        });
    }

    var grouped = categorize(raw, deps.severityRules || DEFAULT_SEVERITY);
    return {
        blocking: grouped.blocking,
        warning: grouped.warning,
        raw_errors: raw,
        blocking_count: grouped.blocking.length,
        warning_count: grouped.warning.length
    };
}

// ─── Module exports ────────────────────────────────────────────────

/**
 * runHadOperatorVisibleProblem(report) → bool   (#62 C-4)
 *
 * "Did this run have something the operator needs to be told about?"
 * Gates whether the import shows a result panel at all.
 *
 * 🔴 `report.errors.length > 0` ALONE IS NOT ENOUGH, and that gap is the entire
 * reason this predicate exists rather than an inline `if`. On 2026-08-21 an
 * import dropped 51 of the operator's 110 edited paragraphs and finished with
 * `errors: []`: the paragraphs could not be located, preflight raised 51
 * BLOCKING findings, and `continueOnBlocking` — true by default for the
 * user-facing entry (import_integrated.idjs:618) — waved every one of them
 * through. Output saved, log green, nothing said. A panel keyed on
 * `errors.length` would have stayed silent on exactly the failure it exists to
 * surface.
 *
 * So an unlocated paragraph counts as a problem in its own right. It lives in
 * THIS module because this is where the repo already decides what counts as
 * blocking, and it is exported so the rule can be tested — an unverifiable
 * visibility gate is how the first one stopped working.
 *
 * 🔴 NARROWED 2026-08-22 by owner, and the reason matters more than the change.
 * He watched an ordinary run open the panel and said 「刚刚的就是正常跑的一遍」.
 * The run in question (import_integrated_20260822_100911.log):
 *     preflight 10 blocking, all bypassed via continueOnBlocking
 *     postflight 0 blocking, 0 warning      <- re-run after the emphasis pass
 *     errors 0 · located 109/109
 * ⇒ the gate was bypassed, and then the thing it guards against DID NOT HAPPEN.
 *   Under his definition (「只在出错时出现」) that is not a problem run.
 *
 * ⇒ `preflight_blocking_overridden` NO LONGER opens the panel ON ITS OWN;
 *   `postflight.blocking` does. Preflight says the run STARTED badly, postflight
 *   says it ENDED badly, and only the second is what the operator is being shown.
 *
 * ⚠ IT STILL GOES IN THE LOG. `lib/v2_pipeline.js:2324` writes the
 *   "BLOCKING GATE OVERRIDDEN" line independently of this predicate — that line is
 *   #62 C-3's output and narrowing the panel must not quietly undo it. Verified,
 *   not assumed: the log call is not reached through here.
 */
function runHadOperatorVisibleProblem(report) {
    if (!report) return false;
    if (report.errors && report.errors.length > 0) return true;
    if (report.locate && Number(report.locate.miss) > 0) return true;
    // 🔴 4A (owner 2026-08-22): postflight is what says whether the run ENDED badly.
    // A bypassed preflight gate says the run STARTED badly, and those are not the
    // same question — see the block above for why the second one no longer
    // opens the panel by itself.
    if (report.postflight) {
        var pfb = report.postflight.blocking;
        var n = Array.isArray(pfb) ? pfb.length : Number(report.postflight.blocking_count || 0);
        if (n > 0) return true;
    }
    return false;
}

module.exports = {
    REPLACEMENT_CHARS: REPLACEMENT_CHARS,
    DEFAULT_SEVERITY: DEFAULT_SEVERITY,
    runPreflight: runPreflight,
    runPostflight: runPostflight,
    categorize: categorize,
    runHadOperatorVisibleProblem: runHadOperatorVisibleProblem,
    // Individual checks (testable separately)
    checkFontsFromPlan: checkFontsFromPlan,
    checkMissingLinks: checkMissingLinks,
    checkReplacementChars: checkReplacementChars,
    checkLocateResults: checkLocateResults,
    checkOversetText: checkOversetText,
    _internal: {
        _hasReplacementChar: _hasReplacementChar,
        _getCollectionItem: _getCollectionItem
    }
};
