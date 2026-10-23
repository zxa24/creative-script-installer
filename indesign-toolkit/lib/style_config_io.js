"use strict";

/**
 * style_config_io.js — shared serialization/logic foundation for 8D-ext-G
 * (brand style preset) operator #7.  ONE lib, TWO consumers:
 *   - export_brand_style_preset.idjs  (capture Doc-1 → brand_style_preset.json)
 *   - apply_brand_style_preset.idjs   (apply preset → Doc-2 _T_p_* definitions)
 *   - (later, Phase 10 style_pool shares the same serializer)
 *
 * This module is the PURE CORE.  Given captured snapshot shapes / label
 * strings / payload objects it derives keys, classifies dimensions,
 * serializes the preset, hashes it, and compares values.  It performs NO
 * host I/O — no app.doScript, no style mutation, no fs read/write.  Those
 * live in the operators.  Therefore it is fully Node-testable with fixtures.
 *
 * UXP / ExtendScript compatibility: var only, no ES6+, function expressions,
 * explicit for-loops.  Reuses shipped pure helpers from style_sheet_builder
 * (`_roundTol`, `_shortHash`) so bucketing/hashing are byte-identical to the
 * values the creation `label` was baked with — a re-implementation that
 * drifts would silently break dirty-detection.
 *
 * Spec SoT: task_plan.md "### 8D-ext-G" (r9 GATE PASSED, commit 95cba01).
 * Line-refs below point into that section + the shipped helpers.
 */

var SSB = require("./style_sheet_builder.js");
var _roundTol = SSB._internal._roundTol;   // style_sheet_builder.js:308 — SAME bucket fn the label baked with
var _shortHash = SSB._internal._shortHash; // style_sheet_builder.js:314 — djb2 → 8 hex

// ─── Constants ─────────────────────────────────────────────────────

var SCHEMA_VERSION = 1;
var PRESET_KIND = "brand_style_preset";

// Bump whenever weightClass / stripFontDims / fingerprint-normalization
// logic changes.  Folded into derivation_id so a "logic changed but value
// didn't" revision still produces a new preset_content_hash (B-fold G→r5).
var DERIVATION_LOGIC_VERSION = "g1";

// Drift-stamp sibling label key (NOT translation_import_state_v1 — that v1
// schema is owned by edit-mode diff-classify; import_state_store.js:48).
var STATE_LABEL_KEY = "brand_style_preset_state_v1";

// Re-export DEFAULT_TOLERANCE for operators that want the canonical fallback.
var DEFAULT_TOLERANCE = SSB.DEFAULT_TOLERANCE;

// ── Payload dimensions — exhaustive (14) + the protected / always-apply
//    partition (conflict 节末「一致性锚」 task_plan.md:2633-2636). ──
//
// PROTECTED (9): have a RECONSTRUCTABLE creation baseline in the label →
//   keep-local on conflict.  ALWAYS-APPLY (5): no reconstructable baseline
//   (sB/sA masked out of fingerprint :823-828; fillColor/rule ICC
//   displayedRGB unreadable from live :628/:632 → A3) → always overwrite +
//   report.  The two sets are mutually exclusive and exhaust PAYLOAD_DIMS.
var PAYLOAD_DIMS = [
    "pointSize", "leftIndent", "rightIndent", "firstLineIndent",
    "keepWithNext", "keepLinesTogether", "spaceBefore", "spaceAfter",
    "leading", "justification", "fillColor", "ruleAbove", "ruleBelow",
    "composer"
];
var PROTECTED_DIMS = [
    "pointSize", "leading", "leftIndent", "rightIndent", "firstLineIndent",
    "keepWithNext", "keepLinesTogether", "justification", "composer"
];
var ALWAYS_APPLY_DIMS = [
    "spaceBefore", "spaceAfter", "fillColor", "ruleAbove", "ruleBelow"
];

// Read/write routing reference (schema 三类标注): scalar-safe vs
// enum/object (→ named resolver on write, snapshot-shape on read) vs the
// settled scalar-safe composer.  The operators use this to route reads
// through captureColor/captureRule and writes through the resolvers; the
// pure lib carries it as reference data.
var DIM_KIND = {
    pointSize: "scalar", leftIndent: "scalar", rightIndent: "scalar",
    firstLineIndent: "scalar", keepWithNext: "scalar",
    keepLinesTogether: "scalar", spaceBefore: "scalar", spaceAfter: "scalar",
    composer: "scalar",
    leading: "enum-object", justification: "enum-object",
    fillColor: "enum-object", ruleAbove: "enum-object", ruleBelow: "enum-object"
};

// Per-dim dirty comparator spec for the PROTECTED dims (conflict 节
// detection a/b/c, task_plan.md:2628 + :2634).  always-apply dims have no
// creation baseline → no comparator.
//   kind=numeric → BUCKETED-vs-BUCKETED via _roundTol(live, tol) vs already-
//                  bucketed label key (:692/:714-719); tolField picks the tol.
//   kind=leading → AUTO sentinel both-sides normalized, else bucketed.
//   kind=enum    → String() form vs label String() form (:713/:726).
//   kind=rawint  → RAW integer equality (NO bucket — key.kwn is raw :727).
//   kind=bool    → strict boolean equality (key.klt :728).
var DIM_COMPARATOR = {
    pointSize:         { kind: "numeric", labelKey: "fs",   tolField: "fontSize_pt" },
    leading:           { kind: "leading", labelKey: "lead", tolField: "leading_pt" },
    leftIndent:        { kind: "numeric", labelKey: "lI",   tolField: "indent_pt" },
    rightIndent:       { kind: "numeric", labelKey: "rI",   tolField: "indent_pt" },
    firstLineIndent:   { kind: "numeric", labelKey: "fI",   tolField: "indent_pt" },
    justification:     { kind: "enum",    labelKey: "just" },
    composer:          { kind: "enum",    labelKey: "comp" },
    keepWithNext:      { kind: "rawint",  labelKey: "kwn" },
    keepLinesTogether: { kind: "bool",    labelKey: "klt" }
};

// Rule read-back compares this field set + `active` (conflict 节判据
// task_plan.md:2638).  color/gapColor compared via norm; the rest by
// scalar/enum-string equality.  Fields absent (null/undefined) in the
// intended payload are skipped (auto-pass) because _applyRuleSpec skips
// null fields (:2208).
var RULE_SCALAR_FIELDS = [
    "weight", "offset", "type", "width", "tint", "gapTint",
    "overprint", "leftIndent", "rightIndent"
];

// Among RULE_SCALAR_FIELDS the ONLY genuine enum is `width` (RuleWidth:
// "TEXT_WIDTH"/"COLUMN_WIDTH"; a live String() may carry a "RuleWidth." prefix
// → normalize via _enumStr).  `type` is a stroke-style NAME, not an enum
// (visual_snapshot.js:201 — InDesign returns a string like "Solid" / "Thin -
// Thin" OR a CUSTOM style name that may contain ".", e.g. literally "1.5
// Dashed"); it MUST be compared as a RAW string — _enumStr's split-on-"." would
// truncate "1.5 Dashed" → "5 Dashed" and silently false-pass a mismatch (P4).
// All other RULE_SCALAR_FIELDS are numeric/bool (strict ===).
var RULE_ENUM_FIELDS = { width: true };

// Width / stretch tokens stripped (whole-word, incl. semi/extra/ultra
// compound forms, joined or spaced) BEFORE weight classification so
// "SemiCondensed" does not leak "semi" into the weight discriminator
// (r8 PIN, task_plan.md:2509).  Width itself does NOT enter the weight
// token — width-only same-geometry variants collapse to the same match_key
// and are caught by the uniqueness assertion, not silently.
var WIDTH_RE = /(?:semi|extra|ultra)?[\s_-]*(?:condensed|compressed|expanded|extended|narrow|wide)/gi;

// ─── ES5 micro-helpers ─────────────────────────────────────────────

function _indexOf(arr, v) {
    for (var i = 0; i < arr.length; i++) { if (arr[i] === v) return i; }
    return -1;
}
function _isArray(x) { return Object.prototype.toString.call(x) === "[object Array]"; }
function _has(obj, k) { return obj != null && Object.prototype.hasOwnProperty.call(obj, k); }
function _numOr(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
function _numArr(v) {
    var out = [];
    if (_isArray(v)) { for (var i = 0; i < v.length; i++) out.push(Number(v[i])); }
    return out;
}

// Recursively sort object keys (arrays left in order) → canonical JSON so
// payload key-order noise never produces a false revision / false
// "differing payload" diagnostic (a voice flagged unstable ordering).
function _canonicalize(obj) {
    if (obj === null || typeof obj !== "object") return obj;
    if (_isArray(obj)) {
        var arr = [];
        for (var i = 0; i < obj.length; i++) arr.push(_canonicalize(obj[i]));
        return arr;
    }
    var keys = [];
    for (var k in obj) { if (_has(obj, k)) keys.push(k); }
    keys.sort();
    var out = {};
    for (var j = 0; j < keys.length; j++) out[keys[j]] = _canonicalize(obj[keys[j]]);
    return out;
}
function _canonicalJSON(obj) { return JSON.stringify(_canonicalize(obj)); }

// ───────────────────────────────────────────────────────────────────
// R2 — match_key derivation
// ───────────────────────────────────────────────────────────────────

// Parse a creation label: ("M:"|"B:")? + JSON.stringify(fingerprint key).
// Returns { prefix, key } or null when the label is foreign / prefix-less /
// non-JSON (caller treats null as skip-and-report).
function _parseLabel(label) {
    var body = (label == null) ? "" : String(label);
    var prefix = "";
    if (body.indexOf("M:") === 0) { prefix = "M:"; body = body.substring(2); }
    else if (body.indexOf("B:") === 0) { prefix = "B:"; body = body.substring(2); }
    var key = null;
    try { key = JSON.parse(body); } catch (e) { return null; }
    if (key === null || typeof key !== "object" || _isArray(key)) return null;
    return { prefix: prefix, key: key };
}

// Full creation fingerprint key (incl. latinFamily/latinStyle) — operators
// feed this to the dirty comparator as `creationKey`.
function parseCreationKey(label) {
    var p = _parseLabel(label);
    return p ? p.key : null;
}

// font-agnostic weight-class token (r8 PIN table + r9 oblique→italic fold,
// task_plan.md:2509). Strip width/stretch FIRST, then ordered first-hit
// substring → seven canonical tokens {regular, bold, semibold, medium,
// light, black, italic}.  demi≡semi→semibold, heavy≡black→black,
// oblique≡italic→italic.  Order matters: semi/demi BEFORE bare bold so
// "Semibold" (contains "bold") classes as semibold, not bold.
function weightClass(latinStyle) {
    var s = (latinStyle == null) ? "" : String(latinStyle);
    s = s.toLowerCase().replace(WIDTH_RE, " ");
    if (s.indexOf("semi") >= 0 || s.indexOf("demi") >= 0) return "semibold";
    if (s.indexOf("medium") >= 0) return "medium";
    if (s.indexOf("light") >= 0) return "light";
    if (s.indexOf("black") >= 0 || s.indexOf("heavy") >= 0) return "black";
    if (s.indexOf("oblique") >= 0 || s.indexOf("italic") >= 0) return "italic";
    if (s.indexOf("bold") >= 0) return "bold";
    return "regular";
}

// stripFontDims(label): drop latinFamily/latinStyle, KEEP M:/B: prefix.
// parse → strip font keys → re-prepend prefix.  Byte-stable: both export &
// apply parse the SAME label text → JSON.parse preserves key order → delete
// → JSON.stringify re-emits identical residue (task_plan.md:2597).
function stripFontDims(label) {
    var p = _parseLabel(label);
    if (!p) return null;
    delete p.key.latinFamily;
    delete p.key.latinStyle;
    return p.prefix + JSON.stringify(p.key);
}

// match_key = stripFontDims(label) + "|w:" + weightClass(latinStyle).
// weightClass needs latinStyle (read BEFORE stripping); export & apply use
// THIS SAME function ⟹ derivation byte-identical (task_plan.md:2552/:2597).
function deriveMatchKey(label) {
    var p = _parseLabel(label);
    if (!p) return null;
    var wc = weightClass(p.key.latinStyle);
    delete p.key.latinFamily;
    delete p.key.latinStyle;
    return p.prefix + JSON.stringify(p.key) + "|w:" + wc;
}

// Coarse candidate key for near-miss suggestions: {role, color,
// justification} (qual_key, task_plan.md:2554/:2518).  color uses the norm
// binding/explicit token so a synthetic-swatch rename does not break it.
function deriveQualKey(opts) {
    opts = opts || {};
    var role = (opts.role == null) ? "" : String(opts.role);
    var just = _enumStr(opts.justification == null ? "" : opts.justification);
    var n = norm(opts.fillColor || null);
    var colorTok = (n.kind === "explicit")
        ? ("e:" + (n.key.space || "?") + ":" + n.key.values.join(","))
        : ("b:" + n.key);
    return role + "|c:" + colorTok + "|j:" + just;
}

// ───────────────────────────────────────────────────────────────────
// R2 — export uniqueness assertion + apply matcher (A1 三件套)
// ───────────────────────────────────────────────────────────────────

function payloadHash(payload) { return _shortHash(_canonicalJSON(payload || {})); }
function payloadsEqual(a, b) { return _canonicalJSON(a || {}) === _canonicalJSON(b || {}); }

// EXPORT-time uniqueness assertion (task_plan.md:2597 (1) + :2510).  Group
// entries by match_key:
//   - byte-equal payloads collide      → COLLAPSE to one entry (keeps the
//     first entry's advisory name/_resolved_font; the others' advisory is
//     dropped by design — zero apply-side data loss, G→r7 C-fold).
//   - differing payloads collide       → duplicate-key diagnostic (caller
//     warn/refuse), entries kept so the diagnostic can name them.
// Returns { entries: collapsed[], diagnostics: [...], collapsedGroups: [...] }.
function collapseEntries(entries) {
    entries = entries || [];
    var order = [];            // preserve first-seen match_key order
    var groups = {};           // match_key → entry[]
    var i;
    for (i = 0; i < entries.length; i++) {
        var mk = entries[i].match_key;
        if (!_has(groups, mk)) { groups[mk] = []; order.push(mk); }
        groups[mk].push(entries[i]);
    }
    var out = [];
    var diagnostics = [];
    var collapsedGroups = [];
    for (i = 0; i < order.length; i++) {
        var key = order[i];
        var grp = groups[key];
        if (grp.length === 1) { out.push(grp[0]); continue; }
        var allEqual = true;
        for (var j = 1; j < grp.length; j++) {
            if (!payloadsEqual(grp[j].payload, grp[0].payload)) { allEqual = false; break; }
        }
        if (allEqual) {
            out.push(grp[0]);   // COLLAPSE → one
            collapsedGroups.push({ match_key: key, count: grp.length });
        } else {
            for (var m = 0; m < grp.length; m++) out.push(grp[m]);
            diagnostics.push({
                kind: "duplicate-key",
                match_key: key,
                count: grp.length,
                names: _names(grp),
                message: "differing payloads under same match_key (" + key + ")"
            });
        }
    }
    return { entries: out, diagnostics: diagnostics, collapsedGroups: collapsedGroups };
}

function _names(grp) {
    var out = [];
    for (var i = 0; i < grp.length; i++) out.push(grp[i].name || null);
    return out;
}

// APPLY-side index: match_key → entry[] (LIST, never lossy map).
function indexEntries(entries) {
    var byKey = {};
    entries = entries || [];
    for (var i = 0; i < entries.length; i++) {
        var mk = entries[i].match_key;
        if (!_has(byKey, mk)) byKey[mk] = [];
        byKey[mk].push(entries[i]);
    }
    return byKey;
}

// APPLY-side exact-match outcome for a stub's match_key bucket (decision-C
// outcome 1, task_plan.md:2599 + G→r6 A1 alignment with export rule):
//   no entry         → { outcome: "none" }
//   exactly one      → { outcome: "one", entry }
//   >1 all byte-equal→ { outcome: "one", entry, collapsedSilently: true }
//   >1 any differing → { outcome: "ambiguous", reason } (skip + report,
//                       NEVER silent last-write-wins)
function resolveMatch(entryList) {
    if (!entryList || !entryList.length) return { outcome: "none" };
    if (entryList.length === 1) return { outcome: "one", entry: entryList[0] };
    var allEqual = true;
    for (var i = 1; i < entryList.length; i++) {
        if (!payloadsEqual(entryList[i].payload, entryList[0].payload)) { allEqual = false; break; }
    }
    if (allEqual) return { outcome: "one", entry: entryList[0], collapsedSilently: true };
    return { outcome: "ambiguous", reason: "differing payloads under same match_key", count: entryList.length };
}

// ───────────────────────────────────────────────────────────────────
// R3 — payload classification + force-POINTS helper
// ───────────────────────────────────────────────────────────────────

function classifyDim(dim) {
    if (_indexOf(PROTECTED_DIMS, dim) >= 0) return "protected";
    if (_indexOf(ALWAYS_APPLY_DIMS, dim) >= 0) return "always-apply";
    return null;
}

// Report-line reason for every always-apply (carve-out) dim — differs only
// in the cause string (task_plan.md:2636).
function carveOutReason(dim) {
    if (dim === "spaceBefore" || dim === "spaceAfter") return "no creation baseline";
    if (dim === "fillColor" || dim === "ruleAbove" || dim === "ruleBelow") return "ICC baseline unreconstructable";
    return null;
}

// Invariant guard (tests assert ok===true): the protected + always-apply
// sets are mutually exclusive AND exhaust PAYLOAD_DIMS.
function dimPartitionCheck() {
    var missing = [];       // payload dims in neither set
    var overlap = [];       // dims in both sets
    var unknown = [];       // dims in a set but not in PAYLOAD_DIMS
    var i;
    for (i = 0; i < PAYLOAD_DIMS.length; i++) {
        var d = PAYLOAD_DIMS[i];
        var inP = _indexOf(PROTECTED_DIMS, d) >= 0;
        var inA = _indexOf(ALWAYS_APPLY_DIMS, d) >= 0;
        if (inP && inA) overlap.push(d);
        if (!inP && !inA) missing.push(d);
    }
    var all = PROTECTED_DIMS.concat(ALWAYS_APPLY_DIMS);
    for (i = 0; i < all.length; i++) {
        if (_indexOf(PAYLOAD_DIMS, all[i]) < 0) unknown.push(all[i]);
    }
    return {
        ok: (missing.length === 0 && overlap.length === 0 && unknown.length === 0),
        missing: missing, overlap: overlap, unknown: unknown
    };
}

// Build a clean payload object from captured per-dim values: keep only the
// 14 known dims, drop appliedFont/fontStyle (font-free invariant ①,
// task_plan.md:2574), stable key order.  Captured shapes (captureColor /
// captureRule output) pass through verbatim — assembly only, no host read.
function buildPayload(captured) {
    captured = captured || {};
    var out = {};
    for (var i = 0; i < PAYLOAD_DIMS.length; i++) {
        var d = PAYLOAD_DIMS[i];
        if (_has(captured, d)) out[d] = captured[d];
    }
    return out;
}

// force-POINTS / restore helper (A2 dual-pin, task_plan.md:2588 + :2716).
// Dependency-injected so it is host-agnostic + testable: host = { app, doc,
// MeasurementUnits }.  Primary pin = app.scriptPreferences.measurementUnit
// (governs script-context ParagraphStyle numeric I/O — probe 20260610_03);
// fallback pin = doc.viewPreferences.{horizontal,vertical}MeasurementUnits
// (AUTO-delegation path + matches shipped pipeline reorganize_inplace_core
// .js:657-660 / v2_pipeline.js:954-965).  Dual-restore in finally.  Operators
// wrap their live reads (export) and bulk writes (apply) with this INSIDE
// their ENTIRE_SCRIPT doScript block.
function withPointsMeasurement(host, fn) {
    host = host || {};
    var app = host.app, doc = host.doc, MU = host.MeasurementUnits;
    var POINTS = MU ? MU.POINTS : null;
    var saved = { script: undefined, h: undefined, v: undefined };
    var sp = (app && app.scriptPreferences) ? app.scriptPreferences : null;
    var vp = (doc && doc.viewPreferences) ? doc.viewPreferences : null;
    if (sp) {
        try { saved.script = sp.measurementUnit; } catch (e0) {}
        if (POINTS !== null) { try { sp.measurementUnit = POINTS; } catch (e1) {} }
    }
    if (vp) {
        try { saved.h = vp.horizontalMeasurementUnits; } catch (e2) {}
        try { saved.v = vp.verticalMeasurementUnits; } catch (e3) {}
        if (POINTS !== null) {
            try { vp.horizontalMeasurementUnits = POINTS; } catch (e4) {}
            try { vp.verticalMeasurementUnits = POINTS; } catch (e5) {}
        }
    }
    try {
        return fn();
    } finally {
        if (sp && saved.script !== undefined) { try { sp.measurementUnit = saved.script; } catch (e6) {} }
        if (vp) {
            if (saved.h !== undefined) { try { vp.horizontalMeasurementUnits = saved.h; } catch (e7) {} }
            if (saved.v !== undefined) { try { vp.verticalMeasurementUnits = saved.v; } catch (e8) {} }
        }
    }
}

// ───────────────────────────────────────────────────────────────────
// R4 — norm() TOTAL read-back verdict (always-apply color/rule)
// ───────────────────────────────────────────────────────────────────

// Normalize an enum-ish value to a comparable string, stripping any
// "Enum." prefix (mirrors _resolveJustification:2063 / captureParagraphSnapshot
// String() forms).  Idempotent on plain strings.
function _enumStr(v) {
    var s = (v == null) ? "" : String(v);
    if (s.indexOf(".") >= 0) s = s.split(".").pop();
    return s;
}

// Binding token for a captured color: swatch/sentinel name with the
// "Text Color" ≡ "[Text Color]" step-0 normalization (_resolveFillColor:2267).
function _colorToken(c) {
    var sw = (c && c.swatch != null) ? String(c.swatch) : "";
    if (sw === "[Text Color]") sw = "Text Color";
    return sw;
}

// norm(c) — values-first dispatch (G→r9 ②): a color carrying EXPLICIT
// numeric `values` → explicit kind (compare {space,values}); otherwise →
// binding kind (compare swatch/sentinel token).  Synthetic _T_color_* swatch
// names are NEVER compared (both paths avoid the name).  c is a captured
// shape ({swatch, space, values, ...}) or null (task_plan.md:2642).
function norm(c) {
    if (c && _isArray(c.values) && c.values.length > 0) {
        return {
            kind: "explicit",
            key: { space: (c.space == null) ? null : String(c.space), values: _numArr(c.values) }
        };
    }
    return { kind: "binding", key: _colorToken(c) };
}

function _normKeyEqual(ni, nl) {
    if (ni.kind !== nl.kind) return false;
    if (ni.kind === "binding") return ni.key === nl.key;
    // explicit: space + element-wise values
    if (ni.key.space !== nl.key.space) return false;
    var a = ni.key.values, b = nl.key.values;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
    return true;
}

function _describeNorm(n) {
    if (n.kind === "binding") return 'binding "' + n.key + '"';
    return "explicit " + (n.key.space || "?") + ":[" + n.key.values.join(",") + "]";
}

// readBackVerdict(intended, live) — TOTAL function over (intended-kind ×
// live-kind), four cells, NO unclassified cell (G→r8 A-class, task_plan.md
// :2641-2646).  norm both sides; equal → applied-OK, ANY inequality →
// applied-FAILED/no-op.  binding×same-binding → OK (binding preserved);
// explicit×explicit-match → OK (compare {space,values}, not swatch name);
// binding×explicit / explicit×binding / binding×other-binding /
// explicit×other-rgb → FAILED.
function readBackVerdict(intended, live) {
    var ni = norm(intended);
    var nl = norm(live);
    if (_normKeyEqual(ni, nl)) {
        return { verdict: "applied-OK", intended: ni, live: nl };
    }
    return {
        verdict: "applied-FAILED",
        reason: "write did not land as intended (intended " + _describeNorm(ni) + ", live " + _describeNorm(nl) + ")",
        intended: ni, live: nl
    };
}

// ruleReadBackVerdict(intended, live) — captureRule shapes.  active must
// match; null intended fields skipped (auto-pass, _applyRuleSpec skips null
// :2208); color/gapColor via readBackVerdict (norm); genuine enum fields
// (RULE_ENUM_FIELDS, i.e. `width`) prefix-normalized via _enumStr; the rule
// `type` is a stroke-style NAME compared as a RAW string (P4); numeric/bool
// scalars by strict equality (read-back of a value just written) (:2638-2639).
function ruleReadBackVerdict(intended, live) {
    intended = intended || { active: false };
    live = live || { active: false };
    var iActive = !!intended.active;
    var lActive = !!live.active;
    if (iActive !== lActive) {
        return {
            verdict: "applied-FAILED",
            reason: "rule active mismatch (intended " + iActive + ", live " + lActive + ")",
            field: "active"
        };
    }
    if (!iActive) return { verdict: "applied-OK" };   // both inactive → OK

    var i, f;
    for (i = 0; i < RULE_SCALAR_FIELDS.length; i++) {
        f = RULE_SCALAR_FIELDS[i];
        if (intended[f] === null || intended[f] === undefined) continue;   // null-skip
        var iv = intended[f], lv = live[f];
        var eq;
        if (_has(RULE_ENUM_FIELDS, f)) {
            eq = (_enumStr(iv) === _enumStr(lv));        // genuine enum — strip "Enum." prefix
        } else if (typeof iv === "string" || typeof lv === "string") {
            eq = (String(iv) === String(lv));            // stroke-style NAME / raw string — dot-safe, NO _enumStr (P4)
        } else {
            eq = (iv === lv);                            // numeric / bool scalar
        }
        if (!eq) {
            return {
                verdict: "applied-FAILED",
                reason: "rule field '" + f + "' mismatch (intended " + JSON.stringify(iv) + ", live " + JSON.stringify(lv) + ")",
                field: f
            };
        }
    }
    var colorFields = ["color", "gapColor"];
    for (i = 0; i < colorFields.length; i++) {
        f = colorFields[i];
        if (intended[f] === null || intended[f] === undefined) continue;   // null-skip
        var v = readBackVerdict(intended[f], live[f] || null);
        if (v.verdict !== "applied-OK") {
            return {
                verdict: "applied-FAILED",
                reason: "rule field '" + f + "' " + v.reason,
                field: f
            };
        }
    }
    return { verdict: "applied-OK" };
}

// ───────────────────────────────────────────────────────────────────
// R5 — per-dim dirty comparator + three-state reconciliation
// ───────────────────────────────────────────────────────────────────

function _isAutoLeading(v) {
    if (v === "AUTO") return true;
    if (typeof v === "string" && v.indexOf("AUTO") >= 0) return true;
    return false;
}

function _bucket(v, tol) { return _roundTol(_numOr(v, 0), tol); }

// dimEqualsCreation(dim, live, creationKey, tol) — is the live value still
// at its (already-bucketed) creation baseline?  creationKey = parsed
// fingerprint key from the label.  Used for dirty-detection (state-2 of
// reconciliation, and first-run conflict detection).  Returns null for
// always-apply / unknown dims (no reconstructable baseline).
function dimEqualsCreation(dim, live, creationKey, tol) {
    var c = DIM_COMPARATOR[dim];
    if (!c) return null;
    tol = tol || DEFAULT_TOLERANCE;
    var creation = creationKey ? creationKey[c.labelKey] : undefined;
    // P2: a MISSING creation labelKey is a DATA gap (masked fingerprint dim /
    // cross-doc derivation-opts mismatch), NOT a "diverged" signal. Comparing a
    // bucketed live against an undefined creation would read numeric/enum as
    // permanently FALSE (→ false-dirty → silent keep-local that "looks like
    // protection") and read rawint 0 / bool false as undefined→0/false EQUAL
    // (→ false-untouched). Both conflate "never recorded" with a concrete value.
    // → null = "no baseline, cannot compare" (mirrors the unknown-dim null;
    // dirtyDim maps it to null = not dirty-trackable; reconcile/resolve surface
    // "no-baseline"). Distinct from a legit creation === 0/false (key PRESENT).
    if (creation === undefined) return null;
    switch (c.kind) {
        case "numeric":
            return _bucket(live, tol[c.tolField]) === creation;
        case "leading":
            if (_isAutoLeading(live)) return creation === "AUTO";
            if (creation === "AUTO") return false;
            return _bucket(live, tol.leading_pt) === creation;
        case "enum":
            return _enumStr(live) === _enumStr(creation);
        case "rawint":
            return (_numOr(live, 0)) === (_numOr(creation, 0));
        case "bool":
            return (!!live) === (!!creation);
    }
    return null;
}

// dirty(dim) ≜ bucket(live) ≠ bucket(creation) (task_plan.md:2625).
// null (no baseline) → not a dirty-trackable dim.
function dirtyDim(dim, live, creationKey, tol) {
    var eq = dimEqualsCreation(dim, live, creationKey, tol);
    if (eq === null) return null;
    return !eq;
}

// dimEqualsValue(dim, live, value, tol) — typed comparison of live against
// an ARBITRARY value (the stamped applied_values[dim]); buckets BOTH sides
// for numeric/leading (the stamped value was written raw; read-back may
// carry float noise — r7 C-fold avoids 21.0 vs 21.0000001 false state-3).
function dimEqualsValue(dim, live, value, tol) {
    var c = DIM_COMPARATOR[dim];
    if (!c) return null;
    // P1: a MISSING applied_values[dim] (key absent → undefined; a JSON-parsed
    // stamp never yields undefined for a PRESENT key) means this dim was NEVER
    // applied. It must NOT compare-equal to a live 0/false: numeric/rawint coerce
    // undefined→0 and bool coerces undefined→false, which would falsely read a
    // live 0/false as "still at the last-applied value" → state-1 "update" →
    // SILENT overwrite of a kept-local protected dim. A missing applied value is
    // never "equal" → false, so the caller falls through to the creation/dirty
    // path (spec :2649 "或从未 apply 过": live==creation → untouched, else keep-local).
    if (value === undefined) return false;
    tol = tol || DEFAULT_TOLERANCE;
    switch (c.kind) {
        case "numeric":
            return _bucket(live, tol[c.tolField]) === _bucket(value, tol[c.tolField]);
        case "leading":
            if (_isAutoLeading(live) || _isAutoLeading(value)) {
                return _isAutoLeading(live) === _isAutoLeading(value);
            }
            return _bucket(live, tol.leading_pt) === _bucket(value, tol.leading_pt);
        case "enum":
            return _enumStr(live) === _enumStr(value);
        case "rawint":
            return (_numOr(live, 0)) === (_numOr(value, 0));
        case "bool":
            return (!!live) === (!!value);
    }
    return null;
}

// re-apply per-dim three-state reconciliation (G→r6 A5, task_plan.md:2647-
// 2651).  PER-DIM, isolated — a verdict on one dim never touches another.
//   state-1  live == applied_values[dim]                 → "update" (safe to
//            update to the new-rev preset value)
//   state-2  live != applied AND live == creation bucket → "untouched" (was
//            reverted/undone to creation — take preset; absorbs undo-residual)
//   state-3  live != applied AND live != creation        → "keep-local"
//            (designer edited after apply)
//   no-baseline  creation labelKey ABSENT (data gap)      → "no-baseline" (P2:
//            cannot compare — surface, do NOT silently keep-local)
// Always-apply (carve-out) dims have no creation baseline → returns
// "always-apply" (caller overwrites every run + reports).
// A MISSING applied_values[dim] (undefined) skips state-1 (it was never applied)
// and is reconciled by state-2/3 against creation (spec :2649 "或从未 apply 过") —
// never a false state-1 "update" off a 0/false-conflated undefined (P1).
function reconcileDim(dim, live, appliedValue, creationKey, tol) {
    if (classifyDim(dim) === "always-apply") return "always-apply";
    if (!DIM_COMPARATOR[dim]) return "always-apply";
    // state-1 ONLY when an applied record EXISTS (key present). P1: a missing
    // applied_values[dim] (undefined — kept-local on a prior conflict, absent
    // per :2617) must fall through, never read as "update" off a live 0/false.
    if (appliedValue !== undefined && dimEqualsValue(dim, live, appliedValue, tol)) {
        return "update";                                                     // state-1
    }
    // P2: a missing creation baseline (labelKey absent → null) is a DATA gap,
    // not a confident verdict — surface "no-baseline" rather than silent keep-local.
    var eqCreation = dimEqualsCreation(dim, live, creationKey, tol);
    if (eqCreation === null) return "no-baseline";
    if (eqCreation) return "untouched";                                      // state-2 (incl. "从未 apply 过")
    return "keep-local";                                                     // state-3
}

// First-run conflict resolution (no prior stamp) for a PROTECTED dim
// (task_plan.md:2630-2631):
//   untouched (live == creation) → "take-preset"; else → "keep-local".
// `presetWins` run-level toggle forces "take-preset".
// P2: a missing creation baseline (labelKey absent → null) → "no-baseline"
// (cannot compare — surface, do not silently keep-local).
function resolveConflict(dim, live, creationKey, tol, presetWins) {
    if (classifyDim(dim) === "always-apply") return "always-apply";
    if (presetWins) return "take-preset";
    var eqCreation = dimEqualsCreation(dim, live, creationKey, tol);
    if (eqCreation === null) return "no-baseline";
    if (eqCreation) return "take-preset";   // untouched (live == creation)
    return "keep-local";
}

// Apply uses the RECORDED per-dim tol (G→r6 A2, task_plan.md:2542) — never
// independently assume DEFAULT_TOLERANCE.  Falls back to DEFAULT (legible)
// with usedDefault=true when a preset lacks the field.
function extractTolerances(preset) {
    var rec = preset && preset.tooling && preset.tooling.derivation_opts
        && preset.tooling.derivation_opts.tolerance;
    var fields = ["fontSize_pt", "leading_pt", "indent_pt", "space_pt"];
    var tol = {};
    var usedDefault = false;
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var v = rec ? Number(rec[f]) : NaN;
        if (isFinite(v)) { tol[f] = v; }
        else { tol[f] = DEFAULT_TOLERANCE[f]; usedDefault = true; }
    }
    return { tolerance: tol, usedDefault: usedDefault };
}

// ───────────────────────────────────────────────────────────────────
// R1 — schema build / validate / hash
// ───────────────────────────────────────────────────────────────────

// derivation_id = logic version + hash over the normalization logic version
// + ACTUAL per-dim tolerance + opts (G→r5 B-fold + G→r6 A2: tol value is
// part of derivation logic, task_plan.md:2530).  Bumps whenever tol/opts
// change ⟹ cross-rev detectable via preset_content_hash.
function computeDerivationId(derivationOpts) {
    derivationOpts = derivationOpts || {};
    var tol = derivationOpts.tolerance || {};
    var parts = {
        logic: DERIVATION_LOGIC_VERSION,
        tolerance: {
            fontSize_pt: _numOr(tol.fontSize_pt, null),
            leading_pt: _numOr(tol.leading_pt, null),
            indent_pt: _numOr(tol.indent_pt, null),
            space_pt: _numOr(tol.space_pt, null)
        },
        splitMasterFromBody: derivationOpts.splitMasterFromBody !== false,
        spacePreservingMerge: derivationOpts.spacePreservingMerge !== false,
        dims: derivationOpts.dims || "default"
    };
    return DERIVATION_LOGIC_VERSION + ":" + _shortHash(JSON.stringify(parts));
}

// Stable canonical entry order BEFORE hashing (a voice flagged unstable sort
// → false revisions).  Total order: match_key → payload_hash → name →
// qual_key.  Returns a NEW array (does not mutate input).
function canonicalizeEntries(entries) {
    var arr = (entries || []).slice();
    arr.sort(function (a, b) {
        var ak = a.match_key || "", bk = b.match_key || "";
        if (ak !== bk) return ak < bk ? -1 : 1;
        var ah = a.payload_hash || payloadHash(a.payload), bh = b.payload_hash || payloadHash(b.payload);
        if (ah !== bh) return ah < bh ? -1 : 1;
        var an = a.name || "", bn = b.name || "";
        if (an !== bn) return an < bn ? -1 : 1;
        var aq = JSON.stringify(a.qual_key || ""), bq = JSON.stringify(b.qual_key || "");
        if (aq !== bq) return aq < bq ? -1 : 1;
        return 0;
    });
    return arr;
}

// preset_content_hash covers {match_key, payload} (per entry, canonical
// order) + derivation_id + schema_version (G→r5 B-fold, task_plan.md:2529).
// So a "match_key/normalization changed but value didn't" revision still
// produces a new hash (no silent missed rev).
function computePresetContentHash(entries, derivationId, schemaVersion) {
    var canon = canonicalizeEntries(entries);
    var coverage = [];
    for (var i = 0; i < canon.length; i++) {
        coverage.push({ match_key: canon[i].match_key, payload: _canonicalize(canon[i].payload || {}) });
    }
    return _shortHash(JSON.stringify({
        entries: coverage,
        derivation_id: derivationId,
        schema_version: schemaVersion
    }));
}

// Convenience: signature-set hash of the source document's style identities
// (sorted match_keys) for source_document.source_hash.
function computeSourceHash(matchKeys) {
    var arr = (matchKeys || []).slice();
    arr.sort();
    return _shortHash(JSON.stringify(arr));
}

// buildPreset(opts) — assemble + hash a complete brand_style_preset.json.
//   opts: { presetId, entries, sourceDocument, derivationOpts, exporterCommit,
//           createdAt, updatedAt }
//   entries: [{ name?, match_key, role?, qual_key?, payload, _resolved_font? }]
// Computes payload_hash per entry, derivation_id, and preset_content_hash
// over the canonical entry order.  Does NOT collapse duplicates — call
// collapseEntries first (export operator) and pass the collapsed list.
function buildPreset(opts) {
    opts = opts || {};
    var srcEntries = opts.entries || [];
    var entries = [];
    for (var i = 0; i < srcEntries.length; i++) {
        var e = srcEntries[i];
        entries.push({
            name: (e.name == null) ? null : String(e.name),
            match_key: e.match_key,
            role: (e.role == null) ? null : String(e.role),
            qual_key: (e.qual_key == null) ? null : e.qual_key,
            payload: e.payload || {},
            payload_hash: e.payload_hash || payloadHash(e.payload),
            _resolved_font: (e._resolved_font == null) ? null : e._resolved_font
        });
    }
    var derivationOpts = opts.derivationOpts || {};
    var derivationId = computeDerivationId(derivationOpts);
    var preset = {
        schema_version: SCHEMA_VERSION,
        kind: PRESET_KIND,
        preset_id: (opts.presetId == null) ? null : String(opts.presetId),
        preset_content_hash: null,   // filled below
        derivation_id: derivationId,
        created_at: (opts.createdAt == null) ? null : String(opts.createdAt),
        updated_at: (opts.updatedAt == null) ? null : String(opts.updatedAt),
        source_document: opts.sourceDocument || { name: null, source_hash: null },
        tooling: {
            exporter_commit: (opts.exporterCommit == null) ? null : String(opts.exporterCommit),
            derivation_opts: {
                tolerance: {
                    fontSize_pt: _numOr(derivationOpts.tolerance && derivationOpts.tolerance.fontSize_pt, DEFAULT_TOLERANCE.fontSize_pt),
                    leading_pt: _numOr(derivationOpts.tolerance && derivationOpts.tolerance.leading_pt, DEFAULT_TOLERANCE.leading_pt),
                    indent_pt: _numOr(derivationOpts.tolerance && derivationOpts.tolerance.indent_pt, DEFAULT_TOLERANCE.indent_pt),
                    space_pt: _numOr(derivationOpts.tolerance && derivationOpts.tolerance.space_pt, DEFAULT_TOLERANCE.space_pt)
                },
                splitMasterFromBody: derivationOpts.splitMasterFromBody !== false,
                spacePreservingMerge: derivationOpts.spacePreservingMerge !== false,
                dims: derivationOpts.dims || "default"
            }
        },
        entries: entries
    };
    preset.preset_content_hash = computePresetContentHash(entries, derivationId, SCHEMA_VERSION);
    return preset;
}

// validatePreset(obj) → { ok, errors[], warnings[] }.  Structural + font-free
// invariant (no appliedFont/fontStyle in any payload, ①) + tolerance-present
// + recomputed-content-hash check.
function validatePreset(obj) {
    var errors = [], warnings = [];
    function err(m) { errors.push(m); }
    function warn(m) { warnings.push(m); }

    if (obj == null || typeof obj !== "object") {
        return { ok: false, errors: ["preset is not an object"], warnings: warnings };
    }
    if (obj.schema_version !== SCHEMA_VERSION) err("schema_version must be " + SCHEMA_VERSION + " (got " + JSON.stringify(obj.schema_version) + ")");
    if (obj.kind !== PRESET_KIND) err('kind must be "' + PRESET_KIND + '"');
    if (typeof obj.preset_id !== "string" || !obj.preset_id) err("preset_id must be a non-empty string");
    if (typeof obj.derivation_id !== "string" || !obj.derivation_id) err("derivation_id must be a non-empty string");

    var tol = obj.tooling && obj.tooling.derivation_opts && obj.tooling.derivation_opts.tolerance;
    if (!tol) err("tooling.derivation_opts.tolerance missing (tol must travel — A2)");
    else {
        var tf = ["fontSize_pt", "leading_pt", "indent_pt", "space_pt"];
        for (var t = 0; t < tf.length; t++) {
            if (!isFinite(Number(tol[tf[t]]))) err("tolerance." + tf[t] + " must be a finite number");
        }
    }

    if (!_isArray(obj.entries)) { err("entries must be an array"); return { ok: errors.length === 0, errors: errors, warnings: warnings }; }
    for (var i = 0; i < obj.entries.length; i++) {
        var e = obj.entries[i];
        var tag = "entries[" + i + "]";
        if (e == null || typeof e !== "object") { err(tag + " is not an object"); continue; }
        if (typeof e.match_key !== "string" || !e.match_key) err(tag + ".match_key must be a non-empty string");
        if (e.payload == null || typeof e.payload !== "object") { err(tag + ".payload must be an object"); continue; }
        // Font-free invariant ① — payload must NOT carry font dims.
        if (_has(e.payload, "appliedFont")) err(tag + '.payload carries forbidden "appliedFont" (font-free invariant ①)');
        if (_has(e.payload, "fontStyle")) err(tag + '.payload carries forbidden "fontStyle" (font-free invariant ①)');
        // Only known dims allowed.
        for (var pk in e.payload) {
            if (!_has(e.payload, pk)) continue;
            if (_indexOf(PAYLOAD_DIMS, pk) < 0) warn(tag + '.payload has unknown dim "' + pk + '"');
        }
        if (e.payload_hash != null && e.payload_hash !== payloadHash(e.payload)) {
            warn(tag + ".payload_hash stale (recompute differs)");
        }
    }

    // Recompute content hash (staleness anchor).
    var recomputed = computePresetContentHash(obj.entries, obj.derivation_id, obj.schema_version);
    if (obj.preset_content_hash != null && obj.preset_content_hash !== recomputed) {
        warn("preset_content_hash does not match recomputed (" + obj.preset_content_hash + " vs " + recomputed + ")");
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

// ───────────────────────────────────────────────────────────────────
// R1/R5 support — drift stamp (LIST-of-records, stub_identity = full label)
// ───────────────────────────────────────────────────────────────────

// stub_identity LOCK (G→r6 B-fold, task_plan.md:2617) = the COMPLETE
// creation label (full fingerprint incl. the latinFamily/latinStyle keys
// match_key strips).  Two stubs that collapse to one match_key differ ONLY in
// font family → their full labels differ ⟹ stable, drift-immune disambiguator.
function stubIdentity(label) { return (label == null) ? "" : String(label); }

// One per_style record.  applied_payload_hash = djb2 of applied_values →
// whole-record fast-path "did anything change?" short-circuit (A5, :2651).
function buildPerStyleRecord(opts) {
    opts = opts || {};
    var appliedValues = opts.appliedValues || {};
    return {
        match_key: opts.matchKey,
        stub_identity: stubIdentity(opts.stubIdentity != null ? opts.stubIdentity : opts.label),
        applied_dims: opts.appliedDims || [],
        skipped_conflicts: opts.skippedConflicts || [],
        applied_values: appliedValues,
        applied_payload_hash: payloadHash(appliedValues)
    };
}

// Drift stamp written into the Doc-2 .indd via import_state_store sibling
// label STATE_LABEL_KEY (operator persists; this builds the shape).
function buildDriftStamp(opts) {
    opts = opts || {};
    return {
        preset_id: opts.presetId,
        preset_content_hash: opts.presetContentHash,
        derivation_id: opts.derivationId,
        applied_at: (opts.appliedAt == null) ? null : String(opts.appliedAt),
        per_style: opts.perStyle || []
    };
}

// Locate a stamp record by the (match_key, stub_identity) DOUBLE key — same
// match_key multi-stub each keeps its own record, no last-write-wins (A1,
// :2597 (3)).
function findStampRecord(perStyle, matchKey, stubIdentityVal) {
    if (!_isArray(perStyle)) return null;
    for (var i = 0; i < perStyle.length; i++) {
        var r = perStyle[i];
        if (r && r.match_key === matchKey && r.stub_identity === stubIdentityVal) return r;
    }
    return null;
}

// ─── Module exports ────────────────────────────────────────────────

module.exports = {
    // constants
    SCHEMA_VERSION: SCHEMA_VERSION,
    PRESET_KIND: PRESET_KIND,
    DERIVATION_LOGIC_VERSION: DERIVATION_LOGIC_VERSION,
    STATE_LABEL_KEY: STATE_LABEL_KEY,
    DEFAULT_TOLERANCE: DEFAULT_TOLERANCE,
    PAYLOAD_DIMS: PAYLOAD_DIMS,
    PROTECTED_DIMS: PROTECTED_DIMS,
    ALWAYS_APPLY_DIMS: ALWAYS_APPLY_DIMS,
    DIM_KIND: DIM_KIND,
    DIM_COMPARATOR: DIM_COMPARATOR,

    // R2 — match_key derivation
    stripFontDims: stripFontDims,
    weightClass: weightClass,
    deriveMatchKey: deriveMatchKey,
    deriveQualKey: deriveQualKey,
    parseCreationKey: parseCreationKey,
    collapseEntries: collapseEntries,
    indexEntries: indexEntries,
    resolveMatch: resolveMatch,

    // R3 — payload classification + force-POINTS
    classifyDim: classifyDim,
    carveOutReason: carveOutReason,
    dimPartitionCheck: dimPartitionCheck,
    buildPayload: buildPayload,
    withPointsMeasurement: withPointsMeasurement,

    // R4 — norm read-back verdict
    norm: norm,
    readBackVerdict: readBackVerdict,
    ruleReadBackVerdict: ruleReadBackVerdict,

    // R5 — dirty comparator + reconciliation
    dimEqualsCreation: dimEqualsCreation,
    dirtyDim: dirtyDim,
    dimEqualsValue: dimEqualsValue,
    reconcileDim: reconcileDim,
    resolveConflict: resolveConflict,
    extractTolerances: extractTolerances,

    // R1 — schema build / validate / hash
    payloadHash: payloadHash,
    payloadsEqual: payloadsEqual,
    computeDerivationId: computeDerivationId,
    canonicalizeEntries: canonicalizeEntries,
    computePresetContentHash: computePresetContentHash,
    computeSourceHash: computeSourceHash,
    buildPreset: buildPreset,
    validatePreset: validatePreset,

    // drift stamp
    stubIdentity: stubIdentity,
    buildPerStyleRecord: buildPerStyleRecord,
    buildDriftStamp: buildDriftStamp,
    findStampRecord: findStampRecord,

    _internal: {
        _parseLabel: _parseLabel,
        _canonicalize: _canonicalize,
        _canonicalJSON: _canonicalJSON,
        _enumStr: _enumStr,
        _colorToken: _colorToken,
        _normKeyEqual: _normKeyEqual
    }
};
