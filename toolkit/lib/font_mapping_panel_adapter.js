"use strict";

/**
 * lib/font_mapping_panel_adapter.js — Phase 8D-ext-0 schema bridge
 *
 * Converts between:
 *   - panelData: { name, languages: [{id, code, fonts: [{id, name, weights: [...]}]}], pairings: [...] }
 *     (UI shape; nested arrays + id fields for React rendering)
 *   - config: { brand_name, fonts_by_language: { lang: [{font, weight}] },
 *               pairs: [{ members: [{lang, font, weight}], representative_by_lang? }],
 *               equivalence_groups: [{ lang, canonical, merged_in }] }
 *     (lib shape per lib/font_mapping_pairs.js validateBrandConfig)
 *
 * Import/Export integration:
 *   - Export → panelDataToConfig + validateBrandConfig assert pass → JSON
 *     (codex r7 P1 fix: brand_name from panelData.name MUST be mapped)
 *   - Import → JSON parsed; detect shape (lib config vs old v2 panelData)
 *     and routed by the LAUNCHER's importJson (font_mapping_panel_ui.js /
 *     font_apply_panel.idjs): lib config → configToPanelData, legacy v2
 *     panelData → panelDataToConfig → configToPanelData.
 *
 * MVP detail #11: skipDecisions / hint state / enforcerCheckbox are
 * panel-ephemeral, NOT in round-trip.
 *
 * CONFIG PASSTHROUGH (panel-italic AC③) — the panel is NOT the author of the
 * whole brand_config. It owns exactly PANEL_OWNED_CONFIG_KEYS; every OTHER key
 * (langScriptTable / preferred_per_language / fallback_chains / weight_aliases /
 * italic_by_weight / anything added later) must survive a panel round-trip
 * untouched. configToPanelData therefore parks the source config on the
 * panelData as `__sourceConfig`, and panelDataToConfig rebuilds on TOP of that
 * baseline instead of from scratch. Rationale for the carrier living on
 * panelData rather than a launcher closure: panelData is what actually flows
 * through every path (seed-open, in-panel importJson, React state, exportJson,
 * app.jsx's own validate/export calls), and app.jsx deep-clones state with
 * JSON.parse(JSON.stringify(...)) (`app.jsx:19` clone + `:436` mutate), so a
 * plain data field survives every edit. A launcher-side baseline would go stale
 * the moment the operator imports a different JSON inside the panel.
 */

var FMP;
try { FMP = require("./font_mapping_pairs.js"); } catch (e) { FMP = null; }
var ItalicKeys;
try { ItalicKeys = require("./italic_variant_keys.js"); } catch (e) { ItalicKeys = null; }
var FaceMissing;
try { FaceMissing = require("./font_face_missing.js"); } catch (e) { FaceMissing = null; }

function _sanitizeId(s) {
    return String(s || "").replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Config passthrough (panel-italic AC③)
// ---------------------------------------------------------------------------
// The ONLY keys panelDataToConfig authors. Everything else in the config the
// panel was opened with is carried through verbatim. Adding a key here means
// "the panel is now the authority for it"; NOT adding one means "it round-trips
// untouched" — which is what the next person adding a sixth config block wants
// by default, and why this is a passthrough rather than a wider whitelist.
// (font_skip is owned: configToPanelData round-trips it into panelData, so an
// operator clearing every skip must clear it in the config too — see below.)
var PANEL_OWNED_CONFIG_KEYS = [
    "brand_name", "fonts_by_language", "pairs", "equivalence_groups", "font_skip"
];

// Keys the panel authors ONLY when it is actually carrying that editor's state.
// italic_by_weight round-trips through panelData.italic_by_winner (the
// winner-keyed variant store); a panelData without that field — a bare doc
// scan, a legacy v2 panelData JSON — leaves the block alone as passthrough
// rather than deleting an operator's italic config it never displayed.
var PANEL_CONDITIONAL_CONFIG_KEYS = [
    "italic_by_weight"
];

// Field on panelData that carries the source config as the round-trip baseline.
var SOURCE_CONFIG_FIELD = "__sourceConfig";

function _deepCopyPlain(o) {
    if (o === null || typeof o !== "object") return null;
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; }
}

// Baseline for a rebuild: the explicit baseConfig arg if a non-panel caller
// passes one, else the config configToPanelData parked on the panelData.
// Non-object / unparseable / array → {} (i.e. today's from-scratch behaviour),
// so panelData that never came from a config (bare doc scan, legacy v2 JSON,
// buildSample) is unaffected.
function _baselineConfig(panelData, baseConfig) {
    var src = baseConfig || (panelData && panelData[SOURCE_CONFIG_FIELD]) || null;
    var copy = _deepCopyPlain(src);
    if (!copy || Array.isArray(copy)) return {};
    return copy;
}

// ---------------------------------------------------------------------------
// panelDataToConfig — UI shape → lib config shape
// ---------------------------------------------------------------------------
// codex r7 P1 fix: brand_name MUST be set, else validateBrandConfig rejects.
//
// baseConfig (optional) — passthrough baseline for callers that hold the source
// config directly. Normal panel callers pass NOTHING: the baseline rides on
// panelData[__sourceConfig] so an in-panel importJson (which swaps the whole
// panelData) also swaps the baseline. Passing a launcher-held seedConfig here
// would pin the baseline to the seed and silently resurrect keys from a config
// the operator already replaced.
function panelDataToConfig(panelData, baseConfig) {
    if (!panelData || typeof panelData !== "object") {
        return { ok: false, errors: ["panelData required"], config: null };
    }
    // Rebuild ON TOP of the source config: every non-panel-owned key (
    // langScriptTable / preferred_per_language / fallback_chains /
    // weight_aliases / italic_by_weight / …) survives verbatim. Each owned key
    // is then unconditionally overwritten below, so a stale value from the
    // baseline can never win over what the panel currently shows.
    var config = _baselineConfig(panelData, baseConfig);
    config.brand_name = panelData.name || "Brand";
    // TODO#58 ② — remember which language keys the SOURCE config already had,
    // captured before the reset below wipes them. Used at the end of the rebuild to
    // decide whether an EMPTY language column may be written out. See the comment
    // at the emptiness sweep for why that distinction is load-bearing.
    var _baselineLangKeys = {};
    (function () {
        var b = config.fonts_by_language;
        if (!b || typeof b !== "object") return;
        for (var bk in b) {
            if (Object.prototype.hasOwnProperty.call(b, bk)) _baselineLangKeys[bk] = true;
        }
    })();
    config.fonts_by_language = {};
    config.pairs = [];
    // TODO#58 ②: `_origin: "machine-auto"` is a SESSION-ONLY provenance marker
    // (see doc_scan / app.jsx). Strip it on the way out so a config file never
    // carries it back in.
    // 🔴 Why strip rather than persist: #33d established that once a machine-made
    // entry is on disk it is indistinguishable from one the operator curated. If
    // the marker round-tripped, a re-imported config would hand the machine
    // permission to silently retract groups the operator had deliberately KEPT.
    // Absent marker ⇒ "not mine" ⇒ never auto-deleted. Deterministic grouping
    // re-derives the same groups from the document next session anyway, so
    // persisting it would buy nothing and cost that safety.
    // ⚠ validateBrandConfig checks required keys only (it would NOT have rejected
    // the extra field) — so this is a deliberate choice, not a forced one.
    config.equivalence_groups = (panelData.equivalence_groups || []).map(function (eg) {
        if (!eg || typeof eg !== "object") return eg;
        var out = {};
        for (var k in eg) {
            if (!Object.prototype.hasOwnProperty.call(eg, k)) continue;
            if (k === "_origin") continue;
            out[k] = eg[k];
        }
        return out;
    });
    // font_skip is panel-owned and emitted ONLY when non-empty (legacy configs
    // round-trip byte-identical). Drop the baseline's copy first — otherwise an
    // operator who un-skips every font would keep the old skip set, i.e. fonts
    // silently skipped again on the next import.
    delete config.font_skip;

    // B-ui A-5 (panel→config link): persist the unowned-CJK skip set so a font the
    // user explicitly skipped in the panel reaches the IMPORT path (which reads
    // config.font_skip, no live React). Stored as the optional top-level array of
    // "font|weight" keys — orthogonal block, schema-safe (validateBrandConfig
    // ignores unknown keys, same precedent as faux_italic). Only emitted when
    // non-empty so legacy panels round-trip byte-identical. Accepts either an
    // array (already key form) or a { "font|weight": true } map (the React state
    // shape) for caller convenience.
    var _fs = panelData.font_skip;
    if (Array.isArray(_fs)) {
        var arr = _fs.filter(function (k) { return typeof k === "string" && k; });
        if (arr.length) config.font_skip = arr.slice();
    } else if (_fs && typeof _fs === "object") {
        var keys = Object.keys(_fs).filter(function (k) { return _fs[k]; });
        if (keys.length) config.font_skip = keys;
    }

    var langs = panelData.languages || [];
    for (var i = 0; i < langs.length; i++) {
        var lang = langs[i];
        var code = lang.code || lang.id || "en";
        if (!config.fonts_by_language[code]) config.fonts_by_language[code] = [];
        for (var j = 0; j < (lang.fonts || []).length; j++) {
            var font = lang.fonts[j];
            for (var k = 0; k < (font.weights || []).length; k++) {
                var w = font.weights[k];
                config.fonts_by_language[code].push({
                    font: font.name,
                    weight: w.actual || w.semantic || "Regular"
                });
            }
        }
    }

    // TODO#58 ② — a language column that ended up contributing NO font entry is
    // written out ONLY if the source config already carried that key.
    //
    // Why this exists: ② opens the pick-a-font step by itself when upstream named a
    // target language the config has no fonts for, and owner's rule has a second half
    // — 「直接导出则不写任何东西，下次再自动触发」. When that language has no
    // column at all (the common case for a brand-new target: the SOURCE document has
    // none of its fonts either, so the doc-scan union does not invent one), opening the
    // step means creating the column — and the rebuild above creates the key
    // unconditionally, so merely LOOKING at the picker and exporting would have added
    // `"zh-TW": []` to the operator's config. MEASURED, not read:
    // tests/spikes/spike_58_2_pending_card_writes_nothing.js case B.
    //
    // 🔴 The gate is "was it in the baseline", NOT "is it empty" — a language the
    // operator emptied ON PURPOSE must still round-trip as `[]`, and every existing
    // config keeps byte-identical output because its keys are all in the baseline.
    // (A pending font card is invisible here for a different reason: it carries
    // `weights: []`, so the inner loop pushes nothing. Case A of the same spike.)
    for (var _ek in config.fonts_by_language) {
        if (!Object.prototype.hasOwnProperty.call(config.fonts_by_language, _ek)) continue;
        if ((config.fonts_by_language[_ek] || []).length) continue;
        if (_baselineLangKeys[_ek]) continue;
        delete config.fonts_by_language[_ek];
    }

    // design F (F3) — index the parked members so the authored/carried split below
    // can tell them apart. A representative that names a parked member is CARRIED
    // too: leaving it in the validated config makes the gate fail on a reference the
    // panel never authored, and ok:false makes handleDone refuse everything — the
    // session deadlock F3 exists to prevent. It is restored, verbatim, after the
    // gate by _restoreRepForLang.
    var _parked = {};
    if (Array.isArray(panelData.unplaceableMembers)) {
        panelData.unplaceableMembers.forEach(function (u) {
            if (u) _parked[u.pairingId + '|' + u.lang + '|' + u.font + '|' + u.weight] = true;
        });
    }

    // pairings → pairs: assume pairing.members carry { lang, font, weight }
    // (lib form) or { lang, font, node } (v2 form). For v2, resolve node →
    // (font.name, weight.actual) via the panelData.languages tree.
    var pairings = panelData.pairings || panelData.pairs || [];
    for (var p = 0; p < pairings.length; p++) {
        var pairing = pairings[p];
        var members = [];
        for (var mi = 0; mi < (pairing.members || []).length; mi++) {
            var mem = pairing.members[mi];
            if (mem.font && mem.weight) {
                // already lib form
                members.push({ lang: mem.lang, font: mem.font, weight: mem.weight });
            } else if (mem.font && mem.node) {
                // v2 form: resolve node to font.name + weight.actual
                var resolved = _resolvePanelMember(panelData, mem);
                if (resolved) members.push(resolved);
            }
        }
        var pairOut = { members: members };
        if (pairing.representative_by_lang) {
            var _repIn = pairing.representative_by_lang;
            var _repOut = {}, _repAny = false;
            Object.keys(_repIn).forEach(function (lc) {
                var r = _repIn[lc];
                // a rep naming a parked member is carried, not authored → hold it back
                if (r && _parked[pairing.id + '|' + lc + '|' + r.font + '|' + r.weight]) return;
                _repOut[lc] = r;
                _repAny = true;
            });
            if (_repAny) pairOut.representative_by_lang = _repOut;
        }
        // TODO #33 (design-intent §11) — the name the operator gave this pairing.
        // It used to be dropped here, so exporting and re-importing silently blanked
        // it. Emitted ONLY when non-empty, so a config whose pairings were never
        // named round-trips byte-identical (same rule as font_skip and the parked
        // members). validateBrandConfig ignores unknown pair keys — measured, not
        // assumed — so this is schema-safe, and `label` is never required.
        if (typeof pairing.label === "string" && pairing.label) pairOut.label = pairing.label;
        // Only `true` is emitted: there is no operator action that sets it back to
        // false (linkLabel only ever sets it true; nothing unlinks), so absence IS
        // the false state and legacy files stay byte-identical.
        if (pairing.labelLinked === true) pairOut.labelLinked = true;
        config.pairs.push(pairOut);
    }


    // univ-italic §7.4 ②: the italic HOW config. The panel's store is keyed by
    // the contract-K WINNER key, so it cannot hold two entries for one resolved
    // (family, weight) — AC⑤'s last-writer-wins is structurally impossible
    // rather than merely avoided. Entries are emitted verbatim in insertion
    // order, so an untouched round-trip is byte-equal (AC③).
    var _iv = panelData.italic_by_winner;
    if (_iv && typeof _iv === "object" && !Array.isArray(_iv) && ItalicKeys) {
        var _list = ItalicKeys.emitVariantList(_iv);
        if (_list.length) config.italic_by_weight = _list;
        else if (Array.isArray(config.italic_by_weight)) config.italic_by_weight = [];
        else delete config.italic_by_weight;   // never had one → stay legacy-clean
    }

    // Validate before returning — codex r7 P1: assert pass.
    //
    // design F (F3): the gate's scope is what the panel AUTHORED, not what it
    // CARRIED THROUGH. Parked members (see _reemitUnplaceableMembers) are spliced
    // back in AFTER this check, so a config that arrived invalid does not make the
    // operator's unrelated edits unexportable — `handleDone` refuses everything on
    // ok:false, which would deadlock the whole session on a defect the operator did
    // not cause and cannot fix here. This authored-vs-carried distinction is one the
    // codebase already draws twice: the passthrough baseline keys above, and italic
    // entries stored raw while displayed clamped (components.jsx:270-280).
    // A pairing whose member count only reaches 2 WITH its parked members is not a
    // one-member pairing the operator authored — it is a two-member pairing the panel
    // could only draw half of. Holding the members back from the gate without holding
    // the PAIRING back trips "pairs[N].members must be array of ≥2", which is ok:false,
    // which is handleDone refusing everything: the same session deadlock, through a
    // third door. (Found in host — every Node fixture happened to have ≥2 visible
    // members per pairing. The panel's own prune predicates already count parked
    // members for exactly this reason; the export gate has to agree with them.)
    // Such pairings are omitted from the gate and spliced back whole afterwards.
    // Pairings that still have ≥2 visible members ARE fully validated, parked members
    // and all — only the genuinely undrawable ones are held back.
    var _authored = config;
    if (Array.isArray(panelData.unplaceableMembers) && panelData.unplaceableMembers.length) {
        var _parkedPerPairing = {};
        panelData.unplaceableMembers.forEach(function (u) {
            if (u) _parkedPerPairing[u.pairingId] = (_parkedPerPairing[u.pairingId] || 0) + 1;
        });
        var _keptPairs = [];
        for (var _pk = 0; _pk < config.pairs.length; _pk++) {
            var _pid = pairings[_pk] && pairings[_pk].id;
            var _hasParked = _pid && _parkedPerPairing[_pid] > 0;
            var _visible = (config.pairs[_pk].members || []).length;
            if (_hasParked && _visible < 2) continue;      // undrawable → not the panel's to judge
            _keptPairs.push(config.pairs[_pk]);
        }
        if (_keptPairs.length !== config.pairs.length) {
            // Shallow view: validateBrandConfig only reads. NOTE this renumbers pairs
            // in any error message it produces, which is cosmetic — the messages only
            // surface when some OTHER pair is genuinely invalid.
            _authored = {};
            for (var _k in config) {
                if (Object.prototype.hasOwnProperty.call(config, _k)) _authored[_k] = config[_k];
            }
            _authored.pairs = _keptPairs;
        }
    }

    var v = (FMP && typeof FMP.validateBrandConfig === "function")
        ? FMP.validateBrandConfig(_authored)
        : { ok: true, errors: [] };

    // Splice the parked members back verbatim — on BOTH paths. Callers that read
    // `config` even when ok is false (app.jsx's libConfigForItalic does, since
    // mid-edit states are routinely invalid) must still see the operator's real
    // membership.
    _reemitUnplaceableMembers(config, panelData, pairings);

    if (!v.ok) return { ok: false, errors: v.errors, config: config };
    return { ok: true, errors: [], config: config };
}

// ---------------------------------------------------------------------------
// TODO #32(a) / #29 — re-emit the members the panel could not render
// ---------------------------------------------------------------------------
// design F (owner 2026-08-11). The file leaves EXACTLY as it arrived: the member
// goes back verbatim at its original index, and NOTHING else is written.
//
// An earlier revision of this function also wrote the member's (font, weight) into
// fonts_by_language and invented a representative, so the emitted config would pass
// validateBrandConfig. That was reverted, and the reason is worth keeping: those
// were factual assertions about the brand that NO PERSON had made — the machine
// wrote "en also uses Ghost Sans Regular" without telling the operator — and they
// broke round-trip fidelity (design-intent §11) on the FIRST pass while converging
// on the second, so the divergence was a one-shot event with no witness left. It
// also made the panel's own banner untrue: it promised the member went back as-is.
// In a panel where ItalicVariantNode flags "⚠ was N" merely because a DISPLAYED
// number differs from a STORED one, an undisclosed roster write is off-register.
//
// The roster entry is still the right destination — it is exactly what "Add font"
// produces. The operator now walks there themselves: the block's per-row verb calls
// _ensureFontInLang in panel state (app.jsx), the node appears, the wire draws, and
// the row disappears because a person removed it. Undo already exists and is
// already named: Remove font.
//
// The gate that used to force those extra writes is gone: panelDataToConfig now
// validates the AUTHORED config with parked members excluded, then splices them in.
function _reemitUnplaceableMembers(config, panelData, pairings) {
    var pending = panelData.unplaceableMembers;
    if (!Array.isArray(pending) || !pending.length) return;

    // pairings[i] produced config.pairs[i] one-for-one in the loop above, so the
    // pairing id alone locates the pair a parked member belongs to. A member whose
    // pairing is GONE (operator deleted it, or it was merged into another pairing
    // and app.jsx re-pointed the survivors) is dropped: that deletion was an
    // explicit operator act, unlike the environment-driven drop being fixed here.
    var pairById = {};
    for (var i = 0; i < pairings.length && i < config.pairs.length; i++) {
        if (pairings[i] && pairings[i].id) pairById[pairings[i].id] = config.pairs[i];
    }

    var touched = [];
    for (var u = 0; u < pending.length; u++) {
        var ent = pending[u];
        if (!ent) continue;
        var pair = pairById[ent.pairingId];
        if (!pair || !Array.isArray(pair.members)) continue;

        var mem = _deepCopyPlain(ent.member);
        if (!mem || !mem.lang || !mem.font || !mem.weight) {
            mem = { lang: ent.lang, font: ent.font, weight: ent.weight };
        }
        if (!mem.lang || !mem.font || !mem.weight) continue;

        // The member may have become placeable since (an import added the font, the
        // operator wired it by hand): re-adding it would be an exact-duplicate
        // member, which validateBrandConfig rejects (:102-104).
        var dup = false;
        for (var m2 = 0; m2 < pair.members.length; m2++) {
            var mm = pair.members[m2];
            if (mm && mm.lang === mem.lang && mm.font === mem.font && mm.weight === mem.weight) {
                dup = true;
                break;
            }
        }
        if (dup) continue;

        // Original slot when it still fits — entries were collected in ascending
        // memberIndex per pair, so inserting them in order rebuilds the source
        // ordering exactly. Otherwise append (order is not worth dropping data for).
        var at = pair.members.length;
        if (typeof ent.memberIndex === "number" && ent.memberIndex >= 0 && ent.memberIndex < at) {
            at = ent.memberIndex;
        }
        pair.members.splice(at, 0, mem);
        touched.push({ pair: pair, lang: mem.lang, sourceRep: ent.pairRep || null });
    }
    for (var t = 0; t < touched.length; t++) {
        _restoreRepForLang(touched[t].pair, touched[t].lang, touched[t].sourceRep);
    }
}

// Restore ONLY a representative the source config actually carried.
//
// Why this is a restore and not an ensure (design F): parking a member drops its
// lang to one VISIBLE member, and app.jsx's rep-normalize effect prunes the rep key
// of any lang with ≤1 member — so a rep the operator stored, pointing at the parked
// member, is gone from panel state by export time. Putting it back is reproducing
// the file, which is what F3 requires.
//
// Deliberately NO first-connected fallback. Electing a representative the source
// never named is the same category of unasked assertion as the roster write this
// revision removed, and it would break byte-identity on the un-acted path by adding
// a key the incoming file did not have. It also has no remaining purpose: the MM
// rule that once forced it (a multi-member lang must carry a rep,
// font_mapping_pairs.js:121-128) is evaluated BEFORE parked members are spliced in,
// so a parked-induced multi-member lang never faces that gate.
//
// Precedence: a valid rep the panel currently holds is the operator's live choice
// and is never overridden; otherwise restore the source's, and only if the restore
// has made it a real member again.
// KNOWN GAP (unchanged, surfaced to arch): if the lang still has ≥2 VISIBLE members
// the normalize effect has already replaced the rep with a visible one before
// export, so a source rep naming the parked member is not recovered. The member
// itself is never lost either way.
function _restoreRepForLang(pair, lang, sourceRep) {
    if (!sourceRep || !sourceRep.font || !sourceRep.weight) return;
    var mems = (pair.members || []).filter(function (mm) { return mm.lang === lang; });
    if (mems.length < 2) return;
    var isValid = function (r) {
        return !!(r && r.font && r.weight && mems.some(function (mm) {
            return mm.font === r.font && mm.weight === r.weight;
        }));
    };
    var current = pair.representative_by_lang && pair.representative_by_lang[lang];
    if (isValid(current)) return;
    if (!isValid(sourceRep)) return;
    if (!pair.representative_by_lang) pair.representative_by_lang = {};
    pair.representative_by_lang[lang] = { font: sourceRep.font, weight: sourceRep.weight };
}

function _resolvePanelMember(panelData, mem) {
    var langs = panelData.languages || [];
    for (var i = 0; i < langs.length; i++) {
        if (langs[i].id !== mem.lang) continue;
        var lang = langs[i];
        for (var j = 0; j < (lang.fonts || []).length; j++) {
            var font = lang.fonts[j];
            if (font.id !== mem.font) continue;
            for (var k = 0; k < (font.weights || []).length; k++) {
                var w = font.weights[k];
                if (w.id === mem.node) {
                    return {
                        lang: lang.code || lang.id,
                        font: font.name,
                        weight: w.actual || w.semantic
                    };
                }
            }
            // Merge group? Use representative. 8D-ext-MM step 4 [C]: guarded
            // fallback — a stale merge.rep id that is no longer a member falls
            // back to members[0] (unguarded `rep || members[0]` would keep the
            // stale id → no weight matches → member silently dropped). Matches
            // app.jsx resolveMemberToLib so panel ↔ config resolve identically.
            var merges = font.merges || [];
            for (var mg = 0; mg < merges.length; mg++) {
                if (merges[mg].id !== mem.node) continue;
                var _mems = merges[mg].members || [];
                var rep = (merges[mg].rep && _mems.indexOf(merges[mg].rep) >= 0)
                    ? merges[mg].rep : _mems[0];
                for (var k2 = 0; k2 < (font.weights || []).length; k2++) {
                    if (font.weights[k2].id === rep) {
                        return {
                            lang: lang.code || lang.id,
                            font: font.name,
                            weight: font.weights[k2].actual || font.weights[k2].semantic
                        };
                    }
                }
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// configToPanelData — lib config → UI shape
// ---------------------------------------------------------------------------
// scanResult (optional) provides `used` counts per (family, style) and
// installed-style augmentation (MVP #3) is already baked in by doc_scan.
function configToPanelData(config, scanResult, opts) {
    if (!config || typeof config !== "object") return null;
    opts = opts || {};
    var usedByKey = {}; // "family|style" → count
    if (scanResult && Array.isArray(scanResult.documentFonts)) {
        for (var i = 0; i < scanResult.documentFonts.length; i++) {
            var df = scanResult.documentFonts[i];
            usedByKey[df.font + "|" + df.weight] = df.used || 0;
        }
    }

    // 8D-ext-bypair-tofu-ux Phase 2 follow-up: nodes are built STRICTLY from
    // fonts_by_language (see langCodes/entries below). opts.includeDocFonts
    // unions the scan's doc-present fonts (grouped by intrinsic home-lang) into
    // a COPY of fonts_by_language FIRST, so EVERY scanned font becomes a node —
    // even ones this config doesn't cover. Required by the tofu red-flag, which
    // can only flag fonts that render as nodes (a doc-present-but-unpaired font
    // dropped here = silently un-flaggable). Single SoT for the union so the
    // seed-open path AND both launchers' importJson share it (was inline in one
    // launcher only → drift). NEVER mutates `config` (builds `fbl` fresh).
    // Default OFF → all legacy callers keep "nodes from fonts_by_language only".
    var fbl = config.fonts_by_language || {};
    if (opts.includeDocFonts && scanResult && Array.isArray(scanResult.documentFonts)) {
        var __home = scanResult.byFamilyHomeLang || {};
        var __inst = opts.installedFamilies || {};
        var __merged = {};
        for (var __l in fbl) {
            if (!Object.prototype.hasOwnProperty.call(fbl, __l)) continue;
            __merged[__l] = (fbl[__l] || []).map(function (e) { return { font: e.font, weight: e.weight }; });
        }
        // Dedup by the SANITIZED (font|weight) key within a lang bucket — the same key
        // the node ID is built from (w_<langScope>_<sanitize(fam)>_<sanitize(weight)>) —
        // so a raw-distinct weight that sanitizes to an existing node ID (e.g. "Bold" vs
        // "bold" in the SAME family) doesn't create a duplicate node / React key. First-
        // seen (config / doc-used) spelling wins.
        //
        // DEFERRED (follow-up, see TODO + DEV_LOG 2026-06-21): cross-SPELLING sanitize
        // collisions at the FAMILY level (config "Family Pro" vs doc "Family-Pro") and
        // LANG level (config "EN" vs scan "en") can still dup font-card / L_ IDs, and the
        // used-count for such a fold would be lost — BUT only with a NON-canonical config
        // whose spellings differ from the scan's actual font/lang names; the realistic
        // panel-generated flow never hits it. Root = configToPanelData mixes raw vs
        // sanitized + global vs lang-scoped identity keys; the proper fix is a canonical-
        // identity refactor, scoped as its own change (codex rounds 2-5 each surfaced one
        // facet of this; not gold-plated here to avoid shipping the patch-cascade's bugs).
        var __pushUnique = function (lng, font, weight) {
            if (!__merged[lng]) __merged[lng] = [];
            var __key = _sanitizeId(font) + "|" + _sanitizeId(weight);
            for (var __k = 0; __k < __merged[lng].length; __k++) {
                if (_sanitizeId(__merged[lng][__k].font) + "|" + _sanitizeId(__merged[lng][__k].weight) === __key) return;
            }
            __merged[lng].push({ font: font, weight: weight });
        };
        for (var __di = 0; __di < scanResult.documentFonts.length; __di++) {
            var __df = scanResult.documentFonts[__di];
            var __lng = __home[__df.font] || "en";
            // Add the doc-used weight FIRST (keeps its usedByKey count downstream),
            // then EVERY installed style of the family — mirrors buildPanelData's MVP#3
            // installed-augmentation so a seeded/imported panel shows the SAME full
            // family the bare scan does, not just the one doc-used weight. Installed-only
            // weights get used=0 (no "in doc" badge, state≠todo → not tofu-flagged).
            __pushUnique(__lng, __df.font, __df.weight);
            var __famInstalled = __inst[__df.font];
            if (__famInstalled && __famInstalled.length) {
                for (var __si = 0; __si < __famInstalled.length; __si++) __pushUnique(__lng, __df.font, __famInstalled[__si]);
            }
        }
        fbl = __merged;
    }

    var LANG_PRESETS = {
        'en':    { name: 'English',             script: 'Ag', family: "'Hanken Grotesk'" },
        'zh-CN': { name: 'Simplified Chinese',  script: '永', family: "'Noto Sans SC'" },
        'zh-TW': { name: 'Traditional Chinese', script: '繁', family: "'Noto Sans TC'" },
        'ja':    { name: 'Japanese',            script: 'あ', family: "'Noto Sans JP'" },
        'ko':    { name: 'Korean',              script: '한', family: "'Noto Sans KR'" },
        'th':    { name: 'Thai',                script: 'ก', family: "'Hanken Grotesk'" }
    };

    var languages = [];
    var langCodes = Object.keys(fbl);
    var preferredOrder = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'th'];
    langCodes.sort(function (a, b) {
        var ia = preferredOrder.indexOf(a), ib = preferredOrder.indexOf(b);
        if (ia < 0) ia = 99;
        if (ib < 0) ib = 99;
        return ia - ib;
    });

    for (var li = 0; li < langCodes.length; li++) {
        var code = langCodes[li];
        var entries = fbl[code] || [];

        // Group by font.name
        var byFamily = {};
        for (var fi = 0; fi < entries.length; fi++) {
            var e = entries[fi];
            if (!byFamily[e.font]) byFamily[e.font] = [];
            byFamily[e.font].push(e.weight);
        }

        var fonts = [];
        // Codex r3 P1-4 fix: scope F_id and w_id by lang code so the same
        // family under multiple languages gets distinct IDs. Otherwise UI
        // font lookup/removal (globally-keyed) would conflate them.
        var langScope = _sanitizeId(code);
        Object.keys(byFamily).forEach(function (fam) {
            var weights = byFamily[fam].map(function (w) {
                return {
                    id: 'w_' + langScope + '_' + _sanitizeId(fam) + '_' + _sanitizeId(w),
                    semantic: w,
                    actual: w,
                    used: usedByKey[fam + "|" + w] || 0
                };
            });
            weights.sort(function (a, b) { return b.used - a.used; });
            fonts.push({
                id: 'F_' + langScope + '_' + _sanitizeId(fam),
                name: fam,
                role: 'Body',
                weights: weights,
                merges: []
            });
        });

        var preset = LANG_PRESETS[code] || { name: code, script: '·', family: 'sans-serif' };
        languages.push({
            id: 'L_' + code.replace(/-/g, '_'),
            code: code,
            name: preset.name,
            script: preset.script,
            family: preset.family,
            fonts: fonts
        });
    }

    // Map pairs → pairings. Codex r2 P1-3 fix: React canvas requires v2-id
    // form (lang=L_id, font=F_id, node=w_id). We resolve each lib-form
    // member to its corresponding panel IDs by looking up the languages
    // tree we just built. Drop members that don't resolve (defensive).
    function _findPanelIds(langCode, fontName, weight) {
        var lObj = languages.find(function (l) { return l.code === langCode; });
        if (!lObj) return null;
        var fObj = (lObj.fonts || []).find(function (f) { return f.name === fontName; });
        if (!fObj) return null;
        var wObj = (fObj.weights || []).find(function (w) {
            return w.actual === weight || w.semantic === weight;
        });
        if (!wObj) return null;
        return { lang: lObj.id, font: fObj.id, node: wObj.id };
    }
    var pairings = [];
    // TODO #32(a) / #29 — members no node can carry. Collected, NEVER dropped.
    // A member fails _findPanelIds exactly when its (lang, font, weight) is not
    // in fonts_by_language[lang] (nodes are built strictly from that roster), i.e.
    // exactly when validateBrandConfig's cross-ref would already reject the config
    // it was loaded from (font_mapping_pairs.js:106-110 — verified, see
    // _HANDOFF_panelfix.md). That is an ENVIRONMENT/AUTHORING fault, not consent to
    // delete the operator's link: the old code pushed the pairing with the survivors
    // and no signal at all, so opening the panel and pressing Done erased a member
    // permanently. Same policy as findOrphanEntries' never-prune (OD-13): carry it
    // through, show it, re-emit it verbatim on the way out.
    var unplaceableMembers = [];
    // F1 — the door check. The panel validates its own OUTPUT everywhere and never
    // validated its INPUT, so it refused to write what it silently accepted; a
    // member with no node is exactly a member validateBrandConfig would already have
    // rejected (font_mapping_pairs.js:106-110). Run it here to obtain the precise
    // sentence, and REPORT it — the panel still opens, nothing is refused.
    //
    // Placed in the adapter rather than in each launcher's importJson so all THREE
    // entry points get it from one implementation: font_apply_panel.idjs importJson,
    // font_mapping_panel_ui.js importJson, and font_mapping_panel_ui.js's seedConfig
    // (:146-155) — the last is how an operator's real brand_config arrives, and a
    // per-launcher copy would have missed it (the includeDocFonts comment above
    // records this exact drift happening once already).
    // Messages are keyed by "pairs[<pi>].members[<mi>]", which the validator emits
    // verbatim and which is precisely what identifies a parked member here.
    var _doorErrors = {};
    if (FMP && typeof FMP.validateBrandConfig === "function") {
        try {
            var _dv = FMP.validateBrandConfig(config);
            if (_dv && !_dv.ok) {
                (_dv.errors || []).forEach(function (msg) {
                    var m = /^(pairs\[\d+\]\.members\[\d+\])/.exec(String(msg));
                    if (m && !_doorErrors[m[1]]) _doorErrors[m[1]] = String(msg);
                });
            }
        } catch (eDoor) { /* diagnostics are a bonus; never block the open */ }
    }
    var configPairs = config.pairs || [];
    for (var pi = 0; pi < configPairs.length; pi++) {
        var p = configPairs[pi];
        var resolvedMembers = [];
        var _pairingId = 'P_' + pi;
        var _pairIndex = pi;   // captured for the diagnostic key below (forEach is sync)
        (p.members || []).forEach(function (m, memberIndex) {
            var ids = _findPanelIds(m.lang, m.font, m.weight);
            if (ids) { resolvedMembers.push(ids); return; }
            unplaceableMembers.push({
                // WHICH pairing it belongs to. panelDataToConfig re-emits ONLY into
                // a pairing that still exists, so an operator who deletes the pairing
                // deletes its parked members with it (an explicit act) while an
                // unrelated edit elsewhere can never touch them. Deliberately the ONLY
                // locator: a positional fallback would re-home a parked member into
                // whatever pairing later occupied that index.
                pairingId: _pairingId,
                // Original slot in members[], so an untouched round-trip restores the
                // exact original order rather than appending at the end.
                memberIndex: memberIndex,
                // Named fields for the UI — the panel must say WHICH (lang, font,
                // weight) it could not place, not just how many.
                lang: m.lang, font: m.font, weight: m.weight,
                // The re-emit payload: the member object verbatim, so any key beyond
                // the {lang, font, weight} triple survives untouched too.
                member: _deepCopyPlain(m) || { lang: m.lang, font: m.font, weight: m.weight },
                // This pairing's representative for the member's lang, as the CONFIG
                // spelled it. Needed because parking a member drops that lang to one
                // visible member, and app.jsx's rep-normalize effect (:1292-1349)
                // prunes the rep key of any lang with ≤1 member — so by export time
                // the operator's stored choice is gone from panel state. Without this
                // the restore would silently re-elect first-connected instead.
                pairRep: _deepCopyPlain(
                    (p.representative_by_lang && p.representative_by_lang[m.lang]) || null),
                // F1 — the validator's own sentence for THIS member. It says why the
                // member cannot be placed, which the (lang, font, weight) triple on
                // its own does not. Falls back to a plain description if the config
                // is malformed enough that no per-member message was produced.
                diagnostic: _doorErrors['pairs[' + _pairIndex + '].members[' + memberIndex + ']']
                    || ('pairs[' + _pairIndex + '].members[' + memberIndex + '] references {'
                        + m.font + ', ' + m.weight + '} not in fonts_by_language[' + m.lang + ']')
            });
        });
        pairings.push({
            // TODO #33 — id and hue are NOT read back from the config, deliberately.
            // id: panel-local handle. On load it is positional ('P_' + index); new
            // pairings get window.uid('P'). The config has no notion of pairing
            // identity, so persisting one would introduce a second identity system
            // into the file — and design F's parked members address their pairing by
            // exactly this positional id, so a config-supplied id would break that.
            // hue: a machine-supplied CONSTANT (data.jsx PAIR_COLOR '#5b9cf0';
            // PAIR_HUES is a one-entry palette) with no setter anywhere in the panel.
            // Both are machine-added, neither is reachable by an operator gesture.
            // Reasons reported to arch for design-intent §11's exemption list.
            id: _pairingId,
            hue: '#5b9cf0',
            // TODO #33 — the operator's name for this pairing, and whether the label
            // lane is explicitly wired to it. Both round-trip: `label` is seeded by
            // the machine but is edited through setPairingLabel, and `labelLinked` is
            // set by an explicit label-port drag (linkLabel). Absent in a legacy
            // config → the previous defaults, so old files load exactly as before.
            label: (typeof p.label === "string") ? p.label : '',
            labelLinked: p.labelLinked === true,
            members: resolvedMembers,
            // Keep representative_by_lang in lib form (lang code + font + weight)
            // — it's persisted but only consumed by resolve.js, not React directly.
            representative_by_lang: p.representative_by_lang || undefined
        });
    }

    var out = {
        name: config.brand_name || 'Brand',
        languages: languages,
        pairings: pairings,
        equivalence_groups: config.equivalence_groups || []
    };
    // TODO #32(a) / #29 — only when non-empty, so a config whose every member
    // placed round-trips byte-identical (same rule as font_skip below).
    if (unplaceableMembers.length) out.unplaceableMembers = unplaceableMembers;
    // B-ui A-5: round-trip the persisted unowned-CJK skip set back into panelData
    // (array of "font|weight" keys) so re-opening an imported config keeps the
    // user's prior skips. Only set when present → legacy configs round-trip clean.
    if (Array.isArray(config.font_skip) && config.font_skip.length) {
        out.font_skip = config.font_skip.slice();
    }
    // univ-italic §7.4 ②: the italic variant store, keyed by contract-K winner
    // key. Always present (possibly empty) so the panel knows it owns this block
    // — a panelData WITHOUT it leaves config.italic_by_weight as passthrough.
    if (ItalicKeys) out.italic_by_winner = ItalicKeys.buildVariantMap(config.italic_by_weight);
    // panel-italic AC③: park the source config as the round-trip baseline (see
    // header). A COPY — the panel must never mutate the caller's config, and the
    // baseline must not drift when React clones/edits panelData. Both panel entry
    // points funnel through here (seed-open + in-panel importJson), so both keep
    // their non-panel-owned keys on the way back out.
    var __srcCopy = _deepCopyPlain(config);
    if (__srcCopy) out[SOURCE_CONFIG_FIELD] = __srcCopy;
    // #28e — face-level not-installed precompute (lib/font_face_missing.js).
    // Lives HERE for the same reason includeDocFonts does: all entry points
    // (both launchers' importJson + seedConfig) funnel through configToPanelData,
    // so one implementation serves them all (a per-launcher copy drifted once
    // already — see the includeDocFonts note above). Computed ONLY when the
    // launcher injects a host probe (opts.probeFace); Node tests and the
    // standalone preview don't, so panelData carries no field and the panel
    // shows nothing. NOT a panel-owned config key: panelDataToConfig never
    // reads it, so exports are byte-identical with or without it.
    if (FaceMissing && typeof opts.probeFace === "function") {
        var __missKeys = null;
        try {
            __missKeys = FaceMissing.computeMissingFaceKeys(config, {
                installedFamilies: opts.installedFamilies,
                probeFace: opts.probeFace
            });
        } catch (eMiss) { __missKeys = null; }
        if (__missKeys) {
            out._missingFaceKeys = __missKeys;
            // #28e-rep (design-intent §12): representative-role classification,
            // carried alongside the map so a future owner ruling ("distinguish
            // rep vs non-rep in the red outline?") is a one-wire hookup. NO
            // display reads this yet. Same non-owned-field status as
            // _missingFaceKeys: panelDataToConfig never reads it.
            try { out._faceRoles = FaceMissing.collectFaceRoles(config); }
            catch (eRole) { /* classification is a bonus; never block the open */ }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// addPairMember — codex r6 P1 fix
// ---------------------------------------------------------------------------
// Adds a (lang, font, weight) member to pair at pairIdx. Per
// validateBrandConfig, member MUST reference an existing (font, weight)
// under fonts_by_language[lang]. We ensure that first (push if missing),
// then add the member.
//
// Returns { ok, config: <mutated config>, errors }.
function addPairMember(config, pairIdx, lang, font, weight) {
    if (!config || !Array.isArray(config.pairs)) {
        return { ok: false, errors: ["config missing pairs"], config: config };
    }
    if (pairIdx < 0 || pairIdx >= config.pairs.length) {
        return { ok: false, errors: ["pairIdx out of range"], config: config };
    }
    if (!lang || !font || !weight) {
        return { ok: false, errors: ["lang/font/weight required"], config: config };
    }

    // Ensure fonts_by_language[lang] exists
    if (!config.fonts_by_language) config.fonts_by_language = {};
    if (!Array.isArray(config.fonts_by_language[lang])) {
        config.fonts_by_language[lang] = [];
    }
    // Ensure (font, weight) registered
    var exists = false;
    var arr = config.fonts_by_language[lang];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i].font === font && arr[i].weight === weight) { exists = true; break; }
    }
    if (!exists) arr.push({ font: font, weight: weight });

    // Add to pair. 8D-ext-MM step 4: same-lang multi-member is now ALLOWED (one
    // lang → multiple weights fan-in). Only an EXACT-duplicate {lang,font,weight}
    // member is rejected (idempotency / would double-emit downstream). When the
    // add makes a lang reach ≥2 members, auto-set representative_by_lang[lang] to
    // the first-connected member (validateBrandConfig II-b requires a rep there).
    var pair = config.pairs[pairIdx];
    if (!Array.isArray(pair.members)) pair.members = [];
    var alreadyMember = false;
    for (var m = 0; m < pair.members.length; m++) {
        var mm = pair.members[m];
        if (mm.lang === lang && mm.font === font && mm.weight === weight) {
            alreadyMember = true;
            break;
        }
    }
    if (alreadyMember) {
        return { ok: false,
            errors: ["pair already has exact member {" + lang + ", " + font + ", " + weight + "}"],
            config: config };
    }
    pair.members.push({ lang: lang, font: font, weight: weight });
    _ensureRepForLang(pair, lang);
    return { ok: true, errors: [], config: config };
}

// 8D-ext-MM step 4: if `lang` has ≥2 members in `pair`, ensure
// representative_by_lang[lang] is set to the first-connected (earliest in
// members[]) member of that lang. Keeps a pre-existing valid rep. This is the
// SET/KEEP half of font_mapping_ops._normalizeReps — addPairMember only ADDS a
// member (no removal), so no prune is needed here (lib config = lang CODES).
function _ensureRepForLang(pair, lang) {
    var mems = (pair.members || []).filter(function (mm) { return mm.lang === lang; });
    if (mems.length < 2) return;
    if (!pair.representative_by_lang) pair.representative_by_lang = {};
    var rep = pair.representative_by_lang[lang];
    var valid = rep && rep.font && rep.weight && mems.some(function (mm) {
        return mm.font === rep.font && mm.weight === rep.weight;
    });
    if (!valid) {
        pair.representative_by_lang[lang] = { font: mems[0].font, weight: mems[0].weight };
    }
}

// ---------------------------------------------------------------------------
// TODO#58 ② — "upstream named a target language that has no fonts yet"
// ---------------------------------------------------------------------------
// owner's rule: 「上游已指定目标语言 ∧ 配置里该语言还没有任何字体 ⇒ 直接进入
// 选字体那一步」.
//
// This decides WHETHER and WHAT; the panel does the mutating. It lives here, as a
// pure function, for one reason: the panel half can only be exercised on the host,
// and "did the rule fire on the right input" is the part most likely to be wrong.
// Splitting it means the antecedent gets gate tests offline and the host round only
// has to answer "does the card show up".
//
// Returns null when nothing should happen — which is most of the time, and is the
// correct answer for every uncertainty: no upstream language, or a language that is
// already configured. Otherwise:
//   { kind: "card",   code }          → an empty column exists; put the picker in it
//   { kind: "column", code, column }  → no column at all; add this one, then the picker
//
// 🔴 `sameLang` MUST be the caller's shared comparator (libIdentityGroups.
// sameLang). Upstream may say `zh-Hans-CN` where the column says `zh-CN`; comparing
// raw strings here would make the rule miss exactly the case it exists for, and
// silently — it would look like "the language is already fine". A missing
// comparator falls back to a raw compare, which is strictly the stricter answer
// (fires less), never a looser one.
function planTargetLanguageEntry(languages, upstreamLang, presets, sameLang) {
    var code = upstreamLang == null ? "" : String(upstreamLang);
    if (!code) return null;
    var same = typeof sameLang === "function"
        ? sameLang
        : function (a, b) { return String(a == null ? "" : a) === String(b == null ? "" : b); };
    var langs = Array.isArray(languages) ? languages : [];
    for (var i = 0; i < langs.length; i++) {
        var l = langs[i];
        if (!l || !l.code || !same(l.code, code)) continue;
        // Found it. Already carries fonts ⇒ the config covers this language ⇒ silent.
        if ((l.fonts || []).length > 0) return null;
        return { kind: "card", code: l.code };
    }
    // No column. The ordinary case for a fresh target language: the SOURCE document
    // contains none of its fonts either, so the doc-scan union does not invent one.
    var preset = null;
    var list = Array.isArray(presets) ? presets : [];
    for (var j = 0; j < list.length; j++) {
        if (list[j] && list[j].code && same(list[j].code, code)) { preset = list[j]; break; }
    }
    // ⚠ When a preset matches we take ITS spelling, not upstream's, so the new
    // column is spelled the way configToPanelData would have spelled it. Nothing
    // references the column yet (it is empty), so there is no handle to invalidate.
    if (!preset) preset = { code: code, name: code, script: "·", family: "sans-serif" };
    return {
        kind: "column",
        code: preset.code,
        column: {
            code: preset.code,
            name: preset.name || preset.code,
            script: preset.script || "·",
            family: preset.family || "sans-serif",
            fonts: []
        }
    };
}

module.exports = {
    panelDataToConfig: panelDataToConfig,
    configToPanelData: configToPanelData,
    addPairMember: addPairMember,
    planTargetLanguageEntry: planTargetLanguageEntry,
    // panel-italic AC③ — exported so tests (and any future config-block owner)
    // can assert the passthrough contract instead of re-listing the keys.
    PANEL_OWNED_CONFIG_KEYS: PANEL_OWNED_CONFIG_KEYS,
    PANEL_CONDITIONAL_CONFIG_KEYS: PANEL_CONDITIONAL_CONFIG_KEYS,
    SOURCE_CONFIG_FIELD: SOURCE_CONFIG_FIELD
};
