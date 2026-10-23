"use strict";

/**
 * lib/italic_migration.js — the ONE-OFF migration of a legacy italic config to the copy
 * model (#ac-emphasis-relations §7.6 I-4, batch 4c). Shared by the import (in memory,
 * OD-E14 = A) and the panel (written on Done) — ⛔ neither side keeps its own copy.
 * Pure: no host, no files, never mutates its input (Node-testable). ES5.
 *
 *   migrateItalicConfig(config, opts) → { config, report }
 *
 * Runs when italic_schema is not 2 (absent / 1 / invalid) — even with nothing to migrate
 * the output carries italic_schema: 2 (in memory; whether it is saved is the caller's
 * call: the panel on Done, the import never). Idempotent: a faux entry already claimed
 * by an existing copy, an existing copy, an already-generated pair / relation are not
 * generated again; a second call returns the same config and "nothing to migrate".
 *
 * Per legacy faux entry `{ font, weight, mode: "faux", angle }`:
 *   • slant token stripped to find the base ("Book Italic" → "Book": the legacy key went
 *     through _normWeight, so it reached the base weight's runs — §7.5 gate #3);
 *   • angle 0 / non-finite ⇒ 15 (what the engine really applied), said in the report;
 *   • every fonts_by_language node with the same lookup key gets a copy
 *     (`<weight> Italic·faux`, copy_of, angle) — the key function is the engine's;
 *   • no node matches ⇒ the entry stays as it is and keeps working (`italic_entry_no_node`,
 *     never dropped);
 *   • `mode: "real"` entries are passed through untouched.
 * Per base (upright) pairing whose members got copies (OD-E10 = A):
 *   • an italic pairing of those copies; each LATIN member without a copy contributes its
 *     real italic face (K11 — from fonts_by_language or opts.findItalicFace); missing ⇒ no
 *     italic pairing and no relation for that card, said;
 *   • the real face already in an italic pairing ⇒ the copies JOIN it (if it has no member
 *     in their language), said — that pairing stays the operator's (no origin);
 *   • a card-to-card italic relation base → italic pairing, by each side's unique member;
 *     not when the base card already has an italic relation, nor without unique members.
 *   Generated pairings / relations carry origin: "migration"; copies carry none.
 * Each card is added on its own and kept only if the config still validates AND every
 * pre-existing relation resolves exactly as before; otherwise that card is rolled back
 * and reported (`migration_skipped`). If the final result still fails validateBrandConfig,
 * the ORIGINAL config is returned with report.fellBack (the import then runs unmigrated,
 * `legacy_italic_config`).
 *
 * opts: resolveInstalledFace(font, weight) → {family, fontStyle} | null (host);
 *       findItalicFace(font, weight) → installed italic style name | null (host);
 *       validate(config) → {ok, errors} (default font_mapping_pairs.validateBrandConfig).
 */

var IC = require("./italic_config.js");
var IX = require("./italic_copies.js");
var ER = require("./emphasis_relations.js");
var ERP = require("./emphasis_relations_panel.js");
function _FMP() { return require("./font_mapping_pairs.js"); }

function _clone(o) { return JSON.parse(JSON.stringify(o)); }
function _stripSlant(w) {
    var s = String(w == null ? "" : w).replace(/\b(?:italic|oblique|ital)\b/ig, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    return s || "Regular";
}
function _sameMember(a, b) { return ER._internal.sameMember(a, b); }

function migrateItalicConfig(config, opts) {
    opts = opts || {};
    var report = { ran: false, copies: [], pairs: [], joined: [], relations: [], skipped: [], noNode: [], angleFixed: [], fellBack: null };
    if (!config || typeof config !== "object") return { config: config, report: report };
    if (Number(config.italic_schema) === 2) { report.reason = "italic_schema 2"; return { config: config, report: report }; }
    var validate = typeof opts.validate === "function" ? opts.validate : function (c) { return _FMP().validateBrandConfig(c); };
    var face = function (font, weight) {
        var r = null;
        if (typeof opts.resolveInstalledFace === "function") { try { r = opts.resolveInstalledFace(font, weight); } catch (e) { r = null; } }
        return (r && r.family) ? { font: String(r.family), weight: String(r.fontStyle == null ? weight : r.fontStyle) } : { font: String(font), weight: String(weight) };
    };
    var out = _clone(config);
    report.ran = true;
    var fbl = out.fonts_by_language = out.fonts_by_language || {};
    var stored = Array.isArray(out.italic_by_weight) ? out.italic_by_weight : [];

    // nodes by the engine's lookup key (config's own fonts_by_language, non-copies)
    var nodesByKey = {};
    Object.keys(fbl).forEach(function (lang) {
        (Array.isArray(fbl[lang]) ? fbl[lang] : []).forEach(function (e) {
            if (!e || e.font == null || IX.isCopy(e)) return;
            var c = _FMP().getCanonical(out, lang, e.font, e.weight), f = face(c.font, c.weight);
            var k = IC.italicLookupKey(f.font, f.weight);
            (nodesByKey[k] = nodesByKey[k] || []).push({ lang: lang, font: e.font, weight: e.weight });
        });
    });
    function copyOf(lang, font, weight) {
        var list = Array.isArray(fbl[lang]) ? fbl[lang] : [];
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (e && IX.isCopy(e) && String(e.font) === String(font) && String(e.copy_of) === String(weight)) return e;
        }
        return null;
    }

    // 1. copies from the legacy faux entries
    var madeFor = {};   // "<lang>|<font>|<weight>" of nodes that got a copy THIS run
    stored.forEach(function (e) {
        if (!e || e.mode !== "faux" || e.font == null) return;
        var a = Number(e.angle);
        // owner 2026-10-03 (option a): 0 / non-finite is not an angle — the copy keeps the 15° the
        // old engine really applied (italic_config.lookup reads 0 as "not set"), and it is listed.
        if (!(isFinite(a) && a !== 0)) { report.angleFixed.push({ entry: e, was: e.angle, now: IC.DEFAULT_FAUX_ANGLE }); a = IC.DEFAULT_FAUX_ANGLE; }
        var f = face(e.font, _stripSlant(e.weight));
        var nodes = nodesByKey[IC.italicLookupKey(f.font, f.weight)];
        if (!nodes || !nodes.length) { report.noNode.push({ code: "italic_entry_no_node", entry: e }); return; }
        nodes.forEach(function (n) {
            if (copyOf(n.lang, n.font, n.weight)) return;   // claimed already (idempotent)
            var cp = { font: n.font, weight: IX.copyWeightFor(n.weight), copy_of: n.weight, angle: a };
            fbl[n.lang].push(cp);
            madeFor[n.lang + "|" + n.font + "|" + n.weight] = true;
            report.copies.push({ lang: n.lang, font: n.font, weight: cp.weight, copy_of: n.weight, angle: a });
        });
    });

    // 2. per base card: italic pairing + relation, each card kept only if it validates
    var before = _relationStatus(config);
    var pairs = out.pairs = Array.isArray(out.pairs) ? out.pairs : [];
    var baseCount = pairs.length;
    for (var pi = 0; pi < baseCount; pi++) {
        var base = pairs[pi];
        if (!base || !Array.isArray(base.members) || ER._internal.pairingKind(base) !== "upright") continue;
        var copyMembers = [], others = [];
        base.members.forEach(function (m) {
            var cp = copyOf(m.lang, m.font, m.weight);
            if (cp && madeFor[m.lang + "|" + m.font + "|" + m.weight]) copyMembers.push({ lang: m.lang, font: m.font, weight: cp.weight });
            else others.push(m);
        });
        if (!copyMembers.length) continue;
        var card = _label(base);
        var snapshot = _clone(out);   // taken AFTER step 1: the copies survive a rollback
        var res = _addCard(out, pi, copyMembers, others, opts, report, card);
        var ok = res.ok;
        var why = res.reason;
        if (ok) {
            var v = validate(out);
            if (!v || !v.ok) { ok = false; why = "validateBrandConfig: " + ((v && v.errors) || []).join("; "); }
        }
        if (ok) {
            var after = _relationStatus(out);
            for (var key in before) if (before[key] !== after[key]) { ok = false; why = "an existing relation would change (" + key + ": " + before[key] + " → " + after[key] + ")"; break; }
        }
        if (!ok) {
            // roll the card back entirely (pairing, joined members, real faces it added,
            // relation); the copies stay — they predate the snapshot, and the source
            // italic keeps working through them
            _restore(out, snapshot);
            fbl = out.fonts_by_language; pairs = out.pairs;
            _dropReportFor(report, card);
            report.skipped.push({ code: "migration_skipped", card: card, reason: why });
        }
    }
    out.italic_schema = 2;
    var fin = validate(out);
    if (!fin || !fin.ok) {
        report.fellBack = { code: "legacy_italic_config", errors: (fin && fin.errors) || [] };
        return { config: config, report: report };
    }
    return { config: out, report: report };
}

// Add one card's italic pairing (new or joined) + relation to `out`. → { ok, reason }
function _addCard(out, pi, copyMembers, others, opts, report, card) {
    var fbl = out.fonts_by_language, pairs = out.pairs;
    // the base card already has an italic relation (drawn / hand-written / invalid or not)
    // ⇒ nothing generated for it: a second italic line would make both invalid. Its copies
    // stay and the source italic works as before.
    var rels0 = Array.isArray(out.emphasis_relations) ? out.emphasis_relations : [];
    for (var q0 = 0; q0 < rels0.length; q0++) {
        var r0 = rels0[q0];
        if (!r0 || !r0.from || !r0.to) continue;
        var f0 = ER._internal.pairingsContaining(out, r0.from), t0 = ER._internal.pairingsContaining(out, r0.to);
        if (f0.indexOf(pi) >= 0 && t0.length && t0.every(function (ti) { return ER._internal.pairingKind(pairs[ti]) === "italic"; })) {
            report.skipped.push({ code: "migration_skipped", card: card, reason: "the card already has an italic relation — no italic line generated (its copies and the source italic still work)" });
            return { ok: true };
        }
    }
    // K11: every LATIN member without a copy needs its real italic face
    var realFaces = [];
    for (var i = 0; i < others.length; i++) {
        var m = others[i];
        if (ER._internal.isCjkLang(m.lang)) continue;
        var w = _realItalicFor(out, m, opts);
        if (!w) return { ok: false, reason: "missing real italic face " + m.font + " " + m.weight + " Italic" };
        realFaces.push({ lang: m.lang, font: m.font, weight: w });
    }
    // an existing italic pairing already holding one of those real faces ⇒ join it
    var target = -1;
    for (var r = 0; r < realFaces.length && target < 0; r++) {
        var hits = ER._internal.pairingsContaining(out, realFaces[r]);
        for (var h = 0; h < hits.length; h++) if (ER._internal.pairingKind(pairs[hits[h]]) === "italic") { target = hits[h]; break; }
    }
    if (target >= 0) {
        var tp = pairs[target];
        var _norm = require("./lang_script_table.js").normalizeBcp47Identity;
        for (var c = 0; c < copyMembers.length; c++) {
            var lang = copyMembers[c].lang, has = false;
            for (var k = 0; k < tp.members.length; k++) if (_norm(tp.members[k].lang) === _norm(lang)) has = true;
            if (has) return { ok: false, reason: "existing italic pairing " + _label(tp) + " already has a " + lang + " member" };
        }
        copyMembers.forEach(function (cm) { tp.members.push(cm); });
        report.joined.push({ card: card, pairing: _label(tp), members: copyMembers });
    } else {
        realFaces.forEach(function (rf) {
            var list = fbl[rf.lang] = fbl[rf.lang] || [];
            var present = false;
            list.forEach(function (e) { if (e && !IX.isCopy(e) && String(e.font) === rf.font && String(e.weight) === rf.weight) present = true; });
            if (!present) list.push({ font: rf.font, weight: rf.weight });
        });
        pairs.push({ members: realFaces.concat(copyMembers), origin: "migration" });
        target = pairs.length - 1;
        report.pairs.push({ card: card, members: realFaces.concat(copyMembers) });
    }
    // the relation base → italic pairing
    var rels = out.emphasis_relations = Array.isArray(out.emphasis_relations) ? out.emphasis_relations : [];
    var from = ERP.uniqueMember(out, pi), to = ERP.uniqueMember(out, target);
    if (!from || !to) return { ok: false, reason: "pairing has no unique member" };
    rels.push({ from: from, to: to, origin: "migration" });
    report.relations.push({ card: card, from: from, to: to });
    return { ok: true };
}

function _realItalicFor(out, m, opts) {
    var base = String(m.weight);
    var names = [base + " Italic"];
    if (/^(regular|roman|normal)$/i.test(base)) names.unshift("Italic");
    var list = (out.fonts_by_language && out.fonts_by_language[m.lang]) || [];
    for (var n = 0; n < names.length; n++)
        for (var i = 0; i < list.length; i++)
            if (list[i] && !IX.isCopy(list[i]) && String(list[i].font) === String(m.font) && String(list[i].weight) === names[n]) return names[n];
    if (typeof opts.findItalicFace === "function") {
        var w = null;
        try { w = opts.findItalicFace(m.font, m.weight); } catch (e) { w = null; }
        if (w) return String(w);
    }
    return null;
}

// per existing relation entry: what it resolves to ("rule:<from>><to>:<kind>" or "issue:<reason>")
function _relationStatus(config) {
    var out = {};
    var rr = ER.resolveRelations(config);
    var rels = Array.isArray(config && config.emphasis_relations) ? config.emphasis_relations : [];
    rels.forEach(function (r, i) {
        if (r && r.origin === "migration") return;
        out[i] = "unresolved";
    });
    (rr.issues || []).forEach(function (is) { if (is.entry !== null && is.entry !== undefined && out[is.entry] !== undefined) out[is.entry] = "issue:" + is.reason; });
    (rr.rules || []).forEach(function (ru) {
        if (out[ru.entry] === undefined) return;
        var r = rels[ru.entry];
        var f = ER._internal.pairingsContaining(config, r.from), t = ER._internal.pairingsContaining(config, r.to);
        out[ru.entry] = "rule:" + f.join(",") + ">" + t.join(",") + ":" + ru.dimension;
    });
    return out;
}

function _restore(target, snap) { for (var k in target) if (Object.prototype.hasOwnProperty.call(target, k)) delete target[k]; for (var s in snap) target[s] = snap[s]; }
function _dropReportFor(report, card) {
    ["pairs", "joined", "relations"].forEach(function (k) { report[k] = report[k].filter(function (x) { return x.card !== card; }); });
}
function _label(pair) {
    return (pair && pair.members || []).map(function (m) { return m.lang + ":" + m.font + " " + m.weight; }).join(" + ");
}

module.exports = { migrateItalicConfig: migrateItalicConfig };
