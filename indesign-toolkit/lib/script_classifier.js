"use strict";

// lib/script_classifier.js — Unicode codepoint → script classification.
//
// Purpose: detect "script-by-font" patterns — paragraphs where designers used
// direct character-level font overrides to assign one font per language/script
// (CJK chars in CJK font, Latin chars in Latin font), instead of using GREP
// rules. Phase 8A converts these into segment-style + GREP rules.
//
// Scope (MVP): CJK + Latin + helper scripts (Numeric, Punct, Whitespace).
// Cyrillic / Hangul / Thai / Arabic are recognized as separate MAIN scripts
// but no GREP-rule routing is generated for them yet — they fall back to
// per-run emphasis char styles in Phase 8B.

// Main scripts: each maps to a distinct font and gets its own GREP rule.
// A paragraph's runs that ONLY hit main scripts (after dropping shared chars)
// can be reduced to a script-by-font pattern.
var MAIN = {
    CJK:      "CJK",
    LATIN:    "LATIN",
    CYRILLIC: "CYRILLIC",
    HANGUL:   "HANGUL",
    THAI:     "THAI",
    ARABIC:   "ARABIC"
};

// Shared scripts: chars in these categories belong to ANY surrounding main
// script (typography conventions vary by locale). They don't participate in
// the font-script disjointness test — a font that covers Latin + Numeric +
// Punct still counts as "Latin only" for detection purposes.
var SHARED = {
    NUMERIC:    "NUMERIC",
    PUNCT:      "PUNCT",
    WHITESPACE: "WHITESPACE",
    OTHER:      "OTHER"            // unclassified — also treated as shared
};

// SET of main script names — used by callers to filter run.script_set
var MAIN_SCRIPT_SET = {};
for (var __k in MAIN) {
    if (Object.prototype.hasOwnProperty.call(MAIN, __k)) MAIN_SCRIPT_SET[MAIN[__k]] = true;
}
// SET of shared script names
var SHARED_SCRIPT_SET = {};
for (var __k2 in SHARED) {
    if (Object.prototype.hasOwnProperty.call(SHARED, __k2)) SHARED_SCRIPT_SET[SHARED[__k2]] = true;
}

// GREP expression per main script (Phase 8A uses these to route chars in
// the InDesign paragraph style's nestedGrepStyles). Each pattern matches
// runs of chars in that script; numeric/punct/whitespace are intentionally
// EXCLUDED so they inherit the paragraph default font (typical layout
// convention — full-width period in CJK paragraphs follows the CJK font).
//
// ⚠ These GREP_PATTERNS are for Phase-8A script-by-font DETECTION only. They are
// NOT the routing patterns written into cluster paragraph styles — that is
// lib/style_sheet_builder.js GREP_LATIN_PATTERN / GREP_CJK_PATTERN, which are the
// SOLE producers of the `_T_Latin_*` / `_T_CJK_*` nested-GREP rules. GREP_PATTERNS
// has ZERO routing consumers (vestigial for that purpose). Do NOT "re-sync" this
// LATIN entry with the builder's pattern: this one is a letter-only DETECTION
// classifier and the builder's now context-joins neutral punctuation (curly
// quotes/dashes flanked by letters) — they legitimately differ. Injecting the
// neutral-join here would perturb 8A disjointness/coverage. (Drift closed per
// findings 4类#3: they were never the same set; the old "same ranges" note was wrong.)
var GREP_PATTERNS = {
    LATIN:    "[\\x{0041}-\\x{005A}\\x{0061}-\\x{007A}\\x{00C0}-\\x{024F}]+",
    CJK:      "[\\x{4E00}-\\x{9FFF}\\x{3400}-\\x{4DBF}\\x{F900}-\\x{FAFF}]+",
    CYRILLIC: "[\\x{0400}-\\x{04FF}\\x{0500}-\\x{052F}]+",
    HANGUL:   "[\\x{AC00}-\\x{D7AF}\\x{1100}-\\x{11FF}\\x{3130}-\\x{318F}]+",
    THAI:     "[\\x{0E00}-\\x{0E7F}]+",
    ARABIC:   "[\\x{0600}-\\x{06FF}\\x{0750}-\\x{077F}]+"
};

/**
 * Classify a single Unicode codepoint into one of MAIN or SHARED categories.
 * Order of checks matters — most specific first (e.g. CJK kanji before
 * generic "OTHER"). Whitespace and ASCII-range punctuation handled before
 * the broader Unicode ranges so they reliably land in SHARED.
 *
 * @param {number} cp — codepoint (0..0x10FFFF)
 * @returns {string} one of MAIN.* or SHARED.*
 */
function classifyCodepoint(cp) {
    if (cp === undefined || cp === null || isNaN(cp)) return SHARED.OTHER;

    // Whitespace (must come before punct since 0x20 is space)
    if (cp === 0x09 || cp === 0x0A || cp === 0x0B || cp === 0x0C || cp === 0x0D ||
        cp === 0x20 || cp === 0xA0 || (cp >= 0x2000 && cp <= 0x200B) ||
        cp === 0x3000) {
        return SHARED.WHITESPACE;
    }

    // Numeric (ASCII + fullwidth + Arabic-Indic)
    if ((cp >= 0x30 && cp <= 0x39) ||           // 0-9
        (cp >= 0xFF10 && cp <= 0xFF19) ||       // fullwidth 0-9
        (cp >= 0x0660 && cp <= 0x0669) ||       // Arabic-Indic
        (cp >= 0x06F0 && cp <= 0x06F9)) {       // extended Arabic-Indic
        return SHARED.NUMERIC;
    }

    // Punctuation: ASCII punct + general punctuation + CJK symbols and punct +
    // halfwidth/fullwidth forms (excludes the digit ranges above)
    if ((cp >= 0x21 && cp <= 0x2F) ||           // ! " # $ % & ' ( ) * + , - . /
        (cp >= 0x3A && cp <= 0x40) ||           // : ; < = > ? @
        (cp >= 0x5B && cp <= 0x60) ||           // [ \ ] ^ _ `
        (cp >= 0x7B && cp <= 0x7E) ||           // { | } ~
        (cp >= 0x2000 && cp <= 0x206F) ||       // general punctuation (en/em dash, quotes, etc.)
        (cp >= 0x3000 && cp <= 0x303F) ||       // CJK symbols & punct (full-width comma/period etc.)
        (cp >= 0xFF00 && cp <= 0xFF0F) ||       // fullwidth punct (excluding digits/letters)
        (cp >= 0xFF1A && cp <= 0xFF20) ||       // more fullwidth punct
        (cp >= 0xFF3B && cp <= 0xFF40) ||
        (cp >= 0xFF5B && cp <= 0xFF65) ||
        (cp >= 0x2010 && cp <= 0x2027)) {       // hyphens, dashes, ellipsis
        return SHARED.PUNCT;
    }

    // CJK (Han ideographs, kana, halfwidth kana, CJK extensions)
    if ((cp >= 0x4E00 && cp <= 0x9FFF) ||       // CJK Unified Ideographs
        (cp >= 0x3400 && cp <= 0x4DBF) ||       // CJK Extension A
        (cp >= 0x20000 && cp <= 0x2A6DF) ||     // CJK Extension B
        (cp >= 0xF900 && cp <= 0xFAFF) ||       // CJK Compatibility Ideographs
        (cp >= 0x3040 && cp <= 0x309F) ||       // Hiragana
        (cp >= 0x30A0 && cp <= 0x30FF) ||       // Katakana
        (cp >= 0xFF66 && cp <= 0xFF9D)) {       // halfwidth Katakana
        return MAIN.CJK;
    }

    // Hangul (Korean)
    if ((cp >= 0xAC00 && cp <= 0xD7AF) ||       // Hangul Syllables
        (cp >= 0x1100 && cp <= 0x11FF) ||       // Hangul Jamo
        (cp >= 0x3130 && cp <= 0x318F) ||       // Hangul Compatibility Jamo
        (cp >= 0xA960 && cp <= 0xA97F) ||       // Hangul Jamo Extended-A
        (cp >= 0xD7B0 && cp <= 0xD7FF)) {       // Hangul Jamo Extended-B
        return MAIN.HANGUL;
    }

    // Cyrillic
    if ((cp >= 0x0400 && cp <= 0x04FF) ||
        (cp >= 0x0500 && cp <= 0x052F) ||
        (cp >= 0x2DE0 && cp <= 0x2DFF) ||
        (cp >= 0xA640 && cp <= 0xA69F)) {
        return MAIN.CYRILLIC;
    }

    // Arabic
    if ((cp >= 0x0600 && cp <= 0x06FF) ||
        (cp >= 0x0750 && cp <= 0x077F) ||
        (cp >= 0x08A0 && cp <= 0x08FF) ||
        (cp >= 0xFB50 && cp <= 0xFDFF) ||
        (cp >= 0xFE70 && cp <= 0xFEFF)) {
        return MAIN.ARABIC;
    }

    // Thai
    if (cp >= 0x0E00 && cp <= 0x0E7F) {
        return MAIN.THAI;
    }

    // Latin (ASCII letters + Latin-1 supplement + extended A/B)
    if ((cp >= 0x41 && cp <= 0x5A) ||           // A-Z
        (cp >= 0x61 && cp <= 0x7A) ||           // a-z
        (cp >= 0x00C0 && cp <= 0x024F) ||       // Latin Extended A/B / Latin-1 supplement letters
        (cp >= 0x1E00 && cp <= 0x1EFF)) {       // Latin Extended Additional
        return MAIN.LATIN;
    }

    return SHARED.OTHER;
}

/**
 * Classify a string into the SET of MAIN scripts that appear in it.
 * Shared scripts (Numeric/Punct/Whitespace/Other) are EXCLUDED from the
 * returned set — script-by-font detection only cares about main-script
 * coverage.
 *
 * @param {string} text
 * @returns {Object} { CJK: true, LATIN: true, ... } — entries only for main
 *   scripts that appear in `text`. Empty object if the string contains only
 *   shared chars (or is empty).
 */
function getMainScriptSet(text) {
    var set = {};
    if (!text || typeof text !== "string") return set;
    for (var i = 0; i < text.length; i++) {
        var cp = text.charCodeAt(i);
        // Handle surrogate pairs for CJK Extension B+ (rare in practice)
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < text.length) {
            var low = text.charCodeAt(i + 1);
            if (low >= 0xDC00 && low <= 0xDFFF) {
                cp = ((cp - 0xD800) << 10) + (low - 0xDC00) + 0x10000;
                i++;
            }
        }
        var script = classifyCodepoint(cp);
        if (Object.prototype.hasOwnProperty.call(MAIN_SCRIPT_SET, script)) {
            set[script] = true;
        }
    }
    return set;
}

/**
 * Detect whether a paragraph's run set forms a "script-by-font" pattern:
 * each font covers a disjoint MAIN script (after dropping shared chars).
 *
 * @param {Array} runsWithText — [{ fontFamily, fontStyle, text }, ...]
 *   Each entry must have the font + the text covered by that run.
 *   Pass ALL runs of the paragraph (including the baseline/default-font run).
 *
 * @returns {Object|null} on detection:
 *   {
 *     baseScript: "CJK",                         // dominant script (most chars)
 *     baseFont: { fontFamily, fontStyle },       // font of the dominant script
 *     scriptToFont: {                             // every detected script → its font
 *       CJK:   { fontFamily, fontStyle },
 *       LATIN: { fontFamily, fontStyle }
 *     },
 *     coverage: { CJK: 42, LATIN: 13 }            // char counts per main script
 *   }
 *   Returns null when:
 *     - all runs share the same font (uniform — caller doesn't need 8A)
 *     - any two fonts overlap on the same MAIN script (within-script font
 *       switch — falls back to Phase 8B emphasis)
 *     - no MAIN scripts present (shared-only content; no font policy needed)
 *     - any run has 0 main-script chars (likely a "decorative" font run that
 *       only has punct — ambiguous, conservative skip)
 */
function detectScriptByFontPattern(runsWithText) {
    if (!runsWithText || !runsWithText.length) return null;

    // Step 1: per font, accumulate scripts + char counts (after dropping shared)
    var fontKey = function (r) {
        return (r.fontFamily || "?") + "||" + (r.fontStyle || "Regular");
    };
    var fontInfo = {};   // key → { fontFamily, fontStyle, scripts: {...}, coverage: {...} }
    var fontKeys = [];
    var seenFontKeys = {};

    for (var i = 0; i < runsWithText.length; i++) {
        var r = runsWithText[i];
        if (!r || !r.text) continue;
        var k = fontKey(r);
        if (!seenFontKeys[k]) {
            seenFontKeys[k] = true;
            fontKeys.push(k);
            fontInfo[k] = {
                fontFamily: r.fontFamily,
                fontStyle: r.fontStyle || "Regular",
                scripts: {},      // main scripts seen in this font's runs
                coverage: {}      // char counts per script (main only)
            };
        }
        var info = fontInfo[k];
        var text = r.text;
        for (var ci = 0; ci < text.length; ci++) {
            var cp = text.charCodeAt(ci);
            if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < text.length) {
                var low2 = text.charCodeAt(ci + 1);
                if (low2 >= 0xDC00 && low2 <= 0xDFFF) {
                    cp = ((cp - 0xD800) << 10) + (low2 - 0xDC00) + 0x10000;
                    ci++;
                }
            }
            var s = classifyCodepoint(cp);
            if (Object.prototype.hasOwnProperty.call(MAIN_SCRIPT_SET, s)) {
                info.scripts[s] = true;
                info.coverage[s] = (info.coverage[s] || 0) + 1;
            }
        }
    }

    // Step 2: trivial cases
    if (fontKeys.length < 2) return null;     // uniform font — caller doesn't need 8A

    // Step 3: every font must have at least one main script
    // (a font run that's all punct/whitespace is ambiguous — skip)
    for (var fi = 0; fi < fontKeys.length; fi++) {
        var f = fontInfo[fontKeys[fi]];
        var hasMain = false;
        for (var sn in f.scripts) {
            if (Object.prototype.hasOwnProperty.call(f.scripts, sn)) { hasMain = true; break; }
        }
        if (!hasMain) return null;
    }

    // Step 4: every script must be covered by EXACTLY ONE font (disjointness).
    // If two fonts both cover MAIN.LATIN, this is within-script font switching
    // and belongs to Phase 8B emphasis (different Latin fonts as emphasis).
    var scriptToFont = {};      // script → fontKey
    var totalCoverage = {};     // script → char count summed across fonts (==same as winner since disjoint)
    for (var fi2 = 0; fi2 < fontKeys.length; fi2++) {
        var fk = fontKeys[fi2];
        var info2 = fontInfo[fk];
        for (var s2 in info2.scripts) {
            if (!Object.prototype.hasOwnProperty.call(info2.scripts, s2)) continue;
            if (scriptToFont[s2] && scriptToFont[s2] !== fk) {
                return null;    // collision — two fonts cover same main script
            }
            scriptToFont[s2] = fk;
            totalCoverage[s2] = (totalCoverage[s2] || 0) + info2.coverage[s2];
        }
    }

    // Step 5: pick base script = the one with the most chars; tie → first
    // appearing in run order (preserves designer intent for ambiguous cases).
    // We iterate fontKeys (stable run-order) and within each, iterate the
    // font's own scripts (stable insertion order in the map).
    var baseScript = null, baseCount = -1;
    for (var fi3 = 0; fi3 < fontKeys.length; fi3++) {
        var info3 = fontInfo[fontKeys[fi3]];
        for (var s3 in info3.scripts) {
            if (!Object.prototype.hasOwnProperty.call(info3.scripts, s3)) continue;
            var c = totalCoverage[s3];
            if (c > baseCount) {
                baseCount = c;
                baseScript = s3;
            }
        }
    }
    if (!baseScript) return null;

    // Step 6: build result
    var scriptToFontResult = {};
    for (var s4 in scriptToFont) {
        if (!Object.prototype.hasOwnProperty.call(scriptToFont, s4)) continue;
        var fInfo = fontInfo[scriptToFont[s4]];
        scriptToFontResult[s4] = {
            fontFamily: fInfo.fontFamily,
            fontStyle: fInfo.fontStyle
        };
    }
    var baseFont = scriptToFontResult[baseScript];

    return {
        baseScript: baseScript,
        baseFont: baseFont,
        scriptToFont: scriptToFontResult,
        coverage: totalCoverage
    };
}

/**
 * Phase 8A pass — for each segment with `uniform === false` and `_allRanges`
 * (full per-range breakdown emitted by visual_snapshot.captureFormatSnapshot
 * in mixed-format paragraphs), attempt script-by-font detection. On success:
 *   - mutate `seg.format_snapshot` to be effectively uniform with baseline
 *     overridden to the dominant-script font
 *   - record `seg.format_snapshot.scriptByFont` = detection result so
 *     downstream (style_sheet_builder Pass 3/4) can route non-base scripts
 *     to GREP rules
 *   - clear `_allRanges` (transient field, not needed downstream)
 *   - clear legacy `runs[]` (cluster handling treats segment as uniform)
 *
 * On failure: leave segment unchanged (uniform=false flow handles it via
 * Phase 8B emphasis char styles or the existing skip-cascade-normalize
 * preservation).
 *
 * Caller responsibility: invoke between capture and buildStylePlan.
 *
 * @param {Array} segments
 * @returns {Object} { detected: int, skipped: int, ids: [tid, ...] } stats
 */
// "Pure" script-by-font means: runs differ ONLY on font (and the
// fontStyle component that's tied to that font, which we treat as
// part of the font identity). If any run has a secondary emphasis on
// underline / strikeThrough / pointSize / fillColor / baselineShift /
// tracking / horizontal-or-vertical scale / skew, the paragraph is
// "two-layer" (script-by-font + emphasis) and 8B must handle it
// instead — otherwise the emphasis info gets lost when 8A folds the
// snapshot to uniform=true.
function _hasSecondaryEmphasis(allRanges) {
    if (!allRanges || allRanges.length < 2) return false;
    function key(r) {
        var p = (r && r.props) || {};
        var fc = p.fillColor;
        var fcKey = "_";
        if (fc) {
            if (fc.swatch) fcKey = "S:" + fc.swatch;
            else if (fc.values && fc.values.length) fcKey = "V:" + (fc.space || "?") + ":" + fc.values.join(",");
        }
        return [
            !!p.underline,
            !!p.strikeThrough,
            (p.pointSize == null ? p.fontSize : p.pointSize) || 0,
            fcKey,
            Number(p.baseline_shift || 0),
            Number(p.tracking || 0),
            Number(p.horizontal_scale || 100),
            Number(p.vertical_scale   || 100),
            Number(p.skew || 0)
        ].join("|");
    }
    var first = key(allRanges[0]);
    for (var i = 1; i < allRanges.length; i++) {
        if (key(allRanges[i]) !== first) return true;
    }
    return false;
}

function applyScriptByFontDetection(segments) {
    var stats = { detected: 0, skipped: 0, deferredToEmphasis: 0, ids: [] };
    if (!segments) return stats;
    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (!seg || !seg.format_snapshot) continue;
        var fs = seg.format_snapshot;
        if (fs.uniform !== false) continue;            // already uniform
        if (!fs._allRanges || !fs._allRanges.length) continue;
        var detect = detectScriptByFontPattern(fs._allRanges);
        if (!detect) {
            stats.skipped++;
            continue;
        }
        // Two-layer guard — pure scriptByFont folds to uniform; mixed-layer
        // (scriptByFont + emphasis) defers so 8B can extract the secondary
        // dimensions (underline/italic-via-fontStyle/color/size/...). This
        // avoids losing F10-style emphasis when CJK terms are underlined and
        // a Latin term is italic inside a CJK paragraph.
        if (_hasSecondaryEmphasis(fs._allRanges)) {
            stats.deferredToEmphasis++;
            continue;
        }
        // #BRIDGE-28: fold both CJK-base AND Latin-base script-by-font
        // segments. The original guard rejected Latin-base because the
        // downstream cluster builder lacked a reverse routing template
        // (no CJK GREP). With cjkPool + cjkGrepRule added in
        // style_sheet_builder, the Latin-base case is now symmetric:
        // baseline becomes Latin font (intentional — most-chars-wins
        // confirms it's the paragraph's primary script), and a CJK GREP
        // rule routes the embedded CJK chars to a `_T_CJK_*` CS so they
        // retain their CJK font instead of inheriting the Latin
        // paragraph default (which would substitute / tofu).
        //
        // Other scripts (HANGUL / THAI / CYRILLIC / ARABIC) still defer
        // to emphasis_extractor — GREP_PATTERNS has them defined but
        // cluster builder doesn't yet emit pools for them.
        if (detect.baseScript !== MAIN.CJK && detect.baseScript !== MAIN.LATIN) {
            stats.deferredToEmphasis++;
            continue;
        }
        // For Latin-base, only fold when there's at least one CJK
        // secondary font — otherwise we have no reverse-routing target.
        if (detect.baseScript === MAIN.LATIN && !detect.scriptToFont[MAIN.CJK]) {
            stats.deferredToEmphasis++;
            continue;
        }
        if (fs.baseline) {
            fs.baseline.fontFamily = detect.baseFont.fontFamily;
            fs.baseline.fontStyle  = detect.baseFont.fontStyle || "Regular";
        }
        fs.uniform = true;
        fs.runs = [];
        fs.scriptByFont = detect;
        delete fs._allRanges;
        stats.detected++;
        if (seg.tid) stats.ids.push(seg.tid);
    }
    return stats;
}

module.exports = {
    MAIN: MAIN,
    SHARED: SHARED,
    MAIN_SCRIPT_SET: MAIN_SCRIPT_SET,
    SHARED_SCRIPT_SET: SHARED_SCRIPT_SET,
    GREP_PATTERNS: GREP_PATTERNS,
    classifyCodepoint: classifyCodepoint,
    getMainScriptSet: getMainScriptSet,
    detectScriptByFontPattern: detectScriptByFontPattern,
    applyScriptByFontDetection: applyScriptByFontDetection
};
