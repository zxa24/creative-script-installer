"use strict";

/**
 * lib/annot_italic_demand.js — #41: which SOURCE (font, weight) faces carry a
 * translator italic mark in this translation package.
 *
 * Consumed at panel-open (import_integrated threads the result into the font
 * panel), where the auto-faux trigger is: the moment the operator wires a
 * demanded source face to a CJK weight, that weight needs italic
 * (design-intent §6, 2026-08-13 revision — 甲: auto-add faux@12 + say so).
 *
 * TWO demand sources — checking only one WILL miss marks (task book §需求怎么算):
 *   1. rows[].annotations[]  type:"format" action:"italic" — MUST pass the
 *      `_auto` gate (AutoFormatGate.isAutoAnnotation — the same door the apply
 *      side uses; cross-repo policy: never propagate non-hand-made format).
 *   2. inline <i> tags in target_text — decoded with the REAL emphasis codec
 *      (emphasis_codec.decode), not a regex; italic-flavored run diffs count.
 *
 * Face resolution: row.tid ↔ segments[].tid; the face is
 * seg.format_snapshot.baseline.{fontFamily, fontStyle} (visual_snapshot.js).
 * format_snapshot is written inside a try/catch at export
 * (export_translation_package.idjs:632-634) so it CAN be null per segment —
 * null-guarded here: that tid contributes no face (undercount, never a crash),
 * and the miss is counted in stats so the caller can report the real-package
 * non-null rate (task book: 若低到大面积漏计要停下上报).
 */

var SEP = "␟";   // same face-key separator as font_face_missing / fold sets

var AutoFormatGate;
try { AutoFormatGate = require("./auto_format_gate.js"); } catch (e) { AutoFormatGate = null; }
var EmphasisCodec;
try { EmphasisCodec = require("./emphasis_codec.js"); } catch (e) { EmphasisCodec = null; }

function faceKey(font, weight) { return String(font) + SEP + String(weight); }

function _rowHasItalicAnnotation(row) {
    var anns = row && row.annotations;
    if (!anns || !anns.length) return false;
    for (var i = 0; i < anns.length; i++) {
        var a = anns[i];
        if (!a || a.type !== "format" || a.action !== "italic") continue;
        // cross-repo `_auto` door — same gate the apply side uses.
        if (AutoFormatGate && typeof AutoFormatGate.isAutoAnnotation === "function"
            && AutoFormatGate.isAutoAnnotation(a)) continue;
        return true;
    }
    return false;
}

function _rowHasInlineItalic(row) {
    var t = row && row.target_text;
    if (!t || !EmphasisCodec || typeof EmphasisCodec.decode !== "function") return false;
    if (String(t).indexOf("<") < 0) return false;   // cheap pre-filter
    var runs;
    try {
        var decoded = EmphasisCodec.decode(String(t)) || {};
        // decode's public return names the list `targetEmphasisRuns` (measured
        // 2026-08-13); `runs` kept as a fallback against internal renames.
        runs = decoded.targetEmphasisRuns || decoded.runs || [];
    } catch (e) { return false; }
    for (var i = 0; i < runs.length; i++) {
        var d = runs[i] && runs[i].diff;
        if (d && /italic/i.test(String(d.fontStyle || ""))) return true;
    }
    return false;
}

// computeItalicDemandFaces(translations, segments)
//   translations: { rows, byTid } (loadTranslations shape) or bare rows array
//   segments: array of segment objects (loadSegmentsSidecar().segments)
// → { faces: { "font␟weight": true }, stats: {...} }
function computeItalicDemandFaces(translations, segments) {
    var rows = (translations && translations.rows) || translations || [];
    var segs = segments || [];
    var byTid = {};
    for (var s = 0; s < segs.length; s++) {
        var sg = segs[s];
        if (sg && sg.tid) byTid[sg.tid] = sg;
    }
    var stats = {
        rowsTotal: rows.length,
        rowsWithDemand: 0,
        viaAnnotations: 0,
        viaInlineTags: 0,
        segsTotal: segs.length,
        segsWithSnapshot: 0,
        demandRowsMissingSeg: 0,
        demandRowsMissingSnapshot: 0,
        facesCount: 0
    };
    for (var t = 0; t < segs.length; t++) {
        var sgN = segs[t];
        if (sgN && sgN.format_snapshot && sgN.format_snapshot.baseline
            && sgN.format_snapshot.baseline.fontFamily) stats.segsWithSnapshot++;
    }
    var faces = {};
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || !row.tid) continue;
        var viaAnn = _rowHasItalicAnnotation(row);
        var viaTag = _rowHasInlineItalic(row);
        if (!viaAnn && !viaTag) continue;
        stats.rowsWithDemand++;
        if (viaAnn) stats.viaAnnotations++;
        if (viaTag) stats.viaInlineTags++;
        var seg = byTid[row.tid];
        if (!seg) { stats.demandRowsMissingSeg++; continue; }
        var snap = seg.format_snapshot;
        var base = snap && snap.baseline;
        if (!base || !base.fontFamily) { stats.demandRowsMissingSnapshot++; continue; }
        faces[faceKey(base.fontFamily, base.fontStyle || "Regular")] = true;
    }
    var n = 0;
    for (var k in faces) { if (Object.prototype.hasOwnProperty.call(faces, k)) n++; }
    stats.facesCount = n;
    return { faces: faces, stats: stats };
}

module.exports = {
    FACE_KEY_SEP: SEP,
    faceKey: faceKey,
    computeItalicDemandFaces: computeItalicDemandFaces
};
