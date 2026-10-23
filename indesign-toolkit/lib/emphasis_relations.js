"use strict";

/**
 * lib/emphasis_relations.js — translator-bold "emphasis relation" resolver (pure).
 *
 * task_plan §7.6 #ac-emphasis-relations, batch 1 (bold half, import side).
 *
 * The brand config may carry card-to-card relations between pairings:
 *
 *   emphasis_relations: [ { from: {lang,font,weight}, to: {lang,font,weight} } ]
 *
 * "the emphasis of the pairing that contains `from` is the pairing that contains
 * `to`". A pairing has no stable id in config, so each end names one MEMBER, and
 * resolves to the pairing(s) containing that member. Bold vs italic is not stored:
 * a relation whose target pairing is all-italic is an italic relation, all-upright
 * is a bold relation, mixed is invalid (owner OD-E2c = 1).
 *
 * A translator bold annotation is resolved from the paragraph BODY (owner OD-E9 = A:
 * "按段落正文字重找强调"), never from the live character (spec R-0 / L1: the live
 * character carries pass-1 residue and later sweeps). Latin text inside a CJK target
 * keeps the source family (byPair_char_sweep only re-fonts CJK), so its emphasis
 * weight comes from the target pairing's member in that family; CJK text (or a
 * Latin->Latin whole-range swap) lands on the target pairing's projected member,
 * exactly as byPair projects the body itself (owner OD-E6 = A: one relation covers
 * every language through the pairing).
 *
 * Member identity (spec K1): lang via normalizeBcp47Identity; (font, weight) through
 * getCanonical as a PAIR; family then folded through the "(OTF)" format-token strip
 * the twin resolver uses; weight KEEPS italic/oblique tokens (only case + whitespace
 * folded). font_italic_probe._normWeight is deliberately NOT used here: it strips
 * italic and folds regular/roman to "", which would make Bold == Bold Italic.
 *
 * Nothing here touches InDesign; the host-side landing lives in v2_pipeline.
 * ES5 only (the UXP bundler inlines it).
 */

var LST = require("./lang_script_table.js");
var FMP = require("./font_mapping_pairs.js");
var SSB = null;
try { SSB = require("./style_sheet_builder.js"); } catch (eSSB) { SSB = null; }

var ITALIC_RE = /italic|oblique/i;

function foldWeight(w) {
    return String(w === null || w === undefined ? "" : w)
        .toLowerCase().replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

function foldFamily(f) {
    var s = String(f === null || f === undefined ? "" : f);
    var strip = SSB && SSB._internal && SSB._internal._stripFormatParens;
    if (typeof strip === "function") s = strip(s);
    return s.toLowerCase().replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

function normLang(l) {
    try { return LST.normalizeBcp47Identity(l); } catch (e) { return String(l || ""); }
}

// canonical identity of one member: {lang, family, weight} (folded)
// L9: an equivalence group whose members are not all italic or all upright must not fold
// one onto the other in member identity (it would make an italic pairing's member equal
// an upright one) — such a group is skipped for the getCanonical step and reported.
function _groupMixesItalic(eg) {
    if (!eg) return false;
    var ms = [eg.canonical].concat(eg.merged_in || []);
    var it = 0, up = 0;
    for (var i = 0; i < ms.length; i++) { if (!ms[i]) continue; if (isItalicMember(ms[i])) it++; else up++; }
    return it > 0 && up > 0;
}
function canonMember(config, m) {
    if (!m) return null;
    if (_groupMixesItalic(FMP.findEquivalenceGroup(config, m.lang, m.font, m.weight)))
        return { lang: normLang(m.lang), family: foldFamily(m.font), weight: foldWeight(m.weight) };
    var c = FMP.getCanonical(config, m.lang, m.font, m.weight) || { font: m.font, weight: m.weight };
    return { lang: normLang(m.lang), family: foldFamily(c.font), weight: foldWeight(c.weight) };
}

function sameMember(config, a, b) {
    var x = canonMember(config, a), y = canonMember(config, b);
    return !!(x && y && x.lang === y.lang && x.family === y.family && x.weight === y.weight);
}

function isItalicMember(m) {
    if (!m) return false;
    return ITALIC_RE.test(String(m.weight || "")) || ITALIC_RE.test(String(m.font || "")) || !!m.copy_of;
}

function pairingKind(pair) {
    if (!pair || !Array.isArray(pair.members) || !pair.members.length) return "empty";
    var it = 0, up = 0;
    for (var i = 0; i < pair.members.length; i++) {
        if (isItalicMember(pair.members[i])) it++; else up++;
    }
    if (it && up) return "mixed";
    return it ? "italic" : "upright";
}

// indices of config.pairs containing `member`
function pairingsContaining(config, member) {
    var out = [];
    var pairs = (config && Array.isArray(config.pairs)) ? config.pairs : [];
    for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        if (!p || !Array.isArray(p.members)) continue;
        for (var j = 0; j < p.members.length; j++) {
            if (sameMember(config, p.members[j], member)) { out.push(i); break; }
        }
    }
    return out;
}

function describeMember(m) {
    if (!m) return "(none)";
    return String(m.lang || "?") + ":" + String(m.font || "?") + "|" + String(m.weight || "?");
}

// Short, readable name for a pairing in the report: its member in `lang` (the
// source language, i.e. what the operator reads on the card), else its first member.
function pairingLabel(config, idx, lang) {
    var p = config && Array.isArray(config.pairs) ? config.pairs[idx] : null;
    if (!p) return "#" + idx;
    if (p.label) return String(p.label);
    if (!Array.isArray(p.members) || !p.members.length) return "#" + idx;
    var pick = p.members[0];
    if (lang) {
        var want = normLang(lang);
        for (var i = 0; i < p.members.length; i++) {
            if (normLang(p.members[i].lang) === want) { pick = p.members[i]; break; }
        }
    }
    return String(pick.font) + " " + String(pick.weight);
}

/**
 * resolveRelations — validate `emphasis_relations` LOCALLY (a bad entry never
 * invalidates the config; spec "校验是局部的") and index them by from-pairing.
 * @returns {{ bold:Object<number,number>, italic:Object<number,number>,
 *             rules:Array, issues:Array }}
 *   rules  — one row per valid relation (for the report)
 *   issues — rule-level problems: {code, entry, reason}
 */
function resolveRelations(config) {
    var out = { bold: {}, italic: {}, rules: [], issues: [] };
    // L9 rule-level report (independent of whether relations exist)
    (config && Array.isArray(config.equivalence_groups) ? config.equivalence_groups : []).forEach(function (eg, gi) {
        if (_groupMixesItalic(eg)) out.issues.push({ code: "equivalence_group_mixed_italic", entry: null, group: gi,
            reason: "equivalence group " + (eg.lang || "?") + " " + (eg.canonical ? eg.canonical.font + " " + eg.canonical.weight : "?")
                + " mixes italic and upright weights — it is not used to compare pairing members" });
    });
    if (!config || config.emphasis_relations === undefined || config.emphasis_relations === null) return out;
    var rels = config.emphasis_relations;
    if (!Array.isArray(rels)) {
        out.issues.push({ code: "config_entry_invalid", entry: null, reason: "emphasis_relations is not an array" });
        return out;
    }
    var cands = [];   // {i, from, to, kind}
    for (var i = 0; i < rels.length; i++) {
        var r = rels[i];
        var bad = function (why) { out.issues.push({ code: "config_entry_invalid", entry: i, reason: why }); };
        if (!r || !r.from || !r.to) { bad("missing from/to"); continue; }
        if (r.origin !== undefined && r.origin !== "migration") { bad("unknown origin " + JSON.stringify(r.origin)); continue; }
        var fromIdx = pairingsContaining(config, r.from);
        var toIdx = pairingsContaining(config, r.to);
        if (fromIdx.length !== 1) { bad("from " + describeMember(r.from) + " resolves to " + fromIdx.length + " pairings"); continue; }
        if (toIdx.length !== 1) { bad("to " + describeMember(r.to) + " resolves to " + toIdx.length + " pairings"); continue; }
        if (fromIdx[0] === toIdx[0]) { bad("from and to are the same pairing"); continue; }
        var kind = pairingKind(config.pairs[toIdx[0]]);
        if (kind === "mixed") { bad("target pairing mixes italic and upright members"); continue; }
        if (kind !== "italic" && kind !== "upright") { bad("target pairing is empty"); continue; }
        cands.push({ i: i, from: fromIdx[0], to: toIdx[0], kind: kind === "italic" ? "italic" : "bold" });
    }
    // >=2 relations of the same kind from one pairing ⇒ all of them invalid (no pick)
    var count = {};
    for (var c = 0; c < cands.length; c++) {
        var key = cands[c].from + "|" + cands[c].kind;
        count[key] = (count[key] || 0) + 1;
    }
    for (var d = 0; d < cands.length; d++) {
        var k = cands[d].from + "|" + cands[d].kind;
        if (count[k] > 1) {
            out.issues.push({ code: "config_entry_invalid", entry: cands[d].i,
                reason: count[k] + " " + cands[d].kind + " relations from the same pairing (" + pairingLabel(config, cands[d].from) + ")" });
            continue;
        }
        out[cands[d].kind][cands[d].from] = cands[d].to;
        out.rules.push({
            entry: cands[d].i, dimension: cands[d].kind,
            from: pairingLabel(config, cands[d].from, rels[cands[d].i].from.lang), to: pairingLabel(config, cands[d].to, rels[cands[d].i].from.lang),
            fromIdx: cands[d].from, toIdx: cands[d].to,
            source: (rels[cands[d].i] && rels[cands[d].i].origin === "migration") ? "migration" : "config"
        });
    }
    return out;
}

function isCjkLang(lang) {
    var l = normLang(lang);
    return /^(zh|ja|ko)\b/i.test(l);
}

/**
 * resolveEmphasis — the emphasis face for ONE script sub-run of a translator
 * annotation, from the paragraph body key.
 *
 * @param {Object} o
 *   config     brand config (finalized)
 *   relations  resolveRelations(config) result
 *   body       {font, weight}  upright body key from the source snapshot
 *   srcLang, dstLang
 *   script     "latin" | "cjk"   script of the sub-run's characters
 *   kind       "bold" (batch 1)
 * @returns {{ outcome:string, family?:string, weight?:string, from?:string, to?:string, reason?:string }}
 *   outcome ∈ relation | no_relation | projection_conflict | projection_unmapped | body_key_unavailable
 */
function resolveEmphasis(o) {
    var config = o && o.config;
    var rel = o && o.relations;
    var kind = (o && o.kind) || "bold";
    // #ac-emphasis-relations R-5 K7 / OD-E13 (italic phase): the start can be given
    // instead of the body — `startPairings` (the pairing bold arrived at) or
    // `startMember` (the fallback-Bold card / the carried weight's card: tried in its
    // own language first, then in any language).
    var explicitStart = !!(o && (Array.isArray(o.startPairings) || o.startMember));
    if (!explicitStart && (!o || !o.body || !o.body.font || !o.body.weight)) return { outcome: "body_key_unavailable", reason: "no body key in the source snapshot" };
    if (!config || !Array.isArray(config.pairs) || !rel) return { outcome: "no_relation", reason: "no brand config pairs" };
    var srcLang = normLang(o.srcLang), dstLang = normLang(o.dstLang);
    var starts, startLabel;
    if (Array.isArray(o.startPairings)) {
        starts = o.startPairings.slice();
        startLabel = "start pairing";
    } else if (o.startMember) {
        var sm = o.startMember;
        starts = sm.lang ? pairingsContaining(config, sm) : [];
        if (!starts.length) {
            for (var ap = 0; ap < config.pairs.length; ap++) {
                var pp = config.pairs[ap];
                if (!pp || !Array.isArray(pp.members)) continue;
                for (var am = 0; am < pp.members.length; am++) {
                    var pmm = pp.members[am];
                    if (foldFamily(pmm.font) === foldFamily(sm.font) && foldWeight(pmm.weight) === foldWeight(sm.weight)) { starts.push(ap); break; }
                }
            }
        }
        startLabel = describeMember(sm);
    } else {
        var bodyMember = { lang: srcLang, font: o.body.font, weight: o.body.weight };
        starts = pairingsContaining(config, bodyMember);
        startLabel = "body " + describeMember(bodyMember);
    }
    if (!starts.length) return { outcome: "no_relation", reason: startLabel + " is in no pairing" };
    var keepFamily = (o.latinFamily) || (o.body && o.body.font) || null;
    var IXr = require("./italic_copies.js"), ckr = IXr.checkCopies(config);

    // Latin characters inside a CJK target keep the source family (only CJK is re-fonted).
    var keepSourceFamily = (o.script === "latin" && isCjkLang(dstLang));
    var results = [];
    for (var s = 0; s < starts.length; s++) {
        var toIdx = rel[kind] ? rel[kind][starts[s]] : undefined;
        if (toIdx === undefined) continue;
        // only start pairings that project to the landing language count (spec N5):
        // a pairing with no member in dstLang does not govern this paragraph's body.
        if (!FMP.effectiveTargetWeight(config.pairs[starts[s]], dstLang, config)) continue;
        var toPair = config.pairs[toIdx];
        var r = null;
        if (keepSourceFamily) {
            var bodyFam = foldFamily(keepFamily);
            var pick = null;
            for (var m = 0; m < toPair.members.length; m++) {
                var mm = toPair.members[m];
                if (foldFamily(mm.font) !== bodyFam) continue;
                if (IXr.memberFace(ckr, mm.lang, mm) === null) continue;   // invalid copy: no member (K17)
                if (!pick || (normLang(mm.lang) === srcLang && normLang(pick.lang) !== srcLang)) pick = mm;
            }
            if (!pick) { results.push({ unmapped: true, from: starts[s], to: toIdx }); continue; }
            var pf = IXr.memberFace(ckr, pick.lang, pick);
            r = { family: keepFamily, weight: pf.weight, from: starts[s], to: toIdx };
            if (pf.copy) { r.copy = true; r.angle = pf.angle; }
        } else {
            var eff = FMP.effectiveTargetWeight(toPair, dstLang, config);
            if (!eff) { results.push({ unmapped: true, from: starts[s], to: toIdx }); continue; }
            r = { family: eff.font, weight: eff.weight, from: starts[s], to: toIdx };
            if (eff.copy) { r.copy = true; r.angle = eff.angle; }
        }
        results.push(r);
    }
    var landed = results.filter(function (x) { return !x.unmapped; });
    if (!results.length) return { outcome: "no_relation", reason: "no " + kind + " relation from " + starts.map(function (i) { return pairingLabel(config, i, srcLang); }).join(", ") };
    if (!landed.length) {
        return { outcome: "projection_unmapped", reason: "target pairing " + pairingLabel(config, results[0].to, srcLang) + " has no member for this text" };
    }
    for (var q = 1; q < landed.length; q++) {
        if (foldFamily(landed[q].family) !== foldFamily(landed[0].family) || foldWeight(landed[q].weight) !== foldWeight(landed[0].weight)
            || !!landed[q].copy !== !!landed[0].copy || (landed[q].copy && landed[q].angle !== landed[0].angle)) {
            return { outcome: "projection_conflict", reason: "start pairings disagree: "
                + landed.map(function (x) { return x.family + " " + x.weight + (x.copy ? " +" + x.angle + "°" : ""); }).join(" vs ") };
        }
    }
    var outR = { outcome: "relation", family: landed[0].family, weight: landed[0].weight,
        from: pairingLabel(config, landed[0].from, srcLang), to: pairingLabel(config, landed[0].to, srcLang),
        fromIdx: landed[0].from, toIdx: landed[0].to };
    // italic realization (I-5): a copy member = its upright copy_of + skew; else the real face
    if (kind === "italic") { outR.realization = landed[0].copy ? "faux" : "real"; if (landed[0].copy) outR.angle = landed[0].angle; }
    return outR;
}

/**
 * carriedEmphasisWeight — the ONE rule for the weight of emphasis carried over
 * from the original (emphasis weight has a single rule, owned here).
 *
 * owner 2026-10-01 (app-folio design-intent §8, acca722): FOLLOW THE SOURCE. The
 * piece keeps its source weight (Latin unchanged; CJK = pairing(source weight)) —
 * ⛔ no raise. The 2026-09-30 default "heavier than the body ⇒ at least Medium" is
 * WITHDRAWN. Instead a LOW-CONTRAST pair is flagged for owner to choose between
 * "follow the source" and "brand bump to Medium" (shared contract with importfix,
 * word for word):
 *   trigger: rank(piece) > rank(body) AND rank(piece) < rank("Medium") (500)
 *   e.g. Light body + Regular piece ⇒ flagged; Light body + Medium piece ⇒ not.
 * A piece whose style is ONLY an italic token ("Italic") carries no weight intent
 * and is never flagged. Italic tokens are kept on the returned weight.
 *
 * @param {string} srcWeight   the piece's source style ("Regular", "Bold Italic")
 * @param {string} bodyWeight  the paragraph body's source style
 * @param {function} rank      weight → numeric rank (style_sheet_builder._rankWeight)
 * @returns {{weight:string, lowContrast:boolean, pieceWeight?:string, bodyWeight?:string}}
 *   weight is ALWAYS the source weight.
 */
var BRAND_BUMP_WEIGHT = "Medium";
function carriedEmphasisWeight(srcWeight, bodyWeight, rank) {
    var src = String(srcWeight || "");
    var w = src.replace(/\s*\b(?:italic|oblique)\b\s*/ig, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!w || typeof rank !== "function") return { weight: src, lowContrast: false };
    var b = String(bodyWeight || "").replace(/\s*\b(?:italic|oblique)\b\s*/ig, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "") || "Regular";
    var low = rank(w) > rank(b) && rank(w) < rank(BRAND_BUMP_WEIGHT);
    return low ? { weight: src, lowContrast: true, pieceWeight: w, bodyWeight: b } : { weight: src, lowContrast: false };
}

/**
 * summarizeMissingPairs — owner 2026-10-01 B1 (design-intent §8): when the config has
 * no pairing for a source font, emphasis falls back to the source weight's name BUT
 * every such case is listed ("配置缺配对：<字体>") so owner can add the pairing. ⛔ The
 * pipeline never edits the config. Dedups the raw sink entries by
 * (reason, srcFont, srcWeight, cjkFamily) with a count, in first-seen order.
 * @param list [{ reason: "no_pair"|"no_config", srcFont, srcWeight, cjkFamily, tid? }]
 */
function summarizeMissingPairs(list) {
    var out = [], at = {};
    (Array.isArray(list) ? list : []).forEach(function (e) {
        if (!e) return;
        var k = [e.reason, e.srcFont, e.srcWeight, e.cjkFamily, e.dstWeight, e.bodyWeight].join("|");
        if (at[k] === undefined) {
            at[k] = out.length;
            var row0 = { reason: e.reason, srcFont: e.srcFont || null, srcWeight: e.srcWeight || null,
                cjkFamily: e.cjkFamily || null, count: 0, tids: [] };
            // reason "lighter_than_body" (§1 conflict, arch 2026-10-01) carries both weights
            if (e.dstWeight) row0.dstWeight = e.dstWeight;
            if (e.bodyWeight) row0.bodyWeight = e.bodyWeight;
            out.push(row0);
        }
        var row = out[at[k]];
        row.count++;
        if (e.tid && row.tids.indexOf(e.tid) < 0 && row.tids.length < 20) row.tids.push(e.tid);
    });
    return out;
}

module.exports = {
    summarizeMissingPairs: summarizeMissingPairs,
    resolveRelations: resolveRelations,
    resolveEmphasis: resolveEmphasis,
    carriedEmphasisWeight: carriedEmphasisWeight,
    // exported for tests / the host landing
    _internal: {
        foldWeight: foldWeight, foldFamily: foldFamily, canonMember: canonMember,
        sameMember: sameMember, isItalicMember: isItalicMember, pairingKind: pairingKind,
        pairingsContaining: pairingsContaining, isCjkLang: isCjkLang
    }
};
