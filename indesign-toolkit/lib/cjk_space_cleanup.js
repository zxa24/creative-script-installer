"use strict";

// cjk_space_cleanup.js
// PURE predicates + GREP-pattern builders for removing errant ASCII spaces at
// the boundary between a half-width ASCII symbol and a full-width CJK
// punctuation mark (TODO #20).
//
// WHY a separate pure module (no `require("indesign")`): text_cleanup.js pulls
// in the host `indesign` module at load, so it can't be required in the
// non-host `npm test` harness. Mirroring lib/cjk_field_check.js, the character
// -class decision lives here as pure JS so it is unit-testable, and the host
// findGrep path in text_cleanup.js derives its GREP classes from the SAME
// constants below (single source → the pattern and the predicate cannot drift).
//
// SCOPE (deliberately narrow, to prevent over-deletion — see the plan-audit):
//   Remove a single U+0020 space ONLY when it sits between
//     (half-width symbol) ␣ (full-width punctuation)   e.g. ")␣、" -> ")、"
//   or the reverse
//     (full-width punctuation) ␣ (half-width symbol)   e.g. "、␣(" -> "、("
//   NOTHING else. In particular this module never touches:
//     - "汉字 ␣ 英文词" (ideograph↔ASCII-alnum) — already handled by
//       removeCjkAsciiSpaces in text_cleanup.js; left/right here are never alnum.
//     - "字 ␣ 、"       (ideograph↔full-punct) — out of the "半角符号↔全角标点" scope.
//     - "投资/银行"      (no space at all) — user chose to leave "/" at line-head.
//     - the ideographic space U+3000 — only the raw ASCII space U+0020 is removed.

// ── Half-width ASCII symbol set ──────────────────────────────────────────────
// Actual characters (unescaped). Mirrors SYMBOL_GREP in text_cleanup.js. Kept as
// a plain char string here so the predicate and the GREP class both derive from
// this one constant.
var HALF_SYMBOL_CHARS = "(){},:!?.+=%@#$[]&*/<>|~^_`'\"\\-";

// ── Full-width CJK punctuation set ───────────────────────────────────────────
// Single source: inclusive code-point ranges. Both isFullWidthPunct() and the
// GREP class are derived from this list.
//   3001..3002  、。
//   3008..3011  〈〉《》「」『』【】        (angle / double-angle / corner / lenticular brackets)
//   3014..301F  〔〕〖〗〘〙〚〛〜〝〞〟      (tortoise/white brackets, wave dash, quote marks)
//   30FB        ・  (katakana middle dot)
//   FF01..FF0F  ！＂＃＄％＆＇（）＊＋，－．／
//   FF1A..FF20  ：；＜＝＞？＠
//   FF3B..FF40  ［＼］＾＿｀
//   FF5B..FF5E  ｛｜｝～
// The 3008..3011 + 3014..301F SPLIT deliberately skips U+3012 〒 (POSTAL MARK) and
// U+3013 〓 (GETA MARK): those two are Unicode category So (symbols), not the brackets
// this range is for, so leaving them in would strip the space in ") 〒" (codex-audit
// over-inclusion finding, 2026-07-01).
// The FF-forms ranges intentionally retain the full-width symbol-operators they span
// (＄＋＜＝＞＾｀｜～): those are full-width glyphs that never occur in Latin text, so
// cleaning a stray space around them carries no over-deletion risk — unlike the
// General-Punctuation dual-use marks (curly quotes " " ' ' / em-dash — / ellipsis …)
// which are deliberately NOT included: they DO occur in Latin and would over-delete
// legitimate mixed-content spacing such as English  "hello" (loudly)  ->  "hello"(loudly).
// Deliberately EXCLUDED: FF10..FF19 (full-width digits), FF21..FF3A / FF41..FF5A
// (full-width Latin letters), and U+3000 (ideographic space).
var FULLWIDTH_PUNCT_RANGES = [
    [0x3001, 0x3002],
    [0x3008, 0x3011],
    [0x3014, 0x301F],
    [0x30FB, 0x30FB],
    [0xFF01, 0xFF0F],
    [0xFF1A, 0xFF20],
    [0xFF3B, 0xFF40],
    [0xFF5B, 0xFF5E]
];

// ── GREP class builders (derive from the constants above) ────────────────────
function escapeForGrepClass(ch) {
    // Inside a GREP character class, backslash / ] / [ / ^ / - are special.
    if (ch === "\\" || ch === "]" || ch === "[" || ch === "^" || ch === "-") {
        return "\\" + ch;
    }
    return ch;
}

function halfSymbolGrepBody() {
    var out = "";
    for (var i = 0; i < HALF_SYMBOL_CHARS.length; i++) {
        out += escapeForGrepClass(HALF_SYMBOL_CHARS.charAt(i));
    }
    return out;
}

function hex4(cp) {
    var s = cp.toString(16).toUpperCase();
    while (s.length < 4) { s = "0" + s; }
    return "\\x{" + s + "}";
}

function fullPunctGrepBody() {
    var out = "";
    for (var i = 0; i < FULLWIDTH_PUNCT_RANGES.length; i++) {
        var lo = FULLWIDTH_PUNCT_RANGES[i][0];
        var hi = FULLWIDTH_PUNCT_RANGES[i][1];
        out += (lo === hi) ? hex4(lo) : (hex4(lo) + "-" + hex4(hi));
    }
    return out;
}

var HALF_SYMBOL_GREP = "[" + halfSymbolGrepBody() + "]";
var FULLWIDTH_PUNCT_GREP = "[" + fullPunctGrepBody() + "]";

// Each pattern matches exactly 3 characters: [left][space][right].
var BOUNDARY_SPACE_PATTERNS = [
    HALF_SYMBOL_GREP + " " + FULLWIDTH_PUNCT_GREP,
    FULLWIDTH_PUNCT_GREP + " " + HALF_SYMBOL_GREP
];

// ── Pure predicates (the enforced spec; unit-tested) ─────────────────────────
function isHalfWidthSymbol(ch) {
    return typeof ch === "string" && ch.length === 1 && HALF_SYMBOL_CHARS.indexOf(ch) >= 0;
}

function isFullWidthPunct(ch) {
    if (typeof ch !== "string" || ch.length !== 1) { return false; }
    var cp = ch.charCodeAt(0);
    for (var i = 0; i < FULLWIDTH_PUNCT_RANGES.length; i++) {
        if (cp >= FULLWIDTH_PUNCT_RANGES[i][0] && cp <= FULLWIDTH_PUNCT_RANGES[i][1]) {
            return true;
        }
    }
    return false;
}

// Given the three characters [left][mid][right], decide whether the mid space
// should be removed. Only a raw ASCII space (U+0020) between a half-width symbol
// and a full-width punctuation (either order) qualifies.
function shouldRemoveBoundarySpace(left, mid, right) {
    if (mid !== " ") { return false; }
    return (isHalfWidthSymbol(left) && isFullWidthPunct(right)) ||
           (isFullWidthPunct(left) && isHalfWidthSymbol(right));
}

module.exports = {
    HALF_SYMBOL_CHARS: HALF_SYMBOL_CHARS,
    FULLWIDTH_PUNCT_RANGES: FULLWIDTH_PUNCT_RANGES,
    HALF_SYMBOL_GREP: HALF_SYMBOL_GREP,
    FULLWIDTH_PUNCT_GREP: FULLWIDTH_PUNCT_GREP,
    BOUNDARY_SPACE_PATTERNS: BOUNDARY_SPACE_PATTERNS,
    isHalfWidthSymbol: isHalfWidthSymbol,
    isFullWidthPunct: isFullWidthPunct,
    shouldRemoveBoundarySpace: shouldRemoveBoundarySpace
};
