"use strict";

// lib/emphasis_extractor.js — Phase 8B
//
// Promote per-character format overrides in mixed-format paragraphs into
// emphasis character styles, leaving the paragraph's baseline winners on the
// paragraph style.
//
// Caller chain:
//   format_snapshot._allRanges  → extractEmphasis(...)
//                              ↓
//   format_snapshot.baseline (winners) + format_snapshot.emphasisRuns
//                              ↓
//   style_sheet_builder consumes baseline (paragraph style) + emphasisRuns
//   (char-style pool _T_c_emp_*); style_applier applies emphasisRuns over a
//   cascade-normalized paragraph.
//
// Per-dimension winner rules (locked in by task_plan Phase 8B):
//
//   fontFamily          most-chars-wins; targetLanguage may force the font
//                       whose runs cover that language's main script.
//   fontStyle           parsed into { weight, italic }:
//                         weight = LIGHTEST-weight that appears
//                                  (Light < Regular < Medium < Semibold < Bold < Black)
//                         italic = false (always — italic is always emphasis)
//                       base fontStyle string is recomposed from
//                       (lightestWeight, italic=false).
//   fontSize / fillColor / tracking / horizontalScale / verticalScale
//                       most-chars-wins, ties broken by run order.
//   underline / strikeThrough           base = false  (bool dim is asymmetric)
//   baselineShift                       base = 0      (super/sub is asymmetric)
//   skew                                base = 0      (synthetic italic — designers use
//                                                      non-zero skew on fonts without an
//                                                      italic variant; always emphasis)
//
// Four run classes are withheld from the baseline winner pass. Three of them
// still reach the output (or are provably format-transparent); the fourth is
// dropped outright:
//   • blank / whitespace-only runs            → coalesced into a neighbor
//   • designer-CS runs containing CJK         → direct-override channel (#BRIDGE-24 A1)
//   • VISIBLE position-shifted runs (SUPER/SUBSCRIPT), hint-less or
//     self-marked                             → direct-override channel (#E2E-1b)
//   • every OTHER run whose `charStyleHint` is set (a non-[None] designer char
//     style, no CJK in its text) → dropped: it neither votes nor becomes an
//     emphasis run, because it is already styled and we leave it alone
//     (counted as stats.runsSkippedExistingCharStyle).
// "Withheld", not "never votes": two documented degenerate fallbacks hand the
// vote back rather than leave a paragraph with no baseline of its own. If every
// admitted run is position-shifted, the guard puts those runs back and they
// vote; if every admitted run is blank, the winner pass falls back to the blank
// runs and they vote. Both are last resorts — the alternative is a baseline
// nothing on the page has.
//
// A hint naming one of OUR OWN pipeline styles (SELF_MARKED_PREFIXES) is NOT in
// the fourth class: those runs came from a previous import, the char style IS
// the emphasis signal, so they are re-admitted and vote normally — subject to
// the position divert above, which applies to every run that would otherwise
// vote. A BLANK position-shifted run is likewise not in the position class: the
// POSITION admitter never diverts a blank, leaving it on the ordinary path where
// the blank machinery owns it (and where it votes only under the all-blank
// fallback just described).
//
// The designer-CS-CJK admitter, by contrast, DOES claim blanks — U+3000
// IDEOGRAPHIC SPACE is both blank and CJK, and the admitter is right to claim
// it. Such a run is dropped at the emission choke point instead
// (_emitDirectOverrideRuns), so it produces no emphasis run; and since it never
// entered `ranges`, it cannot vote under the all-blank fallback either. Both
// qualifiers are load-bearing — see _admitRun and _emitDirectOverrideRuns.
//
// A position-shift is a rendering transform (optically smaller, often a lighter
// face), so a 2-char superscript must not define the paragraph's weight — see
// the admitter in extractEmphasis for the Placemat case that proved it.
//
// editMode = true bypasses targetLanguage (lets natural winners through so
// designers can see what auto-detection would pick).

// Relative-path require keeps both node tests and the bridge runner's
// embedded-registry shim happy — the latter detects "./" / "../" and
// resolves against the requiring module's directory. Going through
// `path.resolve(__dirname, ...)` would yield an absolute path that the
// shim can't look up in its registry.
var SC = require("./script_classifier.js");
// translation_common.normalizeText is the repo's single SoT for "invisible"
// text: it strips BOM + zero-width family (U+200B/200C/200D) + U+0007 and
// collapses/trims whitespace (see translation_common.js:87-91, mirrored by
// export_translation_package.idjs:130 + import_translations.idjs). _isBlankText
// reuses it so the "blank run" predicate can never drift from that set.
var TC = require("./translation_common.js");

// ─── Weight rank table ────────────────────────────────────────────────
//
// Standardized typographic weights. Unknown weight strings default to 400
// (Regular-class) so they don't accidentally win lightest-wins.
var WEIGHT_RANK = {
    "Thin":       100, "Hairline":   100,
    "ExtraLight": 200, "UltraLight": 200,
    "Light":      300,
    "":           400, "Regular":    400, "Normal": 400, "Book": 400,
    "Medium":     500,
    "Semibold":   600, "SemiBold":   600, "Demibold": 600, "DemiBold": 600,
    "Bold":       700,
    "ExtraBold":  800, "UltraBold":  800, "Heavy":   800, "XBold":  800, "Xbold":  800,
    "Black":      900
};

function rankWeight(w) {
    if (w === null || w === undefined) return 400;
    var key = String(w);
    if (Object.prototype.hasOwnProperty.call(WEIGHT_RANK, key)) return WEIGHT_RANK[key];
    var lc = key.toLowerCase();
    for (var k in WEIGHT_RANK) {
        if (Object.prototype.hasOwnProperty.call(WEIGHT_RANK, k) &&
            k.toLowerCase() === lc) return WEIGHT_RANK[k];
    }
    return 400;
}

/**
 * Parse an InDesign fontStyle string ("Bold Italic", "Light", "Italic", ...)
 * into a structured { weight, italic, raw } record.
 *
 * "Italic" alone resolves to { weight: "Regular", italic: true } since
 * InDesign uses bare "Italic" for the italic of the Regular weight.
 */
function parseFontStyle(s) {
    var raw = (s === null || s === undefined) ? "Regular" : String(s);
    var lower = raw.toLowerCase();
    var italic = (lower.indexOf("italic") >= 0) || (lower.indexOf("oblique") >= 0);
    var weightStr = raw
        .replace(/italic/ig, "")
        .replace(/oblique/ig, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!weightStr) weightStr = "Regular";
    return { weight: weightStr, italic: italic, raw: raw };
}

/**
 * Compose a fontStyle string back from { weight, italic }.
 *   { weight: "Regular", italic: false } → "Regular"
 *   { weight: "Regular", italic: true  } → "Italic"  (InDesign convention)
 *   { weight: "Bold",    italic: true  } → "Bold Italic"
 *   { weight: "Light",   italic: false } → "Light"
 */
function composeFontStyle(weight, italic) {
    var w = weight || "Regular";
    if (italic) {
        if (w === "Regular") return "Italic";
        return w + " Italic";
    }
    return w;
}

// ─── Language code → main script mapping ──────────────────────────────
//
// Used by the targetLanguage override. Granular enough for the scripts we
// have GREP infrastructure for (CJK + Latin + Cyrillic + Thai + Arabic).
function languageToScript(lang) {
    if (!lang) return null;
    var l = String(lang).toLowerCase();
    // CJK family
    if (l.indexOf("zh") === 0) return "CJK";
    if (l.indexOf("ja") === 0) return "CJK";
    if (l.indexOf("ko") === 0) return "HANGUL";
    if (l.indexOf("th") === 0) return "THAI";
    if (l.indexOf("ar") === 0 || l.indexOf("fa") === 0 || l.indexOf("ur") === 0 ||
        l.indexOf("he") === 0) return "ARABIC";
    if (l.indexOf("ru") === 0 || l.indexOf("uk") === 0 || l.indexOf("bg") === 0 ||
        l.indexOf("sr") === 0 || l.indexOf("be") === 0 || l.indexOf("mk") === 0) {
        return "CYRILLIC";
    }
    // Default: anything else is treated as LATIN script
    return "LATIN";
}

// ─── Per-font script coverage (for targetLanguage override) ───────────

function classifyFontFamilyByScript(allRanges) {
    var counts = {};   // fontFamily → { CJK: n, LATIN: n, ... }
    for (var i = 0; i < allRanges.length; i++) {
        var r = allRanges[i];
        if (!r || !r.text) continue;
        // Tolerate two _allRanges shapes: top-level fontFamily (8A capture
        // contract) or nested props.fontFamily (8B-extended contract).
        var family = r.fontFamily || (r.props && r.props.fontFamily);
        if (!family) continue;
        if (!counts[family]) counts[family] = {};
        var bucket = counts[family];
        var t = r.text;
        for (var ci = 0; ci < t.length; ci++) {
            var cp = t.charCodeAt(ci);
            if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < t.length) {
                var lo = t.charCodeAt(ci + 1);
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = ((cp - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
                    ci++;
                }
            }
            var s = SC.classifyCodepoint(cp);
            bucket[s] = (bucket[s] || 0) + 1;
        }
    }
    return counts;
}

function pickFontByTargetScript(allRanges, targetScript) {
    if (!targetScript) return null;
    var counts = classifyFontFamilyByScript(allRanges);
    var bestFont = null, bestCount = 0;
    // Iterate in insertion order so ties resolve to first-appearing font.
    for (var fname in counts) {
        if (!Object.prototype.hasOwnProperty.call(counts, fname)) continue;
        var c = counts[fname][targetScript] || 0;
        if (c > bestCount) { bestCount = c; bestFont = fname; }
    }
    return bestCount > 0 ? bestFont : null;
}

// ─── Field-level winner selection ─────────────────────────────────────

/**
 * most-chars-wins on `field` across non-skipped runs.
 * Tied → first-appearing wins (preserves designer intent).
 *
 * @param runs  Array of { text, props }
 * @param field Property name on `props` (e.g. "fontFamily" or "fontSize")
 * @param keyOf  Optional function to project the field value to a comparable
 *               key string (e.g. fillColor → swatch name).
 */
function mostCharsWinner(runs, field, keyOf) {
    var counts = {};        // key → char count
    var firstSeen = {};     // key → first-seen index
    var keyToValue = {};    // key → original value (for return)
    for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        var v = r.props ? r.props[field] : undefined;
        var k = keyOf ? keyOf(v) : (v === null || v === undefined ? "__NULL__" : String(v));
        if (!Object.prototype.hasOwnProperty.call(counts, k)) {
            counts[k] = 0;
            firstSeen[k] = i;
            keyToValue[k] = v;
        }
        counts[k] += (r.text ? r.text.length : 0);
    }
    var bestKey = null, bestCount = -1, bestFirstSeen = Infinity;
    for (var k2 in counts) {
        if (!Object.prototype.hasOwnProperty.call(counts, k2)) continue;
        var c = counts[k2];
        if (c > bestCount || (c === bestCount && firstSeen[k2] < bestFirstSeen)) {
            bestCount = c;
            bestFirstSeen = firstSeen[k2];
            bestKey = k2;
        }
    }
    return bestKey === null ? null : keyToValue[bestKey];
}

// A run is "blank" when, after the repo's text normalization, it carries no
// glyph that survives to the rendered output — an empty run, spaces, a trailing
// "\n\n"/paragraph return, OR a zero-width run (U+200B ZWSP / U+200C / U+200D /
// U+FEFF BOM / U+0007). Such runs carry no visible formatting, so they must not
// vote on baseline winners (a trailing whitespace OR zero-width run in a lighter
// font would otherwise drag a uniform heavy title's lightest-weight baseline
// down — the page-3 Longevity demote bug, sibling of the b08d103 soft-break
// baseline fix).
//
// The "invisible" set is NOT hand-rolled here: it is exactly what
// translation_common.normalizeText() strips/collapses, the repo's single SoT
// for invisible text (shared by export + import). Aligning to that SoT also
// means chars the pipeline does NOT strip (e.g. U+0085 NEL, which is neither in
// the strip set nor in JS \s, so it survives into the output) are treated as
// VISIBLE — consistent with the rest of the system, which keeps them.
function _isBlankText(t) {
    if (t === null || t === undefined) return true;
    return TC.normalizeText(String(t)) === "";
}

// ─── Blank-run coalescing (emphasis-run generation) ───────────────────
//
// A whitespace-only run is format-transparent: it must never be emitted as a
// standalone emphasis run carrying its OWN independent format (e.g. a trailing
// space that happens to hold a different size / weight than the title it
// follows). Instead a blank run "follows its neighbor" — the PREVIOUS run's
// format takes priority (a trailing / interior space joins the run before it),
// falling back to the NEXT run when there is no previous (a leading space joins
// the run after it). This is the `coalesceBlankEmphasis` behavior (default ON,
// user product decision 2026-06-24); flip the flag off to restore the legacy
// "a blank run that differs from baseline is emitted as its own run" emission.

// Nearest non-blank range index from `idx`, walking in `dir` (-1 prev / +1 next).
function _nearestNonBlankIdx(ranges, idx, dir) {
    for (var i = idx + dir; i >= 0 && i < ranges.length; i += dir) {
        if (!_isBlankText(ranges[i] && ranges[i].text)) return i;
    }
    return -1;
}

// Index of `r` within `allRanges`, by identity. Lets the caller key blanks and
// emitted runs by their ORIGINAL position, so the coalescer can be handed the
// unfiltered input (see _coalesceBlankRuns).
function _indexOfRange(allRanges, r) {
    for (var i = 0; i < (allRanges || []).length; i++) {
        if (allRanges[i] === r) return i;
    }
    return -1;
}

// Absorb each blank run into a neighbor's emphasis run. `runByRangeIdx` maps a
// NON-blank range index → the emphasis run it produced (absent when that range
// matched the paragraph baseline). For each blank we pick the neighbor whose
// format it inherits — previous first, else next — and when that neighbor (a)
// carries an emphasis run AND (b) is position-contiguous with the blank, we
// EXTEND that run to swallow the blank's range so the blank is never a
// standalone run. When the neighbor is baseline (no run), or a hint-filtered
// range sits between them (breaking position contiguity), the blank simply
// stays baseline. Either way the blank's own format is dropped, never emitted.
//
// `ranges` here is the UNFILTERED input, and the indices are original ones. That
// is the whole trick for runs the filter removed (diverted to the direct-override
// channel, or skipped as an already-styled designer CS): they are still IN the
// array the scan walks, so the scan STOPS at one instead of looking through it,
// and — carrying no entry in `runByRangeIdx`, which only the emitting admitted
// ranges populate — it donates nothing. A blank behind a removed run therefore
// finds no donor and stays baseline, with no need to ask whether a neighbour was
// removed, and no inference from positional gaps. It holds for a CHAIN of blanks
// at any length, because the chain's left-hand neighbour genuinely is that
// removed run however many blanks intervene.
function _coalesceBlankRuns(ranges, blankIdxs, runByRangeIdx) {
    // Pass 1 — trailing / interior blanks take the PREVIOUS run. Ascending so a
    // chain of contiguous blanks grows the donor run's end rightward.
    for (var a = 0; a < blankIdxs.length; a++) {
        var bi = blankIdxs[a];
        var prevIdx = _nearestNonBlankIdx(ranges, bi, -1);
        if (prevIdx < 0) continue;                  // no previous → pass 2 (leading)
        var prevRun = runByRangeIdx[prevIdx];
        if (!prevRun) continue;                     // previous is baseline → blank baseline
        var br = ranges[bi];
        if (prevRun.end === br.start) prevRun.end = br.end;   // contiguous → extend
    }
    // Pass 2 — leading blanks (no previous run at all) take the NEXT run.
    // Descending so a chain of leading blanks grows the donor run's start
    // leftward.
    for (var z = blankIdxs.length - 1; z >= 0; z--) {
        var bi2 = blankIdxs[z];
        if (_nearestNonBlankIdx(ranges, bi2, -1) >= 0) continue;  // had a previous
        var nextIdx = _nearestNonBlankIdx(ranges, bi2, +1);
        if (nextIdx < 0) continue;                  // all-blank paragraph
        var nextRun = runByRangeIdx[nextIdx];
        if (!nextRun) continue;                     // next is baseline → blank baseline
        var br2 = ranges[bi2];
        if (br2.end === nextRun.start) nextRun.start = br2.start;  // contiguous → extend
    }
}

function lightestWeightWinner(runs) {
    var lightest = null;
    var lightestRank = Infinity;
    var lightestFirstSeen = Infinity;
    for (var i = 0; i < runs.length; i++) {
        var styleStr = runs[i].props ? runs[i].props.fontStyle : null;
        var parsed = parseFontStyle(styleStr);
        var rank = rankWeight(parsed.weight);
        if (rank < lightestRank ||
            (rank === lightestRank && i < lightestFirstSeen)) {
            lightestRank = rank;
            lightestFirstSeen = i;
            lightest = parsed.weight;
        }
    }
    return lightest || "Regular";
}

// ─── fillColor key (for most-chars-wins comparison) ───────────────────

function fillColorKey(c) {
    if (!c) return "__NULL__";
    if (c.swatch) return "S:" + c.swatch;
    if (c.values && c.values.length) {
        return "V:" + (c.space || "?") + ":" + c.values.join(",");
    }
    return "__UNKNOWN__";
}

function fillColorEqual(a, b) {
    return fillColorKey(a) === fillColorKey(b);
}

// ─── Public: per-paragraph extraction ─────────────────────────────────

/**
 * Run emphasis extraction over the per-range breakdown of a single
 * mixed-format paragraph.
 *
 * @param {Array} allRanges  [{ start, end, text, props, hint }, ...]
 *   `props` shape matches captureCharProperties return: fontFamily,
 *   fontStyle, fontSize, fillColor, underline, strikeThrough, tracking,
 *   baseline_shift, horizontal_scale, vertical_scale.
 * @param {Object} fallbackBaseline  Used when every run is skipped (charStyle).
 * @param {Object} options
 *   {
 *     targetLanguage: string|null,
 *     editMode:       bool          // true bypasses targetLanguage
 *   }
 *
 * @returns {Object}
 *   {
 *     baselineWinners: { fontFamily, fontStyle, fontSize, fillColor,
 *                        underline, strikeThrough, tracking,
 *                        baseline_shift, horizontal_scale, vertical_scale },
 *     emphasisRuns: [
 *       { start, end, diff: { ... only differing fields ... } }
 *     ],
 *     stats: {
 *       runsTotal, runsSkippedExistingCharStyle, runsEmphasis,
 *       targetLanguageOverride, editModeOverride
 *     }
 *   }
 */
// Self-marked char styles created by the translation pipeline. Runs
// carrying these hints came from a previous import — the styled chars
// ARE the emphasis signal and must be re-extracted on re-export so the
// roundtrip doesn't lose information. Designer's pre-existing manual
// char styles (any other prefix) remain skipped per Phase 8B contract.
var SELF_MARKED_PREFIXES = ["_T_c_emp_", "_T_c_annotation_", "_T_Latin_"];

function _isSelfMarkedHint(hint) {
    if (!hint) return false;
    for (var i = 0; i < SELF_MARKED_PREFIXES.length; i++) {
        if (String(hint).indexOf(SELF_MARKED_PREFIXES[i]) === 0) return true;
    }
    return false;
}

// #BRIDGE-24 Fix A1: detect CJK content in a range. Used to override the
// hint-bearing skip when a designer-CS-wrapped range contains CJK chars
// whose effective fontFamily differs from baseline — those need emphasis
// extraction to survive cluster psFont swaps. Matches Han, Hiragana,
// Katakana, Hangul, CJK symbols & halfwidth/fullwidth forms.
// The class is written in \uXXXX ESCAPES on purpose — do NOT put literal
// CJK characters back. It used to hold the literal for U+F900, whose NFD
// decomposition is U+8C48; a normalizing edit rewrote the range start to
// U+8C48, silently widening the class over the surrogate block (so EVERY
// non-BMP char, emoji included, tested CJK), the PUA, and Yi/Vai/Lisu.
// Escapes cannot be eaten that way.
function _hasCJK(text) {
    if (!text) return false;
    return /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/.test(text);
}

// #E2E-1b admitter. Route ONE run that is otherwise cleared to vote either
// into the winner-pass set (`ranges`) or into the position-shift staging queue
// (`positionShifted`, which the degenerate guard either puts BACK into `ranges`
// when it fires, or otherwise drains into `directOverride`).
// Returns true when the run was admitted to `ranges`.
//
// A position-shifted run (SUPERSCRIPT / SUBSCRIPT set via character.position)
// is a RENDERING TRANSFORM, not a weight choice — InDesign draws it optically
// smaller, and designers routinely pick a lighter face for it so the raised
// glyph doesn't blot. It therefore must not vote in the winner pass, exactly as
// blank runs and designer-CS runs don't:
//
//   Placemat "…avec Client-A[MD]. " — [0,125) Dax Pro Bold@36 NORMAL,
//   [125,127) Dax Pro Medium@30 SUPERSCRIPT (the French ®),
//   [127,129) Dax Pro Bold@36 NORMAL. Those 2 superscript chars were the whole
//   paragraph's only sub-Bold weight, so lightest-wins handed the baseline
//   Medium while most-chars-wins kept size 36 / position NORMAL — a hybrid
//   baseline no run actually has. The title then imported one weight too light
//   (MHei PRC Bold where the Dax Pro Bold → Xbold pair was owed).
//
// The algorithm ALREADY treats position-shift as "always emphasis" (baseline
// forces position NORMAL + baseline_shift 0, like skew and underline), so
// letting it vote on fontStyle/fontSize contradicted its own base. Diverted
// runs exit via the direct-override channel, NOT as a normal emphasis run:
// with the baseline correctly at Bold, such a run's diff is LIGHTER than
// baseline, which the two-state translator UX cannot express (design-intent.md
// §1 locked invariant `emphasis weight >= baseline`). The direct-override
// channel is precisely the exit for runs that must survive without entering
// that two-state model.
//
// Two notes on WHICH runs this sees:
//
//   • EVERY run cleared to vote passes through here — hint-less runs AND
//     self-marked (`_T_c_emp_*` / `_T_c_annotation_*` / `_T_Latin_*`) ones.
//     Checking position only on the hint-less path let a re-export reproduce
//     the exact pre-fix bug: our own import stamps `_T_c_emp_*` onto these
//     runs, so the Placemat superscript came back as a self-marked run, voted,
//     and dragged the baseline to Medium again. A diverted self-marked run
//     keeps its `charStyleHint` (the directOverride emit loop copies it).
//
//   • BLANK shifted runs are NOT diverted — they take the ordinary path into
//     `ranges`, exactly as the same run without a position would, which is the
//     symmetry with the no-position control that Case POS-8 pins. Diverting
//     them bought nothing: blanks are already excluded from `winnerRanges`, so
//     one cannot vote either way (bar the all-blank fallback), while the
//     divert put it beyond `_coalesceBlankRuns`'s reach.
//
//     Note this clause is about ROUTING, not about the no-standalone-blank-run
//     rule — that one is enforced at the emission choke point (see
//     _emitDirectOverrideRuns), because a routing-side check cannot cover
//     admitters that legitimately claim a blank for other reasons.
function _admitRun(r, ranges, positionShifted) {
    var pos = (r.props && r.props.position) || "NORMAL";
    if (pos !== "NORMAL" && !_isBlankText(r.text)) {
        positionShifted.push(r);
        return false;
    }
    ranges.push(r);
    return true;
}

// Emit the queued direct-override runs into `out`, diffed against `baseline`.
// The ONE place a diverted run becomes a standalone emphasis run — both callers
// (the early no-winner return and the main emit) go through here.
//
// ── INVARIANT: a blank run is never emitted as a standalone emphasis run ──
//
// Locked product decision (user 2026-06-24): a whitespace-only run must never
// be EMITTED carrying its own independent format. Runs on the ordinary path
// already obey it — they are queued as `blankIdxs` and coalesced into a
// neighbor — but `directOverride` is appended AFTER `_coalesceBlankRuns` has
// run, so a diverted blank escapes coalescing and lands here as exactly the
// standalone run the decision forbids (minting a _T_c_emp_* char style over
// invisible text, and holding `uniform` false for it).
//
// The guard belongs at THIS choke point rather than in the admitters, for two
// reasons. First, it then holds for any admitter added later, however many feed
// the channel. Second, an admitter-side test cannot see the whole picture: an
// admitter claims a run for its OWN reason, which can legitimately coincide
// with blankness — U+3000 IDEOGRAPHIC SPACE is simultaneously blank (JS \s) and
// CJK (first member of that class), so the designer-CS-CJK admitter is right to
// claim it and wrong to emit it. Dropping it here leaves the run skipped and
// untouched, which is what a designer-styled space should be.
//
// Unconditional BY DESIGN — unlike the ordinary path, this guard does not
// consult `coalesceBlankEmphasis`. That flag chooses between two ways of
// handling a blank that has a neighbour to fall back on (coalesce into it, or
// the legacy "emit its own format"); a diverted blank has no such choice, since
// it is past `_coalesceBlankRuns` by the time it gets here, so honoring the flag
// would mean only the legacy branch, i.e. emitting the standalone blank run in
// every case. Dropping is the correct outcome either way, and the sole
// production call site leaves the flag ON.
function _emitDirectOverrideRuns(queue, baseline, out) {
    for (var i = 0; i < queue.length; i++) {
        var r = queue[i];
        if (_isBlankText(r.text)) continue;      // never a standalone blank run
        var d = diffProps(r.props, baseline);
        if (!d) continue;                        // no diff vs baseline → nothing to emit
        var runOut = { start: r.start, end: r.end, diff: d };
        if (r.hint) runOut.charStyleHint = r.hint;
        out.push(runOut);
    }
}

// Pick the most-chars-wins fontFamily across the NON-hint subset of a
// paragraph's ranges. Used as the reference baseline when deciding
// whether a hint-bearing range's font differs enough to warrant a
// direct-override emphasis. Falls back to fallbackBaseline.fontFamily
// when every range in the paragraph carries a hint.
function _scanBaselineFamily(allRanges, fallbackBaseline) {
    var freq = {}, total = 0;
    for (var i = 0; i < (allRanges || []).length; i++) {
        var r = allRanges[i];
        if (!r || r.hint) continue;
        var fam = r.props && r.props.fontFamily;
        if (!fam) continue;
        var len = Math.max(1, (r.end || 0) - (r.start || 0));
        freq[fam] = (freq[fam] || 0) + len;
        total += len;
    }
    if (total > 0) {
        var best = null, bestN = 0;
        for (var k in freq) {
            if (Object.prototype.hasOwnProperty.call(freq, k) && freq[k] > bestN) {
                best = k; bestN = freq[k];
            }
        }
        return best;
    }
    return (fallbackBaseline && fallbackBaseline.fontFamily) || null;
}

function extractEmphasis(allRanges, fallbackBaseline, options) {
    options = options || {};
    var stats = {
        runsTotal: (allRanges || []).length,
        runsSkippedExistingCharStyle: 0,
        runsSelfMarkedReExtracted: 0,
        runsDesignerCSCJKAdmitted: 0,  // #BRIDGE-24 Fix A1
        runsPositionShiftedAdmitted: 0,  // #E2E-1b — exited via directOverride
        runsPositionShiftedPutBack: 0,   // #E2E-1b — degenerate guard put them back
        runsEmphasis: 0,
        targetLanguageOverride: false,
        editModeOverride: !!options.editMode
    };

    // #BRIDGE-24 Fix A1: pre-compute a reference fontFamily from the
    // non-hint subset (or fall back to baseline.fontFamily). Used to
    // detect designer-CS-wrapped CJK ranges whose effective font
    // diverges from what surrounding designer-CS Latin ranges use —
    // a signal that the designer CS isn't controlling the font and
    // the CJK chars are picking up a separate fallback that cluster
    // psFont swap would wipe out.
    var scanBaselineFamily = _scanBaselineFamily(allRanges, fallbackBaseline);

    // The DIRECT-OVERRIDE channel: ranges that must not enter the baseline
    // winner vote, but still have to reach the output. They are emitted as
    // emphasis_runs at the end (after winner-computation finishes on the
    // remaining ranges), diffed against the SAME baselineWinners.
    //
    // Two admitters queue into it:
    //   • #BRIDGE-24 Fix A1 — designer-CS-wrapped CJK ranges. Voting them
    //     would flip the para baseline from the dominant Latin family to the
    //     lone CJK family, which would then tofu the Latin chars.
    //   • #E2E-1b — position-shifted (SUPERSCRIPT / SUBSCRIPT) ranges. See
    //     the admitter below for why they must not vote, and why the
    //     direct-override channel (not a normal emphasis run) is the only
    //     legal exit for them.
    var directOverride = [];

    // #E2E-1b staging: position-shifted hint-less ranges. Held aside until
    // the filter loop ends so the degenerate "every run is shifted" case can
    // put them back (see the guard after the loop).
    var positionShifted = [];

    // Filter: drop runs whose hint is a designer-applied char style
    // (preserve as-is). Runs whose hint is one of OUR pipeline-created
    // names (`_T_c_emp_*`, `_T_c_annotation_*`, `_T_Latin_*`) are
    // re-extracted — those came from a prior import and the char style
    // IS the emphasis signal.
    var ranges = [];
    for (var i = 0; i < (allRanges || []).length; i++) {
        var r = allRanges[i];
        if (!r) continue;
        if (r.hint) {
            if (_isSelfMarkedHint(r.hint)) {
                // Still subject to the #E2E-1b position divert — a self-marked
                // hint is OUR OWN stamp from a previous import, not a reason to
                // let a superscript vote (see _admitRun). Count only when the
                // run actually rejoined the winner pass, which is what
                // "re-extracted" means; a diverted one is counted by the
                // position channel instead, so one run is one event.
                if (_admitRun(r, ranges, positionShifted)) {
                    stats.runsSelfMarkedReExtracted++;
                }
                continue;
            }
            // #BRIDGE-24 Fix A1 (extended): designer-CS-CJK range —
            // queue for direct-override emission AFTER baseline winners
            // are computed. Don't add to `ranges` (would skew baseline
            // winners toward the outlier and tofu the surrounding chars).
            //
            // Admit ANY hint-bearing range containing CJK chars, then let
            // diffProps at emit time decide whether the range actually
            // differs from the (non-hint) baseline winners. The original
            // narrower condition `rFam !== scanBaselineFamily` missed
            // designer-CS CJK ranges that share the baseline family but
            // differ in fontStyle (e.g. Hyperlink-wrapped "奖励积分" with
            // MHei PRC|Bold while surrounding emphasis runs are also
            // MHei PRC|Bold — but baseline lightestWeight winner is
            // Regular, so an emphasis run IS needed to preserve the Bold).
            // Designer CSs without a font diff vs baseline (e.g. pure
            // color/underline CS on a Regular Latin run) still skip via
            // the no-diff filter inside the directOverride emit loop.
            var rText = (typeof r.text === "string") ? r.text : "";
            if (_hasCJK(rText)) {
                stats.runsDesignerCSCJKAdmitted++;
                directOverride.push(r);
                continue;
            }
            stats.runsSkippedExistingCharStyle++;
            continue;
        }
        // Hint-less run — same admitter, same #E2E-1b divert (see _admitRun).
        _admitRun(r, ranges, positionShifted);
    }

    // #E2E-1b degenerate guard — fires when no VISIBLE (non-blank) un-shifted
    // run is left to define the baseline: put the shifted runs back and let
    // them vote rather than fall through to a baseline nothing on the page
    // actually has.
    //
    // The predicate is the VISIBLE subset, not `ranges.length === 0` — that is
    // what makes it truly isomorphic to the blank-run
    // `winnerRanges.length === 0 → winnerRanges = ranges` fallback below, which
    // also tests visibility. Keying on the whole admitted set instead let one
    // blank range suppress the guard: for
    //   [ {"*", Bold, SUPERSCRIPT}, {"\r", Light, NORMAL} ]
    // `ranges` held the "\r" so the guard stayed silent, the superscript went to
    // direct-override, `winnerRanges` then filtered to empty, and the fallback
    // below derived the paragraph baseline from an invisible carriage return
    // (Bold → Light). See Case POS-6.
    //
    // Blank runs may still be in `ranges` when the guard fires; they simply
    // don't survive the `winnerRanges` filter, so the shifted runs are what
    // votes. Reaching `fallbackBaseline` instead would strand the paragraph on
    // pre-extraction first-char values.
    if (positionShifted.length) {
        // Two mutually exclusive counters, one per branch — together they sum
        // to the number of shifted runs recognized, and apart they distinguish
        // the two outcomes:
        //   runsPositionShiftedAdmitted → run exited via the directOverride
        //     channel. Strict mirror of runsDesignerCSCJKAdmitted: both count
        //     ADMISSIONS to that channel, so this one must stay 0 when the
        //     degenerate guard fires and nothing is admitted.
        //   runsPositionShiftedPutBack  → the degenerate guard put the run back
        //     into `ranges` to vote. Without its own counter this branch is
        //     indistinguishable from "there were no shifted runs at all" —
        //     both leave Admitted at 0.
        // (Blank shifted runs are deliberately never in `positionShifted` at
        // all — see _admitRun — so neither counter ever sees them.)
        var hasVisibleRange = false;
        for (var vri = 0; vri < ranges.length; vri++) {
            if (!_isBlankText(ranges[vri] && ranges[vri].text)) { hasVisibleRange = true; break; }
        }
        if (!hasVisibleRange) {
            // Merge back in TEXT ORDER — order is load-bearing, since
            // lightestWeightWinner breaks weight ties by first-seen index and
            // mostCharsWinner breaks count ties the same way. Both arrays were
            // filled walking allRanges in order, so sorting the union by start
            // restores the original sequence.
            ranges = ranges.concat(positionShifted);
            ranges.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
            stats.runsPositionShiftedPutBack += positionShifted.length;
            // Put-back is the OTHER way a run reaches `ranges`, so a self-marked
            // one rejoins the vote here just as it would have at the _admitRun
            // call site — and "re-extracted" means exactly that. Counting it
            // only there left this path reading 0 for a run that went on to
            // define the baseline.
            for (var sm = 0; sm < positionShifted.length; sm++) {
                if (_isSelfMarkedHint(positionShifted[sm].hint)) {
                    stats.runsSelfMarkedReExtracted++;
                }
            }
        } else {
            for (var psi = 0; psi < positionShifted.length; psi++) {
                stats.runsPositionShiftedAdmitted++;
                directOverride.push(positionShifted[psi]);
            }
        }
    }

    // All runs skipped → no winner; fall back to provided baseline (typically
    // first-char effective values from the snapshot).
    if (ranges.length === 0) {
        // #BRIDGE-24 Fix A1: even with no admitted ranges for winner
        // computation, if we queued direct-override runs, still emit them
        // (their diff is computed against fallbackBaseline). Reachable only
        // with designer-CS-CJK runs — #E2E-1b's guard above already put
        // position-shifted runs back into `ranges` when they were all there was.
        var earlyBaseline = cloneProps(fallbackBaseline) || emptyProps();
        var earlyEmphasis = [];
        _emitDirectOverrideRuns(directOverride, earlyBaseline, earlyEmphasis);
        stats.runsEmphasis = earlyEmphasis.length;
        return {
            baselineWinners: earlyBaseline,
            emphasisRuns: earlyEmphasis,
            stats: stats
        };
    }

    // ── 1. Pick winners per dimension ──────────────────────────────

    // Winners are computed over VISIBLE runs only — blank/whitespace-only runs
    // carry no visible formatting and must not vote (see _isBlankText). This
    // keeps the locked Phase-8B lightest-weight rule but reads it as "lightest
    // VISIBLE weight": a trailing "\n\n" in Whitney Book no longer demotes a
    // uniform Semibold title to Book/Regular. Emphasis-run generation below
    // coalesces blank runs into a neighbor (coalesceBlankEmphasis, default ON)
    // so a differing blank run never becomes a standalone emphasis run.
    // All-blank paragraph → keep `ranges` so it still yields a baseline.
    var winnerRanges = [];
    for (var wri = 0; wri < ranges.length; wri++) {
        if (!_isBlankText(ranges[wri] && ranges[wri].text)) winnerRanges.push(ranges[wri]);
    }
    if (winnerRanges.length === 0) winnerRanges = ranges;

    // fontFamily — most-chars-wins, with optional targetLanguage override
    var fontFamilyWinner = mostCharsWinner(winnerRanges, "fontFamily", null);
    if (!options.editMode && options.targetLanguage) {
        var script = languageToScript(options.targetLanguage);
        if (script) {
            var forced = pickFontByTargetScript(winnerRanges, script);
            if (forced && forced !== fontFamilyWinner) {
                fontFamilyWinner = forced;
                stats.targetLanguageOverride = true;
            }
        }
    }

    // fontStyle — composed from (lightest VISIBLE weight, italic=false)
    var lightestWeight = lightestWeightWinner(winnerRanges);
    var fontStyleWinner = composeFontStyle(lightestWeight, false);

    // most-chars-wins for the rest; bool/baseline_shift use symmetric defaults
    var fontSizeWinner   = mostCharsWinner(winnerRanges, "fontSize",         null);
    var fillColorWinner  = mostCharsWinner(winnerRanges, "fillColor",        fillColorKey);
    var trackingWinner   = mostCharsWinner(winnerRanges, "tracking",         null);
    var hScaleWinner     = mostCharsWinner(winnerRanges, "horizontal_scale", null);
    var vScaleWinner     = mostCharsWinner(winnerRanges, "vertical_scale",   null);

    var baselineWinners = {
        fontFamily:        fontFamilyWinner,
        fontStyle:         fontStyleWinner,
        fontSize:          fontSizeWinner === null   ? 0    : fontSizeWinner,
        fillColor:         fillColorWinner,
        underline:         false,                    // symmetric base
        strikeThrough:     false,                    // symmetric base
        tracking:          trackingWinner === null   ? 0    : trackingWinner,
        baseline_shift:    0,                        // symmetric base
        horizontal_scale:  hScaleWinner === null     ? 100  : hScaleWinner,
        vertical_scale:    vScaleWinner === null     ? 100  : vScaleWinner,
        skew:              0,                        // symmetric base (faux italic)
        position:          "NORMAL"                  // #E2E-1: symmetric base
    };

    // ── 2. Build emphasisRuns: per-range diff vs baselineWinners ──
    //
    // coalesceBlankEmphasis (default ON, user product decision 2026-06-24):
    // whitespace-only runs are format-transparent — queue them and coalesce
    // into a neighbor below (prev format wins, else next) instead of emitting
    // their own format. Flip the flag off to restore the legacy emission where
    // a blank run that differs from baseline is emitted as its own run.
    var coalesceBlanks = options.coalesceBlankEmphasis !== false;

    // Both collections are keyed by ORIGINAL (allRanges) index, and blankIdxs
    // holds only ADMITTED blanks — a blank the filter removed (a designer-CS
    // space) is left alone, never coalesced. Walking `ranges` here but recording
    // original indices is what lets the coalescer scan the unfiltered input.
    var emphasisRuns = [];
    var runByRangeIdx = {};   // allRanges index → emitted emphasis run (non-blank only)
    var blankIdxs = [];       // allRanges indices of admitted blank runs (coalesce mode)
    for (var j = 0; j < ranges.length; j++) {
        var rg = ranges[j];
        var oj = _indexOfRange(allRanges, rg);
        if (coalesceBlanks && _isBlankText(rg && rg.text)) {
            if (oj >= 0) blankIdxs.push(oj);   // never emit a blank run's own format
            continue;
        }
        var diff = diffProps(rg.props, baselineWinners);
        if (diff) {
            var runOut = {
                start: rg.start,
                end:   rg.end,
                diff:  diff
            };
            // #E2E-2: propagate the source character-style name (when the
            // designer applied a named style like "superscript" or
            // "BOLD emphasis") so import can prefer the original style name
            // over the synthetic _T_c_emp_* fingerprint. Lost previously
            // because emphasisRuns only carried `diff`.
            if (rg.hint) runOut.charStyleHint = rg.hint;
            emphasisRuns.push(runOut);
            if (oj >= 0) runByRangeIdx[oj] = runOut;
        }
    }
    // Coalesce blank runs into a contiguous neighbor's emphasis run (or leave
    // them baseline). Runs are mutated in place; the sort below re-orders.
    // NOTE: only ADMITTED ranges can donate — a blank adjacent ONLY to a
    // diverted run finds no donor and stays baseline (still never a fake
    // standalone run), for a chain of blanks of any length. Intentional for
    // both admitters: a designer-CS run carries a real `charStyleHint`, and
    // extending its boundary onto adjacent (invisible) whitespace would
    // over-propagate the CS — counter to the no-auto-propagation policy; a
    // position-shifted run (#E2E-1b) would drag the neighbouring space up into
    // SUPERSCRIPT. Whitespace going baseline instead has no visible effect
    // either way.
    //
    // The scan is handed `allRanges`, NOT the filtered set, which is what makes
    // that NOTE true: a removed run is still present for the scan to stop at,
    // and donates nothing because only admitted ranges populate runByRangeIdx.
    if (coalesceBlanks && blankIdxs.length) {
        _coalesceBlankRuns(allRanges, blankIdxs, runByRangeIdx);
    }
    // Append the queued direct-override runs (#BRIDGE-24 Fix A1 designer-CS
    // CJK + #E2E-1b position-shifted). Their diff is computed against the SAME
    // baselineWinners, so for the CJK case the font flip is the only emitted
    // diff (color etc. continue to come from the designer CS that the apply
    // path keeps intact), and for the position case the shift + whatever size
    // and face the designer chose for it ride along. Blank diverted runs are
    // dropped here rather than emitted — see _emitDirectOverrideRuns.
    _emitDirectOverrideRuns(directOverride, baselineWinners, emphasisRuns);
    // Re-sort by start so downstream consumers see emphasis_runs in
    // text order (matters for offset-shift heuristics and visual diff).
    emphasisRuns.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
    stats.runsEmphasis = emphasisRuns.length;

    return {
        baselineWinners: baselineWinners,
        emphasisRuns:    emphasisRuns,
        stats:           stats
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyProps() {
    return {
        fontFamily: null,
        fontStyle: "Regular",
        fontSize: 0,
        fillColor: null,
        underline: false,
        strikeThrough: false,
        tracking: 0,
        baseline_shift: 0,
        horizontal_scale: 100,
        vertical_scale: 100,
        skew: 0,
        position: "NORMAL"   // #E2E-1
    };
}

function cloneProps(p) {
    if (!p) return null;
    return {
        fontFamily:       p.fontFamily       == null ? null : p.fontFamily,
        fontStyle:        p.fontStyle        == null ? "Regular" : p.fontStyle,
        fontSize:         p.fontSize         == null ? 0    : p.fontSize,
        fillColor:        p.fillColor        == null ? null : p.fillColor,
        underline:        !!p.underline,
        strikeThrough:    !!p.strikeThrough,
        tracking:         p.tracking         == null ? 0    : p.tracking,
        baseline_shift:   p.baseline_shift   == null ? 0    : p.baseline_shift,
        horizontal_scale: p.horizontal_scale == null ? 100  : p.horizontal_scale,
        vertical_scale:   p.vertical_scale   == null ? 100  : p.vertical_scale,
        skew:             p.skew             == null ? 0    : p.skew,
        position:         p.position         == null ? "NORMAL" : p.position  // #E2E-1
    };
}

/**
 * Compute fields where `runProps` differs from `baseline`. Returns null when
 * everything matches (run is fully covered by paragraph baseline).
 */
function diffProps(runProps, baseline) {
    if (!runProps) return null;
    var diff = {};
    var any = false;

    if ((runProps.fontFamily || null) !== (baseline.fontFamily || null)) {
        diff.fontFamily = runProps.fontFamily || null; any = true;
    }
    if ((runProps.fontStyle || "Regular") !== (baseline.fontStyle || "Regular")) {
        diff.fontStyle = runProps.fontStyle || "Regular"; any = true;
    }
    if (Number(runProps.fontSize || 0) !== Number(baseline.fontSize || 0)) {
        diff.fontSize = Number(runProps.fontSize || 0); any = true;
    }
    if (!fillColorEqual(runProps.fillColor, baseline.fillColor)) {
        diff.fillColor = runProps.fillColor || null; any = true;
    }
    if (!!runProps.underline !== !!baseline.underline) {
        diff.underline = !!runProps.underline; any = true;
    }
    if (!!runProps.strikeThrough !== !!baseline.strikeThrough) {
        diff.strikeThrough = !!runProps.strikeThrough; any = true;
    }
    if (Number(runProps.tracking || 0) !== Number(baseline.tracking || 0)) {
        diff.tracking = Number(runProps.tracking || 0); any = true;
    }
    if (Number(runProps.baseline_shift || 0) !== Number(baseline.baseline_shift || 0)) {
        diff.baseline_shift = Number(runProps.baseline_shift || 0); any = true;
    }
    if (Number(runProps.horizontal_scale || 100) !== Number(baseline.horizontal_scale || 100)) {
        diff.horizontal_scale = Number(runProps.horizontal_scale || 100); any = true;
    }
    if (Number(runProps.vertical_scale || 100) !== Number(baseline.vertical_scale || 100)) {
        diff.vertical_scale = Number(runProps.vertical_scale || 100); any = true;
    }
    if (Number(runProps.skew || 0) !== Number(baseline.skew || 0)) {
        diff.skew = Number(runProps.skew || 0); any = true;
    }
    // #E2E-1: position diff. SUPERSCRIPT/SUBSCRIPT etc. set via
    // character.position (NOT through a named character style) was silently
    // dropped before this dim was added — round-trip lost ®* superscripts.
    var runPos  = runProps.position  || "NORMAL";
    var basePos = baseline.position  || "NORMAL";
    if (runPos !== basePos) {
        diff.position = runPos; any = true;
    }
    return any ? diff : null;
}

// ─── Public: full-segment pass ────────────────────────────────────────

/**
 * Walk every segment, for each `format_snapshot._allRanges` (mixed-format
 * paragraph not already handled by Phase 8A script-by-font) call
 * extractEmphasis and rewrite the snapshot:
 *
 *   - format_snapshot.baseline ← baselineWinners
 *   - format_snapshot.emphasisRuns ← extractEmphasis result
 *   - format_snapshot.uniform stays false unless emphasisRuns is empty
 *   - format_snapshot._allRanges left in place — downstream readers should
 *     prefer emphasisRuns (8A still consumes _allRanges directly).
 *
 * @param {Array}  segments
 * @param {Object} options { targetLanguage, editMode }
 *
 * @returns {Object} stats
 *   { processed, skippedScriptByFont, skippedNoRanges,
 *     runsEmphasisTotal, runsSkippedExistingCharStyleTotal,
 *     runsDesignerCSCJKAdmittedTotal, runsPositionShiftedAdmittedTotal,
 *     runsPositionShiftedPutBackTotal, targetLanguageOverrideCount }
 */
function applyEmphasisExtraction(segments, options) {
    var stats = {
        processed: 0,
        skippedScriptByFont: 0,
        skippedNoRanges: 0,
        skippedAlreadyExtracted: 0,
        runsEmphasisTotal: 0,
        runsSkippedExistingCharStyleTotal: 0,
        // Both direct-override admitters, aggregated so a package-level report
        // can show how often each channel fires on live documents. Previously
        // per-paragraph only, i.e. invisible to every caller.
        runsDesignerCSCJKAdmittedTotal: 0,      // #BRIDGE-24 A1
        runsPositionShiftedAdmittedTotal: 0,    // #E2E-1b — via directOverride
        runsPositionShiftedPutBackTotal: 0,     // #E2E-1b — degenerate put-back
        targetLanguageOverrideCount: 0
    };
    if (!segments) return stats;

    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (!seg || !seg.format_snapshot) continue;
        var fs = seg.format_snapshot;

        // Already handled by Phase 8A — script-by-font segments now read as
        // uniform=true with scriptByFont metadata; routing to GREP rules.
        if (fs.scriptByFont) {
            stats.skippedScriptByFont++;
            continue;
        }
        // Idempotency gate — export-side 8B already populated emphasisRuns
        // (or v2_pipeline restored it from emphasis_runs in segments.json).
        // Re-running here would overwrite winners with the same data, so
        // skip. Empty array is still "extracted" (intentional null result).
        if (fs.emphasisRuns) {
            stats.skippedAlreadyExtracted++;
            continue;
        }
        if (fs.uniform !== false) continue;

        // Need full per-range props. visual_snapshot.captureFormatSnapshot is
        // expected to have already attached `_allRanges` with `props` + `hint`
        // when uniform=false. Older snapshots without props get skipped.
        if (!fs._allRanges || !fs._allRanges.length) {
            stats.skippedNoRanges++;
            continue;
        }
        // Skip if first range has no props (legacy capture format)
        if (!fs._allRanges[0].props) {
            stats.skippedNoRanges++;
            continue;
        }

        var result = extractEmphasis(fs._allRanges, fs.baseline, options);

        // Rewrite snapshot with winners + emphasisRuns
        fs.baseline = mergeBaselineIntoSnapshot(fs.baseline, result.baselineWinners);
        fs.emphasisRuns = result.emphasisRuns;
        if (result.emphasisRuns.length === 0) {
            fs.uniform = true;
            fs.runs = [];
        }

        stats.processed++;
        stats.runsEmphasisTotal += result.stats.runsEmphasis;
        stats.runsSkippedExistingCharStyleTotal += result.stats.runsSkippedExistingCharStyle;
        stats.runsDesignerCSCJKAdmittedTotal += result.stats.runsDesignerCSCJKAdmitted;
        stats.runsPositionShiftedAdmittedTotal += result.stats.runsPositionShiftedAdmitted;
        stats.runsPositionShiftedPutBackTotal += result.stats.runsPositionShiftedPutBack;
        if (result.stats.targetLanguageOverride) stats.targetLanguageOverrideCount++;
    }
    return stats;
}

/**
 * Merge winner-derived fields into the existing baseline object so we keep
 * incidental fields (e.g. charStyleHint) that visual_snapshot may have
 * attached. winners take precedence on conflicting fields.
 */
function mergeBaselineIntoSnapshot(existing, winners) {
    var merged = cloneProps(existing) || emptyProps();
    merged.fontFamily       = winners.fontFamily;
    merged.fontStyle        = winners.fontStyle;
    merged.fontSize         = winners.fontSize;
    merged.fillColor        = winners.fillColor;
    merged.underline        = winners.underline;
    merged.strikeThrough    = winners.strikeThrough;
    merged.tracking         = winners.tracking;
    merged.baseline_shift   = winners.baseline_shift;
    merged.horizontal_scale = winners.horizontal_scale;
    merged.vertical_scale   = winners.vertical_scale;
    merged.skew             = winners.skew;
    merged.position         = winners.position || "NORMAL";  // #E2E-1
    if (existing && existing.charStyleHint) merged.charStyleHint = existing.charStyleHint;
    return merged;
}

module.exports = {
    extractEmphasis:          extractEmphasis,
    applyEmphasisExtraction:  applyEmphasisExtraction,
    parseFontStyle:           parseFontStyle,
    composeFontStyle:         composeFontStyle,
    rankWeight:               rankWeight,
    languageToScript:         languageToScript,
    SELF_MARKED_PREFIXES:     SELF_MARKED_PREFIXES,
    // exposed for tests
    _internal: {
        WEIGHT_RANK:                 WEIGHT_RANK,
        mostCharsWinner:             mostCharsWinner,
        lightestWeightWinner:        lightestWeightWinner,
        diffProps:                   diffProps,
        fillColorKey:                fillColorKey,
        pickFontByTargetScript:      pickFontByTargetScript,
        classifyFontFamilyByScript:  classifyFontFamilyByScript,
        cloneProps:                  cloneProps,
        emptyProps:                  emptyProps,
        isSelfMarkedHint:            _isSelfMarkedHint,
        isBlankText:                 _isBlankText,
        nearestNonBlankIdx:          _nearestNonBlankIdx,
        coalesceBlankRuns:           _coalesceBlankRuns
    }
};
