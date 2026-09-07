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
    return computeAppliedHash(text, []) === entry.applied_hash;
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

function classify(args) {
    args = args || {};
    var rows = args.translations || [];
    var sidecar = args.sidecarState;            // may be null on first import
    var segByTid = args.segmentsByTid || {};
    var liveLookup = args.liveLookupByTid || function () { return null; };

    var sidecarSegs = (sidecar && sidecar.segments) || {};

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
            priorNotApplied: 0
        }
    };

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

        if (prev.applied_hash === newHash) {
            verdict.noop.push(tid);
            verdict.stats.noop++;
            verdict.perTid[tid] = { bucket: "noop", reason: "hash match", newHash: newHash };
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

    return verdict;
}

module.exports = {
    classify: classify,
    computeAppliedHash: computeAppliedHash,
    appliedHashMatchesText: appliedHashMatchesText,
    computeFingerprint: computeFingerprint,
    computeLiveStyleFingerprint: computeLiveStyleFingerprint,
    _internal: {
        normalizeText: _normalizeText,
        normalizeEmphasisRuns: _normalizeEmphasisRuns,
        paraFormatFingerprint: _paraFormatFingerprint,
        djb2Hex: djb2Hex
    }
};
