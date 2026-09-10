"use strict";

// lib/snapshot_utils.js — Frame snapshot capture, serialization, and geometry-split expansion

var utils = require("./utils.js");
var safe = utils.safe;
var getCollectionItem = utils.getCollectionItem;
var Contract = require("./frame_repair_contract.js");
var FramePartition = require("./frame_partition.js");
var FrameHostAdapter = require("./frame_host_adapter.js");

/**
 * Capture a snapshot of a single frame.
 * @param {TextFrame} frame
 * @param {number} index - Frame index within the story
 * @param {boolean} storySingleFrame - True if story has only one frame
 * @returns {Object} Frame snapshot object (via Contract.createFrameSnapshot)
 */
function sampleFrameSnapshot(frame, index, storySingleFrame) {
    var partition = FramePartition.getFramePartition(frame);
    var firstLine = "", lastLine = "", contents = "";
    var lineCount = 0;
    var hasObjectMarker = false;
    var objectMarkerCount = 0;
    var startsWithObjectMarker = false;
    var endsWithObjectMarker = false;
    var i;

    try {
        if (frame.lines && frame.lines.length) {
            lineCount = Number(frame.lines.length);
            firstLine = safe(getCollectionItem(frame.lines, 0).contents);
            lastLine = safe(getCollectionItem(frame.lines, frame.lines.length - 1).contents);
        }
    } catch (e0) {}
    try { contents = safe(frame.contents); } catch (e1) {}
    for (i = 0; i < contents.length; i++) {
        if (contents.charCodeAt(i) === 65532) {
            objectMarkerCount += 1;
            if (i === 0) { startsWithObjectMarker = true; }
            if (i === contents.length - 1) { endsWithObjectMarker = true; }
        }
    }
    hasObjectMarker = objectMarkerCount > 0;

    return Contract.createFrameSnapshot({
        id: frame.id,
        index: index,
        pageName: frame.parentPage ? safe(frame.parentPage.name) : "",
        bounds: String(FrameHostAdapter.copyBoundsArray(frame.geometricBounds).join(",")),
        geometricBounds: FrameHostAdapter.copyBoundsArray(frame.geometricBounds),
        storySingleFrame: !!storySingleFrame,
        partition: partition,
        displaySignature: {
            lineCount: lineCount,
            firstLine: firstLine,
            lastLine: lastLine,
            textLength: contents.length,
            hasObjectMarker: hasObjectMarker,
            objectMarkerCount: objectMarkerCount,
            startsWithObjectMarker: startsWithObjectMarker,
            endsWithObjectMarker: endsWithObjectMarker,
            overflows: !!frame.overflows,
            isTextFrame: true
        }
    });
}

/**
 * Capture a snapshot of all frames in a story.
 * @param {Story} story
 * @returns {Object} Story snapshot {storyId, frames, frameCount}
 */
function captureStorySnapshot(story) {
    var storySingleFrame = !!(story && story.textContainers && story.textContainers.length === 1);
    var frames = FramePartition.sampleStoryPartitions(story, function (frame, index) {
        return sampleFrameSnapshot(frame, index, storySingleFrame);
    });
    var snapshot = { storyId: story ? story.id : "", frames: frames, frameCount: frames.length };
    var i;
    for (i = 0; i < frames.length; i++) { snapshot.frames[i].index = i; }
    return snapshot;
}

/**
 * Log a story snapshot's frame details.
 * @param {string} prefix - Log line prefix
 * @param {Object} snapshot - Story snapshot
 * @param {function} log - Logging function
 */
function logStorySnapshot(prefix, snapshot, log) {
    var i, frame;
    log(prefix + " storyId=" + safe(snapshot.storyId) + " frames=" + safe(snapshot.frameCount));
    for (i = 0; i < snapshot.frames.length; i++) {
        frame = snapshot.frames[i];
        log(
            prefix + " frame[" + i + "] id=" + safe(frame.id) +
            " page=" + safe(frame.pageName) +
            " firstParaOrdinal=" + safe(frame.firstParaOrdinal) +
            " lastParaOrdinal=" + safe(frame.lastParaOrdinal) +
            " firstParaStart=" + safe(frame.firstParaStart) +
            " lastParaStart=" + safe(frame.lastParaStart) +
            " firstChar=" + safe(frame.firstCharIdx) +
            " lastChar=" + safe(frame.lastCharIdx) +
            " lines=" + safe(frame.lineCount) +
            " overflows=" + safe(frame.overflows)
        );
    }
}

/**
 * Serialize a frame snapshot to a plain JSON-safe object.
 * @param {Object} fs_snap - Frame snapshot
 * @returns {Object|null}
 */
function serializeFrameSnapshot(fs_snap) {
    if (!fs_snap) { return null; }
    return {
        id: safe(fs_snap.id),
        index: fs_snap.index,
        pageName: safe(fs_snap.pageName),
        bounds: safe(fs_snap.bounds),
        geometricBounds: fs_snap.geometricBounds ? fs_snap.geometricBounds.slice() : null,
        storySingleFrame: !!fs_snap.storySingleFrame,
        empty: !!fs_snap.empty,
        firstParaStart: fs_snap.firstParaStart,
        lastParaStart: fs_snap.lastParaStart,
        firstParaOrdinal: fs_snap.firstParaOrdinal,
        lastParaOrdinal: fs_snap.lastParaOrdinal,
        firstParaOffset: fs_snap.firstParaOffset,
        lastParaOffset: fs_snap.lastParaOffset,
        firstCharIdx: fs_snap.firstCharIdx,
        lastCharIdx: fs_snap.lastCharIdx,
        lineCount: fs_snap.lineCount,
        firstLine: safe(fs_snap.firstLine),
        lastLine: safe(fs_snap.lastLine),
        textLength: fs_snap.textLength,
        hasObjectMarker: !!fs_snap.hasObjectMarker,
        objectMarkerCount: fs_snap.objectMarkerCount || 0,
        startsWithObjectMarker: !!fs_snap.startsWithObjectMarker,
        endsWithObjectMarker: !!fs_snap.endsWithObjectMarker,
        overflows: !!fs_snap.overflows,
        isTextFrame: !!fs_snap.isTextFrame
    };
}

/**
 * Serialize a story snapshot.
 * @param {Object} snap - Story snapshot
 * @returns {Object}
 */
function serializeStorySnapshot(snap) {
    var i, frames = [];
    for (i = 0; i < snap.frames.length; i++) {
        frames.push(serializeFrameSnapshot(snap.frames[i]));
    }
    return { storyId: safe(snap.storyId), frameCount: snap.frameCount, frames: frames };
}

/**
 * Expand geometry-split frames that are too short to hold CJK text.
 * @param {Story} targetStory - Live InDesign story object
 * @param {Object} beforeSnapshot - Story snapshot with frames array
 * @param {string} labelPrefix - Label for log messages
 * @param {function} log - Logging function
 * @param {Object} [opts] - Options: {heightThreshold, expandHeight}
 * @returns {number} Number of frames expanded
 */
function expandGeometrySplitFramesPreApply(targetStory, beforeSnapshot, labelPrefix, log, opts) {
    var heightThreshold = (opts && opts.heightThreshold) || 0.15;
    var expandHeight = (opts && opts.expandHeight) || 0.25;
    var frames, i, bf, nextBf, prevBf, isGeomSplit, liveFrame, gb, height;
    var expandCount = 0;
    var failedExpandCount = 0;

    if (!beforeSnapshot || !beforeSnapshot.frames || !beforeSnapshot.frames.length) {
        return expandCount;
    }

    frames = beforeSnapshot.frames;
    for (i = 0; i < frames.length; i++) {
        bf = frames[i];
        isGeomSplit = false;

        if (i + 1 < frames.length) {
            nextBf = frames[i + 1];
            if (bf.lastParaStart >= 0 && bf.lastParaStart === nextBf.firstParaStart) {
                isGeomSplit = true;
            }
        }

        if (!isGeomSplit && i > 0) {
            prevBf = frames[i - 1];
            if (bf.firstParaStart >= 0 &&
                    prevBf.firstParaStart === prevBf.lastParaStart &&
                    prevBf.lastParaStart === bf.firstParaStart) {
                isGeomSplit = true;
            }
        }

        if (!isGeomSplit) { continue; }
        if (!bf.geometricBounds) { continue; }
        height = bf.geometricBounds[2] - bf.geometricBounds[0];
        if (height >= heightThreshold) { continue; }

        liveFrame = FrameHostAdapter.getStoryTextContainerById(targetStory, bf.id);
        if (!liveFrame) {
            log(labelPrefix + " geom-split frame[" + i + "] id=" + bf.id + " not found, skip");
            continue;
        }

        gb = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);
        gb[2] = gb[0] + expandHeight;
        try {
            liveFrame.geometricBounds = gb;
            bf.geometricBounds = gb.slice(0);
            expandCount += 1;
            log(labelPrefix + " geom-split expanded frame[" + i + "] id=" + bf.id +
                " height=" + height.toFixed(4) + " -> " + expandHeight);
        } catch (eExp) {
            failedExpandCount += 1;
            log(labelPrefix + " geom-split expand frame[" + i + "] id=" + bf.id +
                " FAILED: " + safe(eExp));
        }
    }

    if (expandCount > 0) {
        log(labelPrefix + " geom-split expanded " + expandCount + " frame(s)");
    }
    if (failedExpandCount > 0) {
        log(labelPrefix + " geom-split failed " + failedExpandCount + " frame(s)");
    }
    return expandCount;
}

module.exports = {
    sampleFrameSnapshot: sampleFrameSnapshot,
    captureStorySnapshot: captureStorySnapshot,
    logStorySnapshot: logStorySnapshot,
    serializeFrameSnapshot: serializeFrameSnapshot,
    serializeStorySnapshot: serializeStorySnapshot,
    expandGeometrySplitFramesPreApply: expandGeometrySplitFramesPreApply
};
