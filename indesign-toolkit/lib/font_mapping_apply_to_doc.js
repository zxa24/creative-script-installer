"use strict";

/**
 * lib/font_mapping_apply_to_doc.js — Phase 8D-ext-0 pure executor
 *
 * Takes an actions list (from font_mapping_resolve.resolveDocActions) and
 * applies font swaps to the doc. NO planning, NO classification — purely
 * iterates the list + writes appliedFont to each story range.
 *
 * Entry script wraps this in `app.doScript(..., UndoModes.ENTIRE_SCRIPT)`
 * for one-key Ctrl+Z revert of the whole batch (per task_plan 8D-ext-0 P1d
 * fix: single ENTIRE_SCRIPT transaction encompasses both swap + enforcer).
 *
 * Preserved MVP-empirical details (per task_plan 8D-ext-0 "11 MVP 实证细节"):
 *   #6  story-relative idx range (use actions[i].idxStart/idxEnd, not TSR ref)
 *   #7  reverse-sort by (storyIdx desc, idxStart desc) so earlier ranges
 *       not invalidated by later swaps
 *   #8  itemByRange to grab characters (stable across appliedFont mutations,
 *       unlike textStyleRanges which may merge after a swap)
 *   #9  errorSamples collect first 5 failures with src/target/err
 *
 * 8D-ext-SA — script-aware byPair sweep (CJK target keeps Latin source font):
 *   A byPair sweep whose action targets a CJK language from a NON-CJK source
 *   (e.g. Whitney/en → MHei/zh-CN) must NOT re-font the Latin letters / ASCII
 *   digits / halfwidth punctuation inside the matched range — only the CJK
 *   chars get the CJK font. Whole-range swap previously CJK-fied those Latin
 *   runs ("Client-B" / "BOA" / "123" all rendered in MHei). The gate is
 *   per-action: dstLang ∈ CJK_LANG_SET && sourceLang ∉ CJK_LANG_SET. Keyed on
 *   the ACTION's dstLang only — panel-path actions (resolveDocActions) carry no
 *   dstLang, so they are untouched by this branch and keep whole-range swap.
 *   CJK→CJK and Latin→Latin pairs also keep whole-range swap (out of scope).
 *   The pure run-splitter lives in lib/script_split.js (Node-testable); this
 *   file only does the host-side range.contents read + range.appliedFont write.
 *
 * applyActionsToDoc(doc, actions) → {
 *   ok, swapped, errors, errorSamples, actionsExecuted, actionsTotal
 * }
 */

var _splitRunsByScript = require("./script_split.js").splitRunsByScript;

function _safeStr(v) { try { return String(v); } catch (e) { return ""; } }

// 8D-ext-SA gate (build-note #2): script-aware split applies only to a
// non-CJK source → CJK target action. dstLang absent (panel path) → false.
// sourceLang absent → not a CJK lang → treated as non-CJK source (gate keys
// dstLang membership; the source-CJK check only EXCLUDES explicit CJK→CJK).
function _isScriptAwareAction(act, cjkSet) {
    if (!act || !act.dstLang) return false;
    if (!cjkSet[act.dstLang]) return false;      // target must be CJK
    if (cjkSet[act.sourceLang]) return false;    // CJK→CJK out of scope
    return true;
}

// SPEC §10.4 / §13.3.1: byPair sweep must NOT clobber the appliedFont/skew of
// characters carrying a `_T_c_emp_*` combined emphasis character style (the
// explicit installed face the emphasis refactor wrote). Walk [idxStart,idxEnd]
// per-char, read appliedCharacterStyle.name, and call `writeSpan(spanStart,
// spanEnd)` on each maximal contiguous NON-exempt span; exempt chars are
// skipped (their emphasis face survives). Returns true iff ≥1 span was written.
//
// Perf (SPEC §12.8.1): the walk is bounded to the ACTION's own range (emphasis
// runs are short prefixes); reading appliedCharacterStyle.name per char in that
// small span is negligible vs the appliedFont write itself. If reading the CS
// name throws for the whole range, fall back to ONE whole-range write (no worse
// than pre-exemption behavior).
function _isEmpExemptName(name) {
    return !!(name && name.indexOf("_T_c_emp_") === 0);
}
function _writeSpansSkippingEmp(charContainer, idxStart, idxEnd, writeSpan) {
    var wroteAny = false;
    var spanStart = -1;
    var anyExempt = false;
    for (var i = idxStart; i <= idxEnd; i++) {
        var nm = "";
        try {
            var cs = charContainer.item(i).appliedCharacterStyle;
            nm = cs ? _safeStr(cs.name) : "";
        } catch (eNm) { nm = ""; }
        var exempt = _isEmpExemptName(nm);
        if (exempt) anyExempt = true;
        if (exempt) {
            if (spanStart >= 0) { writeSpan(spanStart, i - 1); wroteAny = true; spanStart = -1; }
        } else {
            if (spanStart < 0) spanStart = i;
        }
    }
    if (spanStart >= 0) { writeSpan(spanStart, idxEnd); wroteAny = true; }
    // If nothing was exempt, the loop already wrote the single whole-range span.
    return { wroteAny: wroteAny, anyExempt: anyExempt };
}

function applyActionsToDoc(doc, actions) {
    var result = {
        ok: true,
        swapped: 0,
        errors: 0,
        errorSamples: [],
        actionsExecuted: 0,
        actionsTotal: 0
    };
    if (!doc) {
        result.ok = false;
        result.errors = 1;
        result.errorSamples.push({ err: "no doc" });
        return result;
    }
    if (!Array.isArray(actions)) {
        result.ok = false;
        result.errors = 1;
        result.errorSamples.push({ err: "actions must be array" });
        return result;
    }
    result.actionsTotal = actions.length;

    // MVP #7: reverse-sort so earlier ranges aren't invalidated by later swaps.
    // Within same story+container (story body or cell), swap last-range-first
    // (idxStart desc). Different cells are independent text containers; their
    // sort order between each other doesn't matter for correctness but we
    // group them deterministically for diagnostics.
    function _cpKey(cp) {
        if (!cp) return "_story";
        return "t" + cp.tableIdx + ".c" + cp.cellIdx + ".x" + cp.textIdx;
    }
    var sorted = actions.slice().sort(function (a, b) {
        if (a.storyIdx !== b.storyIdx) return b.storyIdx - a.storyIdx;
        var ka = _cpKey(a.cellPath);
        var kb = _cpKey(b.cellPath);
        if (ka !== kb) return ka < kb ? 1 : -1;
        return b.idxStart - a.idxStart;
    });

    // 8D-ext-SA: reuse the facade's single CJK_LANG_SET (build-note #7 — do not
    // make a copy). Required at call time (not load time) so the leaf executor
    // doesn't take a load-order dependency on the facade.
    var CJK_LANG_SET = require("./byPair_char_sweep.js").CJK_LANG_SET;

    for (var i = 0; i < sorted.length; i++) {
        var act = sorted[i];
        try {
            // MVP #6: story-relative idx range
            var story = doc.stories.item(act.storyIdx);
            // Codex r2 P1 (table cells): if cellPath present, the TSR was
            // captured inside a table cell — the idxStart/idxEnd are
            // RELATIVE TO THAT CELL'S text, NOT story.characters. Address
            // story.tables[T].cells[C].texts[X].characters.itemByRange.
            // charContainer is the Characters collection sub-ranges are taken
            // from (story body or cell text); both the whole-range swap and the
            // 8D-ext-SA per-run sub-ranges index into the SAME container.
            var charContainer;
            if (act.cellPath) {
                var cell = story.tables.item(act.cellPath.tableIdx).cells.item(act.cellPath.cellIdx);
                charContainer = cell.texts.item(act.cellPath.textIdx).characters;
            } else {
                // MVP #8: itemByRange (stable; TSR refs merge post-mutate)
                charContainer = story.characters;
            }
            var dstFont = act.dstFamily + "\t" + act.dstStyle;

            if (_isScriptAwareAction(act, CJK_LANG_SET)) {
                // 8D-ext-SA: Latin-source → CJK-target. Re-font ONLY the CJK
                // runs; leave Latin/digit/halfwidth-punct/neutral chars on the
                // source font (build-note #4 leave-untouched — never write a
                // non-CJK char, so no reverse-map to source weight is needed).
                // range.contents is read as a plain string aligned 1:1 to char
                // offsets (host assumption; see uncertainty notes). appliedFont
                // writes don't change the character count, so the snapshot
                // offsets stay valid across the per-run writes (build-note #5
                // fixed-snapshot path — chosen over GREP-split so the CJK
                // definition has ONE source of truth, script_split._isCJKChar,
                // and no global findGrepPreferences state to save/restore).
                var range = charContainer.itemByRange(act.idxStart, act.idxEnd);
                var contents = _safeStr(range.contents);
                // Offset-alignment guard: the per-run sub-ranges assume
                // contents is 1:1 with character offsets (contents.length ===
                // idxEnd-idxStart+1). UXP can tag-ify some special markers in
                // text contents (CLAUDE.md gate #1) and supplementary-plane
                // chars are 2 code units — either would desync offsets. On a
                // mismatch, do NOT trust the offsets: fall back to whole-range
                // swap (CJK still gets the right font; worst case Latin in that
                // one range stays CJK-fied — strictly safer than writing the
                // font at wrong positions) and record it for the host probe.
                var expectedLen = act.idxEnd - act.idxStart + 1;
                if (contents.length !== expectedLen) {
                    // Offsets can't be trusted → whole-range swap. Reuse the
                    // already-hoisted `range` so the font write hits ONE ref (the
                    // same itemByRange the contents read came from).
                    range.appliedFont = dstFont;
                    result.swapped++;
                    if (result.scriptSplitFallbacks === undefined) result.scriptSplitFallbacks = 0;
                    result.scriptSplitFallbacks++;
                } else {
                    var runs = _splitRunsByScript(contents);
                    var wroteCJK = false;
                    for (var ri = 0; ri < runs.length; ri++) {
                        if (!runs[ri].isCJK) continue;
                        var subStart = act.idxStart + runs[ri].startOffset;
                        var subEnd = subStart + runs[ri].len - 1;
                        // SPEC §10.4: skip chars carrying a `_T_c_emp_*` combined
                        // emphasis CS — byPair must NOT overwrite their explicit
                        // installed face. Write only the contiguous non-exempt spans.
                        var _empSpan = _writeSpansSkippingEmp(charContainer, subStart, subEnd, function (ws, we) {
                            var sub = charContainer.itemByRange(ws, we);
                            sub.appliedFont = dstFont;
                        });
                        if (_empSpan.wroteAny) wroteCJK = true;
                    }
                    // swapped semantics (8D-ext-SA, build-note #4): for
                    // script-aware actions, swapped counts a range only when ≥1
                    // CJK run was re-fonted. A pure-Latin range (Client-B
                    // case) writes nothing → not counted (it used to count under
                    // whole-range swap).
                    if (wroteCJK) result.swapped++;
                }
            } else {
                // Whole-range swap — panel path (no dstLang), Latin→Latin, and
                // CJK→CJK (out of scope of script-split, e.g. M5 zh→zh-TW).
                // SPEC §10.4/§13.3.1: still per-char exempt `_T_c_emp_*` chars so
                // a CJK→CJK byPair swap can't clobber an emphasis face. Offsets
                // are trustworthy here (no contents desync read on this path), so
                // per-char split is safe.
                _writeSpansSkippingEmp(charContainer, act.idxStart, act.idxEnd, function (ws, we) {
                    charContainer.itemByRange(ws, we).appliedFont = dstFont;
                });
                result.swapped++;
            }
            result.actionsExecuted++;
        } catch (e) {
            result.errors++;
            // MVP #9: errorSamples — first 5 failures
            if (result.errorSamples.length < 5) {
                result.errorSamples.push({
                    src: (act.sourceFont || "?") + "/" + (act.sourceWeight || "?"),
                    target: (act.dstFamily || "?") + "/" + (act.dstStyle || "?"),
                    storyIdx: act.storyIdx,
                    cellPath: act.cellPath,
                    idxStart: act.idxStart,
                    idxEnd: act.idxEnd,
                    err: _safeStr(e && e.message || e)
                });
            }
        }
    }
    return result;
}

module.exports = {
    applyActionsToDoc: applyActionsToDoc
};
