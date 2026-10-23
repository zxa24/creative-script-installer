"use strict";

/**
 * lib/emphasis_relations_panel.js — the font panel's card-to-card emphasis
 * relations (task_plan §7.6 #ac-emphasis-relations R-6 / AC⑧, batch 3). Pure.
 *
 * Session shape (on panelData):
 *   emphasisRelations:       [{ id, from: <pairing id>, to: <pairing id>, origin?, raw?, touched }]
 *   emphasisRelationOrphans: [{ raw, index, reason }]   // entries that resolved to 0 / ≥2 pairings
 * Pairing ids are the panel's (positional 'P_<i>' on load, uid for new ones);
 * the config has no pairing identity, so a relation end is written as a MEMBER of
 * the pairing (data model "配对引用").
 *
 * Export rule (K9): an untouched relation whose original entry still resolves to
 * the same two pairings is written back verbatim; anything drawn / touched this
 * session — or whose original reference no longer resolves uniquely — is written
 * with each pairing's FIRST UNIQUE member (in members[] order: a member in no
 * other pairing). A pairing with no unique member cannot be referenced ⇒ the
 * relation is NOT written and is returned in `unresolvable` (the panel marks the
 * line red and the Done report lists it — never a reference that silently
 * becomes an orphan next time).
 *
 * Bold vs italic is never stored: a relation into an all-italic pairing is an
 * italic relation, into an all-upright one a bold relation (OD-E2c = 1).
 */

var ER = require("./emphasis_relations.js");

function _pairIdx(pairingIds, pid) {
    for (var i = 0; i < pairingIds.length; i++) if (pairingIds[i] === pid) return i;
    return -1;
}

function _triple(m) { return { lang: m.lang, font: m.font, weight: m.weight }; }

// First member of pairs[idx] that belongs to no other pairing, or null.
function uniqueMember(config, idx) {
    var p = config && Array.isArray(config.pairs) ? config.pairs[idx] : null;
    if (!p || !Array.isArray(p.members)) return null;
    for (var i = 0; i < p.members.length; i++) {
        var hits = ER._internal.pairingsContaining(config, p.members[i]);
        if (hits.length === 1 && hits[0] === idx) return _triple(p.members[i]);
    }
    return null;
}

/** Load: config.emphasis_relations → session relations + orphans. */
function fromConfig(config) {
    var out = { relations: [], orphans: [], present: false };
    if (!config || config.emphasis_relations === undefined) return out;
    out.present = true;
    var rels = Array.isArray(config.emphasis_relations) ? config.emphasis_relations : [];
    for (var i = 0; i < rels.length; i++) {
        var r = rels[i];
        if (!r || !r.from || !r.to) { out.orphans.push({ raw: r, index: i, reason: "missing from / to" }); continue; }
        var f = ER._internal.pairingsContaining(config, r.from);
        var t = ER._internal.pairingsContaining(config, r.to);
        if (f.length !== 1 || t.length !== 1) {
            out.orphans.push({ raw: r, index: i,
                reason: "resolves to " + f.length + " / " + t.length + " pairings" });
            continue;
        }
        var rel = { id: "R_" + i, from: "P_" + f[0], to: "P_" + t[0], raw: JSON.parse(JSON.stringify(r)), touched: false };
        if (r.origin !== undefined) rel.origin = r.origin;
        out.relations.push(rel);
    }
    return out;
}

/**
 * Export: session relations → config.emphasis_relations entries.
 * @param config      the config panelDataToConfig just built (pairs index-aligned with pairingIds)
 * @param pairingIds  panel pairing ids in the same order
 * @returns {{ list: Array, unresolvable: Array<{id, from, to, reason}> }}
 */
function toConfig(relations, orphans, config, pairingIds) {
    var list = [], unresolvable = [];
    (relations || []).forEach(function (rel) {
        var fi = _pairIdx(pairingIds, rel.from), ti = _pairIdx(pairingIds, rel.to);
        if (fi < 0 || ti < 0) return;   // its pairing was deleted — the relation went with it
        if (!rel.touched && rel.raw) {
            var f = ER._internal.pairingsContaining(config, rel.raw.from);
            var t = ER._internal.pairingsContaining(config, rel.raw.to);
            if (f.length === 1 && t.length === 1 && f[0] === fi && t[0] === ti) { list.push(rel.raw); return; }
        }
        var uf = uniqueMember(config, fi), ut = uniqueMember(config, ti);
        if (!uf || !ut) {
            unresolvable.push({ id: rel.id, from: rel.from, to: rel.to,
                reason: (!uf ? "source" : "target") + " card has no member that is in no other card" });
            return;
        }
        var e = { from: uf, to: ut };
        if (rel.origin !== undefined) e.origin = rel.origin;
        list.push(e);
    });
    (orphans || []).forEach(function (o) { list.push(o.raw); });
    return { list: list, unresolvable: unresolvable };
}

function _kindOf(config, idx) {
    return ER._internal.pairingKind(config.pairs[idx]);   // "upright" | "italic" | "mixed" | "empty"
}

/**
 * May the operator draw fromPid → toPid? (R-6: refuse with a reason, never guess.)
 * @returns {{ ok:boolean, kind?:"bold"|"italic", reason?:string, warning?:string }}
 */
function checkNewRelation(config, pairingIds, relations, fromPid, toPid) {
    var fi = _pairIdx(pairingIds, fromPid), ti = _pairIdx(pairingIds, toPid);
    if (fi < 0 || ti < 0) return { ok: false, reason: "card not found" };
    if (fi === ti) return { ok: false, reason: "a card cannot point to itself" };
    var tk = _kindOf(config, ti);
    if (tk === "mixed") return { ok: false, reason: "the target card mixes italic and upright weights: it cannot say which it is" };
    if (tk === "empty") return { ok: false, reason: "the target card has no weights" };
    if (!uniqueMember(config, fi)) return { ok: false, reason: "every weight on this card is also on another card, so the line could not be saved" };
    if (!uniqueMember(config, ti)) return { ok: false, reason: "every weight on the target card is also on another card, so the line could not be saved" };
    var kind = tk === "italic" ? "italic" : "bold";
    for (var i = 0; i < (relations || []).length; i++) {
        var r = relations[i];
        if (r.from !== fromPid) continue;
        var ri = _pairIdx(pairingIds, r.to);
        if (ri < 0) continue;
        var rk = _kindOf(config, ri) === "italic" ? "italic" : "bold";
        if (rk === kind) return { ok: false, reason: "this card already has a" + (kind === "italic" ? "n italic" : " bold") + " line: delete the old one first" };
    }
    var out = { ok: true, kind: kind };
    if (_kindOf(config, fi) === "italic") out.warning = "will not take effect: the paragraph body is always upright";
    return out;
}

/**
 * Per-line status for drawing: kind, red (and why), standing note.
 * Red = the line cannot take effect as saved: ≥2 of one kind from a card (all of
 * them), target mixed / empty, or no unique member to write it with.
 */
function lineStatus(config, pairingIds, relations) {
    var out = {};
    var count = {};
    (relations || []).forEach(function (r) {
        var ti = _pairIdx(pairingIds, r.to);
        var k = ti < 0 ? "?" : (_kindOf(config, ti) === "italic" ? "italic" : (_kindOf(config, ti) === "upright" ? "bold" : _kindOf(config, ti)));
        out[r.id] = { kind: k, red: null, note: null };
        var key = r.from + "|" + k;
        count[key] = (count[key] || 0) + 1;
    });
    (relations || []).forEach(function (r) {
        var s = out[r.id], fi = _pairIdx(pairingIds, r.from), ti = _pairIdx(pairingIds, r.to);
        if (fi < 0 || ti < 0) { s.red = "card missing"; return; }
        if (s.kind === "mixed") s.red = "target card mixes italic and upright weights: this line has no effect";
        else if (s.kind === "empty") s.red = "target card has no weights";
        else if (count[r.from + "|" + s.kind] > 1) s.red = "this card has two " + s.kind + " lines: neither takes effect; delete one";
        else if (!uniqueMember(config, fi) || !uniqueMember(config, ti)) s.red = "a card on this line has no weight of its own, so it cannot be saved";
        if (fi >= 0 && _kindOf(config, fi) === "italic") s.note = "will not take effect: the paragraph body is always upright";
        if (r.origin === "migration") s.note = (s.note ? s.note + " · " : "") + "generated from the old italic settings";
    });
    return out;
}

/** A pairing was deleted: its relations go with it; say how many and between which cards. */
function afterPairingDeleted(relations, pid) {
    var kept = [], removed = [];
    (relations || []).forEach(function (r) { (r.from === pid || r.to === pid ? removed : kept).push(r); });
    return { relations: kept, removed: removed };
}

/**
 * Two pairings merged (gonePid folded into keepPid): re-home the relations and
 * say what the merge did (R-6 L8) — self-loops deleted, a card that now has ≥2
 * of one kind (kept, both red), relations whose target became mixed.
 */
function afterPairingsMerged(relations, keepPid, gonePid, mergedConfig, pairingIds) {
    var out = [], selfLoops = [];
    (relations || []).forEach(function (r) {
        var n = JSON.parse(JSON.stringify(r));
        var moved = false;
        if (n.from === gonePid) { n.from = keepPid; moved = true; }
        if (n.to === gonePid) { n.to = keepPid; moved = true; }
        if (moved) n.touched = true;
        if (n.from === n.to) { selfLoops.push(r); return; }
        out.push(n);
    });
    var st = mergedConfig ? lineStatus(mergedConfig, pairingIds, out) : {};
    var duplicate = out.filter(function (r) { return st[r.id] && /two .* lines/.test(st[r.id].red || ""); });
    var mixedTargets = out.filter(function (r) { return r.to === keepPid && st[r.id] && st[r.id].kind === "mixed"; });
    return { relations: out, selfLoops: selfLoops, duplicate: duplicate, mixedTargets: mixedTargets };
}

module.exports = {
    fromConfig: fromConfig,
    toConfig: toConfig,
    checkNewRelation: checkNewRelation,
    lineStatus: lineStatus,
    afterPairingDeleted: afterPairingDeleted,
    afterPairingsMerged: afterPairingsMerged,
    uniqueMember: uniqueMember
};
