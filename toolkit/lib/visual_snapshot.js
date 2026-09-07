"use strict";

/**
 * lib/visual_snapshot.js
 *
 * Phase 1 (Export 端视觉快照采集) — pure function module
 *
 * Plan reference: task_plan.md "Phase 1: Export 端视觉快照采集（重构）"
 *
 * Responsibility:
 *   - Capture per-paragraph visual snapshot (effective values, NOT style
 *     definition values).
 *   - Two top-level functions:
 *       captureFormatSnapshot(para)    → character-level (baseline + runs)
 *       captureParagraphSnapshot(para) → paragraph-level (alignment, leading,
 *                                        indents, tabs, keep options, composer,
 *                                        hyphenation, mojikumi/kinsoku, etc.)
 *
 * Design constraints:
 *   - Pure functions, no IO, no side effects on doc.
 *   - DO NOT read appliedParagraphStyle.* — only read effective values from
 *     the para / character object directly.
 *   - Return JSON-serializable plain objects.
 *   - Tolerate missing fields (some properties throw on inline anchors,
 *     mixed runs, etc.) — wrap in try/catch and return null/default.
 *   - Used by:
 *       a. translation_mvp_uxp/export_translation_package.idjs (main path)
 *       b. translation_mvp_uxp/build_styles.idjs (post-MVP standalone)
 *       c. tests/visual_snapshot_tests.js (Node unit tests with mocked para)
 *
 * UXP / ExtendScript compatibility:
 *   - Uses NothingEnum sentinel check (mixed runs return NothingEnum.NOTHING)
 *   - Compatible with both .idjs (UXP) and .jsx (ExtendScript) callers
 *   - No ES6+ syntax (var, function, no arrow / class / let / const)
 */

// ─── Sentinel detection ────────────────────────────────────────────
//
// InDesign returns NothingEnum.NOTHING (a special sentinel) when a property
// queried on a multi-character range has mixed values. We can't import
// NothingEnum from outside the host (Node tests don't have it), so we use
// a heuristic: NothingEnum sentinel typically string-stringifies to a
// "[object NothingEnum]"-like value or has a special toString.
function isMixedSentinel(v) {
    if (v === null || v === undefined) return true;
    try {
        var s = String(v);
        if (s === "" || s === "undefined" || s === "null") return true;
        // ExtendScript NothingEnum.NOTHING typically renders as "[object NothingEnum]"
        // or special enum string. Be permissive.
        if (s.indexOf("Nothing") >= 0) return true;
    } catch (e) {
        return true;
    }
    return false;
}

// ─── Defensive property reader ─────────────────────────────────────

function safeGet(obj, propName, defaultVal) {
    try {
        var v = obj[propName];
        if (isMixedSentinel(v)) return defaultVal;
        return v;
    } catch (e) {
        return defaultVal;
    }
}

function toFiniteNumber(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
}

function toBool(v) {
    if (v === true || v === false) return v;
    if (v === null || v === undefined) return false;
    return !!v;
}

// ─── Color serialization ──────────────────────────────────────────
//
// fillColor / strokeColor in InDesign is a Color or Swatch object with:
//   - name (e.g., "Black", "C=100 M=0 Y=0 K=0", "[None]")
//   - space (ColorSpace enum: CMYK / RGB / LAB / etc.)
//   - colorValue (array of channel values)
//
// We capture both name (for swatch lookup on import) and colorValue
// (for fallback creation if swatch missing on import doc).

function colorSpaceName(spaceEnum) {
    if (spaceEnum === null || spaceEnum === undefined) return "UNKNOWN";
    try {
        var s = String(spaceEnum);
        // Normalize ExtendScript / UXP enum strings:
        //   "ColorSpace.CMYK" → "CMYK"
        //   1935826259 (numeric) → look up by toString
        if (s.indexOf(".") >= 0) {
            return s.split(".").pop();
        }
        return s;
    } catch (e) {
        return "UNKNOWN";
    }
}

function captureColor(colorObj, convertToRGB) {
    if (!colorObj) return null;
    var out = {
        swatch: null,
        space: null,
        values: null,
        displayedRGB: null    // set when convertToRGB is provided + supported
    };
    try {
        var n = colorObj.name;
        if (n !== undefined && n !== null) {
            var s = String(n);
            if (s && s !== "undefined" && s !== "null") out.swatch = s;
        }
    } catch (e) {}
    try {
        var sp = colorObj.space;
        if (sp !== undefined && sp !== null) {
            var sn = colorSpaceName(sp);
            if (sn && sn !== "UNKNOWN") out.space = sn;
        }
    } catch (e) {}
    try {
        var v = colorObj.colorValue;
        if (v && typeof v.length === "number") {
            var arr = [];
            for (var i = 0; i < v.length; i++) arr.push(Number(v[i]));
            out.values = arr;
        }
    } catch (e) {}
    if (typeof convertToRGB === "function" && out.values && out.space) {
        try {
            var rgb = convertToRGB(out.values, out.space);
            if (rgb && rgb.length >= 3) {
                out.displayedRGB = [
                    Math.round(rgb[0]),
                    Math.round(rgb[1]),
                    Math.round(rgb[2])
                ];
            }
        } catch (e) {}
    }
    if (!out.swatch && !out.values) return null;
    return out;
}

// ─── Paragraph-level snapshot ──────────────────────────────────────
//
// Captures paragraph-level effective values. Per task_plan.md decision:
// "完整捕获" — all fields, not just deltas vs style definition.

function captureTabStops(para) {
    var stops = [];
    try {
        var col = para.tabStops;
        if (!col || typeof col.length !== "number") return stops;
        for (var i = 0; i < col.length; i++) {
            try {
                var ts = (typeof col.item === "function") ? col.item(i) : col[i];
                if (!ts) continue;
                stops.push({
                    position: toFiniteNumber(safeGet(ts, "position", 0)),
                    alignment: String(safeGet(ts, "alignment", "")),
                    leader: String(safeGet(ts, "leader", "")),
                    alignment_char: String(safeGet(ts, "alignmentCharacter", ""))
                });
            } catch (eItem) {}
        }
    } catch (e) {}
    return stops;
}

function captureRule(para, prefix, convertToRGB) {
    // prefix = "ruleAbove" or "ruleBelow"
    var active = toBool(safeGet(para, prefix, false));
    // Skip detailed reads when inactive — color objects return .name=undefined
    // and indent/offset reads pollute snapshots with default-noise. Downstream
    // round-trip writer treats absent fields as "leave at InDesign default".
    if (!active) {
        return { active: false };
    }
    return {
        active: true,
        weight:       toFiniteNumber(safeGet(para, prefix + "LineWeight", 0)),
        color:        captureColor(safeGet(para, prefix + "Color", null), convertToRGB),
        gapColor:     captureColor(safeGet(para, prefix + "GapColor", null), convertToRGB),
        offset:       toFiniteNumber(safeGet(para, prefix + "Offset", 0)),
        tint:         toFiniteNumber(safeGet(para, prefix + "Tint", -1)),
        gapTint:      toFiniteNumber(safeGet(para, prefix + "GapTint", -1)),
        // Type: stroke-style name. InDesign returns either a string like
        // "Solid" / "Thin - Thin" or a StrokeStyle object whose .name is the
        // same string. captureColor-style serialization is overkill; just
        // stringify and trust the round-trip writer to look it up via
        // doc.strokeStyles.itemByName.
        type:         String(safeGet(para, prefix + "Type", "Solid")),
        leftIndent:   toFiniteNumber(safeGet(para, prefix + "LeftIndent", 0)),
        rightIndent:  toFiniteNumber(safeGet(para, prefix + "RightIndent", 0)),
        // Width: RuleWidth enum ("TEXT_WIDTH" / "COLUMN_WIDTH"). Capture as
        // string for cross-runtime portability (enum int vs string drift).
        width:        String(safeGet(para, prefix + "Width", "TEXT_WIDTH")),
        overprint:    toBool(safeGet(para, prefix + "Overprint", false)),
        gapOverprint: toBool(safeGet(para, prefix + "GapOverprint", false))
    };
}

function captureParagraphSnapshot(para, convertToRGB) {
    if (!para) return null;
    var firstChar = null;
    try {
        if (para.characters && para.characters.length > 0) {
            firstChar = (typeof para.characters.item === "function")
                ? para.characters.item(0)
                : para.characters[0];
        }
    } catch (e) {}

    var snap = {
        // ── Basic typography ──
        justification: String(safeGet(para, "justification", "LEFT_ALIGN")),
        leading: (function () {
            // leading is a CHARACTER property; read from first char if available
            var v = firstChar ? safeGet(firstChar, "leading", null) : null;
            if (v === null) v = safeGet(para, "leading", null);
            // Could be number (pt) or "AUTO" sentinel
            if (typeof v === "number") return v;
            try {
                var s = String(v);
                if (s.indexOf("AUTO") >= 0 || s.indexOf("Auto") >= 0) return "AUTO";
            } catch (e) {}
            return v === null ? null : toFiniteNumber(v);
        })(),
        // autoLeading multiplier (typically 120 = 120% of fontSize). Used
        // downstream by style_merge_advisor to resolve "AUTO" leading into
        // an effective numeric value so KDE on the leading axis can mix
        // AUTO + numeric variants when their effective values are close.
        auto_leading: toFiniteNumber(safeGet(para, "autoLeading", 120)) || 120,
        space_before: toFiniteNumber(safeGet(para, "spaceBefore", 0)),
        space_after: toFiniteNumber(safeGet(para, "spaceAfter", 0)),
        first_line_indent: toFiniteNumber(safeGet(para, "firstLineIndent", 0)),
        left_indent: toFiniteNumber(safeGet(para, "leftIndent", 0)),
        right_indent: toFiniteNumber(safeGet(para, "rightIndent", 0)),

        // ── Lists / tab stops ──
        bullets_and_numbering_type: String(safeGet(para, "bulletsAndNumberingListType", "NONE")),
        numbering_format: (function () {
            var v = safeGet(para, "numberingFormat", null);
            return v === null ? null : String(v);
        })(),
        numbering_start_at: toFiniteNumber(safeGet(para, "numberingStartAt", 1)),
        bullet_char: (function () {
            try {
                var bc = para.bulletChar;
                // [P1-C fix] the UXP Bullet object's Unicode codepoint is `characterValue`
                // (host-verified = 8226 for •), NOT `bulletsCharacterValue` (undefined in
                // UXP → every bullet_char captured null → a NON-• source bullet lost its
                // real char and fell to the BULLET_LIST default • on rebuild).
                if (bc && bc.characterValue !== undefined) {
                    return String.fromCharCode(toFiniteNumber(bc.characterValue));
                }
            } catch (e) {}
            return null;
        })(),
        // [P1-C (a)] the Latin font the bullet ORIGINALLY renders in — so the rebuilt
        // _T_p_ style can set bulletChar.bulletsFont explicitly (preserve-original,
        // user ruling §9) instead of AUTO_VALUE (which inherits the CJK psFont that
        // can't draw •). bulletsFont=AUTO_VALUE (the common case) means the bullet
        // inherits the PARAGRAPH font → fall to para.appliedFont. Full "Family\tStyle".
        bullet_font: (function () {
            try {
                var bc = para.bulletChar;
                var bf = bc ? bc.bulletsFont : null;
                var nm = null;
                if (bf !== null && bf !== undefined) {
                    var bfn = (typeof bf === "string") ? bf : (bf && bf.name ? String(bf.name) : null);
                    if (bfn && bfn.toUpperCase().indexOf("AUTO") < 0) nm = bfn;
                }
                if (!nm) {
                    var pf = para.appliedFont;
                    nm = (typeof pf === "string") ? pf : (pf && pf.name ? String(pf.name) : null);
                    // [codex-r2 fix] a bare-string appliedFont is family-only (no weight);
                    // append the paragraph fontStyle so the bullet's real weight isn't lost
                    // to a wrong "Regular" default at apply — which could false-miss an
                    // installed Bold/Light face and leave the • AUTO/unrendered.
                    if (nm && nm.indexOf("\t") < 0) {
                        var _pfs = null;
                        try { _pfs = para.fontStyle; } catch (e2) {}
                        if (typeof _pfs === "string" && _pfs && _pfs.toUpperCase() !== "NOTHING") nm = nm + "\t" + _pfs;
                    }
                }
                return nm || null;
            } catch (e) { return null; }
        })(),
        tab_stops: captureTabStops(para),

        // ── Keep options ──
        keep_with_next: toFiniteNumber(safeGet(para, "keepWithNext", 0)),
        keep_lines_together: toBool(safeGet(para, "keepLinesTogether", false)),
        keep_first_lines: toFiniteNumber(safeGet(para, "keepFirstLines", 0)),
        keep_last_lines: toFiniteNumber(safeGet(para, "keepLastLines", 0)),

        // ── Hyphenation ──
        hyphenation: toBool(safeGet(para, "hyphenation", true)),
        hyphenate_capitalized_words: toBool(safeGet(para, "hyphenateCapitalizedWords", false)),
        hyphen_zone: toFiniteNumber(safeGet(para, "hyphenZone", 0)),
        hyphenate_ladder_limit: toFiniteNumber(safeGet(para, "hyphenateLadderLimit", 3)),

        // ── Composer / CJK paragraph engine ──
        composer: String(safeGet(para, "composer", "ADOBE_PARAGRAPH_COMPOSER")),

        // ── Paragraph rules ──
        rule_above: captureRule(para, "ruleAbove", convertToRGB),
        rule_below: captureRule(para, "ruleBelow", convertToRGB),

        // ── Drop cap ──
        drop_cap_lines: toFiniteNumber(safeGet(para, "dropCapLines", 0)),
        drop_cap_characters: toFiniteNumber(safeGet(para, "dropCapCharacters", 0)),

        // ── CJK-specific ──
        mojikumi_table: (function () {
            try {
                var t = para.mojikumiTable;
                if (t && t.name !== undefined) return String(t.name);
            } catch (e) {}
            return null;
        })(),
        kinsoku_set: (function () {
            try {
                var k = para.kinsokuSet;
                if (k && k.name !== undefined) return String(k.name);
            } catch (e) {}
            return null;
        })(),
        balance_ragged_lines: toBool(safeGet(para, "balanceRaggedLines", false)),

        // #E2E-3: CJK typography fields that drive Latin↔CJK spacing.
        // Previously omitted, causing "Premium 卡" → "Premium卡" on import.
        // mojikumi/kinsoku above are table references; these are the
        // numeric/enum knobs that control spacing/scaling behavior.
        kanji_word_spacing: toFiniteNumber(safeGet(para, "kanjiWordSpacing", 100)),
        cjk_grid_tracking: toBool(safeGet(para, "cjkGridTracking", false)),
        glyph_form: (function () {
            try { return String(safeGet(para, "glyphForm", "NORMAL_TRADITIONAL_FORM")); }
            catch (e) { return "NORMAL_TRADITIONAL_FORM"; }
        })(),
        single_word_justification: (function () {
            try { return String(safeGet(para, "singleWordJustification", "FULLY_JUSTIFIED")); }
            catch (e) { return "FULLY_JUSTIFIED"; }
        })(),
        kashidas: toBool(safeGet(para, "kashidas", false)),
        kerning_for_japanese: toBool(safeGet(para, "characterAlignment", false))
    };

    return snap;
}

// ─── Character-level baseline + runs ───────────────────────────────

function captureCharProperties(charOrRange, convertToRGB) {
    // Read the visual properties of a character (or textStyleRange)
    var props = {
        fontFamily: null,
        fontStyle: null,
        fontSize: 0,
        fillColor: null,
        underline: false,
        // #UL-DETAIL (2026-05-26): underline visual props. Paragraph styles
        // like Client-A "Subhead H3" define char-level underline at the style
        // level (underline=true + offset=6 + weight=0.4 + color=PANTONE 300 C)
        // to produce a thin colored line below the heading. Without these
        // fields the cluster pipeline rebuilt the paragraph style with
        // underline=false (default), losing the visual divider line.
        underlineOffset: 0,
        underlineWeight: 0,
        underlineColor: null,
        underlineTint: -1,
        strikeThrough: false,
        tracking: 0,
        baseline_shift: 0,
        horizontal_scale: 100,
        vertical_scale: 100,
        skew: 0,
        // #E2E-1: position (NORMAL / SUPERSCRIPT / SUBSCRIPT / SUPERIOR /
        // INFERIOR / NUMERATOR / DENOMINATOR). Default "NORMAL". Previously
        // omitted from the prop set, so SUPERSCRIPT characters set via
        // character.position (designer typed Ctrl+Shift+= or applied a
        // shortcut) without an explicit baselineShift override were captured
        // as if they were normal — round-trip lost ®* superscripts on
        // Client-A card-name paragraphs.
        position: "NORMAL"
    };

    try {
        var f = charOrRange.appliedFont;
        if (f) {
            try { props.fontFamily = String(f.fontFamily); } catch (e) {}
        }
    } catch (e) {}
    try { props.fontStyle = String(safeGet(charOrRange, "fontStyle", "Regular")); } catch (e) {}
    try { props.fontSize = toFiniteNumber(safeGet(charOrRange, "pointSize", 0)); } catch (e) {}
    try { props.fillColor = captureColor(safeGet(charOrRange, "fillColor", null), convertToRGB); } catch (e) {}
    try { props.underline = toBool(safeGet(charOrRange, "underline", false)); } catch (e) {}
    // #UL-DETAIL: capture offset/weight/color even when underline is false —
    // they may be set on the paragraph style as defaults the cluster needs
    // to round-trip. Color resolution mirrors fillColor (captureColor).
    try { props.underlineOffset = toFiniteNumber(safeGet(charOrRange, "underlineOffset", 0)); } catch (e) {}
    try { props.underlineWeight = toFiniteNumber(safeGet(charOrRange, "underlineWeight", 0)); } catch (e) {}
    try { props.underlineColor = captureColor(safeGet(charOrRange, "underlineColor", null), convertToRGB); } catch (e) {}
    try { props.underlineTint = toFiniteNumber(safeGet(charOrRange, "underlineTint", -1)); } catch (e) {}
    try { props.strikeThrough = toBool(safeGet(charOrRange, "strikeThru", false)); } catch (e) {}
    try { props.tracking = toFiniteNumber(safeGet(charOrRange, "tracking", 0)); } catch (e) {}
    try { props.baseline_shift = toFiniteNumber(safeGet(charOrRange, "baselineShift", 0)); } catch (e) {}
    try { props.horizontal_scale = toFiniteNumber(safeGet(charOrRange, "horizontalScale", 100)); } catch (e) {}
    try { props.vertical_scale = toFiniteNumber(safeGet(charOrRange, "verticalScale", 100)); } catch (e) {}
    // skew = synthetic italic angle in degrees (DOM property name `skew`).
    // Designers use this for faux italic on fonts without an italic variant
    // (e.g. CJK families). Captured here so reorganize round-trips correctly.
    try { props.skew = toFiniteNumber(safeGet(charOrRange, "skew", 0)); } catch (e) {}
    // #E2E-1: position dim. InDesign exposes Position as an enum string
    // (e.g. "NORMAL", "SUPERSCRIPT"). When unset the DOM may return undefined
    // or {} (UXP NothingEnum); coerce to "NORMAL".
    try {
        var posRaw = safeGet(charOrRange, "position", "NORMAL");
        var posStr = (posRaw === null || posRaw === undefined) ? "NORMAL" : String(posRaw);
        if (posStr === "NOTHING" || posStr === "undefined" || posStr === "[object Object]") posStr = "NORMAL";
        props.position = posStr;
    } catch (e) {}

    return props;
}

function captureCharStyleHint(charOrRange) {
    // Optional: capture appliedCharacterStyle.name for E2 hybrid + E3 命名
    try {
        var cs = charOrRange.appliedCharacterStyle;
        if (cs && cs.name !== undefined) {
            var name = String(cs.name);
            if (name && name !== "[None]") return name;
        }
    } catch (e) {}
    return null;
}

function visualFingerprintForRun(props) {
    // Simple JSON stringify; cluster-tolerance comparison is done
    // upstream in fingerprintRun (lib/style_sheet_builder.js).
    // #E2E-1: include position so SUPERSCRIPT/SUBSCRIPT chars split out as
    // their own ranges and survive the uniform=true path.
    return JSON.stringify({
        ff: props.fontFamily,
        fs: props.fontStyle,
        sz: props.fontSize,
        c: props.fillColor ? props.fillColor.swatch : null,
        u: props.underline,
        s: props.strikeThrough,
        t: props.tracking,
        bs: props.baseline_shift,
        hs: props.horizontal_scale,
        vs: props.vertical_scale,
        sk: props.skew,
        pos: props.position || "NORMAL"
    });
}

function captureFormatSnapshot(para, convertToRGB) {
    if (!para) return null;

    // Get baseline from first character
    var firstChar = null;
    try {
        if (para.characters && para.characters.length > 0) {
            firstChar = (typeof para.characters.item === "function")
                ? para.characters.item(0)
                : para.characters[0];
        }
    } catch (e) {}

    if (!firstChar) {
        // Empty paragraph: return minimal snapshot
        return {
            uniform: true,
            baseline: captureCharProperties({}, convertToRGB),
            runs: []
        };
    }

    var baseline = captureCharProperties(firstChar, convertToRGB);
    var charStyleHint = captureCharStyleHint(firstChar);
    if (charStyleHint) baseline.charStyleHint = charStyleHint;

    // Iterate textStyleRanges and record EVERY range (text + font + props +
    // baseline-fp match). The full set drives both:
    //   - uniform/runs decision (only diff-from-baseline ranges go into runs)
    //   - Phase 8A script-by-font detection downstream (needs all ranges to
    //     test font-script disjointness)
    var allRanges = [];
    var baselineFp = visualFingerprintForRun(baseline);
    var uniform = true;
    var offset = 0;

    var ranges = null;
    try { ranges = para.textStyleRanges; } catch (e) {}

    if (ranges && typeof ranges.length === "number") {
        for (var i = 0; i < ranges.length; i++) {
            try {
                var range = (typeof ranges.item === "function") ? ranges.item(i) : ranges[i];
                if (!range) continue;
                var rangeText;
                try { rangeText = String(range.contents || ""); } catch (e) { rangeText = ""; }

                // Strip trailing CR (paragraph mark)
                var crIdx = rangeText.indexOf("\r");
                if (crIdx >= 0) rangeText = rangeText.substring(0, crIdx);
                if (rangeText.length === 0) continue;

                var rangeProps = captureCharProperties(range, convertToRGB);
                var rangeHint = captureCharStyleHint(range);
                var rangeFp = visualFingerprintForRun(rangeProps);

                allRanges.push({
                    start: offset,
                    end: offset + rangeText.length,
                    text: rangeText,
                    props: rangeProps,
                    hint: rangeHint,
                    matchesBaseline: (rangeFp === baselineFp)
                });
                if (rangeFp !== baselineFp) uniform = false;
                offset += rangeText.length;
            } catch (eRange) {}
        }
    }

    // Build the legacy `runs` field — only diff-from-baseline ranges.
    // Field shape preserved for back-compat with downstream code that
    // already consumes it (annotation char styles, mixed-format reports).
    var runs = [];
    if (!uniform) {
        for (var ri = 0; ri < allRanges.length; ri++) {
            var r = allRanges[ri];
            if (r.matchesBaseline) continue;
            var run = {
                start: r.start,
                end: r.end,
                fontFamily: r.props.fontFamily,
                fontStyle: r.props.fontStyle,
                fontSize: r.props.fontSize,
                fillColor: r.props.fillColor,
                underline: r.props.underline,
                strikeThrough: r.props.strikeThrough,
                tracking: r.props.tracking,
                baseline_shift: r.props.baseline_shift,
                horizontal_scale: r.props.horizontal_scale,
                vertical_scale: r.props.vertical_scale,
                skew: r.props.skew,
                position: r.props.position || "NORMAL"  // #E2E-1
            };
            if (r.hint) run.charStyleHint = r.hint;
            runs.push(run);
        }
    }

    var snap = {
        uniform: uniform,
        baseline: baseline,
        runs: runs   // only populated when uniform=false
    };

    // For uniform=false paragraphs, also emit `_allRanges` (full per-range
    // breakdown with text + props + hint) so:
    //   - Phase 8A script-by-font detection (script_classifier) can test
    //     font-script disjointness — uses `fontFamily` / `fontStyle`
    //     mirrored at the top level.
    //   - Phase 8B emphasis extraction (emphasis_extractor) can pick winners
    //     across all dimensions — uses `props` (full character properties)
    //     plus `hint` (existing applied character style name) to skip runs
    //     already styled by the designer.
    // Underscore prefix marks _allRanges as transient — buildStylePlan
    // consumes it and strips before the snapshot is serialized to disk.
    if (!uniform) {
        snap._allRanges = [];
        for (var ai = 0; ai < allRanges.length; ai++) {
            var ar = allRanges[ai];
            snap._allRanges.push({
                start: ar.start,
                end: ar.end,
                text: ar.text,
                fontFamily: ar.props.fontFamily,   // 8A back-compat shape
                fontStyle: ar.props.fontStyle,     // 8A back-compat shape
                props: ar.props,                    // 8B full per-range props
                hint: ar.hint                       // 8B existing charStyle marker
            });
        }
    }

    return snap;
}

// Build a per-SUB-SEGMENT format_snapshot from a parent paragraph's snapshot by
// clipping `_allRanges` (+ legacy `runs`) to the char range [start, end) and
// rebasing offsets to 0. Soft-break sub-segments otherwise inherit the PARENT's
// full mixed-format ranges verbatim, so the later applyEmphasisExtraction pass
// computes the PARENT's lightest-weight baseline for each sub-segment — a
// UNIFORM title sub-segment (e.g. "Getting Ready" all Whitney Semibold 25pt)
// then gets the parent's lighter Whitney Book baseline with its real format
// demoted to an emphasis run (which import treats as _auto → stripped),
// collapsing the title to body. Slicing per sub-segment lets the emphasis pass
// derive each sub-segment's OWN baseline.
//
// Only mixed parents (uniform=false → carries `_allRanges`) need this. Returns
// the input unchanged for uniform parents, scriptByFont (Phase 8A) segments
// (handled by a separate routing path), or when nothing lands in [start, end).
// The new snapshot keeps uniform=false + a placeholder baseline; the export's
// applyEmphasisExtraction pass overwrites baseline + emphasisRuns from the
// sliced `_allRanges`.
function sliceFormatSnapshotToRange(fs, start, end) {
    if (!fs || fs.uniform !== false || !fs._allRanges || fs.scriptByFont) return fs;
    function clip(arr) {
        var out = [];
        if (!arr) return out;
        for (var i = 0; i < arr.length; i++) {
            var r = arr[i];
            if (!r || typeof r.start !== "number" || typeof r.end !== "number") continue;
            var s = Math.max(r.start, start);
            var e = Math.min(r.end, end);
            if (e <= s) continue;
            var nr = {};
            for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) nr[k] = r[k]; }
            nr.start = s - start;
            nr.end = e - start;
            if (typeof r.text === "string") nr.text = r.text.slice(s - r.start, e - r.start);
            out.push(nr);
        }
        return out;
    }
    var slicedAll = clip(fs._allRanges);
    if (!slicedAll.length) return fs;   // nothing in range → keep parent (safety)
    var snap = {
        uniform: false,                  // emphasis pass recomputes baseline + emphasisRuns
        baseline: slicedAll[0].props ? slicedAll[0].props : fs.baseline,
        runs: clip(fs.runs || [])
    };
    snap._allRanges = slicedAll;
    return snap;
}

// ─── Module exports ────────────────────────────────────────────────

module.exports = {
    captureFormatSnapshot: captureFormatSnapshot,
    captureParagraphSnapshot: captureParagraphSnapshot,
    sliceFormatSnapshotToRange: sliceFormatSnapshotToRange,
    // Internal helpers exposed for testing
    _internal: {
        captureCharProperties: captureCharProperties,
        captureColor: captureColor,
        // captureRule exported additively for 8D-ext-G operator #7 (G→r7 PIN,
        // task_plan.md:2570/:2639): export_brand_style_preset reads a paragraph
        // style's rule payload (full field set incl tint/gapColor/gapTint/
        // overprint) via this helper; apply uses it for read-back verify. Both
        // a ParagraphStyle and a paragraph expose the same ruleAbove*/ruleBelow*
        // props, so passing a style object as `para` works. Additive — no caller
        // relocated, zero regression.
        captureRule: captureRule,
        captureTabStops: captureTabStops,
        visualFingerprintForRun: visualFingerprintForRun,
        isMixedSentinel: isMixedSentinel,
        safeGet: safeGet
    }
};
