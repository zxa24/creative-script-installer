"use strict";

/**
 * lib/italic_variant_keys.js — panel-side WINNER-KEY derivation for the italic
 * HOW config (task_plan §univ-italic §7.4 · contract K · AC⑤).
 *
 * WHY THIS EXISTS
 * ---------------
 * `italic_config.lookup(brandConfig, family, weightStyle)` is called at apply
 * time with the family the run ACTUALLY LANDS IN — post-byPair, post-style-pool:
 *   • style_applier.js:1619        → `resolved.family`
 *   • style_sheet_builder.js:2309  → `fam` ("Key = (resolved family, italic-
 *                                     stripped resolved weight) · contract K")
 *   • italic_apply.js:104          → the live char's appliedFont
 * So a panel control that stores the SOURCE column's spelling produces a key
 * that is type-valid but can never match: the operator's choice is dropped with
 * no error and no grep-able trace. Everything the panel writes therefore goes
 * through resolveWinner() below.
 *
 * WHICH NODE IS THE WINNER (derived, not assumed)
 * ----------------------------------------------
 * byPair is SCRIPT-AWARE, and that is what decides it. From
 * byPair_char_sweep.js:8-18 (8D-ext-SA, 2026-06-11):
 *
 *   "For actions whose dstLang ∈ CJK_LANG_SET && sourceLang ∉ CJK_LANG_SET
 *    (Latin source → CJK target), it re-fonts ONLY the CJK chars in the range
 *    and leaves Latin/digit/halfwidth-punct on the source font. […] Latin→Latin
 *    and CJK→CJK pairs still whole-range swap."
 *
 * Therefore:
 *   • Latin source → CJK target: the source font KEEPS its Latin/digit chars.
 *     Its own (family, weight) stays live at apply time, so the Latin node owns
 *     its own key — this is the case AC④ (Latin `real` must not regress) rides
 *     on. The pair's CJK target node separately owns the CJK chars.
 *   • Latin→Latin / CJK→CJK: whole-range swap, the source font carries NOTHING
 *     afterwards. Its own key is dead → the winner is the pair's effective
 *     target member, and every source node mapping there collapses onto ONE key
 *     (AC⑤: no last-writer-wins).
 *   • A node in the target language column is its own winner.
 *
 * The effective target member is NOT re-derived here: effectiveTargetWeight()
 * in font_mapping_pairs.js is the pipeline's own SoT for it (rep-or-sole +
 * equivalence-group canonicalization), so drift is impossible by construction.
 *
 * NO EXPLICIT TARGET LANGUAGE ("(auto)")
 * -------------------------------------
 * The panel's Primary dropdown defaults to "(auto)" = "". That is NOT "unknown"
 * to the pipeline: resolvePanelActions derives the target through a priority
 * chain — _meta targetLang → panel primaryLang → single-CJK config → scanner
 * dominantLang, refusing to guess among ≥2 CJK targets. That chain is
 * `font_mapping_resolve._resolveCjkTarget` and it is CALLED here, not
 * reimplemented (same discipline as effectiveTargetWeight above). Its outcomes
 * map onto this module as:
 *   resolved → that lang IS the target; the winner is NOT indeterminate.
 *   blocked  → the resolver itself refuses to pick among the config's CJK
 *              targets, so the panel must not either: own key + indeterminate.
 *   scanner  → the lang comes from the doc scan, which this pure module does not
 *              have. A caller may supply it (opts.dominantLang); absent that the
 *              outcome is indeterminate — never an invented target.
 * `cjkTargetsInConfig` is derived exactly as resolvePanelActions derives it
 * (font_mapping_resolve.js:691-698): fonts_by_language keys ∩ CJK_LANG_SET,
 * canonicalized through normalizeBcp47Identity.
 *
 * INSTALLED-NAME NORMALIZATION (contract K · r3 note)
 * --------------------------------------------------
 * The family a run lands in is decided by byPair AND by the style-write-time
 * rewrite in `_writeStyleFontNormalized`/`_resolveInstalledFontName`
 * (style_sheet_builder.js:2209): a font that IS installed under a different
 * spelling gets the installed one ("Whitney"+"Book" → "Whitney Book"+"Regular").
 * A key stored under the config spelling then reads as unconfigured at apply
 * time — the same silent-drop class as a source-column key. So the winner is run
 * through that resolver before the key is built.
 *
 * This module stays PURE: the resolver probes installed fonts, so it is INJECTED
 * (opts.resolveInstalledFont, bound to the live doc in font_panel_env.js) rather
 * than required here. Absent, null-returning or throwing → the names are used as
 * given, i.e. exactly today's behaviour, so a panel with no open document and
 * every Node test still work.
 *
 * Note for configs written BEFORE this normalization existed: an entry stored
 * under the un-normalized spelling is not migrated. It reads as unconfigured in
 * the panel — which is what it already was at apply time; the fix makes the two
 * agree rather than silently re-blessing a key the pipeline never looked up.
 */

var _normWeight = require("./font_italic_probe.js")._normWeight;
var FMP = require("./font_mapping_pairs.js");
var CjkSweep = require("./byPair_char_sweep.js");
var _normLang = require("./lang_script_table.js").normalizeBcp47Identity;

var CJK_LANG_SET = (CjkSweep && CjkSweep.CJK_LANG_SET) || {};
var KEY_SEP = "␟";   // U+241F — same separator convention as the eg fold set

/**
 * variantKey — the contract-K identity of an italic config entry.
 * family: EXACT string compare (lookup does `String(e.font) !== fam`).
 * weight: through _normWeight (lookup does `_normWeight(e.weight) !== nw`),
 *         which also strips any "italic" token, so a base weight and its italic
 *         spelling collapse to one key — exactly what the apply side looks up.
 */
function variantKey(font, weight) {
    return String(font == null ? "" : font) + KEY_SEP + _normWeight(weight);
}

function _isCjkLang(langCode) {
    return !!CJK_LANG_SET[_normLang(langCode)];
}

function _sameMember(m, canonLang, font, weight) {
    return !!m && _normLang(m.lang) === canonLang && String(m.font) === font
        && _normWeight(m.weight) === _normWeight(weight);
}

// Is this (lang, font, weight) a member of a pair that ALSO has a member in some
// OTHER language? Only such a node can be swapped onto another font, so only
// such a node is ambiguous while no target language is selected.
function _isCrossLangPairMember(config, canonLang, font, weight) {
    for (var pi = 0; pi < config.pairs.length; pi++) {
        var pair = config.pairs[pi];
        if (!pair || !Array.isArray(pair.members)) continue;
        var mine = false, other = false;
        for (var mi = 0; mi < pair.members.length; mi++) {
            var m = pair.members[mi];
            if (!m) continue;
            if (_sameMember(m, canonLang, font, weight)) mine = true;
            else if (_normLang(m.lang) !== canonLang) other = true;
        }
        if (mine && other) return true;
    }
    return false;
}

// CJK target langs present in this config — the SAME derivation
// resolvePanelActions feeds _resolveCjkTarget (font_mapping_resolve.js:691-698):
// fonts_by_language keys ∩ CJK set, canonicalized, de-duped, order preserved.
function _cjkTargetsInConfig(config) {
    var out = [], seen = {};
    var fbl = config && config.fonts_by_language;
    if (!fbl || typeof fbl !== "object") return out;
    var keys = Object.keys(fbl);
    for (var i = 0; i < keys.length; i++) {
        var c = _normLang(keys[i]);
        if (CJK_LANG_SET[c] && !seen[c]) { seen[c] = true; out.push(c); }
    }
    return out;
}

// Derive the target language the resolver itself would use when the panel has
// no explicit one. Returns { lang } — lang null ⇒ the chain gave no usable
// answer (blocked, or scanner with no dominantLang to stand on) and the caller
// must treat the winner as indeterminate rather than pick.
//
// Lazy require, mirroring font_mapping_resolve's own load-order discipline (it
// has no top-level requires); an unavailable module degrades to the pre-chain
// behaviour instead of breaking panel load.
function _deriveTargetLang(config, opts) {
    var Resolve = null;
    try { Resolve = require("./font_mapping_resolve.js"); } catch (e) { Resolve = null; }
    if (!Resolve || typeof Resolve._resolveCjkTarget !== "function") return { lang: null };
    var dom = opts.dominantLang ? _normLang(opts.dominantLang) : null;
    var r = null;
    try {
        r = Resolve._resolveCjkTarget(dom, _cjkTargetsInConfig(config), {
            metaTargetLang: opts.metaTargetLang || null,
            primaryLang: opts.primaryLang || null
        }, CJK_LANG_SET);
    } catch (e2) { return { lang: null }; }
    if (!r) return { lang: null };
    // "scanner" carries whatever dominantLang we passed in — null when the caller
    // has none, and we do NOT invent one (the doc scan is the only authority).
    if (r.kind === "resolved" || r.kind === "scanner") return { lang: r.lang || null };
    return { lang: null };   // blocked — the resolver refuses to choose
}

// Rewrite a winner's (font, weight) to the spelling the pipeline will actually
// write, via the caller-injected installed-name resolver (contract K r3). No
// resolver / null result / a throw → names as given (today's behaviour).
function _applyInstalledName(res, resolveInstalledFont) {
    if (typeof resolveInstalledFont !== "function") return res;
    var inst = null;
    try { inst = resolveInstalledFont(res.font, res.weight); } catch (e) { inst = null; }
    if (!inst || !inst.family) return res;
    res.font = String(inst.family);
    if (inst.fontStyle !== null && inst.fontStyle !== undefined) res.weight = String(inst.fontStyle);
    return res;
}

/**
 * resolveWinner — the (font, weight) an italic HOW set on this panel node must
 * be stored under.
 *
 * @param {Object} config      lib-form brand config ({fonts_by_language, pairs,
 *                             equivalence_groups}) — pairs/eg are what matter
 * @param {string} langCode    the node's language column (lib lang code)
 * @param {string} font        the node's family (exact spelling)
 * @param {string} weight      the node's weight token
 * @param {string} targetLang  the import's TARGET language (panel primaryLang).
 *                             Empty ⇒ derived through the resolver's own chain
 *                             (see the header) instead of giving up.
 * @param {Object} [opts]      optional, all fields optional:
 *                             dominantLang         — the doc scan's dominant lang,
 *                               the only thing that can settle the chain's
 *                               "scanner" outcome. Absent → indeterminate.
 *                             metaTargetLang       — workflow _meta target lang,
 *                               the chain's highest-priority signal.
 *                             resolveInstalledFont — (family, style) →
 *                               {family, fontStyle}|null, the pipeline's
 *                               installed-name resolver bound to a live doc.
 * @returns {{font:string, weight:string, viaPair:boolean, indeterminate:boolean}}
 *          viaPair=true ⇒ this node is NOT its own winner (its runs are swapped
 *          onto another font) — the caller should say so in the UI rather than
 *          let the operator think the control edits this column.
 *          indeterminate=true ⇒ the target language could not be settled (none
 *          given AND the resolver's chain declined) AND this node is paired
 *          across languages, so whether it keeps its own font cannot be decided
 *          yet. The key returned is the node's own; the caller MUST surface this
 *          rather than store silently — an unsettled target is exactly how a
 *          config gets written under a font that carries nothing after import
 *          (the failure this whole module exists to prevent).
 */
function resolveWinner(config, langCode, font, weight, targetLang, opts) {
    opts = opts || {};
    return _applyInstalledName(
        _resolveWinnerRaw(config, langCode, font, weight, targetLang, opts),
        opts.resolveInstalledFont
    );
}

// Pair/lang resolution proper — works entirely in CONFIG spelling (that is what
// pairs and equivalence_groups are written in). The installed-name rewrite is
// applied once, by resolveWinner, to whichever winner this returns.
function _resolveWinnerRaw(config, langCode, font, weight, targetLang, opts) {
    var own = {
        font: String(font == null ? "" : font),
        weight: String(weight == null ? "" : weight),
        viaPair: false,
        indeterminate: false
    };
    if (!config || !Array.isArray(config.pairs)) return own;

    var canonNode = _normLang(langCode);
    var canonTgt = _normLang(targetLang);

    // Canonicalize an OWN-key result through equivalence_groups before returning
    // it. effectiveTargetWeight already does this for the viaPair branch, which is
    // why the header could claim the pair target cannot drift — but every `own`
    // branch bypassed it, and the pipeline physically rewrites an eg `merged_in`
    // (font, weight) to its canonical before italic realization ever runs
    // (font_mapping_resolve.js:772 `_toCanonical`, resolve_core.js:170-171 on the
    // source side). So a copy created on a merged_in alias was keyed to a spelling
    // the run never carries. These aliases ARE reachable in the tree: the A.1 fold
    // deliberately never folds a SAME-family merged_in, and exempts MM-owned ones.
    // Membership matching below stays on the raw spelling — pairs are authored in
    // raw config spelling, and a node whose alias is not a pair member falls
    // through to an own-return, where it gets canonicalized here anyway.
    function ownCanon() {
        var c = null;
        try { c = FMP.getCanonical(config, canonNode, own.font, own.weight); } catch (e) { c = null; }
        if (c && c.font) { own.font = String(c.font); own.weight = String(c.weight); }
        return own;
    }

    // No target language chosen (the standalone panel's "(auto)" default) — ask
    // the resolver's own priority chain rather than giving up. Only when THAT
    // declines (blocked / scanner with no dominantLang) does the node keep its
    // own key, flagged when a pair could still swap it away.
    if (!targetLang) {
        var derived = _deriveTargetLang(config, opts);
        if (!derived.lang) {
            own.indeterminate = _isCrossLangPairMember(config, canonNode, own.font, own.weight);
            return ownCanon();
        }
        canonTgt = _normLang(derived.lang);
    }
    // A node in the target column already IS the resolved font.
    if (canonNode === canonTgt) return ownCanon();
    // Latin source → CJK target keeps its own Latin chars (byPair_char_sweep SA).
    if (!_isCjkLang(canonNode) && _isCjkLang(canonTgt)) return ownCanon();

    // Whole-range swap: find the pair this node belongs to and follow it to the
    // target member the pipeline itself would pick.
    for (var pi = 0; pi < config.pairs.length; pi++) {
        var pair = config.pairs[pi];
        if (!pair || !Array.isArray(pair.members)) continue;
        var isMember = false;
        for (var mi = 0; mi < pair.members.length; mi++) {
            var m = pair.members[mi];
            if (!m) continue;
            if (_normLang(m.lang) === canonNode && String(m.font) === own.font
                && _normWeight(m.weight) === _normWeight(own.weight)) { isMember = true; break; }
        }
        if (!isMember) continue;
        var eff = null;
        try { eff = FMP.effectiveTargetWeight(pair, canonTgt, config); } catch (e) { eff = null; }
        if (eff && eff.font && eff.weight) {
            return { font: String(eff.font), weight: String(eff.weight), viaPair: true, indeterminate: false };
        }
        // member of a pair that has no target member for this direction → the
        // node is not swapped anywhere; it keeps its own font.
        return ownCanon();
    }
    return ownCanon();
}

/**
 * buildVariantMap — config.italic_by_weight[] → { winnerKey: entry }.
 * Entries are kept VERBATIM (original font/weight spelling, no invented angle)
 * so an untouched round-trip is byte-equal (AC③ covers italic_by_weight too).
 * A duplicate key in a hand-written config collapses to the FIRST entry — the
 * apply-side lookup takes the first match too, so this reports what would
 * actually have been used rather than inventing a merge.
 */
function buildVariantMap(list) {
    var map = {};
    if (!Array.isArray(list)) return map;
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || e.font == null || e.weight == null) continue;
        var k = variantKey(e.font, e.weight);
        if (!Object.prototype.hasOwnProperty.call(map, k)) map[k] = e;
    }
    return map;
}

/**
 * claimedWinnerKeys — every winner key some weight in this panelData resolves to.
 *
 * The store is winner-keyed and each node computes its own key at render time, so
 * an entry is VISIBLE in the panel iff some node produces the same key. That makes
 * "claimed" the exact complement of "orphan" — no separate bookkeeping.
 *
 * Walks the RAW weights tree rather than the visible-node derivation: a weight the
 * A.1 fold hides canonicalizes to the same key as the canonical node that replaced
 * it, so including it can only ever ADD a key that is genuinely reachable. Erring
 * toward "claimed" is the safe direction — a false orphan invites the operator to
 * delete live config, a missed orphan merely leaves it listed.
 */
function claimedWinnerKeys(panelData, config, targetLang, opts) {
    var claimed = {};
    var langs = (panelData && panelData.languages) || [];
    for (var li = 0; li < langs.length; li++) {
        var lang = langs[li];
        if (!lang) continue;
        var code = lang.code || lang.id || "";
        var fonts = lang.fonts || [];
        for (var fi = 0; fi < fonts.length; fi++) {
            var font = fonts[fi];
            if (!font || !font.name) continue;
            var weights = font.weights || [];
            for (var wi = 0; wi < weights.length; wi++) {
                var w = weights[wi];
                if (!w) continue;
                var token = w.actual || w.semantic;
                if (!token) continue;
                var win = resolveWinner(config, code, font.name, token, targetLang, opts);
                claimed[variantKey(win.font, win.weight)] = true;
            }
        }
    }
    return claimed;
}

/**
 * findOrphanEntries — italic config entries no weight node can reach (AC⑦ / 3B).
 *
 * These are NOT pruned. "Cannot find a claimant" does not mean "the operator
 * deleted it": the same shape is produced by an environment difference (the
 * installed-name resolver absent, or a font spelled differently on this machine),
 * and auto-pruning would then silently erase every italic setting during an
 * ordinary session — the exact failure class this whole feature exists to prevent.
 * So they are LISTED, read-only, and removed one at a time by the operator.
 *
 * Genuine causes: the font/weight was removed from the config; equivalence_groups
 * changed so the old canonical is no longer produced; or environment drift.
 * NOT a cause: rewiring a pair / changing a representative / changing the primary
 * language — the winner is still a node in the config, it just displays elsewhere.
 *
 * @returns {Array<{key:string, entry:Object}>} in store insertion order
 */
function findOrphanEntries(panelData, config, targetLang, opts) {
    var store = (panelData && panelData.italic_by_winner) || null;
    if (!store || typeof store !== "object") return [];
    var claimed = claimedWinnerKeys(panelData, config, targetLang, opts);
    var out = [];
    var keys = Object.keys(store);
    for (var i = 0; i < keys.length; i++) {
        if (!claimed[keys[i]]) out.push({ key: keys[i], entry: store[keys[i]] });
    }
    return out;
}

/** emitVariantList — { winnerKey: entry } → italic_by_weight[] (insertion order). */
function emitVariantList(map) {
    var out = [];
    if (!map || typeof map !== "object") return out;
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
        var e = map[keys[i]];
        if (e && e.font != null && e.weight != null) out.push(e);
    }
    return out;
}

var DEFAULT_FAUX_ANGLE = 15;   // §3:126 — a new copy is faux@15, never mode-less
// 1, NOT 0. `italic_config.lookup` reads the angle as
// `(isFinite(a) && a !== 0) ? a : DEFAULT_FAUX_ANGLE` (italic_config.js:65-66),
// i.e. it treats 0 as ABSENT and substitutes 15. A panel that let the operator
// dial 0 would therefore show "0°" and apply 15° — the panel contradicting itself
// with no error. 0° also has no meaning to express here: "this weight does not
// slant" is said by deleting the copy, not by a zero-degree one.
var SKEW_MIN = 1;
// 60, not 30. The old ceiling was inherited from the #17 UI (its tooltip already
// read "0-30") and was never an engine limit -- InDesign's skew range is far
// wider. The operator asked for angles above 30, and refusing them was the panel
// imposing a limit nobody chose (user 2026-08-07).
var SKEW_MAX = 60;

function clampAngle(deg) {
    var n = Number(deg);
    if (!isFinite(n)) return DEFAULT_FAUX_ANGLE;
    return Math.max(SKEW_MIN, Math.min(SKEW_MAX, Math.round(n)));
}

/** newFauxEntry — the entry a freshly created copy carries (always valid). */
function newFauxEntry(winnerFont, winnerWeight, angle) {
    return {
        font: String(winnerFont),
        weight: String(winnerWeight),
        mode: "faux",
        angle: clampAngle(angle == null ? DEFAULT_FAUX_ANGLE : angle)
    };
}

module.exports = {
    variantKey: variantKey,
    resolveWinner: resolveWinner,
    claimedWinnerKeys: claimedWinnerKeys,
    findOrphanEntries: findOrphanEntries,
    buildVariantMap: buildVariantMap,
    emitVariantList: emitVariantList,
    newFauxEntry: newFauxEntry,
    clampAngle: clampAngle,
    DEFAULT_FAUX_ANGLE: DEFAULT_FAUX_ANGLE,
    SKEW_MIN: SKEW_MIN,
    SKEW_MAX: SKEW_MAX,
    KEY_SEP: KEY_SEP
};
