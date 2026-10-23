"use strict";

/**
 * lib/version_carry.js — B2 carry-forward PLAN builder (pure).
 *
 * Charter r1 B2 / contract §1/§6/§7. Given the previous package's file bytes
 * (root-folder stripped) + the current export's tip-version files, produce a
 * write-plan: the flat set of version directories to write + the recomputed
 * manifest. The .idjs executes the plan (zip read / root-strip / fs writes live
 * there; this module is host-free = Node-testable).
 *
 * Invariants enforced here:
 *   §1 FLATTEN — carried versions are copied as SIBLING dirs; a prior package's
 *      whole `versions/` is never nested (no exponential blow-up).
 *   §6 carry-forward — read prev versions/* (or BOOTSTRAP v1 from a no-versions/
 *      package's top-level payload) → append current tip → recompute manifest.
 *   §7 required = segments.json + (translations.json | translations_template.json);
 *      filenames NOT renamed.
 *   AC8 — checkIdentity(current uid/project_id vs prev); mismatch → block carry
 *      (host still exports normally = AC7); missing → surface, proceed.
 */

var VM = require("./version_manifest.js");

var REQUIRED_SEG = "segments.json";
var TRANS_PRIMARY = "translations.json";
var TRANS_TEMPLATE = "translations_template.json";
// Files worth carrying into each version dir (visual-compare fidelity, §7 推荐).
var RECOMMENDED = ["preview.pdf", "tid_map.json"];

// ── utf8 decode (bytes → string) for JSON parse. TextDecoder when present,
//    else a manual BMP+astral decoder. ─────────────────────────────────────
function _utf8Decode(u8) {
    if (typeof TextDecoder !== "undefined") {
        try { return new TextDecoder("utf-8").decode(u8); } catch (e) {}
    }
    var out = "";
    var i = 0, n = u8.length;
    while (i < n) {
        var b = u8[i++];
        if (b < 0x80) { out += String.fromCharCode(b); }
        else if (b >= 0xC0 && b < 0xE0) {
            out += String.fromCharCode(((b & 0x1F) << 6) | (u8[i++] & 0x3F));
        } else if (b >= 0xE0 && b < 0xF0) {
            out += String.fromCharCode(((b & 0x0F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F));
        } else if (b >= 0xF0) {
            var cp = ((b & 0x07) << 18) | ((u8[i++] & 0x3F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F);
            cp -= 0x10000;
            out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        }
    }
    return out;
}

function _parseJsonBytes(bytes) {
    try { return JSON.parse(_utf8Decode(bytes)); } catch (e) { return null; }
}

// pick present translations file in a dir given a prefix ("" = top-level,
// "versions/<vid>/" for a version dir). Returns { name, bytes } | null.
function _presentTranslations(files, prefix) {
    if (files[prefix + TRANS_PRIMARY] != null) return { name: TRANS_PRIMARY, bytes: files[prefix + TRANS_PRIMARY] };
    if (files[prefix + TRANS_TEMPLATE] != null) return { name: TRANS_TEMPLATE, bytes: files[prefix + TRANS_TEMPLATE] };
    return null;
}

// Build a version entry + the file-set for its dir from a flat file map.
// Returns { entry, files } or { error }.
function _entryFromDir(files, prefix, meta) {
    var seg = files[prefix + REQUIRED_SEG];
    if (seg == null) return { error: "missing " + REQUIRED_SEG + " (prefix='" + prefix + "')" };
    var trans = _presentTranslations(files, prefix);
    if (!trans) return { error: "missing translations.json / translations_template.json (prefix='" + prefix + "')" };

    var dirFiles = {};
    dirFiles[REQUIRED_SEG] = seg;
    dirFiles[trans.name] = trans.bytes;
    var payload = [REQUIRED_SEG, trans.name];
    for (var i = 0; i < RECOMMENDED.length; i++) {
        var rn = RECOMMENDED[i];
        if (files[prefix + rn] != null) { dirFiles[rn] = files[prefix + rn]; payload.push(rn); }
    }

    var entry = VM.buildVersionEntry({
        segBytes: seg,
        transBytes: trans.bytes,
        versionId: meta.versionId,
        parent: meta.parent == null ? null : meta.parent,
        projectUid: meta.projectUid,
        projectId: meta.projectId,
        exportedAt: meta.exportedAt,
        payload: payload
    });
    return { entry: entry, files: dirFiles };
}

// group prev "versions/<vid>/<file>" entries → { vids:{vid:{file:bytes}}, manifestBytes, hasVersions }
function _groupPrevVersions(prevFiles) {
    var vids = {}, manifestBytes = null, count = 0;
    for (var key in prevFiles) {
        if (!prevFiles.hasOwnProperty(key)) continue;
        if (key.indexOf("versions/") !== 0) continue;
        var rest = key.slice("versions/".length);
        if (rest === "manifest.json") { manifestBytes = prevFiles[key]; continue; }
        var slash = rest.indexOf("/");
        if (slash < 0) continue;
        var vid = rest.slice(0, slash);
        var fileName = rest.slice(slash + 1);
        if (!fileName) continue;
        if (!vids[vid]) { vids[vid] = {}; count++; }
        vids[vid][fileName] = prevFiles[key];
    }
    return { vids: vids, manifestBytes: manifestBytes, hasVersions: (count > 0 || manifestBytes != null) };
}

// derive a bootstrap version_id from the prev top-level segments.json's
// exported_at_utc (best provenance); fall back to an epoch sentinel (sorts as
// the earliest root, which is correct for a bootstrap v1).
function _bootstrapVersionId(prevFiles) {
    var seg = _parseJsonBytes(prevFiles[REQUIRED_SEG]);
    var iso = seg && seg.document && seg.document.exported_at_utc;
    if (iso) { try { return { id: VM.makeVersionId(iso), iso: String(iso) }; } catch (e) {} }
    return { id: "19700101T000000-000Z", iso: "" };
}

/**
 * planCarryForward(opts) → plan
 *   opts.prevFiles    : { relPath: Uint8Array }  (root folder ALREADY stripped)
 *   opts.currentFiles : { name: Uint8Array }     (current tip dir: segments.json +
 *                        translations(.json|_template) [+ preview.pdf, tid_map.json])
 *   opts.currentMeta  : { versionId, projectUid, projectId, exportedAt }
 *
 * plan = {
 *   ok, block, bootstrap, reason,
 *   warnings: [str],
 *   identity: {...},               // AC8 checkIdentity result (or null)
 *   manifest,                       // recomputed manifest object (when ok && !block)
 *   versionsToWrite: [ { dir, files:{name:bytes} } ]  // carried siblings + current
 * }
 */
function planCarryForward(opts) {
    opts = opts || {};
    var warnings = [];
    var prevFiles = opts.prevFiles || {};
    var currentFiles = opts.currentFiles || {};
    var meta = opts.currentMeta || {};

    var grouped = _groupPrevVersions(prevFiles);
    var priorVersions, priorTipHash, prevManifestForIdentity, carriedDirs = {}, bootstrap;

    if (grouped.hasVersions) {
        bootstrap = false;
        var prevManifest = grouped.manifestBytes ? _parseJsonBytes(grouped.manifestBytes) : null;
        if (!prevManifest || !prevManifest.versions) {
            return { ok: false, block: false, warnings: warnings,
                reason: "previous package has versions/ dirs but manifest.json is missing/unparseable — refusing to guess lineage (must-surface)" };
        }
        var vc = VM.validateChain(prevManifest);
        if (!vc.ok) {
            // Surface but still carry the versions verbatim (don't silently drop history).
            warnings.push("carried manifest failed validation (carrying verbatim, surfacing): " + vc.issues.join("; "));
        }
        priorVersions = prevManifest.versions;
        priorTipHash = prevManifest.tip;
        prevManifestForIdentity = prevManifest;
        carriedDirs = grouped.vids;
    } else {
        bootstrap = true;
        var bid = _bootstrapVersionId(prevFiles);
        var boot = _entryFromDir(prevFiles, "", {
            versionId: bid.id, parent: null, exportedAt: bid.iso,
            projectUid: "", projectId: ""    // unknown for a pre-feature bootstrap pkg
        });
        if (boot.error) {
            return { ok: false, block: false, warnings: warnings,
                reason: "cannot bootstrap from previous package top-level: " + boot.error };
        }
        priorVersions = [boot.entry];
        priorTipHash = boot.entry.content_hash;
        prevManifestForIdentity = { versions: [boot.entry] };
        carriedDirs[bid.id] = boot.files;
    }

    // current tip entry
    var cur = _entryFromDir(currentFiles, "", {
        versionId: meta.versionId, parent: null, exportedAt: meta.exportedAt,
        projectUid: meta.projectUid || "", projectId: meta.projectId || ""
    });
    if (cur.error) {
        return { ok: false, block: false, warnings: warnings,
            reason: "current export tip is missing required files: " + cur.error };
    }

    // AC8 identity guard
    var identity = VM.checkIdentity(meta.projectUid || "", meta.projectId || "", prevManifestForIdentity);
    if (identity.mustSurface) warnings.push("AC8 identity: " + identity.reason);
    if (identity.block) {
        return { ok: true, block: true, bootstrap: bootstrap, warnings: warnings, identity: identity,
            reason: "AC8 project_uid mismatch — carry-forward skipped (no fake ancestor); export proceeds normally (AC7)" };
    }

    var cf = VM.carryForward({ priorVersions: priorVersions, priorTipHash: priorTipHash, currentEntry: cur.entry });
    for (var w = 0; w < cf.warnings.length; w++) warnings.push(cf.warnings[w]);

    var versionsToWrite = [];
    for (var vid in carriedDirs) {
        if (carriedDirs.hasOwnProperty(vid)) versionsToWrite.push({ dir: vid, files: carriedDirs[vid] });
    }
    versionsToWrite.push({ dir: cf.appended.version_id, files: cur.files });

    return {
        ok: true, block: false, bootstrap: bootstrap, warnings: warnings,
        identity: identity, manifest: cf.manifest, versionsToWrite: versionsToWrite
    };
}

module.exports = {
    planCarryForward: planCarryForward,
    REQUIRED_SEG: REQUIRED_SEG,
    TRANS_PRIMARY: TRANS_PRIMARY,
    TRANS_TEMPLATE: TRANS_TEMPLATE,
    RECOMMENDED: RECOMMENDED,
    _utf8Decode: _utf8Decode,
    _groupPrevVersions: _groupPrevVersions,
    _presentTranslations: _presentTranslations
};
