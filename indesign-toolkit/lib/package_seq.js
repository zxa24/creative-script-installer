"use strict";

/**
 * lib/package_seq.js — translation-package sequence prefix ("V01D_" / "V02T_").
 *
 * owner 2026-09-25 (task_plan.md#pkg-seq-prefix): every export — InDesign or
 * webapp — carries ONE shared, increasing number plus a role letter:
 *   D = designer export (InDesign), T = translator export (webapp).
 * A normal round trip reads V01D → V02T → V03D → V04T; all packages of a
 * project can live in one folder and sort by name = sort by time.
 * Interim design: the number lives ONLY in file / folder names (Phase 10
 * `versions/` will later become the source; the prefix format stays).
 *
 * Pure functions, no host / fs. The webapp keeps a byte-for-byte twin of
 * parseSeq / parseRole / formatPrefix / stripSeq / packageStem
 * (app-folio lib/package_seq.js) — change both together.
 */

// V<digits>, optional role letter, underscore. The role is optional only so a
// hand-renamed "V03_" still counts; every exporter writes a role.
var PREFIX_RE = /^V(\d+)([DT])?_/;
// Timestamp tails the two exporters append: _translation_package_YYYYMMDD_HHMMSS
// (InDesign) and _translated_YYYYMMDD_HHMMSS (webapp). Stripped repeatedly so a
// name that went through several round trips reduces to the document stem.
var TAIL_RE = /_(?:translation_package|translated)_\d{8}_\d{6}$/;

function _lastSegment(name) {
    var s = String(name);
    var cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return cut >= 0 ? s.substring(cut + 1) : s;
}

// "V03D_foo" → 3; no prefix → null. Accepts full paths (uses the last segment).
function parseSeq(name) {
    if (name == null) return null;
    var m = PREFIX_RE.exec(_lastSegment(name));
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isFinite(n) ? n : null;
}

// "V03D_foo" → "D"; "V03_foo" / no prefix → null.
function parseRole(name) {
    if (name == null) return null;
    var m = PREFIX_RE.exec(_lastSegment(name));
    return (m && m[2]) ? m[2] : null;
}

// (1, "D") → "V01D_", (12, "T") → "V12T_", (123, "D") → "V123D_".
function formatPrefix(n, role) {
    var k = Math.max(1, Math.floor(Number(n) || 0));
    var r = (role === "D" || role === "T") ? role : "";
    return "V" + (k < 10 ? "0" + k : String(k)) + r + "_";
}

// Remove one leading prefix.
function stripSeq(name) {
    return String(name == null ? "" : name).replace(PREFIX_RE, "");
}

// "V01D_Doc_translation_package_20260925_133248_translated_20260925_141345.zip" → "Doc"
function packageStem(name) {
    var s = stripSeq(_lastSegment(name == null ? "" : name).replace(/\.zip$/i, ""));
    var prev;
    do { prev = s; s = s.replace(TAIL_RE, ""); } while (s !== prev);
    return s || "package";
}

// Highest number among packages of THIS document (both roles) in `names`.
// A name counts only if it has a prefix AND a recognisable exporter tail AND its
// stem equals `stem` exactly (so "A" never picks up "A_B"'s packages).
function maxSeqForStem(names, stem) {
    var best = 0;
    for (var i = 0; i < (names || []).length; i++) {
        var nm = String(names[i]);
        var n = parseSeq(nm);
        if (n == null) continue;
        var bare = stripSeq(_lastSegment(nm)).replace(/\.zip$/i, "");
        if (!TAIL_RE.test(bare)) continue;
        if (packageStem(nm) !== String(stem)) continue;
        if (n > best) best = n;
    }
    return best;
}

// Next number = max(all known) + 1; unknown / none → 1.
function nextSeq(candidates) {
    var best = 0;
    for (var i = 0; i < (candidates || []).length; i++) {
        var n = Number(candidates[i]);
        if (isFinite(n) && n > best) best = Math.floor(n);
    }
    return best + 1;
}

// ── TODO #122 (owner 2026-09-29): same side re-exports keep the number, a side
// switch adds one. owner 2026-10-22 「编号仅在导出方变更时增加，其余的不变」: the
// "most recent" package is THIS document's (and this target language's) — the
// 2026-09-29 batch alignment is withdrawn; a new document in a folder whose other
// documents are at V03 starts at V01. Issued packages are never renamed. ──
//
// The most recent known package = highest seq; equal seq → latest time.
// known: [{ seq: n, role: "D"|"T"|null, time: "YYYYMMDD_HHMMSS"|"" }]
function pickLatest(known) {
    var best = null;
    for (var i = 0; i < (known || []).length; i++) {
        var k = known[i];
        if (!k || !(Number(k.seq) >= 1)) continue;
        if (!best || k.seq > best.seq || (k.seq === best.seq && String(k.time || "") > String(best.time || ""))) best = k;
    }
    return best;
}

// Rule: latest.role === role ⇒ same number; otherwise +1; nothing known ⇒ 1.
// A latest package whose role is unknown (hand-renamed "V03_", an old label
// without a role) counts as the OTHER side — the pre-#122 behaviour (+1) — until
// the owner rules otherwise (TODO #122 open item e4).
function nextForRole(latest, role) {
    if (!latest || !(Number(latest.seq) >= 1)) return 1;
    return Number(latest.seq) + (latest.role === role ? 0 : 1);
}

// Document identity: the import writes "<doc>.translated.indd",
// whose exports are named "<doc>.translated_translation_package_…" — the same
// document as "<doc>.indd" (Client-A DocX-1, 2026-09-29).
function docIdentity(stem) {
    return String(stem == null ? "" : stem).replace(/\.translated$/i, "");
}

// Last exporter timestamp in a name ("…_20260925_121208[.zip]") or "".
function _lastTimestamp(name) {
    var m = /_(\d{8}_\d{6})(?:\.zip)?$/i.exec(String(name));
    return m ? m[1] : "";
}

// #ac-ai-prefill names its packages "<doc>_SC" / "<doc>_TC" (one package per
// language). Such a stem is <doc>'s, in that language group — unless the folder
// holds a document whose own name is "<doc>_TC" (then they are that document's).
var TOKEN_STEM_RE = /^(.*)_(SC|TC)$/;

// null = not this document's; { token: null | "SC" | "TC" } = this document's.
function matchDocument(stem, doc, folderDocs) {
    var id = docIdentity(stem), want = docIdentity(doc);
    if (id === want) return { token: null };
    var m = TOKEN_STEM_RE.exec(String(stem == null ? "" : stem));
    if (!m || docIdentity(m[1]) !== want) return null;
    for (var i = 0; i < (folderDocs || []).length; i++) if (docIdentity(folderDocs[i]) === id) return null;
    return { token: m[2] };
}

// Known packages of ONE document from package file names.
//   doc — this document's stem ("<doc>.translated" is the same document)
//   opts.folderDocs — the .indd stems next to it (only to keep "<doc>_TC.indd"'s
//     packages its own)
//   opts.unprefixed — a name WITHOUT a V prefix (owner 2026-09-29 = P2 "tail"):
//     "tail" (default) role from the last exporter tail (_translated_ ⇒ T, else
//     D), round inferred by inferRounds; "ignore" skips them.
// Only .zip files count — owner: unzipped folders are not packages (the
// import_* folders keep the DESIGNER package's name while holding a translator
// return). Only names with a recognisable exporter tail count. A name carrying a
// language token gets lang = the token ("SC" / "TC"); the zip's own
// _package_seq.json, when the caller reads it, overrides.
function knownFromNames(names, doc, opts) {
    var mode = (opts && opts.unprefixed) || "tail";
    var folderDocs = (opts && opts.folderDocs) || [];
    var out = [];
    for (var i = 0; i < (names || []).length; i++) {
        var nm = String(names[i]);
        if (!/\.zip$/i.test(nm)) continue;
        var bare = stripSeq(_lastSegment(nm)).replace(/\.zip$/i, "");
        if (!TAIL_RE.test(bare)) continue;
        var hit = matchDocument(packageStem(nm), doc, folderDocs);
        if (!hit) continue;
        var seq = parseSeq(nm);
        if (seq == null && mode !== "tail") continue;
        var role = parseRole(nm);
        if (seq == null) role = /_translated_\d{8}_\d{6}$/.test(bare) ? "T" : "D";
        var k = { seq: seq, role: role, time: _lastTimestamp(nm), name: nm, prefixed: seq != null };
        if (hit.token) k.lang = hit.token;
        out.push(k);
    }
    if (mode === "tail") inferRounds(out);
    return out;
}

// P2 round inference for un-prefixed packages: walk in time order; a prefixed
// package sets the running round; an un-prefixed one takes the running round,
// +1 when its role differs from the previous package's (first one = round 1).
// Mutates the entries' seq. (Offered to the owner as P2 — not the default.)
function inferRounds(known) {
    var list = (known || []).slice().sort(function (a, b) {
        return String(a.time || "") < String(b.time || "") ? -1 : (String(a.time || "") > String(b.time || "") ? 1 : 0);
    });
    var cur = 0, prevRole = null;
    for (var i = 0; i < list.length; i++) {
        var k = list[i];
        if (k.seq != null) { cur = k.seq; prevRole = k.role; continue; }
        cur = (cur === 0) ? 1 : cur + (k.role === prevRole ? 0 : 1);
        // a nested old name carries its own history ("…_translation_package_<ts>
        // _translated_<ts>" = D then T = round 2) — never below that, so the
        // webapp and InDesign read the same name the same way
        var own = roundsFromLegacyName(k.name);
        if (own && own.seq > cur) cur = own.seq;
        k.seq = cur; prevRole = k.role;
    }
    return known;
}

// Twin of the webapp's reading of ONE old un-prefixed name (owner P2): its
// exporter tails are its history, oldest first; the round goes up each time the
// side changes. "Doc_translation_package_…" → {1, D};
// "Doc_translation_package_…_translated_…" → {2, T}. No tail → null.
function roundsFromLegacyName(name) {
    var s = stripSeq(_lastSegment(name == null ? "" : name).replace(/\.zip$/i, ""));
    var roles = [];
    var m;
    while ((m = /_(translation_package|translated)_\d{8}_\d{6}$/.exec(s))) {
        roles.unshift(m[1] === "translated" ? "T" : "D");
        s = s.substring(0, m.index);
    }
    if (!roles.length) return null;
    var seq = 1;
    for (var i = 1; i < roles.length; i++) if (roles[i] !== roles[i - 1]) seq++;
    return { seq: seq, role: roles[roles.length - 1], time: "" };
}

// ── per-language sequences (owner 2026-09-29: one sequence per target language)
// 港台不分 (#ac-ai-prefill P1=B, the package-name token rule): Traditional
// Chinese for Hong Kong / Taiwan / Macau is ONE sequence "TC", Simplified is
// "SC"; other languages compare case-insensitively as written. "" = unknown
// (bare "zh" included: the script cannot be read).
function langGroup(lang) {
    var l = String(lang == null ? "" : lang).replace(/^\s+|\s+$/g, "").toLowerCase().replace(/_/g, "-");
    if (l === "tc" || /^zh-(hant|tw|hk|mo)(-|$)/.test(l)) return "TC";
    if (l === "sc" || /^zh-(hans|cn|sg)(-|$)/.test(l)) return "SC";
    return l === "zh" ? "" : l;
}

// A package whose language is unknown (old package, no sidecar) counts for
// EVERY language — so a number never goes backwards because a language could
// not be read.
function forLanguage(known, lang) {
    var want = langGroup(lang);
    return (known || []).filter(function (k) { var g = langGroup(k.lang); return !g || !want || g === want; });
}

// An old import label carries only {seq}: owner — a LOWER BOUND; the role
// comes from the folder scan. A label WITH a role is an ordinary known package.
function applyLabelFloor(latest, label) {
    if (!label || !(Number(label.seq) >= 1)) return latest;
    if (label.role === "D" || label.role === "T") {
        return pickLatest([latest, { seq: Number(label.seq), role: label.role, time: String(label.time || "") }].filter(Boolean));
    }
    if (!latest) return { seq: Number(label.seq), role: null, time: "" };
    if (Number(label.seq) > latest.seq) return { seq: Number(label.seq), role: latest.role, time: latest.time };
    return latest;
}

// The whole decision in one place: known packages of THIS document → this
// language's sequence → optional label floor (a label of ANOTHER language group
// is ignored) → rule ①/②. Returns { seq, latest } for the log line.
function decideSeq(o) {
    o = o || {};
    var lang = o.targetLanguage || "";
    var latest = pickLatest(forLanguage(o.known || [], lang));
    var label = o.label;
    if (label && langGroup(label.lang) && langGroup(lang) && langGroup(label.lang) !== langGroup(lang)) label = null;
    latest = applyLabelFloor(latest, label);
    return { seq: nextForRole(latest, o.role), latest: latest };
}

// ── in-package record (arch 2026-09-29 = M2: its own file, NOT in the frozen
// _meta.json schema). Written by BOTH exporters; the webapp reads it (W1) and
// the importer copies it into the document label. The round lives ONLY here —
// versions/manifest.json records content snapshots and carries no round.
var SIDECAR_NAME = "_package_seq.json";

function buildSidecar(o) {
    o = o || {};
    return {
        schema: "package_seq/1",
        seq: Math.max(1, Math.floor(Number(o.seq) || 1)),
        role: (o.role === "D" || o.role === "T") ? o.role : null,
        target_language: o.targetLanguage ? String(o.targetLanguage) : null,
        batch: {
            folder: o.batchFolder ? String(o.batchFolder) : null,
            documents: (o.batchDocs || []).map(docIdentity).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).sort()
        },
        exported_at: o.exportedAt ? String(o.exportedAt) : null,
        exported_by: o.tool ? String(o.tool) : null
    };
}

// UTF-8 bytes → string without TextDecoder: UXP has none (storage_uxp.js:93;
// host 2026-09-29 — `new TextDecoder` threw inside the export's scan and the
// catch reported the folder as "absent"). Malformed bytes → U+FFFD.
function utf8ToString(u8) {
    var out = "", i = 0, n = u8.length;
    while (i < n) {
        var c = u8[i++], cp;
        if (c < 0x80) cp = c;
        else if (c >= 0xC2 && c < 0xE0 && i < n) cp = ((c & 0x1F) << 6) | (u8[i++] & 0x3F);
        else if (c >= 0xE0 && c < 0xF0 && i + 1 < n) { cp = ((c & 0x0F) << 12) | ((u8[i] & 0x3F) << 6) | (u8[i + 1] & 0x3F); i += 2; }
        else if (c >= 0xF0 && c < 0xF5 && i + 2 < n) { cp = ((c & 0x07) << 18) | ((u8[i] & 0x3F) << 12) | ((u8[i + 1] & 0x3F) << 6) | (u8[i + 2] & 0x3F); i += 3; }
        else cp = 0xFFFD;
        if (cp > 0xFFFF) { cp -= 0x10000; out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); }
        else out += String.fromCharCode(cp);
    }
    return out;
}

// null when absent / unreadable / not ours — callers then fall back to names.
// Accepts a string, an object, or raw UTF-8 bytes (Uint8Array / Array).
function parseSidecar(text) {
    var o;
    if (text && typeof text === "object" && typeof text.length === "number" && typeof text !== "string") {
        text = utf8ToString(text);
    }
    try { o = (typeof text === "string") ? JSON.parse(text) : text; } catch (e) { return null; }
    if (!o || o.schema !== "package_seq/1" || !(Number(o.seq) >= 1)) return null;
    return {
        seq: Math.floor(Number(o.seq)),
        role: (o.role === "D" || o.role === "T") ? o.role : null,
        lang: o.target_language ? String(o.target_language) : null,
        // same shape as a name timestamp so pickLatest's tie-break compares like with like
        time: (function () {
            var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(o.exported_at || ""));
            return m ? (m[1] + m[2] + m[3] + "_" + m[4] + m[5] + m[6]) : "";
        })()
    };
}

module.exports = {
    SIDECAR_NAME: SIDECAR_NAME,
    buildSidecar: buildSidecar,
    parseSidecar: parseSidecar,
    utf8ToString: utf8ToString,
    forLanguage: forLanguage,
    langGroup: langGroup,
    matchDocument: matchDocument,
    decideSeq: decideSeq,
    applyLabelFloor: applyLabelFloor,
    pickLatest: pickLatest,
    nextForRole: nextForRole,
    docIdentity: docIdentity,
    knownFromNames: knownFromNames,
    inferRounds: inferRounds,
    roundsFromLegacyName: roundsFromLegacyName,
    PREFIX_RE: PREFIX_RE,
    TAIL_RE: TAIL_RE,
    parseSeq: parseSeq,
    parseRole: parseRole,
    formatPrefix: formatPrefix,
    stripSeq: stripSeq,
    packageStem: packageStem,
    maxSeqForStem: maxSeqForStem,
    nextSeq: nextSeq,
    LABEL_KEY: "package_seq_v1",
    ROLE_DESIGNER: "D",
    ROLE_TRANSLATOR: "T"
};
