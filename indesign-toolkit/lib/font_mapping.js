"use strict";

/**
 * lib/font_mapping.js
 *
 * Phase 2 MVP — 字体策略 (font_policy)
 *
 * Plan reference:
 *   task_plan.md "字体策略 (MVP 必含 - PRD S4 / 约束 66)"
 *   - PRD.md:46 S4: 缺字/字体缺失 → 一期硬错误拦截
 *   - PRD.md:66: "缺字/替代字体需明确策略"
 *
 * Responsibility:
 *   Resolve fonts for translation:
 *     - CJK: preference list, first INSTALLED wins
 *     - Latin: preserve_source mode (use source font if available, else
 *              walk fallback_chain)
 *   Detect missing fonts before commit (feeds preflight gate).
 *
 * MVP scope (per plan):
 *   - resolveCJKFont(doc, policy) → {font, name, source, attempted?}
 *   - resolveLatinFont(doc, sourceFontName, policy) →
 *       {name, source: "source"|"fallback"|"missing", original?, attempted?}
 *   - scanMissingFonts(doc, segments, policy) → [{kind, font, attempted}]
 *
 * NOT in MVP (E16 follow-up):
 *   - latin.mode = "force_to" / "explicit_map"
 *   - cjk.per_role (heading/body 用不同 CJK 字体)
 *   - applyFontMapping(doc, mapping, scope) standalone
 *
 * UXP / ExtendScript compatibility:
 *   - Pure module, no IO
 *   - All InDesign API access via deps:
 *       deps.findFont(name) → font object or null
 *           (caller injects wrapper around app.fonts.itemByName + status check)
 *       deps.FontStatus → indesign.FontStatus enum (for status comparison)
 *   - var only, no ES6+
 */

// ─── Default policy (per plan) ────────────────────────────────────

var DEFAULT_FONT_POLICY = {
    cjk: {
        preference: [
            "Source Han Sans CN",
            "Microsoft YaHei",
            "PingFang SC",
            "SimSun"
        ]
    },
    latin: {
        mode: "preserve_source",
        fallback_chain: [
            "Helvetica",
            "Arial",
            "Times New Roman"
        ]
    }
};

function _mergeDefaults(policy) {
    var p = policy || {};
    var cjk = p.cjk || {};
    var latin = p.latin || {};
    return {
        cjk: {
            preference: cjk.preference || DEFAULT_FONT_POLICY.cjk.preference.slice()
        },
        latin: {
            mode: latin.mode || DEFAULT_FONT_POLICY.latin.mode,
            fallback_chain: latin.fallback_chain || DEFAULT_FONT_POLICY.latin.fallback_chain.slice()
        }
    };
}

// ─── CJK font resolution ──────────────────────────────────────────

/**
 * Find first INSTALLED font from preference list.
 *
 * @returns {Object} {font, name, source, attempted?}
 *   - on hit:  {font: <fontObj>, name: "Source Han Sans CN", source: "preference"}
 *   - on miss: {font: null, name: null, source: "missing", attempted: [...]}
 */
function resolveCJKFont(doc, policy, deps) {
    var p = _mergeDefaults(policy);
    if (!deps || typeof deps.findFont !== "function") {
        throw new Error("resolveCJKFont: deps.findFont required");
    }

    var attempted = [];

    // #E2E-8 (reverted): "Prefer document's actual CJK font" branch deferred
    // to the later font-compliance pass. For now, use the preference
    // fallback list uniformly — that means CJK paragraphs land on
    // `Source Han Sans CN` (or whatever's top of preference) regardless of
    // what the source doc used. Visual will diverge from source typography
    // for now; correct mapping handled in the dedicated font-compliance
    // milestone where missing-weight fallback within a family is also
    // addressed.

    for (var i = 0; i < p.cjk.preference.length; i++) {
        var candidate = p.cjk.preference[i];
        attempted.push(candidate);
        var font = deps.findFont(candidate);
        if (font) {
            return {
                font: font,
                name: candidate,
                source: "preference",
                rank: i
            };
        }
    }
    return {
        font: null,
        name: null,
        source: "missing",
        attempted: attempted
    };
}

// ─── Latin font resolution ────────────────────────────────────────

/**
 * Resolve Latin font in preserve_source mode:
 *   1. If sourceFontName is installed → use it
 *   2. Else walk fallback_chain → first installed wins
 *   3. Else → missing
 *
 * @returns {Object} {name, source, original?, attempted?}
 *   - on source hit:   {name: "Myriad Pro", source: "source"}
 *   - on fallback hit: {name: "Helvetica", source: "fallback", original: "Myriad Pro"}
 *   - on miss:         {name: null, source: "missing", original: "Myriad Pro", attempted: [...]}
 */
function resolveLatinFont(doc, sourceFontName, policy, deps) {
    var p = _mergeDefaults(policy);
    if (!deps || typeof deps.findFont !== "function") {
        throw new Error("resolveLatinFont: deps.findFont required");
    }

    if (p.latin.mode !== "preserve_source") {
        // E16 modes (force_to / explicit_map) not implemented in MVP
        throw new Error("resolveLatinFont: latin.mode '" + p.latin.mode + "' not supported in MVP (E16 follow-up)");
    }

    // Try source font first
    if (sourceFontName) {
        var sourceFont = deps.findFont(sourceFontName);
        if (sourceFont) {
            return {
                name: sourceFontName,
                source: "source"
            };
        }
    }

    // Walk fallback chain
    var attempted = sourceFontName ? [sourceFontName] : [];
    for (var i = 0; i < p.latin.fallback_chain.length; i++) {
        var fallback = p.latin.fallback_chain[i];
        attempted.push(fallback);
        var fbFont = deps.findFont(fallback);
        if (fbFont) {
            return {
                name: fallback,
                source: "fallback",
                original: sourceFontName,
                rank: i
            };
        }
    }

    return {
        name: null,
        source: "missing",
        original: sourceFontName,
        attempted: attempted
    };
}

// ─── Missing-font scan ────────────────────────────────────────────

/**
 * Pre-scan all fonts that the import will need.
 *
 * Walks segments, collects unique baseline.fontFamily values, attempts
 * to resolve each via Latin policy. Also resolves the global CJK font.
 *
 * @returns {Array} list of issues:
 *   {kind: "cjk_missing", attempted: [...]}
 *   {kind: "latin_missing", font: "Myriad Pro", attempted: [...]}
 *   {kind: "latin_substituted", original: "Myriad Pro", used: "Arial"}
 *
 * Empty array means all fonts resolved fine.
 */
function scanMissingFonts(doc, segments, policy, deps) {
    var p = _mergeDefaults(policy);
    var issues = [];

    // 1. CJK
    var cjkResult = resolveCJKFont(doc, p, deps);
    if (cjkResult.source === "missing") {
        issues.push({
            kind: "cjk_missing",
            attempted: cjkResult.attempted
        });
    }

    // 2. Latin: collect unique source fonts from segments
    var seenLatin = {};
    if (segments && segments.length) {
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            if (!seg || !seg.format_snapshot || !seg.format_snapshot.baseline) continue;
            var f = seg.format_snapshot.baseline.fontFamily;
            if (!f) continue;
            seenLatin[f] = (seenLatin[f] || 0) + 1;
            // Also walk runs
            var runs = seg.format_snapshot.runs;
            if (runs && runs.length) {
                for (var r = 0; r < runs.length; r++) {
                    var rf = runs[r].fontFamily;
                    if (rf) seenLatin[rf] = (seenLatin[rf] || 0) + 1;
                }
            }
        }
    }

    for (var fontName in seenLatin) {
        if (!seenLatin.hasOwnProperty(fontName)) continue;
        var latinResult = resolveLatinFont(doc, fontName, p, deps);
        if (latinResult.source === "missing") {
            issues.push({
                kind: "latin_missing",
                font: fontName,
                attempted: latinResult.attempted,
                segment_count: seenLatin[fontName]
            });
        } else if (latinResult.source === "fallback") {
            issues.push({
                kind: "latin_substituted",
                original: fontName,
                used: latinResult.name,
                segment_count: seenLatin[fontName]
            });
        }
        // source === "source" → no issue
    }

    return issues;
}

// ─── Module exports ────────────────────────────────────────────────

module.exports = {
    DEFAULT_FONT_POLICY: DEFAULT_FONT_POLICY,
    resolveCJKFont: resolveCJKFont,
    resolveLatinFont: resolveLatinFont,
    scanMissingFonts: scanMissingFonts,
    _internal: {
        _mergeDefaults: _mergeDefaults
    }
};
