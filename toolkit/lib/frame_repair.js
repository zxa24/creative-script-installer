"use strict";

// lib/frame_repair.js
//
// Post-translation text frame repair engine.
// Restores paragraph distribution, anchor positions, and overflow
// after CJK text replacement changes content length.
//
// Usage:
//   var FrameRepair = require("./lib/frame_repair.js");
//   FrameRepair.init({ log, safe, safeNumberString, indesign,
//                       FrameHostAdapter, FramePartition,
//                       computeOrdinalAdjustment });
//   FrameRepair.ordinalRepairPass(story, snapshot, label, deltas);

// ---------------------------------------------------------------------------
// Module-level dependencies (set via init)
// ---------------------------------------------------------------------------
var log, safe, safeNumberString;
var indesign, FrameHostAdapter, FramePartition;
var computeOrdinalAdjustment;

function init(ctx) {
    log = ctx.log;
    safe = ctx.safe;
    safeNumberString = ctx.safeNumberString;
    indesign = ctx.indesign;
    FrameHostAdapter = ctx.FrameHostAdapter;
    FramePartition = ctx.FramePartition;
    computeOrdinalAdjustment = ctx.computeOrdinalAdjustment;
}

// ---------------------------------------------------------------------------
// Expand tiny frames -- pre-processing
// Frames shorter than CHINESE_MIN_LINE_HEIGHT (0.165") cannot display
// Chinese text: InDesign flows text THROUGH them without rendering.
// ---------------------------------------------------------------------------

var CHINESE_MIN_LINE_HEIGHT = 0.165;

function expandTinyFramesForChinese(targetStory, beforeSnapshot, labelPrefix) {
    var i, beforeFrame, liveFrame, gb, snapshotHeight, liveHeight, newBottom;
    var expanded = 0;
    if (!beforeSnapshot || !beforeSnapshot.frames || !beforeSnapshot.frames.length) { return; }

    for (i = 0; i < beforeSnapshot.frames.length; i++) {
        beforeFrame = beforeSnapshot.frames[i];
        if (!beforeFrame || !beforeFrame.geometricBounds) { continue; }
        if (beforeFrame.hasObjectMarker) { continue; }
        if (beforeFrame.lineCount !== 1) { continue; }

        snapshotHeight = beforeFrame.geometricBounds[2] - beforeFrame.geometricBounds[0];
        if (!(snapshotHeight > 0) || snapshotHeight >= CHINESE_MIN_LINE_HEIGHT) { continue; }

        liveFrame = FrameHostAdapter.getStoryTextContainerById(targetStory, beforeFrame.id);
        if (!liveFrame) { continue; }

        gb = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);
        liveHeight = gb[2] - gb[0];
        if (liveHeight >= CHINESE_MIN_LINE_HEIGHT) { continue; }

        newBottom = gb[0] + CHINESE_MIN_LINE_HEIGHT;
        try {
            FrameHostAdapter.setFrameBottom(liveFrame, newBottom);
            try { targetStory.recompose(); } catch (eRecomp0) {}
            expanded += 1;
            log(labelPrefix + " expandTiny frame[" + i + "] id=" + safe(beforeFrame.id) +
                " h=" + snapshotHeight.toFixed(3) + " -> " + CHINESE_MIN_LINE_HEIGHT);
        } catch (eExp) {
            log(labelPrefix + " expandTiny frame[" + i + "] id=" + safe(beforeFrame.id) +
                " FAILED: " + safe(eExp));
        }
    }
    if (expanded > 0) {
        log(labelPrefix + " expandTiny expanded=" + expanded + " frame(s)");
    }
}

// ---------------------------------------------------------------------------
// Ordinal Repair Pass
//
// Single forward scan: for each frame, binary-search frame height so that
// lastParaOrdinal matches the before-snapshot target.
//
//   cur.lastOrd > target  =>  shrink (frame holds too many paragraphs)
//   cur.lastOrd < target  =>  expand (frame holds too few paragraphs)
//   cur.lastOrd == target =>  skip
//
// lastParaOrdinal is monotonically non-decreasing w.r.t. frame height,
// so binary search is guaranteed to converge.
// ---------------------------------------------------------------------------

// Bug#2: ONE shared cap for widening a 1-line frame to keep it on one line —
// used by BOTH ordinalRepairPass's single-line width fallback (binarySearchFrameWidth)
// AND fixOverflowPass's lineCount===1 width branch. Single source of truth so the
// two single-line width paths can't drift (an audit caught a 2.0/8.0 divergence).
// Free-resize design intent (user 2026-06-25): repair widens without a layout-
// conflict check; humans backstop overlap. host-measured: a master page# needs
// ~2.78in to unwrap; 8.0in (~full Letter width) covers it with margin and the
// binary search minimizes the actual widen. See findings.md#frame-fit-free-resize.
var SINGLE_LINE_MAX_WIDTH_EXPAND_IN = 8.0;

var ORDINAL_REPAIR_MAX_STEPS = 20;
var ORDINAL_REPAIR_MIN_HEIGHT_IN = 0.08;
var ORDINAL_REPAIR_MAX_EXPAND_IN = 12.0;
var ORDINAL_REPAIR_MAX_WIDTH_EXPAND_IN = SINGLE_LINE_MAX_WIDTH_EXPAND_IN;
var ORDINAL_REPAIR_PRECISION_IN = 0.001;

function getLastParaOrdinalOfLiveFrame(liveFrame) {
    var partition;
    try {
        partition = FramePartition.getFramePartition(liveFrame);
        if (partition && partition.lastParaOrdinal >= 0) {
            return partition.lastParaOrdinal;
        }
    } catch (e0) {}
    return -1;
}

function getFirstParaOrdinalOfLiveFrame(liveFrame) {
    var partition;
    try {
        partition = FramePartition.getFramePartition(liveFrame);
        if (partition && partition.firstParaOrdinal >= 0) {
            return partition.firstParaOrdinal;
        }
    } catch (e0) {}
    return -1;
}

function binarySearchFrameHeight(targetStory, liveFrame, targetLastOrd, direction, labelPrefix, frameIndex, frameId) {
    var gb = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);
    var frameTop = Number(gb[0]);
    var curBottom = Number(gb[2]);
    var lo, hi, mid, snapOrd, steps, lastGoodBottom;

    if (direction === "shrink") {
        lo = frameTop + ORDINAL_REPAIR_MIN_HEIGHT_IN;
        hi = curBottom;
    } else {
        lo = curBottom;
        hi = frameTop + ORDINAL_REPAIR_MAX_EXPAND_IN;
    }

    lastGoodBottom = -1;
    steps = 0;

    while (steps < ORDINAL_REPAIR_MAX_STEPS) {
        mid = (lo + hi) / 2;
        steps += 1;

        FrameHostAdapter.setFrameBottom(liveFrame, mid);
        try { targetStory.recompose(); } catch (e0) {}

        snapOrd = getLastParaOrdinalOfLiveFrame(liveFrame);

        log(labelPrefix + " ordinalRepair bsearch frame[" + frameIndex + "] id=" + safe(frameId) +
            " step=" + steps + " mid=" + safeNumberString(mid) +
            " lastOrd=" + snapOrd + " target=" + targetLastOrd +
            " lo=" + safeNumberString(lo) + " hi=" + safeNumberString(hi));

        if (snapOrd === targetLastOrd) {
            lastGoodBottom = mid;
            hi = mid;
        } else if (snapOrd > targetLastOrd) {
            hi = mid;
        } else {
            lo = mid;
        }

        if (hi - lo < ORDINAL_REPAIR_PRECISION_IN) { break; }
    }

    if (lastGoodBottom > 0) {
        FrameHostAdapter.setFrameBottom(liveFrame, lastGoodBottom);
        try { targetStory.recompose(); } catch (e1) {}
    }

    return {
        ok: lastGoodBottom > 0,
        steps: steps,
        finalBottom: lastGoodBottom > 0 ? lastGoodBottom : mid
    };
}

function binarySearchFrameWidth(targetStory, liveFrame, targetLastOrd, expandMode, labelPrefix, frameIndex, frameId) {
    var gb = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);
    var frameLeft = Number(gb[1]);
    var frameRight = Number(gb[3]);
    var lo, hi, mid, steps, snapOrd, lastGoodExpansion, newGb, halfDelta;

    lo = 0;
    hi = ORDINAL_REPAIR_MAX_WIDTH_EXPAND_IN;
    lastGoodExpansion = -1;
    steps = 0;

    while (steps < ORDINAL_REPAIR_MAX_STEPS) {
        mid = (lo + hi) / 2;
        steps += 1;

        newGb = FrameHostAdapter.copyBoundsArray(gb);
        if (expandMode === "width-right") {
            newGb[3] = frameRight + mid;
        } else if (expandMode === "width-left") {
            newGb[1] = frameLeft - mid;
        } else {
            halfDelta = mid / 2;
            newGb[1] = frameLeft - halfDelta;
            newGb[3] = frameRight + halfDelta;
        }
        liveFrame.geometricBounds = newGb;
        try { targetStory.recompose(); } catch (eW0) {}

        snapOrd = getLastParaOrdinalOfLiveFrame(liveFrame);

        log(labelPrefix + " ordinalRepair widthSearch frame[" + frameIndex + "] id=" + safe(frameId) +
            " step=" + steps + " expand=" + safeNumberString(mid) + " mode=" + expandMode +
            " lastOrd=" + snapOrd + " target=" + targetLastOrd);

        if (snapOrd === targetLastOrd) {
            lastGoodExpansion = mid;
            hi = mid;
        } else if (snapOrd > targetLastOrd) {
            hi = mid;
        } else {
            lo = mid;
        }

        if (hi - lo < ORDINAL_REPAIR_PRECISION_IN) { break; }
    }

    if (lastGoodExpansion >= 0) {
        newGb = FrameHostAdapter.copyBoundsArray(gb);
        if (expandMode === "width-right") {
            newGb[3] = frameRight + lastGoodExpansion;
        } else if (expandMode === "width-left") {
            newGb[1] = frameLeft - lastGoodExpansion;
        } else {
            halfDelta = lastGoodExpansion / 2;
            newGb[1] = frameLeft - halfDelta;
            newGb[3] = frameRight + halfDelta;
        }
        liveFrame.geometricBounds = newGb;
        try { targetStory.recompose(); } catch (eW1) {}
    }

    return {
        ok: lastGoodExpansion >= 0,
        steps: steps
    };
}

function binarySearchSpillover(targetStory, liveFrame, targetLastOrd, nextLiveFrame, nextTargetFirstOrd, labelPrefix, frameIndex, frameId) {
    var gb = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);
    var curBottom = Number(gb[2]);
    var lo, hi, mid, steps, curLastOrd, nextCurFirstOrd, lastGoodBottom;

    lo = curBottom;
    hi = curBottom + ORDINAL_REPAIR_MAX_EXPAND_IN;
    lastGoodBottom = -1;
    steps = 0;

    while (steps < ORDINAL_REPAIR_MAX_STEPS) {
        mid = (lo + hi) / 2;
        steps += 1;

        FrameHostAdapter.setFrameBottom(liveFrame, mid);
        try { targetStory.recompose(); } catch (e0) {}

        curLastOrd = getLastParaOrdinalOfLiveFrame(liveFrame);
        nextCurFirstOrd = getFirstParaOrdinalOfLiveFrame(nextLiveFrame);

        log(labelPrefix + " ordinalRepair spillover frame[" + frameIndex + "] id=" + safe(frameId) +
            " step=" + steps + " mid=" + safeNumberString(mid) +
            " lastOrd=" + curLastOrd + " nextFirstOrd=" + nextCurFirstOrd +
            " targetNextFirst=" + nextTargetFirstOrd +
            " lo=" + safeNumberString(lo) + " hi=" + safeNumberString(hi));

        if (curLastOrd > targetLastOrd) {
            hi = mid;
        } else if (nextCurFirstOrd === nextTargetFirstOrd) {
            lastGoodBottom = mid;
            hi = mid;
        } else if (nextCurFirstOrd === -1 && curLastOrd === targetLastOrd) {
            lastGoodBottom = mid;
            hi = mid;
        } else {
            lo = mid;
        }

        if (hi - lo < ORDINAL_REPAIR_PRECISION_IN) { break; }
    }

    if (lastGoodBottom > 0) {
        FrameHostAdapter.setFrameBottom(liveFrame, lastGoodBottom);
        try { targetStory.recompose(); } catch (e1) {}
    }

    return {
        ok: lastGoodBottom > 0,
        steps: steps,
        finalBottom: lastGoodBottom > 0 ? lastGoodBottom : mid
    };
}

function getFrameJustification(liveFrame) {
    var paras, justVal;
    try {
        paras = liveFrame.paragraphs;
        if (paras && paras.length > 0) {
            justVal = String(paras[0].justification);
            return justVal;
        }
    } catch (e0) {}
    return "unknown";
}

function determineWidthExpandMode(liveFrame) {
    var justification = getFrameJustification(liveFrame);
    if (justification.indexOf("CENTER") >= 0 || justification.indexOf("Center") >= 0) {
        return "width-center";
    } else if (justification.indexOf("RIGHT") >= 0 || justification.indexOf("Right") >= 0 ||
               justification.indexOf("AWAY_FROM_SPINE") >= 0 || justification.indexOf("TO_BINDING") >= 0) {
        return "width-left";
    }
    return "width-right";
}

function ordinalRepairPass(targetStory, beforeSnapshot, labelPrefix, storyParaDeltas) {
    var i, beforeFrame, liveFrame, curOrd, targetLastOrd, saveBounds, direction;
    var result, finalOrd, repaired, failed, skipped;
    var nextBeforeFrame, nextLiveFrame, nextFirstOrd, nextTargetFirstOrd;
    var needsSpilloverFix, widthResult, widthExpandMode;
    var ordAdj;

    if (!beforeSnapshot || !beforeSnapshot.frames || !beforeSnapshot.frames.length) { return 0; }

    repaired = 0;
    failed = 0;
    skipped = 0;

    for (i = 0; i < beforeSnapshot.frames.length; i++) {
        beforeFrame = beforeSnapshot.frames[i];
        if (!beforeFrame) { continue; }

        targetLastOrd = beforeFrame.lastParaOrdinal;

        if (storyParaDeltas && storyParaDeltas.length && targetLastOrd >= 0) {
            ordAdj = computeOrdinalAdjustment(storyParaDeltas, targetLastOrd, "last");
            if (ordAdj !== 0) {
                log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " deltaAdjust targetOrd " + targetLastOrd + " -> " + (targetLastOrd + ordAdj) +
                    " (adj=" + ordAdj + ")");
                targetLastOrd = targetLastOrd + ordAdj;
            }
        }
        if (targetLastOrd < 0) {
            skipped += 1;
            continue;
        }

        // Skip chart/table anchor frames: frames that start with U+FFFC in the
        // before-snapshot are anchor-only holders (textLength~2).
        // restoreAnchorBoundaries handles these boundaries instead.
        if (beforeFrame.startsWithObjectMarker) {
            skipped += 1;
            continue;
        }

        liveFrame = FrameHostAdapter.getStoryTextContainerById(targetStory, beforeFrame.id);
        if (!liveFrame) {
            log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) + " MISSING");
            failed += 1;
            continue;
        }

        curOrd = getLastParaOrdinalOfLiveFrame(liveFrame);

        // Check for paragraph spillover
        needsSpilloverFix = false;
        if (curOrd === targetLastOrd && (i + 1) < beforeSnapshot.frames.length) {
            nextBeforeFrame = beforeSnapshot.frames[i + 1];
            if (nextBeforeFrame && nextBeforeFrame.firstParaOrdinal >= 0) {
                nextTargetFirstOrd = nextBeforeFrame.firstParaOrdinal;
                if (storyParaDeltas && storyParaDeltas.length && nextTargetFirstOrd >= 0) {
                    ordAdj = computeOrdinalAdjustment(storyParaDeltas, nextTargetFirstOrd, "first");
                    nextTargetFirstOrd = nextTargetFirstOrd + ordAdj;
                }
                nextLiveFrame = FrameHostAdapter.getStoryTextContainerById(targetStory, nextBeforeFrame.id);
                if (nextLiveFrame) {
                    nextFirstOrd = getFirstParaOrdinalOfLiveFrame(nextLiveFrame);
                    if (nextFirstOrd >= 0 && nextFirstOrd < nextTargetFirstOrd) {
                        needsSpilloverFix = true;
                        log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                            " spillover detected: next frame[" + (i + 1) + "] firstOrd=" + nextFirstOrd +
                            " should be " + nextTargetFirstOrd);
                    }
                }
            }
        }

        if (curOrd === targetLastOrd && !needsSpilloverFix) {
            skipped += 1;
            continue;
        }

        if (needsSpilloverFix) {
            direction = "spillover";
        } else if (curOrd > targetLastOrd) {
            direction = "shrink";
        } else {
            direction = "expand";
        }

        saveBounds = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);

        log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
            " curOrd=" + curOrd + " targetOrd=" + targetLastOrd +
            " direction=" + direction);

        if (direction === "spillover") {
            result = binarySearchSpillover(
                targetStory, liveFrame, targetLastOrd, nextLiveFrame, nextTargetFirstOrd,
                labelPrefix, i, beforeFrame.id
            );
        } else {
            result = binarySearchFrameHeight(
                targetStory, liveFrame, targetLastOrd, direction,
                labelPrefix, i, beforeFrame.id
            );
        }

        finalOrd = getLastParaOrdinalOfLiveFrame(liveFrame);

        if (direction === "spillover") {
            nextFirstOrd = getFirstParaOrdinalOfLiveFrame(nextLiveFrame);
            if (finalOrd === targetLastOrd && nextFirstOrd === nextTargetFirstOrd) {
                repaired += 1;
                log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " SPILLOVER-OK in " + result.steps + " steps");
            } else {
                FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
                try { targetStory.recompose(); } catch (e1) {}
                failed += 1;
                log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " SPILLOVER-FAILED finalOrd=" + finalOrd + " nextFirstOrd=" + nextFirstOrd +
                    " (restored original bounds)");
            }
        } else if (finalOrd === targetLastOrd) {
            repaired += 1;
            log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                " OK in " + result.steps + " steps");
        } else if (direction === "expand" && beforeFrame.lineCount === 1) {
            // Height failed for single-line: try width expansion
            FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
            try { targetStory.recompose(); } catch (eWf0) {}

            widthExpandMode = determineWidthExpandMode(liveFrame);
            log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                " height failed for single-line, fallback to " + widthExpandMode);

            widthResult = binarySearchFrameWidth(
                targetStory, liveFrame, targetLastOrd, widthExpandMode,
                labelPrefix, i, beforeFrame.id
            );

            finalOrd = getLastParaOrdinalOfLiveFrame(liveFrame);
            if (finalOrd === targetLastOrd) {
                repaired += 1;
                log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " OK (width-fallback " + widthExpandMode + " in " + widthResult.steps + " steps)");
            } else if (beforeFrame.storySingleFrame) {
                FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
                try { targetStory.recompose(); } catch (eWf2) {}
                try {
                    liveFrame.fit(indesign.FitOptions.FRAME_TO_CONTENT);
                    try { targetStory.recompose(); } catch (eWf3) {}
                } catch (eWf4) {}
                finalOrd = getLastParaOrdinalOfLiveFrame(liveFrame);
                if (finalOrd === targetLastOrd) {
                    repaired += 1;
                    log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                        " OK (fit-to-content after height+width failed)");
                } else {
                    FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
                    try { targetStory.recompose(); } catch (eWf5) {}
                    failed += 1;
                    log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                        " FAILED finalOrd=" + finalOrd + " targetOrd=" + targetLastOrd +
                        " (height+width+fit all failed, restored original bounds)");
                }
            } else {
                FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
                try { targetStory.recompose(); } catch (eWf1) {}
                failed += 1;
                log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " FAILED finalOrd=" + finalOrd + " targetOrd=" + targetLastOrd +
                    " (height+width both failed, restored original bounds)");
            }
        } else if (direction === "expand" && beforeFrame.storySingleFrame) {
            FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
            try { targetStory.recompose(); } catch (eFc0) {}
            log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                " height failed for single-frame, fallback to fit-to-content");
            try {
                liveFrame.fit(indesign.FitOptions.FRAME_TO_CONTENT);
                try { targetStory.recompose(); } catch (eFc1) {}
            } catch (eFc2) {}
            finalOrd = getLastParaOrdinalOfLiveFrame(liveFrame);
            if (finalOrd === targetLastOrd) {
                repaired += 1;
                log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " OK (fit-to-content)");
            } else {
                FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
                try { targetStory.recompose(); } catch (eFc3) {}
                failed += 1;
                log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " FAILED finalOrd=" + finalOrd + " targetOrd=" + targetLastOrd +
                    " (height+fit both failed, restored original bounds)");
            }
        } else {
            FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
            try { targetStory.recompose(); } catch (e0) {}
            failed += 1;
            log(labelPrefix + " ordinalRepair frame[" + i + "] id=" + safe(beforeFrame.id) +
                " FAILED finalOrd=" + finalOrd + " targetOrd=" + targetLastOrd +
                " (restored original bounds, continuing with actual state)");
        }
    }

    log(labelPrefix + " ordinalRepair pass complete: repaired=" + repaired +
        " failed=" + failed + " skipped=" + skipped);
    return repaired;
}

// ---------------------------------------------------------------------------
// U+FFFC (object marker / table anchor) helpers
// ---------------------------------------------------------------------------

function liveFrameStartsWithObjectMarker(liveFrame) {
    try {
        var ch = liveFrame.characters.item(0);
        if (ch && ch.contents) {
            var code = String(ch.contents).charCodeAt(0);
            return code === 65532;
        }
    } catch (e0) {}
    return false;
}

function getLiveFrameObjectMarkerCount(liveFrame) {
    var count = 0;
    try {
        var contents = String(liveFrame.contents);
        var k;
        for (k = 0; k < contents.length; k++) {
            if (contents.charCodeAt(k) === 65532) { count += 1; }
        }
    } catch (e0) {}
    return count;
}

function liveFrameEndsWithObjectMarker(liveFrame) {
    try {
        var chars = liveFrame.characters;
        if (!chars || !chars.length) { return false; }
        var lastCh = chars.item(chars.length - 1);
        if (lastCh && lastCh.contents) {
            return String(lastCh.contents).charCodeAt(0) === 65532;
        }
    } catch (e0) {}
    return false;
}

// ---------------------------------------------------------------------------
// Boundary-based anchor restoration
// ---------------------------------------------------------------------------

var ANCHOR_REPAIR_MAX_STEPS = 20;
var ANCHOR_REPAIR_MAX_EXPAND_IN = 6.0;
var ANCHOR_REPAIR_MIN_HEIGHT_IN = 0.08;
var ANCHOR_REPAIR_PRECISION_IN = 0.001;

function checkBoundaryAnchorState(targetStory, beforeSnapshot, boundaryIdx) {
    var bf = beforeSnapshot.frames[boundaryIdx];
    var bfNext = beforeSnapshot.frames[boundaryIdx + 1];
    var lf = FrameHostAdapter.getStoryTextContainerById(targetStory, bf.id);
    var lfNext = FrameHostAdapter.getStoryTextContainerById(targetStory, bfNext.id);
    var curCount, targetCount, curNextStarts, targetNextStarts;
    var curEnds, targetEnds;
    var ok;

    if (!lf || !lfNext) {
        return { ok: true, missing: true };
    }

    curCount = getLiveFrameObjectMarkerCount(lf);
    targetCount = bf.objectMarkerCount || 0;
    curNextStarts = liveFrameStartsWithObjectMarker(lfNext);
    targetNextStarts = !!(bfNext.startsWithObjectMarker);
    curEnds = liveFrameEndsWithObjectMarker(lf);
    targetEnds = !!(bf.endsWithObjectMarker);

    ok = (curCount === targetCount) &&
         (curNextStarts === targetNextStarts) &&
         (curEnds === targetEnds);

    return {
        ok: ok,
        missing: false,
        curCount: curCount,
        targetCount: targetCount,
        curNextStarts: curNextStarts,
        targetNextStarts: targetNextStarts,
        curEnds: curEnds,
        targetEnds: targetEnds
    };
}

function priorBoundariesHold(targetStory, beforeSnapshot, upToIdx) {
    var b, state;
    for (b = 0; b < upToIdx; b++) {
        state = checkBoundaryAnchorState(targetStory, beforeSnapshot, b);
        if (!state.ok && !state.missing) {
            return false;
        }
    }
    return true;
}

function restoreAnchorBoundaries(targetStory, beforeSnapshot, labelPrefix, verifyOnly) {
    var i, bf, bfNext, lf;
    var state, direction;
    var gb, frameBottom, frameTop;
    var lo, hi, mid, steps, lastGoodBottom, saveBounds;
    var fixed = 0, skipped = 0, failed = 0, verified = 0;
    var needsAnchorRepair = false;

    if (!beforeSnapshot || !beforeSnapshot.frames || beforeSnapshot.frames.length < 2) {
        return { fixed: 0, skipped: 0, failed: 0, verified: 0 };
    }

    // Quick scan: does any boundary need anchor repair?
    for (i = 0; i < beforeSnapshot.frames.length - 1; i++) {
        bf = beforeSnapshot.frames[i];
        bfNext = beforeSnapshot.frames[i + 1];
        if ((bf.objectMarkerCount || 0) > 0 || (bfNext.objectMarkerCount || 0) > 0 ||
            bf.startsWithObjectMarker || bf.endsWithObjectMarker ||
            bfNext.startsWithObjectMarker || bfNext.endsWithObjectMarker) {
            needsAnchorRepair = true;
            break;
        }
    }
    if (!needsAnchorRepair) {
        return { fixed: 0, skipped: 0, failed: 0, verified: 0 };
    }

    for (i = 0; i < beforeSnapshot.frames.length - 1; i++) {
        bf = beforeSnapshot.frames[i];
        bfNext = beforeSnapshot.frames[i + 1];

        if ((bf.objectMarkerCount || 0) === 0 && (bfNext.objectMarkerCount || 0) === 0 &&
            !bf.startsWithObjectMarker && !bf.endsWithObjectMarker &&
            !bfNext.startsWithObjectMarker && !bfNext.endsWithObjectMarker) {
            continue;
        }

        state = checkBoundaryAnchorState(targetStory, beforeSnapshot, i);
        if (state.missing) {
            skipped += 1;
            continue;
        }

        if (state.ok) {
            if (verifyOnly) { verified += 1; }
            else { skipped += 1; }
            continue;
        }

        log(labelPrefix + " anchorBoundary[" + i + "] MISMATCH:" +
            " count=" + state.curCount + "/" + state.targetCount +
            " nextStarts=" + state.curNextStarts + "/" + state.targetNextStarts +
            " ends=" + state.curEnds + "/" + state.targetEnds);

        if (verifyOnly) {
            failed += 1;
            continue;
        }

        if (state.curCount > state.targetCount) {
            direction = "shrink";
        } else if (state.curCount < state.targetCount) {
            direction = "expand";
        } else {
            if (state.targetNextStarts && !state.curNextStarts) {
                direction = "expand";
            } else if (!state.targetNextStarts && state.curNextStarts) {
                direction = "shrink";
            } else if (state.targetEnds && !state.curEnds) {
                direction = "shrink";
            } else {
                direction = "expand";
            }
        }

        lf = FrameHostAdapter.getStoryTextContainerById(targetStory, bf.id);
        if (!lf) {
            skipped += 1;
            continue;
        }

        gb = FrameHostAdapter.copyBoundsArray(lf.geometricBounds);
        frameTop = Number(gb[0]);
        frameBottom = Number(gb[2]);
        saveBounds = gb.slice(0);

        if (direction === "expand") {
            lo = frameBottom;
            hi = frameBottom + ANCHOR_REPAIR_MAX_EXPAND_IN;
        } else {
            lo = frameTop + ANCHOR_REPAIR_MIN_HEIGHT_IN;
            hi = frameBottom;
        }

        lastGoodBottom = -1;
        steps = 0;

        log(labelPrefix + " anchorBoundary[" + i + "] id=" + safe(bf.id) +
            " direction=" + direction +
            " bottom=" + safeNumberString(frameBottom) +
            " range=[" + safeNumberString(lo) + "," + safeNumberString(hi) + "]");

        while (steps < ANCHOR_REPAIR_MAX_STEPS) {
            mid = (lo + hi) / 2;
            steps += 1;

            FrameHostAdapter.setFrameBottom(lf, mid);
            try { targetStory.recompose(); } catch (eRecomp) {}

            state = checkBoundaryAnchorState(targetStory, beforeSnapshot, i);

            if (state.ok) {
                lastGoodBottom = mid;
                if (direction === "expand") {
                    hi = mid;
                } else {
                    lo = mid;
                }
            } else {
                if (state.curCount > state.targetCount) {
                    hi = mid;
                } else if (state.curCount < state.targetCount) {
                    lo = mid;
                } else {
                    if (direction === "expand") {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
            }

            if (steps <= 3 || state.ok || steps === ANCHOR_REPAIR_MAX_STEPS) {
                log(labelPrefix + " anchorBoundary[" + i + "] step=" + steps +
                    " mid=" + safeNumberString(mid) +
                    " count=" + state.curCount + "/" + state.targetCount +
                    " nextStarts=" + state.curNextStarts + "/" + state.targetNextStarts +
                    " ends=" + state.curEnds + "/" + state.targetEnds +
                    " ok=" + state.ok);
            }

            if (hi - lo < ANCHOR_REPAIR_PRECISION_IN) { break; }
        }

        if (lastGoodBottom > 0) {
            FrameHostAdapter.setFrameBottom(lf, lastGoodBottom);
            try { targetStory.recompose(); } catch (eRecomp2) {}

            if (!priorBoundariesHold(targetStory, beforeSnapshot, i)) {
                FrameHostAdapter.restoreFrameBounds(lf, saveBounds);
                try { targetStory.recompose(); } catch (eRecomp3) {}
                failed += 1;
                log(labelPrefix + " anchorBoundary[" + i + "] id=" + safe(bf.id) +
                    " ROLLBACK: prior boundaries disrupted after " + steps + " steps");
            } else {
                fixed += 1;
                log(labelPrefix + " anchorBoundary[" + i + "] id=" + safe(bf.id) +
                    " OK in " + steps + " steps (bottom " +
                    safeNumberString(frameBottom) + " -> " + safeNumberString(lastGoodBottom) + ")");
            }
        } else {
            FrameHostAdapter.restoreFrameBounds(lf, saveBounds);
            try { targetStory.recompose(); } catch (eRecomp4) {}
            failed += 1;
            log(labelPrefix + " anchorBoundary[" + i + "] id=" + safe(bf.id) +
                " FAILED after " + steps + " steps (restored original bounds)");
        }
    }

    if (fixed > 0 || failed > 0) {
        log(labelPrefix + " anchorBoundary " + (verifyOnly ? "VERIFY" : "REPAIR") +
            " complete: fixed=" + fixed + " skipped=" + skipped +
            " failed=" + failed + " verified=" + verified);
    }

    return { fixed: fixed, skipped: skipped, failed: failed, verified: verified };
}

// ---------------------------------------------------------------------------
// Post-repair overflow fix
// ---------------------------------------------------------------------------

var OVERFLOW_FIX_MAX_STEPS = 15;
// Bug#2: shares SINGLE_LINE_MAX_WIDTH_EXPAND_IN (8.0in) with ordinalRepair so a
// lineCount===1 frame (e.g. master page# "Page X of Y" → "X 页 Y") widens enough
// to keep CJK on one line instead of falling back to height-expand (2-line wrap).
// (See the SINGLE_LINE_MAX_WIDTH_EXPAND_IN definition near the ordinal caps.)
var OVERFLOW_FIX_MAX_WIDTH_EXPAND_IN = SINGLE_LINE_MAX_WIDTH_EXPAND_IN;
var OVERFLOW_FIX_MAX_HEIGHT_EXPAND_IN = 3.0;
var OVERFLOW_FIX_PRECISION_IN = 0.001;

function fixOverflowPass(targetStory, beforeSnapshot, labelPrefix, storyParaDeltas) {
    var i, beforeFrame, liveFrame, curOrd, targetLastOrd;
    var saveBounds, gb, frameLeft, frameRight, frameTop, frameBottom;
    var expandMode, fixed, skipped, failed;
    var lo, hi, mid, steps;
    var ordAdj;

    if (!beforeSnapshot || !beforeSnapshot.frames || !beforeSnapshot.frames.length) { return; }

    fixed = 0;
    skipped = 0;
    failed = 0;

    for (i = 0; i < beforeSnapshot.frames.length; i++) {
        beforeFrame = beforeSnapshot.frames[i];
        if (!beforeFrame) { continue; }

        liveFrame = FrameHostAdapter.getStoryTextContainerById(targetStory, beforeFrame.id);
        if (!liveFrame) { continue; }
        if (!liveFrame.overflows) {
            skipped += 1;
            continue;
        }

        targetLastOrd = beforeFrame.lastParaOrdinal;
        if (storyParaDeltas && storyParaDeltas.length && targetLastOrd >= 0) {
            ordAdj = computeOrdinalAdjustment(storyParaDeltas, targetLastOrd, "last");
            if (ordAdj !== 0) { targetLastOrd = targetLastOrd + ordAdj; }
        }
        curOrd = getLastParaOrdinalOfLiveFrame(liveFrame);
        if (targetLastOrd >= 0 && curOrd !== targetLastOrd) {
            skipped += 1;
            continue;
        }

        saveBounds = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);

        // For single-frame stories, try fit-to-content first.
        // Bug#2: but NOT for lineCount===1 frames. fit(FRAME_TO_CONTENT) grows
        // HEIGHT to fit a wrapped 2-line composition (e.g. master page number
        // "Page X of Y" → "X 页 Y" at its narrow width) and clears overflow at
        // 2 lines, short-circuiting BEFORE the lineCount===1 width-expand branch
        // below — leaving the frame permanently 2-line. A 1-line frame must go
        // straight to width-expand (widen to keep CJK on one line). The
        // width→bottom fallback still handles a too-short-but-wide 1-line frame
        // (height grows, stays 1 line). Multi-line single-frame stories keep the
        // fit-to-content fast path. host-verified 20260625_01.
        if (beforeFrame.storySingleFrame && beforeFrame.lineCount !== 1) {
            try {
                liveFrame.fit(indesign.FitOptions.FRAME_TO_CONTENT);
                try { targetStory.recompose(); } catch (eFit0) {}
            } catch (eFit1) {
                log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " fit-to-content threw: " + safe(eFit1 && eFit1.message ? eFit1.message : eFit1));
            }
            if (!liveFrame.overflows) {
                fixed += 1;
                log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " OK (fit-to-content)");
                continue;
            }
            var fitBounds = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);
            log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
                " fit-to-content did not clear overflow, fallback to binary search" +
                " before=[" + saveBounds.join(",") + "] after=[" + fitBounds.join(",") + "]");
            FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
            try { targetStory.recompose(); } catch (eFit2) {}
        }

        gb = FrameHostAdapter.copyBoundsArray(liveFrame.geometricBounds);
        frameTop = Number(gb[0]);
        frameLeft = Number(gb[1]);
        frameBottom = Number(gb[2]);
        frameRight = Number(gb[3]);

        if (beforeFrame.lineCount <= 0 || beforeFrame.empty) {
            expandMode = "bottom";
        } else if (beforeFrame.lineCount === 1) {
            expandMode = determineWidthExpandMode(liveFrame);
        } else {
            expandMode = "bottom";
        }

        log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
            " mode=" + expandMode + " beforeLines=" + safe(beforeFrame.lineCount));

        steps = 0;
        lo = 0;
        if (expandMode === "bottom") {
            hi = OVERFLOW_FIX_MAX_HEIGHT_EXPAND_IN;
        } else {
            hi = OVERFLOW_FIX_MAX_WIDTH_EXPAND_IN;
        }

        var lastGoodExpansion = -1;
        while (steps < OVERFLOW_FIX_MAX_STEPS) {
            mid = (lo + hi) / 2;
            steps += 1;

            gb = FrameHostAdapter.copyBoundsArray(saveBounds);
            if (expandMode === "bottom") {
                gb[2] = frameBottom + mid;
            } else if (expandMode === "width-right") {
                gb[3] = frameRight + mid;
            } else if (expandMode === "width-left") {
                gb[1] = frameLeft - mid;
            } else if (expandMode === "width-center") {
                gb[1] = frameLeft - mid;
                gb[3] = frameRight + mid;
            }
            liveFrame.geometricBounds = gb;
            try { targetStory.recompose(); } catch (e0) {}

            if (!liveFrame.overflows) {
                lastGoodExpansion = mid;
                hi = mid;
            } else {
                lo = mid;
            }
            if (hi - lo < OVERFLOW_FIX_PRECISION_IN) { break; }
        }

        if (lastGoodExpansion >= 0) {
            gb = FrameHostAdapter.copyBoundsArray(saveBounds);
            if (expandMode === "bottom") {
                gb[2] = frameBottom + lastGoodExpansion;
            } else if (expandMode === "width-right") {
                gb[3] = frameRight + lastGoodExpansion;
            } else if (expandMode === "width-left") {
                gb[1] = frameLeft - lastGoodExpansion;
            } else if (expandMode === "width-center") {
                gb[1] = frameLeft - lastGoodExpansion;
                gb[3] = frameRight + lastGoodExpansion;
            }
            liveFrame.geometricBounds = gb;
            try { targetStory.recompose(); } catch (e1) {}
        }

        if (!liveFrame.overflows) {
            fixed += 1;
            log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
                " OK in " + steps + " steps mode=" + expandMode);
        } else if (expandMode !== "bottom") {
            // Width failed: fallback to bottom
            FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
            try { targetStory.recompose(); } catch (eFb0) {}
            log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
                " width failed, fallback to bottom");

            lo = 0;
            hi = OVERFLOW_FIX_MAX_HEIGHT_EXPAND_IN;
            lastGoodExpansion = -1;
            steps = 0;
            while (steps < OVERFLOW_FIX_MAX_STEPS) {
                mid = (lo + hi) / 2;
                steps += 1;
                gb = FrameHostAdapter.copyBoundsArray(saveBounds);
                gb[2] = frameBottom + mid;
                liveFrame.geometricBounds = gb;
                try { targetStory.recompose(); } catch (eFb1) {}
                if (!liveFrame.overflows) {
                    lastGoodExpansion = mid;
                    hi = mid;
                } else {
                    lo = mid;
                }
                if (hi - lo < OVERFLOW_FIX_PRECISION_IN) { break; }
            }
            if (lastGoodExpansion >= 0) {
                gb = FrameHostAdapter.copyBoundsArray(saveBounds);
                gb[2] = frameBottom + lastGoodExpansion;
                liveFrame.geometricBounds = gb;
                try { targetStory.recompose(); } catch (eFb2) {}
            }
            if (!liveFrame.overflows) {
                fixed += 1;
                log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " OK (fallback bottom) in " + steps + " steps");
            } else {
                FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
                try { targetStory.recompose(); } catch (eFb3) {}
                failed += 1;
                log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
                    " FAILED mode=" + expandMode + "+bottom (restored original bounds)");
            }
        } else {
            FrameHostAdapter.restoreFrameBounds(liveFrame, saveBounds);
            try { targetStory.recompose(); } catch (e8) {}
            failed += 1;
            log(labelPrefix + " fixOverflow frame[" + i + "] id=" + safe(beforeFrame.id) +
                " FAILED mode=" + expandMode + " (restored original bounds)");
        }
    }

    if (fixed > 0 || failed > 0) {
        log(labelPrefix + " fixOverflow pass complete: fixed=" + fixed +
            " failed=" + failed + " skipped=" + skipped);
    }
}

// ---------------------------------------------------------------------------
// Full repair pipeline: runs all passes in order on a single story
// ---------------------------------------------------------------------------

var ORDINAL_REPAIR_MAX_PASSES = 3;

function repairStory(targetStory, beforeSnapshot, labelPrefix, storyParaDeltas) {
    var ordPassNum, ordPassRepaired;

    // 1. Pre-expand tiny frames
    expandTinyFramesForChinese(targetStory, beforeSnapshot, labelPrefix);

    // 2. Ordinal repair (multi-pass)
    for (ordPassNum = 1; ordPassNum <= ORDINAL_REPAIR_MAX_PASSES; ordPassNum++) {
        ordPassRepaired = ordinalRepairPass(targetStory, beforeSnapshot,
            labelPrefix + (ordPassNum > 1 ? " pass" + ordPassNum : ""), storyParaDeltas);
        if (ordPassRepaired === 0) {
            if (ordPassNum > 1) {
                log(labelPrefix + " ordinalRepair multi-pass converged at pass " + ordPassNum);
            }
            break;
        }
    }

    // 3. Anchor boundary restoration
    restoreAnchorBoundaries(targetStory, beforeSnapshot, labelPrefix, false);

    // 4. Overflow fix
    fixOverflowPass(targetStory, beforeSnapshot, labelPrefix, storyParaDeltas);

    // 5. Post-overflow anchor verify
    restoreAnchorBoundaries(targetStory, beforeSnapshot, labelPrefix + " post-overflow", false);

    // 6. Spillover cleanup
    ordPassRepaired = ordinalRepairPass(targetStory, beforeSnapshot,
        labelPrefix + " spillover-cleanup", storyParaDeltas);
    if (ordPassRepaired > 0) {
        log(labelPrefix + " spillover-cleanup fixed " + ordPassRepaired + " frame(s)");
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    init: init,
    expandTinyFramesForChinese: expandTinyFramesForChinese,
    ordinalRepairPass: ordinalRepairPass,
    restoreAnchorBoundaries: restoreAnchorBoundaries,
    fixOverflowPass: fixOverflowPass,
    repairStory: repairStory
};
