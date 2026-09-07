"use strict";

/**
 * brand_preset_export_glue.js — PURE SHARED glue for the 8D-ext-G brand-preset
 * round-trip: export_brand_style_preset.idjs (#7, EXPORT) AND
 * apply_brand_style_preset.idjs (#7, APPLY, step #3). Despite the historical
 * "_export_" filename, both operators REQUIRE this module so the cross-operator
 * handoff runs the IDENTICAL code on both sides (no mirror-drift — fable r1 P1).
 *
 * The host-dependent work (resolve active doc, force-POINTS doScript, live
 * ParagraphStyle reads, fs read/write, directory listing) lives in the .idjs
 * operators. THIS module is the pure, Node-testable glue they wire together:
 *   - output-path resolution (export) + preset DISCOVERY pick (apply)
 *   - brand-name resolution (candidate paths + cfg→name extraction; fs INJECTED)
 *   - _T_p_* style collection (gate #2 grouped-walk; doc-like INJECTED)
 *   - deterministic preset_id, role extraction, color-shape normalization,
 *     collapse-diagnostic policy, empty-reason wording, report-summary builder.
 * No host I/O, no app/doc — every host touch is an injected reader/lister so
 * the logic is fully fixture-able and bit-identical export↔apply.
 *
 * The serialization / keying / hashing / schema CORE is style_config_io.js
 * (committed 27f0eab). This module REQUIRES it and never re-implements it; it
 * reuses payloadHash for the stable id hash so id derivation matches the
 * project's one djb2 implementation.
 *
 * UXP / ES5: var only, function expressions, explicit loops. No path.join /
 * path.dirname (UXP-denylisted) — paths are built with explicit sep detection.
 *
 * Spec SoT: task_plan.md "### 8D-ext-G" 持久化节 (:2606-2615 path/anchor +
 * 跨-operator discovery contract #3), schema (:2520-2580), uniqueness
 * (:2510/:2597).
 */

var SCIO = require("./style_config_io.js");

// Stable basename both export AND apply must agree on for the well-known
// stable-anchor location (GUARANTEED-(b), task_plan.md:2609). Brand-named when
// a brand name is known, else the fixed fallback so the round-trip is
// deterministic even with no brand_config.
var FIXED_BASENAME = "brand_style_preset.json";

// ─── path / string helpers (no path.* — UXP-denylisted) ─────────────

function _sepOf(p) { return (p && String(p).indexOf("\\") >= 0) ? "\\" : "/"; }

// Numeric coercion shared by the live-payload reader (NaN/Infinity → 0).
function _num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

// Directory portion of a native path (drops the last path component). Returns
// "" when there is no separator (caller treats as unsaved/no-anchor).
function dirOf(nativePath) {
    var p = (nativePath == null) ? "" : String(nativePath);
    if (!p) return "";
    var sep = _sepOf(p);
    var idx = p.lastIndexOf(sep);
    return (idx > 0) ? p.substring(0, idx) : "";
}

function _joinDirFile(dir, file) {
    var sep = _sepOf(dir);
    if (dir.charAt(dir.length - 1) === sep) return dir + file;
    return dir + sep + file;
}

// Filesystem-safe slug for a brand / doc name. Lowercased, non-alnum runs → "-".
function slugify(s) {
    var str = (s == null) ? "" : String(s);
    return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Strip a trailing file extension (".indd", ".json", …) for stem derivation.
function docStem(name) {
    var s = (name == null) ? "" : String(name);
    return s.replace(/\.[^.\\/]+$/, "");
}

// Brand-level basename. Brand-named when brandName resolves to a non-empty
// slug; else the fixed fallback (task_plan.md:2609).
function presetBasename(brandName) {
    var slug = slugify(brandName);
    if (slug) return slug + "_brand_style_preset.json";
    return FIXED_BASENAME;
}

var _BRAND_NAMED_SUFFIX = "_brand_style_preset.json";

// True if `name` is a BRAND-NAMED preset (`<slug>_brand_style_preset.json`),
// i.e. ends with the suffix AND has a non-empty slug prefix. The bare fixed
// basename (`brand_style_preset.json`) is NOT brand-named (no leading "_").
function _isBrandNamedPreset(name) {
    var n = (name == null) ? "" : String(name);
    if (n.length <= _BRAND_NAMED_SUFFIX.length) return false;   // suffix-only / shorter → no slug
    return n.substring(n.length - _BRAND_NAMED_SUFFIX.length) === _BRAND_NAMED_SUFFIX;
}

// True if `name` is ANY preset file the round-trip recognizes: the fixed
// basename or a brand-named one. Shared so export/apply agree on what counts.
function isPresetBasename(name) {
    var n = (name == null) ? "" : String(name);
    return n === FIXED_BASENAME || _isBrandNamedPreset(n);
}

// ─── brand-name resolution (SHARED export↔apply; fs read INJECTED) ───
//
// fable r1 P1: brand-name resolution was operator-private in the EXPORT .idjs,
// so apply would have to re-implement the candidate order + field priority and
// any drift → divergent basename → silent round-trip break. Hoisted here so
// BOTH operators call the identical logic; the fs read stays host-side, passed
// in as `readJsonFn(path) -> parsedObj|null`.

// Ordered co-located brand_config candidates next to the doc's STABLE anchor
// dir: doc-stem-keyed first (byPair tier-1 convention,
// import_byPair_wiring.js:114), then the shared `brand_config.json`. PURE.
function buildBrandConfigCandidates(docDir, docName) {
    var out = [];
    if (!docDir) return out;
    var stem = docStem(docName);
    if (stem) out.push(_joinDirFile(docDir, stem + "_brand_config.json"));
    out.push(_joinDirFile(docDir, "brand_config.json"));
    return out;
}

// Extract a brand-name field from a parsed brand_config object. Field priority
// matches byPair (validateBrandConfig requires `brand_name`). PURE.
function extractBrandName(cfg) {
    if (cfg == null || typeof cfg !== "object") return null;
    var bn = cfg.brand || cfg.brand_name || cfg.brandName
        || (cfg._meta && (cfg._meta.brand || cfg._meta.brand_name));
    return bn ? String(bn) : null;
}

// Resolve a brand name: explicit override wins; else read the co-located
// brand_config candidates (via injected readJsonFn) and take the first
// extractable brand-name field. NULL → caller uses the fixed basename.
// `readJsonFn` does the host fs read + JSON.parse and returns the parsed object
// or null on any miss; keeping it injected lets export & apply share this whole
// function while each owns its own fs (gate #3 — fs in the operator).
function resolveBrandName(docDir, docName, readJsonFn, explicitBrandName) {
    if (explicitBrandName) return String(explicitBrandName);
    if (!docDir || typeof readJsonFn !== "function") return null;
    var candidates = buildBrandConfigCandidates(docDir, docName);
    for (var i = 0; i < candidates.length; i++) {
        var cfg = null;
        try { cfg = readJsonFn(candidates[i]); } catch (e) { cfg = null; }
        var bn = extractBrandName(cfg);
        if (bn) return bn;
    }
    return null;
}

// ─── _T_p_* style collection (gate #2 grouped walk; doc-like INJECTED) ──
//
// PURE given a doc-like ({allParagraphStyles, paragraphStyles,
// paragraphStyleGroups}) — Node-testable with a mock doc. fable r1 P2: the old
// operator copy keyed a `seen[name]` dedup, which SILENTLY DROPPED a distinct
// same-named grouped style (InDesign style names are unique only PER GROUP —
// two `_T_p_*` with equal names in different groups are legal). No dedup is
// needed: allParagraphStyles has no duplicates and the recursive walk visits
// each style once (style tree, no shared children) — so every distinct style
// survives.
function collectTPStyles(doc) {
    var out = [];
    function isTP(nm) { return nm.indexOf("_T_p_") === 0; }
    // Primary: doc.allParagraphStyles is a JS Array (incl. grouped),
    // [i]-indexed, NOT a collection (script_font_enforcer.js:412-414).
    try {
        var all = doc.allParagraphStyles;
        if (all && typeof all.length === "number") {
            for (var i = 0; i < all.length; i++) {
                var ps = all[i];
                if (!ps) continue;
                var nm = ""; try { nm = String(ps.name); } catch (e) {}
                if (isTP(nm)) out.push(ps);
            }
        }
    } catch (eAll) {}
    if (out.length) return out;
    // Fallback: recursive walk of paragraphStyles + paragraphStyleGroups
    // (flat itemByName misses grouped — gate #2; doc acts as the top group).
    function walk(group) {
        try {
            var pss = group.paragraphStyles;
            if (pss && typeof pss.length === "number") {
                for (var j = 0; j < pss.length; j++) {
                    var p = (typeof pss.item === "function") ? pss.item(j) : pss[j];
                    var n = ""; try { n = String(p.name); } catch (e2) {}
                    if (isTP(n)) out.push(p);
                }
            }
        } catch (e3) {}
        try {
            var gs = group.paragraphStyleGroups;
            if (gs && typeof gs.length === "number") {
                for (var k = 0; k < gs.length; k++) {
                    walk((typeof gs.item === "function") ? gs.item(k) : gs[k]);
                }
            }
        } catch (e4) {}
    }
    walk(doc);
    return out;
}

// ─── output-path resolution (GUARANTEED (a) presetPath / (b) anchor) ──
//
// (a) explicit automationOptions.presetPath → use verbatim (headless, no UI).
// (b) else co-locate the brand-named file next to the SAVED .indd persistent
//     dir (the stable anchor — never the ephemeral tier-2 package dir,
//     task_plan.md:2610). docNativePath = the awaited doc.fullName.nativePath.
// Unsaved doc (no nativePath) AND no presetPath → legible failure object so the
// operator reports "export needs a saved doc or an explicit presetPath" rather
// than crashing on a null path (task_plan.md:2615).
function resolvePresetPath(opts) {
    opts = opts || {};
    var explicit = opts.explicitPresetPath;
    if (explicit) {
        return { ok: true, path: String(explicit), source: "presetPath", basename: _basenameOf(String(explicit)) };
    }
    var docNativePath = opts.docNativePath;
    var dir = dirOf(docNativePath);
    if (!dir) {
        return {
            ok: false,
            error: "doc is unsaved (no fullName/nativePath) and no automationOptions.presetPath given — export needs a saved doc or an explicit presetPath",
            source: "none"
        };
    }
    var basename = presetBasename(opts.brandName);
    return { ok: true, path: _joinDirFile(dir, basename), source: "stable-anchor", basename: basename };
}

function _basenameOf(p) {
    var s = String(p || "");
    var sep = _sepOf(s);
    var idx = s.lastIndexOf(sep);
    return (idx >= 0) ? s.substring(idx + 1) : s;
}

// ─── apply-side preset DISCOVERY pick (SHARED; dir listing INJECTED) ──
//
// The cross-operator discovery contract #3 (task_plan.md G-section): apply
// MUST find the preset by PATTERN, never by recomputing the running doc's stem
// — that is exactly what broke the round trip (Doc-1 writes
// `<brandSlug>_brand_style_preset.json`; Doc-2 has a different stem). The host
// operator tries `automationOptions.presetPath` FIRST (tier a); this PURE
// helper resolves the GLOB tier (b) + fixed fallback (c) from the anchor-dir
// listing it is handed:
//   entries — array of basenames (strings) OR {name, mtimeMs} from the anchor.
//   opts.brandSlug — slugified brand name (export-side resolveBrandName), used
//     ONLY to disambiguate when the glob matches multiple brand-named files.
// Order: brand-named (`*_brand_style_preset.json`) — exactly one → use; many →
// prefer the brandSlug match, else newest (when mtime present), else a
// deterministic lexical pick flagged ambiguous; zero brand-named → fixed
// `brand_style_preset.json`; none → ok:false. A basename mismatch therefore
// never breaks the round trip — apply finds Doc-1's file by the pattern.
function pickPreset(entries, opts) {
    opts = opts || {};
    var brandSlug = opts.brandSlug ? String(opts.brandSlug) : "";
    var list = _normalizeListing(entries);
    var brandNamed = [];
    var hasFixed = false;
    for (var i = 0; i < list.length; i++) {
        var nm = list[i].name;
        if (nm === FIXED_BASENAME) { hasFixed = true; continue; }
        if (_isBrandNamedPreset(nm)) brandNamed.push(list[i]);
    }
    if (brandNamed.length === 1) {
        return { ok: true, basename: brandNamed[0].name, source: "glob-single",
            ambiguous: false, diagnostic: null, candidates: _listNames(brandNamed) };
    }
    if (brandNamed.length > 1) {
        // (i) brandSlug match
        if (brandSlug) {
            var want = brandSlug + _BRAND_NAMED_SUFFIX;
            for (var j = 0; j < brandNamed.length; j++) {
                if (brandNamed[j].name === want) {
                    return { ok: true, basename: want, source: "glob-brand-match",
                        ambiguous: false, diagnostic: null, candidates: _listNames(brandNamed) };
                }
            }
        }
        // (ii) newest by mtime (only when ALL entries carry mtime)
        var newest = _newestByMtime(brandNamed);
        if (newest) {
            return { ok: true, basename: newest.name, source: "glob-newest", ambiguous: true,
                diagnostic: "multiple *_brand_style_preset.json and no brandSlug match — picked newest (" + newest.name + ")",
                candidates: _listNames(brandNamed) };
        }
        // (iii) no mtime → deterministic lexical pick, flagged ambiguous
        var names = _listNames(brandNamed).slice().sort();
        return { ok: true, basename: names[0], source: "glob-ambiguous", ambiguous: true,
            diagnostic: "multiple *_brand_style_preset.json, no brandSlug match, no mtime — picked lexically-first (" + names[0] + ")",
            candidates: names };
    }
    if (hasFixed) {
        return { ok: true, basename: FIXED_BASENAME, source: "fixed",
            ambiguous: false, diagnostic: null, candidates: [FIXED_BASENAME] };
    }
    return { ok: false, basename: null, source: "none",
        ambiguous: false, diagnostic: "no *_brand_style_preset.json or brand_style_preset.json in anchor dir", candidates: [] };
}

function _normalizeListing(entries) {
    var out = [];
    if (!entries || typeof entries.length !== "number") return out;
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e == null) continue;
        if (typeof e === "string") { out.push({ name: e, mtimeMs: null }); continue; }
        if (typeof e === "object" && e.name) {
            var m = (typeof e.mtimeMs === "number") ? e.mtimeMs
                : ((typeof e.mtime === "number") ? e.mtime : null);
            out.push({ name: String(e.name), mtimeMs: m });
        }
    }
    return out;
}

function _listNames(list) {
    var o = [];
    for (var i = 0; i < list.length; i++) o.push(list[i].name);
    return o;
}

function _newestByMtime(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].mtimeMs == null) return null;   // need ALL to have mtime to trust "newest"
        if (!best || list[i].mtimeMs > best.mtimeMs) best = list[i];
    }
    return best;
}

// ─── preset_id (deterministic — NOT Date/random; brand/doc-derived) ──
//
// preset_id is the brand-preset IDENTITY (which brand lineage); staleness/rev
// is carried separately by preset_content_hash, so a stable, content-free id
// is correct: re-exporting the same brand overwrites the same preset_id. Hash
// suffix via SCIO.payloadHash (the project's single djb2) for collision-resist
// while staying legible.
function derivePresetId(brandName, docName) {
    var base = String(brandName || docStem(docName) || "brand");
    var slug = slugify(base) || "brand";
    var h = SCIO.payloadHash({ brand_preset_id_base: base });
    return "bsp_" + slug + "_" + h;
}

// ─── role extraction from the _T_p_* name (advisory only, :386-387) ──
//
// Name = "_T_p_" + (role+"_")? + "<size>pt/<lead>pt|A" + "_<font>_<weight>_<hash4>"
// (style_sheet_builder.js:377-393). Role precedes the size token; when role was
// omitted (legacy size-first names) the char after "_T_p_" is a digit → null.
// role may itself contain "_" (e.g. "body_b"), so we cut at the FIRST size
// token, not at the first "_". Role is advisory (qual_key coarse near-miss),
// doc-relative, never the exact key — so a miss here only weakens suggestions.
function roleFromStyleName(name) {
    var s = (name == null) ? "" : String(name);
    if (s.indexOf("_T_p_") !== 0) return null;
    var rest = s.substring(5);
    if (/^\d/.test(rest)) return null;                 // size-first → role omitted
    var m = rest.match(/\d+(?:\.\d+)?pt\//);           // first size token
    if (!m) return null;
    var idx = rest.indexOf(m[0]);
    if (idx <= 0) return null;
    var role = rest.substring(0, idx);
    if (role.charAt(role.length - 1) === "_") role = role.substring(0, role.length - 1);
    return role || null;
}

// ─── color-shape normalization for payload storage ──────────────────
//
// captureColor/captureRule produce a `displayedRGB` field (capture-time ICC,
// A3-unreconstructable, and NULL here since export passes no convertToRGB).
// It is NOT part of the match/compare contract — norm() (style_config_io.js)
// reads only {swatch,space,values}. Carrying it would (a) bloat the JSON with
// null noise and (b) risk spurious cross-doc payload differences if two docs
// resolved different ICC RGB → false duplicate-key diagnostics. So strip it
// from every color shape going into the payload (top-level fillColor + nested
// rule color/gapColor), matching the schema's {swatch,space,values}.
function stripDisplayedRGB(colorShape) {
    if (colorShape == null || typeof colorShape !== "object") return colorShape;
    var out = {};
    for (var k in colorShape) {
        if (!Object.prototype.hasOwnProperty.call(colorShape, k)) continue;
        if (k === "displayedRGB") continue;
        out[k] = colorShape[k];
    }
    return out;
}

// Clean a captureRule shape: drop displayedRGB from nested color/gapColor.
// Inactive rules ({active:false}) pass through untouched.
function cleanRuleShape(ruleShape) {
    if (ruleShape == null || typeof ruleShape !== "object") return ruleShape;
    if (!ruleShape.active) return ruleShape;
    var out = {};
    for (var k in ruleShape) {
        if (!Object.prototype.hasOwnProperty.call(ruleShape, k)) continue;
        if (k === "color" || k === "gapColor") {
            out[k] = (ruleShape[k] == null) ? ruleShape[k] : stripDisplayedRGB(ruleShape[k]);
        } else {
            out[k] = ruleShape[k];
        }
    }
    return out;
}

// ─── live per-style payload read (SHARED export↔apply; fable r1 P2) ──
//
// fable r1 (gimpl3) P2: this field-set + shape logic was a BYTE-IDENTICAL copy
// in export's `_readStylePayload` AND apply's `_readLivePayload` — relied on for
// "the captured shape feeding apply's conflict detection is byte-identical to
// what the preset stored", but enforced only by a comment. A one-sided edit
// would silently break the round trip (export captures a shape apply no longer
// reads the same way). Hoisted here so BOTH operators call the IDENTICAL reader
// ⟹ export-writes-shape === apply-reads-shape forever.
//
// PURE given a style-like `ps` (any object exposing the ParagraphStyle props)
// + injected `deps.captureColor` / `deps.captureRule` (the host snapshot
// readers; kept injected so the glue takes no visual_snapshot dependency and
// stays Node-fixture-able). Mirrors visual_snapshot:226-237 for leading and the
// schema's {swatch,space,values} color shape (displayedRGB stripped — A3, not
// part of the compare contract).
function readStylePayload(ps, deps) {
    deps = deps || {};
    var capColor = deps.captureColor;
    var capRule = deps.captureRule;
    var c = {};
    try { c.pointSize = _num(ps.pointSize); } catch (e) {}
    try { c.leftIndent = _num(ps.leftIndent); } catch (e) {}
    try { c.rightIndent = _num(ps.rightIndent); } catch (e) {}
    try { c.firstLineIndent = _num(ps.firstLineIndent); } catch (e) {}
    // keepWithNext = line-count int (NOT pt; unit-independent — schema :2563)
    try { c.keepWithNext = _num(ps.keepWithNext); } catch (e) {}
    try { c.keepLinesTogether = !!ps.keepLinesTogether; } catch (e) {}
    try { c.spaceBefore = _num(ps.spaceBefore); } catch (e) {}
    try { c.spaceAfter = _num(ps.spaceAfter); } catch (e) {}
    // leading: number(pt) | "AUTO" (Leading.AUTO enum) — mirror visual_snapshot:226-237
    try {
        var lead = ps.leading;
        if (typeof lead === "number") { c.leading = lead; }
        else {
            var ls = String(lead);
            c.leading = (ls.indexOf("AUTO") >= 0 || ls.indexOf("Auto") >= 0) ? "AUTO" : _num(lead);
        }
    } catch (e) {}
    try { c.justification = String(ps.justification); } catch (e) {}      // enum String() form (:2568)
    try { c.composer = String(ps.composer); } catch (e) {}                // scalar-safe String (:2572)
    // enum/object dims → snapshot-shape reader (NOT live JSON.stringify), then
    // strip capture-time displayedRGB (A3, not part of the compare contract).
    try { c.fillColor = (typeof capColor === "function") ? stripDisplayedRGB(capColor(ps.fillColor)) : null; } catch (e) { c.fillColor = null; }
    try { c.ruleAbove = (typeof capRule === "function") ? cleanRuleShape(capRule(ps, "ruleAbove")) : { active: false }; } catch (e) { c.ruleAbove = { active: false }; }
    try { c.ruleBelow = (typeof capRule === "function") ? cleanRuleShape(capRule(ps, "ruleBelow")) : { active: false }; } catch (e) { c.ruleBelow = { active: false }; }
    return c;
}

// ─── collapse-diagnostic policy ─────────────────────────────────────
//
// collapseEntries (style_config_io.js) already COLLAPSES byte-equal payload
// collisions to one entry silently and emits a `duplicate-key` diagnostic ONLY
// for differing-payload collisions (task_plan.md:2510). This decides the
// operator's reaction to those differing-payload diagnostics:
//   refuseOnDuplicate=false (default) → WARN: write the preset (both differing
//     entries are kept by collapseEntries so apply's resolveMatch can flag
//     ambiguity + skip — the designed non-silent flow), surface loudly.
//   refuseOnDuplicate=true            → REFUSE: do not write; report the dup.
// Spec leaves "warn/refuse" to the operator (:2510/:2679) — warn is the MVP
// default because it stays consistent with the apply-side ambiguity handling;
// refuse is opt-in via automationOptions.refuseOnDuplicate.
function classifyCollapse(collapseResult, refuseOnDuplicate) {
    collapseResult = collapseResult || {};
    var diags = collapseResult.diagnostics || [];
    var hasDup = diags.length > 0;
    return {
        hasDuplicate: hasDup,
        refuse: !!(hasDup && refuseOnDuplicate),
        diagnostics: diags,
        collapsedGroups: collapseResult.collapsedGroups || [],
        entryCount: (collapseResult.entries || []).length
    };
}

// ─── empty-export reason wording (fable r1 P4) ──────────────────────
//
// Distinguish "scanned 0 _T_p_*" from "scanned N but all had foreign /
// unparseable labels (no match_key)". In the empty path captured==0, so when
// scanned>0 every scanned style was foreign-skipped (captured + skipped ==
// scanned). The old single string "no _T_p_* styles found" misreported the
// all-foreign case. PURE so the wording is Node-lockable.
function emptyExportReason(scanned, skippedForeign) {
    var n = Number(scanned) || 0;
    var f = Number(skippedForeign) || 0;
    if (n > 0 && f > 0) {
        return "scanned " + n + " _T_p_* style(s) but all " + f
            + " had foreign/unparseable labels (no match_key) — nothing exported";
    }
    return "no _T_p_* styles found — nothing exported";
}

// ─── report summary builder ─────────────────────────────────────────

function buildSummary(opts) {
    opts = opts || {};
    return {
        ok: !!opts.ok,
        operator: "export_brand_style_preset",
        ts: opts.ts || null,
        output_path: opts.outputPath || null,
        path_source: opts.pathSource || null,           // presetPath | stable-anchor | none
        written: !!opts.written,
        refused: !!opts.refused,
        reason: opts.reason || null,
        source_document: opts.sourceDocument || { name: null, source_hash: null },
        preset_id: opts.presetId || null,
        preset_content_hash: opts.presetContentHash || null,
        derivation_id: opts.derivationId || null,
        styles_scanned: opts.stylesScanned || 0,        // all _T_p_* found
        styles_captured: opts.stylesCaptured || 0,      // valid-label, payload built
        skipped_foreign_label: opts.skippedForeign || 0,
        entry_count: opts.entryCount || 0,              // after collapse
        collapsed_groups: opts.collapsedGroups || [],   // byte-equal collisions folded
        duplicate_diagnostics: opts.diagnostics || [],  // differing-payload collisions
        measurement_forced_points: (opts.measurementForcedPoints !== false),
        validation: opts.validation || null,            // {ok, errors, warnings}
        warnings: opts.warnings || []
    };
}

// ─── exports ────────────────────────────────────────────────────────

module.exports = {
    FIXED_BASENAME: FIXED_BASENAME,
    _sepOf: _sepOf,
    dirOf: dirOf,
    slugify: slugify,
    docStem: docStem,
    presetBasename: presetBasename,
    isPresetBasename: isPresetBasename,
    buildBrandConfigCandidates: buildBrandConfigCandidates,
    extractBrandName: extractBrandName,
    resolveBrandName: resolveBrandName,        // SHARED export↔apply (fs injected)
    collectTPStyles: collectTPStyles,          // SHARED (doc-like injected)
    readStylePayload: readStylePayload,        // SHARED export↔apply (captureColor/Rule injected — P2)
    resolvePresetPath: resolvePresetPath,
    pickPreset: pickPreset,                    // apply-side discovery (listing injected)
    derivePresetId: derivePresetId,
    roleFromStyleName: roleFromStyleName,
    stripDisplayedRGB: stripDisplayedRGB,
    cleanRuleShape: cleanRuleShape,
    classifyCollapse: classifyCollapse,
    emptyExportReason: emptyExportReason,
    buildSummary: buildSummary
};
