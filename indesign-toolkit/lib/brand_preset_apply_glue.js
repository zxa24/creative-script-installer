"use strict";

/**
 * brand_preset_apply_glue.js — PURE glue for apply_brand_style_preset.idjs (the
 * APPLY half of 8D-ext-G operator #7). Companion to brand_preset_export_glue.js
 * (#2, EXPORT) and style_config_io.js (#1, the serialization/logic CORE).
 *
 * The host-dependent work (resolve active doc, force-POINTS doScript, live
 * ParagraphStyle reads + WRITES, read-back via captureColor/captureRule, fs read,
 * dir listing, insertLabel drift stamp) lives in the .idjs operator. THIS module
 * is the pure, Node-testable orchestration the operator wires together:
 *   - apply-side preset DISCOVERY resolution (mirrors the pinned contract #3 by
 *     CALLING the SHARED brand_preset_export_glue.pickPreset — never recomputes
 *     Doc-2's stem)
 *   - per-stub match-outcome classification (decision-C 4-outcome) via #1's
 *     deriveMatchKey + resolveMatch
 *   - per-stub per-dim reconciliation PLAN (which dims to write / keep-local /
 *     no-baseline / always-apply) via #1's reconcileDim + resolveConflict +
 *     classifyDim — the host then executes the writes + read-backs
 *   - near-miss qual_key suggestion matching, low-reuse diagnostic, and the
 *     coverage-report builder
 * No host I/O, no app/doc — every host touch is injected; the logic is fully
 * fixture-able and bit-identical to what the operator runs.
 *
 * It REQUIRES #1 (style_config_io) and #2 (brand_preset_export_glue) and never
 * re-implements their logic. The discovery tier (b) is the IDENTICAL pickPreset
 * the export side's basename is written for — so a basename mismatch never
 * breaks the round trip (cross-operator discovery contract #3, task_plan.md:2612).
 *
 * UXP / ES5: var only, function expressions, explicit loops. No path.* (UXP
 * denylisted) — join/basename via the shared glue's separator detection.
 *
 * Spec SoT: task_plan.md "### 8D-ext-G" (match 算法 :2597-2602, conflict 语义
 * :2622-2660, 持久化 + discovery contract #3 :2604-2616, coverage/复用率 :2698).
 */

var SCIO = require("./style_config_io.js");
var GLUE = require("./brand_preset_export_glue.js");

// ─── path helpers (reuse the shared glue's sep detection; no path.*) ──

function _join(dir, file) {
    var sep = GLUE._sepOf(dir);
    if (dir.charAt(dir.length - 1) === sep) return dir + file;
    return dir + sep + file;
}
function _basenameOf(p) {
    var s = String(p == null ? "" : p);
    var sep = GLUE._sepOf(s);
    var idx = s.lastIndexOf(sep);
    return (idx >= 0) ? s.substring(idx + 1) : s;
}
function _isArr(x) { return Object.prototype.toString.call(x) === "[object Array]"; }
function _has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }

// ─── apply-side DISCOVERY resolution (pinned contract #3) ─────────────
//
// Tier (a) explicit automationOptions.presetPath → verbatim (headless, no UI).
// Tier (b) GLOB `<savedIndDir>/*_brand_style_preset.json` via the SHARED
//   GLUE.pickPreset(listing, {brandSlug}) — the IDENTICAL resolver the export
//   side names files for ⟹ NEVER recompute Doc-2's stem (task_plan.md:2614).
// Tier (c) nothing → ok:false `no-preset-found` (operator does clean exit, NOT
//   abort). Unsaved doc (no anchor dir) AND no presetPath → ok:false legible.
//   `listing` = array of basenames OR {name, mtimeMs}; `dir` = the anchor dir
//   (operator computes from the awaited doc.fullName.nativePath, OUTSIDE the
//   sync doScript — doc.fullName is a Promise, gate #3).
function resolveDiscovery(opts) {
    opts = opts || {};
    if (opts.explicitPresetPath) {
        var ep = String(opts.explicitPresetPath);
        return {
            ok: true, path: ep, source: "presetPath", basename: _basenameOf(ep),
            ambiguous: false, diagnostic: null, candidates: [_basenameOf(ep)]
        };
    }
    var dir = opts.dir;
    if (!dir) {
        return {
            ok: false, path: null, source: "none", basename: null, ambiguous: false,
            error: "doc is unsaved (no fullName/nativePath) and no automationOptions.presetPath given — apply needs a saved doc or an explicit presetPath",
            diagnostic: "no anchor dir", candidates: []
        };
    }
    var pick = GLUE.pickPreset(opts.listing || [], { brandSlug: opts.brandSlug });
    if (!pick.ok) {
        return {
            ok: false, path: null, source: "none", basename: null, ambiguous: false,
            diagnostic: pick.diagnostic || "no-preset-found", candidates: pick.candidates || []
        };
    }
    return {
        ok: true, path: _join(dir, pick.basename), source: pick.source, basename: pick.basename,
        ambiguous: !!pick.ambiguous, diagnostic: pick.diagnostic || null, candidates: pick.candidates || []
    };
}

// ─── per-stub match-outcome classification (decision-C 4-outcome) ─────
//
// presetIndex = SCIO.indexEntries(preset.entries) i.e. { match_key → entry[] }.
// Outcomes (task_plan.md:2597-2602):
//   foreign           — label has no parseable match_key (deriveMatchKey null)
//                       → skip + report (NEVER silent).
//   matched           — exactly one entry (or >1 all byte-equal: collapsedSilently)
//                       → auto-apply.
//   ambiguous         — >1 entry, differing payloads → skip + report (NEVER
//                       silent last-write-wins).
//   unmatched-target  — has match_key but NO preset entry → leave + report.
function classifyStub(label, presetIndex) {
    var matchKey = SCIO.deriveMatchKey(label);
    var stubIdentity = SCIO.stubIdentity(label);
    if (!matchKey) {
        return {
            outcome: "foreign", matchKey: null, stubIdentity: stubIdentity, creationKey: null,
            reason: "foreign/unparseable label (no match_key)"
        };
    }
    var creationKey = SCIO.parseCreationKey(label);
    var bucket = (presetIndex && _has(presetIndex, matchKey)) ? presetIndex[matchKey] : null;
    var res = SCIO.resolveMatch(bucket);
    if (res.outcome === "none") {
        return { outcome: "unmatched-target", matchKey: matchKey, stubIdentity: stubIdentity, creationKey: creationKey };
    }
    if (res.outcome === "ambiguous") {
        // 8D-ext-TB v1 EXACT-ONLY tie-break: a differing-payload match_key
        // collision (twin styles) is resolvable when the doc stub's creation
        // font identity (parseCreationKey latinFamily/latinStyle — frozen at
        // creation, survives a live font merge) exactly matches the
        // _resolved_font of exactly ONE entry in the bucket. Resolve to it and
        // return the SAME shape the matched path returns (so consumer .idjs:457
        // runs unchanged) plus resolvedByTiebreak:true. 0 / >1 exact matches, or
        // any entry lacking a usable _resolved_font → fall through to today's
        // ambiguous skip+report (no behavior downgrade). Normalization step ② is
        // DEFERRED (no cross-doc fixture yet — task_plan 8D-ext-TB build note #1).
        var tbEntry = _tieBreakExact(creationKey, bucket);
        if (tbEntry) {
            return {
                outcome: "matched", matchKey: matchKey, stubIdentity: stubIdentity, creationKey: creationKey,
                entry: tbEntry, resolvedByTiebreak: true
            };
        }
        return {
            outcome: "ambiguous", matchKey: matchKey, stubIdentity: stubIdentity, creationKey: creationKey,
            reason: res.reason, count: res.count
        };
    }
    return {
        outcome: "matched", matchKey: matchKey, stubIdentity: stubIdentity, creationKey: creationKey,
        entry: res.entry, collapsedSilently: !!res.collapsedSilently
    };
}

// font-identity token; null when either side is missing/blank (can't compare).
function _fontIdent(family, style) {
    if (family == null || style == null) return null;
    var f = String(family), s = String(style);
    if (f === "" || s === "") return null;
    return f + "\u0000" + s;   // NUL-delimited: neither a font family nor style contains NUL
}

// EXACT-ONLY tie-break over a differing-payload collision bucket (8D-ext-TB v1).
// Returns the SOLE entry whose _resolved_font {family,style} exactly equals the
// doc stub's creation {latinFamily,latinStyle}; null when 0 / >1 entries match,
// or when ANY entry lacks a usable _resolved_font (then the whole bucket stays
// ambiguous — today's skip+report, no downgrade). No normalization: "Whitney"/
// "Book" and "Whitney Book"/"Regular" are DISTINCT, which is exactly what lets
// the twin collision resolve. (task_plan 8D-ext-TB build notes #1/#2)
function _tieBreakExact(creationKey, bucket) {
    if (!creationKey || !_isArr(bucket) || bucket.length < 2) return null;
    var want = _fontIdent(creationKey.latinFamily, creationKey.latinStyle);
    if (!want) return null;
    var hit = null;
    for (var i = 0; i < bucket.length; i++) {
        var e = bucket[i];
        var rf = e ? e._resolved_font : null;
        var have = rf ? _fontIdent(rf.family, rf.style) : null;
        if (!have) return null;       // any entry missing _resolved_font → can't tie-break safely
        if (have === want) {
            if (hit) return null;     // >1 exact match → non-unique → stay ambiguous
            hit = e;
        }
    }
    return hit;                       // exactly one exact match, or null (zero)
}

// Stable identity of a preset ENTRY for reuse-rate / unmatched-entry tracking
// (two Doc-2 stubs matching the same entry must count once). match_key +
// payload_hash — match_key alone can collide on a residual differing-payload
// group (resolveMatch flags those ambiguous, but be defensive).
function entryKey(entry) {
    if (!entry) return "";
    var ph = entry.payload_hash || SCIO.payloadHash(entry.payload || {});
    return String(entry.match_key) + "#" + ph;
}

// ─── per-stub reconciliation PLAN (per-dim, isolated) ─────────────────
//
// Pure decision over (entry.payload × live × prior stamp record × creationKey).
// Returns the PLAN; the host executes the writes + read-backs.
//   protectedWrites: [{dim, value, verdict}]  dims to WRITE (take-preset/update/
//                    untouched) — appliedValues[dim] := value on the host write.
//   keptLocal:       [{dim, live, preset}]     designer edited after apply → keep
//                    Doc-2 value (NO write, applied_values absent so next run's
//                    state-1 can't false-fire off a 0/false-conflated undefined).
//   noBaseline:      [{dim, live, preset}]      creation labelKey absent (data gap)
//                    → surface, NOT silent keep-local (P2).
//   alwaysApply:     [{dim, value, reason}]     sB/sA + fillColor + rule — host
//                    ALWAYS writes + (color/rule) read-back-verifies (A3).
// hasPrior=false (no stamp on disk) → first-run conflict via resolveConflict
// (presetWins toggle honored); hasPrior=true → per-dim three-state reconcileDim
// (presetWins overrides a state-3 keep-local → update). (task_plan.md:2647-2660)
var _WRITE_VERDICTS = { "take-preset": 1, "update": 1, "untouched": 1 };

function planStub(payload, live, priorRecord, creationKey, tol, presetWins) {
    payload = payload || {};
    live = live || {};
    tol = tol || SCIO.DEFAULT_TOLERANCE;
    var hasPrior = !!priorRecord;
    var priorApplied = (priorRecord && priorRecord.applied_values) ? priorRecord.applied_values : {};
    var protectedWrites = [], keptLocal = [], noBaseline = [], alwaysApply = [];

    var dims = [];
    for (var k in payload) { if (_has(payload, k)) dims.push(k); }
    for (var i = 0; i < dims.length; i++) {
        var dim = dims[i];
        var presetVal = payload[dim];
        var cls = SCIO.classifyDim(dim);
        if (cls === "always-apply") {
            alwaysApply.push({ dim: dim, value: presetVal, reason: SCIO.carveOutReason(dim) });
            continue;
        }
        if (cls !== "protected") { continue; }   // unknown dim — validatePreset warns; skip silently here
        var liveVal = _has(live, dim) ? live[dim] : undefined;
        var verdict;
        if (hasPrior) {
            verdict = SCIO.reconcileDim(dim, liveVal, priorApplied[dim], creationKey, tol);
        } else {
            var c = SCIO.resolveConflict(dim, liveVal, creationKey, tol, presetWins);
            verdict = c;   // take-preset | keep-local | no-baseline | always-apply
        }
        if (presetWins && verdict === "keep-local") verdict = "update";
        if (_WRITE_VERDICTS[verdict]) {
            protectedWrites.push({ dim: dim, value: presetVal, verdict: verdict });
        } else if (verdict === "keep-local") {
            keptLocal.push({ dim: dim, live: liveVal, preset: presetVal });
        } else if (verdict === "no-baseline") {
            noBaseline.push({ dim: dim, live: liveVal, preset: presetVal });
        }
        // verdict === "always-apply" can only occur if classifyDim disagreed with
        // reconcileDim (it won't for a protected dim) — skip safely.
    }
    return { protectedWrites: protectedWrites, keptLocal: keptLocal, noBaseline: noBaseline, alwaysApply: alwaysApply };
}

// ─── drift-stamp MERGE across preset revisions (fable r1 gimpl3 P1) ───
//
// The per_style stamp must NOT be rebuilt from ONLY this run's matched stubs.
// On a PARTIAL apply (some stubs match this run; others classify unmatched-
// target / ambiguous / foreign) rebuilding-from-scratch would DROP the prior
// records of the stubs not matched this run — so those stubs silently lose
// their keep-local drift protection: a later re-apply with a different preset/
// style subset would re-match one and, finding no prior record, treat it as a
// first-run conflict (its live dims now ≠ creation → keep-local), and the
// preset stops transporting for that stub until presetWins. MERGE instead:
//   priorPerStyle — the prior stamp's per_style LIST (or [] on first apply).
//   newRecords    — the records built THIS run (one per matched stub).
// A prior record is REPLACED iff this run produced a record with the SAME
// (match_key, stub_identity) DOUBLE key (the A1 multi-stub disambiguator);
// every prior record NOT touched this run is PRESERVED verbatim; stubs matched
// this run with no prior record are APPENDED. Order-stable: prior order kept,
// new stubs appended in input order.
//
// A record is removed ONLY when its style no longer exists — an OPTIONAL GC the
// caller drives by passing `opts.liveStubKeys` (the [{match_key, stub_identity}]
// of every still-present _T_p_* style). A prior record whose key is absent from
// that set is GC'd (the style was deleted). When `liveStubKeys` is omitted, NO
// record is ever dropped — a stub is never removed merely for being unmatched
// this run; dead records for deleted styles linger harmlessly (they never
// re-match). The operator only WRITES the merged stamp when ≥1 stub matched
// this run, so the nothing-matched "don't clobber" guard is a subcase (empty
// newRecords → leave the prior stamp untouched).
function mergeStampRecords(priorPerStyle, newRecords, opts) {
    opts = opts || {};
    var prior = _isArr(priorPerStyle) ? priorPerStyle : [];
    var fresh = _isArr(newRecords) ? newRecords : [];
    var liveSet = _buildLiveKeySet(opts.liveStubKeys);   // null ⟹ GC disabled

    var freshByKey = {};
    var i;
    for (i = 0; i < fresh.length; i++) {
        var nr = fresh[i];
        if (!nr) continue;
        freshByKey[_stampKey(nr.match_key, nr.stub_identity)] = nr;
    }

    var merged = [];
    var emitted = {};
    for (i = 0; i < prior.length; i++) {
        var pr = prior[i];
        if (!pr) continue;
        var pk = _stampKey(pr.match_key, pr.stub_identity);
        if (_has(emitted, pk)) continue;                 // defensive: dedup a malformed prior list
        if (_has(freshByKey, pk)) {
            merged.push(freshByKey[pk]);                 // UPDATE: this run's record wins
        } else if (liveSet && !_has(liveSet, pk)) {
            continue;                                    // GC: the style no longer exists
        } else {
            merged.push(pr);                             // PRESERVE prior protection (the P1 fix)
        }
        emitted[pk] = true;
    }
    for (i = 0; i < fresh.length; i++) {
        var fr = fresh[i];
        if (!fr) continue;
        var fk = _stampKey(fr.match_key, fr.stub_identity);
        if (!_has(emitted, fk)) { merged.push(fr); emitted[fk] = true; }   // APPEND a new stub
    }
    return merged;
}

// (match_key, stub_identity) double-key, NUL-delimited (neither component
// contains a literal NUL — match_key is a derived ascii key, stub_identity a JSON label).
function _stampKey(matchKey, stubIdentityVal) {
    return String(matchKey) + "\u0000" + String(stubIdentityVal);
}

// Build the GC presence set from liveStubKeys (or null when GC is disabled).
function _buildLiveKeySet(liveStubKeys) {
    if (!_isArr(liveStubKeys)) return null;
    var set = {};
    for (var i = 0; i < liveStubKeys.length; i++) {
        var s = liveStubKeys[i];
        if (!s || s.match_key == null) continue;
        set[_stampKey(s.match_key, s.stub_identity)] = true;
    }
    return set;
}

// ─── near-miss qual_key suggestions (advisory, non-blocking) ──────────
//
// For each UNMATCHED preset entry, list UNMATCHED Doc-2 stubs whose coarse
// qual_key ({role,color,justification}, drop size/leading) equals the entry's —
// catches headline 47pt(Doc1) vs 48pt(Doc2) bucket drift (task_plan.md:2600).
// entries: [{name?, match_key, qual_key}]; stubs: [{name, stub_identity, qual_key}].
function nearMissSuggestions(unmatchedEntries, unmatchedStubs) {
    unmatchedEntries = unmatchedEntries || [];
    unmatchedStubs = unmatchedStubs || [];
    var out = [];
    for (var i = 0; i < unmatchedEntries.length; i++) {
        var e = unmatchedEntries[i];
        if (e == null || e.qual_key == null) continue;
        var eq = String(e.qual_key);
        var cands = [];
        for (var j = 0; j < unmatchedStubs.length; j++) {
            var s = unmatchedStubs[j];
            if (s && s.qual_key != null && String(s.qual_key) === eq) {
                cands.push({ stub_name: s.name || null, stub_identity: s.stub_identity || null });
            }
        }
        if (cands.length) {
            out.push({ preset_entry: e.name || e.match_key, match_key: e.match_key, qual_key: e.qual_key, candidates: cands });
        }
    }
    return out;
}

// ─── low-reuse diagnostic (distinguish derivation-mismatch vs真不同) ──
//
// task_plan.md:2698 — a low reuse rate must be DIAGNOSABLE, not a vague hint:
// compare the preset's derivation_id logic version against the running tool's.
// Different → likely a derivation/normalization-logic mismatch (re-export);
// same version but many unmatched → the documents' styles genuinely differ.
function lowReuseDiagnostic(matchedEntries, totalEntries, presetDerivationId, toolLogicVersion) {
    var total = Number(totalEntries) || 0;
    if (total <= 0) return null;
    var matched = Number(matchedEntries) || 0;
    var unmatched = total - matched;
    if (unmatched <= 0) return null;
    if (matched / total >= 0.8) return null;   // healthy reuse — no diagnostic
    var presetLogic = String(presetDerivationId == null ? "" : presetDerivationId).split(":")[0];
    var tool = String(toolLogicVersion == null ? "" : toolLogicVersion);
    if (presetLogic && tool && presetLogic !== tool) {
        return "low reuse (" + matched + "/" + total + " entries matched): preset derivation logic '"
            + presetLogic + "' != current tool '" + tool
            + "' — LIKELY derivation/normalization mismatch; re-export the preset with the current tool";
    }
    return "low reuse (" + matched + "/" + total + " entries matched): same derivation logic ('"
        + tool + "') but " + unmatched
        + " preset entries unmatched — LIKELY the documents' styles genuinely differ";
}

// ─── coverage-report builder (the apply summary; JSON-serializable) ───
//
// HEADLINE reuse_rate = matched-distinct-preset-entries ÷ total preset entries
// (task_plan.md:2698 — an entry counts as "matched/reused" once a Doc-2 stub
// keys to it, BEFORE the per-dim write/read-back verdict). fable r1 gimpl3 P3:
// that headline must not be misread as "all geometry transported" — a matched
// entry whose dims all land kept-local or applied-FAILED still counts toward
// reuse_rate. So break out DISTINCT sub-indicators:
//   reuse_rate     (HEADLINE) — matched-distinct-entries ÷ total
//   applied_rate              — entries that transported ≥1 preset dim ÷ total
//   kept_local_count         — protected dims kept (designer edited after apply)
//   applied_failed_count     — always-apply read-backs that FAILED to land
// `reuse_rate_basis` states which number is the headline, in the object itself.
function buildCoverageReport(o) {
    o = o || {};
    var total = Number(o.totalPresetEntries) || 0;
    var matched = Number(o.matchedPresetEntries) || 0;
    var applied = Number(o.appliedPresetEntries) || 0;   // entries that transported ≥1 dim
    var reuseRate = total > 0 ? (matched / total) : 0;
    var appliedRate = total > 0 ? (applied / total) : 0;
    var keptLocal = o.keptLocal || [];
    var appliedFailed = o.appliedFailed || [];
    return {
        ok: !!o.ok,
        operator: "apply_brand_style_preset",
        ts: o.ts || null,
        // discovery
        preset_path: o.presetPath || null,
        path_source: o.pathSource || null,            // presetPath | glob-* | fixed | none
        discovery_ambiguous: !!o.discoveryAmbiguous,
        discovery_diagnostic: o.discoveryDiagnostic || null,
        // identity / version
        preset_id: o.presetId || null,
        preset_content_hash: o.presetContentHash || null,
        derivation_id: o.derivationId || null,
        rev_changed: !!o.revChanged,
        rev_message: o.revMessage || null,
        validation: o.validation || null,             // {ok, errors, warnings}
        // tolerance provenance (A2 — apply re-buckets with the RECORDED tol)
        tolerance_used: o.toleranceUsed || null,
        tolerance_used_default: !!o.toleranceUsedDefault,
        measurement_forced_points: (o.measurementForcedPoints !== false),
        // counters
        styles_scanned: Number(o.stylesScanned) || 0,
        total_preset_entries: total,
        matched_preset_entries: matched,
        applied_preset_entries: applied,
        matched_stub_count: Number(o.matchedStubCount) || 0,
        // coverage — HEADLINE is reuse_rate; applied_rate / kept_local_count /
        // applied_failed_count are DISTINCT so "reuse" can't be read as "all
        // transported" (P3). reuse_rate >= applied_rate always.
        reuse_rate: reuseRate,                        // HEADLINE (matched ÷ total)
        reuse_rate_pct: Math.round(reuseRate * 1000) / 10,
        applied_rate: appliedRate,                    // sub: ≥1-dim-transported ÷ total
        applied_rate_pct: Math.round(appliedRate * 1000) / 10,
        kept_local_count: keptLocal.length,           // sub: designer-edited dims kept
        applied_failed_count: appliedFailed.length,   // sub: always-apply read-back FAILED
        reuse_rate_basis: "HEADLINE reuse_rate = matched-distinct-preset-entries / total (an entry counts once a stub keys to it, even if its dims were kept-local or applied-FAILED). applied_rate = entries that actually transported >=1 preset dim. kept_local_count / applied_failed_count itemize the non-transported dims.",
        // 4-outcome + operator-level no-preset-found (reported by the operator)
        unmatched_target: o.unmatchedTarget || [],            // stub had match_key, no entry
        unmatched_preset_entry: o.unmatchedPresetEntry || [], // entry matched no stub, no coarse candidate
        near_miss_suggested: o.nearMissSuggested || [],       // entry → coarse stub candidate(s)
        ambiguous_skipped: o.ambiguousSkipped || [],          // stub matched >1 differing entry
        resolved_by_tiebreak: o.resolvedByTiebreak || [],     // 8D-ext-TB: collision resolved by exact font tie-break ({name, match_key, entry_key, resolved_font})
        foreign_skipped: o.foreignSkipped || [],              // stub label unparseable
        // conflict accounting
        kept_local: keptLocal,                                // protected dim kept (designer edited)
        no_baseline: o.noBaseline || [],                      // protected dim, creation labelKey absent (data gap)
        always_applied: o.alwaysApplied || [],                // carve-out dims overwritten (+reason)
        applied_failed: appliedFailed,                        // always-apply read-back FAILED (in reuse_rate, NOT applied_rate)
        // drift stamp
        stamp_written: !!o.stampWritten,
        stamp_error: o.stampError || null,
        low_reuse_diagnostic: o.lowReuseDiagnostic || null,
        warnings: o.warnings || [],
        reason: o.reason || null
    };
}

// ─── exports ──────────────────────────────────────────────────────────

module.exports = {
    resolveDiscovery: resolveDiscovery,
    classifyStub: classifyStub,
    entryKey: entryKey,
    planStub: planStub,
    mergeStampRecords: mergeStampRecords,
    nearMissSuggestions: nearMissSuggestions,
    lowReuseDiagnostic: lowReuseDiagnostic,
    buildCoverageReport: buildCoverageReport,
    _internal: {
        _join: _join,
        _basenameOf: _basenameOf
    }
};
