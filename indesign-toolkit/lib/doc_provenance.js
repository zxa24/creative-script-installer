"use strict";

/**
 * lib/doc_provenance.js
 *
 * Classify an InDesign Document by import/export provenance — used to
 * decide whether import_translations_v2 enters edit mode and to annotate
 * export packages with their source-doc state.
 *
 * Signal priority (most → least reliable):
 *   1. doc.extractLabel("translation_import_state_v1") parses to valid JSON
 *      → "imported-with-state"  (edit mode safe to start; state available)
 *   2. doc has any paragraphStyle named ^_T_p_  (incl. in style groups)
 *      → "imported-legacy"      (older import OR label deleted; must full)
 *   3. doc.xmlElements contains <TranslationSegment> nodes
 *      → "exported-only"        (round-tripped through export; no import yet)
 *   4. None of the above → "original"
 *
 * Filename `.translated.indd` is recorded as `filenameHint` but never
 * upgrades the state — operators can rename freely, so it can't drive
 * decisions on its own.
 *
 * Pure-ish module: only touches the Document via documented properties.
 * No fs / uxp / app deps. Node tests can pass in a stub doc.
 */

var STATE_LABEL_KEY = "translation_import_state_v1";

// ---------------------------------------------------------------------------
// Low-level extractors (defensive: each one catches its own throws so a
// missing/broken signal can't take the whole classifier down)
// ---------------------------------------------------------------------------

function _safeExtractLabel(doc, key) {
    try {
        var v = doc.extractLabel(key);
        // probe_label_io confirmed insert/extract are SYNC in UXP idjs;
        // a Promise return here would mean an undocumented API change —
        // surface as null (treated as "no label").
        if (v && typeof v.then === "function") return null;
        return v || "";
    } catch (e) { return ""; }
}

function _parseStateJson(raw) {
    if (!raw || typeof raw !== "string") return null;
    var s = raw.replace(/^\s+|\s+$/g, "");
    if (!s) return null;
    if (s.charAt(0) !== "{") return null;
    var obj;
    try { obj = JSON.parse(s); } catch (e) { return null; }
    if (!obj || typeof obj !== "object") return null;
    // schema field is the minimum required marker — protects against
    // unrelated future labels that happen to start with "{".
    if (typeof obj.schema !== "number") return null;
    return obj;
}

function _scanParagraphStyles(doc) {
    var info = { has: false, count: 0, sampleName: null };
    function visit(stylesCollection) {
        try {
            var n = stylesCollection.length;
            for (var i = 0; i < n; i++) {
                var nm = "";
                try { nm = String(stylesCollection.item(i).name); } catch (e) {}
                if (nm.indexOf("_T_p_") === 0) {
                    info.has = true;
                    info.count++;
                    if (!info.sampleName) info.sampleName = nm;
                }
            }
        } catch (e) {}
    }
    try { visit(doc.paragraphStyles); } catch (e) {}
    try {
        var groups = doc.paragraphStyleGroups;
        for (var gi = 0; gi < groups.length; gi++) {
            try { visit(groups.item(gi).paragraphStyles); } catch (e) {}
        }
    } catch (e) {}
    return info;
}

function _hasTranslationSegmentTags(doc) {
    // Iterative DFS over XML structure; bail on first match. Capped to a
    // generous iteration limit so a runaway tree (or stub bug) can't hang
    // the classifier.
    try {
        var roots = doc.xmlElements;
        if (!roots || roots.length === 0) return false;
        var stack = [];
        for (var ri = 0; ri < roots.length; ri++) {
            try { stack.push(roots.item(ri)); } catch (e) {}
        }
        var iter = 0;
        var MAX_ITER = 5000;
        while (stack.length && iter < MAX_ITER) {
            iter++;
            var node = stack.pop();
            try {
                var nm = node.markupTag && node.markupTag.name;
                if (nm && String(nm) === "TranslationSegment") return true;
            } catch (e) {}
            try {
                var children = node.xmlElements;
                for (var ci = 0; ci < children.length; ci++) {
                    try { stack.push(children.item(ci)); } catch (eC) {}
                }
            } catch (eCh) {}
        }
        return false;
    } catch (e) { return false; }
}

function _checkFilenameHint(doc) {
    var nm = "";
    try { nm = String(doc.name || ""); } catch (e) {}
    return /\.translated\.indd$/i.test(nm);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function classify(doc) {
    if (!doc) {
        return {
            state: "original",
            hasImportState: false,
            importState: null,
            hasClusterStyles: false,
            clusterStyleCount: 0,
            clusterStyleSample: null,
            hasTranslationSegmentTags: false,
            filenameHint: false,
            rawLabelLen: 0,
            labelKey: STATE_LABEL_KEY
        };
    }

    var rawLabel = _safeExtractLabel(doc, STATE_LABEL_KEY);
    var importState = _parseStateJson(rawLabel);
    var psInfo = _scanParagraphStyles(doc);
    var hasTSTags = _hasTranslationSegmentTags(doc);
    var filenameHint = _checkFilenameHint(doc);

    var state;
    if (importState) state = "imported-with-state";
    else if (psInfo.has) state = "imported-legacy";
    else if (hasTSTags) state = "exported-only";
    else state = "original";

    return {
        state: state,
        hasImportState: !!importState,
        importState: importState,
        hasClusterStyles: psInfo.has,
        clusterStyleCount: psInfo.count,
        clusterStyleSample: psInfo.sampleName,
        hasTranslationSegmentTags: hasTSTags,
        filenameHint: filenameHint,
        rawLabelLen: rawLabel ? rawLabel.length : 0,
        labelKey: STATE_LABEL_KEY
    };
}

function formatSummary(prov) {
    if (!prov) return "(no provenance)";
    switch (prov.state) {
        case "imported-with-state":
            var parts = ["Imported (state label v" + (prov.importState && prov.importState.schema)];
            if (prov.importState && prov.importState.last_import_at) {
                parts.push("last @ " + prov.importState.last_import_at);
            }
            if (prov.importState && prov.importState.segments) {
                parts.push(Object.keys(prov.importState.segments).length + " segs in state");
            }
            parts.push(prov.clusterStyleCount + " cluster styles");
            return parts.join(", ") + ")";
        case "imported-legacy":
            // NOTE: printed from the SOURCE classify, BEFORE Fix A re-derives routing
            // from the opened workDoc — so do NOT assert the final mode here (Fix A may
            // demote an in-memory-reorganized source, whose disk copy has 0 clusters, to
            // the FULL pipeline). Fix A logs its own authoritative routing line.
            return "Imported (legacy — "
                + prov.clusterStyleCount + " cluster styles, NO state label; "
                + "final routing re-derived from the opened workDoc after saveACopy [Fix A])";
        case "exported-only":
            return "Exported-only (TranslationSegment XML tags present, never imported)";
        case "original":
            return "Original (no translation markers detected"
                + (prov.filenameHint ? " — filename hint set but no scripting signals" : "") + ")";
        default:
            return String(prov.state) || "(unknown)";
    }
}

module.exports = {
    classify: classify,
    formatSummary: formatSummary,
    STATE_LABEL_KEY: STATE_LABEL_KEY,
    // exposed for unit tests
    _internal: {
        parseStateJson: _parseStateJson,
        scanParagraphStyles: _scanParagraphStyles,
        hasTranslationSegmentTags: _hasTranslationSegmentTags,
        checkFilenameHint: _checkFilenameHint
    }
};
