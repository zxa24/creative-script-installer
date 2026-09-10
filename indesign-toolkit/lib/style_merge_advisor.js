"use strict";

/**
 * lib/style_merge_advisor.js
 *
 * Post-buildStylePlan analysis: identifies near-duplicate paragraph-style
 * clusters that differ only in small numeric dimensions (fontSize / leading
 * / indents / spacing) but share all qualitative features (font, weight,
 * color, alignment, bullets, composer).
 *
 * Two functions:
 *
 *   findNearDuplicateGroups(plan, segments, [tolerance])
 *     Returns [{ variants:[planEntry, ...], confidence:HIGH/MEDIUM/LOW,
 *                qualKey, qualSummary, totalParas, suggestedTarget }, ...]
 *
 *   mergeGroupsAtConfidence(plan, segments, threshold)
 *     Mutates plan to absorb minority variants into majority.
 *     For each group at >= threshold:
 *       - Pick variant with most paragraphs as "winner" (target)
 *       - Remove minority variants from plan.paraStylesToCreate
 *       - Extend winner.tids to include all minority tids
 *       - Add plan.fingerprintRedirect[minorityFp] = winnerFp so that
 *         commitStylePlan can populate paraStyleMap with both keys
 *         pointing to the same paragraph style object
 *     threshold = "high" | "high+medium" | "all"
 *     Returns merge summary.
 */

var DEFAULT_TOLERANCE = {
    fontSize_pt: 1.0,
    leading_pt: 2.0,
    indent_pt: 2.0,
    space_pt: 2.0
};

// Hybrid mode tunables — KDE peak detection within each qualKey bucket.
// Bandwidth = max(MAD, IQR) × 1.4826 / 1.349 × Silverman scaling.
//
// A sample is absorbed into its nearest peak only if ALL three checks pass:
//   1. distance ≤ outlierBandwidthMul × bandwidth
//   2. distance ≤ max(outlierMinPt, peakSize × outlierMaxAbsoluteRatio)
//   3. relative diff ≤ outlierMaxRelativeDiff
// Otherwise it stays as a singleton "outlier" cluster — never merged.
//
// The absolute cap (rule 2) used to be a fixed 4pt — too loose at body
// sizes (4pt = 50% of an 8pt body) and too tight at display sizes (4pt =
// 5% of 80pt). Now scales with peak size: 10% of peak by default, with a
// 2pt floor so very small body buckets aren't over-tightened. At small
// sizes the relative cap (rule 3) usually wins; at large sizes the
// proportional abs cap usually wins.
//
// Examples at default (medium) settings:
//   peak 6pt:  absCap = max(2, 0.6)  = 2pt   ← rel (1.2pt) usually stricter
//   peak 12pt: absCap = max(2, 1.2)  = 2pt   ← rel (2.4pt) usually stricter
//   peak 24pt: absCap = max(2, 2.4)  = 2.4pt
//   peak 48pt: absCap = max(2, 4.8)  = 4.8pt ← was 4pt (slightly looser)
//   peak 80pt: absCap = max(2, 8.0)  = 8pt   ← was 4pt (much looser)
var HYBRID_DEFAULTS = {
    bandwidthFloorSigma: 0.3,
    outlierBandwidthMul: 2,
    outlierMinPt: 2,                       // absolute floor (in pt)
    outlierMaxAbsoluteRatio: 0.10,         // 10% of peak size
    outlierMaxRelativeDiff: 0.20,
    peakRelativeFloor: 0.05    // ignore KDE peaks below 5% of tallest
};

function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function _abs(n) { return n < 0 ? -n : n; }

// Color key — strict imperceptible-only tolerance. Mirrors
// lib/style_sheet_builder.js _colorKey, kept in sync by hand.
// Converts CMYK/RGB to a common RGB representation rounded to nearest
// integer (ΔE76 ~0.5-1 = at or below human perception). Different swatches
// with non-trivial channel diffs stay separate — this is by design so
// designer-distinguishable colors aren't silently collapsed.
function _cmykToRgb(c, m, y, k) {
    var cn = (Number(c) || 0) / 100;
    var mn = (Number(m) || 0) / 100;
    var yn = (Number(y) || 0) / 100;
    var kn = (Number(k) || 0) / 100;
    return [
        Math.round(255 * (1 - cn) * (1 - kn)),
        Math.round(255 * (1 - mn) * (1 - kn)),
        Math.round(255 * (1 - yn) * (1 - kn))
    ];
}

function _fillColorBucket(fillColor) {
    if (!fillColor) return "?";
    if (fillColor.swatch === "[None]") return "none";
    if (fillColor.canonicalRGB && fillColor.canonicalRGB.length >= 3) {
        return "rgb:" + fillColor.canonicalRGB[0] + "," + fillColor.canonicalRGB[1] + "," + fillColor.canonicalRGB[2];
    }
    if (fillColor.displayedRGB && fillColor.displayedRGB.length >= 3) {
        return "rgb:" + fillColor.displayedRGB[0] + "," + fillColor.displayedRGB[1] + "," + fillColor.displayedRGB[2];
    }
    var vals = fillColor.values || [];
    if (vals.length === 0) return "swatch:" + (fillColor.swatch || "?");
    var space = String(fillColor.space || "?");
    var rgb = null;
    if (space === "RGB" && vals.length >= 3) {
        rgb = [Math.round(vals[0]), Math.round(vals[1]), Math.round(vals[2])];
    } else if (space === "CMYK" && vals.length >= 4) {
        rgb = _cmykToRgb(vals[0], vals[1], vals[2], vals[3]);
    }
    if (rgb) return "rgb:" + rgb[0] + "," + rgb[1] + "," + rgb[2];
    var rounded = [];
    for (var i = 0; i < vals.length; i++) rounded.push(Math.round(vals[i]));
    return space + ":" + rounded.join(",");
}

// [indent-general · impl-audit R2 codex P1·A] Normalized tab-stop bucket for the merge
// qualKey — WITHOUT it, the auto-merge (mergeGroupsAtConfidence) re-collapses two clusters
// that differ ONLY in tab stops (fingerprint already keys tabs, but the merge advisor has a
// SEPARATE qualKey), redirecting the absorbed paragraph to the winner's tabs (silent
// data-loss). Position rounded to 0.5pt like the other numeric qualKey axes; "-" when empty.
function _tabStopsBucket(tabStops) {
    if (!tabStops || !tabStops.length) return "-";
    var parts = [];
    for (var i = 0; i < tabStops.length; i++) {
        var t = tabStops[i];
        if (!t || typeof t.position !== "number") continue;
        parts.push((Math.round(t.position * 2) / 2) + ":" + (t.alignment || "") + ":" + (t.leader || "") + ":" + (t.alignment_char || ""));
    }
    parts.sort();   // order-independent (InDesign returns position-sorted, but be robust)
    return parts.length ? parts.join(",") : "-";
}

// Build per-plan-entry effective properties from the FIRST tid's segment.
// (All tids in a fingerprint cluster share the snapshot — pick one.)
function _entryEffectiveProps(planEntry, segmentsByTid) {
    if (!planEntry.tids || !planEntry.tids.length) return null;
    var seg = segmentsByTid[planEntry.tids[0]];
    if (!seg || !seg.format_snapshot || !seg.paragraph_snapshot) return null;
    var b = seg.format_snapshot.baseline;
    var ps = seg.paragraph_snapshot;
    return {
        fontFamily: b.fontFamily || "?",
        fontStyle: b.fontStyle || "Regular",
        fillColor: _fillColorBucket(b.fillColor),
        justification: ps.justification || "?",
        bullets: ps.bullets_and_numbering_type || "NO_LIST",
        composer: ps.composer || "?",
        fontSize: _round2(b.fontSize),
        leading: ps.leading === "AUTO" ? "AUTO" : _round2(ps.leading),
        autoLeading: (typeof ps.auto_leading === "number" && ps.auto_leading > 0) ? ps.auto_leading : 120,
        leftIndent: _round2(ps.left_indent),
        rightIndent: _round2(ps.right_indent),
        firstLineIndent: _round2(ps.first_line_indent),
        spaceBefore: _round2(ps.space_before),
        spaceAfter: _round2(ps.space_after),
        // [indent-general] tab config as a qualKey axis so auto-merge can't collapse
        // tab-distinct clusters (mirror of the fingerprint's tabStops keying).
        tabStops: _tabStopsBucket(ps.tab_stops),
        // #E2E-7: surface underline / strikeThrough so _qualKey can keep
        // under:true and under:false paragraphs in separate merge buckets.
        // Previously the KDE pass would absorb a link-paragraph (under:true)
        // into a regular-paragraph (under:false) winner with the same color,
        // silently stripping the underline visual from Client-A eclipse / CashBack.
        underline: !!b.underline,
        strikeThrough: !!b.strikeThrough,
        // #28: surface origin so _qualKey can keep master+body in
        // separate merge buckets when splitMasterFromBody is on.
        is_master: !!seg.is_master
    };
}

/**
 * Resolve a (leading, fontSize, autoLeading) triple to an effective
 * numeric leading in points so AUTO + numeric variants can be compared
 * on a common axis. AUTO leading multiplies fontSize by autoLeading%
 * (default 120) — the same calculation InDesign uses at render time.
 *
 * Returns the numeric leading itself when leading is already numeric;
 * fontSize × multiplier when leading is "AUTO"; null when neither is
 * usable (skip from KDE).
 */
function _effectiveLeading(props) {
    if (!props) return null;
    if (typeof props.leading === "number" && isFinite(props.leading)) return props.leading;
    if (props.leading === "AUTO") {
        var mult = (typeof props.autoLeading === "number" && props.autoLeading > 0) ? props.autoLeading : 120;
        var fs = (typeof props.fontSize === "number" && props.fontSize > 0) ? props.fontSize : 0;
        if (fs > 0) return _round2(fs * mult / 100);
    }
    return null;
}

// Default qualKey dimensions — used when caller doesn't pass an override.
// These are the "qualitative" axes that traditionally separate paragraph
// styles (font/weight/color/alignment/bullets/composer). When the caller
// passes a `dimensions` map, we honor it: an axis must be true in
// dimensions to be included in qualKey. Axes not in this list (fontSize,
// leading, etc.) are quantitative and handled by KDE/tolerance, not qualKey.
// #E2E-7: underline / strikeThrough are added so hybrid KDE can NEVER absorb
// a paragraph with underline=true into a paragraph with underline=false (or
// vice versa). Even when fontFamily/fontStyle/fontSize/color match, decorated
// vs undecorated baselines are semantically distinct paragraph identities.
var QUALKEY_AXES = ["fontFamily", "fontStyle", "fillColor", "underline", "strikeThrough",
                    "justification", "bullets", "composer",
                    "leftIndent", "rightIndent", "firstLineIndent", "spaceBefore", "spaceAfter",
                    "tabStops"];

function _qualKey(p, dimensions, splitMasterFromBody) {
    var parts = [];
    // #28: when splitMasterFromBody is enabled, prefix the qual key
    // with the origin tag so master and body entries land in separate
    // merge buckets — autoMerge's KDE/hybrid pass can never collapse
    // a master cluster into a body one and vice versa.
    if (splitMasterFromBody) {
        parts.push(p.is_master ? "ORIG_M" : "ORIG_B");
    }
    for (var i = 0; i < QUALKEY_AXES.length; i++) {
        var axis = QUALKEY_AXES[i];
        // Include only if dimensions is null (default = include all) or
        // the axis is explicitly true in dimensions.
        // [impl-audit R3 codex+n1 P1·A] EXCEPTION: tabStops is keyed ALWAYS-ON (unless
        // explicitly disabled) to MIRROR the fingerprint's `dim.tabStops !== false` gating
        // (style_sheet_builder). Without this, a PARTIAL `dimensions` map that omits a
        // tabStops key (e.g. reorganize-dialog GROUPING_DIMENSIONS + _applyRareDimensions,
        // which set tracking/scale but not tabStops) drops `TB:` here while the fingerprint
        // still splits by tabs → auto-merge re-collapses a tab-distinct cluster and the
        // absorbed paragraph inherits the winner's tabs (silent layout data-loss). This
        // consumer-side gate closes it for EVERY dimensions producer, not just the 2 dialogs.
        // (General drift rule: any axis relying on the fingerprint's `!== false` default-ON
        // must also be default-ON here, or the merge silently drops it.)
        var _include = (axis === "tabStops")
            ? (!dimensions || dimensions.tabStops !== false)
            : (!dimensions || dimensions[axis] === true);
        if (_include) {
            // Map axis name → property on `p` (built by _entryEffectiveProps)
            if (axis === "fontFamily") parts.push("F:" + (p.fontFamily || "?"));
            else if (axis === "fontStyle") parts.push("S:" + (p.fontStyle || "?"));
            else if (axis === "fillColor") parts.push("C:" + (p.fillColor || "?"));
            // #E2E-7: include underline/strikeThrough as bucketing keys
            else if (axis === "underline") parts.push("U:" + (p.underline ? "1" : "0"));
            else if (axis === "strikeThrough") parts.push("ST:" + (p.strikeThrough ? "1" : "0"));
            else if (axis === "justification") parts.push("J:" + (p.justification || "?"));
            else if (axis === "bullets") parts.push("B:" + (p.bullets || "?"));
            else if (axis === "composer") parts.push("M:" + (p.composer || "?"));
            // Numeric axes (when user explicitly enables): bucket to nearest
            // 0.5pt to absorb FP noise but otherwise distinct values stay
            // separate. Prevents hybrid merge from collapsing across
            // genuinely different indents/spacing.
            else if (axis === "leftIndent")     parts.push("LI:" + Math.round((p.leftIndent || 0) * 2) / 2);
            else if (axis === "rightIndent")    parts.push("RI:" + Math.round((p.rightIndent || 0) * 2) / 2);
            else if (axis === "firstLineIndent") parts.push("FI:" + Math.round((p.firstLineIndent || 0) * 2) / 2);
            else if (axis === "spaceBefore")    parts.push("SB:" + Math.round((p.spaceBefore || 0) * 2) / 2);
            else if (axis === "spaceAfter")     parts.push("SA:" + Math.round((p.spaceAfter || 0) * 2) / 2);
            else if (axis === "tabStops")       parts.push("TB:" + (p.tabStops || "-"));
        }
    }
    return parts.join("‖");
}

function _withinTolerance(a, b, tol) {
    if (a.fontFamily !== b.fontFamily) return false;
    if (_abs(a.fontSize - b.fontSize) > tol.fontSize_pt) return false;
    // Compare leadings on their effective numeric value so AUTO and numeric
    // can match when the resolved leading (fontSize × autoLeading%) is
    // within tolerance. Previously AUTO + numeric was a hard reject which
    // missed the common pattern of one paragraph using AUTO and another
    // setting an explicit leading that happens to equal AUTO's resolution.
    var aEff = _effectiveLeading(a);
    var bEff = _effectiveLeading(b);
    if (aEff === null || bEff === null) {
        // One side couldn't be resolved (e.g. missing fontSize for AUTO).
        // Fall back to strict equality.
        if (a.leading !== b.leading) return false;
    } else if (_abs(aEff - bEff) > tol.leading_pt) {
        return false;
    }
    if (_abs(a.leftIndent - b.leftIndent) > tol.indent_pt) return false;
    if (_abs(a.rightIndent - b.rightIndent) > tol.indent_pt) return false;
    if (_abs(a.firstLineIndent - b.firstLineIndent) > tol.indent_pt) return false;
    if (_abs(a.spaceBefore - b.spaceBefore) > tol.space_pt) return false;
    if (_abs(a.spaceAfter - b.spaceAfter) > tol.space_pt) return false;
    return true;
}

function _classifyConfidence(group, segmentsByTid) {
    // Signal 1: source style uniformity
    var allStyles = {};
    var styledSegmentCount = 0;
    group.variants.forEach(function (v) {
        v.tids.forEach(function (tid) {
            var seg = segmentsByTid[tid];
            if (seg && seg.paragraph_style) {
                allStyles[seg.paragraph_style] = true;
                styledSegmentCount++;
            }
        });
    });
    var styleCount = Object.keys(allStyles).length;
    // styleCount === 1 → all known segments agree on the same source style.
    // styleCount === 0 → no segment carries paragraph_style (typical of the
    // reorganize flow's capture, which doesn't write that field). Treat as
    // "unknown but presumed coherent" so the rest of the confidence rules
    // can still run; otherwise reorganize-flow merges always cap at LOW
    // and --auto-merge=high silently rejects every group.
    var sameSourceStyle = (styleCount === 1) || (styleCount === 0 && styledSegmentCount === 0);

    // Signal 2: outlier asymmetry
    var maxCount = 0, totalCount = 0;
    group.variants.forEach(function (v) {
        var c = v.tids.length;
        if (c > maxCount) maxCount = c;
        totalCount += c;
    });
    var outlierRatio = totalCount > 0 ? maxCount / totalCount : 0;

    // Signal 3: relative size difference
    var sizes = group.variants.map(function (v) { return v.props.fontSize; });
    var maxSize = Math.max.apply(null, sizes);
    var minSize = Math.min.apply(null, sizes);
    var sizeRelDiff = maxSize > 0 ? (maxSize - minSize) / maxSize : 0;

    var reason = [];
    reason.push(sameSourceStyle ? "same source style" : (styleCount + " source styles"));
    if (outlierRatio >= 0.8) reason.push("strong majority/outlier");
    else if (outlierRatio >= 0.6) reason.push("moderate majority");
    else reason.push("balanced counts");
    if (sizeRelDiff < 0.05) reason.push("size diff <5%");
    else if (sizeRelDiff < 0.15) reason.push("size diff <15%");
    else reason.push("size diff " + Math.round(sizeRelDiff * 100) + "%");

    var confidence;
    if (sameSourceStyle && outlierRatio >= 0.6 && sizeRelDiff < 0.15) confidence = "HIGH";
    else if (sameSourceStyle && sizeRelDiff < 0.05) confidence = "HIGH";
    else if (!sameSourceStyle && outlierRatio < 0.7) confidence = "LOW";
    else confidence = "MEDIUM";

    return {
        confidence: confidence,
        reason: reason.join(", "),
        sameSourceStyle: sameSourceStyle,
        sourceStyles: Object.keys(allStyles),
        outlierRatio: outlierRatio,
        sizeRelDiff: sizeRelDiff
    };
}

// ─── Hybrid (MAD+IQR KDE peak detection) ──────────────────────────
//
// Replaces the ±1pt union-find pass with Gaussian KDE on the fontSize axis
// inside each qualKey bucket. Robust to:
//   - mode-dominant distributions (IQR fallback when MAD = 0)
//   - extreme outliers (MAD ignores them; outlier threshold isolates them)
// Within each detected peak, every variant becomes mergeable into the
// majority winner. Outliers (samples > outlierThreshold from any peak)
// are kept as singleton clusters (NOT merged).
//
// Limitation: bandwidth selection on multi-modal data has no universal
// solution. Strong mode dominance (>75% at one value) collapses both MAD
// and IQR to 0 → bw floors to 0.3σ → outlier-ish singletons may not merge.
// This is conservative (better to leave a style alone than over-merge).

function _madBandwidth(values) {
    var n = values.length;
    if (n < 2) return 0.5;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(n / 2)];
    var deviations = sorted.map(function (v) { return _abs(v - med); }).sort(function (a, b) { return a - b; });
    var mad = deviations[Math.floor(n / 2)];
    var sigmaMad = 1.4826 * mad;
    var q1 = sorted[Math.floor(n * 0.25)];
    var q3 = sorted[Math.floor(n * 0.75)];
    var sigmaIqr = (q3 - q1) / 1.349;
    var sigmaRobust = Math.max(sigmaMad, sigmaIqr);
    if (sigmaRobust < HYBRID_DEFAULTS.bandwidthFloorSigma) sigmaRobust = HYBRID_DEFAULTS.bandwidthFloorSigma;
    return 1.06 * sigmaRobust * Math.pow(n, -1 / 5);
}

function _kdeAt(x, samples, h) {
    var n = samples.length;
    var sum = 0;
    var c = 1 / (Math.sqrt(2 * Math.PI) * h);
    for (var i = 0; i < n; i++) {
        var u = (x - samples[i]) / h;
        sum += Math.exp(-0.5 * u * u);
    }
    return (sum / n) * c;
}

// Returns { bandwidth, peaks: [{ x, density, members: [valueIdx,...] }], outlierIdx: [...] }
function _kdePeakDetect(values, opts) {
    if (values.length === 0) return { bandwidth: 0, peaks: [], outlierIdx: [] };
    if (values.length === 1) return { bandwidth: 0, peaks: [{ x: values[0], density: 1, members: [0] }], outlierIdx: [] };

    opts = opts || {};
    var bwMulOpt    = (opts.outlierBandwidthMul    != null) ? opts.outlierBandwidthMul    : HYBRID_DEFAULTS.outlierBandwidthMul;
    var minPtOpt    = (opts.outlierMinPt           != null) ? opts.outlierMinPt           : HYBRID_DEFAULTS.outlierMinPt;
    var absRatioOpt = (opts.outlierMaxAbsoluteRatio != null) ? opts.outlierMaxAbsoluteRatio : HYBRID_DEFAULTS.outlierMaxAbsoluteRatio;
    var relOpt      = (opts.outlierMaxRelativeDiff  != null) ? opts.outlierMaxRelativeDiff  : HYBRID_DEFAULTS.outlierMaxRelativeDiff;
    var floorOpt    = (opts.peakRelativeFloor       != null) ? opts.peakRelativeFloor       : HYBRID_DEFAULTS.peakRelativeFloor;

    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var lo = sorted[0] - 1, hi = sorted[sorted.length - 1] + 1;
    var h = _madBandwidth(values);

    // KDE on a 0.1pt grid
    var step = 0.1;
    var grid = [], dens = [];
    for (var x = lo; x <= hi; x += step) {
        grid.push(x);
        dens.push(_kdeAt(x, values, h));
    }
    var maxDens = Math.max.apply(null, dens);
    var minPeakDens = maxDens * floorOpt;

    // Local maxima
    var peaks = [];
    for (var i = 1; i < dens.length - 1; i++) {
        if (dens[i] > dens[i - 1] && dens[i] > dens[i + 1] && dens[i] >= minPeakDens) {
            peaks.push({ x: Math.round(grid[i] * 10) / 10, density: dens[i], members: [] });
        }
    }
    if (peaks.length === 0) {
        peaks.push({ x: sorted[Math.floor(sorted.length / 2)], density: 1, members: [] });
    }

    // Assign each value to nearest peak. A sample is absorbed only if it
    // passes ALL three caps: bandwidth-relative, absolute-pt (proportional
    // to peak size), relative-%. Otherwise it stays as a singleton outlier.
    // The absCap is computed PER PEAK so large headlines and small body
    // text get appropriately scaled tolerance.
    var bwCap = Math.max(bwMulOpt * h, minPtOpt);
    var relCap = relOpt;
    var outlierIdx = [];
    for (var v = 0; v < values.length; v++) {
        var val = values[v];
        var best = -1, bestDist = Infinity;
        for (var pi = 0; pi < peaks.length; pi++) {
            var dist = _abs(val - peaks[pi].x);
            if (dist < bestDist) { bestDist = dist; best = pi; }
        }
        var peakX = best >= 0 ? peaks[best].x : 0;
        var absCap = Math.max(minPtOpt, peakX * absRatioOpt);
        var relDiff = peakX > 0 ? bestDist / peakX : 1;
        if (bestDist > bwCap || bestDist > absCap || relDiff > relCap) {
            outlierIdx.push(v);
        } else {
            peaks[best].members.push(v);
        }
    }

    return { bandwidth: Math.round(h * 100) / 100, peaks: peaks, outlierIdx: outlierIdx };
}

// Build groups in the same shape as findNearDuplicateGroups, but using
// hybrid KDE peak detection within each qualKey bucket. Each peak that
// contains ≥2 variants becomes a merge group. Single-variant peaks and
// outlier variants are NOT emitted (nothing to merge).
function findHybridGroups(plan, segments, hybridOpts) {
    hybridOpts = hybridOpts || {};
    var bwMulOpt    = (hybridOpts.outlierBandwidthMul    != null) ? hybridOpts.outlierBandwidthMul    : HYBRID_DEFAULTS.outlierBandwidthMul;
    var minPtOpt    = (hybridOpts.outlierMinPt           != null) ? hybridOpts.outlierMinPt           : HYBRID_DEFAULTS.outlierMinPt;
    var absRatioOpt = (hybridOpts.outlierMaxAbsoluteRatio != null) ? hybridOpts.outlierMaxAbsoluteRatio : HYBRID_DEFAULTS.outlierMaxAbsoluteRatio;
    var relOpt      = (hybridOpts.outlierMaxRelativeDiff  != null) ? hybridOpts.outlierMaxRelativeDiff  : HYBRID_DEFAULTS.outlierMaxRelativeDiff;
    // Honor user's "leading" dimension choice: if leading was excluded from
    // the fingerprint (user unchecked it in the dialog), don't re-impose a
    // leading sub-bucket here either — that would silently override their
    // intent that "leading shouldn't separate styles". When fingerprintOpts
    // is missing or doesn't restrict dimensions, default to the safety check.
    // Sub-bucket by leading only if user kept leading as a fingerprint
    // dimension. When fingerprintOpts is null/missing → default: include
    // (preserves legacy behavior). When dimensions provided but leading
    // is not explicitly true (false or undefined) → skip sub-bucket.
    var subBucketByLeading = true;
    var fpOpts = plan && plan.fingerprintOpts;
    if (fpOpts && fpOpts.dimensions && fpOpts.dimensions.leading !== true) {
        subBucketByLeading = false;
    }
    var segmentsByTid = {};
    for (var i = 0; i < segments.length; i++) {
        if (segments[i] && segments[i].tid) segmentsByTid[segments[i].tid] = segments[i];
    }
    var entries = [];
    for (var pi = 0; pi < plan.paraStylesToCreate.length; pi++) {
        var pe = plan.paraStylesToCreate[pi];
        var props = _entryEffectiveProps(pe, segmentsByTid);
        if (!props) continue;
        entries.push({
            planEntry: pe,
            fingerprint: pe.fingerprint,
            tids: pe.tids || [],
            paraCount: (pe.tids || []).length,
            props: props,
            qualKey: _qualKey(props, plan && plan.fingerprintOpts && plan.fingerprintOpts.dimensions, plan && plan.fingerprintOpts && plan.fingerprintOpts.splitMasterFromBody)
        });
    }
    var qualGroups = {};
    entries.forEach(function (e) {
        if (!qualGroups[e.qualKey]) qualGroups[e.qualKey] = [];
        qualGroups[e.qualKey].push(e);
    });

    var hybridGroups = [];
    for (var qk in qualGroups) {
        if (!qualGroups.hasOwnProperty(qk)) continue;
        var bucket = qualGroups[qk];
        if (bucket.length < 2) continue;

        // Run KDE peak detection on the fontSize axis only. Leading is
        // a secondary check we apply per-peak — variants with very
        // different leading shouldn't merge even if size matches.
        var sizes = bucket.map(function (e) { return e.props.fontSize; });
        var pk = _kdePeakDetect(sizes, hybridOpts);

        // Inter-peak merging: when two adjacent peaks each contain only one
        // plan entry (so KDE can't merge intra-peak), check if those
        // singletons are within the user's caps and combine them. Common
        // case: 48pt and 49pt headlines forming 2 separate peaks because
        // bandwidth floored to 0.2pt — relative diff 2% should clearly
        // merge. Sort peaks by x asc; iterate adjacent pairs.
        if (pk.peaks.length >= 2) {
            var sortedPeaks = pk.peaks.slice().sort(function (a, b) { return a.x - b.x; });
            for (var pp = 0; pp < sortedPeaks.length - 1; pp++) {
                var pA = sortedPeaks[pp];
                var pB = sortedPeaks[pp + 1];
                if (!pA.members.length || !pB.members.length) continue;
                // Pick representative size for each (median of members)
                var aSizes = pA.members.map(function (idx) { return bucket[idx].props.fontSize; }).sort(function (x, y) { return x - y; });
                var bSizes = pB.members.map(function (idx) { return bucket[idx].props.fontSize; }).sort(function (x, y) { return x - y; });
                var aMed = aSizes[Math.floor(aSizes.length / 2)];
                var bMed = bSizes[Math.floor(bSizes.length / 2)];
                var dist = _abs(aMed - bMed);
                var maxSize = Math.max(aMed, bMed);
                var rel = maxSize > 0 ? dist / maxSize : 1;
                var bwCap = Math.max(bwMulOpt * pk.bandwidth, minPtOpt);
                var absCap = Math.max(minPtOpt, maxSize * absRatioOpt);
                if (dist <= bwCap && dist <= absCap && rel <= relOpt) {
                    // Merge B into A; mark B drained so subsequent iters skip
                    pA.members = pA.members.concat(pB.members);
                    pB.members = [];
                }
            }
        }

        pk.peaks.forEach(function (peak) {
            if (peak.members.length < 2) return;
            // Sub-bucket by leading. The original implementation used a coarse
            // 4pt round (Math.round(leading/4)*4) which has boundary issues:
            // 13.99pt → 12 vs 14.01pt → 16 lands neighbours in different
            // buckets. Replace with a second KDE pass on the leading axis
            // for numeric values; AUTO leading remains its own bucket.
            //
            // When the user excluded `leading` from the fingerprint dimensions
            // (subBucketByLeading=false), skip sub-bucketing entirely — all
            // peak members merge regardless of leading, honoring the user's
            // intent that "leading shouldn't separate styles".
            var subGroups = [];                // [{ key, variants[] }]
            if (!subBucketByLeading) {
                subGroups.push({ key: "ANY", variants: peak.members.map(function (idx) { return bucket[idx]; }) });
            } else {
                // Resolve leading to an effective numeric value per member
                // — AUTO becomes fontSize × autoLeading% so AUTO and numeric
                // variants compare on the same axis. Members whose leading
                // can't be resolved (rare: missing fontSize) become their
                // own singleton sub-group (won't merge).
                var resolvable = [];   // { idx, effective, isAuto }
                peak.members.forEach(function (idx) {
                    var v = bucket[idx];
                    var eff = _effectiveLeading(v.props);
                    if (eff === null) {
                        subGroups.push({
                            key: "L_unresolved",
                            variants: [v]
                        });
                    } else {
                        resolvable.push({ idx: idx, effective: eff, isAuto: v.props.leading === "AUTO" });
                    }
                });
                if (resolvable.length === 1) {
                    var v0 = bucket[resolvable[0].idx];
                    subGroups.push({
                        key: (resolvable[0].isAuto ? "AUTO@" : "L") + resolvable[0].effective,
                        variants: [v0]
                    });
                } else if (resolvable.length >= 2) {
                    var effs = resolvable.map(function (r) { return r.effective; });
                    var lpk = _kdePeakDetect(effs, hybridOpts);
                    lpk.peaks.forEach(function (lpeak) {
                        if (!lpeak.members.length) return;
                        var grpVariants = lpeak.members.map(function (m) { return bucket[resolvable[m].idx]; });
                        var anyAuto = lpeak.members.some(function (m) { return resolvable[m].isAuto; });
                        subGroups.push({
                            key: (anyAuto ? "AUTO~" : "L") + lpeak.x + " bw=" + lpk.bandwidth,
                            variants: grpVariants
                        });
                    });
                    lpk.outlierIdx.forEach(function (m) {
                        var rv = resolvable[m];
                        subGroups.push({
                            key: (rv.isAuto ? "AUTO_outlier@" : "L_outlier") + rv.effective,
                            variants: [bucket[rv.idx]]
                        });
                    });
                }
            }

            subGroups.forEach(function (sg) {
                var variants = sg.variants;
                if (variants.length < 2) return;
                variants.sort(function (a, b) { return a.props.fontSize - b.props.fontSize; });
                // Pick winner = variant with most paragraphs.
                // Tiebreak: prefer AUTO leading. AUTO scales with fontSize so
                // it adapts when other paragraphs in the merged cluster get
                // their fontSize edited later; a fixed numeric leading won't.
                var winnerCandidate = variants[0];
                variants.forEach(function (v) {
                    if (v.paraCount > winnerCandidate.paraCount) {
                        winnerCandidate = v;
                    } else if (v.paraCount === winnerCandidate.paraCount &&
                               v.props.leading === "AUTO" &&
                               winnerCandidate.props.leading !== "AUTO") {
                        winnerCandidate = v;
                    }
                });
                // SECONDARY CAP CHECK: each variant must be within the
                // configured caps relative to the WINNER (not the KDE peak
                // center). Without this, KDE-peak-tolerance can absorb a
                // variant that's far from the winner — e.g. peak@17pt
                // accepts a 20pt variant (3pt < 4pt cap) but the winner
                // is 15pt (5pt away = 33% jump). Filter such variants out.
                var winnerSize = winnerCandidate.props.fontSize;
                var winnerCap = Math.max(bwMulOpt * pk.bandwidth, minPtOpt);
                var winnerAbsCap = Math.max(minPtOpt, winnerSize * absRatioOpt);
                var safeVariants = variants.filter(function (v) {
                    if (v === winnerCandidate) return true;
                    var dist = _abs(v.props.fontSize - winnerSize);
                    var rel = winnerSize > 0 ? dist / winnerSize : 1;
                    return (dist <= winnerCap && dist <= winnerAbsCap && rel <= relOpt);
                });
                if (safeVariants.length < 2) return;
                var totalParas = 0;
                safeVariants.forEach(function (v) { totalParas += v.paraCount; });
                hybridGroups.push({
                    qualKey: qk,
                    qualSummary: {
                        font: safeVariants[0].props.fontFamily + " / " + safeVariants[0].props.fontStyle,
                        color: safeVariants[0].props.fillColor,
                        align: safeVariants[0].props.justification,
                        bullets: safeVariants[0].props.bullets
                    },
                    variants: safeVariants,
                    totalParas: totalParas,
                    winner: winnerCandidate,
                    confidence: "HYBRID",
                    reason: "KDE peak @" + peak.x + "pt bw=" + pk.bandwidth + "pt leading=" + sg.key + " winner=" + winnerSize + "pt",
                    peakX: peak.x,
                    bandwidth: pk.bandwidth
                });
            });
        });
    }
    hybridGroups.sort(function (a, b) { return b.totalParas - a.totalParas; });
    return hybridGroups;
}

function findNearDuplicateGroups(plan, segments, tolerance) {
    var tol = tolerance || DEFAULT_TOLERANCE;
    var segmentsByTid = {};
    for (var i = 0; i < segments.length; i++) {
        if (segments[i] && segments[i].tid) segmentsByTid[segments[i].tid] = segments[i];
    }

    // Build per-plan-entry props
    var entries = [];
    for (var pi = 0; pi < plan.paraStylesToCreate.length; pi++) {
        var pe = plan.paraStylesToCreate[pi];
        var props = _entryEffectiveProps(pe, segmentsByTid);
        if (!props) continue;
        entries.push({
            planEntry: pe,
            fingerprint: pe.fingerprint,
            tids: pe.tids || [],
            paraCount: (pe.tids || []).length,
            props: props,
            qualKey: _qualKey(props, plan && plan.fingerprintOpts && plan.fingerprintOpts.dimensions, plan && plan.fingerprintOpts && plan.fingerprintOpts.splitMasterFromBody)
        });
    }

    // Group by qualKey
    var qualGroups = {};
    entries.forEach(function (e) {
        if (!qualGroups[e.qualKey]) qualGroups[e.qualKey] = [];
        qualGroups[e.qualKey].push(e);
    });

    var nearGroups = [];
    for (var qk in qualGroups) {
        if (!qualGroups.hasOwnProperty(qk)) continue;
        var group = qualGroups[qk];
        if (group.length < 2) continue;
        // Union-find on within-tolerance pairs
        var parent = group.map(function (_, i) { return i; });
        function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
        function union(x, y) { var rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry; }
        for (var i = 0; i < group.length; i++) {
            for (var j = i + 1; j < group.length; j++) {
                if (_withinTolerance(group[i].props, group[j].props, tol)) union(i, j);
            }
        }
        var components = {};
        for (var k = 0; k < group.length; k++) {
            var r = find(k);
            if (!components[r]) components[r] = [];
            components[r].push(group[k]);
        }
        for (var rr in components) {
            if (!components.hasOwnProperty(rr) || components[rr].length < 2) continue;
            var variants = components[rr];
            // Sort by fontSize then leading
            variants.sort(function (a, b) {
                if (a.props.fontSize !== b.props.fontSize) return a.props.fontSize - b.props.fontSize;
                var aL = a.props.leading === "AUTO" ? -1 : a.props.leading;
                var bL = b.props.leading === "AUTO" ? -1 : b.props.leading;
                return aL - bL;
            });
            var totalParas = 0;
            variants.forEach(function (v) { totalParas += v.paraCount; });
            // Pick majority winner
            var winner = variants[0];
            variants.forEach(function (v) { if (v.paraCount > winner.paraCount) winner = v; });
            var grp = {
                qualKey: qk,
                qualSummary: {
                    font: variants[0].props.fontFamily + " / " + variants[0].props.fontStyle,
                    color: variants[0].props.fillColor,
                    align: variants[0].props.justification,
                    bullets: variants[0].props.bullets
                },
                variants: variants,
                totalParas: totalParas,
                winner: winner
            };
            var cls = _classifyConfidence(grp, segmentsByTid);
            grp.confidence = cls.confidence;
            grp.reason = cls.reason;
            grp.sourceStyles = cls.sourceStyles;
            nearGroups.push(grp);
        }
    }
    nearGroups.sort(function (a, b) { return b.totalParas - a.totalParas; });
    return nearGroups;
}

/**
 * Mutate plan to merge near-duplicate clusters at-or-above the specified
 * confidence threshold.
 *
 * threshold:
 *   "high"           — merge HIGH only (safest, conservative)
 *   "high+medium"    — also include MEDIUM (more aggressive)
 *   "all"            — merge all near-dup groups regardless of confidence
 *
 * Mutations:
 *   - Remove minority variants from plan.paraStylesToCreate
 *   - Extend winner's tids to include all minority tids
 *   - Add plan.fingerprintRedirect map (so commitStylePlan can populate
 *     paraStyleMap with both original + redirected fingerprints)
 *
 * Returns: { mergeCount, paragraphsAffected, removedFingerprints, summary[] }
 */
function mergeGroupsAtConfidence(plan, segments, threshold, tolerance, hybridOpts) {
    if (!plan || !plan.paraStylesToCreate) throw new Error("mergeGroupsAtConfidence: plan required");
    // Dispatch: "hybrid" uses KDE peak detection; everything else uses
    // pairwise-tolerance union-find with confidence classification.
    var groups, allowed;
    if (threshold === "hybrid") {
        groups = findHybridGroups(plan, segments, hybridOpts);
        allowed = ["HYBRID"];
    } else {
        groups = findNearDuplicateGroups(plan, segments, tolerance);
        var thresholdLevels = { high: ["HIGH"], "high+medium": ["HIGH", "MEDIUM"], all: ["HIGH", "MEDIUM", "LOW"] };
        allowed = thresholdLevels[threshold] || ["HIGH"];
    }

    if (!plan.fingerprintRedirect) plan.fingerprintRedirect = {};

    var mergeCount = 0;
    var paragraphsAffected = 0;
    var removedFingerprints = [];
    var summary = [];

    var toRemoveSet = {};
    groups.forEach(function (g) {
        if (allowed.indexOf(g.confidence) < 0) return;
        var winnerFp = g.winner.fingerprint;
        var winnerEntry = g.winner.planEntry;
        var minoritiesAbsorbed = [];
        g.variants.forEach(function (v) {
            if (v.fingerprint === winnerFp) return;
            // Redirect minority fingerprint → winner
            plan.fingerprintRedirect[v.fingerprint] = winnerFp;
            // Extend winner's tids
            v.tids.forEach(function (tid) {
                if (winnerEntry.tids.indexOf(tid) < 0) winnerEntry.tids.push(tid);
            });
            paragraphsAffected += v.paraCount;
            removedFingerprints.push(v.fingerprint);
            toRemoveSet[v.fingerprint] = true;
            minoritiesAbsorbed.push({
                fingerprint: v.fingerprint,
                paraCount: v.paraCount,
                fontSize: v.props.fontSize,
                leading: v.props.leading
            });
        });
        if (minoritiesAbsorbed.length > 0) {
            mergeCount++;
            summary.push({
                confidence: g.confidence,
                font: g.qualSummary.font,
                color: g.qualSummary.color,
                winnerFingerprint: winnerFp,
                winnerName: winnerEntry.name,
                winnerSize: g.winner.props.fontSize,
                winnerLeading: g.winner.props.leading,
                winnerParaCount: g.winner.paraCount,
                absorbed: minoritiesAbsorbed
            });
        }
    });

    // Remove minority entries from paraStylesToCreate
    if (removedFingerprints.length > 0) {
        plan.paraStylesToCreate = plan.paraStylesToCreate.filter(function (e) {
            return !toRemoveSet[e.fingerprint];
        });
    }

    return {
        mergeCount: mergeCount,
        paragraphsAffected: paragraphsAffected,
        removedFingerprints: removedFingerprints,
        styleCountBefore: groups.length > 0 ? plan.paraStylesToCreate.length + removedFingerprints.length : plan.paraStylesToCreate.length,
        styleCountAfter: plan.paraStylesToCreate.length,
        summary: summary
    };
}

module.exports = {
    DEFAULT_TOLERANCE: DEFAULT_TOLERANCE,
    HYBRID_DEFAULTS: HYBRID_DEFAULTS,
    findNearDuplicateGroups: findNearDuplicateGroups,
    findHybridGroups: findHybridGroups,
    mergeGroupsAtConfidence: mergeGroupsAtConfidence,
    _internal: {
        _qualKey: _qualKey,
        _withinTolerance: _withinTolerance,
        _classifyConfidence: _classifyConfidence,
        _entryEffectiveProps: _entryEffectiveProps,
        _madBandwidth: _madBandwidth,
        _kdeAt: _kdeAt,
        _kdePeakDetect: _kdePeakDetect
    }
};
