"use strict";

// text_cleanup.js
// Document-level text cleanup utilities.
// Operates on an InDesign document object passed by the caller.
// All source is ASCII-clean.

var indesign = require("indesign");
var app = indesign.app;
var CjkSpaceCleanup = require("./cjk_space_cleanup.js");

// GREP ranges: CJK Unified Ideographs + Extension A + Compatibility Ideographs
var CJK_GREP    = "[\\x{4E00}-\\x{9FFF}\\x{3400}-\\x{4DBF}\\x{F900}-\\x{FAFF}]";
var ALNUM_GREP  = "[A-Za-z0-9]";
var SYMBOL_GREP = "[(){},:!?.+=%@#$\\[\\]&*/<>|~^_`'\"\\\\-]";

// Each pattern matches exactly 3 characters: [left][space][right]
var SPACE_PATTERNS = [
    CJK_GREP + " " + ALNUM_GREP,
    ALNUM_GREP + " " + CJK_GREP,
    CJK_GREP + " " + SYMBOL_GREP,
    SYMBOL_GREP + " " + CJK_GREP
];

function resetFindGrepPrefs() {
    try { app.findGrepPreferences = null; } catch (e0) {}
}

function resetFindChangeGrepPrefs() {
    try { app.findGrepPreferences = null; } catch (e0) {}
    try { app.changeGrepPreferences = null; } catch (e1) {}
}

function getChar(textRange, index) {
    if (textRange && textRange.characters) {
        if (typeof textRange.characters.item === "function") {
            return textRange.characters.item(index);
        }
        return textRange.characters[index];
    }
    return null;
}

// Removes all soft line breaks (Shift+Enter, GREP: \n) from the document.
// Returns the count of removed breaks.
function removeSoftReturns(doc) {
    var total = 0;
    var found;
    var i;
    var ch;

    try {
        resetFindGrepPrefs();
        app.findGrepPreferences.findWhat = "\\n";
        found = doc.findGrep();
        resetFindGrepPrefs();
    } catch (e0) {
        resetFindGrepPrefs();
        return total;
    }

    if (!found || !found.length) { return total; }

    for (i = found.length - 1; i >= 0; i--) {
        try {
            ch = getChar(found[i], 0);
            if (ch && ch.isValid) {
                ch.remove();
                total++;
            }
        } catch (e1) {}
    }

    return total;
}

// Removes spaces that appear between a CJK character and an ASCII
// letter, digit, or common symbol. Only the space character is removed;
// the formatting of surrounding characters is preserved.
// Returns the count of removed spaces.
function removeCjkAsciiSpaces(doc) {
    var total = 0;
    var j;
    var found;
    var i;
    var spaceChar;

    for (j = 0; j < SPACE_PATTERNS.length; j++) {
        try {
            resetFindGrepPrefs();
            app.findGrepPreferences.findWhat = SPACE_PATTERNS[j];
            found = doc.findGrep();
            resetFindGrepPrefs();
        } catch (e0) {
            resetFindGrepPrefs();
            continue;
        }

        if (!found || !found.length) { continue; }

        for (i = found.length - 1; i >= 0; i--) {
            try {
                spaceChar = getChar(found[i], 1);
                if (spaceChar && spaceChar.isValid && spaceChar.contents === " ") {
                    spaceChar.remove();
                    total++;
                }
            } catch (e1) {}
        }
    }

    return total;
}

// Removes an ASCII space (U+0020) that sits at the boundary between a
// half-width ASCII symbol and a full-width CJK punctuation mark, in either
// order (e.g. ")␣、" -> ")、", "、␣(" -> "、("). This is the gap that
// removeCjkAsciiSpaces leaves: that function only handles CJK-ideograph↔ASCII
// -alnum/symbol boundaries, and full-width punctuation (、。，！ …) is NOT a CJK
// ideograph, so ")␣、" never matches. Character classes + the decision come from
// lib/cjk_space_cleanup.js (single source, unit-tested). Only the space char is
// removed; surrounding formatting is preserved. Returns the count removed.
function removeSymbolPunctSpaces(doc) {
    var patterns = CjkSpaceCleanup.BOUNDARY_SPACE_PATTERNS;
    var total = 0;
    var j;
    var found;
    var i;
    var leftChar;
    var spaceChar;
    var rightChar;

    for (j = 0; j < patterns.length; j++) {
        try {
            resetFindGrepPrefs();
            app.findGrepPreferences.findWhat = patterns[j];
            found = doc.findGrep();
            resetFindGrepPrefs();
        } catch (e0) {
            resetFindGrepPrefs();
            continue;
        }

        if (!found || !found.length) { continue; }

        for (i = found.length - 1; i >= 0; i--) {
            try {
                leftChar = getChar(found[i], 0);
                spaceChar = getChar(found[i], 1);
                rightChar = getChar(found[i], 2);
                if (spaceChar && spaceChar.isValid &&
                    leftChar && leftChar.isValid &&
                    rightChar && rightChar.isValid &&
                    CjkSpaceCleanup.shouldRemoveBoundarySpace(
                        leftChar.contents, spaceChar.contents, rightChar.contents)) {
                    spaceChar.remove();
                    total++;
                }
            } catch (e1) {}
        }
    }

    return total;
}

// Collapses runs of 2+ consecutive hard paragraph breaks (\r) into a single
// break. A paragraph containing only whitespace (space / tab / NBSP /
// ideographic space) is treated as empty and collapsed along with the breaks.
// Returns the number of collapse operations performed.
function collapseEmptyParagraphs(doc) {
    var total = 0;
    var changed;

    try {
        resetFindChangeGrepPrefs();
        app.findGrepPreferences.findWhat = "\\r(?:[ \\t\\x{00A0}\\x{3000}]*\\r)+";
        app.changeGrepPreferences.changeTo = "\\r";
        changed = doc.changeGrep();
    } catch (e0) {
        resetFindChangeGrepPrefs();
        return total;
    }
    resetFindChangeGrepPrefs();

    if (changed && changed.length) {
        total = changed.length;
    }
    return total;
}

module.exports = {
    removeSoftReturns: removeSoftReturns,
    removeCjkAsciiSpaces: removeCjkAsciiSpaces,
    removeSymbolPunctSpaces: removeSymbolPunctSpaces,
    collapseEmptyParagraphs: collapseEmptyParagraphs
};
