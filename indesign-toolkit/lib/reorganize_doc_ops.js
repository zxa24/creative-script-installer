"use strict";

/**
 * lib/reorganize_doc_ops.js
 *
 * Shared doc-mutating ops used by both reorganize_styles_inplace.idjs and
 * import_translations_v2.idjs (when its grouping panel enables them):
 *
 *   - splitSoftBreaksWithFormatChange : preclean phase 1 (soft → hard breaks
 *                                       across format changes)
 *   - revertSplitsThatCausedOverflow  : preclean phase 2 (revert splits
 *                                       that newly broke frames)
 *   - cleanupConsecutiveBulletsWithFormatChange : preclean phase 3 (demote
 *                                       split-half body paragraphs that
 *                                       inherit a bullet from the head half)
 *   - snapshotOverflowState / diffOverflowState : per-story overflow snapshot
 *                                       used by phase 2 + diagnostics
 *   - runPreflightSnapshot           : capture story-level snapshot to disk
 *                                       so RepairAfterApply.runRepair can
 *                                       restore frame fits if commit broke them
 *
 * UXP / ExtendScript compatibility:
 *   - Pure module + dependency injection
 *   - var only, no ES6+
 *   - All InDesign API + lib refs come through deps argument:
 *       deps.getCollectionItem
 *       deps.safe (optional; falls back to String(...))
 *       deps.ListType
 *       deps.RuntimePaths
 *       deps.SnapshotWriter
 *       deps.SnapshotUtils
 *       deps.StoryUtils
 *       deps.FileUtils
 */

// ─── helpers ─────────────────────────────────────────────────────

function _safe(deps, val) {
    if (deps && typeof deps.safe === "function") return deps.safe(val);
    try { return String(val); } catch (e) { return ""; }
}

function _charFormatKey(charObj, dimensions) {
    var d = dimensions || {};
    var key = [];
    if (!dimensions || d.fontFamily) {
        var fam = "?"; try { fam = String(charObj.appliedFont.fontFamily); } catch (e) {}
        key.push("F:" + fam);
    }
    if (!dimensions || d.fontStyle) {
        var st = "?"; try { st = String(charObj.fontStyle); } catch (e) {}
        key.push("S:" + st);
    }
    if (!dimensions || d.fontSize) {
        var sz = 0; try { sz = Math.round(Number(charObj.pointSize) * 10) / 10; } catch (e) {}
        key.push("Z:" + sz);
    }
    if (!dimensions || d.fillColor) {
        var c = "?"; try { c = String(charObj.fillColor.name); } catch (e) {}
        key.push("C:" + c);
    }
    return key.join("|");
}

function _storyOrAnyFrameOverflows(story) {
    try { if (story.overflows) return true; } catch (e) {}
    try {
        var fc = story.textContainers;
        for (var i = 0; i < fc.length; i++) {
            try { if (fc[i].overflows) return true; } catch (eF) {}
        }
    } catch (eC) {}
    return false;
}

// ─── snapshotOverflowState / diffOverflowState ───────────────────

function snapshotOverflowState(doc, deps) {
    var getCollectionItem = deps.getCollectionItem;
    var state = {};
    var stories = doc.stories;
    for (var s = 0; s < stories.length; s++) {
        var story = getCollectionItem(stories, s);
        if (!story || !story.isValid) continue;
        var sid = ""; try { sid = String(story.id); } catch (eSid) {}
        if (!sid) continue;
        state[sid] = _storyOrAnyFrameOverflows(story);
    }
    return state;
}

function diffOverflowState(beforeState, afterState) {
    var newlyOverflowing = [], newlyFixed = [];
    for (var sid in afterState) {
        if (!Object.prototype.hasOwnProperty.call(afterState, sid)) continue;
        if (afterState[sid] && !beforeState[sid]) newlyOverflowing.push(sid);
        else if (!afterState[sid] && beforeState[sid]) newlyFixed.push(sid);
    }
    return { newlyOverflowing: newlyOverflowing, newlyFixed: newlyFixed };
}

// ─── splitSoftBreaksWithFormatChange ─────────────────────────────

function splitSoftBreaksWithFormatChange(doc, dimensions, plog, deps) {
    var getCollectionItem = deps.getCollectionItem;
    var found = 0, split = 0, paragraphsBefore = 0, paragraphsAfter = 0;
    var splitRefsByStoryId = {};
    var splitDeltasByStoryId = {};
    var stories = doc.stories;
    if (plog) plog("preclean: scan " + stories.length + " stories for soft breaks");
    for (var s = 0; s < stories.length; s++) {
        var story = getCollectionItem(stories, s);
        if (!story || !story.isValid) continue;
        var sid = ""; try { sid = String(story.id); } catch (eSid) {}
        var contents = "";
        try { contents = String(story.contents || ""); } catch (e) {}
        if (contents.indexOf(" ") < 0 && contents.indexOf("\n") < 0) continue;
        try { paragraphsBefore += story.paragraphs.length; } catch (e) {}

        var paraEndOffsets = [];
        try {
            var nPB = story.paragraphs.length;
            var runningOffset = -1;
            for (var pi = 0; pi < nPB; pi++) {
                var paraI = story.paragraphs.item(pi);
                var paraLen = 0;
                try { paraLen = paraI.characters.length; } catch (eL) {}
                runningOffset += paraLen;
                paraEndOffsets.push(runningOffset);
            }
        } catch (ePO) {
            paraEndOffsets = null;
        }

        var chars = story.characters;
        var n = 0; try { n = chars.length; } catch (e) {}
        for (var c = n - 1; c >= 0; c--) {
            var ch = null;
            try { ch = chars.item(c); } catch (eItem) { continue; }
            var cstr = "";
            try { cstr = String(ch.contents || ""); } catch (eC) {}
            if (cstr !== "FORCED_LINE_BREAK") continue;
            found++;
            if (c <= 0 || c >= n - 1) continue;
            var before = null, after = null;
            try { before = chars.item(c - 1); after = chars.item(c + 1); } catch (eBA) { continue; }
            if (!before || !after) continue;
            var keyBefore = _charFormatKey(before, dimensions);
            var keyAfter = _charFormatKey(after, dimensions);
            if (keyBefore === keyAfter) continue;
            var preSplitParaIdx = -1;
            if (paraEndOffsets) {
                for (var pp = 0; pp < paraEndOffsets.length; pp++) {
                    if (c <= paraEndOffsets[pp]) { preSplitParaIdx = pp; break; }
                }
                if (preSplitParaIdx < 0) preSplitParaIdx = paraEndOffsets.length - 1;
            }
            try {
                ch.contents = "\r";
                split++;
                if (!splitRefsByStoryId[sid]) splitRefsByStoryId[sid] = [];
                if (!splitDeltasByStoryId[sid]) splitDeltasByStoryId[sid] = [];
                splitRefsByStoryId[sid].push(ch);
                // P1 fix (revises P3): keep deltas 1:1 with refs (one
                // entry per soft-break promotion) so revertSplitsThatCausedOverflow
                // can splice them in lock-step. Aggregation by paraIdx
                // moved to the CONSUMER side (cleanupConsecutiveBullets-
                // WithFormatChange aggregates at allowedIdx-build time).
                // The previous push-time aggregation broke the revert
                // path: 3 refs in same para mapped to ONE aggregated
                // delta, so reverting just the latest split would either
                // no-op the splice or wipe an unrelated story's delta.
                splitDeltasByStoryId[sid].push({
                    // #22 fix: emit canonical {paraIdx, tailCount} that
                    // cleanupConsecutiveBulletsWithFormatChange reads to
                    // build allowedIdx. Keep legacy {position, delta}
                    // aliases so any other reader is not broken.
                    paraIdx: preSplitParaIdx,
                    tailCount: 1,
                    position: preSplitParaIdx,
                    delta: 1,
                    type: "split-soft-break"
                });
            } catch (eRepl) {}
        }
        try { paragraphsAfter += story.paragraphs.length; } catch (e) {}
    }
    if (plog) plog("preclean: soft breaks found=" + found + " split=" + split
        + " paragraphs " + paragraphsBefore + " → " + paragraphsAfter);
    return {
        found: found, split: split,
        paragraphsBefore: paragraphsBefore, paragraphsAfter: paragraphsAfter,
        splitRefsByStoryId: splitRefsByStoryId,
        splitDeltasByStoryId: splitDeltasByStoryId
    };
}

// ─── revertSplitsThatCausedOverflow ──────────────────────────────

function revertSplitsThatCausedOverflow(doc, splitRefsByStoryId, splitDeltasByStoryId, beforeState, plog, deps) {
    var getCollectionItem = deps.getCollectionItem;
    var revertedTotal = 0;
    var storiesFixed = 0, storiesUnfixable = 0;
    var stories = doc.stories;
    for (var s = 0; s < stories.length; s++) {
        var story = getCollectionItem(stories, s);
        if (!story || !story.isValid) continue;
        var sid = ""; try { sid = String(story.id); } catch (eSid) {}
        if (!sid) continue;
        var refs = splitRefsByStoryId[sid];
        var deltas = splitDeltasByStoryId ? splitDeltasByStoryId[sid] : null;
        if (!refs || !refs.length) continue;
        var wasOverflow = !!beforeState[sid];
        var isOverflow = _storyOrAnyFrameOverflows(story);
        if (wasOverflow || !isOverflow) continue;
        var revertedHere = 0;
        for (var i = refs.length - 1; i >= 0 && _storyOrAnyFrameOverflows(story); i--) {
            try {
                refs[i].contents = String.fromCharCode(0x2028);
                revertedHere++;
                revertedTotal++;
                if (deltas && deltas.length > i) deltas.splice(i, 1);
            } catch (eR) {}
        }
        if (_storyOrAnyFrameOverflows(story)) storiesUnfixable++;
        else if (revertedHere > 0) storiesFixed++;
        if (plog) plog("preclean: story[" + sid + "] reverted " + revertedHere + " splits, fits=" + (!_storyOrAnyFrameOverflows(story)));
    }
    return { revertedTotal: revertedTotal, storiesFixed: storiesFixed, storiesUnfixable: storiesUnfixable };
}

// ─── cleanupConsecutiveBulletsWithFormatChange ───────────────────

// #18 fix: scope the demote-to-NO_LIST behavior to ONLY the paragraphs
// produced by THIS run's soft-break split. Previously this scanned every
// consecutive bullet in every story and demoted the second one whenever
// its first character format differed from its predecessor — which
// mistakenly clobbered legitimate lists where adjacent items have
// different fonts/colors/sizes (a common designer pattern).
//
// New contract: caller MUST pass `splitDeltasByStoryId` from the prior
// `splitSoftBreaksWithFormatChange` call. We then restrict the scan to
// stories that had any splits AND only consider paragraphs whose ordinal
// index sits within `[splitParaIdx, splitParaIdx + tailCount]` for some
// recorded split. Stories with no splits are skipped entirely.
//
// If the caller passes splitDeltasByStoryId === null, we honor backward
// compatibility (scan everything) but log a WARN so the unscoped path
// is at least visible. New callers should always pass the deltas.
function cleanupConsecutiveBulletsWithFormatChange(doc, dimensions, plog, beforeOverflowState, splitDeltasByStoryId, deps) {
    // BACK-COMPAT: old signature was (doc, dimensions, plog, beforeOverflowState, deps).
    // If `splitDeltasByStoryId` is the deps object (no splits passed), shift args.
    if (splitDeltasByStoryId && typeof splitDeltasByStoryId === "object"
            && (splitDeltasByStoryId.getCollectionItem || splitDeltasByStoryId.ListType)
            && deps === undefined) {
        deps = splitDeltasByStoryId;
        splitDeltasByStoryId = null;
        if (plog) plog("preclean: WARN bullet-cleanup called WITHOUT splitDeltasByStoryId — scanning ALL stories (legacy unsafe path)");
    }
    var getCollectionItem = deps.getCollectionItem;
    var ListType = deps.ListType;
    var demoted = 0, examined = 0;
    var revertedStories = 0, revertedChanges = 0;
    var stories = doc.stories;
    for (var s = 0; s < stories.length; s++) {
        var story = getCollectionItem(stories, s);
        if (!story || !story.isValid) continue;
        var sid = ""; try { sid = String(story.id); } catch (eSid) {}

        // #18 scoping: skip story unless it had splits this run (caller
        // opted into the old unsafe path by passing null/undefined).
        var splitsHere = splitDeltasByStoryId ? splitDeltasByStoryId[sid] : null;
        if (splitDeltasByStoryId && (!splitsHere || !splitsHere.length)) {
            continue;
        }
        // Build allowed paragraph index set: for each split (paraIdx, tailCount)
        // include indices [paraIdx + 1 .. paraIdx + tailCount] (the tail
        // paragraphs created by the split) so the demote logic only fires
        // there. If splitsHere is missing tailCount (older format), fall
        // back to "any paragraph after a split" (paraIdx + 1).
        var allowedIdx = null;
        if (splitsHere) {
            allowedIdx = {};
            // P3 + P1 fix: deltas are recorded 1:1 with refs at split
            // time (so revert can splice them in lock-step), but
            // cleanup needs ONE entry per pre-split paraIdx with
            // accumulated tailCount. Aggregate here.
            //
            // Why aggregate at consumer time:
            //   - revertSplitsThatCausedOverflow walks refs[] descending
            //     and splices the matching delta index. If we aggregated
            //     at push time, refs would outnumber deltas → splice
            //     would either no-op or wipe an unrelated story's entry.
            //   - the shared para_deltas writer (writeParaDeltasForRepair,
            //     used by BOTH the reorganize AND import paths since Bug#1/1A)
            //     + repair are fed by these per-split records (1:1 with the
            //     refs that actually survived revert), so aggregating only
            //     here keeps that channel honest.
            //
            // Then: deltas record PRE-split paraIdx, but cleanup iterates
            // the CURRENT story.paragraphs (post-split) by running index.
            // When multiple original paragraphs each got split, lower-
            // indexed splits shift all higher-indexed paragraphs downward
            // by their tailCount sum. Sort by paraIdx ASC + apply
            // cumulative shift so head = paraIdx + shift; tails at
            // [head+1 .. head+tailCount].
            var byPara = {};
            for (var __di = 0; __di < splitsHere.length; __di++) {
                var __d = splitsHere[__di];
                // #22 fix: accept BOTH the canonical {paraIdx, tailCount}
                // and the legacy {position, delta} field names so an
                // older or external caller can't accidentally produce
                // an empty allowedIdx (which would silently disable the
                // demote pass for all production splits).
                var __pi = (__d && typeof __d.paraIdx === "number") ? __d.paraIdx
                        : (__d && typeof __d.position === "number") ? __d.position : -1;
                var __tc = (__d && typeof __d.tailCount === "number") ? __d.tailCount
                        : (__d && typeof __d.delta === "number") ? __d.delta : 1;
                if (__pi < 0) continue;
                byPara[__pi] = (byPara[__pi] || 0) + __tc;
            }
            var sortedKeys = Object.keys(byPara).map(Number).sort(function (a, b) { return a - b; });
            var cumulativeShift = 0;
            for (var __si = 0; __si < sortedKeys.length; __si++) {
                var __pi2 = sortedKeys[__si];
                var __tc2 = byPara[__pi2];
                var head = __pi2 + cumulativeShift;
                for (var __k = head + 1; __k <= head + __tc2; __k++) { allowedIdx[__k] = true; }
                cumulativeShift += __tc2;
            }
        }

        var wasOverflow = beforeOverflowState ? !!beforeOverflowState[sid] : false;
        var paras = story.paragraphs;
        var nP = 0; try { nP = paras.length; } catch (e) {}
        var prevBulletedKey = null;
        var prevAnchorLeftIndent = 0;
        var changes = [];
        for (var p = 0; p < nP; p++) {
            var para = null;
            try { para = paras.item(p); } catch (eP) { continue; }
            if (!para) continue;
            var bullet = "NO_LIST";
            try { bullet = String(para.bulletsAndNumberingListType); } catch (eB) {}
            if (bullet === "NO_LIST") {
                prevBulletedKey = null;
                prevAnchorLeftIndent = 0;
                continue;
            }
            examined++;
            var fc = null;
            try { fc = para.characters.item(0); } catch (eC) { continue; }
            if (!fc) continue;
            var key = _charFormatKey(fc, dimensions);
            // #18 scoping: only demote if THIS paragraph is one we
            // produced via the soft-break split this run. Avoids
            // clobbering legitimate consecutive list items where the
            // designer intentionally varied font/color/size.
            var isSplitProduct = (allowedIdx === null) || allowedIdx[p] === true;
            if (prevBulletedKey !== null && key !== prevBulletedKey && isSplitProduct) {
                try {
                    var oldLI_d = 0, oldFI_d = 0;
                    try { oldLI_d = Number(para.leftIndent) || 0; } catch (eOL) {}
                    try { oldFI_d = Number(para.firstLineIndent) || 0; } catch (eOF) {}
                    para.bulletsAndNumberingListType = ListType.NO_LIST;
                    try { para.leftIndent = prevAnchorLeftIndent; } catch (eLI) {}
                    try { para.firstLineIndent = 0; } catch (eFI) {}
                    changes.push({ para: para, kind: "demoted", oldBullet: bullet, oldLeftIndent: oldLI_d, oldFirstLineIndent: oldFI_d });
                    demoted++;
                    prevBulletedKey = null;
                    prevAnchorLeftIndent = 0;
                } catch (eD) {}
            } else {
                prevBulletedKey = key;
                try { prevAnchorLeftIndent = Number(para.leftIndent) || 0; } catch (eAL) {}
            }
        }
        if (!wasOverflow && changes.length > 0 && _storyOrAnyFrameOverflows(story)) {
            for (var ci = changes.length - 1; ci >= 0; ci--) {
                var ch = changes[ci];
                try { ch.para.leftIndent = ch.oldLeftIndent; } catch (eR1) {}
                try { ch.para.firstLineIndent = ch.oldFirstLineIndent; } catch (eR2) {}
                if (ch.kind === "demoted" && ch.oldBullet === "BULLET_LIST") {
                    try { ch.para.bulletsAndNumberingListType = ListType.BULLET_LIST; } catch (eR3) {}
                } else if (ch.kind === "demoted" && ch.oldBullet === "NUMBERED_LIST") {
                    try { ch.para.bulletsAndNumberingListType = ListType.NUMBERED_LIST; } catch (eR4) {}
                }
                revertedChanges++;
            }
            revertedStories++;
            if (plog) plog("preclean: story[" + sid + "] cleanup caused overflow → reverted " + changes.length + " changes, fits=" + (!_storyOrAnyFrameOverflows(story)));
        }
    }
    if (plog) plog("preclean: bullet-cleanup examined=" + examined + " demoted=" + demoted
        + " revertedStories=" + revertedStories + " revertedChanges=" + revertedChanges);
    return { demoted: demoted, examined: examined, indentInherited: 0,
        revertedStories: revertedStories, revertedChanges: revertedChanges };
}

// ─── runPreflightSnapshot ────────────────────────────────────────

function runPreflightSnapshot(doc, plog, deps) {
    var RuntimePaths = deps.RuntimePaths;
    var SnapshotWriter = deps.SnapshotWriter;
    var SnapshotUtils = deps.SnapshotUtils;
    var StoryUtils = deps.StoryUtils;
    var FileUtils = deps.FileUtils;

    var DATA_DIR = RuntimePaths.getDataDir();
    var snapshotPaths = SnapshotWriter.buildSnapshotPaths(doc.name, DATA_DIR);
    var storyIds = StoryUtils.collectRepairableStories(doc, function (m) { if (plog) plog("preflight: " + m); });
    if (plog) plog("preflight: collectRepairableStories → " + storyIds.length);
    if (!storyIds.length) {
        if (plog) plog("preflight: no repairable stories — snapshot empty");
        return null;
    }
    // #24 fix: split into THREE phases so "preflight failed → no doc
    // mutation" is actually true.
    //   Phase A — capture snapshots (read-only; no doc mutation).
    //   Phase B — write snapshot to disk; on failure throw with ZERO
    //             frame geometry mutated yet.
    //   Phase C — expand geometry-split frames (doc mutation; happens
    //             only after the snapshot is safely on disk).
    // Previously expand happened inline with capture (line 382) BEFORE
    // the disk write, so a write failure left the live frames already
    // mutated — contradicting the "aborting before doc mutation" message
    // the caller surfaces in alerts.
    var snapshots = {};
    var storyOrder = [];
    var perStoryLive = {};
    var perStorySnap = {};

    // Phase A — capture only.
    for (var i = 0; i < storyIds.length; i++) {
        var sid = storyIds[i];
        var liveStory = StoryUtils.resolveLiveStoryById(doc, sid);
        if (!StoryUtils.isUsableStoryObject(liveStory)) continue;
        var snap = SnapshotUtils.captureStorySnapshot(liveStory);
        snapshots[sid] = SnapshotUtils.serializeStorySnapshot(snap);
        storyOrder.push(sid);
        perStoryLive[sid] = liveStory;
        perStorySnap[sid] = snap;
    }
    var capturedAt = new Date().toISOString();
    var payload = {
        schemaVersion: 1,
        capturedAt: capturedAt,
        documentName: _safe(deps, doc.name),
        storyCount: storyOrder.length,
        storyOrder: storyOrder,
        stories: snapshots
    };

    // Phase B — write to disk BEFORE any doc mutation.
    var json = JSON.stringify(payload, null, 2);
    var ok1 = FileUtils.writeTextFile(snapshotPaths.docSpecific, json);
    var ok2 = FileUtils.writeTextFile(snapshotPaths.latest, json);
    if (!ok1 && !ok2) {
        // #17 + #24 fix: snapshot write failure is FATAL when safety is on.
        // We're still in Phase B — geom expand has NOT yet run, so the doc
        // is genuinely untouched. Throw lets the caller's try/catch (#13)
        // turn this into a real fail-closed abort.
        var lastErr = null;
        try { lastErr = FileUtils.getLastFileUtilsError && FileUtils.getLastFileUtilsError(); } catch (eGE) {}
        var errMsg = "snapshot write FAILED at both paths"
            + " (docSpecific=" + snapshotPaths.docSpecific
            + ", latest=" + snapshotPaths.latest
            + (lastErr ? "; lastError=" + (lastErr.message || lastErr.code || JSON.stringify(lastErr)) : "")
            + ")";
        if (plog) plog("preflight: " + errMsg);
        throw new Error(errMsg);
    }

    // Phase C — geometry-split frame expand (doc mutation, post-write).
    // The on-disk snapshot keeps PRE-EXPAND bounds, which is the true
    // "before" reference for repair. The in-memory snap object is
    // mutated to post-expand bounds by expandGeometrySplitFramesPreApply
    // (and is no longer referenced by anything outside this function).
    for (var j = 0; j < storyOrder.length; j++) {
        var sidJ = storyOrder[j];
        try {
            SnapshotUtils.expandGeometrySplitFramesPreApply(
                perStoryLive[sidJ], perStorySnap[sidJ], "story[" + j + "]",
                function (m) { if (plog) plog("preflight: " + m); }
            );
        } catch (eExp) {
            if (plog) plog("preflight: expand WARN story[" + j + "] " + (eExp && eExp.message ? eExp.message : eExp));
        }
    }

    return {
        snapshotPath: snapshotPaths.latest,
        snapshotPathDocSpecific: snapshotPaths.docSpecific,
        storyCount: storyOrder.length,
        capturedAt: capturedAt   // #23 fix: caller can bind paraDeltas to this run
    };
}

// ─── writeParaDeltasForRepair (Bug#1 / 1A — para_deltas contract bridge) ──────
//
// Single canonical writer for para_deltas_latest.json — the file
// repair_after_apply.js:loadParaDeltas reads to compensate frame ordinals
// for soft-break splits (computeOrdinalAdjustment, type "split-soft-break").
//
// CONTRACT-DRIFT FIX: splitSoftBreaksWithFormatChange produces the per-split
// deltas into an IN-MEMORY map (splitDeltasByStoryId / ctx.splitDeltasByStoryId),
// but repair reads them from the FILE. The reorganize_styles_inplace path wrote
// this file; the IMPORT path (import_integrated / import_translations_v2) did
// NOT — so a soft-break-split frame (forced LINE break → \r when formats differ
// across it, e.g. page-2 title 准备工作\r副标, master footer) reached repair with
// a stale pre-split snapshot ordinal and computeOrdinalAdjustment got 0 deltas →
// ordinalRepair's final pass shrank the frame to restore the snapshot's 1-para
// distribution → the 2nd paragraph went overset. Routing every caller (both
// import entries + reorganize) through this one writer removes the divergent
// channel so the import path can never again "forget" to feed repair.
// See findings.md#para-deltas-contract-drift / DEV_LOG 2026-06-25.
//
// Bind to THIS run's snapshot (documentName + snapshotCapturedAt) so repair's
// staleness guard (repair_after_apply.js:769/773) keeps the deltas instead of
// discarding a prior run's file. Always write (even {} when no splits) so a
// stale prior file is overwritten rather than silently consumed.
//
// deps: { RuntimePaths, FileUtils, generatedBy? }
function writeParaDeltasForRepair(doc, splitDeltasByStoryId, snapshotInfo, deps) {
    var RuntimePaths = deps.RuntimePaths;
    var FileUtils = deps.FileUtils;
    var storyDeltas = {};
    var sdById = splitDeltasByStoryId || {};
    var sid, arr, k;
    for (sid in sdById) {
        if (!Object.prototype.hasOwnProperty.call(sdById, sid)) continue;
        arr = sdById[sid];
        if (!arr || !arr.length) continue;
        // Sort by position ascending per computeOrdinalAdjustment contract.
        arr.sort(function (a, b) { return (a.position - b.position); });
        storyDeltas[sid] = arr;
    }
    var nKeys = 0;
    for (k in storyDeltas) { if (Object.prototype.hasOwnProperty.call(storyDeltas, k)) nKeys++; }
    var payload = {
        documentName: String(doc.name),
        snapshotCapturedAt: snapshotInfo ? snapshotInfo.capturedAt : null,
        snapshotPath: snapshotInfo ? snapshotInfo.snapshotPathDocSpecific : null,
        storyDeltas: storyDeltas,
        generatedBy: (deps && deps.generatedBy) || "import_pipeline",
        generatedAt: new Date().toISOString()
    };
    var DATA_DIR_PD = String(RuntimePaths.getDataDir()).replace(/\\/g, "/");
    var pdPath = DATA_DIR_PD.replace(/\/$/, "") + "/para_deltas_latest.json";
    var ok = false, err = null;
    try {
        ok = FileUtils.writeTextFile(pdPath, JSON.stringify(payload, null, 2));
        if (!ok) {
            try { err = FileUtils.getLastFileUtilsError && FileUtils.getLastFileUtilsError(); } catch (eGE) {}
            if (!err) err = { message: "writeTextFile returned false" };
        }
    } catch (eW) {
        ok = false;
        err = eW;
    }
    return {
        ok: !!ok,
        path: pdPath,
        storiesWritten: nKeys,
        snapshotCapturedAt: payload.snapshotCapturedAt,
        error: err
    };
}

module.exports = {
    splitSoftBreaksWithFormatChange:           splitSoftBreaksWithFormatChange,
    revertSplitsThatCausedOverflow:            revertSplitsThatCausedOverflow,
    cleanupConsecutiveBulletsWithFormatChange: cleanupConsecutiveBulletsWithFormatChange,
    snapshotOverflowState:                     snapshotOverflowState,
    diffOverflowState:                         diffOverflowState,
    runPreflightSnapshot:                      runPreflightSnapshot,
    writeParaDeltasForRepair:                  writeParaDeltasForRepair,
    _charFormatKey:                            _charFormatKey,
    _storyOrAnyFrameOverflows:                 _storyOrAnyFrameOverflows
};
