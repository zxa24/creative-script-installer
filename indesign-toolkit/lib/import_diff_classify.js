"use strict";

/**
 * lib/import_diff_classify.js
 *
 * Route each translation row to one of three buckets, given the prior
 * import state and live doc info:
 *
 *   noop      — target_text + emphasis identical to last applied → no work
 *   textOnly  — text and/or char-level emphasis changed, but paragraph
 *               format is stable AND the doc's live paragraph style still
 *               matches what we recorded → write text + repaint CS only,
 *               never touch appliedParagraphStyle
 *   full      — anything else; falls through to buildStylePlan /
 *               commitStylePlan / cluster assign (existing v2 pipeline)
 *
 * Pure logic; no UXP / InDesign deps. Caller is responsible for resolving
 * each TID's live paragraph style name and (eventually) re-extracting a
 * fingerprint from segments.json. Both are passed in as a function and
 * an object so this module is fully node-testable.
 *
 * Usage:
 *
 *   var DC = require("./lib/import_diff_classify.js");
 *   var verdict = DC.classify({
 *     translations:  payload.translations,
 *     sidecarState:  store.read(doc),                // null if first-time
 *     // (segmentsByTid kept in signature for backward compat but unused —
 *     // see live_fingerprint note below)
 *     liveLookupByTid: function (tid) {              // doc-side resolver
 *       // MUST return both keys when available:
 *       //   paragraph_style_name — for ps-rename detection
 *       //   live_fingerprint     — djb2 of paragraph.appliedParagraphStyle's
 *       //                          actual properties at this moment;
 *       //                          stable across imports when no manual
 *       //                          restyle happened. NULL is acceptable
 *       //                          (= skip fingerprint check).
 *       return { paragraph_style_name: "...", live_fingerprint: "abc123" };
 *     }
 *   });
 *
 *   verdict.noop      // array of tid strings
 *   verdict.textOnly  // array
 *   verdict.full      // array
 *   verdict.skipped   // array of { tid, reason } — non-translatable rows
 *   verdict.perTid    // map tid → { bucket, reason, ... }
 *   verdict.stats     // { noop, textOnly, full, skipped, total, missingPrev, ... }
 *
 * Caller can also use `DC.computeAppliedHash(text, emphasisRuns)` after
 * apply to build the new sidecar entries.
 */

// ---------------------------------------------------------------------------
// Hash + normalization
// ---------------------------------------------------------------------------

function djb2Hex(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
}

function _normalizeText(t) {
    if (t === null || t === undefined) return "";
    var s = String(t);
    // Normalize line endings (CRLF / CR → LF) so an export-then-reimport
    // doesn't show false-positive diffs from invisible CR insertion.
    s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Strip trailing newline (paragraph mark is implicit in segment text)
    while (s.length > 0 && s.charCodeAt(s.length - 1) === 10) s = s.substring(0, s.length - 1);
    return s;
}

function _normalizeEmphasisRuns(runs) {
    if (!runs || !runs.length) return [];
    var copy = [];
    for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        if (!r) continue;
        // Capture canonical projection: start, end, sorted diff keys.
        var diffKeys = r.diff ? Object.keys(r.diff).slice().sort() : [];
        var canonDiff = {};
        for (var k = 0; k < diffKeys.length; k++) canonDiff[diffKeys[k]] = r.diff[diffKeys[k]];
        copy.push({
            start: typeof r.start === "number" ? r.start : -1,
            end:   typeof r.end === "number" ? r.end : -1,
            diff:  canonDiff
        });
    }
    copy.sort(function (a, b) {
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
    });
    return copy;
}

/**
 * computeAppliedHash(target_text, target_emphasis_runs) → hex string
 *
 * The canonical fingerprint of "what would get applied if this row went
 * through edit-apply". Stable under CRLF / run-ordering noise.
 */
function computeAppliedHash(text, emphasisRuns) {
    var normText = _normalizeText(text);
    var normRuns = _normalizeEmphasisRuns(emphasisRuns);
    var key = normText + "" + JSON.stringify(normRuns);
    return djb2Hex(key);
}

/**
 * appliedHashMatchesText(entry, text) → bool   (#62 B②)
 *
 * "Is `text` the text this sidecar entry recorded as applied?"
 *
 * Used by the segment locator to recognise a paragraph as the one a PREVIOUS
 * import wrote for this tid, when the incoming package's `source_hash` can no
 * longer match (it hashes the ORIGINAL source language, while the paragraph
 * now holds the previous round's translation — the whole of #62).
 *
 * 🔴 Lives HERE, not in the locator, and takes the text rather than exposing
 * the normaliser, because `applied_hash` is a COMPOSITE key —
 * `_normalizeText(text) + "\x1f" + JSON.stringify(normalisedRuns)` — built
 * with THIS module's `_normalizeText` (CRLF→LF plus trailing-newline strip).
 * The locator's own `_normalizeForHash` is a DIFFERENT normaliser (it collapses
 * every whitespace run to a single space and trims), so a hash computed with it
 * would silently never match. Anyone tempted to "just reuse the one already in
 * segment_locator" would produce a predicate that is quietly always false.
 * Keeping the construction in one module makes that mistake unavailable.
 *
 * ⚠ RECONSTRUCTIBILITY LIMIT — deliberate, not an oversight:
 * the composite key embeds the emphasis runs, and the entry stores only their
 * COUNT, not the runs themselves. So the key can only be rebuilt when that
 * count is zero (`JSON.stringify([]) === "[]"`). For an entry with runs we
 * return false — an explicit FALL-THROUGH to the caller's existing strategy
 * chain, never a silent "match". Measured on a real document 2026-08-22:
 * 103 of 107 entries carry zero runs, so the limit costs ~4%.
 */
function appliedHashMatchesText(entry, text) {
    if (!entry || typeof entry !== "object") return false;
    if (!entry.applied_hash) return false;
    if (Number(entry.applied_emphasis_run_count) !== 0) return false;   // cannot rebuild → fall through
    // The text is read with the RECORD's own normaliser (_normalizeLiveText = what
    // computeAppliedHash does to a target, plus U+2028 → LF): line endings unified, the
    // paragraph mark dropped, every other character exact. One function for both sides
    // (arch 2026-10-03) — the locator used to hand in ITS OWN normalised text (trimmed,
    // breaks turned into spaces), so a recorded target ending in a space or holding a
    // forced line break could never match (findings
    // #english-package-onto-translated-doc-rows-not-located).
    return computeAppliedHash(_normalizeLiveText(text), []) === entry.applied_hash;
}

// ---------------------------------------------------------------------------
// #ac-emphasis-relations batch 2 (task_plan §7.6 R-0 (c) · owner OD-E20 = B):
// the translator's hand-marked bold / italic is part of "what changed".
// ---------------------------------------------------------------------------

// Fingerprint of a row's manual bold / italic format annotations: non-_auto,
// type "format", action bold|italic, cut into non-overlapping sub-ranges each
// with its dimension set ⇒ duplicates / overlaps / array order do not matter.
// Serialized [[start, endExclusive, "b"|"i"|"bi"], …] → djb2. No such
// annotation ⇒ the fingerprint of the empty list (still a value — a legacy
// entry is recognised by the FIELD being absent, not by an empty value).
// ⛔ Kept out of applied_hash: appliedHashMatchesText rebuilds that key from
// text alone (#62 locator); folding annotations in would break it.
function computeFmtAnnotationFingerprint(annotations) {
    var marks = [];
    var list = Array.isArray(annotations) ? annotations : [];
    for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a || a._auto === true || a.type !== "format") continue;
        if (a.action !== "bold" && a.action !== "italic") continue;
        if (typeof a.offset !== "number" || typeof a.length !== "number" || a.length <= 0 || a.offset < 0) continue;
        marks.push({ s: a.offset, e: a.offset + a.length, d: a.action === "bold" ? "b" : "i" });
    }
    var cuts = {};
    marks.forEach(function (m) { cuts[m.s] = true; cuts[m.e] = true; });
    var pts = Object.keys(cuts).map(Number).sort(function (x, y) { return x - y; });
    var segs = [];
    for (var p = 0; p + 1 < pts.length; p++) {
        var s = pts[p], e = pts[p + 1], b = false, it = false;
        for (var k = 0; k < marks.length; k++) {
            if (marks[k].s <= s && marks[k].e >= e) { if (marks[k].d === "b") b = true; else it = true; }
        }
        if (!b && !it) continue;
        var dim = (b ? "b" : "") + (it ? "i" : "");
        var last = segs[segs.length - 1];
        if (last && last[1] === s && last[2] === dim) last[1] = e;
        else segs.push([s, e, dim]);
    }
    return djb2Hex(JSON.stringify(segs));
}

// Fingerprint of the brand-config parts the emphasis landing reads (owner
// OD-E22 default A: a change here re-writes rows that carry manual bold /
// italic). Parts: pairs, equivalence_groups, emphasis_relations,
// emphasis_foreign_family, italic_by_weight, and the italic-copy fields of
// fonts_by_language entries. Key order is canonicalised. null config ⇒ null.
function _canonJson(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return "[" + v.map(_canonJson).join(",") + "]";
    var ks = Object.keys(v).sort();
    return "{" + ks.map(function (k) { return JSON.stringify(k) + ":" + _canonJson(v[k]); }).join(",") + "}";
}
var EMPTY_FMT_FP = computeFmtAnnotationFingerprint([]);   // "no manual bold / italic"
function computeEmphasisConfigFingerprint(config) {
    if (!config || typeof config !== "object") return null;
    var copies = {};
    var fbl = config.fonts_by_language || {};
    Object.keys(fbl).sort().forEach(function (lang) {
        (Array.isArray(fbl[lang]) ? fbl[lang] : []).forEach(function (fw) {
            if (fw && (fw.copy_of !== undefined || fw.angle !== undefined)) {
                (copies[lang] = copies[lang] || []).push({ font: fw.font, weight: fw.weight, copy_of: fw.copy_of, angle: fw.angle });
            }
        });
    });
    return djb2Hex(_canonJson({
        pairs: config.pairs || null,
        equivalence_groups: config.equivalence_groups || null,
        emphasis_relations: config.emphasis_relations || null,
        emphasis_foreign_family: config.emphasis_foreign_family || null,
        italic_by_weight: config.italic_by_weight || null,
        copies: copies
    }));
}

// ---------------------------------------------------------------------------
// Fingerprint extraction (paragraph-level format identity)
// ---------------------------------------------------------------------------

// Pull a minimal projection of "para-level format that affects cluster
// identity" from a segment's format_snapshot. NOT a full re-implementation
// of the cluster fingerprint hash used by style_sheet_builder — this is
// a stability check: if any of these change, paragraph style is no longer
// safe to reuse and we escalate to full.
//
// Returned as a sorted JSON string so equality is structural.
function _paraFormatFingerprint(segmentSnap) {
    if (!segmentSnap) return null;
    var fs = segmentSnap.format_snapshot;
    var ps = segmentSnap.paragraph_snapshot;
    if (!fs && !ps) return null;
    var sig = {};
    if (fs && fs.baseline) {
        sig.b_family    = fs.baseline.fontFamily || null;
        sig.b_style     = fs.baseline.fontStyle || null;
        sig.b_size      = fs.baseline.fontSize || null;
        // Color: use swatch name + CMYK/RGB values
        if (fs.baseline.fillColor) {
            sig.b_color = (fs.baseline.fillColor.swatch || "")
                + ":" + (fs.baseline.fillColor.values || []).join(",");
        }
        sig.b_underline    = !!fs.baseline.underline;
        sig.b_strike       = !!fs.baseline.strikeThrough;
    }
    if (ps) {
        sig.p_just     = ps.justification || null;
        sig.p_leading  = ps.leading || null;
        sig.p_spB      = ps.space_before || 0;
        sig.p_spA      = ps.space_after || 0;
        sig.p_indL     = ps.left_indent || 0;
        sig.p_indR     = ps.right_indent || 0;
        sig.p_indFL    = ps.first_line_indent || 0;
        sig.p_bullets  = ps.bullets_and_numbering_type || "NO_LIST";
        sig.p_ruleA    = !!(ps.rule_above && ps.rule_above.active);
        sig.p_ruleB    = !!(ps.rule_below && ps.rule_below.active);
    }
    // Deterministic key order
    var keys = Object.keys(sig).sort();
    var out = {};
    for (var i = 0; i < keys.length; i++) out[keys[i]] = sig[keys[i]];
    return JSON.stringify(out);
}

// Lightweight 8-char hex digest of the segments.json snapshot, kept exported
// for tests but NOT used by classify() anymore — the classify path now relies
// on live-style fingerprints (see computeLiveStyleFingerprint).
function computeFingerprint(segmentSnap) {
    var sig = _paraFormatFingerprint(segmentSnap);
    if (!sig) return null;
    return djb2Hex(sig);
}

// Hash of LIVE applied paragraph style properties. Caller (v2_pipeline) reads
// these off `paragraph.appliedParagraphStyle` at classify-time AND at
// label-write-time so the same fingerprint scheme is used on both sides of
// the round-trip. Inputs:
//   {
//     fontFamily, fontStyle, pointSize, fillColor (any displayable form),
//     leading, justification, spaceBefore, spaceAfter,
//     leftIndent, rightIndent, firstLineIndent
//   }
// Missing fields are tolerated (default = "" / 0); the hash is deterministic
// because we sort keys.
function computeLiveStyleFingerprint(props) {
    if (!props || typeof props !== "object") return null;
    var FIELDS = [
        "fontFamily", "fontStyle", "pointSize", "fillColor",
        "leading", "justification",
        "spaceBefore", "spaceAfter",
        "leftIndent", "rightIndent", "firstLineIndent"
    ];
    var canon = {};
    for (var i = 0; i < FIELDS.length; i++) {
        var k = FIELDS[i];
        var v = props[k];
        if (v === undefined || v === null) canon[k] = "";
        else if (typeof v === "number") canon[k] = (Math.round(v * 1000) / 1000); // 3 decimal stability
        else canon[k] = String(v);
    }
    return djb2Hex(JSON.stringify(canon));
}

// ---------------------------------------------------------------------------
// classify()
// ---------------------------------------------------------------------------

function _shouldSkipRow(row) {
    if (!row || !row.tid) return { skip: true, reason: "no tid" };
    // Explicit non-translatable / explicitly skipped rows: never process.
    if (row.status === "skip" || row.translatable === false) {
        return { skip: true, reason: "status=skip / not translatable" };
    }
    // status="todo" with empty target_text: translator left it blank.
    // Don't classify these as textOnly — they would otherwise route the
    // empty string into apply (which is a no-op via hasTarget=false guard
    // downstream, but cleaner to skip here so the bucket counts reflect
    // intent). Empty target_text with status="translated" IS a real signal
    // (translator deliberately cleared) and falls through to classify.
    var hasTarget = row.target_text !== undefined && row.target_text !== null && String(row.target_text).length > 0;
    if (!hasTarget && (!row.status || row.status === "todo")) {
        return { skip: true, reason: "empty target_text + status todo" };
    }
    return { skip: false };
}

// D1 (owner 2026-10-01 ①A): "did this row change?" is judged against the text the
// paragraph holds NOW, not only against what the last import recorded. Two ways the
// recorded hash lies: a later step rewrote the paragraph (cjk_style_apply removed the
// CJK–Latin spaces the 9-24 import wrote — the translator then "adds" them back, the
// package equals the record ⇒ noop ⇒ never written, DocX-1 ③), or someone already put
// the new text in by hand. Comparison: line endings / U+2028 → LF and the trailing
// paragraph mark dropped (same as _normalizeText); every other character exact —
// spaces are the very thing that went missing.
function _normalizeLiveText(t) {
    return _normalizeText(t === null || t === undefined ? t : String(t).replace(/\u2028/g, "\n"));
}

// The row states the translator's own emphasis (non-auto runs / an explicit "none",
// or hand-marked bold / italic annotations): equal text does not mean nothing to do,
// so the live-text shortcut to noop is not taken (the existing comparison decides).
function _rowStatesEmphasis(row) {
    if (!row) return false;
    var AFG = require("./auto_format_gate.js");
    if (Array.isArray(row.target_emphasis_runs) && !AFG.isAutoEmphasisRuns(row)
            && (row.target_emphasis_runs.length > 0 || row.target_emphasis_runs_user_set === true)) return true;
    var anns = Array.isArray(row.annotations) ? row.annotations : [];
    for (var i = 0; i < anns.length; i++) {
        var a = anns[i];
        if (a && a.type === "format" && (a.action === "bold" || a.action === "italic") && !AFG.isAutoAnnotation(a)) return true;
    }
    return false;
}

/**
 * priorBySourceTid(stateSegments) -> { tid: entry }
 *
 * The import state is keyed by the tid a row has in the TRANSLATED document (the
 * fallback tid encodes a character offset, and offsets move when text is translated);
 * each entry keeps the tid the package used as `src_tid`. A second import brings the
 * package's tids again, so a prior record must be looked up by src_tid. Index by both,
 * src_tid wins: a package tid can coincide with ANOTHER row's re-keyed tid, and then
 * the direct key names the wrong row.
 *
 * One function for the locator (which already did this, v2_pipeline #62 B②) and for
 * classify (which looked up `segments[tid]` directly, so every re-keyed row read as
 * "no prior state" — 17 rows on DocX-1 Product-8; findings
 * #rekeyed-rows-read-as-no-prior-state).
 */
function priorBySourceTid(stateSegments) {
    var out = {}, segs = stateSegments || {}, keys = Object.keys(segs), i;
    for (i = 0; i < keys.length; i++) out[keys[i]] = segs[keys[i]];
    for (i = 0; i < keys.length; i++) {
        var e = segs[keys[i]];
        if (e && e.src_tid) out[e.src_tid] = e;
    }
    return out;
}

function classify(args) {
    args = args || {};
    var rows = args.translations || [];
    var sidecar = args.sidecarState;            // may be null on first import
    var segByTid = args.segmentsByTid || {};
    var liveLookup = args.liveLookupByTid || function () { return null; };
    // D1: tid → the paragraph's current text, or null/undefined when unknown
    // (then the row is judged exactly as before).
    var liveTextOf = args.liveTextByTid || function () { return null; };

    var sidecarSegs = priorBySourceTid(sidecar && sidecar.segments);   // by the package's tid (src_tid wins)

    var verdict = {
        noop: [],
        textOnly: [],
        full: [],
        skipped: [],
        perTid: {},
        stats: {
            total: rows.length,
            noop: 0,
            textOnly: 0,
            full: 0,
            skipped: 0,
            missingPrev: 0,
            psNameMismatch: 0,
            fingerprintChanged: 0,
            liveLookupFailed: 0,
            // #67 A0: rows the PREVIOUS import recorded as seen-but-not-applied.
            priorNotApplied: 0,
            // D1: decided by the paragraph's current text
            liveTextEqual: 0,
            liveTextDiffers: 0,
            // #ac-emphasis-relations batch 2
            fmtAnnotationChanged: 0,
            emphasisConfigChanged: 0,
            legacyFmtBaseline: 0
        },
        // #ac-emphasis-relations batch 2 (OD-E18 = A): legacy entries judged noop
        // that carry manual bold / italic now — their annotations may have changed.
        legacyNoopWithManualFmt: []
    };
    var __rowFmt = {};   // tid → { fmtChanged, prevFmtFpEmpty } for rows that fall through

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var sk = _shouldSkipRow(row);
        if (sk.skip) {
            verdict.skipped.push({ tid: row && row.tid, reason: sk.reason });
            verdict.stats.skipped++;
            verdict.perTid[row && row.tid] = { bucket: "skipped", reason: sk.reason };
            continue;
        }

        var tid = row.tid;
        var newHash = computeAppliedHash(row.target_text, row.target_emphasis_runs);
        var prev = sidecarSegs[tid];

        // D1: the paragraph already holds exactly this text ⇒ nothing to write,
        // whatever the record says (no record / older record included).
        var liveText = null;
        try { liveText = liveTextOf(tid); } catch (eLt) { liveText = null; }
        var liveKnown = (liveText !== null && liveText !== undefined);
        var liveSame = liveKnown && _normalizeLiveText(liveText) === _normalizeLiveText(row.target_text);
        // trial-1.2 merge (importfix D1 x emphrel batch 2, OD-E20 B): a row whose last
        // import landed manual bold / italic and whose package now has NONE (the
        // translator removed them) states no emphasis, yet must still be rewritten so
        // the removal lands — it is not "nothing to write".
        var fmtMarksRemoved = !!prev && prev.applied !== false
            && Object.prototype.hasOwnProperty.call(prev, "applied_fmt_fp")
            && prev.applied_fmt_fp !== EMPTY_FMT_FP
            && computeFmtAnnotationFingerprint(row.annotations) === EMPTY_FMT_FP;
        if (liveSame && !_rowStatesEmphasis(row) && !fmtMarksRemoved) {
            verdict.noop.push(tid);
            verdict.stats.noop++;
            verdict.stats.liveTextEqual++;
            verdict.perTid[tid] = { bucket: "noop", reason: "live text equals target", newHash: newHash };
            continue;
        }

        if (!prev) {
            verdict.full.push(tid);
            verdict.stats.full++;
            verdict.stats.missingPrev++;
            verdict.perTid[tid] = { bucket: "full", reason: "no prior state", newHash: newHash };
            continue;
        }

        // #67 A0: a row the previous import saw but did NOT apply. Such an entry
        // deliberately carries no `applied_hash`, so the comparison below would
        // already fall through to `full` on its own — but it would land there
        // wearing a reason like "live lookup failed", which describes THIS run
        // rather than the truth ("last run never wrote this"). Name it, because a
        // reason that misattributes the cause is how #62 stayed invisible.
        if (prev.applied === false) {
            verdict.full.push(tid);
            verdict.stats.full++;
            verdict.stats.priorNotApplied++;
            verdict.perTid[tid] = {
                bucket: "full",
                reason: "prior import did not apply this row (" + (prev.not_applied_reason || "unknown") + ")",
                newHash: newHash
            };
            continue;
        }

        // #ac-emphasis-relations batch 2 (R-0 (c)):
        //   OD-E20 = B — manual format annotations changed ⇒ rewrite, like a text change;
        //   OD-E22 = A (default, owner may change) — the emphasis config changed and the
        //     row carries manual bold / italic ⇒ rewrite;
        //   OD-E23 = A (default, owner may change) — such a row (text unchanged) goes
        //     to `full`, i.e. its paragraph style is re-applied too.
        //   OD-E18 = A — an entry without `applied_fmt_fp` (older build) keeps the old
        //     formula (hash only); counted so the report can say so once.
        var newFmtFp = computeFmtAnnotationFingerprint(row.annotations);
        __rowFmt[tid] = { fmtChanged: null, prevFmtFpEmpty: prev.applied_fmt_fp === EMPTY_FMT_FP };
        var hasManualFmt = newFmtFp !== EMPTY_FMT_FP;
        var legacyFmt = !Object.prototype.hasOwnProperty.call(prev, "applied_fmt_fp");
        var fmtChanged = !legacyFmt && prev.applied_fmt_fp !== newFmtFp;
        var cfgChanged = !legacyFmt && hasManualFmt && !!args.emphasisConfigFp
            && Object.prototype.hasOwnProperty.call(prev, "applied_cfg_fp")
            && prev.applied_cfg_fp !== args.emphasisConfigFp;
        __rowFmt[tid].fmtChanged = fmtChanged;
        if (legacyFmt) {
            verdict.stats.legacyFmtBaseline++;
            if (prev.applied_hash === newHash && hasManualFmt) verdict.legacyNoopWithManualFmt.push(tid);
        }
        if (prev.applied_hash === newHash && liveKnown && !liveSame && !fmtChanged && !cfgChanged) {
            // D1: the package is what the last import wrote, but the paragraph no
            // longer holds it (rewritten after that import) ⇒ write it again.
            // trial-1.2 merge (importfix D1 x emphrel batch 2): a row whose manual format
            // annotations or emphasis config ALSO changed is left to the `full` branch below
            // (OD-E20 B / E22 A), which rewrites the text too — so both changes land.
            verdict.textOnly.push(tid);
            verdict.stats.textOnly++;
            verdict.stats.liveTextDiffers++;
            verdict.perTid[tid] = { bucket: "textOnly", reason: "live text differs from target (changed after the last import)",
                newHash: newHash };
            continue;
        }
        if (prev.applied_hash === newHash) {
            if (fmtChanged || cfgChanged) {
                var why = fmtChanged ? "manual format annotations changed" : "emphasis config changed";
                if (fmtChanged) verdict.stats.fmtAnnotationChanged++; else verdict.stats.emphasisConfigChanged++;
                verdict.full.push(tid);
                verdict.stats.full++;
                verdict.perTid[tid] = { bucket: "full", reason: why, newHash: newHash,
                    fmtChanged: fmtChanged, cfgChanged: cfgChanged, hashChanged: false,
                    prevFmtFpEmpty: prev.applied_fmt_fp === EMPTY_FMT_FP };
                continue;
            }
            verdict.noop.push(tid);
            verdict.stats.noop++;
            verdict.perTid[tid] = { bucket: "noop", reason: "hash match", newHash: newHash, legacyFmt: legacyFmt };
            continue;
        }

        // Hash differs → check whether the doc-side cluster style is still
        // the one we recorded. Anything that drifted → full.
        var live = null;
        try { live = liveLookup(tid); } catch (e) { live = null; }
        if (!live || !live.paragraph_style_name) {
            verdict.full.push(tid);
            verdict.stats.full++;
            verdict.stats.liveLookupFailed++;
            verdict.perTid[tid] = {
                bucket: "full", reason: "live lookup failed", newHash: newHash
            };
            continue;
        }
        if (prev.applied_paragraph_style && live.paragraph_style_name !== prev.applied_paragraph_style) {
            verdict.full.push(tid);
            verdict.stats.full++;
            verdict.stats.psNameMismatch++;
            verdict.perTid[tid] = {
                bucket: "full",
                reason: "live PS mismatch (" + live.paragraph_style_name + " vs " + prev.applied_paragraph_style + ")",
                newHash: newHash,
                liveStyle: live.paragraph_style_name,
                prevStyle: prev.applied_paragraph_style
            };
            continue;
        }

        // Fingerprint check: compare live applied style fingerprint against
        // stored. live.live_fingerprint is computed by the caller from the
        // doc's CURRENT paragraph.appliedParagraphStyle properties (not from
        // segments.json) — so it reflects the cluster-style-applied state,
        // not the pre-cluster source state. This is what stays stable across
        // imports when no manual restyling happened.
        //
        // (Earlier version used computeFingerprint(segByTid[tid]) here, but
        // that was input-snapshot-based: import N-1 had source A=10.1 →
        // cluster applied → A=10. Stored fp came from segments.json A=10.1.
        // Import N's new segments.json captures A=10 (post-import-N-1) →
        // fp differs even though nothing actually changed. False escalation.)
        var liveFp = live && live.live_fingerprint;
        if (prev.cluster_fingerprint && liveFp && liveFp !== prev.cluster_fingerprint) {
            verdict.full.push(tid);
            verdict.stats.full++;
            verdict.stats.fingerprintChanged++;
            verdict.perTid[tid] = {
                bucket: "full",
                reason: "live style fingerprint changed (" + prev.cluster_fingerprint + " → " + liveFp + ")",
                newHash: newHash,
                liveFingerprint: liveFp
            };
            continue;
        }

        verdict.textOnly.push(tid);
        verdict.stats.textOnly++;
        verdict.perTid[tid] = {
            bucket: "textOnly",
            reason: "text/emphasis diff, paragraph format stable",
            newHash: newHash,
            liveFingerprint: liveFp || null
        };
    }

    // #ac-emphasis-relations batch 2: rows that fell through on a HASH change carry
    // the flags the pipeline needs (OD-E21 clearing, prior_direct_not_cleared).
    Object.keys(__rowFmt).forEach(function (t) {
        var pt = verdict.perTid[t];
        if (!pt || pt.hashChanged !== undefined) return;
        if (pt.bucket !== "textOnly" && pt.bucket !== "full") return;
        pt.hashChanged = true;
        pt.fmtChanged = !!__rowFmt[t].fmtChanged;
        pt.prevFmtFpEmpty = __rowFmt[t].prevFmtFpEmpty;
    });

    return verdict;
}

module.exports = {
    classify: classify,
    computeAppliedHash: computeAppliedHash,
    appliedHashMatchesText: appliedHashMatchesText,
    priorBySourceTid: priorBySourceTid,
    computeFingerprint: computeFingerprint,
    computeLiveStyleFingerprint: computeLiveStyleFingerprint,
    computeFmtAnnotationFingerprint: computeFmtAnnotationFingerprint,
    computeEmphasisConfigFingerprint: computeEmphasisConfigFingerprint,
    EMPTY_FMT_FP: EMPTY_FMT_FP,
    _internal: {
        normalizeText: _normalizeText,
        normalizeLiveText: _normalizeLiveText,
        rowStatesEmphasis: _rowStatesEmphasis,
        normalizeEmphasisRuns: _normalizeEmphasisRuns,
        paraFormatFingerprint: _paraFormatFingerprint,
        djb2Hex: djb2Hex
    }
};
