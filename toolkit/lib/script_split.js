"use strict";

/**
 * lib/script_split.js — Phase 8D-ext-SA pure script-run splitter.
 *
 * Pure, Node-testable, ZERO host/InDesign deps (kept a leaf so the apply
 * executor can require it and the host side only does `range.appliedFont`
 * writes — task_plan 8D-ext-SA build-note #1).
 *
 * splitRunsByScript(contents) -> [{ startOffset, len, isCJK }] — contiguous
 * binary runs over the string. Offsets/len are in JS UTF-16 code units,
 * which align 1:1 with InDesign character indices for the Basic-Multilingual-
 * Plane text this pipeline handles (the _isCJKChar class below is BMP-only;
 * supplementary-plane chars classify as non-CJK and are left untouched).
 *
 * _isCJKChar — binary classifier (8D-ext-SA build-note #3). COPIED VERBATIM
 * from lib/script_font_enforcer.js _isCJKChar (its line ~48) so the sweep and
 * the post-apply enforcer agree on what "CJK" means. The two are pinned
 * together by an agreement assertion in tests/script_split_tests.js — if you
 * touch one regex, that test fails until both match. CJK = Han, Hiragana,
 * Katakana, Hangul, CJK symbols/punctuation, halfwidth/fullwidth forms
 * (U+FF00-FFEF — so FULLWIDTH digits/punct count as CJK; HALFWIDTH ASCII
 * digits/punct do NOT and stay on the source font).
 */

// The class is written in \uXXXX ESCAPES on purpose — do NOT put literal
// CJK characters back. It used to hold the literal for U+F900, whose NFD
// decomposition is U+8C48; a normalizing edit rewrote the range start to
// U+8C48, silently widening the class over the surrogate block (so EVERY
// non-BMP char, emoji included, tested CJK), the PUA, and Yi/Vai/Lisu.
// Escapes cannot be eaten that way.
function _isCJKChar(ch) {
    if (!ch) return false;
    return /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch);
}

// Split a string into contiguous CJK / non-CJK runs. Returns runs in order;
// concatenating their [startOffset, startOffset+len) covers the whole string
// with no gaps/overlaps. Empty/!string input -> [].
function splitRunsByScript(contents) {
    var runs = [];
    var s = (contents == null) ? "" : String(contents);
    if (s.length === 0) return runs;
    var runStart = 0;
    var curIsCJK = _isCJKChar(s.charAt(0));
    for (var i = 1; i < s.length; i++) {
        var isCJK = _isCJKChar(s.charAt(i));
        if (isCJK !== curIsCJK) {
            runs.push({ startOffset: runStart, len: i - runStart, isCJK: curIsCJK });
            runStart = i;
            curIsCJK = isCJK;
        }
    }
    runs.push({ startOffset: runStart, len: s.length - runStart, isCJK: curIsCJK });
    return runs;
}

module.exports = {
    splitRunsByScript: splitRunsByScript,
    _isCJKChar: _isCJKChar
};
