"use strict";

/**
 * lib/italic_copies.js — italic copies as ordinary weight entries (#ac-emphasis-relations
 * §7.6 I-1 / I-2 / I-4, batch 4b). Pure leaf: no host, no files, never mutates its
 * inputs (Node-testable; the run_uxp_script bundler inlines it). ES5 only.
 *
 * A copy is a fonts_by_language entry
 *     { font: "MHeiHK", weight: "Xbold Italic·faux", copy_of: "Xbold", angle: 12 }
 * addressed like any weight by (lang, font, weight). `copy_of` / `angle` are the HOW
 * (implemented as the upright face `copy_of` + synthetic skew `angle`); they are NOT
 * routing marks — pairing, relations, validation and addressing look only at
 * (lang, font, weight). Only "realise this member as a face" reads them.
 *
 * What lives here:
 *   COPY_SUFFIX / copyWeightFor          the one spelling (conflict table 12 = A)
 *   checkCopies(config, opts)            local validation: invalid copies are listed,
 *                                        never reject the whole config (§7.5 OD-6)
 *   memberFace(checked, lang, member)    the face a pair member realises as (copy ⇒
 *                                        copy_of + angle; invalid copy ⇒ null = skipped)
 *   deriveItalicByWeight(config, opts)   the EFFECTIVE italic_by_weight (I-4): one record
 *                                        per copy, stored entries claimed / kept / dropped,
 *                                        cross-language angle collisions ⇒ no record
 *   buildItalicView(config, records)     the object handed to every `italicConfig` reader
 *                                        (shallow copy, only italic_by_weight replaced)
 */

var IC = require("./italic_config.js");
// font_mapping_pairs requires THIS module for its projections (copy members ⇒ copy_of),
// so it is loaded lazily here to keep the require graph acyclic at load time.
function _canon(config, lang, font, weight) { return require("./font_mapping_pairs.js").getCanonical(config, lang, font, weight); }

var COPY_SUFFIX = " Italic·faux";

function copyWeightFor(baseWeight) { return String(baseWeight) + COPY_SUFFIX; }
function isCopy(e) { return !!(e && e.copy_of !== undefined && e.copy_of !== null); }
function _endsWithSuffix(w) {
    var s = String(w == null ? "" : w);
    return s.length > COPY_SUFFIX.length && s.slice(-COPY_SUFFIX.length) === COPY_SUFFIX;
}
function _addr(lang, font, weight) { return String(lang) + "|" + String(font) + "|" + String(weight); }

/**
 * checkCopies — local validation of every copy-shaped entry (data model "撞名校验" +
 * "局部校验追加"). → { invalid: { "<lang>|<font>|<weight>": reason }, issues: [...] }
 * Reasons: copy_suffix_mismatch · copy_name_without_copy_of · copy_of_not_found ·
 * copy_of_is_copy · copy_angle_invalid · copy_name_is_installed_face.
 * opts.isFaceInstalled(font, weight) → bool (host only; omitted in Node ⇒ not checked).
 */
function checkCopies(config, opts) {
    opts = opts || {};
    var invalid = {}, issues = [];
    var fbl = (config && config.fonts_by_language) || {};
    Object.keys(fbl).forEach(function (lang) {
        var list = Array.isArray(fbl[lang]) ? fbl[lang] : [];
        var byFontWeight = {};
        list.forEach(function (e) { if (e && e.font != null) byFontWeight[String(e.font) + "|" + String(e.weight)] = e; });
        list.forEach(function (e) {
            if (!e || e.font == null) return;
            var reason = null;
            if (!isCopy(e)) {
                if (_endsWithSuffix(e.weight)) reason = "copy_name_without_copy_of";
            } else if (String(e.weight) !== copyWeightFor(e.copy_of)) {
                reason = "copy_suffix_mismatch";
            } else {
                var base = byFontWeight[String(e.font) + "|" + String(e.copy_of)];
                var a = Number(e.angle);
                if (!base) reason = "copy_of_not_found";
                else if (isCopy(base)) reason = "copy_of_is_copy";
                else if (!(isFinite(a) && a !== 0)) reason = "copy_angle_invalid";
                else if (typeof opts.isFaceInstalled === "function" && opts.isFaceInstalled(e.font, e.weight)) reason = "copy_name_is_installed_face";
            }
            if (reason) {
                invalid[_addr(lang, e.font, e.weight)] = reason;
                issues.push({ code: "config_entry_invalid", block: "fonts_by_language", lang: lang, font: e.font, weight: e.weight, reason: reason });
            }
        });
    });
    return { invalid: invalid, issues: issues, _config: config };
}

/**
 * memberFace — the face a fonts_by_language entry / pair member realises as.
 *   plain entry  → { font, weight }
 *   valid copy   → { font, weight: copy_of, angle, copy: true }
 *   invalid copy → null  (K17: "not realised" — neither its own name, RED-LINE, nor its
 *                         copy_of, which is itself untrusted)
 * `checked` = checkCopies(config) result; the member's copy fields are read from the
 * config's own fonts_by_language entry at the same address (pair members only carry
 * (lang, font, weight)).
 */
function memberFace(checked, lang, member) {
    if (!member) return null;
    var font = member.font, weight = member.weight;
    var entry = _findEntry(checked && checked._config, lang, font, weight) || member;
    if (!isCopy(entry)) {
        if (_endsWithSuffix(weight)) return null;   // copy-named but not a copy: never a face
        return { font: font, weight: weight };
    }
    if (checked && checked.invalid && checked.invalid[_addr(lang, font, weight)]) return null;
    return { font: font, weight: String(entry.copy_of), angle: Number(entry.angle), copy: true };
}
function _findEntry(config, lang, font, weight) {
    var list = config && config.fonts_by_language && config.fonts_by_language[lang];
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e && String(e.font) === String(font) && String(e.weight) === String(weight)) return e;
    }
    return null;
}

/**
 * deriveItalicByWeight — the EFFECTIVE italic_by_weight (I-4), from the copies plus the
 * stored entries. Runs on the FINAL config (after migration, 4c).
 * opts.resolveInstalledFace(font, weight) → { family, fontStyle } | null — the SAME
 *   installed-name resolver the pipeline writes with (_resolveInstalledFontName: it can
 *   rewrite BOTH, e.g. Whitney + Book → Whitney Book | Regular, and the apply sites key
 *   on that live face). Host only; omitted ⇒ identity and result.installedNameRewrite
 *   = false, said in the report (data model N6).
 * opts.checked = a prior checkCopies result (else computed here).
 * → { records, issues, installedNameRewrite }
 *   issues: derived_key_angle_conflict · derived_record_mismatch · italic_entry_no_node
 */
function deriveItalicByWeight(config, opts) {
    opts = opts || {};
    var hasInst = typeof opts.resolveInstalledFace === "function";
    function face(font, weight) {
        var r = null;
        if (hasInst) { try { r = opts.resolveInstalledFace(font, weight); } catch (eI) { r = null; } }
        return (r && r.family) ? { font: String(r.family), weight: String(r.fontStyle == null ? weight : r.fontStyle) }
                               : { font: String(font), weight: String(weight) };
    }
    var checked = opts.checked || checkCopies(config, opts);
    var fbl = (config && config.fonts_by_language) || {};
    // invalid copies are reported here too (config_entry_invalid: listed, skipped as members,
    // derive nothing) — the import's only report path for them
    var issues = (checked.issues || []).slice();
    // 1. one candidate per valid copy, grouped by the lookup key (collision = same key)
    var groups = {}, order = [];
    Object.keys(fbl).forEach(function (lang) {
        (Array.isArray(fbl[lang]) ? fbl[lang] : []).forEach(function (e) {
            if (!isCopy(e) || checked.invalid[_addr(lang, e.font, e.weight)]) return;
            var c = _canon(config, lang, e.font, e.copy_of);
            var f = face(c.font, c.weight);
            var key = IC.italicLookupKey(f.font, f.weight);
            if (!groups[key]) { groups[key] = { font: f.font, weight: f.weight, members: [] }; order.push(key); }
            groups[key].members.push({ lang: lang, font: e.font, weight: e.weight, angle: Number(e.angle) });
        });
    });
    var derived = {}, records = [];
    order.forEach(function (key) {
        var g = groups[key], a0 = g.members[0].angle, same = true;
        for (var i = 1; i < g.members.length; i++) if (g.members[i].angle !== a0) same = false;
        if (!same) {
            issues.push({ code: "derived_key_angle_conflict", key: key, font: g.font, weight: g.weight, members: g.members });
            derived[key] = null;   // claimed, but nothing effective (⛔ no first-write-wins)
            return;
        }
        derived[key] = { font: g.font, weight: g.weight, mode: "faux", angle: a0 };
        records.push(derived[key]);
    });
    // 2. the config's own nodes (non-copies; NOT doc fonts merged in by the panel — round-10 P3)
    var nodeKeys = {};
    Object.keys(fbl).forEach(function (lang) {
        (Array.isArray(fbl[lang]) ? fbl[lang] : []).forEach(function (e) {
            if (!e || isCopy(e) || e.font == null) return;
            var c = _canon(config, lang, e.font, e.weight);
            var f = face(c.font, c.weight);
            nodeKeys[IC.italicLookupKey(f.font, f.weight)] = true;
        });
    });
    // 3. stored entries: claimed ⇒ derived wins · unclaimed real ⇒ kept · unclaimed faux ⇒
    //    dropped if a node could carry a copy (schema 2), else kept + italic_entry_no_node
    var stored = Array.isArray(config && config.italic_by_weight) ? config.italic_by_weight : [];
    var storedKeys = {};
    stored.forEach(function (e) {
        if (!e || e.font == null) return;
        var fe = face(e.font, e.weight);
        var key = IC.italicLookupKey(fe.font, fe.weight);
        storedKeys[key] = true;
        if (Object.prototype.hasOwnProperty.call(derived, key)) {
            var d = derived[key];
            if (!d) return;   // angle conflict: the copies own the key, nothing effective
            if (e.mode !== "faux" || Number(e.angle) !== d.angle) {
                issues.push({ code: "derived_record_mismatch", key: key, stored: e, derived: d,
                    note: e.mode === "real" ? "hand-written real replaced by the copy on the same key" : "stored value differs; derived wins" });
            }
            return;
        }
        if (e.mode === "real") { records.push(e); return; }
        if (e.mode === "faux" && Number(config && config.italic_schema) === 2 && nodeKeys[key]) {
            issues.push({ code: "derived_record_mismatch", key: key, stored: e, derived: null, note: "stored faux key not derivable from any copy; dropped" });
            return;
        }
        if (e.mode === "faux" && !nodeKeys[key]) issues.push({ code: "italic_entry_no_node", key: key, entry: e });
        records.push(e);
    });
    // 4. derived but not stored ⇒ effective anyway, said in the report
    records.forEach(function (r) {
        if (r.mode !== "faux" || !groups[IC.italicLookupKey(r.font, r.weight)]) return;
        var k = IC.italicLookupKey(r.font, r.weight);
        if (!storedKeys[k]) issues.push({ code: "derived_record_mismatch", key: k, stored: null, derived: r, note: "the stored config lacks this record" });
    });
    return { records: records, issues: issues, installedNameRewrite: hasInst };
}

/**
 * faceRoster — fonts_by_language entries as REAL faces an operator may pick / a probe may
 * check (CONSUMER-CONTRACT, Hook B roster rule): a copy is offered as its base
 * `{font, weight: copy_of}` (never under the copy name); a copy-named entry without
 * copy_of is dropped; duplicates (a base listed next to its copy) collapse.
 * → [{ font, weight }]
 */
function faceRoster(entries) {
    var out = [], seen = {};
    (Array.isArray(entries) ? entries : []).forEach(function (e) {
        if (!e || !e.font) return;
        var w;
        if (isCopy(e)) w = String(e.copy_of);
        else if (_endsWithSuffix(e.weight)) return;
        else w = e.weight;
        var k = String(e.font) + "\t" + String(w);
        if (seen[k]) return;
        seen[k] = true;
        out.push({ font: e.font, weight: w });
    });
    return out;
}

/** buildItalicView — shallow copy of the final config with italic_by_weight replaced by
 *  the derived records. ⛔ never written back into __brandConfig (it is saved / edited). */
function buildItalicView(config, records) {
    var v = {};
    for (var k in (config || {})) if (Object.prototype.hasOwnProperty.call(config, k)) v[k] = config[k];
    v.italic_by_weight = records || [];
    return v;
}

module.exports = {
    COPY_SUFFIX: COPY_SUFFIX,
    copyWeightFor: copyWeightFor,
    isCopy: isCopy,
    checkCopies: checkCopies,
    memberFace: memberFace,
    faceRoster: faceRoster,
    deriveItalicByWeight: deriveItalicByWeight,
    buildItalicView: buildItalicView
};
