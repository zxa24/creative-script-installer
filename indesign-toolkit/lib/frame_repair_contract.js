"use strict";

function normalizeNumber(value, fallback) {
    var num = Number(value);
    if (!isFinite(num)) {
        return fallback;
    }
    return num;
}

function normalizeString(value) {
    if (value === null || typeof value === "undefined") {
        return "";
    }
    return String(value);
}

function createPartitionSnapshot(raw) {
    raw = raw || {};
    return {
        empty: !!raw.empty,
        firstParaStart: normalizeNumber(raw.firstParaStart, -1),
        lastParaStart: normalizeNumber(raw.lastParaStart, -1),
        firstCharIdx: normalizeNumber(raw.firstCharIdx, -1),
        lastCharIdx: normalizeNumber(raw.lastCharIdx, -1),
        firstParaOrdinal: normalizeNumber(raw.firstParaOrdinal, -1),
        lastParaOrdinal: normalizeNumber(raw.lastParaOrdinal, -1)
    };
}

function createDisplaySignature(raw) {
    raw = raw || {};
    return {
        lineCount: normalizeNumber(raw.lineCount, 0),
        firstLine: normalizeString(raw.firstLine),
        lastLine: normalizeString(raw.lastLine),
        textLength: normalizeNumber(raw.textLength, 0),
        hasObjectMarker: !!raw.hasObjectMarker,
        objectMarkerCount: normalizeNumber(raw.objectMarkerCount, 0),
        startsWithObjectMarker: !!raw.startsWithObjectMarker,
        endsWithObjectMarker: !!raw.endsWithObjectMarker,
        overflows: !!raw.overflows,
        isTextFrame: !!raw.isTextFrame
    };
}

function createFrameSnapshot(raw) {
    var partition = createPartitionSnapshot(raw && raw.partition ? raw.partition : raw);
    var displaySignature = createDisplaySignature(raw && raw.displaySignature ? raw.displaySignature : raw);
    raw = raw || {};
    return {
        id: raw.id,
        index: normalizeNumber(raw.index, -1),
        pageName: normalizeString(raw.pageName),
        bounds: normalizeString(raw.bounds),
        storySingleFrame: !!raw.storySingleFrame,
        geometricBounds: raw.geometricBounds ? (raw.geometricBounds.slice ? raw.geometricBounds.slice(0) : raw.geometricBounds) : null,
        partition: partition,
        displaySignature: displaySignature,
        empty: partition.empty,
        firstParaStart: partition.firstParaStart,
        lastParaStart: partition.lastParaStart,
        firstCharIdx: partition.firstCharIdx,
        lastCharIdx: partition.lastCharIdx,
        firstParaOrdinal: partition.firstParaOrdinal,
        lastParaOrdinal: partition.lastParaOrdinal,
        lineCount: displaySignature.lineCount,
        firstLine: displaySignature.firstLine,
        lastLine: displaySignature.lastLine,
        textLength: displaySignature.textLength,
        hasObjectMarker: displaySignature.hasObjectMarker,
        objectMarkerCount: displaySignature.objectMarkerCount,
        startsWithObjectMarker: displaySignature.startsWithObjectMarker,
        endsWithObjectMarker: displaySignature.endsWithObjectMarker,
        overflows: displaySignature.overflows,
        isTextFrame: displaySignature.isTextFrame
    };
}

function createRepairSection(raw) {
    raw = raw || {};
    return {
        attempted: normalizeNumber(raw.attempted, 0),
        fixed: raw.fixed ? raw.fixed.slice(0) : [],
        failed: raw.failed ? raw.failed.slice(0) : [],
        skipped: raw.skipped ? raw.skipped.slice(0) : []
    };
}

function validateRepairAdapter(adapter) {
    var required = [
        "isThreaded",
        "getLiveFrame",
        "frameMatches",
        "repairFrame",
        "priorFramesStillMatch",
        "rememberConfirmed",
        "restoreConfirmed",
        "abortThreaded",
        "recompose",
        "pushUnique",
        "log"
    ];
    var i;
    if (!adapter) {
        throw new Error("Repair adapter is required.");
    }
    for (i = 0; i < required.length; i++) {
        if (typeof adapter[required[i]] !== "function") {
            throw new Error("Repair adapter missing function: " + required[i]);
        }
    }
    return adapter;
}

module.exports = {
    createPartitionSnapshot: createPartitionSnapshot,
    createDisplaySignature: createDisplaySignature,
    createFrameSnapshot: createFrameSnapshot,
    createRepairSection: createRepairSection,
    validateRepairAdapter: validateRepairAdapter
};
