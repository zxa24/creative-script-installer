"use strict";

/**
 * brand_preset_apply_runner.js — shared APPLY runner extracted from
 * apply_brand_style_preset.idjs (8D-ext-GI). It is the DOM-bearing core of the
 * brand-style migration so BOTH entry points can drive it identically:
 *   (a) apply_brand_style_preset.idjs (the standalone operator, now a thin shell)
 *   (b) import_integrated.idjs (inline apply right after the deliverable save)
 *
 *   applyBrandStylePresetToDoc(doc, { presetPath, presetWins, log,
 *                                     pathSource, discoveryAmbiguous,
 *                                     discoveryDiagnostic }) → coverageReport
 *
 * OWNS (lib): preset LOAD + validate, preset index + tolerances, prior drift
 * stamp read, collectTPStyles, the force-POINTS ENTIRE_SCRIPT applyAll doScript
 * (single undo), drift-stamp write, and the coverage-report build. The apply
 * mechanics (per-dim writes, always-apply read-back verdicts, 8D-ext-TB exact
 * tie-break carrier `_resolved_font` → resolved_by_tiebreak[]) are carried over
 * 1:1 from the operator.
 *
 * DOES NOT own (stays in each entry shell): AutomationBridge read /
 * recordAutomationResult, the independent coverage-log file write, discovery
 * (caller resolves `presetPath` and hands it in), and doc resolution. Per the
 * spec, the lib入参 only takes doc + path (+ optional log/discovery metadata for
 * the report) — it never touches the automation side-channel.
 *
 * APP / ENUM acquisition (gi r2 audit [B]#2 + CLAUDE gate #4 / MVP detail #2):
 * the lib self-acquires app + indesign.* enums with the isolated-module fallback
 * `globalThis.app ? globalThis.app : require("indesign").app`. The require is
 * GUARDED so `node -e "require(this)"` does NOT throw (no DOM/main runs at load —
 * the host work only fires inside applyBrandStylePresetToDoc).
 */

var indesign = null;
try { indesign = require("indesign"); } catch (eReq) { indesign = null; }
var app = (typeof globalThis !== "undefined" && globalThis.app)
    ? globalThis.app
    : (indesign ? indesign.app : null);
var ScriptLanguage = indesign ? indesign.ScriptLanguage : null;
var UndoModes = indesign ? indesign.UndoModes : null;
var MeasurementUnits = indesign ? indesign.MeasurementUnits : null;
// write-side enums for the shipped resolvers (host-only; null under node)
var Leading = indesign ? indesign.Leading : null;
var Justification = indesign ? indesign.Justification : null;
var ColorSpace = indesign ? indesign.ColorSpace : null;
var ColorModel = indesign ? indesign.ColorModel : null;
var RuleWidth = indesign ? indesign.RuleWidth : null;

var SCIO = require("./style_config_io.js");
var glue = require("./brand_preset_export_glue.js");      // #2 — shared discovery/collection
var aglue = require("./brand_preset_apply_glue.js");      // apply-side pure orchestration
var VS = require("./visual_snapshot.js");
var SSB = require("./style_sheet_builder.js");

var captureColor = VS._internal.captureColor;
var captureRule = VS._internal.captureRule;                   // additive export (G→r7 PIN)
var _resolveLeading = SSB._internal._resolveLeading;
var _resolveJustification = SSB._internal._resolveJustification;
var _resolveFillColor = SSB._internal._resolveFillColor;
var _applyRuleSpec = SSB._internal._applyRuleSpec;            // additive export (G→r7 PIN)

// deps shape the shipped resolvers expect (mirrors import_translations_v2.idjs:1723-1730)
var COLOR_DEPS = { ColorSpace: ColorSpace, ColorModel: ColorModel, RuleWidth: RuleWidth };
// live per-style payload read deps (host-side captures, injected — gate #3)
var STYLE_READ_DEPS = { captureColor: captureColor, captureRule: captureRule };

function _num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function _isArr(x) { return Object.prototype.toString.call(x) === "[object Array]"; }
function _nowIso() { try { return new Date().toISOString(); } catch (e) { return null; } }

function _readJsonSync(p) {
    var fs = require("fs");
    var raw = null;
    try { raw = fs.readFileSync(p, "utf-8"); } catch (e) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (eP) { return null; }
}

// ─── drift-stamp sibling label (clone of import_state_store _safe* — option-2,
//     task_plan.md:2620: NO public-write schema munging; sibling key
//     SCIO.STATE_LABEL_KEY, distinct from translation_import_state_v1) ──

function _safeInsertLabel(doc, key, value) {        // ← import_state_store.js:55
    try {
        var r = doc.insertLabel(key, value || "");
        if (r && typeof r.then === "function") return { ok: false, err: "insertLabel returned a Promise (UXP API change?)" };
        return { ok: true };
    } catch (e) { return { ok: false, err: String(e && (e.message || e)) }; }
}
function _safeExtractLabel(doc, key) {              // ← import_state_store.js:70
    try {
        var v = doc.extractLabel(key);
        if (v && typeof v.then === "function") return { ok: false, err: "extractLabel returned a Promise" };
        return { ok: true, value: v || "" };
    } catch (e) { return { ok: false, err: String(e && (e.message || e)) }; }
}
function _readDriftStamp(doc) {
    var ext = _safeExtractLabel(doc, SCIO.STATE_LABEL_KEY);
    if (!ext.ok || !ext.value) return null;
    var raw = String(ext.value).replace(/^\s+|\s+$/g, "");
    if (!raw || raw.charAt(0) !== "{") return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    // schema-gate (collision defense): preset state carries a per_style LIST.
    if (!parsed || typeof parsed !== "object" || !_isArr(parsed.per_style)) return null;
    return parsed;
}
function _writeDriftStamp(doc, stamp) {
    var json;
    try { json = JSON.stringify(stamp); }
    catch (e) { return { ok: false, err: "JSON.stringify: " + (e && e.message || e) }; }
    return _safeInsertLabel(doc, SCIO.STATE_LABEL_KEY, json);
}

// ─── live per-style payload read (sync; runs inside force-POINTS doScript) ─
// fable r1 (gimpl3) P2: delegates to the SHARED glue.readStylePayload so the
// captured shape feeding conflict detection is byte-identical to what export's
// _readStylePayload wrote — same function, no mirror-drift.

function _readLivePayload(ps) { return glue.readStylePayload(ps, STYLE_READ_DEPS); }

// ─── per-dim WRITE (scalar direct / enum+object via shipped resolvers) ─
// NOTE gate #7: these are ParagraphStyle PROPERTY writes, NOT character-style
// application — no CS apply happens, so the "Apply CS resets fillColor/pointSize"
// reset does NOT fire here. Protected dims write before always-apply dims; both
// are independent properties on the style so ordering among them is irrelevant.

function _writeDim(ps, dim, value, doc) {
    try {
        switch (dim) {
            case "pointSize": ps.pointSize = _num(value); return true;
            case "leftIndent": ps.leftIndent = _num(value); return true;
            case "rightIndent": ps.rightIndent = _num(value); return true;
            case "firstLineIndent": ps.firstLineIndent = _num(value); return true;
            case "keepWithNext": ps.keepWithNext = _num(value); return true;
            case "keepLinesTogether": ps.keepLinesTogether = !!value; return true;
            case "spaceBefore": ps.spaceBefore = _num(value); return true;
            case "spaceAfter": ps.spaceAfter = _num(value); return true;
            case "composer": ps.composer = String(value); return true;
            case "leading": {
                var lv = _resolveLeading(value, Leading);
                if (lv !== undefined) { ps.leading = lv; return true; }
                return false;
            }
            case "justification": {
                var jv = _resolveJustification(value, Justification);
                if (jv !== null && jv !== undefined) { ps.justification = jv; return true; }
                return false;
            }
            case "fillColor": {
                // binding/sentinel ("Text Color") → resolver returns null → skip
                // the assignment (keep current). The read-back judges OK/FAILED.
                var col = _resolveFillColor(doc, value, COLOR_DEPS);
                if (col) { ps.fillColor = col; return true; }
                return false;
            }
            case "ruleAbove": _applyRuleSpec(ps, value, "ruleAbove", doc, COLOR_DEPS); return true;
            case "ruleBelow": _applyRuleSpec(ps, value, "ruleBelow", doc, COLOR_DEPS); return true;
        }
    } catch (e) { return false; }
    return false;
}

// Always-apply read-back verdict (A3 TOTAL norm). color → captureColor +
// readBackVerdict; rule → captureRule + ruleReadBackVerdict; sB/sA → scalar
// (force-POINTS write lands → applied-OK, no color read-back).
function _alwaysApplyAndVerify(ps, dim, value, doc) {
    if (dim === "spaceBefore" || dim === "spaceAfter") {
        _writeDim(ps, dim, value, doc);
        return { verdict: "applied-OK" };
    }
    if (dim === "fillColor") {
        _writeDim(ps, dim, value, doc);
        var live = null;
        try { live = captureColor(ps.fillColor); } catch (e) {}
        return SCIO.readBackVerdict(value, live);
    }
    if (dim === "ruleAbove" || dim === "ruleBelow") {
        _writeDim(ps, dim, value, doc);
        var liveR = null;
        try { liveR = captureRule(ps, dim); } catch (e2) { liveR = { active: false }; }
        return SCIO.ruleReadBackVerdict(value, liveR);
    }
    return { verdict: "applied-OK" };
}

// ─── the runner ───────────────────────────────────────────────────────
//
// doc          : the document to apply ONTO (caller resolves; never ===).
// opts.presetPath          : explicit preset file path (caller's discovery result)
// opts.presetWins          : run-level protected-dim conflict → take preset
// opts.log                 : optional logger fn(line) — caller accumulates for its
//                            own log file; the lib does NOT write any log file.
// opts.pathSource          : discovery source label for the report ("presetPath"
//                            | "glob" …) — default "presetPath" (explicit path).
// opts.discoveryAmbiguous  : carried into the report (default false)
// opts.discoveryDiagnostic : carried into the report (default null)
//
// Returns the coverage report object (load/validate failures included). Side
// effects: writes the drift stamp into the doc + mutates `_T_p_*` style geometry
// inside ONE ENTIRE_SCRIPT doScript. No file/automation I/O.
function applyBrandStylePresetToDoc(doc, opts) {
    opts = opts || {};
    var presetWins = !!opts.presetWins;
    var presetPath = opts.presetPath;
    var pathSource = opts.pathSource || "presetPath";
    var discoveryAmbiguous = !!opts.discoveryAmbiguous;
    var discoveryDiagnostic = (opts.discoveryDiagnostic !== undefined) ? opts.discoveryDiagnostic : null;
    var log = (typeof opts.log === "function") ? opts.log : function () {};
    function plog(m) { try { log(m); } catch (e) {} }

    if (!doc) {
        plog("ABORT: no document passed to applyBrandStylePresetToDoc");
        return aglue.buildCoverageReport({ ok: false, reason: "no document", pathSource: "none" });
    }
    if (!presetPath) {
        plog("ABORT: no presetPath passed to applyBrandStylePresetToDoc");
        return aglue.buildCoverageReport({ ok: false, reason: "no presetPath", pathSource: "none" });
    }

    // 4. LOAD + validate preset (refuse on schema/version errors, legible).
    var preset = _readJsonSync(presetPath);
    if (!preset) {
        plog("ABORT: preset unreadable: " + presetPath);
        return aglue.buildCoverageReport({
            ok: false, reason: "preset file unreadable or not JSON: " + presetPath,
            presetPath: presetPath, pathSource: pathSource, discoveryAmbiguous: discoveryAmbiguous,
            discoveryDiagnostic: discoveryDiagnostic
        });
    }
    var validation = SCIO.validatePreset(preset);
    if (!validation.ok) {
        plog("VALIDATION FAILED: " + validation.errors.join("; "));
        return aglue.buildCoverageReport({
            ok: false, reason: "validatePreset failed: " + validation.errors.join("; "),
            presetPath: presetPath, pathSource: pathSource, discoveryAmbiguous: discoveryAmbiguous,
            discoveryDiagnostic: discoveryDiagnostic, validation: validation,
            presetId: preset.preset_id, presetContentHash: preset.preset_content_hash,
            derivationId: preset.derivation_id
        });
    }
    var warnings = [];
    for (var wi = 0; wi < validation.warnings.length; wi++) warnings.push(validation.warnings[wi]);

    // 5. preset index (LIST per match_key) + tolerances (RECORDED tol — A2).
    var presetEntries = _isArr(preset.entries) ? preset.entries : [];
    var presetIndex = SCIO.indexEntries(presetEntries);
    var tolRes = SCIO.extractTolerances(preset);
    var tol = tolRes.tolerance;
    if (tolRes.usedDefault) warnings.push("preset lacked some tolerance fields — fell back to DEFAULT_TOLERANCE for those");

    // 6. prior drift stamp (sibling label) — read OUTSIDE doScript.
    var priorStamp = _readDriftStamp(doc);
    var priorPerStyle = (priorStamp && _isArr(priorStamp.per_style)) ? priorStamp.per_style : [];
    var revChanged = !!(priorStamp && priorStamp.preset_content_hash
        && priorStamp.preset_content_hash !== preset.preset_content_hash);
    var revMessage = revChanged
        ? ("preset changed since last apply (stamp hash " + priorStamp.preset_content_hash
            + " → disk " + preset.preset_content_hash + ") — re-applying with per-dim reconciliation")
        : null;
    if (revMessage) plog(revMessage);

    // 7. collect Doc-2 `_T_p_*` (gate #2 grouped) + apply inside ONE
    //    force-POINTS ENTIRE_SCRIPT doScript (single undo; gate #9 sync-freeze).
    var tpStyles = glue.collectTPStyles(doc);

    // accumulators (filled inside the doScript loop)
    var matchedEntryKeys = {};         // entryKey → true (distinct MATCHED preset entries — reuse_rate numerator)
    var appliedEntryKeys = {};         // entryKey → true (entries that transported ≥1 dim — applied_rate, P3)
    var liveStubKeys = [];             // {match_key, stub_identity} for every non-foreign live style (stamp-merge GC, P1)
    var matchedStubCount = 0;
    var unmatchedStubs = [];           // {name, stub_identity, qual_key}  (for near-miss)
    var unmatchedTarget = [];          // {name, stub_identity, match_key}
    var ambiguousSkipped = [];         // {name, stub_identity, match_key, reason, count}
    var resolvedByTiebreak = [];       // {name, stub_identity, match_key, entry_key, resolved_font}  (8D-ext-TB)
    var foreignSkipped = [];           // {name, reason}
    var keptLocalRep = [];             // {style, dim, live, preset}
    var noBaselineRep = [];            // {style, dim}
    var alwaysAppliedRep = [];         // {style, dim, reason, verdict}
    var appliedFailedRep = [];         // {style, dim, reason}
    var perStyleRecords = [];          // drift-stamp LIST-of-records
    var stampResult = { ok: false, err: null };

    function applyAll() {
        SCIO.withPointsMeasurement(
            { app: app, doc: doc, MeasurementUnits: MeasurementUnits },
            function () {
                for (var i = 0; i < tpStyles.length; i++) {
                    var ps = tpStyles[i];
                    var name = ""; try { name = String(ps.name); } catch (eNm) {}
                    var label = ""; try { label = String(ps.label || ""); } catch (eL) {}
                    var cls = aglue.classifyStub(label, presetIndex);
                    var live = _readLivePayload(ps);

                    // record every non-foreign live style for the stamp-merge GC
                    // (P1): a prior record whose (match_key, stub_identity) is
                    // absent from this set = its style was deleted → GC'd;
                    // present-but-unmatched-this-run = PRESERVED, not dropped.
                    if (cls.matchKey) liveStubKeys.push({ match_key: cls.matchKey, stub_identity: cls.stubIdentity });

                    if (cls.outcome === "foreign") {
                        foreignSkipped.push({ name: name, reason: cls.reason });
                        continue;
                    }
                    if (cls.outcome === "ambiguous") {
                        ambiguousSkipped.push({ name: name, stub_identity: cls.stubIdentity, match_key: cls.matchKey, reason: cls.reason, count: cls.count });
                        continue;
                    }
                    if (cls.outcome === "unmatched-target") {
                        var role = glue.roleFromStyleName(name);
                        var qk = SCIO.deriveQualKey({ role: role, fillColor: live.fillColor, justification: live.justification });
                        unmatchedTarget.push({ name: name, stub_identity: cls.stubIdentity, match_key: cls.matchKey });
                        unmatchedStubs.push({ name: name, stub_identity: cls.stubIdentity, qual_key: qk });
                        continue;
                    }

                    // ── matched: reconcile + apply ──
                    var entry = cls.entry;
                    var ek = aglue.entryKey(entry);
                    matchedEntryKeys[ek] = true;           // counts toward reuse_rate (headline)
                    matchedStubCount++;
                    // 8D-ext-TB: a collision resolved by the exact font tie-break
                    // is additively reported (functionally it already flows the
                    // matched path unchanged via cls.entry below).
                    if (cls.resolvedByTiebreak) {
                        resolvedByTiebreak.push({
                            name: name, stub_identity: cls.stubIdentity, match_key: cls.matchKey,
                            entry_key: ek, resolved_font: (entry && entry._resolved_font) || null
                        });
                    }
                    var prior = SCIO.findStampRecord(priorPerStyle, cls.matchKey, cls.stubIdentity);
                    var plan = aglue.planStub(entry.payload, live, prior, cls.creationKey, tol, presetWins);

                    var appliedValues = {};
                    var appliedDims = [];
                    var skippedConflicts = [];

                    // protected writes (update / untouched / take-preset)
                    var w;
                    for (w = 0; w < plan.protectedWrites.length; w++) {
                        var pw = plan.protectedWrites[w];
                        var okW = _writeDim(ps, pw.dim, pw.value, doc);
                        if (okW) { appliedValues[pw.dim] = pw.value; appliedDims.push(pw.dim); }
                        else { appliedFailedRep.push({ style: name, dim: pw.dim, reason: "protected write did not resolve (" + pw.verdict + ")" }); }
                    }
                    // kept-local (state-3) — NO write, applied_values absent (P1)
                    for (w = 0; w < plan.keptLocal.length; w++) {
                        var kl = plan.keptLocal[w];
                        keptLocalRep.push({ style: name, dim: kl.dim, live: kl.live, preset: kl.preset });
                        skippedConflicts.push(kl.dim);
                    }
                    // no-baseline (data gap, P2) — surface, NO silent keep-local
                    for (w = 0; w < plan.noBaseline.length; w++) {
                        var nb = plan.noBaseline[w];
                        noBaselineRep.push({ style: name, dim: nb.dim });
                        skippedConflicts.push(nb.dim);
                    }
                    // always-apply (carve-out) — ALWAYS write + read-back verify
                    for (w = 0; w < plan.alwaysApply.length; w++) {
                        var aa = plan.alwaysApply[w];
                        var verdict = _alwaysApplyAndVerify(ps, aa.dim, aa.value, doc);
                        appliedValues[aa.dim] = aa.value;
                        if (verdict && verdict.verdict === "applied-OK") {
                            appliedDims.push(aa.dim);
                            alwaysAppliedRep.push({ style: name, dim: aa.dim, reason: aa.reason, verdict: "applied-OK" });
                        } else {
                            appliedFailedRep.push({ style: name, dim: aa.dim, reason: (verdict && verdict.reason) || "read-back FAILED" });
                            alwaysAppliedRep.push({ style: name, dim: aa.dim, reason: aa.reason, verdict: "applied-FAILED" });
                        }
                    }

                    // P3: an entry "applied" iff ≥1 preset dim actually
                    // transported this run (protected write OK or always-apply
                    // applied-OK). All-kept-local / all-FAILED → matched but NOT
                    // applied (reuse_rate counts it; applied_rate does not).
                    if (appliedDims.length > 0) appliedEntryKeys[ek] = true;

                    perStyleRecords.push(SCIO.buildPerStyleRecord({
                        matchKey: cls.matchKey,
                        stubIdentity: cls.stubIdentity,
                        appliedDims: appliedDims,
                        skippedConflicts: skippedConflicts,
                        appliedValues: appliedValues
                    }));
                }

                // write the drift stamp INSIDE the ENTIRE_SCRIPT (single undo).
                // P1 MERGE: on a PARTIAL apply, prior records for stubs not
                // matched THIS run MUST be preserved — rebuilding from only this
                // run's records would erase their keep-local drift protection.
                // mergeStampRecords UPDATEs this run's (match_key, stub_identity)
                // records and PRESERVES every untouched prior record; GC drops a
                // prior record only when its style no longer exists (liveStubKeys).
                // Guard: only WRITE when ≥1 stub matched this run — nothing
                // matched (perStyleRecords empty) → leave the prior stamp wholly
                // untouched (don't clobber; this is the merge's empty subcase).
                if (perStyleRecords.length > 0) {
                    var mergedPerStyle = aglue.mergeStampRecords(priorPerStyle, perStyleRecords, { liveStubKeys: liveStubKeys });
                    var stamp = SCIO.buildDriftStamp({
                        presetId: preset.preset_id,
                        presetContentHash: preset.preset_content_hash,
                        derivationId: preset.derivation_id,
                        appliedAt: _nowIso(),
                        perStyle: mergedPerStyle
                    });
                    stampResult = _writeDriftStamp(doc, stamp);
                } else {
                    stampResult = { ok: false, skipped: true, err: null };
                }
            }
        );
    }
    try {
        app.doScript(applyAll, ScriptLanguage.JAVASCRIPT, undefined,
            UndoModes.ENTIRE_SCRIPT, "Apply Brand Style Preset");
    } catch (eDS) {
        plog("doScript failed (" + (eDS && eDS.message || eDS) + ") — retry raw");
        try { applyAll(); } catch (eRaw) {
            plog("raw apply failed: " + (eRaw && eRaw.message || eRaw));
        }
    }

    // 8. coverage report — unmatched preset entries + near-miss + low-reuse.
    var unmatchedEntries = [];
    for (var ei = 0; ei < presetEntries.length; ei++) {
        var e = presetEntries[ei];
        if (!matchedEntryKeys[aglue.entryKey(e)]) {
            unmatchedEntries.push({ name: e.name || null, match_key: e.match_key, qual_key: e.qual_key });
        }
    }
    var nearMiss = aglue.nearMissSuggestions(unmatchedEntries, unmatchedStubs);
    // unmatched-preset-entry = unmatched entries with NO coarse candidate.
    var suggestedKeys = {};
    for (var ni = 0; ni < nearMiss.length; ni++) suggestedKeys[nearMiss[ni].match_key] = true;
    var unmatchedPresetEntry = [];
    for (var ui = 0; ui < unmatchedEntries.length; ui++) {
        if (!suggestedKeys[unmatchedEntries[ui].match_key]) unmatchedPresetEntry.push(unmatchedEntries[ui]);
    }
    var matchedEntryCount = 0;
    for (var mk in matchedEntryKeys) { if (Object.prototype.hasOwnProperty.call(matchedEntryKeys, mk)) matchedEntryCount++; }
    var appliedEntryCount = 0;   // P3: distinct entries that transported ≥1 dim
    for (var ak in appliedEntryKeys) { if (Object.prototype.hasOwnProperty.call(appliedEntryKeys, ak)) appliedEntryCount++; }
    var lowReuse = aglue.lowReuseDiagnostic(matchedEntryCount, presetEntries.length, preset.derivation_id, SCIO.DERIVATION_LOGIC_VERSION);

    if (!stampResult.ok && !stampResult.skipped) warnings.push("drift stamp write failed: " + (stampResult.err || "unknown"));

    var report = aglue.buildCoverageReport({
        ok: true,
        presetPath: presetPath,
        pathSource: pathSource,
        discoveryAmbiguous: discoveryAmbiguous,
        discoveryDiagnostic: discoveryDiagnostic,
        presetId: preset.preset_id,
        presetContentHash: preset.preset_content_hash,
        derivationId: preset.derivation_id,
        revChanged: revChanged,
        revMessage: revMessage,
        validation: validation,
        toleranceUsed: tol,
        toleranceUsedDefault: tolRes.usedDefault,
        stylesScanned: tpStyles.length,
        totalPresetEntries: presetEntries.length,
        matchedPresetEntries: matchedEntryCount,
        appliedPresetEntries: appliedEntryCount,
        matchedStubCount: matchedStubCount,
        unmatchedTarget: unmatchedTarget,
        unmatchedPresetEntry: unmatchedPresetEntry,
        nearMissSuggested: nearMiss,
        ambiguousSkipped: ambiguousSkipped,
        resolvedByTiebreak: resolvedByTiebreak,
        foreignSkipped: foreignSkipped,
        keptLocal: keptLocalRep,
        noBaseline: noBaselineRep,
        alwaysApplied: alwaysAppliedRep,
        appliedFailed: appliedFailedRep,
        stampWritten: stampResult.ok,
        stampError: stampResult.ok ? null : stampResult.err,
        lowReuseDiagnostic: lowReuse,
        warnings: warnings
    });
    plog("DONE scanned=" + tpStyles.length + " matchedStubs=" + matchedStubCount
        + " matchedEntries=" + matchedEntryCount + "/" + presetEntries.length
        + " reuse=" + report.reuse_rate_pct + "% (headline) appliedEntries=" + appliedEntryCount
        + " applied=" + report.applied_rate_pct + "% keptLocal=" + keptLocalRep.length
        + " appliedFailed=" + appliedFailedRep.length + " tiebreak=" + resolvedByTiebreak.length + " stamp=" + stampResult.ok);
    if (lowReuse) plog("LOW-REUSE: " + lowReuse);
    return report;
}

module.exports = {
    applyBrandStylePresetToDoc: applyBrandStylePresetToDoc,
    // exported for unit testing (载重点 ④: withPointsMeasurement round-trip reset)
    _internal: {
        _writeDim: _writeDim,
        _alwaysApplyAndVerify: _alwaysApplyAndVerify,
        _readDriftStamp: _readDriftStamp,
        _writeDriftStamp: _writeDriftStamp
    }
};
