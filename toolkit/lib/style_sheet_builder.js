"use strict";

/**
 * lib/style_sheet_builder.js
 *
 * Phase 2 MVP — Plan + Commit 两阶段
 *
 * Plan reference:
 *   task_plan.md "Phase 2: Import 端建样式池（buildStylePlan + commitStylePlan）"
 *
 * Two-stage design:
 *
 *   buildStylePlan(segments, workDoc, options) → plan
 *     纯计算; 不写 doc. 收集 baseline + paragraph_snapshot, 视觉指纹聚类,
 *     Latin 池按 (fontFamily, fontStyle) 全局去重, 决定每段落样式是否
 *     需要 GREP. 输出可序列化 plan + clusterReport.
 *
 *   commitStylePlan(workDoc, plan) → sheet
 *     按拓扑序应用 plan: latin char styles → para styles (含 GREP 引用 latin).
 *     返回 { paraStyleMap, latinStyleMap, annotationCharStyleCache }.
 *     ⚠️ 调用方必须保证 preflight 已通过.
 *
 *   commitStylePlanGuarded(workDoc, plan, preflightReport) → sheet
 *     防呆包装: preflightReport.blocking 非空时抛错.
 *
 *   ensureAnnotationCharStyle(workDoc, sheet, action, value) → CharacterStyle
 *     在 Pass B 应用 annotations 时按需创建 _T_c_annotation_*. 缓存复用.
 *
 * Key plan decisions (recorded in task_plan.md decision table):
 *   - paragraph fingerprint MUST include latinFamily + latinStyle
 *     (otherwise Body Myriad + Heading Helvetica errantly merge)
 *   - GREP rules default to "always add for CJK-default styles"
 *     (don't gate on source cluster; target may add Latin URLs / brand names)
 *   - Latin char style pool dedup'd by (fontFamily, fontStyle) globally
 *     (typical 1-3 styles serving N paragraph styles)
 *   - DO NOT pre-build _T_c_* from source runs (MVP doesn't consume them);
 *     only record observed_run_fingerprints in clusterReport for E10
 *   - DO NOT provide buildTranslationStyleSheet wrapper (违反 commit boundary)
 *
 * UXP / ExtendScript compatibility:
 *   - Pure module + deps injection
 *   - var only, no ES6+
 *   - All InDesign API access via deps:
 *       deps.fontMapping  — { resolveCJKFont, resolveLatinFont, scanMissingFonts }
 *       deps.findFont     — function(name) → font or null (passed to fontMapping)
 *       deps.colorSpace   — indesign.ColorSpace enum (for annotation color creation)
 *       deps.position     — indesign.Position enum (for annotation superscript)
 */

// ─── Constants ────────────────────────────────────────────────────

var DEFAULT_TOLERANCE = {
    fontSize_pt: 0.5,
    leading_pt: 0.5,
    indent_pt: 0.1,
    space_pt: 0.1,
    color_deltaE: 5,
    tracking_em: 5,
    scale_pct: 5
};

// Numeric dimension preset buckets (Phase 9 — sparse-typography refinement).
//
// fontSize / leading are continuous and well-suited to KDE clustering; the
// other typographic dimensions (tracking, scale, baselineShift, skew) are
// usually set to one of a few designer presets (e.g. tracking ∈ {0, ±50,
// ±100, ±200} thousandths-of-em). KDE on a 2-3-mode distribution doesn't
// produce clean peaks, but explicit deadzone + step snapping does.
//
// Snap rule per dimension:
//   value within ±deadzone of `default` → snaps to `default`
//   anywhere else → snaps to nearest `default + k * step`
//
// Why deadzone separate from step: hScale 99..101 should clearly all be
// "100% (no-scale) bucket" but 87 should NOT be confused with 90 (90 is
// a real designer preset). Deadzone covers "imperceptible drift around
// the canonical value"; step covers "designer's chosen non-default
// preset" — narrower or wider depending on the typographic convention.
var NUMERIC_DIM_PRESETS = {
    tracking:         { default: 0,   deadzone: 50,  step: 50  },
    horizontal_scale: { default: 100, deadzone: 2,   step: 5   },
    vertical_scale:   { default: 100, deadzone: 2,   step: 5   },
    baseline_shift:   { default: 0,   deadzone: 0.5, step: 0.5 },
    // skew step=15 not 5 — designers use 12° or 15° interchangeably for
    // faux italic (15° is the typographic canonical value but 12° is
    // common too). step=5 would split them; step=15 collapses both into
    // the same 15° bucket. 7..22° → 15°, 22..37° → 30°, etc.
    skew:             { default: 0,   deadzone: 1,   step: 15  }
};

function _snapPreset(value, defaultVal, deadzone, step) {
    if (value === null || value === undefined || isNaN(value)) return defaultVal;
    var n = Number(value);
    if (Math.abs(n - defaultVal) <= deadzone) return defaultVal;
    if (step > 0) {
        var snapped = Math.round(n / step) * step;
        // Round to handle floating-point step (e.g. step=0.5)
        return Math.round(snapped * 1000) / 1000;
    }
    return n;
}

function _snapTracking(v)        { var p = NUMERIC_DIM_PRESETS.tracking;         return _snapPreset(v, p.default, p.deadzone, p.step); }
function _snapHScale(v)          { var p = NUMERIC_DIM_PRESETS.horizontal_scale; return _snapPreset(v, p.default, p.deadzone, p.step); }
function _snapVScale(v)          { var p = NUMERIC_DIM_PRESETS.vertical_scale;   return _snapPreset(v, p.default, p.deadzone, p.step); }
function _snapBaselineShift(v)   { var p = NUMERIC_DIM_PRESETS.baseline_shift;   return _snapPreset(v, p.default, p.deadzone, p.step); }
function _snapSkew(v)            { var p = NUMERIC_DIM_PRESETS.skew;             return _snapPreset(v, p.default, p.deadzone, p.step); }

// Latin GREP: a run of Latin-ish chars (letters + ASCII + Latin-1/Ext) routed to
// the _T_Latin_ CS. Neutral "smart punctuation" (curly quotes / dashes / ellipsis
// / guillemets — NEUTRAL_PUNCT_CLASS) is JOINED into the run ONLY when it sits
// between two Latin LETTERS (lookbehind/lookaround on LATIN_LETTER, NOT the broad
// LATIN_CLASS — which includes space, so `好 "OpenAI" 好` must NOT pull the quotes
// in). This fixes the French apostrophe (`d'épargne`) orphaning full-width in the
// CJK psFont while keeping CJK-context / space-adjacent quotes full-width.
// Host-verified (InDesign live findGrep + nested-style + recompose on a real doc).
var LATIN_CLASS  = "[\\x{0020}-\\x{007E}\\x{00A0}-\\x{024F}]";
var LATIN_LETTER = "[\\x{0041}-\\x{005A}\\x{0061}-\\x{007A}\\x{00C0}-\\x{024F}]";
// Neutral smart-punct set. MUST stay identical to script_font_enforcer.js
// NEUTRAL_PUNCT_RE (cross-file agreement test in tests/cluster_grep_repair_tests.js):
//   U+2010–2015 hyphen/dashes · 2018–201F curly quotes · 2026 ellipsis ·
//   2032–2033 primes · 2039–203A single guillemets ‹ ›
var NEUTRAL_PUNCT_CLASS = "[\\x{2010}-\\x{2015}\\x{2018}-\\x{201F}\\x{2026}\\x{2032}\\x{2033}\\x{2039}\\x{203A}]";
var GREP_LATIN_PATTERN = LATIN_CLASS + "+(?:(?<=" + LATIN_LETTER + ")" + NEUTRAL_PUNCT_CLASS + "(?=" + LATIN_LETTER + ")" + LATIN_CLASS + "+)*";

// #BRIDGE-27: detect designer "CJK psFont + GREP-routed Latin" pattern.
// Some docs (e.g. Client-B marketing collateral with body_*_transripts_*
// styles) set the paragraph style's appliedFont to a CJK family
// (MHeiHK / MSung / SimSun / ...) and route Latin chars to a Latin
// character style via a nested GREP rule. Without this detection, the
// cluster builder's most-chars-wins baseline picks the GREP-routed Latin
// family (because Latin chars often outnumber CJK in body copy) and
// writes it as the cluster psFont — CJK chars then inherit a Latin font
// and lose their glyphs. Detection lets the cluster preserve the source
// designer pattern: cluster psFont = CJK, plus a cluster-level Latin
// GREP routing parallel to the source's.
var _CJK_FAMILY_RE_BUILDER = /(Source Han|Noto Sans (?:CJK|SC|TC|KR|JP)|Noto Serif (?:CJK|SC|TC|KR|JP)|MHei|MSung|MKai|STSong|STHeiti|STKaiti|STFangsong|SimSun|SimHei|SimKai|FangSong|YouYuan|LiSong|LiHei|BiauKai|MingLiU|PMingLiU|Microsoft JhengHei|Microsoft YaHei|DFKai|Yu Gothic|Yu Mincho|Hiragino|MS Gothic|MS Mincho|MS PGothic|MS PMincho|Meiryo|Osaka|Apple SD Gothic|Malgun Gothic|Batang|Dotum|Gulim|Gungsuh|Nanum|UD Digi|HGS|HGP)/i;
function _isCJKFamilyName(family) {
    if (!family) return false;
    return _CJK_FAMILY_RE_BUILDER.test(String(family));
}

// Recursive paragraph-style lookup. doc.paragraphStyles.itemByName() is a
// flat collection on the root and does NOT descend into paragraphStyleGroups,
// so designer styles organized into folders (e.g. /Body/Body copy P) miss
// every flat itemByName(). Walks all groups depth-first; returns the first
// match. Returns null when not found or workDoc is missing.
function _findParagraphStyleByName(workDoc, name) {
    if (!workDoc || !name) return null;
    var nm = String(name);
    try {
        var rootHit = workDoc.paragraphStyles.itemByName(nm);
        if (rootHit && rootHit.isValid) return rootHit;
    } catch (e) {}
    function walk(group) {
        try {
            var hit = group.paragraphStyles.itemByName(nm);
            if (hit && hit.isValid) return hit;
        } catch (e) {}
        var subs;
        try { subs = group.paragraphStyleGroups; } catch (e) { return null; }
        var sN = 0;
        try { sN = subs.length; } catch (e) {}
        for (var i = 0; i < sN; i++) {
            var sub = null;
            try { sub = subs.item(i); } catch (e) {}
            if (!sub) continue;
            var r = walk(sub);
            if (r) return r;
        }
        return null;
    }
    return walk(workDoc);
}
function _detectDesignerCJKPsWithLatinGrep(workDoc, sourceStyleName) {
    if (!workDoc || !sourceStyleName) return null;
    if (String(sourceStyleName).indexOf("_T_") === 0) return null;  // skip pipeline-managed
    var ps = _findParagraphStyleByName(workDoc, sourceStyleName);
    if (!ps || !ps.isValid) return null;
    var psFontFamily = "", psFontStyle = "";
    try {
        var pf = ps.appliedFont;
        if (pf && typeof pf === "object") {
            try { psFontFamily = String(pf.fontFamily || ""); } catch (e1) {}
            try { psFontStyle  = String(pf.fontStyleName || ""); } catch (e2) {}
        } else if (typeof pf === "string") {
            psFontFamily = String(pf);
        }
    } catch (e) {}
    if (!_isCJKFamilyName(psFontFamily)) return null;
    // Look for nested GREP rule routing a Latin-ish range to ANY CS.
    // Common designer patterns: "[!-~©®™]+", "[\\x21-\\x7E]+", or our pipeline's
    // "[\\x{0020}-\\x{007E}\\x{00A0}-\\x{024F}]+". Any of these indicates the
    // designer's intent: Latin chars get a separate font via the GREP CS.
    var hasLatinGrep = false;
    try {
        var greps = ps.nestedGrepStyles;
        var gN = 0; try { gN = greps.length; } catch (e) {}
        for (var g = 0; g < gN; g++) {
            var ng = null;
            try { ng = greps.item(g); } catch (e) {}
            if (!ng) continue;
            var expr = "";
            try { expr = String(ng.grepExpression || ""); } catch (e) {}
            if (!expr) continue;
            // Match common Latin-targeting regex shapes
            // Match a few common shapes for "Latin-targeting" GREP. Any of
            // these indicates designer routes ASCII / Latin Extended chars
            // through this GREP. We don't need an exhaustive parser — false
            // positives (admitting a non-Latin GREP) just mean we preserve
            // the source psFont (CJK) which is the safe default for docs
            // where the source ps already uses CJK as default font.
            if (/\\x\{0020\}|\\x\{0021\}|\\x\{0041\}|\\x\{007E\}|\[!-~|\[A-Z|\[a-z|\\x21\-\\x7E|\\x20\-\\x7E|\\x00C0\-\\x024F/.test(expr)) {
                hasLatinGrep = true;
                break;
            }
        }
    } catch (e) {}
    if (!hasLatinGrep) return null;
    return {
        psFontFamily: psFontFamily,
        psFontStyle: psFontStyle || "Regular"
    };
}

// Phase 8A: when a paragraph was identified as script-by-font (mixed runs
// where each font covers a disjoint Unicode script), the Latin font for
// the GREP rule + Latin pool lookup must come from the script-by-font
// breakdown (scriptToFont.LATIN), NOT from baseline.fontFamily — which
// has been overridden to the dominant-script font (CJK) by
// applyScriptByFontDetection. Returns the Latin family/style to use; falls
// back to baseline for non-script-by-font paragraphs.
function _resolveLatinFontForCluster(seg) {
    var sbf = seg && seg.format_snapshot && seg.format_snapshot.scriptByFont;
    if (sbf && sbf.scriptToFont && sbf.scriptToFont.LATIN) {
        return {
            fontFamily: sbf.scriptToFont.LATIN.fontFamily,
            fontStyle:  sbf.scriptToFont.LATIN.fontStyle || "Regular"
        };
    }
    var base = seg && seg.format_snapshot && seg.format_snapshot.baseline;
    return {
        fontFamily: base ? base.fontFamily : null,
        fontStyle:  base ? (base.fontStyle || "Regular") : "Regular"
    };
}

// #BRIDGE-28: parallel to _resolveLatinFontForCluster. Reads CJK font
// info from scriptByFont when present — used for Latin-base reverse
// routing where the cluster psFont is Latin but the cluster also needs
// a `_T_CJK_*` CS routed via GREP to cover embedded CJK runs.
function _resolveCJKFontForCluster(seg) {
    var sbf = seg && seg.format_snapshot && seg.format_snapshot.scriptByFont;
    if (sbf && sbf.scriptToFont && sbf.scriptToFont.CJK) {
        return {
            fontFamily: sbf.scriptToFont.CJK.fontFamily,
            fontStyle:  sbf.scriptToFont.CJK.fontStyle || "Regular"
        };
    }
    return { fontFamily: null, fontStyle: "Regular" };
}

// #BRIDGE-28: GREP expression matching CJK script chars (Han Unified +
// Han Extension A + Han Compatibility). Used by the Latin-base reverse-
// routing GREP rule to channel embedded CJK chars to a `_T_CJK_*` CS,
// keeping them on their original CJK font even though the cluster psFont
// is Latin. Mirrors GREP_PATTERNS.CJK in script_classifier.js.
// CJK mirror: symmetric with the Latin GREP. The CJK class is pure Han (no
// space), so the class IS the "letter" flank — a neutral punct is joined into
// the CJK run whenever it sits between two Han chars (no lookaround needed;
// `[CJK]+[NEUTRAL][CJK]+` already requires Han on both sides). Keeps a
// CJK-flanked quote/dash on the CJK font in a Latin-base cluster (mirror of the
// French-apostrophe bug). Host-verified via findGrep. Same NEUTRAL_PUNCT_CLASS.
var CJK_CLASS = "[\\x{4E00}-\\x{9FFF}\\x{3400}-\\x{4DBF}\\x{F900}-\\x{FAFF}]";
var GREP_CJK_PATTERN = CJK_CLASS + "+(?:" + NEUTRAL_PUNCT_CLASS + CJK_CLASS + "+)*";

// Detect whether a font family looks like a CJK font (used to decide if
// a paragraph style needs the Latin GREP rule).
function _isCJKFont(name) {
    if (!name) return false;
    var lower = String(name).toLowerCase();
    // #E2E-8b: extend the CJK marker list with Adobe / Monotype CJK
    // family stems that appear in real packages (e.g. "MHei PRC",
    // "STSong-Light", "Adobe Heiti Std"). Previously these slipped
    // through unrecognized, so docCjkFonts was empty and the CJK
    // resolver fell back to the user preference list, silently
    // replacing the document's actual CJK font.
    var cjkMarkers = [
        "source han", "noto sans cjk", "noto serif cjk",
        "microsoft yahei", "microsoft jhenghei", "yu mincho", "yu gothic",
        "pingfang", "simsun", "simhei", "nsimsun", "fangsong", "kaiti",
        "dengxian", "ms mincho", "ms gothic", "hiragino", "malgun gothic",
        "gulim", "batang",
        // Adobe / Monotype / common simplified Chinese stems
        "mhei", "mksong", "mksung", "stsong", "stsung", "stkaiti", "stfangsong",
        "adobe heiti", "adobe song", "adobe ming", "adobe fangsong", "adobe kaiti",
        "founder", "fz ", "fzltxh", "fzltzh",
        // Japanese / Korean common stems
        "ryumin", "shin go", "kozuka", "iwata", "midashi",
        "applemyungjo", "applegothic", "nanum"
    ];
    for (var i = 0; i < cjkMarkers.length; i++) {
        if (lower.indexOf(cjkMarkers[i]) >= 0) return true;
    }
    return false;
}

// ─── Utility: round + tolerance bucketing ─────────────────────────

function _round(n, decimals) {
    var f = Math.pow(10, decimals || 0);
    return Math.round((Number(n) || 0) * f) / f;
}

// Pick the most-frequent key in a count map. Tie → fallback (typically
// the sample seg's own value so behavior matches non-format-preserving
// flow on edge cases). Used by Pass 3.5 for sB/sA winner selection.
function _pickMostCommon(countsMap, fallback) {
    var best = null, bestCount = 0;
    for (var k in countsMap) {
        if (!countsMap.hasOwnProperty(k)) continue;
        var c = countsMap[k];
        if (c > bestCount) { bestCount = c; best = k; }
    }
    if (best === null) return fallback;
    var n = Number(best);
    return isFinite(n) ? n : fallback;
}

function _roundTol(n, tol) {
    // Bucket n into buckets of size tol so values within tol get same key
    if (!tol || tol <= 0) return _round(n, 4);
    return Math.round((Number(n) || 0) / tol) * tol;
}

function _shortHash(s) {
    // djb2 → 8 hex chars
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
        h = ((h << 5) + h) + s.charCodeAt(i);
        h = h | 0;
    }
    var hex = (h >>> 0).toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
}

function _sanitize(name) {
    if (!name) return "Unknown";
    return String(name).replace(/[^A-Za-z0-9]+/g, "_");
}

// ─── Descriptive style naming ─────────────────────────────────────
//
// Format: _T_p_<size>pt/<leading>pt_<font-initials>_<style-initials>_<hash4>
// AUTO leading variant: _T_p_<size>pt/A_<font-initials>_<style-initials>_<hash4>
//
// Size/leading lead the name so the InDesign Paragraph Styles panel
// alphabetically sorts by typographic level (7pt body together, 16pt
// subheads together, 48pt headlines together) instead of by font name.
//
// Examples:
//   _T_p_16pt/19pt_EST_L_bcb8     (EJ Sans Text Light 16pt, leading 19pt)
//   _T_p_48pt/A_EST_B_d12f        (EJ Sans Text Bold 48pt, AUTO leading)
//   _T_p_16pt/20pt_EST_SMI_3c02   (EJ Sans Text SemiCondensed Medium Italic)
//
// Initials = first letter of each space-separated word, uppercase.
// Hash = 4 chars of djb2 → cross-run stable; collisions in 65k space are rare
// but defensively de-duplicated by appending _2/_3 suffix.

function _abbreviateWords(s, fallback) {
    if (!s) return fallback || "X";
    var str = String(s).trim();
    if (!str) return fallback || "X";
    var parts = str.split(/\s+/);
    var abbr = "";
    for (var i = 0; i < parts.length; i++) {
        var ch = parts[i].charAt(0);
        if (ch && /[A-Za-z0-9]/.test(ch)) abbr += ch.toUpperCase();
    }
    return abbr || (fallback || "X");
}

function _formatNumeric(n) {
    if (typeof n !== "number" || !isFinite(n)) return "?";
    if (n === Math.floor(n)) return String(n);
    // Keep 1 decimal place for fractional sizes (e.g., 7.5pt)
    return String(Math.round(n * 10) / 10);
}

function _formatSizeLeading(size, leading) {
    var sz = _formatNumeric(size);
    var isAuto = (leading === "AUTO" || leading === null || leading === undefined
        || (typeof leading === "string" && leading.indexOf("AUTO") >= 0));
    if (isAuto) return sz + "pt/A";
    return sz + "pt/" + _formatNumeric(leading) + "pt";
}

function _buildDescriptiveStyleName(baseline, paraSnap, shortHash, usedNames, role) {
    var f = _abbreviateWords(baseline.fontFamily, "X");
    var s = _abbreviateWords(baseline.fontStyle || "Regular", "R");
    var szLd = _formatSizeLeading(baseline.fontSize, paraSnap.leading);
    var hash4 = String(shortHash).substring(0, 4);
    // Order: role → size/leading → font → weight → hash. Role-first sorts
    // the Paragraph Styles panel by semantic group (all body together,
    // all head together, etc.). When role is omitted (legacy / role
    // detection disabled), name reverts to size-first.
    var rolePart = role ? (role + "_") : "";
    var base = "_T_p_" + rolePart + szLd + "_" + f + "_" + s + "_" + hash4;
    var name = base;
    var n = 2;
    while (usedNames[name]) { name = base + "_" + n; n++; }
    usedNames[name] = true;
    return name;
}

// Role classification — runs after paraStylesToCreate is built. Identifies
// "body" anchor as the highest-paragraph-count entry (must be ≥ 15% of all
// paragraphs to be considered valid body), then labels each entry by its
// size ratio to body. When no body anchor → size-tier labels (xs..xxl).
//
// Role bands (vs body size):
//   < 0.90      → caption
//   0.90-1.15   → body (winner = bodyEntry itself; same-size others get
//                       body_b/body_l/body_m/body_sb/body_i suffix)
//   1.15-2.5    → sub
//   2.5-4.5     → head
//   > 4.5       → display
//
// Size-tier fallback (when no body):
//   ≤6pt → xs, ≤10 → sm, ≤16 → md, ≤30 → lg, ≤60 → xl, >60 → xxl
function _classifyRoles(paraStylesToCreate, segmentsByTid) {
    if (!paraStylesToCreate || !paraStylesToCreate.length) return;
    var totalParas = 0;
    var entries = paraStylesToCreate.map(function (ps) {
        var seg = ps.tids && ps.tids[0] ? segmentsByTid[ps.tids[0]] : null;
        var size = seg && seg.format_snapshot && seg.format_snapshot.baseline ? seg.format_snapshot.baseline.fontSize : 0;
        var fontStyle = seg && seg.format_snapshot && seg.format_snapshot.baseline ? (seg.format_snapshot.baseline.fontStyle || "Regular") : "Regular";
        var c = (ps.tids || []).length;
        totalParas += c;
        return { ps: ps, size: size, count: c, fontStyle: fontStyle };
    });
    if (totalParas === 0) return;

    // Find body candidate
    var bodyEntry = null, bodyCount = 0;
    for (var i = 0; i < entries.length; i++) {
        if (entries[i].count > bodyCount) { bodyCount = entries[i].count; bodyEntry = entries[i]; }
    }
    var bodyValid = bodyEntry && (bodyEntry.count / totalParas >= 0.15);
    var bodySize = bodyValid ? bodyEntry.size : null;

    function tierFallback(size) {
        if (size <= 6) return "xs";
        if (size <= 10) return "sm";
        if (size <= 16) return "md";
        if (size <= 30) return "lg";
        if (size <= 60) return "xl";
        return "xxl";
    }
    function bodyVariant(fontStyle) {
        var s = String(fontStyle || "").toLowerCase();
        if (s.indexOf("bold") >= 0) return "body_b";
        if (s.indexOf("italic") >= 0) return "body_i";
        if (s.indexOf("light") >= 0) return "body_l";
        if (s.indexOf("semi") >= 0) return "body_sb";
        if (s.indexOf("medium") >= 0) return "body_m";
        return "body_alt";
    }
    for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        if (!bodyValid || !e.size || e.size <= 0) {
            e.ps.role = tierFallback(e.size || 0);
            continue;
        }
        var ratio = e.size / bodySize;
        if (ratio < 0.90) e.ps.role = "caption";
        else if (ratio <= 1.15) e.ps.role = (e === bodyEntry) ? "body" : bodyVariant(e.fontStyle);
        else if (ratio <= 2.5) e.ps.role = "sub";
        else if (ratio <= 4.5) e.ps.role = "head";
        else e.ps.role = "display";
    }
}

// ─── Color key (tolerance bucketed) ────────────────────────────────

// Color key — strict imperceptible-only tolerance.
//
// Strategy: convert any color (CMYK / RGB / LAB) to a common RGB
// representation, round to nearest integer (tol = 1 RGB unit ≈ ΔE76 0.5-1,
// at or below human perception threshold ~ΔE 1). Two colors with even a
// 2-unit RGB diff get distinct keys → never merged.
//
// Examples:
//   - "Dark Gray" CMYK (70.55, 61.63, 58.78, 48.55) → RGB (39, 50, 54)
//   - "R=58 G=61 B=63" RGB → RGB (58, 61, 63)
//     → DIFFERENT keys (max channel diff = 19) → not merged
//   - Two paragraphs both using "Dark Gray" → both convert to same RGB →
//     same key → merged (same swatch identity)
//
// Special cases:
//   - [None] swatch → "none"
//   - No values + no swatch → "null"
//   - Unknown space → preserve space + raw rounded values as fallback key
// InDesign auto-generates names like "R=58 G=61 B=63" or "C=70 M=60 Y=60 K=50"
// for unnamed custom colors. These names carry no design intent — prefer
// designer-named swatches (e.g. "Dark Gray", "Brand Blue") for canonical
// representation when paragraph-count ties occur.
function _isAutoSwatchName(name) {
    return !name || /^[RCK]=\d/.test(String(name));
}

// Among multiple swatch names that map to the same canonical RGB, pick
// the one likely to represent designer intent: most-used name first,
// then prefer non-auto, then alphabetical (deterministic).
function _bestSwatchName(swatchCounts) {
    var names = Object.keys(swatchCounts || {});
    if (!names.length) return null;
    names.sort(function (a, b) {
        if (swatchCounts[a] !== swatchCounts[b]) return swatchCounts[b] - swatchCounts[a];
        var aAuto = _isAutoSwatchName(a) ? 1 : 0;
        var bAuto = _isAutoSwatchName(b) ? 1 : 0;
        if (aAuto !== bAuto) return aAuto - bAuto;
        return a < b ? -1 : 1;
    });
    return names[0];
}

// Canonicalize all displayedRGB values across segments via union-find.
// Two RGB triples join the same class if max channel diff ≤ 1 (ΔE ≤ ~0.5).
// Mutates seg.format_snapshot.baseline.fillColor (and run-level fillColors)
// to add a `canonicalRGB` field that all subsequent code uses for keying.
//
// Winner selection within a class (the canonical representative):
//   1. Highest paragraph count
//   2. Tie-break: prefer color whose primary swatch is designer-named
//      (e.g. "Dark Gray" beats "R=58 G=61 B=63")
//   3. Final tie-break: alphabetical swatch name → fully deterministic
function _canonicalizeColors(segments, tol) {
    if (!segments || !segments.length) return;
    // tol=0 → no canonicalization (strict swatch identity preserved)
    if (typeof tol !== "number" || tol <= 0) return;
    var seen = {};   // "r,g,b" → { rgb, count, swatches: { name: count } }
    function recordRGB(rgb, swatchName) {
        if (!rgb || rgb.length < 3) return;
        var k = rgb[0] + "," + rgb[1] + "," + rgb[2];
        if (!seen[k]) seen[k] = { rgb: [rgb[0], rgb[1], rgb[2]], count: 0, swatches: {} };
        seen[k].count++;
        if (swatchName) seen[k].swatches[swatchName] = (seen[k].swatches[swatchName] || 0) + 1;
    }
    for (var i = 0; i < segments.length; i++) {
        var fs = segments[i] && segments[i].format_snapshot;
        if (!fs) continue;
        if (fs.baseline && fs.baseline.fillColor && fs.baseline.fillColor.displayedRGB) {
            recordRGB(fs.baseline.fillColor.displayedRGB, fs.baseline.fillColor.swatch);
        }
        if (fs.runs && fs.runs.length) {
            for (var r = 0; r < fs.runs.length; r++) {
                if (fs.runs[r] && fs.runs[r].fillColor && fs.runs[r].fillColor.displayedRGB) {
                    recordRGB(fs.runs[r].fillColor.displayedRGB, fs.runs[r].fillColor.swatch);
                }
            }
        }
    }
    var keys = Object.keys(seen);
    var n = keys.length;
    if (n === 0) return;

    // Union-find — pairwise max-channel-diff ≤ 1 → same class
    var parent = []; for (var x = 0; x < n; x++) parent[x] = x;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    var rgbs = keys.map(function (k) { return seen[k].rgb; });
    for (var i2 = 0; i2 < n; i2++) {
        for (var j = i2 + 1; j < n; j++) {
            var d = Math.max(
                Math.abs(rgbs[i2][0] - rgbs[j][0]),
                Math.abs(rgbs[i2][1] - rgbs[j][1]),
                Math.abs(rgbs[i2][2] - rgbs[j][2])
            );
            if (d <= tol) union(i2, j);
        }
    }
    // Pick canonical = most-used color per component, with tie-break that
    // prefers designer-named swatches over auto-named (R=… / C=…) ones.
    var byRoot = {};
    for (var k2 = 0; k2 < n; k2++) {
        var r2 = find(k2);
        if (!byRoot[r2]) byRoot[r2] = [];
        byRoot[r2].push({
            key: keys[k2],
            rgb: rgbs[k2],
            count: seen[keys[k2]].count,
            swatches: seen[keys[k2]].swatches,
            bestName: _bestSwatchName(seen[keys[k2]].swatches)
        });
    }
    var canonical = {};   // "r,g,b" → canonical [r,g,b]
    Object.keys(byRoot).forEach(function (root) {
        var members = byRoot[root];
        members.sort(function (a, b) {
            // 1. Higher paragraph count first
            if (a.count !== b.count) return b.count - a.count;
            // 2. Designer-named swatch beats auto-named
            var aAuto = _isAutoSwatchName(a.bestName) ? 1 : 0;
            var bAuto = _isAutoSwatchName(b.bestName) ? 1 : 0;
            if (aAuto !== bAuto) return aAuto - bAuto;
            // 3. Alphabetical swatch name (deterministic final tie-break)
            if (!a.bestName && !b.bestName) return 0;
            if (!a.bestName) return 1;
            if (!b.bestName) return -1;
            return a.bestName < b.bestName ? -1 : 1;
        });
        var winner = members[0];
        members.forEach(function (m2) { canonical[m2.key] = winner.rgb; });
    });
    // Stamp canonicalRGB on every fillColor that has a displayedRGB
    function stamp(fillColor) {
        if (!fillColor || !fillColor.displayedRGB || fillColor.displayedRGB.length < 3) return;
        var k3 = fillColor.displayedRGB[0] + "," + fillColor.displayedRGB[1] + "," + fillColor.displayedRGB[2];
        if (canonical[k3]) fillColor.canonicalRGB = canonical[k3];
    }
    for (var i3 = 0; i3 < segments.length; i3++) {
        var fs2 = segments[i3] && segments[i3].format_snapshot;
        if (!fs2) continue;
        if (fs2.baseline) stamp(fs2.baseline.fillColor);
        if (fs2.runs && fs2.runs.length) {
            for (var r3 = 0; r3 < fs2.runs.length; r3++) stamp(fs2.runs[r3] && fs2.runs[r3].fillColor);
        }
    }
}

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

function _colorKey(fillColor) {
    if (!fillColor) return "null";
    if (fillColor.swatch === "[None]") return "none";
    // Prefer canonicalRGB (set by buildStylePlan's _canonicalizeColors —
    // collapses ICC rounding noise within a class via union-find ≤ 1 unit).
    if (fillColor.canonicalRGB && fillColor.canonicalRGB.length >= 3) {
        return "rgb:" + fillColor.canonicalRGB[0] + "," + fillColor.canonicalRGB[1] + "," + fillColor.canonicalRGB[2];
    }
    // Next: displayedRGB from ICC conversion at capture time
    if (fillColor.displayedRGB && fillColor.displayedRGB.length >= 3) {
        return "rgb:" + fillColor.displayedRGB[0] + "," + fillColor.displayedRGB[1] + "," + fillColor.displayedRGB[2];
    }
    var vals = fillColor.values || [];
    if (vals.length === 0) {
        return "swatch:" + (fillColor.swatch || "?");
    }
    var space = String(fillColor.space || "?");
    var rgb = null;
    if (space === "RGB" && vals.length >= 3) {
        rgb = [Math.round(vals[0]), Math.round(vals[1]), Math.round(vals[2])];
    } else if (space === "CMYK" && vals.length >= 4) {
        // Fallback: naive CMYK→RGB without ICC profile. Less accurate than
        // displayedRGB but better than nothing when convertToRGB wasn't
        // available at capture time.
        rgb = _cmykToRgb(vals[0], vals[1], vals[2], vals[3]);
    }
    if (rgb) return "rgb:" + rgb[0] + "," + rgb[1] + "," + rgb[2];
    // Unknown/unsupported space (LAB, MIXED_INK, …) — use exact rounded values
    var rounded = [];
    for (var i = 0; i < vals.length; i++) rounded.push(Math.round(vals[i]));
    return space + ":" + rounded.join(",");
}

// ─── Fingerprints ─────────────────────────────────────────────────

// Fingerprint dimensions a caller can toggle on/off. Anything NOT in the
// `dimensions` map (or set to false) is excluded from the fingerprint —
// paragraphs differing only in that dimension will collapse into one cluster
// and the cluster's first sample dictates the property value. Pass null
// or omit to include all dimensions (current default behavior).
//
// `bullets` covers the full list spec: type (NO_LIST/BULLET/NUMBERED),
// numbering format (1,2,3 vs A,B,C), start-at, and bullet character.
var ALL_FINGERPRINT_DIMENSIONS = {
    fontFamily: true, fontStyle: true, fontSize: true, fillColor: true,
    leading: true, justification: true,
    spaceBefore: true, spaceAfter: true,
    leftIndent: true, rightIndent: true, firstLineIndent: true,
    bullets: true, composer: true,
    underline: true, strikeThrough: true, tracking: true,
    baselineShift: true, horizontalScale: true, verticalScale: true,
    skew: true,
    // [indent-general · impl-audit codex P1·A] tab stops MUST be fingerprinted: they are
    // the only deferred style spec that isn't, so two paragraphs sharing everything else but
    // differing in tabs would merge into one _T_p_* cluster and inherit the SAMPLE's tabs
    // (wrong tabs for the others — silent layout/data-loss). The placemat proves tabs are
    // independent of indents (leftIndent/firstLineIndent=0, tab@15.75). Keying them makes
    // each cluster tab-homogeneous → the sample's tabs are correct for all members, exactly
    // like bullets/rules/color/leading (which are all already fingerprinted).
    tabStops: true,
    keepWithNext: true, keepLinesTogether: true,
    // Paragraph rules — split off so two visually-identical paragraphs that
    // differ ONLY in ruleAbove (e.g. 0.5pt baseline rule used as a stable
    // mixed-script underline) cluster into separate _T_p_<hash> styles
    // instead of getting merged + losing the rule on whichever segment lost
    // the majority vote.
    ruleAbove: true, ruleBelow: true
};

// [indent-general] Stable normalized key for a captured tab_stops array (position rounded
// to indent tolerance + alignment + leader + alignmentChar). null when empty. Two paragraphs
// with different tab configs ⇒ different keys ⇒ different clusters (so the per-cluster sample
// tabs are correct for all members). Rounding mirrors the indent/leading tolerance buckets.
function _tabStopsKey(tabStops, tolerance) {
    if (!tabStops || !tabStops.length) return null;
    var tol = tolerance || DEFAULT_TOLERANCE;
    var parts = [];
    for (var i = 0; i < tabStops.length; i++) {
        var ts = tabStops[i];
        if (!ts || typeof ts.position !== "number") continue;
        parts.push(_roundTol(ts.position, tol.indent_pt) + ":" + (ts.alignment || "") + ":" + (ts.leader || "") + ":" + (ts.alignment_char || ""));
    }
    parts.sort();   // [xhigh P4·D] order-independent (InDesign returns position-sorted, but be robust)
    return parts.length ? parts.join("|") : null;
}

function fingerprintParagraph(paraSnap, baseline, tolerance, dimensions) {
    var tol = tolerance || DEFAULT_TOLERANCE;
    if (!paraSnap || !baseline) return null;
    var dim = dimensions || ALL_FINGERPRINT_DIMENSIONS;
    var key = {};
    // Character-level baseline
    if (dim.fontFamily)  key.latinFamily = baseline.fontFamily || "?";
    if (dim.fontStyle)   key.latinStyle  = baseline.fontStyle  || "Regular";
    if (dim.fontSize)    key.fs          = _roundTol(baseline.fontSize, tol.fontSize_pt);
    if (dim.fillColor)   key.color       = _colorKey(baseline.fillColor);
    if (dim.underline)   key.under       = !!baseline.underline;
    if (dim.strikeThrough) key.strk      = !!baseline.strikeThrough;
    // Character-geometry attributes (tracking / baseline shift / scale) are
    // ALWAYS in the fingerprint, regardless of `dimensions` input. They rarely
    // appear, but when a designer sets one (e.g. hScale=85% to shrink a URL
    // into a tight master frame), it defines that paragraph's visual identity
    // and must NOT be coalesced with neighbours that happen to share font/
    // size/color but render at full width. Excluding these caused the
    // "edwardjones.ca" master URL overflow on every page after apply.
    // Apply preset snapping (deadzone + step buckets) before stamping into
    // the fingerprint. This collapses sparsely-set typographic dimensions
    // (tracking, scale, baselineShift, skew) into "default" plus a few
    // discrete steps — matching how designers actually pick these values.
    if (dim.tracking !== false)        key.track  = _snapTracking(baseline.tracking);
    if (dim.baselineShift !== false)   key.bShift = _snapBaselineShift(baseline.baseline_shift);
    if (dim.horizontalScale !== false) key.hScale = _snapHScale(baseline.horizontal_scale);
    if (dim.verticalScale !== false)   key.vScale = _snapVScale(baseline.vertical_scale);
    if (dim.skew !== false)            key.skew   = _snapSkew(baseline.skew);
    // Paragraph-level (tolerance bucketed)
    if (dim.justification) key.just = paraSnap.justification || "LEFT_ALIGN";
    if (dim.leading)       key.lead = (paraSnap.leading === "AUTO") ? "AUTO" : _roundTol(paraSnap.leading, tol.leading_pt);
    if (dim.spaceBefore)   key.sB   = _roundTol(paraSnap.space_before, tol.space_pt);
    if (dim.spaceAfter)    key.sA   = _roundTol(paraSnap.space_after, tol.space_pt);
    if (dim.firstLineIndent) key.fI = _roundTol(paraSnap.first_line_indent, tol.indent_pt);
    if (dim.leftIndent)    key.lI   = _roundTol(paraSnap.left_indent, tol.indent_pt);
    if (dim.rightIndent)   key.rI   = _roundTol(paraSnap.right_indent, tol.indent_pt);
    if (dim.bullets) {
        key.bullets = paraSnap.bullets_and_numbering_type || "NONE";
        key.nfmt    = paraSnap.numbering_format || null;
        key.nStart  = paraSnap.numbering_start_at || 0;
        key.bChar   = paraSnap.bullet_char || null;
        // [codex bullet-audit] include the explicit bullet_font so two bullet paragraphs
        // with the same type/char/baseline but DIFFERENT captured bullet fonts don't
        // collapse into one cluster (whose sample's font would win for both).
        key.bFont   = paraSnap.bullet_font || null;
    }
    if (dim.composer)      key.comp = paraSnap.composer || "ADOBE_PARAGRAPH_COMPOSER";
    if (dim.keepWithNext)  key.kwn  = paraSnap.keep_with_next || 0;
    if (dim.keepLinesTogether) key.klt = !!paraSnap.keep_lines_together;
    if (dim.ruleAbove) key.rA = _ruleKey(paraSnap.rule_above, tol);
    if (dim.ruleBelow) key.rB = _ruleKey(paraSnap.rule_below, tol);
    // [indent-general] tabs load-bearing for layout → keyed unless explicitly disabled
    // (mirrors the `!== false` always-on gating of tracking/scale/skew). Empty ⇒ null, so
    // no-tab paragraphs (the majority) cluster together unchanged.
    if (dim.tabStops !== false) key.tabs = _tabStopsKey(paraSnap.tab_stops, tol);
    return JSON.stringify(key);
}

// Reduce a rule_above/rule_below snap into a stable, tolerance-bucketed
// fingerprint sub-key. Inactive rules collapse to `false` so all
// no-rule paragraphs share one bucket. Active rules contribute the
// fields most likely to be designer-meaningful (weight / offset / color /
// type / width / indents). `tint` and `overprint` are deliberately
// omitted from the hash — they exist in the round-tripped spec but
// rarely differ at clustering scale, and including them would over-
// fragment clusters that share visual intent.
function _ruleKey(ruleSnap, tol) {
    if (!ruleSnap || !ruleSnap.active) return false;
    return {
        w:  _roundTol(ruleSnap.weight, tol.fontSize_pt),
        o:  _roundTol(ruleSnap.offset, tol.indent_pt),
        c:  _colorKey(ruleSnap.color),
        t:  ruleSnap.type || "Solid",
        wd: ruleSnap.width || "TEXT_WIDTH",
        li: _roundTol(ruleSnap.leftIndent, tol.indent_pt),
        ri: _roundTol(ruleSnap.rightIndent, tol.indent_pt)
    };
}

function fingerprintRun(run, tolerance) {
    var tol = tolerance || DEFAULT_TOLERANCE;
    if (!run) return null;
    return JSON.stringify({
        ff: run.fontFamily || "?",
        fst: run.fontStyle || "Regular",
        fs: _roundTol(run.fontSize, tol.fontSize_pt),
        color: _colorKey(run.fillColor),
        u: !!run.underline,
        s: !!run.strikeThrough,
        t: _round(run.tracking, 0),
        bs: _round(run.baseline_shift, 1),
        hs: _round(run.horizontal_scale, 0),
        vs: _round(run.vertical_scale, 0),
        // #E2E-1: position dim contributes to run identity so SUPERSCRIPT
        // runs cluster separately from NORMAL runs of the same font/size.
        pos: run.position || "NORMAL"
    });
}

// ─── Plan builder ─────────────────────────────────────────────────

/**
 * Build a StylePlan from segments. Pure computation, no doc writes.
 *
 * @param {Array} segments — segments.json segment objects with format_snapshot + paragraph_snapshot
 * @param {Document} workDoc — InDesign workDoc (for font resolution)
 * @param {Object} options — { tolerance?, fontPolicy?, reuseFrom? }
 * @param {Object} deps — { fontMapping, findFont, [colorSpace, position] }
 * @returns {Object} plan
 */
function buildStylePlan(segments, workDoc, options, deps) {
    if (!segments) throw new Error("buildStylePlan: segments required");
    if (!deps || !deps.fontMapping || !deps.findFont) {
        throw new Error("buildStylePlan: deps.fontMapping + deps.findFont required");
    }

    // #E2E-14: reset CJK weight caches per call so a freshly-opened doc with
    // a different installed-font set doesn't read stale results from a
    // previous invocation.
    _cjkWeightCache = {};
    _cjkFamilyStylesCache = {};
    // #E2E-15: same for the source-font installed probe cache.
    _installedProbeCache = {};

    var opts = options || {};
    var tolerance = opts.tolerance || DEFAULT_TOLERANCE;
    var fingerprintDimensions = opts.fingerprintDimensions || null;   // null = include all
    var colorTol = (typeof opts.colorTol === "number") ? opts.colorTol : 0;   // 0 = strict (no canonicalization)
    var fontPolicy = opts.fontPolicy;   // null → fontMapping defaults
    // TODO#15 ②: pair-authoritative CJK weight lookup — fn(srcFont, srcStyle) →
    // { dstFont, dstWeight }|null — threaded from the import byPair (built by
    // font_mapping_pairs.makeCjkWeightLookup). null → today's rank-nearest
    // behavior (fail-open; reorganize / no-byPair paths unaffected).
    var cjkPairWeightLookup = (typeof opts.cjkPairWeightLookup === "function") ? opts.cjkPairWeightLookup : null;
    // Per-build CJK weight audit: pair-mapped count vs SURFACED rank fallbacks
    // (attached to clusterReport for the import log/report — user principle:
    // rank is never a silent cross-font guess).
    var _cjkWeightResolution = { fromPair: 0, fallbackRank: [] };
    var fontDeps = { findFont: deps.findFont };
    // Phase 9 — format-preserving merge for spaceBefore/spaceAfter.
    // Default ON: cluster ignores those two dims and the cluster style writes
    // the most-paragraphs-wins value; per-paragraph overrides restore the
    // original sB/sA at apply time. Setting spacePreservingMerge=false
    // reverts to strict per-spacing-distinct paragraph styles (legacy
    // behavior).
    var spacePreservingMerge = (opts.spacePreservingMerge === false) ? false : true;
    // #28: when true (default), master-spread paragraphs cluster
    // separately from body-page paragraphs even if their visual format
    // is identical. Pooling them risks (a) a body cluster's "winner"
    // value overriding a deliberately-different master footer/header,
    // visible on every page that uses the master, and (b) master frames
    // (running heads, page numbers, copyright strips) being absorbed
    // into a body theme that doesn't match the brand template. Set
    // false to opt back into single-pool clustering.
    var splitMasterFromBody = (opts.splitMasterFromBody === false) ? false : true;
    var effectiveDims = fingerprintDimensions;
    if (spacePreservingMerge) {
        // Force-disable sB/sA in the fingerprint regardless of caller's input
        // so the cluster bucket collapses across spacing differences.
        effectiveDims = effectiveDims ? Object.assign({}, effectiveDims) : Object.assign({}, ALL_FINGERPRINT_DIMENSIONS);
        effectiveDims.spaceBefore = false;
        effectiveDims.spaceAfter = false;
    }

    // Wrap fingerprintParagraph so callers don't have to remember to
    // apply the origin prefix at every cluster-key call site.
    function _scopedPfp(seg) {
        var basePfp = fingerprintParagraph(
            seg.paragraph_snapshot, seg.format_snapshot.baseline,
            tolerance, effectiveDims
        );
        if (!basePfp) return null;
        if (!splitMasterFromBody) return basePfp;
        return (seg.is_master ? "M:" : "B:") + basePfp;
    }

    // ─── Pass 0: canonicalize displayedRGB across all segments ──────
    // Builds equivalence classes via union-find on max-channel-diff ≤ colorTol.
    // tol=0 (strictest): exact RGB match only — colors merge iff identical.
    // tol=1: collapses ICC rounding noise (ΔE < 1, imperceptible).
    // tol≥2: progressively looser visual matching.
    _canonicalizeColors(segments, colorTol);

    // ─── Pass 1: cluster paragraphs ──────────────────────────────
    var paraFingerprints = {};   // fp → { tids:[], sample seg, sBCounts, sACounts }
    var runFingerprintsObserved = {};   // fp → count (only for clusterReport)
    var nLatinSampledByFingerprint = {};   // baseline.fontFamily seen
    // #BRIDGE-28: parallel collection of CJK fonts from scriptByFont
    // metadata, used by Latin-base reverse-routing to build cjkPool.
    var nCJKSampledByFingerprint = {};

    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (!seg || !seg.paragraph_snapshot || !seg.format_snapshot) continue;
        var pfp = _scopedPfp(seg);
        if (!pfp) continue;
        if (!paraFingerprints[pfp]) {
            paraFingerprints[pfp] = { tids: [], sample: seg, sBCounts: {}, sACounts: {}, sourceStyleNames: [] };
        } else {
            // Prefer scriptByFont samples as the cluster representative —
            // they carry Latin-font info that pure-baseline samples lack.
            // Without this, a cluster mixing uniform-CJK + script-by-font(CJK,Latin)
            // members might pick the uniform sample, lose Latin font info,
            // and emit a GREP rule pointing to baseline (which is CJK).
            var existingSbf = paraFingerprints[pfp].sample.format_snapshot.scriptByFont;
            var thisSbf     = seg.format_snapshot.scriptByFont;
            if (thisSbf && !existingSbf) paraFingerprints[pfp].sample = seg;
        }
        paraFingerprints[pfp].tids.push(seg.tid);
        // #BRIDGE-13 / #BRIDGE-14b: track every original paragraph_style
        // name that landed in this cluster, deduped. commitStylePlan
        // copies designer-added (non-`_T_*`) nested GREP rules from
        // EVERY such style. The real export writes `paragraph_style`
        // (see export_translation_package.idjs); some fixtures /
        // older runs use `source_paragraph_style_name`. Accept either
        // so the union doesn't silently degrade to empty (which would
        // make the #BRIDGE-13 fix a no-op on real packages).
        var __ssn = seg.source_paragraph_style_name || seg.paragraph_style || "";
        if (__ssn && paraFingerprints[pfp].sourceStyleNames.indexOf(__ssn) < 0) {
            paraFingerprints[pfp].sourceStyleNames.push(__ssn);
        }

        // Phase 9: tally sB/sA distribution per cluster so Pass 1.5 can
        // pick the most-paragraphs-wins value as the cluster style's
        // default and emit per-segment overrides for the rest.
        if (spacePreservingMerge) {
            var sBKey = _round(seg.paragraph_snapshot.space_before || 0, 2);
            var sAKey = _round(seg.paragraph_snapshot.space_after  || 0, 2);
            paraFingerprints[pfp].sBCounts[sBKey] = (paraFingerprints[pfp].sBCounts[sBKey] || 0) + 1;
            paraFingerprints[pfp].sACounts[sAKey] = (paraFingerprints[pfp].sACounts[sAKey] || 0) + 1;
        }

        // Track Latin font occurrences for Pass 2 font resolution. Uses
        // _resolveLatinFontForCluster so script-by-font paragraphs contribute
        // their actual Latin font (not the CJK baseline they were folded into).
        var lf = _resolveLatinFontForCluster(seg).fontFamily;
        if (lf) nLatinSampledByFingerprint[lf] = (nLatinSampledByFingerprint[lf] || 0) + 1;
        // #BRIDGE-28: track CJK font occurrences from scriptByFont info.
        // Only segments with scriptByFont.scriptToFont.CJK contribute —
        // baseline-CJK clusters already use cjkResult and don't need a
        // separate pool entry. Used by Pass 3 to build cjkPool.
        var cf = _resolveCJKFontForCluster(seg).fontFamily;
        if (cf) nCJKSampledByFingerprint[cf] = (nCJKSampledByFingerprint[cf] || 0) + 1;

        var runs = seg.format_snapshot.runs;
        if (runs && runs.length) {
            for (var r = 0; r < runs.length; r++) {
                var rfp = fingerprintRun(runs[r], tolerance);
                if (rfp) runFingerprintsObserved[rfp] = (runFingerprintsObserved[rfp] || 0) + 1;
            }
        }
    }

    // ─── Pass 2: resolve fonts (CJK + Latin) ─────────────────────
    // #E2E-8 (reverted): docCjkFonts collection deferred to the font-
    // compliance milestone. resolveCJKFont uses the preference fallback
    // list uniformly for now (CJK paragraphs land on Source Han Sans CN
    // regardless of source doc's actual CJK family).
    var cjkResult = deps.fontMapping.resolveCJKFont(workDoc, fontPolicy, fontDeps);
    var latinResolutions = {};   // sourceFontName → resolveLatinFont result
    for (var srcFontName in nLatinSampledByFingerprint) {
        if (!nLatinSampledByFingerprint.hasOwnProperty(srcFontName)) continue;
        latinResolutions[srcFontName] = deps.fontMapping.resolveLatinFont(
            workDoc, srcFontName, fontPolicy, fontDeps
        );
    }

    // ─── Pass 3: build Latin pool (dedup by usedFontFamily + fontStyle) ──
    var latinPool = {};   // key = "<usedFontFamily>__<fontStyle>" → spec
    for (var pfp2 in paraFingerprints) {
        if (!paraFingerprints.hasOwnProperty(pfp2)) continue;
        var sample = paraFingerprints[pfp2].sample;
        // Pull Latin font from script-by-font breakdown when present;
        // otherwise fall back to baseline (existing CJK-default + Latin-baseline
        // case where baseline.fontFamily IS the Latin font).
        var sampleLatin = _resolveLatinFontForCluster(sample);
        var srcLatin = sampleLatin.fontFamily;
        var sampleStyle = sampleLatin.fontStyle;
        var resolution = latinResolutions[srcLatin];
        var usedFont = (resolution && resolution.name) ? resolution.name : srcLatin;
        if (!usedFont) continue;
        // TODO#15 ①: normalize to a SYSTEM-installed (family, style) so the
        // created _T_Latin_* CS isn't silently substituted to the wrong weight
        // (legacy "Whitney"+"Book" → installed "Whitney"+"Bold"). The GREP-rule
        // lookup below applies the SAME normalization so it hits this pool entry.
        var __nl = _normLatinFont(workDoc, usedFont, sampleStyle);
        usedFont = __nl.family; sampleStyle = __nl.fontStyle;
        var poolKey = usedFont + "__" + sampleStyle;
        if (!latinPool[poolKey]) {
            latinPool[poolKey] = {
                fingerprint: "lat_" + _shortHash(poolKey),
                name: "_T_Latin_" + _sanitize(usedFont) + "_" + _sanitize(sampleStyle),
                fontFamily: usedFont,
                fontStyle: sampleStyle,
                origin: srcLatin,                              // for report
                substituted: !!(resolution && resolution.source === "fallback")
            };
        }
    }

    // ─── Pass 3b: build CJK pool (mirror of latinPool for reverse-routing) ──
    // #BRIDGE-28: cjkPool collects `_T_CJK_*` CS specs for cluster samples
    // whose scriptByFont metadata identifies a CJK secondary script (i.e.
    // Latin-base + embedded CJK). The cluster style's nestedGrep then
    // routes CJK chars via GREP_CJK_PATTERN to this CS, so embedded CJK
    // runs keep their original CJK font instead of inheriting the Latin
    // cluster psFont (which would substitute / tofu them).
    var cjkPool = {};   // key = "<fontFamily>__<fontStyle>" → spec
    for (var pfp2b in paraFingerprints) {
        if (!paraFingerprints.hasOwnProperty(pfp2b)) continue;
        var sampleB = paraFingerprints[pfp2b].sample;
        var sbfB = sampleB.format_snapshot && sampleB.format_snapshot.scriptByFont;
        if (!sbfB || sbfB.baseScript !== "LATIN") continue;  // only Latin-base needs CJK pool
        var sampleCJK = _resolveCJKFontForCluster(sampleB);
        var srcCJK = sampleCJK.fontFamily;
        if (!srcCJK) continue;
        var cjkPoolKey = srcCJK + "__" + sampleCJK.fontStyle;
        if (!cjkPool[cjkPoolKey]) {
            cjkPool[cjkPoolKey] = {
                fingerprint: "cjk_" + _shortHash(cjkPoolKey),
                name: "_T_CJK_" + _sanitize(srcCJK) + "_" + _sanitize(sampleCJK.fontStyle),
                fontFamily: srcCJK,
                fontStyle: sampleCJK.fontStyle,
                origin: srcCJK
            };
        }
    }

    // ─── Pass 3.5: pick cluster sB/sA winners (Phase 9 format-preserving merge) ──
    // For each cluster, the most-paragraphs-wins value becomes the cluster
    // style's spaceBefore/spaceAfter. This is recorded on the bucket so
    // Pass 4 reads it instead of the (arbitrary) sample's value.
    if (spacePreservingMerge) {
        for (var pfpW in paraFingerprints) {
            if (!paraFingerprints.hasOwnProperty(pfpW)) continue;
            var bucketW = paraFingerprints[pfpW];
            bucketW.winnerSB = _pickMostCommon(bucketW.sBCounts, bucketW.sample.paragraph_snapshot.space_before || 0);
            bucketW.winnerSA = _pickMostCommon(bucketW.sACounts, bucketW.sample.paragraph_snapshot.space_after  || 0);
        }
    }

    // ─── Pass 4: paraStylesToCreate (with latinStyleKey + grepRule) ──
    var paraStylesToCreate = [];
    var usedStyleNames = {};
    for (var pfp3 in paraFingerprints) {
        if (!paraFingerprints.hasOwnProperty(pfp3)) continue;
        var bucket = paraFingerprints[pfp3];
        var sampleSeg = bucket.sample;
        var baseline = sampleSeg.format_snapshot.baseline;
        var paraSnap = sampleSeg.paragraph_snapshot;

        var hash = _shortHash(pfp3);
        var styleName = _buildDescriptiveStyleName(baseline, paraSnap, hash, usedStyleNames);

        // #BRIDGE-27: detect the designer "CJK psFont + GREP-routed Latin"
        // pattern on the sample's source paragraph style. When present,
        // cluster psFont must preserve the source CJK family (most-chars-
        // wins baseline would incorrectly pick the GREP-routed Latin) AND
        // the cluster should emit its own Latin GREP routing to keep the
        // structure intact.
        var __srcPsName = sampleSeg.source_paragraph_style_name || sampleSeg.paragraph_style || "";
        var designerCJKPattern = null;
        try { designerCJKPattern = _detectDesignerCJKPsWithLatinGrep(workDoc, __srcPsName); }
        catch (eDp) {}

        // Decide: include GREP rule for this paragraph style?
        // Rule: always add for CJK-default styles. Skip only if default font
        // is already Latin (rare, non-CJK target case).
        var willHaveCJKDefault = !!(cjkResult && cjkResult.name) || !!designerCJKPattern;
        // Reorganize-mode (no preference list) needs the GREP rule whenever
        // the cluster sample has script-by-font info — baseline is now CJK
        // (set by applyScriptByFontDetection) so Latin chars in the paragraph
        // would lose their original font without the GREP routing.
        var hasScriptByFont = !!(sampleSeg.format_snapshot && sampleSeg.format_snapshot.scriptByFont);
        var grepRule = null;
        if (willHaveCJKDefault || hasScriptByFont) {
            // Find the matching latin pool entry — uses script-by-font Latin
            // when present, baseline otherwise.
            var sampleLatinFn = _resolveLatinFontForCluster(sampleSeg);
            var srcLatinFn = sampleLatinFn.fontFamily;
            var sampleStyleFn = sampleLatinFn.fontStyle;
            var resolution2 = latinResolutions[srcLatinFn];
            var usedFontFn = (resolution2 && resolution2.name) ? resolution2.name : srcLatinFn;
            if (usedFontFn) {
                // TODO#15 ①: same system-installed normalization as the pool
                // build above so this lookup hits the (normalized) pool entry.
                var __nlFn = _normLatinFont(workDoc, usedFontFn, sampleStyleFn);
                usedFontFn = __nlFn.family; sampleStyleFn = __nlFn.fontStyle;
                var poolKeyFn = usedFontFn + "__" + sampleStyleFn;
                var latinSpec = latinPool[poolKeyFn];
                if (latinSpec) {
                    grepRule = {
                        expression: GREP_LATIN_PATTERN,
                        latinStyleFingerprint: latinSpec.fingerprint
                    };
                }
            }
        }

        // #BRIDGE-28: Latin-base reverse routing — when the cluster sample
        // has scriptByFont with baseScript=LATIN, embed CJK chars need to
        // be routed via a separate GREP rule to a `_T_CJK_*` CS so they
        // keep their original CJK font instead of inheriting the Latin
        // cluster psFont (which would substitute / tofu CJK glyphs).
        var cjkGrepRule = null;
        var sbfForCJK = sampleSeg.format_snapshot && sampleSeg.format_snapshot.scriptByFont;
        if (sbfForCJK && sbfForCJK.baseScript === "LATIN" && sbfForCJK.scriptToFont && sbfForCJK.scriptToFont.CJK) {
            var sampleCjkRule = _resolveCJKFontForCluster(sampleSeg);
            var srcCjkRule = sampleCjkRule.fontFamily;
            var sampleCjkStyleRule = sampleCjkRule.fontStyle;
            if (srcCjkRule) {
                var cjkPoolKey2 = srcCjkRule + "__" + sampleCjkStyleRule;
                var cjkSpecRule = cjkPool[cjkPoolKey2];
                if (cjkSpecRule) {
                    cjkGrepRule = {
                        expression: GREP_CJK_PATTERN,
                        cjkStyleFingerprint: cjkSpecRule.fingerprint
                    };
                }
            }
        }

        // Collect properties for the new para style.
        // String/spec values that need runtime InDesign-context resolution
        // (justification enum, fillColor swatch lookup) stay as strings here
        // and get converted in commitStylePlan via _resolveStyleProperties.
        //
        // Font/style coupling decision:
        //   When CJK is applied (translation mode): appliedFont = CJK font,
        //     fontStyle = "Regular" (CJK fonts only have Regular weight).
        //     Latin character weights are preserved by the GREP rule
        //     applying _T_Latin_<font>_<weight> per fingerprint.
        //   When CJK is NOT applied (reorganize-only / no-CJK mode):
        //     appliedFont = baseline.fontFamily (original Latin font),
        //     fontStyle = baseline.fontStyle (original weight). Without
        //     this, all paragraphs default to "Regular" and lose Light/
        //     Bold/Medium/Semibold weights.
        var hasCjk = !!(cjkResult && cjkResult.name);
        // Phase 9: when spacePreservingMerge is on, the cluster picked a
        // most-paragraphs-wins sB/sA; use it instead of the sample's
        // (arbitrary) values so all members get the same style default.
        // Off → fall back to sample-from-cluster as before.
        var clusterSB = (spacePreservingMerge && bucket.winnerSB !== undefined) ? bucket.winnerSB : paraSnap.space_before;
        var clusterSA = (spacePreservingMerge && bucket.winnerSA !== undefined) ? bucket.winnerSA : paraSnap.space_after;

        // #E2E-15 (rev2): fallback-mode CJK resolution. Family is LOCKED to
        // the cjk_resolution family (Source Han Sans CN), but the style/weight
        // tracks the source baseline (subhead Xbold → SHS Heavy; body Bold →
        // SHS Bold; body Regular → SHS Regular). This fixes both
        //   (a) "subhead Bold demoted to Regular" — weight was being dropped
        //   (b) "weight drift between paragraphs" — every CJK paragraph was
        //       getting hardcoded Regular regardless of source intent
        // while still respecting the user's directive that compliance-mode
        // CJK fallback uses Source Han exclusively (no original-family
        // family).
        //
        // Weight resolution: take source style (stripped of Italic), probe
        // SHS for that weight name; if not installed, pick the SHS weight
        // closest by rank (ties prefer going UP/heavier). SHS ships
        // ExtraLight..Heavy, so a request for Xbold (rank 800) maps to Heavy
        // (rank 800) exactly, Bold→Bold, Regular→Regular, Medium→Medium, etc.
        //
        // Probes use `_isFontInstalled` (byName-only); no buildFontIndex
        // enumeration (that path stalled InDesign in earlier attempts).
        var resolvedCjkFamily = cjkResult ? cjkResult.name : "";
        var resolvedCjkStyle = "Regular";
        var srcStyle  = (baseline && baseline.fontStyle) ? baseline.fontStyle : "Regular";
        if (hasCjk && resolvedCjkFamily) {
            var srcFam = (baseline && baseline.fontFamily) ? baseline.fontFamily : "";
            // (0) PAIR AUTHORITY (TODO#15 ②): the brand_config pair's EXPLICIT
            // CJK target weight for this source (font, weight) is the only valid
            // weight model — cross-font weight has no intrinsic rank
            // correspondence, so the old rank-nearest map (Semibold→Bold)
            // silently dropped the pair's intent (Semibold→Xbold). Consult the
            // pair first; the source weight is used ONLY when this (font, weight)
            // is in no pair (then SURFACED, never a silent guess).
            var __pairHit = cjkPairWeightLookup ? cjkPairWeightLookup(srcFam, srcStyle) : null;
            var desiredWeight, __mappedByPair;
            if (__pairHit && __pairHit.dstWeight) {
                // pair target weight (italic stripped — CJK weights carry no
                // italic; synthetic slant is the skew prop below).
                desiredWeight = _stripItalicForWeightOnly(__pairHit.dstWeight) || __pairHit.dstWeight;
                __mappedByPair = true;
                _cjkWeightResolution.fromPair++;
            } else {
                desiredWeight = _stripItalicForWeightOnly(srcStyle) || "Regular";
                __mappedByPair = false;
            }
            if (_isFontInstalled(workDoc, resolvedCjkFamily, desiredWeight)) {
                // (1) exact target weight installed within the CJK family.
                resolvedCjkStyle = desiredWeight;
            } else {
                // (2) target weight not installed → nearest INSTALLED weight by
                // rank, ANCHORED TO desiredWeight (the PAIR target when mapped,
                // the source weight only when truly unpaired). Ties prefer
                // heavier. This rank step now refines an already-pair-correct
                // target rather than substituting for the pair.
                var targetRank = _rankWeight(desiredWeight);
                var bestStyle = null;
                var bestScore = Infinity;
                for (var __ci = 0; __ci < _CANDIDATE_WEIGHTS.length; __ci++) {
                    var cand = _CANDIDATE_WEIGHTS[__ci];
                    if (!_isFontInstalled(workDoc, resolvedCjkFamily, cand)) continue;
                    var candRank = _rankWeight(cand);
                    var distance = Math.abs(candRank - targetRank);
                    var directionPenalty = (candRank < targetRank) ? 1 : 0;
                    var score = distance * 10 + directionPenalty;
                    if (score < bestScore) { bestScore = score; bestStyle = cand; }
                }
                if (bestStyle) resolvedCjkStyle = bestStyle;
                // else: keep "Regular" default (no CJK weights probed clean —
                // unlikely, since cjkResult resolution already confirmed family).
            }
            // (3) SURFACE the unpaired guess — user principle: rank only as a
            // visible fallback, never a silent cross-font weight guess.
            if (!__mappedByPair) {
                _recordCjkWeightFallback(_cjkWeightResolution, resolvedCjkFamily, srcFam, srcStyle, resolvedCjkStyle);
            }
        }

        // #BRIDGE-27: precedence — translation-mode CJK fallback (hasCjk)
        // > designer CJK pattern preserve > baseline most-chars-wins.
        // Translation mode keeps the SHS-locked compliance behavior; in
        // reorganize mode (hasCjk=false), if the source ps uses CJK as
        // default + GREP for Latin, preserve that family/style instead of
        // letting baseline pick the GREP-routed Latin family as psFont.
        var __clusterPsFontFamily, __clusterPsFontStyle;
        if (hasCjk) {
            __clusterPsFontFamily = resolvedCjkFamily;
            __clusterPsFontStyle  = resolvedCjkStyle;
        } else if (designerCJKPattern) {
            __clusterPsFontFamily = designerCJKPattern.psFontFamily;
            __clusterPsFontStyle  = designerCJKPattern.psFontStyle;
        } else {
            __clusterPsFontFamily = baseline.fontFamily || "";
            __clusterPsFontStyle  = baseline.fontStyle  || "Regular";
        }
        var props = {
            justification: paraSnap.justification,        // string → Justification enum (commit-time)
            spaceBefore: clusterSB,
            spaceAfter: clusterSA,
            firstLineIndent: paraSnap.first_line_indent,
            leftIndent: paraSnap.left_indent,
            rightIndent: paraSnap.right_indent,
            appliedFont: __clusterPsFontFamily,
            fontStyle:   __clusterPsFontStyle,
            pointSize: baseline.fontSize,
            // Character geometry — must be on the paragraph style itself,
            // otherwise normalizeCascade's clearOverrides() strips the
            // original char-level value and reverts to InDesign defaults
            // (e.g. master URL "edwardjones.ca" overflows when hScale resets
            // from 85% → 100%, making 14ch at 10pt wider than the 73pt frame).
            // Geometry-style dimensions get the same preset snap that drove
            // the fingerprint above, so segments in the same cluster all
            // receive the bucket-canonical value (not whatever raw value
            // happened to be on the cluster sample). Without this, two
            // segments with tracking 12 and 18 would cluster together
            // (both snap to 0) but the new paragraph style might write
            // tracking=12 or tracking=18 depending on which segment was
            // picked as cluster sample — visually inconsistent.
            horizontalScale: _snapHScale(baseline.horizontal_scale),
            verticalScale:   _snapVScale(baseline.vertical_scale),
            tracking:        _snapTracking(baseline.tracking),
            baselineShift:   _snapBaselineShift(baseline.baseline_shift),
            // skew = a GENUINE designer skew carried faithfully (row E captured-skew
            // replay). Paragraph-style skew survives cascade normalize because it's a
            // style property, not a per-char override — so a real designer slant
            // belongs here. _snapSkew preserves it.
            //
            // univ-italic ④ (2026-06-28): carrier #2 / #ITALIC-SKEW-PARA REMOVED. It
            // used to stamp skew=15 here for hasCjk + Italic-intent baselines (a
            // whole-paragraph uniform-italic CJK paragraph is uniform=true → has no
            // emphasisRuns → never reached the gated CS-body emphasis path). That
            // auto-15 violated 乙-strict (machine auto-slant without operator config)
            // AND could only express one angle for the whole paragraph. The slant now
            // lands as config-gated, per-weight CS-body skew via the synthesized
            // whole-paragraph emphasis run at v2_pipeline applyOnePara "Step 3.4b"
            // (→ applyEmphasisRunsAsCharStyles, identical to carrier #1: faux@angle /
            // real / block / surface). Latin chars in such a paragraph get their slant
            // from the same per-run realization (or their `_T_Latin_*` CS), never from
            // a paragraph-style skew.
            skew:            _snapSkew(baseline.skew),
            // #UL-DETAIL (2026-05-26): paragraph-style-level underline.
            // Client-A "Subhead H3" defines underline=true + offset=6 + weight=0.4
            // + PANTONE 300 C as visual divider line below the heading.
            // Carried on the new _T_p_* style so visual matches source.
            // underlineColor needs swatch resolution at commit time (see
            // fillColorSpec / underlineColorSpec below).
            underline:       !!baseline.underline,
            underlineOffset: (typeof baseline.underlineOffset === "number") ? baseline.underlineOffset : 0,
            underlineWeight: (typeof baseline.underlineWeight === "number") ? baseline.underlineWeight : 0,
            underlineTint:   (typeof baseline.underlineTint   === "number") ? baseline.underlineTint   : -1,
            // Keep options
            keepWithNext: paraSnap.keep_with_next || 0,
            keepLinesTogether: !!paraSnap.keep_lines_together,
            keepFirstLines: paraSnap.keep_first_lines || 0,
            keepLastLines: paraSnap.keep_last_lines || 0,
            // Hyphenation
            hyphenation: !!paraSnap.hyphenation,
            // Composer
            composer: paraSnap.composer
            // NOTE: fillColor + leading not in `props` — handled separately
            // by _applyDeferredProperties in commit (require Color obj resolution
            // / character-level write since leading is a char prop in InDesign).
        };

        paraStylesToCreate.push({
            fingerprint: pfp3,
            shortHash: hash,
            name: styleName,
            // Stash baseline + paraSnap for the role-classification pass
            // below, which renames each entry once roles are assigned.
            _baseline: baseline,
            _paraSnap: paraSnap,
            properties: props,
            // Captured-but-deferred: applied to the style by commit-time helpers
            // because they need either enum-resolution or doc-side lookup.
            fillColorSpec: baseline.fillColor || null,    // {swatch, space, values} or null
            // #UL-DETAIL: same deferred-resolution pattern for underlineColor.
            underlineColorSpec: baseline.underlineColor || null,
            leadingSpec: paraSnap.leading,                 // number (pt) | "AUTO" | null
            // [indent-general] Captured tab stops — applied at commit time via
            // _applyTabStops (needs the TabStopAlignment enum + a tabStops.add loop, so it
            // can't ride the bulk `properties=` write). null/empty ⇒ NO-OP (never clobber
            // InDesign's default tabs to zero). Root fix for the placemat indent bug: a
            // bullet whose text position rides a tab stop (@15.75pt, leftIndent=0) lost its
            // tabs because commit never re-applied captured tab_stops → the marker's
            // after-tab fell to the default ~36pt → oversized gap. General (all _T_p_*).
            tabStopsSpec: (paraSnap.tab_stops && paraSnap.tab_stops.length) ? paraSnap.tab_stops : null,
            // Bullet/numbering spec — needs ListType enum resolution at commit time.
            // Without this, a "BULLET_LIST" source paragraph loses its "•" marker
            // when its style is reorganized to _T_p_<hash>.
            bulletsSpec: {
                type: paraSnap.bullets_and_numbering_type || "NO_LIST",   // string → ListType enum
                numberingFormat: paraSnap.numbering_format || null,
                numberingStartAt: paraSnap.numbering_start_at || 1,
                bulletChar: paraSnap.bullet_char || null,                 // single-char string or null
                // [P1-C (a)] original bullet Latin font "Family\tStyle". Prefer the
                // explicitly-captured bullet_font; FALL BACK to the cluster's LATIN font
                // when it is absent — e.g. a package exported BEFORE bullet_font capture
                // landed, or any capture that couldn't read it. Use
                // _resolveLatinFontForCluster (NOT raw baseline): applyScriptByFontDetection
                // overwrites baseline.fontFamily to the dominant/CJK font, so raw baseline
                // could pin a CJK face that can't draw • [codex/xhigh bullet-audit C]; the
                // resolver returns the scriptByFont LATIN sub-font when present. Still
                // "preserve-original from the source snapshot" (§9). null when neither
                // exists → apply-time font block skips (no substitute).
                bulletFont: paraSnap.bullet_font || (function () {
                    var _lf = _resolveLatinFontForCluster(sampleSeg);
                    return (_lf && _lf.fontFamily) ? (_lf.fontFamily + "\t" + (_lf.fontStyle || "Regular")) : null;
                })()
            },
            // Paragraph rules — needs Swatch/StrokeStyle lookup + RuleWidth enum
            // at commit time. Without this, designer paragraph rules
            // (e.g. 0.5pt baseline rule used as a "stable underline" under
            // mixed Latin/CJK + superscripted runs) are silently dropped
            // when paragraphs are re-clustered to _T_p_<hash>. Snapshot
            // shape: { active:bool, weight, offset, tint, color:{swatch,...},
            //          gapColor, gapTint, type, width, leftIndent, rightIndent,
            //          overprint, gapOverprint }.
            ruleAboveSpec: paraSnap.rule_above || null,
            ruleBelowSpec: paraSnap.rule_below || null,
            grepRule: grepRule,
            // #BRIDGE-28: optional CJK GREP rule (Latin-base reverse routing).
            // Consumed by commitStylePlan alongside grepRule to emit both
            // Latin → _T_Latin_* AND CJK → _T_CJK_* nested GREPs.
            cjkGrepRule: cjkGrepRule,
            tids: bucket.tids,
            // #32 G4: stash the source para style name from the cluster
            // sample so commitStylePlan can copy designer-added (non-`_T_*`)
            // nested GREP rules onto the new `_T_p_*` style. Without this,
            // designer GREP-driven formatting (URL detection, brand-name
            // bolding, registered marks) is silently dropped when paras
            // get re-clustered onto fresh styles.
            // #BRIDGE-14b: accept either field name (export emits
            // `paragraph_style`; older fixtures use
            // `source_paragraph_style_name`).
            _sourceStyleName: (bucket.sample && (bucket.sample.source_paragraph_style_name || bucket.sample.paragraph_style)) || "",
            // #BRIDGE-13: complete list of source paragraph styles that
            // ended up in this cluster (auto-merge may pull multiple
            // designer-named styles into one fingerprint). commitStylePlan
            // unions all of their nested GREP rules, deduping by
            // (grepExpression, charStyleName) so URL/brand/superscript
            // rules from non-sample styles survive the consolidation.
            _sourceStyleNames: bucket.sourceStyleNames ? bucket.sourceStyleNames.slice() : []
        });
    }

    // ─── Pass 4b: role classification + name rebuild ──────────────
    // Identify body anchor (max-count cluster ≥ 15% of paragraphs) and
    // label each entry by size ratio (caption/body/sub/head/display).
    // Then regenerate each entry's name with the role prefix so the
    // Paragraph Styles panel groups by semantic role alphabetically.
    var segmentsByTid = {};
    for (var stI = 0; stI < segments.length; stI++) {
        if (segments[stI] && segments[stI].tid) segmentsByTid[segments[stI].tid] = segments[stI];
    }
    _classifyRoles(paraStylesToCreate, segmentsByTid);
    var renamedUsedNames = {};
    for (var renI = 0; renI < paraStylesToCreate.length; renI++) {
        var ent = paraStylesToCreate[renI];
        ent.name = _buildDescriptiveStyleName(ent._baseline, ent._paraSnap, ent.shortHash, renamedUsedNames, ent.role);
        // Strip the temporary stash fields from the public plan shape.
        delete ent._baseline;
        delete ent._paraSnap;
    }

    // ─── Pass 5: latinStylesToCreate (from pool) ─────────────────
    var latinStylesToCreate = [];
    for (var pk in latinPool) {
        if (!latinPool.hasOwnProperty(pk)) continue;
        latinStylesToCreate.push(latinPool[pk]);
    }

    // ─── Pass 5a: cjkStylesToCreate (from cjkPool) ────────────────
    // #BRIDGE-28: parallel to latinStylesToCreate. Each entry becomes a
    // `_T_CJK_*` character style in commitStylePlan, mapped by
    // fingerprint for cjkGrepRule routing.
    var cjkStylesToCreate = [];
    for (var pkC in cjkPool) {
        if (!cjkPool.hasOwnProperty(pkC)) continue;
        cjkStylesToCreate.push(cjkPool[pkC]);
    }

    // ─── Pass 5b: Phase 8B emphasis char-style pool ──────────────
    // Walk segments with format_snapshot.emphasisRuns (set by
    // emphasis_extractor.applyEmphasisExtraction). Dedup by diff signature
    // into a single _T_c_emp_* pool; record per-segment apply records so
    // style_applier can re-apply emphasis after cascade normalize.
    //
    // MVP scope: skip emphasisRuns whose diff includes fontFamily AND the
    // segment also has scriptByFont — that layered case (CJK paragraph
    // with Bold English word) needs combined GREP + char-style design that
    // task_plan defers to a follow-up.
    var empCharStylePool = {};        // empFingerprint → { name, fingerprint, propsSpec, descriptor, effectiveFont, hasItalicIntent }
    var empRunsBySegment = {};        // tid → [{ start, end, empFingerprint }]
    var empRunsTotal = 0;
    var empRunsSkippedLayered = 0;

    for (var eI = 0; eI < segments.length; eI++) {
        var eSeg = segments[eI];
        if (!eSeg || !eSeg.format_snapshot) continue;
        var eFs = eSeg.format_snapshot;
        var eRuns = eFs.emphasisRuns;
        if (!eRuns || !eRuns.length) continue;
        var hasSbf = !!eFs.scriptByFont;
        var perSegment = [];
        for (var ri2 = 0; ri2 < eRuns.length; ri2++) {
            var er = eRuns[ri2];
            if (!er || !er.diff) continue;
            // MVP: skip layered scriptByFont + emphasis-with-font-diff case
            if (hasSbf && Object.prototype.hasOwnProperty.call(er.diff, "fontFamily")) {
                empRunsSkippedLayered++;
                continue;
            }
            // Phase 8B italic realization: italic intent + the font this run
            // ends up rendering on (= diff.fontFamily if set, else the
            // segment's baseline font) = the effective font, carried as
            // `effectiveFont` so the COMMIT step can config-gate the slant
            // (real / faux@config-angle / block / surface — see Step 2.5;
            // univ-italic audit, NOT the old auto real-vs-skew=15 decision).
            // Different effective fonts must produce DIFFERENT pool entries —
            // a single _T_c_emp_italic shared across an Arial segment and a
            // YaHei segment would realize differently on each. Include
            // effectiveFont in the dedup key only when italic is part of the
            // diff so non-italic emphasis (bold / color / underline / size)
            // keeps tight pool sharing across segments.
            var hasItalicIntent = _diffHasItalicIntent(er.diff);
            var effectiveFont = (er.diff.fontFamily) || (eFs.baseline && eFs.baseline.fontFamily) || null;
            var sigBase = _empSignature(er.diff);
            var sig = (hasItalicIntent && effectiveFont)
                ? sigBase + "|@font=" + effectiveFont
                : sigBase;
            var fp = "emp_" + _shortHash(sig);
            if (!empCharStylePool[fp]) {
                empCharStylePool[fp] = {
                    fingerprint: fp,
                    name: _empCharStyleName(er.diff, fp, hasItalicIntent ? effectiveFont : null),
                    propsSpec: _empPropsSpec(er.diff),
                    descriptor: _empDescriptor(er.diff),
                    effectiveFont: effectiveFont,
                    hasItalicIntent: hasItalicIntent
                };
            }
            perSegment.push({
                start: er.start,
                end: er.end,
                empFingerprint: fp
            });
            empRunsTotal++;
        }
        if (perSegment.length && eSeg.tid) {
            empRunsBySegment[eSeg.tid] = perSegment;
        }
    }
    var empCharStylesToCreate = [];
    for (var ek in empCharStylePool) {
        if (!empCharStylePool.hasOwnProperty(ek)) continue;
        empCharStylesToCreate.push(empCharStylePool[ek]);
    }

    // ─── Pass 5c: per-segment spaceBefore/spaceAfter overrides ───────
    // Phase 9 format-preserving merge — when spacePreservingMerge=ON, the
    // cluster style writes the most-paragraphs-wins sB/sA. Segments whose
    // original sB/sA differ from the winner get a per-paragraph override
    // recorded here so style_applier.applySpaceOverridesToParagraph can
    // restore the original values after cascade normalize.
    var spaceOverridesBySegment = {};
    var spaceOverrideCount = 0;
    if (spacePreservingMerge) {
        // Build fingerprint-to-cluster lookup
        var fpToCluster = paraFingerprints;
        for (var soI = 0; soI < segments.length; soI++) {
            var soSeg = segments[soI];
            if (!soSeg || !soSeg.paragraph_snapshot || !soSeg.format_snapshot) continue;
            var soFp = _scopedPfp(soSeg);
            if (!soFp || !fpToCluster[soFp]) continue;
            var soCluster = fpToCluster[soFp];
            var origSB = Number(soSeg.paragraph_snapshot.space_before || 0);
            var origSA = Number(soSeg.paragraph_snapshot.space_after  || 0);
            var winSB = Number(soCluster.winnerSB);
            var winSA = Number(soCluster.winnerSA);
            var override = {};
            if (Math.abs(origSB - winSB) > 0.01) override.spaceBefore = origSB;
            if (Math.abs(origSA - winSA) > 0.01) override.spaceAfter = origSA;
            if (Object.keys(override).length > 0 && soSeg.tid) {
                spaceOverridesBySegment[soSeg.tid] = override;
                spaceOverrideCount++;
            }
        }
    }

    // ─── Pass 6: build clusterReport ─────────────────────────────
    var totalRunsObserved = 0;
    var observedRunFingerprints = [];
    for (var rfp2 in runFingerprintsObserved) {
        if (!runFingerprintsObserved.hasOwnProperty(rfp2)) continue;
        totalRunsObserved += runFingerprintsObserved[rfp2];
        observedRunFingerprints.push({ fingerprint: rfp2, count: runFingerprintsObserved[rfp2] });
    }

    var clusterReport = {
        total_paragraphs: segments.length,
        para_styles_count: paraStylesToCreate.length,
        latin_pool_size: latinStylesToCreate.length,
        run_fingerprint_count: observedRunFingerprints.length,
        total_runs: totalRunsObserved,
        compression_ratio: paraStylesToCreate.length > 0
            ? (segments.length / paraStylesToCreate.length)
            : 0,
        // For E10 follow-up
        observed_run_fingerprints: observedRunFingerprints
    };

    var fontPlan = {
        cjk: cjkResult,
        latin: latinResolutions,
        latin_pool: latinPool
    };

    clusterReport.emp_char_styles_count = empCharStylesToCreate.length;
    clusterReport.emp_runs_total = empRunsTotal;
    clusterReport.emp_runs_skipped_layered = empRunsSkippedLayered;
    clusterReport.space_preserving_merge = spacePreservingMerge;
    clusterReport.space_overrides_count = spaceOverrideCount;
    // TODO#15 ②: CJK weight resolution audit — how many cluster psFonts took the
    // pair-authoritative weight vs the SURFACED rank fallback (no-pair source).
    clusterReport.cjk_weight_resolution = _cjkWeightResolution;

    return {
        paraStylesToCreate: paraStylesToCreate,
        latinStylesToCreate: latinStylesToCreate,
        // #BRIDGE-28: CJK reverse-routing character styles for Latin-base
        // scriptByFont clusters. commitStylePlan creates these as
        // `_T_CJK_*` CSs and routes embedded CJK chars to them via GREP.
        cjkStylesToCreate: cjkStylesToCreate,
        // Phase 8B: deduped emphasis character styles + per-segment apply
        // records (annotation char styles still created JIT by
        // ensureAnnotationCharStyle during the translation flow).
        empCharStylesToCreate: empCharStylesToCreate,
        empRunsBySegment: empRunsBySegment,
        // Phase 9: per-paragraph sB/sA overrides when format-preserving
        // merge is on. style_applier.applySpaceOverridesToParagraph
        // consumes these after cluster style apply + cascade normalize.
        spaceOverridesBySegment: spaceOverridesBySegment,
        spacePreservingMerge: spacePreservingMerge,
        fontPlan: fontPlan,
        clusterReport: clusterReport,
        // Round-trip the fingerprint config so applier uses the same
        // dimensions we used at build time. Without this the applier
        // would compute fingerprints with the default (all-on) dimensions
        // and miss-match the cluster keys.
        // CRITICAL: round-trip the EFFECTIVE dimensions (post-Phase-9 sB/sA
        // overrides), not the caller's original input. style_applier
        // recomputes the fingerprint at apply time to look up the cluster
        // style — if dims drift between build and apply, every lookup fails
        // and clusterStylesApplied stays 0.
        // #28: round-trip splitMasterFromBody so the applier prepends
        // the same "M:"/"B:" origin tag at lookup time. Without this
        // round-trip, applier would compute base pfp and miss every
        // cluster key (which is now origin-prefixed).
        fingerprintOpts: { tolerance: tolerance, dimensions: effectiveDims, splitMasterFromBody: splitMasterFromBody }
    };
}

// ─── Phase 8B helpers: emphasis signature / naming / props spec ───────
//
// `diff` is the emphasisRun.diff object emitted by emphasis_extractor —
// only the fields where the run differs from the paragraph baseline.

function _empSignature(diff) {
    // Stable key for dedup. Stringify keys in a deterministic order.
    if (!diff) return "";
    var keys = [];
    for (var k in diff) {
        if (Object.prototype.hasOwnProperty.call(diff, k)) keys.push(k);
    }
    keys.sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
        var v = diff[keys[i]];
        if (keys[i] === "fillColor") {
            parts.push(keys[i] + "=" + _fillColorEmpKey(v));
        } else {
            parts.push(keys[i] + "=" + (v === null || v === undefined ? "_" : String(v)));
        }
    }
    return parts.join("|");
}

function _fillColorEmpKey(c) {
    if (!c) return "_";
    if (c.swatch) return "S:" + c.swatch;
    if (c.values && c.values.length) return "V:" + (c.space || "?") + ":" + c.values.join(",");
    return "_";
}

function _empCharStyleName(diff, fingerprint, italicEffectiveFont) {
    if (!diff) return "_T_c_emp_" + (fingerprint || "unknown");
    // Prefer descriptive segments when only a single canonical dim differs.
    var keys = [];
    for (var k in diff) {
        if (Object.prototype.hasOwnProperty.call(diff, k)) keys.push(k);
    }
    if (keys.length === 1) {
        var only = keys[0];
        if (only === "fontStyle") {
            // For italic-bearing single-dim emphasis, include the effective
            // target font in the name. The same italic intent on different
            // base fonts produces different concrete styles (real italic
            // for Arial; skew faux italic for YaHei) — naming them apart
            // makes the Character Styles panel readable.
            var label = _sanitize(String(diff.fontStyle).toLowerCase());
            if (italicEffectiveFont) {
                label = label + "_" + _sanitize(String(italicEffectiveFont));
            }
            return "_T_c_emp_" + label;
        }
        if (only === "underline" && diff.underline === true) return "_T_c_emp_underline";
        if (only === "strikeThrough" && diff.strikeThrough === true) return "_T_c_emp_strike";
        if (only === "fillColor") {
            var hex = _fillColorAsHex(diff.fillColor);
            if (hex) return "_T_c_emp_color_" + hex;
            return "_T_c_emp_color_" + _sanitize(_fillColorEmpKey(diff.fillColor));
        }
        if (only === "fontSize") {
            return "_T_c_emp_size_" + Math.round(Number(diff.fontSize)) + "pt";
        }
        if (only === "baseline_shift") {
            return "_T_c_emp_baselineShift_" +
                (diff.baseline_shift > 0 ? "p" : "n") +
                Math.abs(Math.round(Number(diff.baseline_shift)));
        }
        if (only === "tracking") {
            return "_T_c_emp_tracking_" + Math.round(Number(diff.tracking));
        }
        if (only === "horizontal_scale") {
            return "_T_c_emp_hscale_" + Math.round(Number(diff.horizontal_scale));
        }
        if (only === "vertical_scale") {
            return "_T_c_emp_vscale_" + Math.round(Number(diff.vertical_scale));
        }
        if (only === "skew") {
            // Skew = synthetic italic angle. Designer-applied skew is the
            // standard faux-italic mechanism for fonts without an italic
            // variant (CJK families). Naming surfaces the angle so the
            // Character Styles panel reads as e.g. "_T_c_emp_skew_15".
            var sk = Math.round(Number(diff.skew));
            return "_T_c_emp_skew_" + (sk < 0 ? "n" + Math.abs(sk) : String(sk));
        }
        if (only === "fontFamily") {
            return "_T_c_emp_font_" + _sanitize(String(diff.fontFamily));
        }
    }
    // Multi-dim → fingerprint-only name
    return "_T_c_emp_" + (fingerprint || "unknown");
}

function _empDescriptor(diff) {
    var fields = [];
    for (var k in diff) {
        if (!Object.prototype.hasOwnProperty.call(diff, k)) continue;
        if (k === "fillColor") {
            fields.push("color=" + _fillColorEmpKey(diff[k]));
        } else {
            fields.push(k + "=" + diff[k]);
        }
    }
    return fields.join(",");
}

function _empPropsSpec(diff) {
    // Spec uses the InDesign DOM character-style property names so commit
    // can pass it straight to characterStyle.properties (with one carve-out
    // for fillColorSpec which needs swatch resolution at commit time, and
    // for appliedFontFamily which goes through a separate set so we don't
    // collide with the Font-object form of appliedFont).
    var spec = {};
    if (Object.prototype.hasOwnProperty.call(diff, "fontFamily"))     spec.appliedFontFamily = diff.fontFamily;
    if (Object.prototype.hasOwnProperty.call(diff, "fontStyle"))      spec.fontStyle = diff.fontStyle;
    if (Object.prototype.hasOwnProperty.call(diff, "fontSize"))       spec.pointSize = diff.fontSize;
    if (Object.prototype.hasOwnProperty.call(diff, "fillColor"))      spec.fillColorSpec = diff.fillColor;
    if (Object.prototype.hasOwnProperty.call(diff, "underline"))      spec.underline = diff.underline;
    if (Object.prototype.hasOwnProperty.call(diff, "strikeThrough"))  spec.strikeThru = diff.strikeThrough;
    if (Object.prototype.hasOwnProperty.call(diff, "tracking"))       spec.tracking = diff.tracking;
    if (Object.prototype.hasOwnProperty.call(diff, "baseline_shift")) spec.baselineShift = diff.baseline_shift;
    if (Object.prototype.hasOwnProperty.call(diff, "horizontal_scale")) spec.horizontalScale = diff.horizontal_scale;
    if (Object.prototype.hasOwnProperty.call(diff, "vertical_scale"))   spec.verticalScale = diff.vertical_scale;
    if (Object.prototype.hasOwnProperty.call(diff, "skew"))             spec.skew = diff.skew;
    // #E2E-1 import side: propagate position dim so emphasis_extractor's
    // SUPERSCRIPT/SUBSCRIPT diffs survive into the emp char style. The
    // commit path resolves the string to the DOM Position enum constant.
    if (Object.prototype.hasOwnProperty.call(diff, "position"))         spec.position = diff.position;
    return spec;
}

function _fillColorAsHex(c) {
    if (!c || !c.values) return null;
    if (c.space === "RGB" && c.values.length >= 3) {
        var r = Math.max(0, Math.min(255, Math.round(c.values[0])));
        var g = Math.max(0, Math.min(255, Math.round(c.values[1])));
        var b = Math.max(0, Math.min(255, Math.round(c.values[2])));
        var hex = ((r << 16) | (g << 8) | b).toString(16);
        while (hex.length < 6) hex = "0" + hex;
        return hex.toUpperCase();
    }
    return null;
}

// ─── Commit-time helpers (need real InDesign DOM) ─────────────────

// Italic-availability probe + cache. EXTRACTED to lib/font_italic_probe.js so
// the doc-wide italic→skew apply sites (v2_pipeline BRIDGE-35 / BRIDGE-41 /
// link-uniform, style_applier direct-override) share the SAME decision this
// emphasis-pool builder makes — otherwise the doc-wide sweep re-stamps what
// this builder got right (root cause: fix-faux-latin-italic). These thin
// wrappers keep every existing call site (_probeFontHasItalic /
// _resetItalicProbeCache) unchanged.
var _FontItalicProbe = require("./font_italic_probe.js");
// univ-italic ③: per-weight italic HOW config reader + 乙-strict decision model.
// Shared with carrier #1 (style_applier _applyOneEmphasisSubRun) so the Latin-CS
// chokepoint here makes the SAME realization decision (faux@config-angle / real /
// block / surface) on the SAME (family, weight) key — no cross-path drift.
var _ItalicConfig = require("./italic_config.js");

function _resetItalicProbeCache() { _FontItalicProbe.resetItalicProbeCache(); }

function _probeFontHasItalic(workDoc, fontFamily) {
    return _FontItalicProbe.probeFontHasItalic(workDoc, fontFamily);
}

// #E2E-14: Weight rank for cross-family weight matching. Mirror of
// emphasis_extractor's WEIGHT_RANK so we don't add a require()-cycle.
// Used by the pair-authoritative CJK weight resolution at :1200-1240 to pick
// the closest INSTALLED weight in the target CJK family when the desired
// weight (the pair's target when mapped, the source weight only when truly
// unpaired) is not installed under that exact name
// (e.g. MHei PRC's "Xbold" -> Source Han's "Heavy").
// #47: previously this comment named `_resolveBestCJKWeight`, which had
// zero callers and has been removed — a comment naming a dead function is
// how a reader concludes the live path does not exist.
var _WEIGHT_RANK = {
    "Thin":       100, "Hairline":   100,
    "ExtraLight": 200, "UltraLight": 200,
    "Light":      300,
    "":           400, "Regular":    400, "Normal": 400, "Book": 400,
    "Medium":     500,
    "Semibold":   600, "SemiBold":   600, "Demibold": 600, "DemiBold": 600,
    "Bold":       700,
    "ExtraBold":  800, "UltraBold":  800, "Heavy":   800, "Xbold": 800,
    "Black":      900
};

// TODO#15 ②: dedup-record a cluster whose CJK weight fell back to rank-nearest
// because its source (font, weight) matched NO pair. Surfaced via clusterReport
// (user principle: rank is never a silent cross-font guess).
function _recordCjkWeightFallback(acc, family, srcFont, srcStyle, resolvedStyle) {
    if (!acc || !acc.fallbackRank) return;
    var key = String(family) + "|" + String(srcFont) + "|" + String(srcStyle);
    for (var i = 0; i < acc.fallbackRank.length; i++) {
        if (acc.fallbackRank[i]._key === key) { acc.fallbackRank[i].count++; return; }
    }
    acc.fallbackRank.push({
        _key: key, family: family, srcFont: srcFont,
        srcStyle: srcStyle, resolvedStyle: resolvedStyle, count: 1
    });
}

function _rankWeight(w) {
    if (w === null || w === undefined) return 400;
    var key = String(w);
    if (Object.prototype.hasOwnProperty.call(_WEIGHT_RANK, key)) return _WEIGHT_RANK[key];
    var lc = key.toLowerCase();
    for (var k in _WEIGHT_RANK) {
        if (Object.prototype.hasOwnProperty.call(_WEIGHT_RANK, k) &&
            k.toLowerCase() === lc) return _WEIGHT_RANK[k];
    }
    return 400;
}

function _stripItalicForWeightOnly(s) {
    if (!s) return "";
    return String(s).replace(/italic/ig, "").replace(/oblique/ig, "").replace(/\s+/g, " ").trim();
}

// #E2E-14: Caches for the CJK weight resolver.
//   _cjkFamilyStylesCache  : family            → [installed style names]
//   _cjkWeightCache        : family|desired    → resolved style name
// Both reset at the start of buildStylePlan so a freshly-opened doc doesn't
// read stale results. The family→styles cache is the expensive one (it
// scans app.fonts, which can be hundreds of entries); we hit it once per
// distinct CJK family per build (typically just one — the resolved CJK
// family from cjk_resolution). Without this cache the resolver re-walked
// app.fonts for every (family, desiredStyle) pair, blowing the import out
// to multi-minute runs and tripping the bridge plugin's timeout.
var _cjkWeightCache = null;
var _cjkFamilyStylesCache = null;

// Enumerate every installed style name within a family. Only returns
// installed-status fonts so the resolver never picks a weight that
// InDesign would flag as missing.
function _enumerateFamilyStyles(workDoc, fontFamily) {
    if (!fontFamily) return [];
    if (!_cjkFamilyStylesCache) _cjkFamilyStylesCache = {};
    if (Object.prototype.hasOwnProperty.call(_cjkFamilyStylesCache, fontFamily)) {
        return _cjkFamilyStylesCache[fontFamily];
    }
    var styles = [];
    var seen = {};
    // Hard ceiling on font-iteration work per call. UXP IPC for property
    // getters can be slow when app.fonts has hundreds-to-thousands of
    // entries; without a cap, a single CJK family probe could exceed the
    // bridge plugin's script-timeout and look like a hang (we burned an
    // InDesign session on this in the e2e run). 10000 is well above any
    // realistic font catalog.
    var SCAN_CAP = 10000;
    function scan(fontColl) {
        var len = 0; try { len = fontColl.length; } catch (eL) { return; }
        if (len > SCAN_CAP) len = SCAN_CAP;
        for (var i = 0; i < len; i++) {
            try {
                var f = (typeof fontColl.item === "function") ? fontColl.item(i) : fontColl[i];
                if (!f) continue;
                var fam = ""; try { fam = String(f.fontFamily); } catch (eFam) {}
                if (fam !== fontFamily) continue;
                // Filter to installed only — workDoc.fonts contains
                // missing/substituted fonts referenced by the doc, and we
                // must not return one of those as the resolver's answer
                // (InDesign would pop a missing-font dialog at commit time
                // and the import would block waiting on it).
                var statusStr = ""; try { statusStr = String(f.status); } catch (eSt) {}
                if (statusStr && statusStr !== "INSTALLED"
                    && statusStr.indexOf("INSTALLED") < 0
                    && statusStr.indexOf("Installed") < 0) continue;
                var st = ""; try { st = String(f.fontStyleName || f.fontStyle || ""); } catch (eS) {}
                if (st && !Object.prototype.hasOwnProperty.call(seen, st)) {
                    seen[st] = true;
                    styles.push(st);
                }
            } catch (eF) {}
        }
    }
    if (workDoc) {
        try { scan(workDoc.fonts); } catch (eDS) {}
    }
    if (styles.length === 0 && workDoc) {
        try {
            var appRef = workDoc.parent;
            // Defensive: limit ancestor walk to avoid any chance of an
            // infinite loop on a weird UXP DOM proxy.
            for (var hop = 0; hop < 4 && appRef; hop++) {
                if (appRef.fonts) { scan(appRef.fonts); break; }
                var nextRef;
                try { nextRef = appRef.parent; } catch (eP) { nextRef = null; }
                if (!nextRef || nextRef === appRef) break;
                appRef = nextRef;
            }
        } catch (eApp) {}
    }
    _cjkFamilyStylesCache[fontFamily] = styles;
    return styles;
}

// #E2E-14: Candidate weight names tried during resolution. Ordered so that
// the most-common ones are probed first. Italic variants only probed when
// the desired style asked for italic.
var _CANDIDATE_WEIGHTS = [
    "Regular", "Normal", "Book",
    "Light", "ExtraLight", "UltraLight", "Thin", "Hairline",
    "Medium",
    "Semibold", "SemiBold", "Demibold", "DemiBold",
    "Bold",
    "ExtraBold", "UltraBold", "Heavy", "Xbold",
    "Black"
];

/**
 * #E2E-14: Pick the installed style within `fontFamily` whose weight is
 * closest to `desiredStyle`'s weight on the rank scale (100..900). Italic
 * intent in desiredStyle is preserved when an italic variant of the chosen
 * weight is available; otherwise the weight-only variant is returned.
 *
 * Returns a string suitable for `paraStyle.fontStyle = X` (e.g. "Bold",
 * "Heavy", "Bold Italic"), or "Regular" as last-resort fallback.
 *
 * Without this, style_sheet_builder hard-coded fontStyle="Regular" for all
 * CJK-default paragraph styles — which silently demoted every body-Bold /
 * subhead-Xbold paragraph to Regular when source MHei PRC was substituted
 * by Source Han Sans CN (which also has Bold/Heavy but they need an
 * explicit fontStyle).
 *
 * Implementation: probe a small fixed candidate list via findFontFn (cheap
 * O(1) lookups against InDesign's font catalog), enumerate only what's
 * actually installed. Avoids walking app.fonts (which can be 1000s of
 * entries with slow per-getter UXP IPC and would otherwise time out the
 * bridge plugin).
 */
// #47 (2026-08-22): `_resolveBestCJKWeight` was REMOVED here — it was the
// old rank-nearest CJK weight map, superseded by the pair-authoritative
// path at :1200-1240. That site's own comment says why the old model was
// wrong: "cross-font weight has no intrinsic rank correspondence, so the
// old rank-nearest map (Semibold->Bold) silently dropped the pair's intent
// (Semibold->Xbold)". It had ZERO callers repo-wide; deleting it orphans
// nothing (`_CANDIDATE_WEIGHTS` / `_rankWeight` / `_stripItalicForWeightOnly`
// / `_cjkWeightCache` / `_enumerateFamilyStyles` all keep other users).
// Kept as a note, not silence: the next reader would otherwise re-derive
// the same rank-nearest idea and not know it was tried and rejected.
/**
 * #E2E-15: O(1) byName installed-font probe. Stays away from
 * `app.fonts.everyItem().name` (the expensive enumeration path inside
 * `buildFontIndex`) — that one stalled InDesign hard during the previous
 * weight-resolver experiment. Just two `itemByName` calls per probe:
 * once on workDoc.fonts (smaller — only fonts referenced by the doc),
 * once on app.fonts as fallback. Each is an O(1) dictionary lookup
 * against InDesign's internal font registry.
 *
 * Caches per (family|style) so repeated cluster builds don't re-probe.
 */
// TODO#15 ①+③ (B-class): InDesign SILENTLY substitutes a font written with a
// SYSTEM-NOT_AVAILABLE (family, style) to some installed face of a same-named
// family — often the WRONG WEIGHT. Here the legacy OpenType name "Whitney"+
// "Book" is not a system font (only "Whitney Book"+"Regular" is), so writing it
// substitutes to the installed "Whitney"+"Bold" → body Book text renders Bold.
// Same B-class as ③ (writing "MHei PRC"+"Regular" — NOT_AVAILABLE — substituted
// the CJK psFont; bb5967c). Before a (family, style) is written to a style,
// normalize it to a SYSTEM-installed equivalent that PRESERVES the weight +
// italic, trying (1) the as-specified pair, then (2) the legacy↔preferred twin
// ("Whitney"+"Book" → "Whitney Book"+"Regular"; "Whitney"+"Book Italic" →
// "Whitney Book"+"Italic"). Status MUST be probed against the SYSTEM catalog
// (app.fonts) ONLY — NOT workDoc.fonts: an embedded doc-font can report
// INSTALLED under the legacy name, yet a family-string write still re-resolves
// against the system catalog and substitutes. The install map is per-weight
// inconsistent (e.g. "Whitney"+"Medium"/"Bold" install under the legacy name,
// "Whitney"+"Book"/"Semibold"/"Light" only under the twin), so BOTH forms must
// be probed.

// System-only installed probe (app.fonts, NOT workDoc.fonts). Walks up to the
// app from workDoc so it works whether workDoc.parent is the app or a chain.
function _isSystemFontInstalled(workDoc, family, style) {
    if (!family) return false;
    var full = String(family) + "\t" + (style || "Regular");
    var ref = null;
    try { ref = workDoc && workDoc.parent; } catch (e0) {}
    for (var hop = 0; hop < 5 && ref; hop++) {
        var fonts = null;
        try { fonts = ref.fonts; } catch (eF) { fonts = null; }
        if (fonts) {
            try {
                var f = fonts.itemByName(full);
                if (!f) return false;
                var valid = false; try { valid = !!f.isValid; } catch (eV) {}
                if (!valid) return false;
                var st = ""; try { st = String(f.status); } catch (eS) {}
                // TODO#38 (owner 3A 2026-08-13): status unreadable → NOT installed.
                // Was `return true` ("benefit of the doubt") — a fail-open under
                // EVERY resolver layer ①-④, i.e. the default floor of the whole
                // resolution chain, not an isolated edge. Census 20260813_14:
                // 0/631 faces have unreadable status — scope of that number is
                // THIS machine's font table AT THAT MOMENT. On another machine,
                // or mid Adobe-Fonts sync / face-activation, it may not be 0 —
                // this arm is a live guard-rail, NOT dead code.
                // Returning false lets the caller keep probing LATER candidates/
                // layers instead of locking onto an unverifiable name.
                if (!st) return false;
                return st === "INSTALLED" || st.indexOf("INSTALLED") >= 0;
            } catch (eP) { return false; }
        }
        var nxt = null; try { nxt = ref.parent; } catch (eN) { nxt = null; }
        if (!nxt || nxt === ref) break;
        ref = nxt;
    }
    return false;
}

// ─── P2b Fix b: legacy-compound → preferred reverse-twin resolution ───────
// STRICT — no heuristic guessing. Only exact-root bounded byName probes OR a
// human-curated legacy-rename map. No prefix scan, no ranking, NO app.fonts
// enumeration (enumeration "stalled InDesign hard" — see :1160 / :2004-2010).
// Every return is install-verified via _isSystemFontInstalled (stringify-enum,
// :2050). Reached ONLY after the forward twins in _resolveInstalledFontName
// return null, so no forward-twin case can regress.

// Curated legacy brand-rename map: legacyRoot(lowercased) → preferredFamily.
// The ONLY path authorized to RENAME a root (root "Dax" ≠ installed "Dax Pro",
// so exact-root cannot and must not infer it). Human-authorized entries only —
// add a rename here deliberately, never guess it.
var _LEGACY_RENAME_MAP = { "dax": "Dax Pro" };

var _P2B_WEIGHT_WORDS = ["Thin", "Extralight", "Ultralight", "Light", "Book",
    "Regular", "Normal", "Medium", "Semibold", "Demibold", "Demi", "Bold",
    "Extrabold", "Ultrabold", "Black", "Heavy"];

// Trailing weight word of a family name ("Dax Light" → "Light"), else "".
// A bare single-token family ("Dax") has no splittable weight → "".
function _trailingWeightWord(family) {
    var toks = String(family || "").split(/\s+/);
    if (toks.length < 2) return "";
    var last = toks[toks.length - 1];
    for (var i = 0; i < _P2B_WEIGHT_WORDS.length; i++) {
        if (last.toLowerCase() === _P2B_WEIGHT_WORDS[i].toLowerCase()) return last;
    }
    return "";
}

// Strip a TRAILING parenthesized FORMAT token only ("(OTF)"/"(TT)"/…) so
// "Dax Pro (OTF)" and "Dax Pro" are one logical family. Design-variant words
// (Condensed/Slab/Narrow/…) are NOT stripped — they name a different typeface.
function _stripFormatParens(family) {
    return String(family || "")
        .replace(/\s*\((?:OTF|TTF|TT|OT|OpenType|TrueType|Type\s*1|T1|PS|PostScript)\)\s*$/i, "")
        .replace(/\s+$/, "");
}

// Bounded byName probe of ONE exact-root candidate at effStyle: tries the root
// plus each parenthesized-format variant, returns the first INSTALLED exact name
// (family+fontStyle) or null. O(1) itemByName via _isSystemFontInstalled — NO
// enumeration, NO prefix match, NO ranking.
function _reverseTwinBoundedProbe(workDoc, rootFamily, effStyle) {
    var cands = [rootFamily, rootFamily + " (OTF)", rootFamily + " (TT)"];
    for (var i = 0; i < cands.length; i++) {
        if (_isSystemFontInstalled(workDoc, cands[i], effStyle)) {
            return { family: cands[i], fontStyle: effStyle };
        }
    }
    return null;
}

// legacy-compound → preferred reverse twin. install-verified {family,fontStyle}
// or null. isItalic carries the slant through (as the forward twins do).
function _resolveLegacyReverseTwin(workDoc, family, style, isItalic) {
    var famNoParens = _stripFormatParens(family);
    var famWeight = _trailingWeightWord(famNoParens);       // "Light" | ""
    var styleWeight = _stripItalicForWeightOnly(style);      // italic-stripped weight ("Regular" for Regular)
    // effective weight = the more specific of {family-weight, style-weight};
    // conflict → prefer the family's weight (it names the intended face).
    var effWeight = famWeight || styleWeight || "";
    // [codex-r2 fix] a regular/normal-weight ITALIC face is exposed as plain "Italic"
    // by most families (NOT "Regular Italic"/"Normal Italic") — collapse it so the
    // bounded probe doesn't false-miss an installed italic twin (invariant: italic carried).
    var _ewIt = (effWeight && !/^(regular|normal)$/i.test(effWeight)) ? effWeight : "";
    var effStyle = isItalic
        ? (_ewIt ? _ewIt + " Italic" : "Italic")
        : (effWeight || "Regular");
    // root = family minus its trailing weight word (else the bare family).
    var root = famWeight
        ? famNoParens.slice(0, famNoParens.length - famWeight.length).replace(/\s+$/, "")
        : famNoParens;
    if (!root) return null;
    // (a) EXACT-ROOT bounded probe (root AS-IS — never infers a rename).
    var byRoot = _reverseTwinBoundedProbe(workDoc, root, effStyle);
    if (byRoot) return byRoot;
    // (b) curated legacy-rename map — the ONLY authorized root RENAME. Feed the
    // preferred family through the SAME bounded probes (install-verify-or-null),
    // so a rename that isn't actually installed still returns null (not a
    // NOT_AVAILABLE pair) — policy-aligned "config or surface", never substitute.
    var pref = Object.prototype.hasOwnProperty.call(_LEGACY_RENAME_MAP, root.toLowerCase())
        ? _LEGACY_RENAME_MAP[root.toLowerCase()] : null;
    if (pref) {
        var byMap = _reverseTwinBoundedProbe(workDoc, pref, effStyle);
        if (byMap) return byMap;
    }
    return null;
}

// Returns {family, fontStyle} of a system-installed font equivalent to
// (family, style) — preserving weight + italic — or null when nothing is
// system-installed (caller keeps the original; a truly-missing font still
// substitutes, unchanged from today).
function _resolveInstalledFontName(workDoc, family, style) {
    if (!family) return null;
    var st = (style !== null && style !== undefined && String(style)) ? String(style) : "Regular";
    // (1) as-specified already system-installed → no change.
    if (_isSystemFontInstalled(workDoc, family, st)) return { family: family, fontStyle: st };
    var isItalic = /italic|oblique/i.test(st);
    var twSty = isItalic ? "Italic" : "Regular";
    var weightWord = _stripItalicForWeightOnly(st);   // "Book"/"Semibold"/… ("" for Regular)
    var lw = weightWord ? weightWord.toLowerCase() : "";
    // (2) named-weight legacy↔preferred twin: "Fam Weight" + Regular/Italic
    // ("Whitney"+"Book" → "Whitney Book"+"Regular"; "Whitney"+"Book Italic" →
    // "Whitney Book"+"Italic").
    if (weightWord && lw !== "regular" && lw !== "normal") {
        if (_isSystemFontInstalled(workDoc, String(family) + " " + weightWord, twSty)) {
            return { family: String(family) + " " + weightWord, fontStyle: twSty };
        }
    }
    // (3) "normal"/Regular weight where the LEGACY family name isn't a system
    // font: map to the family's BASE sub-family. H&Co fonts (Whitney / Gotham)
    // name the normal weight "Book" — so "Whitney"+"Regular" (NOT a system font)
    // → "Whitney Book"+"Regular" instead of substituting to the installed
    // "Whitney"+"Bold". Try "Fam Book" then a literal "Fam Regular" sub-family.
    if (!weightWord || lw === "regular" || lw === "normal") {
        if (_isSystemFontInstalled(workDoc, String(family) + " Book", twSty)) {
            return { family: String(family) + " Book", fontStyle: twSty };
        }
        if (_isSystemFontInstalled(workDoc, String(family) + " Regular", twSty)) {
            return { family: String(family) + " Regular", fontStyle: twSty };
        }
    }
    // (4) [P2b Fix b] legacy-compound → preferred reverse twin (STRICT:
    // exact-root bounded byName OR curated rename map; no guessing;
    // install-verified). Reached only after the forward twins (2)/(3) miss, so
    // no forward case regresses. e.g. ("Dax Light","Regular") → "Dax Pro"/"Light".
    var _revTwin = _resolveLegacyReverseTwin(workDoc, family, st, isItalic);
    if (_revTwin) return _revTwin;
    return null;
}

// Normalize (family, style) to a system-installed pair, or return it unchanged
// when nothing better is found. Used at BOTH latin-pool key sites (pool build +
// GREP-rule lookup) so they stay on the SAME normalized name (a mismatch would
// drop the GREP routing).
function _normLatinFont(workDoc, family, style) {
    var inst = _resolveInstalledFontName(workDoc, family, style);
    return inst ? inst : { family: family, fontStyle: style };
}

// Slant predicate / weight-only strip (module-level so the shared font-write
// helper below AND commitStylePlan's latin-CS step use ONE definition).
// TODO#26 part 2 (2026-08-12, host-probed): was `_isItalicFontStyle`, matching only
// `italic`. That gate made the whole italic-realization block UNREACHABLE for
// "… Oblique" faces — the operator's per-weight config was silently bypassed and the
// CS kept the real oblique face, diverging from site ④ (whose `_wasItalic` regex and
// the emphasis pool's `_diffHasItalicIntent` both match oblique). Host probe
// 20260812_04: pre-fix AND helper-fix-only site ② wrote "Light Oblique"+no skew for a
// faux-12° config, while site ④ wrote "Light"+12. NB the advertised "double slant"
// never actually shipped — this gate blocked the faux arm before it could stack skew
// on a slanted face; the real defect was the silent config bypass. The helper split
// (_stripSlantToWeight, below) is what makes EXTENDING this gate safe: with the old
// oblique-blind strip, opening the gate would have created the double slant for real.
function _isSlantFontStyle(s) {
    if (!s) return false;
    var lc = String(s).toLowerCase();
    return lc.indexOf("italic") !== -1 || lc.indexOf("oblique") !== -1;
}
// TODO#26 (2026-08-12): `_stripItalicToWeight` REMOVED. It stripped only `Italic`,
// never `Oblique`, and its result was DUAL-PURPOSE — both the `lookup` key and the
// literal written into the style's `fontStyle`. On a face like "Light Oblique" that
// produced `fontStyle="Light Oblique"` + `skew=N` (double slant) in the faux arm, and
// left the run ON the oblique face in the surface/block arm — inverting that branch's
// own fail-closed contract. The key layer never diverged (lookup's `_normWeight` folds
// oblique itself), so this was purely a WRITE-side defect.
//
// The two purposes are now separated, and neither reuses the other's value:
//   • KEY   → hand the RAW token to `_ItalicConfig.lookup` and let its own normaliser
//             do all folding. ONE normaliser, ONE folding — no private helper can
//             drift from it again. (Do NOT touch `_normWeight` itself: `_resolve`
//             binds it module-locally and changing it re-breaks `keep`. 2026-08-07.)
//   • WRITE → `_stripSlantToWeight`, which strips italic AND oblique, for the upright
//             literal actually assigned to `fontStyle`.
// Sibling helpers `_stripItalicForWeightOnly` (:1847, site ①) and
// `_stripItalicFromFontStyle` (:2500, site ③'s write arms) already strip both.
function _stripSlantToWeight(s) {
    return String(s || "")
        .replace(/\s*(?:italic|oblique)\s*/gi, " ")
        .replace(/\s+/g, " ")
        .replace(/^\s+|\s+$/g, "") || "Regular";
}

// SINGLE font-write chokepoint: write (family, style) to a style object
// NORMALIZED to a system-installed equivalent (weight + italic preserved), with
// the faux-italic skew fallback. Both Step 1 (latin CS creation) and the
// post-commit sweep call this so the normalization + italic logic can't drift
// across call sites. Returns the resolved {family, fontStyle} actually written.
function _writeStyleFontNormalized(workDoc, styleObj, family, style, italicConfig) {
    var inst = _resolveInstalledFontName(workDoc, family, style);
    var fam = inst ? inst.family : family;
    var sty = inst ? inst.fontStyle : style;
    // [P2b Fix a] cold-robust write: the "Family\tStyle" tab-name form resolves a
    // COLD family (absent from workDoc.fonts — e.g. a target CJK on an EN→ZH import)
    // that a BARE `appliedFont = fam` would substitute-to-default or throw. (fam,sty)
    // is the install-verified pair from _resolveInstalledFontName, so the tab-name
    // resolves; the warm-path bare fallback preserves prior behavior on odd DOM
    // states. fontStyle is authoritatively (re)set by the italic-config block / else
    // below, so the tab-name's style is not load-bearing (italic realization
    // unchanged). This folds _writeStyleFontTabName's cold-robustness into the
    // normalize chokepoint so the post-commit sweep (which calls this) is cold-robust.
    try { styleObj.appliedFont = fam + "\t" + sty; }
    catch (eF) {
        // Bare fallback ONLY for an install-verified pair (inst != null → warm). NEVER
        // bare-substitute a MISSING font (inst == null) to the doc default — that
        // violates the policy (missing → surface, never substitute). For a missing pair
        // the tab-name write sets a NOT_AVAILABLE reference PRESERVING the name (per
        // _writeStyleFontTabName); if it threw on an odd DOM state, leave the font
        // unchanged rather than substitute.
        if (inst) { try { styleObj.appliedFont = fam; } catch (eF2) {} }
    }
    // univ-italic ③ (乙 STRICT): a managed CS's italic realization is operator-
    // config-gated, mirroring carrier #1 (_applyOneEmphasisSubRun). The per-weight
    // brand_config decides HOW the weight slants; an UNCONFIGURED italic weight does
    // NOT auto-slant (no auto real italic, no auto faux skew=15) — it writes upright.
    // This replaces the old fix-faux-latin-italic auto behavior (real→real / no-real
    // →weight+skew=15) which auto-slanted without operator config.
    //
    // The slant of any paragraph that USES this CS is owned + SURFACED by the
    // whole-paragraph synthesis (v2_pipeline Step 3.4b) / emphasis path (which have
    // live per-char context); this chokepoint only fixes the static CS DEFINITION so
    // a synthesis-bypassed / collided char can never fall back to an auto-15 GREP
    // route. Key = (resolved family, italic-stripped resolved weight) — IDENTICAL to
    // carrier #1, so both paths read the same config entry (contract K).
    if (_isSlantFontStyle(sty)) {
        // TODO#26: key vs write are two different quantities — see _stripSlantToWeight.
        // KEY = the raw token; lookup's own normaliser folds italic AND oblique.
        // WRITE = the upright literal, italic and oblique both stripped.
        var _uprightW = _stripSlantToWeight(sty);
        var _cfg = _ItalicConfig.lookup(italicConfig || null, fam, sty);
        var _exactIt = null;
        try { _exactIt = _FontItalicProbe.findExactItalicStyleName(workDoc, fam, _uprightW); } catch (eEx) {}
        // "Already on a real italic face" = the incoming style IS italic AND that
        // exact italic face exists for this weight. Such a style is a WEIGHT the
        // document already uses, not an implementation awaiting authorisation —
        // so it is kept verbatim. This branch used to strip it to `_baseW`, which
        // is what turned the fixture's 7 Whitney italic runs upright (AC④').
        // CJK never ships a real italic face. italic_apply gates its probe on !isCJK;
        // this site probes unconditionally, so a CJK family that happens to ship a
        // face the probe can NAME ("Italic"/"Oblique") would newly get it applied
        // where it was previously surfaced upright — and, via __wantsItalic below,
        // would also newly lock appliedFont. Gate it here so the CJK answer is
        // symmetric across sites. (The reverse — a CJK run losing its faux slant —
        // cannot happen: cfg.faux is tested before keep.)
        var _isCjkFam = false;
        try { _isCjkFam = !!(_isCJKFamilyName && _isCJKFamilyName(fam)); } catch (eCjk) {}
        var _alreadyItalicFace = !!_exactIt && !_isCjkFam;
        var _dec = _ItalicConfig.resolveItalicRealization(_cfg, !!_exactIt, _alreadyItalicFace);
        if (_dec.kind === "faux") {
            // TODO#26: MUST be the upright literal. Writing the slanted face here and
            // then adding `skew` is the double-slant defect (e.g. "Light Oblique" + 12°).
            try { styleObj.fontStyle = _uprightW; } catch (eS) {}
            try { styleObj.skew = _dec.angle; } catch (eSk) {}
        } else if (_dec.kind === "real" || _dec.kind === "keep") {
            try { styleObj.fontStyle = _exactIt || sty; } catch (eS) {}
            try { styleObj.skew = 0; } catch (eSk) {}
        } else {
            // block (configured real, no weight-exact italic) OR surface (marked
            // italic but this weight HAS no italic face) → upright + no skew.
            // 乙-strict, narrowed: the machine never INVENTS a slant; it no longer
            // removes one the document already had.
            // TODO#26: this branch's whole point is "upright + no skew". Before the fix
            // it wrote an oblique-bearing literal here, leaving the run ON the slanted
            // face with skew 0 — i.e. the exact opposite of the fail-closed behaviour
            // this comment promises. `_uprightW` makes the code match the contract.
            try { styleObj.fontStyle = _uprightW; } catch (eS) {}
            try { styleObj.skew = 0; } catch (eSk) {}
        }
    } else {
        try { styleObj.fontStyle = sty; } catch (eS) {}
    }
    return { family: fam, fontStyle: sty };
}

// Write a style's appliedFont using the full "Family\tStyle" tab-name form —
// the ONLY write form that resolves a font that is COLD in workDoc.fonts (not
// present in the source document, the typical case for a TARGET CJK family like
// MHei PRC during an EN→ZH import where the source has no CJK).
//
// Host-verified 2026-06-24 (#cjkfont, the "财务顾问" Minion-Xbold ghost): for a
// cold target font, a BARE-family appliedFont write either
//   (a) silently substitutes the document default — the bulk `psObj.properties =
//       {appliedFont:"MHei PRC", fontStyle:"Xbold"}` path, whose appliedFont key
//       precedes fontStyle, yields `Minion Pro\tXbold` (family lost to the doc
//       default, weight kept) — exactly the observed ghost; or
//   (b) THROWS "font family not available" (sequential bare write).
// The tab-name form resolves against the app font catalog even cold (only the
// FIRST cluster style to reference the family was cold → it alone broke, 1 of
// 41 — every later style found the family warm). fontStyle is derived from the
// resolved font, so it is not set separately.
//
// A truly-missing font (no such "Family\tStyle") becomes a NOT_AVAILABLE
// reference that PRESERVES the intended name, which the post-commit
// _sweepManagedStyleFonts can normalize (legacy→installed twin). A substitution,
// by contrast, loses the intent and the sweep cannot recover it — so tab-name is
// strictly safer than the bare-family bulk write for every font, not just CJK.
function _writeStyleFontTabName(styleObj, family, style) {
    if (!styleObj || !family) return;
    var fam = String(family);
    var sty = (style !== null && style !== undefined && String(style)) ? String(style) : "Regular";
    try { styleObj.appliedFont = fam + "\t" + sty; }
    catch (e) {
        // Defensive warm-path fallback; should be unreachable for installed
        // fonts (tab-name resolves cold). Keeps prior behavior on odd DOM states.
        try { styleObj.appliedFont = fam; } catch (e2) {}
        try { styleObj.fontStyle = sty; } catch (e3) {}
    }
}

// Read a style object's current (family, fontStyle). `appliedFont` may be a
// string family name or a Font object whose `.name` is "Family\tStyle"; split
// on tab and prefer the explicit `fontStyle` for the weight. An UNSET fontStyle
// comes back as the UXP `Nothing` enumerator (typeof "object", stringifies
// "NOTHING") — treat it as the default Regular weight, NOT a literal "NOTHING"
// weight word (else a legacy family with an unset style would slip past the
// resolver and keep substituting).
function _readStyleFont(styleObj) {
    var fam = null, sty = "Regular";
    try {
        var af = styleObj.appliedFont;
        var raw = (typeof af === "string") ? af : (af && af.name ? String(af.name) : null);
        if (raw) fam = (raw.indexOf("\t") >= 0) ? raw.split("\t")[0] : raw;
    } catch (eR) {}
    try {
        var fs = styleObj.fontStyle;
        if (typeof fs === "string" && fs && fs.toUpperCase() !== "NOTHING") sty = fs;
    } catch (eS) {}
    return fam ? { family: fam, fontStyle: sty } : null;
}

// TODO#15 ① [R1 audit chokepoint, 2026-06-22]: post-commit INVARIANT — every
// pipeline-managed `_T_*` style's appliedFont must be SYSTEM-installed. The
// per-call-site normalization (latin pool / GREP / latin CS) covers the latin
// styles THIS run builds, but other font-write paths can still land a legacy OT
// name that InDesign silently substitutes to the wrong weight: the CJK
// reverse-routing CS (`_T_CJK_*`), the emphasis CS (`__lockFamily`), a cluster
// paragraph style's psFont (reorganize / designer-CJK mode), or a STALE
// `_T_Latin_*` CS left by a prior run that a GREP still routes to (the "2023"
// orphan). ONE sweep over OUR namespace closes every gap regardless of which
// path wrote the font — and is a true invariant, not a per-symptom patch.
// Scoped to the `_T_` name prefix ONLY — never touches designer styles (intent
// review: a designer may deliberately keep a legacy name on their own style).
// 5-voice audit (2026-06-22) recommended direction; see _HANDOFF / DEV_LOG.
function _sweepManagedStyleFonts(workDoc, italicConfig) {
    var stats = { scanned: 0, fixed: 0, examples: [] };
    function _one(styleObj) {
        if (!styleObj) return;
        var nm = ""; try { nm = String(styleObj.name); } catch (eN) { return; }
        if (nm.indexOf("_T_") !== 0) return;   // OUR managed namespace only
        var cur = _readStyleFont(styleObj);
        if (!cur || !cur.family) return;
        stats.scanned++;
        var inst = _resolveInstalledFontName(workDoc, cur.family, cur.fontStyle);
        // null → truly missing (keep as-is = today's behavior); same → already
        // system-installed (no-op). Only rewrite when the resolved twin differs.
        if (!inst) return;
        if (inst.family === cur.family && inst.fontStyle === cur.fontStyle) return;
        _writeStyleFontNormalized(workDoc, styleObj, cur.family, cur.fontStyle, italicConfig || null);
        stats.fixed++;
        if (stats.examples.length < 12) {
            stats.examples.push(nm + " " + cur.family + "/" + cur.fontStyle + "→" + inst.family + "/" + inst.fontStyle);
        }
    }
    try { var cs = workDoc.characterStyles; for (var i = 0; i < cs.length; i++) { try { _one(cs.item(i)); } catch (eC) {} } } catch (eCS) {}
    try { var ps = workDoc.paragraphStyles; for (var j = 0; j < ps.length; j++) { try { _one(ps.item(j)); } catch (eP) {} } } catch (ePS) {}
    return stats;
}

var _installedProbeCache = null;

function _isFontInstalled(workDoc, fontFamily, fontStyle) {
    if (!fontFamily) return false;
    var style = fontStyle || "Regular";
    var key = fontFamily + "|" + style;
    if (!_installedProbeCache) _installedProbeCache = {};
    if (Object.prototype.hasOwnProperty.call(_installedProbeCache, key)) {
        return _installedProbeCache[key];
    }
    var fullName = fontFamily + "\t" + style;
    function probe(fontColl) {
        if (!fontColl) return false;
        try {
            var f = fontColl.itemByName(fullName);
            if (!f) return false;
            var valid = false; try { valid = !!f.isValid; } catch (eV) {}
            if (!valid) return false;
            // Check status — InDesign's FontStatus enum stringifies to
            // names like "INSTALLED" or "NOT_AVAILABLE". Anything other
            // than INSTALLED is unsafe to set on a paragraph style (the
            // commit would either silently fall back to InDesign's font
            // substitute or surface a missing-font dialog).
            var st = ""; try { st = String(f.status); } catch (eSt) {}
            if (!st) return true;   // status unreadable — give benefit of doubt
            if (st === "INSTALLED" || st.indexOf("INSTALLED") >= 0
                || st.indexOf("Installed") >= 0) return true;
            return false;
        } catch (eP) { return false; }
    }
    var ok = false;
    if (workDoc && workDoc.fonts) ok = probe(workDoc.fonts);
    if (!ok && workDoc) {
        // Walk up to the app and probe its catalog. Bounded loop so we
        // can never spin forever on a weird UXP DOM proxy.
        try {
            var appRef = workDoc.parent;
            for (var hop = 0; hop < 4 && appRef; hop++) {
                if (appRef.fonts) { ok = probe(appRef.fonts); break; }
                var nextRef = null;
                try { nextRef = appRef.parent; } catch (eN) { nextRef = null; }
                if (!nextRef || nextRef === appRef) break;
                appRef = nextRef;
            }
        } catch (eApp) {}
    }
    _installedProbeCache[key] = ok;
    return ok;
}

/**
 * Strip italic component from a fontStyle string, preserving the weight.
 *   "Italic"        → ""           (Regular implied)
 *   "Bold Italic"   → "Bold"
 *   "Light Italic"  → "Light"
 *   "Light Oblique" → "Light"
 *   "Bold"          → "Bold"       (no change)
 */
function _stripItalicFromFontStyle(fontStyle) {
    if (!fontStyle) return "";
    return String(fontStyle)
        .replace(/italic/ig, "")
        .replace(/oblique/ig, "")
        .replace(/\s+/g, " ")
        .trim();
}

function _diffHasItalicIntent(diff) {
    if (!diff || !diff.fontStyle) return false;
    var s = String(diff.fontStyle).toLowerCase();
    return s.indexOf("italic") >= 0 || s.indexOf("oblique") >= 0;
}

/**
 * Map snapshot justification string ("CENTER_ALIGN") to indesign.Justification
 * enum value. InDesign refuses string values when setting psObj.properties
 * or psObj.justification — silently falls back to LEFT_ALIGN.
 *
 * @param {string} jStr
 * @param {Object} JustificationEnum — indesign.Justification
 * @returns {*} enum value, or null if not resolvable
 */
function _resolveJustification(jStr, JustificationEnum) {
    if (!jStr || !JustificationEnum) return null;
    var s = String(jStr);
    // Strip "Justification." prefix if toString() rendered it
    if (s.indexOf(".") >= 0) s = s.split(".").pop();
    var keyCandidates = [
        s,                          // CENTER_ALIGN
        s.toLowerCase(),            // center_align (camelCase form some UXP versions use)
        // CENTER_ALIGN → centerAlign
        s.toLowerCase().replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); })
    ];
    for (var i = 0; i < keyCandidates.length; i++) {
        var v = JustificationEnum[keyCandidates[i]];
        if (v !== undefined && v !== null) return v;
    }
    return null;
}

// [indent-general · impl-audit xhigh P1·A] Resolve a captured tab-alignment string
// ("LEFT_ALIGN"/"CENTER_ALIGN"/"RIGHT_ALIGN"/"CHARACTER_ALIGN") to the TabStopAlignment
// enum, trying the SAME 3 casings as _resolveJustification/_resolveListType — because
// `String(enumProp)` casing VARIES across UXP builds (their own comments note the camelCase
// form). A single-candidate lookup would silently drop non-LEFT alignment to LEFT (masked by
// a LEFT-only render check). Falls back to LEFT_ALIGN only as a genuine last resort.
function _resolveTabAlignment(alignStr, TSA) {
    if (!TSA) return null;
    var s = alignStr ? String(alignStr) : "";
    if (s.indexOf(".") >= 0) s = s.split(".").pop();   // strip "TabStopAlignment." prefix
    if (!s) return TSA.LEFT_ALIGN;
    var cands = [s, s.toLowerCase(), s.toLowerCase().replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); })];
    for (var i = 0; i < cands.length; i++) {
        var v = TSA[cands[i]];
        if (v !== undefined && v !== null) return v;
    }
    return TSA.LEFT_ALIGN;   // last resort (LEFT is the safe geometric default)
}

/**
 * Resolve bullets-and-numbering type string to indesign.ListType enum.
 * Returns enum value or null if not resolvable / NO_LIST equivalent.
 */
function _resolveListType(typeStr, ListTypeEnum) {
    if (!typeStr || !ListTypeEnum) return null;
    var s = String(typeStr);
    if (s.indexOf(".") >= 0) s = s.split(".").pop();
    var keys = [s, s.toLowerCase(), s.toLowerCase().replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); })];
    for (var i = 0; i < keys.length; i++) {
        var v = ListTypeEnum[keys[i]];
        if (v !== undefined && v !== null) return v;
    }
    return null;
}

// [P1-C v2] Create/reuse a managed bullet-marker character style carrying the
// paragraph's ORIGINAL Latin source font, and return it (or null when the font is
// not installed → caller surfaces, never substitutes, §8). This is the EXPORT-
// CONFIRMED lever: host render-experiment 06 proved a bulletsCharacterStyle with a
// Latin font renders the • while leaving CJK body text intact (VB), whereas a
// bulletsFont pin is inert (VC) — the marker glyph otherwise resolves via char-1's
// CJK font. The style sets ONLY appliedFont; fill/size inherit char-1 so the marker
// keeps the paragraph's own ink + size (mirrors the source's charStyle=[None]
// behavior — no hard-coded black). Deduped by resolved font name so bullet clusters
// on the same Latin font share one style.
function _ensureBulletCharStyle(workDoc, family, style) {
    if (!workDoc || !family) return null;
    var inst = _resolveInstalledFontName(workDoc, family, style);
    if (!inst) return null;   // missing → caller surfaces (no substitute, §8)
    // [impl-audit P2·C, all 3 re-audit voices] a fallback that resolved the bullet font to a
    // CJK face (legacy pkg: bullet_font null + baseline overwritten to CJK by
    // applyScriptByFontDetection) would build a CJK bullet char style whose glyph the marker
    // can't draw — the SILENT suppression this whole fix targets, re-entering via the fallback.
    // A CJK face is never a valid §9 Latin bullet source → return null so the caller SURFACES
    // it (loud), never silently builds an unrenderable marker. MKD path unaffected (baseline=Whitney).
    // Use _isCJKFamilyName (the module's PRECISE stem-regex detector), NOT the broad-substring
    // _isCJKFont: the latter false-positives on Latin families sharing a marker substring (e.g.
    // "Founders Grotesk" ⊃ "founder") → would REGRESS a real Latin bullet to suppressed; the
    // regex is also broader for CJK stems (MSung/MKai/STHeiti/…) → closes more of the gap.
    if (_isCJKFamilyName(inst.family)) return null;
    var csName = "_T_c_bullet_" + _sanitize(inst.family) + "_" + _sanitize(inst.fontStyle);
    var cs = null;
    try { cs = workDoc.characterStyles.itemByName(csName); } catch (e) {}
    var have = false; try { have = !!(cs && cs.isValid); } catch (e) {}
    if (!have) {
        try { cs = workDoc.characterStyles.add({ name: csName }); }
        catch (eAdd) { try { cs = workDoc.characterStyles.itemByName(csName); } catch (e2) {} }
    }
    var ok = false; try { ok = !!(cs && cs.isValid); } catch (e) {}
    if (!ok) return null;
    // [impl-audit codex P3·A] preserve the ORIGINAL resolved bullet font/style. A bullet
    // marker is NOT an emphasis run, so it must NOT route through _writeStyleFontNormalized's
    // italic-config gate (which 乙-strictly normalizes an UNCONFIGURED italic → upright,
    // silently dropping an italic bullet source's slant). Write the install-verified
    // (family,style) DIRECTLY: cold-robust tab-name form + warm bare fallback (inst != null →
    // never a missing substitute, §8). fill/size left unset → inherit char-1 (source
    // charStyle=[None] behavior — marker keeps the paragraph's own ink + size).
    var _bfTab = inst.family + "\t" + inst.fontStyle;
    try { cs.appliedFont = _bfTab; }
    catch (eW) { try { cs.appliedFont = inst.family; } catch (eW2) {} }
    try { cs.fontStyle = inst.fontStyle; } catch (eS) {}
    return cs;
}

// [indent-general] Apply captured tab stops to a paragraph style, FAITHFULLY
// (position + alignment + leader + alignmentCharacter). EMPTY/absent tabStops ⇒ NO-OP
// (never clobber InDesign's default tabs to zero). Idempotent: clears the style's existing
// tab stops before re-adding (re-run safe). Alignment needs the TabStopAlignment enum — the
// bridge doesn't globalize it and the STRING form is rejected ("Invalid parameter", host-
// probed 2026-07-03), so it's resolved from deps.TabStopAlignment (threaded like ListType).
// If that enum is absent, the stop is still added position-only (InDesign defaults it to
// LEFT_ALIGN) so a Latin-common LEFT tab survives — but non-LEFT alignment needs the enum.
function _applyTabStops(psObj, tabStops, deps) {
    if (!psObj || !tabStops || !tabStops.length) return;   // empty ⇒ no-op (keep defaults)
    var TSA = deps && deps.TabStopAlignment;
    // idempotency: drop any existing tab stops on the style first (reverse iterate + remove).
    try {
        var existing = psObj.tabStops;
        for (var e = existing.length - 1; e >= 0; e--) {
            try { existing.item(e).remove(); } catch (eRm) {}
        }
    } catch (eClr) {}
    for (var i = 0; i < tabStops.length; i++) {
        var t = tabStops[i];
        if (!t || typeof t.position !== "number") continue;
        var spec = { position: t.position };
        // [xhigh P1·A] multi-casing enum resolution (single-candidate silently dropped non-LEFT).
        // [n1 P3·D] only set alignment when resolved (a malformed enum ⇒ undefined must not be
        // passed to add(), which could silently drop the whole stop incl. position).
        if (TSA) { var _al = _resolveTabAlignment(t.alignment, TSA); if (_al !== undefined && _al !== null) spec.alignment = _al; }
        // [xhigh P3·D] only set leader when non-empty (symmetric with alignmentCharacter) — an
        // empty-string leader on some UXP builds could throw in add() → all-adds-fail clobber.
        var ld = (t.leader !== undefined && t.leader !== null) ? String(t.leader) : "";
        if (ld !== "") spec.leader = ld;
        var ac = (t.alignment_char !== undefined && t.alignment_char !== null) ? String(t.alignment_char) : "";
        if (ac !== "") spec.alignmentCharacter = ac;
        try { psObj.tabStops.add(spec); } catch (eAdd) {}
    }
}

/**
 * Apply bulletsSpec to a paragraph style. Handles ListType enum + bullet
 * char + numbering format. No-op for NO_LIST (default already).
 */
function _applyBulletsSpec(psObj, spec, deps, workDoc) {
    if (!psObj || !spec) return;
    var typeStr = spec.type || "NO_LIST";
    // [codex bullet-audit] strip an enum prefix ("ListType.BULLET_LIST" → "BULLET_LIST")
    // so the char/font blocks (=== "BULLET_LIST") don't false-negative on a package that
    // stored the prefixed form — mirrors _resolveListType's own prefix handling (:2465).
    if (typeStr.indexOf(".") >= 0) typeStr = typeStr.split(".").pop();
    if (typeStr === "NO_LIST" || typeStr === "noList") return;
    var listType = _resolveListType(typeStr, deps && deps.ListType);
    if (listType === null) return;
    try { psObj.bulletsAndNumberingListType = listType; } catch (eL) {}
    var _bfSurface;   // [P1-C] set when the original bullet Latin font is not installed → surface
    if (typeStr === "BULLET_LIST" && spec.bulletChar) {
        try {
            // [P1-C fix] `bulletChar` is a READ-ONLY Bullet object — a whole-object
            // assign (`psObj.bulletChar = {...}`) THROWS "'bulletChar' is a read only
            // property" (host-verified; the throw was silently swallowed). Set the
            // codepoint via the SUB-property `.characterValue` (host-verified write).
            // listType=BULLET_LIST is already set above, so bulletChar exists.
            var ch = String(spec.bulletChar);
            if (ch.length > 0) {
                psObj.bulletChar.characterValue = ch.charCodeAt(0);
            }
        } catch (eBC) {}
    }
    // [P1-C v2 · host render-experiment 06, export-confirmed] preserve-original bullet
    // FONT (user ruling §9) via bulletsCharacterStyle — NOT bulletsFont. When
    // bulletsCharacterStyle=[None] the marker's glyph resolves via the paragraph's
    // CHAR-1 FONT (CJK MHei → • not drawn); a bulletsFont pin is INERT (06: VC pin→no •,
    // VA char1-font→•, VB bulletsCharacterStyle→• with CJK body intact). So assign a
    // managed char style carrying the captured Latin source font — the font SOURCE is
    // unchanged (spec.bulletFont), only the APPLICATION point moves bulletsFont →
    // bulletsCharacterStyle. install-verify is inside _ensureBulletCharStyle (twin-aware);
    // MISSING → null → do NOT substitute (§8) → surface (marker stays suppressed until the
    // operator installs / remaps / accepts).
    if (typeStr === "BULLET_LIST" && spec.bulletFont && workDoc) {
        var _bfName = String(spec.bulletFont);
        var _bfFam = (_bfName.indexOf("\t") >= 0) ? _bfName.split("\t")[0] : _bfName;
        var _bfSty = (_bfName.indexOf("\t") >= 0) ? (_bfName.split("\t")[1] || "Regular") : "Regular";
        var _bcs = _ensureBulletCharStyle(workDoc, _bfFam, _bfSty);
        if (_bcs) {
            try { psObj.bulletsCharacterStyle = _bcs; } catch (eBCS) {}
        } else {
            _bfSurface = { style: (function () { try { return String(psObj.name); } catch (e) { return "?"; } })(), font: _bfFam, weight: _bfSty };
        }
    }
    if (typeStr === "NUMBERED_LIST") {
        if (spec.numberingFormat) {
            try { psObj.numberingFormat = String(spec.numberingFormat); } catch (eNF) {}
        }
        if (spec.numberingStartAt) {
            try { psObj.numberingStartAt = Number(spec.numberingStartAt); } catch (eNS) {}
        }
    }
    return _bfSurface;   // [P1-C] {style,font,weight} when the bullet Latin font is missing, else undefined
}

/**
 * Resolve a leadingSpec to either a number (pt) or indesign.Leading.AUTO.
 * leading lives on character properties in InDesign DOM, but ParagraphStyle
 * carries it as the default for its content. Setting via psObj.leading works.
 *
 * @param {*} spec — number (pt), "AUTO", or null
 * @param {Object} LeadingEnum — indesign.Leading
 * @returns {*} resolved value or undefined (leave unchanged)
 */
function _resolveLeading(spec, LeadingEnum) {
    if (spec === null || spec === undefined) return undefined;
    if (typeof spec === "number" && isFinite(spec) && spec > 0) return spec;
    if (typeof spec === "string") {
        var s = spec;
        if (s === "AUTO" || s === "Auto" || s === "auto") {
            if (LeadingEnum && LeadingEnum.AUTO !== undefined) return LeadingEnum.AUTO;
            return undefined;   // can't resolve without enum — skip
        }
        var n = Number(s);
        if (isFinite(n) && n > 0) return n;
    }
    return undefined;
}

/**
 * Resolve a fillColorSpec ({swatch, space, values}) to a Color/Swatch object
 * usable for psObj.fillColor. Strategy:
 *   1. Look up swatch by name in workDoc.swatches (handles "Black", "Paper",
 *      "Dark Gray", and any user-defined swatches in the source doc).
 *   2. If not found AND values[] are present, create a synthetic color via
 *      workDoc.colors.add({name, model, space, colorValue}).
 *   3. If both fail, return null (caller leaves fillColor unchanged).
 *
 * @param {Document} workDoc
 * @param {Object} spec — {swatch, space, values}
 * @param {Object} deps — { ColorSpace?, ColorModel? } enums
 */
// ─── Paragraph rule writer ─────────────────────────────────────────
//
// Round-trip rule_above / rule_below from snapshot → new para style.
// Bulk-settable scalars are handled by the caller via psObj.properties =
// bulkProps. This helper covers the resolution-required slots:
//   • ruleAboveColor / ruleAboveGapColor — need Swatch/Color object lookup
//     (snapshot serializes as { swatch, space, values }; same shape as
//     fillColor — reuse _resolveFillColor)
//   • ruleAboveType                       — needs StrokeStyle object lookup
//     (snapshot has a name string; doc.strokeStyles.itemByName resolves)
//   • ruleAboveWidth                      — needs RuleWidth enum
//     (snapshot has a string "TEXT_WIDTH" / "COLUMN_WIDTH")
//
// Inactive rules: skip entirely. The bulk set already turned the rule
// boolean OFF; touching color/type when inactive throws (the slot expects
// non-null but InDesign reports null when rule=false).
//
// `deps` needs: RuleWidth (enum), ColorSpace / ColorModel (for color
// synthesis fallback in _resolveFillColor). Other deps are optional.
function _applyRuleSpec(psObj, ruleSpec, prefix, workDoc, deps) {
    // Single source of truth for round-tripping rule_above / rule_below
    // snapshots back to a paragraph style. Idempotent — safe to call
    // repeatedly; inactive specs reset only the toggle.
    if (!psObj) return;
    if (!ruleSpec || !ruleSpec.active) {
        try { psObj[prefix] = false; } catch (eOff) {}
        return;
    }
    // Enable rule first; InDesign rejects sub-property writes (Color/Type/
    // Width) on a disabled rule with "rule not on" errors on some hosts.
    try { psObj[prefix] = true; } catch (eOn) {}

    // Scalar fields (numbers, booleans). Wrapped per-prop so a single bad
    // value doesn't skip the rest.
    var scalars = [
        ["LineWeight",   ruleSpec.weight],
        ["Offset",       ruleSpec.offset],
        ["Tint",         ruleSpec.tint],
        ["LeftIndent",   ruleSpec.leftIndent],
        ["RightIndent",  ruleSpec.rightIndent],
        ["GapTint",      ruleSpec.gapTint],
        ["Overprint",    ruleSpec.overprint],
        ["GapOverprint", ruleSpec.gapOverprint]
    ];
    for (var si = 0; si < scalars.length; si++) {
        var name = prefix + scalars[si][0];
        var val  = scalars[si][1];
        if (val === undefined || val === null) continue;
        try { psObj[name] = val; } catch (eS) {}
    }

    // Color — reuse fillColor resolver (handles swatch lookup + Color synth).
    // The "Text Color" sentinel swatch (which makes the rule track the text
    // color of the paragraph) is a real entry in doc.swatches → itemByName
    // returns it directly. So the existing _resolveFillColor path is enough.
    if (ruleSpec.color) {
        try {
            var col = _resolveFillColor(workDoc, ruleSpec.color, deps);
            if (col) psObj[prefix + "Color"] = col;
        } catch (eC) {}
    }
    if (ruleSpec.gapColor) {
        try {
            var gc = _resolveFillColor(workDoc, ruleSpec.gapColor, deps);
            if (gc) psObj[prefix + "GapColor"] = gc;
        } catch (eGC) {}
    }

    // Type — stroke style by name (e.g. "Solid", "Thin - Thin")
    if (ruleSpec.type) {
        try {
            var ss = workDoc.strokeStyles.itemByName(String(ruleSpec.type));
            if (ss && ss.isValid) psObj[prefix + "Type"] = ss;
        } catch (eT) {}
    }

    // Width — RuleWidth enum
    if (ruleSpec.width && deps && deps.RuleWidth) {
        try {
            var w = String(ruleSpec.width).toUpperCase();
            var resolved = null;
            if (w === "TEXT_WIDTH" || w === "TEXTWIDTH" || w === "TEXT") {
                resolved = deps.RuleWidth.textWidth;
            } else if (w === "COLUMN_WIDTH" || w === "COLUMNWIDTH" || w === "COLUMN") {
                resolved = deps.RuleWidth.columnWidth;
            }
            if (resolved !== null && resolved !== undefined) {
                psObj[prefix + "Width"] = resolved;
            }
        } catch (eW) {}
    }
}

function _resolveFillColor(workDoc, spec, deps) {
    if (!spec || !workDoc) return null;
    // Step 0: sentinel/binding swatch names — these are NOT real swatches
    // (itemByName returns isValid=false) but are internal references the
    // host resolves at render time. Examples: "Text Color" (rule/border
    // tracks the run color), "Registration", etc. If the snapshot
    // captured one, we MUST NOT fall through to colors.add(values) below
    // — that would synthesize a fixed-RGB swatch and lose the binding
    // semantics. Returning null lets the caller skip the assignment and
    // keep the paragraph-style default, which for ruleAboveColor IS the
    // "Text Color" binding (verified in InDesign 2026 UXP).
    if (spec.swatch) {
        var n = String(spec.swatch);
        if (n === "Text Color" || n === "[Text Color]") {
            return null;
        }
    }
    // Step 1: existing swatch by name
    if (spec.swatch) {
        try {
            var sw = workDoc.swatches.itemByName(String(spec.swatch));
            if (sw && sw.isValid) return sw;
        } catch (e) {}
    }
    // Step 2: synthesize color
    if (spec.values && spec.values.length) {
        try {
            var spaceEnum = null;
            if (deps && deps.ColorSpace) {
                if (spec.space === "CMYK") spaceEnum = deps.ColorSpace.cmyk;
                else if (spec.space === "RGB") spaceEnum = deps.ColorSpace.rgb;
                else if (spec.space === "LAB") spaceEnum = deps.ColorSpace.lab;
            }
            var modelEnum = null;
            if (deps && deps.ColorModel) modelEnum = deps.ColorModel.process;
            var nameHint = "_T_color_" + (spec.swatch || "x") + "_" + (spec.values.join("_"));
            var addProps = {
                name: nameHint,
                colorValue: spec.values
            };
            if (spaceEnum !== null) addProps.space = spaceEnum;
            if (modelEnum !== null) addProps.model = modelEnum;
            // Try fetch existing first to avoid name collisions
            try {
                var existing = workDoc.swatches.itemByName(nameHint);
                if (existing && existing.isValid) return existing;
            } catch (eFetch) {}
            return workDoc.colors.add(addProps);
        } catch (eAdd) {}
    }
    return null;
}

// ─── Commit (apply plan to doc) ───────────────────────────────────

/**
 * Apply plan to workDoc. Topological order: latin → para (para's GREP
 * references latin). Caller MUST guarantee preflight passed; this function
 * does NOT check.
 *
 * @param {Object} deps — { Justification?, ColorSpace?, ColorModel? } enums.
 *                        Required for properly setting alignment + fillColor;
 *                        when missing, those props silently degrade to defaults.
 */
function commitStylePlan(workDoc, plan, deps) {
    if (!workDoc) throw new Error("commitStylePlan: workDoc required");
    if (!plan) throw new Error("commitStylePlan: plan required");

    var paraStyleMap = {};
    var latinStyleMap = {};
    var cjkStyleMap = {};
    deps = deps || {};

    // #DIAG-COMMIT-TIMING: capture per-sub-step timing inside commitStylePlan.
    // Surfaced via deps.timings if caller wires one in.
    var __ct = { _start: Date.now(), _steps: [] };
    // #REALTIME-LOG (2026-05-26): flush to plog so the disk log file stays
    // current during the 100s+ manual commit phase. Without this, hangs
    // mid-commit leave no breadcrumb at all.
    var __ctPlog = (deps && typeof deps.plog === "function") ? deps.plog : null;
    function __ctMark(label) {
        var ms = Date.now() - __ct._start;
        __ct._steps.push({ label: label, ms: ms });
        if (__ctPlog) { try { __ctPlog("commit: " + label + " +" + ms + "ms"); } catch (e) {} }
    }
    __ctMark("commit_enter");

    // Reset the italic-availability probe cache ONCE at pass entry. Both Step 1
    // (latin char styles, below) and the later emphasis-pool step gate on
    // _probeFontHasItalic, so the reset must precede the FIRST use — not sit
    // between them (fix-faux-latin-italic: Step 1 now probes too).
    _resetItalicProbeCache();

    // Step 1: create Latin character styles (referenced by GREP rules)
    //
    // #ITALIC-SKEW-CS — univ-italic ③ (2026-06-28, audit-corrected): when a Latin
    // pool entry carries an Italic-flavored fontStyle, the CS's italic realization is
    // now OPERATOR-CONFIG-GATED (乙-strict), NOT the old auto "weight-only + skew=15"
    // synthetic italic. The write goes through the SHARED `_writeStyleFontNormalized`
    // chokepoint (also used by the post-commit sweep), which reads the per-weight
    // brand_config: configured faux → weight + CS-body skew=config-angle; configured
    // real + weight-exact face → real italic, skew 0; configured real + none → block
    // (upright); UNCONFIGURED → upright (no auto-slant — the machine never auto-italics
    // an unconfigured weight). The config is threaded via deps.italicConfig (libDeps).
    for (var i = 0; i < plan.latinStylesToCreate.length; i++) {
        var ls = plan.latinStylesToCreate[i];
        try {
            // Re-use existing style on idempotent re-run.
            var lsObj = null;
            try {
                var existing = workDoc.characterStyles.itemByName(ls.name);
                if (existing && existing.isValid) lsObj = existing;
            } catch (eEx2) {}
            if (!lsObj) lsObj = workDoc.characterStyles.add({ name: ls.name });
            // TODO#15 ①: normalize the WRITTEN font to a SYSTEM-installed (family,
            // style). Catches any spec (or a REUSED source-doc CS of the same
            // name — itemByName above) that kept a legacy OT name like "Whitney"+
            // "Regular" (NOT a system font → InDesign substitutes to the wrong
            // weight "Whitney"+"Bold"). Preserves weight + italic; null → keep.
            _writeStyleFontNormalized(workDoc, lsObj, ls.fontFamily, ls.fontStyle, (deps && deps.italicConfig) || null);
            // Stamp fingerprint into label for E5a round-trip
            try { lsObj.label = ls.fingerprint; } catch (eL) {}
            latinStyleMap[ls.fingerprint] = lsObj;
        } catch (e) {
            throw new Error("commitStylePlan: failed to create latin style '" + ls.name + "': " + e.message);
        }
    }
    __ctMark("step1_latin_styles_done(" + plan.latinStylesToCreate.length + ")");

    // Step 1b: #BRIDGE-28 — create CJK reverse-routing character styles
    // (referenced by cjkGrepRule on Latin-base scriptByFont clusters).
    // Mirror of Step 1 with `_T_CJK_*` naming and CJK font family/style.
    var cjkStylesToCreate = plan.cjkStylesToCreate || [];
    for (var iC = 0; iC < cjkStylesToCreate.length; iC++) {
        var cs = cjkStylesToCreate[iC];
        try {
            var csObj = null;
            try {
                var existingC = workDoc.characterStyles.itemByName(cs.name);
                if (existingC && existingC.isValid) csObj = existingC;
            } catch (eExC) {}
            if (!csObj) csObj = workDoc.characterStyles.add({ name: cs.name });
            // [P2b Fix a] normalize + cold-robust write (was bare appliedFont +
            // fontStyle). Legacy families normalize (Dax Light→Dax Pro); a missing
            // CJK weight (e.g. MHei PRC|Regular uninstalled) resolves to null → the
            // ORIGINAL name is kept NOT_AVAILABLE (no substitution — policy-aligned).
            _writeStyleFontNormalized(workDoc, csObj, cs.fontFamily, cs.fontStyle, (deps && deps.italicConfig) || null);
            try { csObj.label = cs.fingerprint; } catch (eLC) {}
            cjkStyleMap[cs.fingerprint] = csObj;
        } catch (e) {
            throw new Error("commitStylePlan: failed to create CJK style '" + cs.name + "': " + e.message);
        }
    }
    __ctMark("step1b_cjk_styles_done(" + cjkStylesToCreate.length + ")");

    // Step 2: create paragraph styles + GREP rules referencing latin
    var noStyle = null;
    try { noStyle = workDoc.paragraphStyles.itemByName("[No Paragraph Style]"); if (!noStyle.isValid) noStyle = null; } catch (eNS) {}
    // #DIAG-COMMIT-TIMING: per paragraph-style sub-step accumulators
    var __psStepTotals = { add: 0, props: 0, lang: 0, fillColor: 0, leading: 0,
                            bullets: 0, rules: 0, label: 0, grepClear: 0,
                            grepAdd: 0, designerGrepCopy: 0, other: 0 };
    var __psStart;
    var __psStepStart;
    for (var p = 0; p < plan.paraStylesToCreate.length; p++) {
        var ps = plan.paraStylesToCreate[p];
        __psStart = Date.now();
        try {
            // Re-use existing _T_p_* style if name already in doc (idempotent
            // re-run: descriptive names + stable hashes mean the same content
            // produces the same style name across runs). Properties below
            // overwrite whatever was there, keeping the style spec authoritative.
            __psStepStart = Date.now();
            var psObj = null;
            try {
                var existing = workDoc.paragraphStyles.itemByName(ps.name);
                if (existing && existing.isValid) psObj = existing;
            } catch (eEx) {}
            if (!psObj) psObj = workDoc.paragraphStyles.add({ name: ps.name });
            // Force basedOn = [No Paragraph Style] to break any auto-inherited
            // basedOn chain (which might propagate style assignments to siblings)
            if (noStyle) { try { psObj.basedOn = noStyle; } catch (eBO) {} }
            __psStepTotals.add += Date.now() - __psStepStart;

            // Bulk-set the simple props (numbers + booleans).
            // Strip justification from the bulk set — it needs enum resolution.
            // Strip appliedFont + fontStyle too — the bulk `.properties=` bare-
            // family write substitutes the document default for a font that is
            // cold in workDoc.fonts (the target CJK family on first reference →
            // the "财务顾问" Minion-Xbold ghost). They are written below via the
            // cold-robust tab-name form (_writeStyleFontTabName).
            __psStepStart = Date.now();
            var bulkProps = {};
            for (var k in ps.properties) {
                if (!ps.properties.hasOwnProperty(k)) continue;
                if (k === "justification") continue;
                if (k === "appliedFont" || k === "fontStyle") continue;
                bulkProps[k] = ps.properties[k];
            }
            try { psObj.properties = bulkProps; } catch (eProps) {}
            // Cluster psFont — [P2b Fix a] normalize + cold-robust write (was the
            // non-normalizing _writeStyleFontTabName). Legacy families now normalize
            // (Dax Light→Dax Pro); a missing family/weight resolves null → kept
            // NOT_AVAILABLE (no substitution — policy-aligned).
            _writeStyleFontNormalized(workDoc, psObj, ps.properties.appliedFont, ps.properties.fontStyle, (deps && deps.italicConfig) || null);

            // Justification: convert string → enum
            var jResolved = _resolveJustification(ps.properties.justification, deps.Justification);
            if (jResolved !== null) {
                try { psObj.justification = jResolved; } catch (eJ) {}
            }
            __psStepTotals.props += Date.now() - __psStepStart;

            // #BRIDGE-29: copy appliedLanguage from the source paragraph
            // style. Newly-created paragraph styles default to "English: USA",
            // which makes Adobe Japanese Composer skip CJK-Latin aki spacing
            // (the 1/4-em gap between 汉字 and ²/³/⁴ superscript digits or
            // adjacent Latin words). The source style already carries the
            // correct language (e.g. "Chinese: Simplified"); copy by object
            // reference because CJK languages aren't reachable via
            // app.languagesWithVendors.itemByName(). Auto-merged clusters
            // take the bucket sample's source style (ps._sourceStyleName).
            __psStepStart = Date.now();
            try {
                var __langSrcName = ps._sourceStyleName ||
                    (ps._sourceStyleNames && ps._sourceStyleNames.length ? ps._sourceStyleNames[0] : "");
                if (__langSrcName && __langSrcName.indexOf("_T_") !== 0) {
                    var __langSrcPs = _findParagraphStyleByName(workDoc, __langSrcName);
                    if (__langSrcPs && __langSrcPs.isValid) {
                        var __srcLang = __langSrcPs.appliedLanguage;
                        if (__srcLang) {
                            try { psObj.appliedLanguage = __srcLang; } catch (eLng) {}
                        }
                    }
                }
            } catch (eLngOuter) {}
            __psStepTotals.lang += Date.now() - __psStepStart;

            // fillColor: resolve swatch / synthesize Color
            __psStepStart = Date.now();
            if (ps.fillColorSpec) {
                var colorObj = _resolveFillColor(workDoc, ps.fillColorSpec, deps);
                if (colorObj) {
                    try { psObj.fillColor = colorObj; } catch (eFC) {}
                }
            }
            // #UL-DETAIL (2026-05-26): underlineColor uses the same swatch
            // resolution as fillColor. Apply only when underline is active.
            //
            // Fallback for old segments.json: if visual_snapshot didn't
            // capture underline offset/weight/color (pre-2026-05-26 export
            // packages don't have those fields), read them directly from
            // the source paragraph style by name. The source ps already
            // lives in workDoc — we don't need the snapshot to round-trip.
            if (ps.properties && ps.properties.underline) {
                var __srcUlName = ps._sourceStyleName ||
                    (ps._sourceStyleNames && ps._sourceStyleNames.length ? ps._sourceStyleNames[0] : "");
                var __srcUlPs = null;
                if (__srcUlName && __srcUlName.indexOf("_T_") !== 0) {
                    try { __srcUlPs = _findParagraphStyleByName(workDoc, __srcUlName); } catch (eUlSrc) {}
                    if (__srcUlPs && !__srcUlPs.isValid) __srcUlPs = null;
                }
                if (ps.underlineColorSpec) {
                    var ulColorObj = _resolveFillColor(workDoc, ps.underlineColorSpec, deps);
                    if (ulColorObj) {
                        try { psObj.underlineColor = ulColorObj; } catch (eULC) {}
                    }
                } else if (__srcUlPs) {
                    try {
                        var srcUlCol = __srcUlPs.underlineColor;
                        if (srcUlCol) {
                            try { psObj.underlineColor = srcUlCol; } catch (eULC2) {}
                        }
                    } catch (eULRead) {}
                }
                // Offset / weight: same fallback. baseline values were 0
                // when snapshot didn't include the fields; copy from
                // source ps in that case so the visual matches.
                if (__srcUlPs && (!ps.properties.underlineOffset || ps.properties.underlineOffset === 0)) {
                    try { psObj.underlineOffset = __srcUlPs.underlineOffset; } catch (eUlO) {}
                }
                if (__srcUlPs && (!ps.properties.underlineWeight || ps.properties.underlineWeight === 0)) {
                    try { psObj.underlineWeight = __srcUlPs.underlineWeight; } catch (eUlW) {}
                }
            }
            __psStepTotals.fillColor += Date.now() - __psStepStart;

            // leading: resolve number or AUTO enum
            __psStepStart = Date.now();
            var leadingResolved = _resolveLeading(ps.leadingSpec, deps.Leading);
            if (leadingResolved !== undefined) {
                try { psObj.leading = leadingResolved; } catch (eLd) {}
            }
            __psStepTotals.leading += Date.now() - __psStepStart;

            // bullets / numbering: needs ListType enum resolution
            __psStepStart = Date.now();
            if (ps.bulletsSpec) {
                var _bfSurf = _applyBulletsSpec(psObj, ps.bulletsSpec, deps, workDoc);
                // [P1-C (a)] a bullet whose original Latin font isn't installed → collect
                // (NEVER silently substituted — the • stays AUTO/unrendered, not swapped).
                // Rides out via plan.clusterReport into the report JSON (same pattern as
                // emp_italic_surfaced) AND is logged LOUD at commit end (the
                // bullet-font-surface plog after the sweep). A future Hook-B interactive
                // surface can read this list.
                if (_bfSurf && plan && plan.clusterReport) {
                    (plan.clusterReport.bullet_font_surfaced = plan.clusterReport.bullet_font_surfaced || []).push(_bfSurf);
                }
            }
            __psStepTotals.bullets += Date.now() - __psStepStart;

            // [indent-general] captured tab stops — faithful restore; empty ⇒ no-op.
            __psStepStart = Date.now();
            if (ps.tabStopsSpec) { _applyTabStops(psObj, ps.tabStopsSpec, deps); }
            __psStepTotals.other += Date.now() - __psStepStart;

            // Paragraph rules
            __psStepStart = Date.now();
            _applyRuleSpec(psObj, ps.ruleAboveSpec, "ruleAbove", workDoc, deps);
            _applyRuleSpec(psObj, ps.ruleBelowSpec, "ruleBelow", workDoc, deps);

            try { psObj.label = ps.fingerprint; } catch (eLP) {}
            __psStepTotals.rules += Date.now() - __psStepStart;

            __psStepStart = Date.now();
            // #8 fix: clear pipeline-managed nested GREP rules BEFORE adding
            // the new one. The "reuse existing _T_p_*" path above means a
            // re-run with changed plan/script-classifier output would leave
            // old GREP rules in place AND add new ones → duplicate GREP per
            // style, wrong char style winning, or stale Latin routing
            // surviving config changes. Only remove rules whose target char
            // style is pipeline-managed ("_T_" prefix); designer-added
            // GREP rules on this style (rare but possible) are preserved.
            try {
                var existingGreps = psObj.nestedGrepStyles;
                var greps = [];
                for (var __gi = 0; __gi < existingGreps.length; __gi++) { greps.push(existingGreps.item(__gi)); }
                for (var __gj = greps.length - 1; __gj >= 0; __gj--) {
                    var __g = greps[__gj];
                    var __targetName = "";
                    try { __targetName = String(__g.appliedCharacterStyle.name); } catch (eGN) {}
                    // #8 fix: clear pipeline-managed (`_T_*`) GREP rules.
                    // #BRIDGE-28b: ALSO clear designer (non-`_T_*`) GREPs
                    // when this paragraph style is being re-clustered. The
                    // re-copy block below decides which designer GREPs to
                    // re-attach based on current range-conflict guards;
                    // without this preclean, an old designer GREP from a
                    // prior run survives and overrides the current cluster
                    // intent (e.g. designer "Latin → EJ Sans Text Light"
                    // overrides a fresh "Latin → _T_Latin_*_Semibold" or
                    // CJK psFont's native Latin coverage).
                    try { __g.remove(); } catch (eGR) {}
                }
            } catch (eGC) {}

            __psStepTotals.grepClear += Date.now() - __psStepStart;

            __psStepStart = Date.now();
            if (ps.grepRule) {
                var latinObj = latinStyleMap[ps.grepRule.latinStyleFingerprint];
                if (latinObj) {
                    try {
                        psObj.nestedGrepStyles.add({
                            grepExpression: ps.grepRule.expression,
                            appliedCharacterStyle: latinObj
                        });
                    } catch (eGrep) {}
                }
            }

            // #BRIDGE-28: emit CJK reverse-routing GREP when Latin-base
            // scriptByFont cluster has cjkGrepRule. Latin chars use
            // cluster psFont (Latin) via inheritance; CJK chars get
            // routed here to `_T_CJK_*` CS for their original CJK font.
            if (ps.cjkGrepRule) {
                var cjkObj = cjkStyleMap[ps.cjkGrepRule.cjkStyleFingerprint];
                if (cjkObj) {
                    try {
                        psObj.nestedGrepStyles.add({
                            grepExpression: ps.cjkGrepRule.expression,
                            appliedCharacterStyle: cjkObj
                        });
                    } catch (eGrepC) {}
                }
            }
            __psStepTotals.grepAdd += Date.now() - __psStepStart;

            __psStepStart = Date.now();
            // #32 G4 / #BRIDGE-13: copy designer-added (non-`_T_*`) nested
            // GREP rules from EVERY source paragraph style that landed in
            // this cluster. The cluster pipeline replaces each para's
            // `appliedParagraphStyle` with the new `_T_p_*`, so any
            // designer GREP rule on the original style (e.g. "match URL
            // → Hyperlink Style", "match ™ → Superscript Style",
            // "match (\d+%) → Tabular Figures Style") would be silently
            // lost without this copy. Before #BRIDGE-13 we only walked
            // the bucket sample's source style — but auto-merge often
            // pulls multiple designer-named styles into one fingerprint,
            // so non-sample styles' GREP rules disappeared. Now we
            // iterate the full sourceStyleNames list and dedupe by
            // (grepExpression, charStyleName) so duplicate rules from
            // co-merged styles only get added once.
            var __srcStyleNames = (ps._sourceStyleNames && ps._sourceStyleNames.length)
                ? ps._sourceStyleNames
                : (ps._sourceStyleName ? [ps._sourceStyleName] : []);
            if (__srcStyleNames.length) {
                var __addedGreps = {};   // key: grepExpression + "\t" + csName
                // #BRIDGE-28b: skip designer GREP rules whose range duplicates
                // a cluster-emitted GREP (Latin OR CJK). InDesign applies
                // nested GREPs in order with later rules overriding earlier
                // ones — so a designer "Latin → EJ Sans Text Light" copied
                // AFTER the cluster's "Latin → _T_Latin_*_Semibold" would
                // override the cluster's intent (Semibold gets overwritten
                // to Light). Detect Latin/CJK shapes in the designer
                // expression and skip when the cluster already routes that
                // range. Designer GREPs targeting OTHER ranges (URL pattern,
                // numeric percentages, registered marks, etc.) still copy.
                function __isLatinRangeExpr(e) {
                    return /\\x\{0020\}|\\x\{0021\}|\\x\{0041\}|\\x\{007E\}|\\x\{00A0\}|\\x\{00C0\}|\[!-~|\[\\x21\-\\x7E|\[\\x20\-\\x7E|\[A-Z|\[a-z/.test(e);
                }
                function __isCJKRangeExpr(e) {
                    return /\\x\{4E00\}|\\x\{3400\}|\\x\{F900\}|\\x\{9FFF\}/.test(e);
                }
                var __clusterHasLatinGrep = !!ps.grepRule;
                var __clusterHasCJKGrep   = !!ps.cjkGrepRule;
                // #BRIDGE-28b extended: when cluster psFont is a CJK
                // family (Source Han, MHei, MSung, ...), Latin chars
                // inherit it directly (CJK fonts cover Latin glyphs).
                // Designer GREP routing Latin → some Latin CS would
                // overwrite the cluster intent (cluster says "CJK font
                // for everything"). Suppress any Latin-range designer
                // GREP in that case, even when the cluster didn't emit
                // its own Latin GREP. Same for the CJK side.
                // ps.appliedFont lives under properties (see plan spec push).
                var __clusterPsFontStr = (ps.properties && ps.properties.appliedFont) || "";
                var __clusterPsFontIsCJK = _isCJKFamilyName(__clusterPsFontStr);
                for (var __ssni = 0; __ssni < __srcStyleNames.length; __ssni++) {
                    var __ssn = __srcStyleNames[__ssni];
                    if (!__ssn || __ssn.indexOf("_T_") === 0) continue;
                    try {
                        var srcPs = _findParagraphStyleByName(workDoc, __ssn);
                        if (!srcPs || !srcPs.isValid) continue;
                        var srcGreps = srcPs.nestedGrepStyles;
                        var srcN = 0; try { srcN = srcGreps.length; } catch (e) {}
                        for (var __sg = 0; __sg < srcN; __sg++) {
                            try {
                                var __srcG = srcGreps.item(__sg);
                                var __srcCsName = "";
                                try { __srcCsName = String(__srcG.appliedCharacterStyle && __srcG.appliedCharacterStyle.name); } catch (e1) {}
                                if (!__srcCsName || __srcCsName.indexOf("_T_") === 0) continue;
                                var __expr = String(__srcG.grepExpression || "");
                                // #BRIDGE-28b range-conflict guard.
                                if (__isLatinRangeExpr(__expr) && (__clusterHasLatinGrep || __clusterPsFontIsCJK)) continue;
                                if (__isCJKRangeExpr(__expr)   && __clusterHasCJKGrep) continue;
                                var __key  = __expr + "\t" + __srcCsName;
                                if (__addedGreps[__key]) continue;
                                // Resolve the target char style by name in workDoc
                                var __tgtCs = null;
                                try { __tgtCs = workDoc.characterStyles.itemByName(__srcCsName); } catch (e2) {}
                                if (!__tgtCs || !__tgtCs.isValid) continue;
                                psObj.nestedGrepStyles.add({
                                    grepExpression: __expr,
                                    appliedCharacterStyle: __tgtCs
                                });
                                __addedGreps[__key] = true;
                            } catch (eGCopy) {}
                        }
                    } catch (eGSP) {}
                }
            }

            __psStepTotals.designerGrepCopy += Date.now() - __psStepStart;

            paraStyleMap[ps.fingerprint] = psObj;
        } catch (e) {
            throw new Error("commitStylePlan: failed to create para style '" + ps.name + "': " + e.message);
        }
    }
    __ct._psStepTotals = __psStepTotals;

    // If the plan came with fingerprintRedirect (set by style_merge_advisor.
    // mergeGroupsAtConfidence), populate paraStyleMap with both the
    // original AND the redirect-source fingerprints pointing to the same
    // paragraph style object. Without this, applyClusterStyleToParagraph
    // would compute a paragraph's original fingerprint, look it up, and
    // miss because the style was merged into another fingerprint.
    if (plan.fingerprintRedirect) {
        for (var redirFp in plan.fingerprintRedirect) {
            if (!plan.fingerprintRedirect.hasOwnProperty(redirFp)) continue;
            var targetFp = plan.fingerprintRedirect[redirFp];
            if (paraStyleMap[targetFp]) paraStyleMap[redirFp] = paraStyleMap[targetFp];
        }
    }
    __ctMark("step2_para_styles_done(" + plan.paraStylesToCreate.length + ")");

    // Step 2.5: create Phase 8B emphasis character styles. Idempotent on
    // re-run via itemByName lookup; cluster-stable fingerprints mean repeat
    // builds reuse the same _T_c_emp_* style. Failures degrade gracefully
    // — the applier just won't find the style and skips the run.
    //
    // Italic realization — univ-italic (audit P1): when a pool entry carries
    // fontStyle italic intent, the slant is OPERATOR-CONFIG-GATED via the shared
    // resolveItalicRealization (same as carrier #1 / ③), NOT the old auto
    // "no italic variant → skew=15 / has variant → real italic" probe behavior.
    // Per the per-weight brand_config: configured faux → weight + skew=config-angle;
    // configured real + weight-exact face → real italic, skew 0; configured real +
    // none → block (upright); unconfigured → upright (no auto-slant, 乙-strict,
    // counted in emp_italic_surfaced). Keyed on (resolved family, italic-stripped
    // weight), threaded via deps.italicConfig.
    var empCharStyleMap = {};
    var empList = plan.empCharStylesToCreate || [];
    var skewFallbackCount = 0;
    var empItalicSurfacedCount = 0;   // audit P1: 乙-strict block/surface (no auto-slant)
    var empItalicKeptCount = 0;       // AC④': real italic faces left as the document had them
    for (var ei = 0; ei < empList.length; ei++) {
        var es = empList[ei];
        try {
            var spec = es.propsSpec || {};
            var styleName = es.name;
            // Italic realization (per pool entry). univ-italic (audit P1): config-gate
            // this Phase-8B source-emphasis pool the SAME way as carrier #1 / ③, instead
            // of the old auto behavior (italic-less → skew=15 / has-italic → auto real
            // italic). That auto path was ungated yet LIVE on restyle-untranslated +
            // reorganize, violating 乙-strict. Key = (resolved family, italic-stripped
            // weight), shared with the other paths (contract K). Clone spec first
            // (callers may inspect plan.empCharStylesToCreate post-commit).
            if (es.hasItalicIntent && es.effectiveFont) {
                var _emFam = "";
                try { _emFam = _FontItalicProbe.familyOf(es.effectiveFont); } catch (eEmF) {}
                if (!_emFam) _emFam = String(es.effectiveFont).split("\t")[0];
                // TODO#26: was `_stripItalicToWeight` (oblique-blind). Behaviour here is
                // unchanged — this value is only a KEY (lookup + findExactItalicStyleName),
                // and both fold oblique internally, so "Light Oblique" and "Light" already
                // resolved identically. Switched anyway so the oblique-blind helper is gone
                // from every call site and cannot be copied into a WRITE path later.
                // (This pool's write arms use `_stripItalicFromFontStyle`, :3433/:3452,
                // which already strips both.)
                var _emW = _stripSlantToWeight(spec.fontStyle) || "Regular";
                var _emCfg = _ItalicConfig.lookup((deps && deps.italicConfig) || null, _emFam, _emW);
                var _emExact = null;
                try { _emExact = _FontItalicProbe.findExactItalicStyleName(workDoc, _emFam, _emW); } catch (eEmx) {}
                // 3rd arg = "this run is ALREADY on a real italic face". Here that is
                // `!!_emExact` ALONE only because the enclosing `if` already supplies the
                // other half — spelling it out, because "has italic intent" and "is on an
                // italic face" are NOT the same thing and conflating them would be a
                // silent drop (a run marked italic but sitting upright would be kept
                // unslanted AND unsurfaced):
                //   • guard: es.hasItalicIntent = _diffHasItalicIntent(er.diff) (:2500-2504)
                //     — the run's OWN captured fontStyle contains italic/oblique. This pool
                //     is built from SOURCE emphasis runs (er.diff, :1498-1512), i.e. real
                //     formatting read off the document, never a translator's mark. A run
                //     that is marked italic but sits on an upright face has no italic in
                //     its fontStyle, so it cannot enter this block at all.
                //   • _emExact: that weight's EXACT italic face is installed.
                // Both together = on a real italic face. If the style says italic but the
                // face is missing, _emExact is null → surface (upright, counted), which is
                // the correct outcome, not a keep.
                // Same composite as italic_apply.js:114 (`!!exactIt && _wasItalic`); there
                // the run's italic-ness must be tested inline because that leaf reads the
                // LIVE char and has no equivalent guard.
                // CJK gate, same reason as the chokepoint: keep must not fire for a
                // CJK family (see there). It also keeps __wantsItalic false for CJK,
                // so the BRIDGE-36 appliedFont lock below cannot newly pin CJK text
                // to the source-side Latin family.
                var _emIsCjk = false;
                try { _emIsCjk = !!(_isCJKFamilyName && _isCJKFamilyName(_emFam)); } catch (eEmCjk) {}
                var _emDec = _ItalicConfig.resolveItalicRealization(_emCfg, !!_emExact, !!_emExact && !_emIsCjk);
                var newSpec = {};
                for (var sk0 in spec) {
                    if (Object.prototype.hasOwnProperty.call(spec, sk0)) newSpec[sk0] = spec[sk0];
                }
                if (_emDec.kind === "faux") {
                    var weightOnly = _stripItalicFromFontStyle(newSpec.fontStyle);
                    if (weightOnly && weightOnly.toLowerCase() !== "regular") newSpec.fontStyle = weightOnly;
                    else newSpec.fontStyle = "Regular";   // re-audit P1: set explicit upright, NOT delete — a REUSED _T_c_emp_* style applies only present bulk keys, so deleting would leave a prior run's stale "Italic" face
                    newSpec.skew = _emDec.angle;     // config angle (was hardcoded 15)
                    spec = newSpec;
                    if (styleName.indexOf("_skew") < 0) styleName = styleName + "_skew";
                    skewFallbackCount++;
                } else if (_emDec.kind === "real" || _emDec.kind === "keep") {
                    if (_emExact) newSpec.fontStyle = _emExact;   // weight-exact installed italic face
                    newSpec.skew = 0;
                    // AC④': count a PRESERVED real italic. Without this the pool
                    // reports nothing for a run that moved from surface to keep, so
                    // "N real italic runs preserved" is unverifiable from the report.
                    if (_emDec.kind === "keep") empItalicKeptCount++;
                    spec = newSpec;
                } else {
                    // block (configured real, no weight-exact italic) OR surface
                    // (unconfigured) → upright weight + NO auto-slant (乙-strict).
                    // Non-silent via the cluster-report counter below.
                    var weightOnly2 = _stripItalicFromFontStyle(newSpec.fontStyle);
                    if (weightOnly2 && weightOnly2.toLowerCase() !== "regular") newSpec.fontStyle = weightOnly2;
                    else newSpec.fontStyle = "Regular";   // re-audit P1: set explicit upright, NOT delete — a REUSED _T_c_emp_* style applies only present bulk keys, so deleting would leave a prior run's stale "Italic" face
                    newSpec.skew = 0;
                    spec = newSpec;
                    empItalicSurfacedCount++;
                }
            }

            var esObj = null;
            try {
                var existingEs = workDoc.characterStyles.itemByName(styleName);
                if (existingEs && existingEs.isValid) esObj = existingEs;
            } catch (eExEs) {}
            if (!esObj) esObj = workDoc.characterStyles.add({ name: styleName });

            // appliedFont takes a font-name string in InDesign DOM. Set it
            // explicitly outside the bulk so it doesn't mangle the char
            // style's underlying Font reference. Same pattern as latin
            // style creation above.
            //
            // #BRIDGE-36: when a CS sets fontStyle="Italic" (or Bold Italic)
            // WITHOUT locking appliedFont, InDesign on doc open resolves
            // the style against each containing paragraph's default font.
            // If that default font is CJK (Source Han Sans, etc.) which
            // has no italic variant, InDesign registers e.g. "Source Han
            // Sans CN | Italic" as a doc-level font dependency — even
            // when NO characters actually apply the CS — and shows
            // "Missing Fonts" on open.
            //
            // Fix: when fontStyle is italic-flavored AND we know the
            // intended effective font (from emp pool's effectiveFont),
            // force appliedFont = effectiveFont. The CS now self-resolves
            // to "Dax Pro | Italic" (a real installed combo), no longer
            // inheriting from a CJK parent.
            //
            // The italic→skew fallback above ALREADY handled the case
            // where effectiveFont lacks italic (strip italic, add skew).
            // For the remaining case (effective font HAS italic, e.g.
            // Dax Pro), still lock appliedFont so the CS is self-contained.
            var __wantsItalic = false;
            try {
                // TODO#26 part 2: shared slant predicate (italic OR oblique). The old
                // inline `indexOf("italic")` missed "… Oblique" faces written by the
                // real/keep arm above, so exactly the BRIDGE-36 missing-font ghost this
                // lock exists for came back for oblique-faced families.
                __wantsItalic = _isSlantFontStyle(String(spec.fontStyle || ""));
            } catch (eWI) {}
            var __lockFamily = spec.appliedFontFamily ||
                (__wantsItalic ? (es.effectiveFont || "") : "");
            if (__lockFamily) {
                try { esObj.appliedFont = __lockFamily; } catch (eEsAF) {}
            }
            var bulkEs = {};
            for (var sk in spec) {
                if (!spec.hasOwnProperty(sk)) continue;
                if (sk === "fillColorSpec" || sk === "appliedFontFamily") continue;
                // #E2E-1 import side: resolve position string ("SUPERSCRIPT"
                // etc.) into the DOM Position enum constant. Setting the raw
                // string fails silently (InDesign DOM requires the enum).
                if (sk === "position" && deps && deps.position) {
                    var posStr = String(spec[sk] || "").toUpperCase();
                    var posEnum = deps.position[posStr];
                    if (posEnum) bulkEs.position = posEnum;
                    continue;
                }
                bulkEs[sk] = spec[sk];
            }
            try { esObj.properties = bulkEs; } catch (eEsProps) {}
            if (spec.fillColorSpec) {
                var empColor = _resolveFillColor(workDoc, spec.fillColorSpec, deps);
                if (empColor) { try { esObj.fillColor = empColor; } catch (eEFC) {} }
            }
            try { esObj.label = es.fingerprint; } catch (eEsL) {}
            empCharStyleMap[es.fingerprint] = esObj;
        } catch (eEs) {
            // Don't throw — emphasis style failures are non-blocking
            // (paragraph + latin styles are still in place).
        }
    }
    if (plan.clusterReport) plan.clusterReport.emp_italic_skew_fallback = skewFallbackCount;
    if (plan.clusterReport) plan.clusterReport.emp_italic_surfaced = empItalicSurfacedCount;   // 乙-strict block/surface (no auto-slant)
    // AC④': real italic faces PRESERVED (unconfigured + already on the face).
    // Reported so the claim is checkable from the report rather than by eye.
    if (plan.clusterReport) plan.clusterReport.emp_italic_kept = empItalicKeptCount;
    // [P1-C (a)] LOUD-surface bullet paragraphs whose ORIGINAL Latin font is NOT installed —
    // the • stays unrendered (NEVER substituted, per user ruling §9); operator installs the
    // font / remaps / accepts. Empty in the common case (e.g. placemat's Dax Pro IS installed).
    if (__ctPlog && plan.clusterReport && plan.clusterReport.bullet_font_surfaced && plan.clusterReport.bullet_font_surfaced.length) {
        try {
            __ctPlog("commit: BULLET-FONT MISSING (not substituted) on " + plan.clusterReport.bullet_font_surfaced.length +
                " style(s) — • will not render until installed/remapped: " +
                plan.clusterReport.bullet_font_surfaced.map(function (s) { return s.style + "→" + s.font + "|" + s.weight; }).join("; "));
        } catch (eBfL) {}
    }
    __ctMark("step25_emp_styles_done(" + empList.length + ")");

    // Step 3 [TODO#15 ① R1 audit chokepoint]: post-commit INVARIANT — sweep
    // every pipeline-managed `_T_*` style so its appliedFont is SYSTEM-installed
    // (not a legacy OT name InDesign would substitute to the wrong weight). This
    // closes the gaps the per-call-site normalization can't reach (CJK reverse
    // CS, emphasis CS, cluster psFont, stale `_T_Latin_*` orphans) in ONE place,
    // regardless of which path wrote the font.
    try {
        var __sweep = _sweepManagedStyleFonts(workDoc, (deps && deps.italicConfig) || null);
        if (plan.clusterReport) plan.clusterReport.managed_font_sweep = __sweep;
        if (__ctPlog) {
            try {
                __ctPlog("commit: font-sweep scanned=" + __sweep.scanned + " fixed=" + __sweep.fixed +
                    (__sweep.fixed ? " [" + __sweep.examples.join("; ") + "]" : ""));
            } catch (eSwL) {}
        }
    } catch (eSweep) {
        if (__ctPlog) { try { __ctPlog("commit: font-sweep ERROR " + eSweep.message); } catch (e2) {} }
    }
    __ctMark("step3_font_sweep_done");

    __ctMark("commit_exit");
    return {
        paraStyleMap: paraStyleMap,
        latinStyleMap: latinStyleMap,
        // #BRIDGE-28: CJK reverse-routing style map (Latin-base scriptByFont
        // clusters). Empty when no Latin-base cluster has CJK secondary.
        cjkStyleMap: cjkStyleMap,
        empCharStyleMap: empCharStyleMap,
        annotationCharStyleCache: {},   // populated lazily by ensureAnnotationCharStyle
        _commitTimings: __ct
    };
}

/**
 * Defensive wrapper: refuses to commit if preflight blocking is non-empty.
 */
function commitStylePlanGuarded(workDoc, plan, preflightReport, deps) {
    if (!preflightReport) {
        throw new Error("commitStylePlanGuarded: preflightReport required (use commitStylePlan if you really want to skip the check)");
    }
    if (preflightReport.blocking && preflightReport.blocking.length > 0) {
        throw new Error(
            "commitStylePlanGuarded: preflight has " + preflightReport.blocking.length +
            " blocking error(s); cannot commit. First: " +
            JSON.stringify(preflightReport.blocking[0])
        );
    }
    return commitStylePlan(workDoc, plan, deps);
}

// ─── Annotation char style JIT ────────────────────────────────────

/**
 * Get or create a _T_c_annotation_<action>_<value?> char style, cached on
 * sheet.annotationCharStyleCache. Called during Pass B when applying
 * translations.annotations[].
 *
 * @param {Document} workDoc
 * @param {Object} sheet — return value of commitStylePlan
 * @param {string} action — "bold" | "italic" | "underline" | "superscript" | "color"
 * @param {*} value — for "color": "#RRGGBB" hex; otherwise unused
 * @param {Object} deps — { colorSpace?, position? } enums (only needed for color/superscript)
 * @returns {CharacterStyle}
 */
function ensureAnnotationCharStyle(workDoc, sheet, action, value, deps) {
    if (!workDoc) throw new Error("ensureAnnotationCharStyle: workDoc required");
    if (!sheet || !sheet.annotationCharStyleCache) {
        throw new Error("ensureAnnotationCharStyle: sheet.annotationCharStyleCache required");
    }

    var cacheKey = action + (value !== undefined && value !== null ? "_" + String(value) : "");
    if (sheet.annotationCharStyleCache[cacheKey]) {
        return sheet.annotationCharStyleCache[cacheKey];
    }

    var name = "_T_c_annotation_" + _sanitize(cacheKey);
    var props = {};

    if (action === "bold") {
        props.fontStyle = "Bold";
    } else if (action === "italic") {
        // NotoSansSC has no italic; we still create the style (fontStyle="Italic"
        // will resolve to fallback). UI consistency over visual. See faux italic
        // follow-up in plan 7.7.
        props.fontStyle = "Italic";
    } else if (action === "underline") {
        // #35 underline annotation. InDesign character-style underline is a
        // bool toggle (Boolean). Default underline weight/offset/color come
        // from the paragraph style — translator can't yet customize these
        // from the webapp.
        props.underline = true;
    } else if (action === "superscript") {
        if (deps && deps.position) {
            props.position = deps.position.SUPERSCRIPT;
        }
    } else if (action === "color") {
        // Resolve color: try existing swatch first, then create
        if (value && deps && deps.colorSpace) {
            var existing = null;
            try { existing = workDoc.swatches.itemByName(value); } catch (eSw) {}
            if (existing && existing.isValid) {
                props.fillColor = existing;
            } else {
                // Create RGB color from hex
                var hex = String(value).replace(/^#/, "");
                if (hex.length === 6) {
                    var r = parseInt(hex.substring(0, 2), 16);
                    var g = parseInt(hex.substring(2, 4), 16);
                    var b = parseInt(hex.substring(4, 6), 16);
                    try {
                        var newColor = workDoc.colors.add({
                            name: "_T_c_color_" + hex,
                            space: deps.colorSpace.RGB,
                            colorValue: [r, g, b]
                        });
                        props.fillColor = newColor;
                    } catch (eC) {}
                }
            }
        }
    }

    // #BRIDGE-22: cross-run idempotency. The annotationCharStyleCache
    // only lives for the current sheet/run. If the doc already has a
    // _T_c_annotation_<cacheKey> style from an earlier run (or from
    // partial cleanup), `characterStyles.add({ name })` throws on
    // duplicate name. Try add first; on duplicate-name failure, look
    // up the existing style by name and refresh its properties.
    // Mirrors the pattern used by commitStylePlan for paragraph and
    // latin pool styles.
    try {
        var styleObj = null;
        try { styleObj = workDoc.characterStyles.add({ name: name }); }
        catch (eAdd) {
            try { styleObj = workDoc.characterStyles.itemByName(name); }
            catch (eN) {
                throw new Error("add+itemByName both failed: " + (eAdd && eAdd.message ? eAdd.message : eAdd));
            }
            if (!styleObj) throw new Error("itemByName returned null after add failure");
        }
        try { styleObj.properties = props; } catch (e) {}
        sheet.annotationCharStyleCache[cacheKey] = styleObj;
        return styleObj;
    } catch (e) {
        throw new Error("ensureAnnotationCharStyle: failed to create '" + name + "': " + e.message);
    }
}

// ─── Module exports ────────────────────────────────────────────────

module.exports = {
    DEFAULT_TOLERANCE: DEFAULT_TOLERANCE,
    GREP_LATIN_PATTERN: GREP_LATIN_PATTERN,
    GREP_CJK_PATTERN: GREP_CJK_PATTERN,
    NEUTRAL_PUNCT_CLASS: NEUTRAL_PUNCT_CLASS,
    fingerprintParagraph: fingerprintParagraph,
    fingerprintRun: fingerprintRun,
    buildStylePlan: buildStylePlan,
    commitStylePlan: commitStylePlan,
    commitStylePlanGuarded: commitStylePlanGuarded,
    ensureAnnotationCharStyle: ensureAnnotationCharStyle,
    _internal: {
        _isCJKFont: _isCJKFont,
        _isFontInstalled: _isFontInstalled,
        _isSystemFontInstalled: _isSystemFontInstalled,
        _resolveInstalledFontName: _resolveInstalledFontName,
        // emphasis→combined-char-style refactor (SPEC §12.5/§13.3/§14.1):
        // additive exports the new applyEmphasisRunsAsCharStyles helper needs.
        // Zero regression — pure read-only additions to the existing namespace.
        _empPropsSpec: _empPropsSpec,
        _empDescriptor: _empDescriptor,
        _resolveLatinFontForCluster: _resolveLatinFontForCluster,
        _writeStyleFontNormalized: _writeStyleFontNormalized,
        _writeStyleFontTabName: _writeStyleFontTabName,
        _sweepManagedStyleFonts: _sweepManagedStyleFonts,
        _readStyleFont: _readStyleFont,
        _rankWeight: _rankWeight,
        _stripItalicForWeightOnly: _stripItalicForWeightOnly,
        _stripSlantToWeight: _stripSlantToWeight,          // TODO#26 (test-only reader)
        _stripItalicFromFontStyle: _stripItalicFromFontStyle,   // TODO#26 (test-only reader)
        _isSlantFontStyle: _isSlantFontStyle,              // TODO#26 part 2 (test-only reader)
        _diffHasItalicIntent: _diffHasItalicIntent,        // TODO#26 part 2 (test-only reader)
        _CANDIDATE_WEIGHTS: _CANDIDATE_WEIGHTS,
        _round: _round,
        _roundTol: _roundTol,
        _shortHash: _shortHash,
        _sanitize: _sanitize,
        _colorKey: _colorKey,
        _resolveJustification: _resolveJustification,
        _resolveFillColor: _resolveFillColor,
        _resolveLeading: _resolveLeading,
        _resolveListType: _resolveListType,
        _applyBulletsSpec: _applyBulletsSpec,
        _applyTabStops: _applyTabStops,
        _tabStopsKey: _tabStopsKey,
        _resolveTabAlignment: _resolveTabAlignment,
        _ensureBulletCharStyle: _ensureBulletCharStyle,
        // G→r7 PIN (8D-ext-G operator #7): additive export so apply_brand_style_preset
        // can reuse the SINGLE rule-round-trip writer (all ~13 fields + enable-first
        // ordering + Text Color sentinel handling). NOT relocated — every existing
        // commitStylePlan call site is untouched → zero regression (task_plan.md:2642).
        _applyRuleSpec: _applyRuleSpec
    }
};
