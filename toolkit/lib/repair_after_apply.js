"use strict";

// lib/repair_after_apply.js — Repair module (extracted from repair_after_apply.idjs)
// Exports: { runRepair, resetState }
// Entry point: repair_after_apply.idjs (thin wrapper)

var RuntimePaths = require("./runtime_paths.js");
var joinPath = RuntimePaths.joinPath;

var fs = require("fs");
var indesign = require("indesign");
var app = indesign.app;
var utils = require("./utils.js");
var safe = utils.safe;
var safeNumberString = utils.safeNumberString;
var pushUnique = utils.pushUnique;
var getCollectionItem = utils.getCollectionItem;
var trySet = utils.trySet;
var FileUtils = require("./file_utils.js");
var StoryUtils = require("./story_utils.js");
var SnapshotUtils = require("./snapshot_utils.js");
var Contract = require("./frame_repair_contract.js");
var FramePartition = require("./frame_partition.js");
var FrameHostAdapter = require("./frame_host_adapter.js");
var SnapshotWriter = require("./snapshot_writer.js");

var ACCEPTANCE_BUNDLE_SUFFIX = "_repair_after_apply_bundle";

// Module-level mutable state — reset in runRepair() for module cache safety
var BASE_DIR = "";
var DATA_DIR = "";
var LATEST_SNAPSHOT_PATH = "";
var PARA_DELTAS_PATH = "";
var DEFAULT_OUT_LOG = "";
var ACCEPTANCE_WATCH_PAGES = null;
var lines = [];
var statusLine = "";
var OUT_PATH = "";
var acceptanceBundle = null;
var acceptanceBundleFinalized = false;
var targetDocRef = null;

// ---------------------------------------------------------------------------
// Logging (local — each script maintains its own lines array)
// ---------------------------------------------------------------------------

function log(text) {
    lines.push(utils.getTimestamp() + " " + String(text));
}

// Aliases for shared module functions used throughout this file
var isUsableStoryObject = StoryUtils.isUsableStoryObject;
var getOutputDirectory = FileUtils.getOutputDirectory;
var getOutputFileNameWithoutExtension = FileUtils.getOutputFileNameWithoutExtension;
var getPathFileName = FileUtils.getPathFileName;
// UXP-safe best-effort file ops (sync signatures, fire-and-forget delete).
// The legacy @node-only sync delete/move helpers threw in UXP (silent leak /
// duplicate temp left behind); these are the UXP-safe drop-ins.
var removeFileBestEffort = FileUtils.removeFileBestEffort;
var moveFileBestEffort = FileUtils.moveFileBestEffort;
var writeJsonFile = FileUtils.writeJsonFile;
var writeTextFile = FileUtils.writeTextFile;
var getLastFileUtilsError = FileUtils.getLastFileUtilsError;

function resolveTargetDocumentFocus(targetDoc) {
    var win = null;
    if (!targetDoc) { return false; }
    try {
        if (targetDoc.layoutWindows && targetDoc.layoutWindows.length) {
            win = getCollectionItem(targetDoc.layoutWindows, 0);
        }
    } catch (e0) {}
    try {
        if (!win && app.layoutWindows && app.layoutWindows.length) {
            win = getCollectionItem(app.layoutWindows, 0);
        }
    } catch (e1) {}
    if (win) {
        try { win.activate(); return true; } catch (e2) {}
    }
    try { app.activeDocument = targetDoc; return true; } catch (e3) {}
    return false;
}

function describeLastFileUtilsError() {
    var err = null;
    try { err = getLastFileUtilsError(); } catch (e0) {}
    if (!err) { return ""; }
    return [
        safe(err.operation),
        safe(err.path),
        safe(err.code),
        safe(err.message)
    ].join(" | ");
}

function recordWriteFailure(kind, pathValue, error) {
    var detail = safe(error && error.message ? error.message : error);
    var lastErr = describeLastFileUtilsError();
    log("WRITE FAILED [" + safe(kind) + "]: " + safe(pathValue) + (detail ? " error=" + detail : ""));
    if (lastErr) {
        log("WRITE FAILED DETAIL [" + safe(kind) + "]: " + lastErr);
    }
}

function writeJsonFileObserved(pathValue, payload, kind) {
    try {
        writeJsonFile(pathValue, payload);
        return true;
    } catch (e0) {
        recordWriteFailure(kind || "json", pathValue, e0);
    }
    return false;
}

function writeTextFileObserved(pathValue, contents, kind) {
    if (writeTextFile(pathValue, contents)) {
        return true;
    }
    recordWriteFailure(kind || "text", pathValue, null);
    return false;
}

// ---------------------------------------------------------------------------
// Acceptance bundle
// ---------------------------------------------------------------------------

function ensureAcceptanceBundle() {
    var outDir, outBase;
    if (acceptanceBundle) { return acceptanceBundle; }
    outDir = getOutputDirectory(OUT_PATH);
    outBase = getOutputFileNameWithoutExtension(OUT_PATH) + ACCEPTANCE_BUNDLE_SUFFIX;
    acceptanceBundle = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString ? new Date().toISOString() : String(new Date()),
        logPath: OUT_PATH,
        outputDir: outDir,
        bundleBase: outBase,
        imageOutputDir: outDir,
        documentName: "",
        pages: {},
        storyIds: [],
        stories: [],
        images: [],
        exports: [],
        errors: [],
        summary: { pass: false, issues: [] },
        geometryRestoredFrameIds: {}
    };
    return acceptanceBundle;
}

function buildAcceptanceFilePath(suffix, extension) {
    var bundle = ensureAcceptanceBundle();
    return joinPath(bundle.outputDir, bundle.bundleBase + suffix + extension);
}

function buildAcceptanceImagePath(pageName, kind) {
    var bundle = ensureAcceptanceBundle();
    return joinPath(bundle.outputDir, bundle.bundleBase + "_page_" + safe(pageName) + "_" + safe(kind) + ".png");
}

function pushBundleIssue(message) {
    pushUnique(ensureAcceptanceBundle().summary.issues, safe(message));
}

function ensureBundlePage(pageName) {
    var bundle = ensureAcceptanceBundle();
    var key = safe(pageName);
    if (!bundle.pages[key]) {
        bundle.pages[key] = { pass: true, issues: [], frames: [], geometrySplitUnresolved: [] };
    }
    return bundle.pages[key];
}

function pushPageIssue(pageName, message) {
    var pageRecord = ensureBundlePage(pageName);
    pageRecord.pass = false;
    pushUnique(pageRecord.issues, safe(message));
    pushBundleIssue("page " + safe(pageName) + ": " + safe(message));
}

function pushPageGeometrySplitUnresolved(pageName, frameId) {
    var pageRecord = ensureBundlePage(pageName);
    pushUnique(pageRecord.geometrySplitUnresolved, "geometry-split-unresolved frame " + safe(frameId));
    log("geometry-split-unresolved frame " + safe(frameId) + " on page " + safe(pageName));
}

// Snapshot capture — delegated to shared SnapshotUtils
var sampleFrameSnapshot = SnapshotUtils.sampleFrameSnapshot;
var captureStorySnapshot = SnapshotUtils.captureStorySnapshot;

function getSnapshotPartition(snapshot) {
    return snapshot && snapshot.partition ? snapshot.partition : snapshot;
}

function getSnapshotDisplaySignature(snapshot) {
    return snapshot && snapshot.displaySignature ? snapshot.displaySignature : snapshot;
}

// ---------------------------------------------------------------------------
// 从 JSON 文件恢复 before 快照
// ---------------------------------------------------------------------------

function deserializeStorySnapshot(raw) {
    var frames = [];
    var i, rf;
    if (!raw || !raw.frames) { return null; }
    for (i = 0; i < raw.frames.length; i++) {
        rf = raw.frames[i];
        frames.push(Contract.createFrameSnapshot(rf));
    }
    return {
        storyId: safe(raw.storyId),
        frameCount: frames.length,
        frames: frames
    };
}

function loadBeforeSnapshot(snapshotPath) {
    var raw, parsed;
    try {
        raw = fs.readFileSync(snapshotPath, "utf8");
    } catch (e0) {
        log("ERROR: cannot read snapshot file: " + snapshotPath);
        log("Error: " + safe(e0 && e0.message ? e0.message : e0));
        return null;
    }
    try {
        parsed = JSON.parse(raw);
    } catch (e1) {
        log("ERROR: snapshot file is not valid JSON: " + snapshotPath);
        return null;
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// Para-delta ordinal adjustment
// ---------------------------------------------------------------------------

function loadParaDeltas(deltasPath) {
    var raw, parsed;
    try {
        raw = fs.readFileSync(deltasPath, "utf8");
    } catch (e0) {
        return null; // no delta file is normal (append/trim-only runs)
    }
    try {
        parsed = JSON.parse(raw);
    } catch (e1) {
        log("WARNING: para deltas file is not valid JSON: " + deltasPath);
        return null;
    }
    if (!parsed || !parsed.storyDeltas) { return null; }
    return parsed;
}

// Compute cumulative delta for a given target ordinal.
// deltas = [{position, delta, type}, ...] sorted by position ascending.
// All positions are in original (pre-mutation) ordinal space.
// Returns the adjustment value to add to the original targetOrd.
//
// `kind` (optional, default 'last') disambiguates "ordinal points to start vs
// end of paragraph P" for split-style deltas where a paragraph is internally
// subdivided. Defaults to 'last' for backward compatibility (most call sites
// adjust frame end ordinals).
//
// Type semantics:
//   "insert"           — new paragraph appears at index position. Existing
//                        ordinals >= position shift by +delta. Condition:
//                        position <= targetOrd (both 'last' and 'first' kinds).
//   "delete"           — paragraph at index position is removed. Same shift
//                        condition as insert (with negative delta).
//   "split-soft-break" — paragraph at index position is internally split into
//                        two paragraphs (e.g. forced-line-break promoted to
//                        \r when format differs across the break). Original
//                        end-of-P maps to end-of-(P+1) → 'last' adjusts at
//                        position <= targetOrd. Original start-of-P maps to
//                        start-of-P (unchanged, the new paragraph appears
//                        AFTER the original's start) → 'first' adjusts only
//                        at position < targetOrd (strict). Without this
//                        distinction, frames whose last paragraph is the
//                        very paragraph being split fail to extend into the
//                        post-split second half.
function computeOrdinalAdjustment(deltas, targetOrd, kind) {
    if (!deltas || !deltas.length) { return 0; }
    var includeBoundary = (kind !== "first");   // default 'last' if omitted
    var cumulative = 0;
    var i, d, hits;
    for (i = 0; i < deltas.length; i++) {
        d = deltas[i];
        if (d.type === "split-soft-break") {
            hits = (d.position === targetOrd) ? includeBoundary : (d.position < targetOrd);
        } else {
            // Existing insert/delete-at-boundary semantics
            hits = (d.position <= targetOrd);
        }
        if (hits) {
            cumulative += d.delta;
        }
    }
    return cumulative;
}

var resolveLiveStoryById = StoryUtils.resolveLiveStoryById;

// ---------------------------------------------------------------------------
// Acceptance: 逐帧记录与 boundary delta 检查
// ---------------------------------------------------------------------------

function captureFrameAcceptanceRecord(frameSnapshot) {
    if (!frameSnapshot) { return null; }
    return {
        frameId: safe(frameSnapshot.id),
        page: safe(frameSnapshot.pageName),
        firstParaStart: frameSnapshot.firstParaStart,
        lastParaStart: frameSnapshot.lastParaStart,
        firstParaOrdinal: frameSnapshot.firstParaOrdinal,
        lastParaOrdinal: frameSnapshot.lastParaOrdinal,
        firstChar: frameSnapshot.firstCharIdx,
        lastChar: frameSnapshot.lastCharIdx,
        lineCount: frameSnapshot.lineCount,
        firstLine: safe(frameSnapshot.firstLine),
        lastLine: safe(frameSnapshot.lastLine),
        hasObjectMarker: !!frameSnapshot.hasObjectMarker,
        overflows: !!frameSnapshot.overflows
    };
}

function getBeforeFrameRecord(pageRecord, frameId) {
    var j, entry;
    for (j = 0; j < pageRecord.frames.length; j++) {
        entry = pageRecord.frames[j];
        if (entry.data && String(entry.data.frameId) === String(frameId) &&
                entry.stage && entry.stage.indexOf("_before") >= 0) {
            return entry.data;
        }
    }
    return null;
}

function recordSnapshotForAcceptance(stage, snapshot, beforeSnapshotFrames, storyParaDeltas) {
    var bundle = ensureAcceptanceBundle();
    var i, frameRecord, pageRecord, beforeRec, isAfterRepair;
    var bFirst, aFirst, delta, useOrdinal, ordAdj;

    if (!snapshot || !snapshot.frames) { return; }
    isAfterRepair = stage && stage.indexOf("_after_repair") >= 0;

    for (i = 0; i < snapshot.frames.length; i++) {
        frameRecord = captureFrameAcceptanceRecord(snapshot.frames[i]);
        if (!frameRecord) { continue; }
        if (ACCEPTANCE_WATCH_PAGES && ACCEPTANCE_WATCH_PAGES.indexOf(frameRecord.page) < 0) { continue; }

        pageRecord = ensureBundlePage(frameRecord.page);
        pageRecord.frames.push({ stage: stage, data: frameRecord });

        // M1-2: 区分预存 overflow 与新引入 overflow
        if (frameRecord.overflows) {
            beforeRec = getBeforeFrameRecord(pageRecord, frameRecord.frameId);
            if (beforeRec && beforeRec.overflows) {
                log("pre-existing-overflow frame " + frameRecord.frameId + " during " + stage);
            } else {
                pushPageIssue(frameRecord.page, "overflow in frame " + frameRecord.frameId + " during " + stage);
            }
        }

        // M1-1 / P3-2: _after_repair 与 _before 比较 boundary delta
        // 优先使用 firstParaOrdinal（文字替换后仍稳定），fallback 到 firstChar
        if (isAfterRepair) {
            beforeRec = getBeforeFrameRecord(pageRecord, frameRecord.frameId);
            if (beforeRec) {
                useOrdinal = (beforeRec.firstParaOrdinal !== undefined && beforeRec.firstParaOrdinal !== null &&
                    frameRecord.firstParaOrdinal !== undefined && frameRecord.firstParaOrdinal !== null);
                if (useOrdinal) {
                    // When para deltas exist, use lastParaOrdinal for boundary check
                    // because ordinalRepairPass targets lastParaOrdinal. firstParaOrdinal
                    // can be a NEW (inserted) paragraph whose ordinal doesn't map from
                    // the original snapshot, causing false positives.
                    if (storyParaDeltas && storyParaDeltas.length &&
                        beforeRec.lastParaOrdinal !== undefined && beforeRec.lastParaOrdinal !== null &&
                        frameRecord.lastParaOrdinal !== undefined && frameRecord.lastParaOrdinal !== null) {
                        bFirst = beforeRec.lastParaOrdinal;
                        aFirst = frameRecord.lastParaOrdinal;
                        if (bFirst >= 0) {
                            // Boundary check uses lastParaOrdinal here (per the
                            // surrounding comment) — adjust with 'last' kind.
                            ordAdj = computeOrdinalAdjustment(storyParaDeltas, bFirst, "last");
                            if (ordAdj !== 0) {
                                bFirst = bFirst + ordAdj;
                            }
                        }
                        if (bFirst !== -1 && aFirst === -1) {
                            log("boundary-lost frame " + frameRecord.frameId + " lastParaOrdinal before=" + bFirst + " after=-1 during " + stage);
                            if (bundle.geometryRestoredFrameIds && bundle.geometryRestoredFrameIds[String(frameRecord.frameId)]) {
                                pushPageGeometrySplitUnresolved(frameRecord.page, frameRecord.frameId);
                            } else {
                                pushPageIssue(frameRecord.page, "boundary-lost frame " + frameRecord.frameId + " during " + stage);
                            }
                        } else if (bFirst !== -1 && aFirst !== -1 && aFirst !== bFirst) {
                            log("boundary-delta frame " + frameRecord.frameId + " lastParaOrdinal before=" + bFirst + " after=" + aFirst + " delta=" + (aFirst - bFirst) + " during " + stage);
                            pushPageIssue(frameRecord.page, "boundary-delta frame " + frameRecord.frameId + " lastParaOrdinal delta=" + (aFirst - bFirst) + " during " + stage);
                        }
                    } else {
                        // No deltas: use firstParaOrdinal as before
                        bFirst = beforeRec.firstParaOrdinal;
                        aFirst = frameRecord.firstParaOrdinal;
                        if (bFirst !== -1 && aFirst === -1) {
                            log("boundary-lost frame " + frameRecord.frameId + " paraOrdinal before=" + bFirst + " after=-1 during " + stage);
                            if (bundle.geometryRestoredFrameIds && bundle.geometryRestoredFrameIds[String(frameRecord.frameId)]) {
                                pushPageGeometrySplitUnresolved(frameRecord.page, frameRecord.frameId);
                            } else {
                                pushPageIssue(frameRecord.page, "boundary-lost frame " + frameRecord.frameId + " during " + stage);
                            }
                        } else if (bFirst !== -1 && aFirst !== -1 && aFirst !== bFirst) {
                            log("boundary-delta frame " + frameRecord.frameId + " paraOrdinal before=" + bFirst + " after=" + aFirst + " delta=" + (aFirst - bFirst) + " during " + stage);
                            pushPageIssue(frameRecord.page, "boundary-delta frame " + frameRecord.frameId + " paraOrdinal delta=" + (aFirst - bFirst) + " during " + stage);
                        }
                    }
                } else {
                    bFirst = beforeRec.firstChar;
                    aFirst = frameRecord.firstChar;
                    if (bFirst !== -1 && aFirst === -1) {
                        log("boundary-lost frame " + frameRecord.frameId + " firstChar before=" + bFirst + " after=-1 during " + stage);
                        if (bundle.geometryRestoredFrameIds && bundle.geometryRestoredFrameIds[String(frameRecord.frameId)]) {
                            pushPageGeometrySplitUnresolved(frameRecord.page, frameRecord.frameId);
                        } else {
                            pushPageIssue(frameRecord.page, "boundary-lost frame " + frameRecord.frameId + " during " + stage);
                        }
                    } else if (bFirst !== -1 && aFirst !== -1) {
                        delta = aFirst - bFirst;
                        if (delta < 0) { delta = -delta; }
                        if (delta > 2) {
                            log("boundary-delta frame " + frameRecord.frameId + " firstChar before=" + bFirst + " after=" + aFirst + " delta=" + (aFirst - bFirst) + " during " + stage);
                            pushPageIssue(frameRecord.page, "boundary-delta frame " + frameRecord.frameId + " firstChar delta=" + (aFirst - bFirst) + " during " + stage);
                        }
                    }
                }
            }
        }
    }
    pushUnique(bundle.storyIds, safe(snapshot.storyId));
}

function logStorySnapshot(prefix, snapshot) {
    SnapshotUtils.logStorySnapshot(prefix, snapshot, log);
}

// ---------------------------------------------------------------------------
// Frame repair engine (extracted module)
// ---------------------------------------------------------------------------
var FrameRepair = require("./frame_repair.js");
// FrameRepair.init() is called inside runRepair() with fresh log context

// ---------------------------------------------------------------------------
// 图像导出
// ---------------------------------------------------------------------------

function cleanupExportArtifactsForBase(outPath, keepBase) {
    var dir = getOutputDirectory(outPath);
    var baseName = getPathFileName(outPath);
    var stem = baseName.replace(/\.png$/i, "");
    var entries, i, name;
    try { entries = fs.readdirSync(dir); } catch (e0) { return; }
    for (i = 0; i < entries.length; i++) {
        name = safe(entries[i]);
        if (name === baseName) {
            if (!keepBase) { removeFileBestEffort(joinPath(dir, name)); }
            continue;
        }
        if (name.indexOf(stem) === 0 && /^\d+\.png$/i.test(name.substring(stem.length))) {
            removeFileBestEffort(joinPath(dir, name));
        }
    }
}

function listExportArtifactsForBase(outPath) {
    var dir = getOutputDirectory(outPath);
    var baseName = getPathFileName(outPath);
    var stem = baseName.replace(/\.png$/i, "");
    var matches = [];
    var entries, i, name, suffix;
    try { entries = fs.readdirSync(dir); } catch (e0) { return matches; }
    for (i = 0; i < entries.length; i++) {
        name = safe(entries[i]);
        if (name === baseName) {
            matches.push({ name: name, order: 1, path: joinPath(dir, name) });
            continue;
        }
        if (name.indexOf(stem) !== 0) { continue; }
        suffix = name.substring(stem.length);
        if (!/^\d+\.png$/i.test(suffix)) { continue; }
        matches.push({ name: name, order: Number(suffix.replace(/\.png$/i, "")), path: joinPath(dir, name) });
    }
    matches.sort(function (a, b) { return a.order - b.order; });
    return matches;
}

function exportAllPageImages(doc, kind) {
    var bundle = ensureAcceptanceBundle();
    var rawOutPath, pngFormat, exportTarget, pageCount, generated, i, page, pageName, stablePath, result;

    if (!doc || !doc.pages || !doc.pages.length) {
        pushBundleIssue("image export skipped: document has no pages");
        return;
    }

    rawOutPath = buildAcceptanceFilePath("_all_pages_" + safe(kind), ".png");
    cleanupExportArtifactsForBase(rawOutPath, false);

    try {
        pngFormat = null;
        try {
            if (indesign && indesign.ExportFormat && indesign.ExportFormat.PNG_FORMAT !== undefined) {
                pngFormat = indesign.ExportFormat.PNG_FORMAT;
            }
        } catch (e0) {}
        if (pngFormat === null) { pngFormat = "png"; }
        trySet(app.pngExportPreferences, "exportingSpread", false);
        trySet(app.pngExportPreferences, "transparentBackground", false);
        exportTarget = rawOutPath;
        try {
            if (typeof File !== "undefined") { exportTarget = File(rawOutPath); }
        } catch (e1) {}
        doc.exportFile(pngFormat, exportTarget, false);
    } catch (e2) {
        pushBundleIssue("image export failed: " + safe(e2 && e2.message ? e2.message : e2));
        log("image export failed: " + safe(e2 && e2.message ? e2.message : e2));
        return;
    }

    generated = listExportArtifactsForBase(rawOutPath);
    pageCount = Number(doc.pages.length) || 0;
    if (!generated.length) {
        pushBundleIssue("image export produced no files");
        return;
    }

    for (i = 0; i < generated.length && i < pageCount; i++) {
        page = getCollectionItem(doc.pages, i);
        pageName = "";
        try { pageName = safe(page && page.name !== undefined ? page.name : (i + 1)); } catch (e3) { pageName = safe(i + 1); }
        stablePath = buildAcceptanceImagePath(pageName, kind);
        // No pre-delete of stablePath: moveFileBestEffort's byte-copy overwrites
        // it. A fire-and-forget delete here would be queued and could run AFTER
        // the copy (the event loop only drains once main() returns), deleting
        // the image we just wrote.
        result = { page: safe(pageName), kind: safe(kind), path: stablePath, ok: false, error: "" };
        if (moveFileBestEffort(generated[i].path, stablePath)) {
            result.ok = true;
            bundle.images.push({ page: safe(pageName), kind: safe(kind), path: stablePath });
            log("image export ok: " + stablePath);
        } else {
            result.error = "failed to move file";
            pushPageIssue(pageName, "image export failed for " + kind);
        }
        bundle.exports.push(result);
    }
    for (i = 0; i < generated.length; i++) { removeFileBestEffort(generated[i].path); }
    cleanupExportArtifactsForBase(rawOutPath, false);
}

// ---------------------------------------------------------------------------
// Acceptance bundle 汇总
// ---------------------------------------------------------------------------

function countIssuesMatching(bundle, prefix) {
    var i, count = 0;
    var issues = bundle.summary.issues;
    for (i = 0; i < issues.length; i++) {
        if (String(issues[i]).indexOf(prefix) >= 0) { count += 1; }
    }
    return count;
}

function buildAcceptanceSummaryPayload(bundle) {
    var pageSummary = {}, manualReviewRequired = [];
    var storyRepair = { totalStories: 0, storiesWithRepairFailures: 0, attempted: 0, fixed: 0, failed: 0, skipped: 0, aborted: 0 };
    var i, key, storyEntry, summary, pageRec, geometrySplitUnresolvedCount = 0;

    for (key in bundle.pages) {
        if (!bundle.pages.hasOwnProperty(key)) { continue; }
        pageRec = bundle.pages[key];
        pageSummary[key] = {
            pass: !!pageRec.pass,
            issueCount: pageRec.issues.length,
            issues: pageRec.issues.slice(0),
            frameSampleCount: pageRec.frames.length,
            geometrySplitUnresolved: pageRec.geometrySplitUnresolved ? pageRec.geometrySplitUnresolved.slice(0) : []
        };
        if (pageRec.geometrySplitUnresolved && pageRec.geometrySplitUnresolved.length) {
            pushUnique(manualReviewRequired, "page " + key);
            geometrySplitUnresolvedCount += pageRec.geometrySplitUnresolved.length;
        }
    }

    for (i = 0; i < bundle.stories.length; i++) {
        storyEntry = bundle.stories[i];
        if (!storyEntry || !storyEntry.repair) { continue; }
        storyRepair.totalStories += 1;
        storyRepair.attempted += Number(storyEntry.repair.attempted || 0);
        storyRepair.fixed += Number(storyEntry.repair.fixed || 0);
        storyRepair.failed += Number(storyEntry.repair.failed || 0);
        storyRepair.skipped += Number(storyEntry.repair.skipped || 0);
        if (storyEntry.repair.aborted) { storyRepair.aborted += 1; }
        if (storyEntry.repair.failed || storyEntry.repair.aborted) { storyRepair.storiesWithRepairFailures += 1; }
    }

    summary = {
        schemaVersion: bundle.schemaVersion,
        generatedAt: bundle.generatedAt,
        documentName: bundle.documentName,
        snapshotPath: bundle.snapshotPath || "",
        logPath: bundle.logPath,
        outputDir: bundle.outputDir,
        status: {
            pass: !!bundle.summary.pass,
            issueCount: bundle.summary.issues.length,
            fatalErrorCount: bundle.errors.length,
            boundaryLostCount: countIssuesMatching(bundle, "boundary-lost"),
            boundaryDeltaCount: countIssuesMatching(bundle, "boundary-delta"),
            geometrySplitUnresolvedCount: geometrySplitUnresolvedCount
        },
        manualReviewRequired: manualReviewRequired,
        watchPages: pageSummary,
        repair: storyRepair,
        files: {
            watchPagesJson: buildAcceptanceFilePath("_watch_pages", ".json"),
            imageDir: bundle.imageOutputDir,
            imageCount: bundle.images.length,
            exportCount: bundle.exports.length
        },
        issues: bundle.summary.issues.slice(0, 20),
        errors: bundle.errors.slice(0, 10)
    };
    return summary;
}

function finalizeAcceptanceBundle(targetDoc) {
    var bundle = ensureAcceptanceBundle();
    var summaryPath, watchPath, summaryPayload, i, pageName;
    var allPageNames, pn;
    if (acceptanceBundleFinalized) { return; }
    if (targetDoc) { bundle.documentName = safe(targetDoc.name); }
    bundle.summary.pass = bundle.summary.issues.length === 0;
    summaryPath = buildAcceptanceFilePath("_summary", ".json");
    watchPath = buildAcceptanceFilePath("_watch_pages", ".json");

    // Collect all page names that have been recorded in the bundle
    allPageNames = [];
    for (pn in bundle.pages) {
        if (bundle.pages.hasOwnProperty(pn)) {
            allPageNames.push(pn);
        }
    }
    allPageNames.sort(function (a, b) { return Number(a) - Number(b); });

    summaryPayload = buildAcceptanceSummaryPayload(bundle);
    writeJsonFileObserved(summaryPath, summaryPayload, "acceptance-summary");
    writeJsonFileObserved(watchPath, {
        documentName: bundle.documentName,
        watchPages: allPageNames,
        imageOutputDir: bundle.imageOutputDir,
        images: bundle.images,
        exports: bundle.exports,
        pages: bundle.pages
    });
    log("Acceptance summary: " + summaryPath);
    log("Acceptance watch pages: " + watchPath);
    for (i = 0; i < allPageNames.length; i++) {
        pageName = allPageNames[i];
        if (bundle.pages[pageName] && bundle.pages[pageName].issues.length) {
            log("page " + pageName + " issues: " + bundle.pages[pageName].issues.join(" | "));
        }
    }
    acceptanceBundleFinalized = true;
}

// ---------------------------------------------------------------------------
// 处理单个 story
// ---------------------------------------------------------------------------

function processStory(targetStory, beforeSnapshot, labelPrefix, storyParaDeltas) {
    var afterSnapshot;
    var bundle = ensureAcceptanceBundle();

    if (!isUsableStoryObject(targetStory)) {
        log(labelPrefix + " skip: invalid story object");
        pushBundleIssue(labelPrefix + " invalid story object");
        return;
    }

    log(labelPrefix + " start storyId=" + safe(beforeSnapshot.storyId) + " frames=" + beforeSnapshot.frameCount);

    // 记录 _before（来自快照文件，用于 boundary delta 基准）
    recordSnapshotForAcceptance(labelPrefix + "_before", beforeSnapshot, null);

    // 采集 apply 后的当前状态
    afterSnapshot = captureStorySnapshot(targetStory);
    logStorySnapshot(labelPrefix + "_after_apply", afterSnapshot);
    recordSnapshotForAcceptance(labelPrefix + "_after_apply", afterSnapshot, null);

    // Run full repair pipeline (ordinal repair, anchor restoration, overflow fix)
    FrameRepair.repairStory(targetStory, beforeSnapshot, labelPrefix, storyParaDeltas);

    bundle.stories.push({
        label: labelPrefix,
        storyId: safe(beforeSnapshot.storyId)
    });

    afterSnapshot = captureStorySnapshot(targetStory);
    logStorySnapshot(labelPrefix + "_after_repair", afterSnapshot);
    recordSnapshotForAcceptance(labelPrefix + "_after_repair", afterSnapshot, null, storyParaDeltas);
    log(labelPrefix + " finish");
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
    var targetDoc, snapshotData, storyOrder, storyId, liveStory, rawSnap, beforeSnapshot;
    var snapshotPath, i;

    log("=== Repair After Apply ===");

    if (!app.documents.length) {
        statusLine = "ERROR: No open document.";
        log(statusLine);
        return;
    }

    targetDoc = app.activeDocument;
    targetDocRef = targetDoc;
    ensureAcceptanceBundle().documentName = safe(targetDoc.name);
    log("Document: " + safe(targetDoc.name));

    // Populate ACCEPTANCE_WATCH_PAGES from all document pages
    ACCEPTANCE_WATCH_PAGES = [];
    for (i = 0; i < targetDoc.pages.length; i++) {
        try {
            var pg = getCollectionItem(targetDoc.pages, i);
            if (pg) { ACCEPTANCE_WATCH_PAGES.push(safe(pg.name)); }
        } catch (ep) {}
    }
    log("Watch pages (all): " + ACCEPTANCE_WATCH_PAGES.join(", "));

    // 确定 snapshot 路径：优先尝试文档专属路径，fallback 到 latest
    snapshotPath = SnapshotWriter.getDocSnapshotPath(targetDoc.name, DATA_DIR);
    if (!SnapshotWriter.snapshotExists(snapshotPath, fs)) {
        snapshotPath = LATEST_SNAPSHOT_PATH;
    }
    log("Loading snapshot: " + snapshotPath);
    ensureAcceptanceBundle().snapshotPath = snapshotPath;

    snapshotData = loadBeforeSnapshot(snapshotPath);
    if (!snapshotData) {
        statusLine = "ERROR: Cannot load before snapshot from " + snapshotPath;
        log(statusLine);
        return;
    }
    log("Snapshot loaded: documentName=" + safe(snapshotData.documentName) + " stories=" + safe(snapshotData.storyCount));

    // Load paragraph deltas (optional — absent for append/trim-only runs)
    var paraDeltasData = loadParaDeltas(PARA_DELTAS_PATH);
    if (paraDeltasData) {
        // Discard deltas from a different document to prevent ordinal corruption
        if (paraDeltasData.documentName && safe(targetDoc.name) !== safe(paraDeltasData.documentName)) {
            log("WARNING: para deltas documentName=" + safe(paraDeltasData.documentName) +
                " does not match current document=" + safe(targetDoc.name) + " — discarding deltas");
            paraDeltasData = null;
        } else if (paraDeltasData.snapshotCapturedAt && snapshotData.capturedAt
                && paraDeltasData.snapshotCapturedAt !== snapshotData.capturedAt) {
            // #23 fix: para_deltas_latest.json is global (single file per
            // documentName), so a prior run's deltas can survive on disk
            // when a new run's writeTextFile silently failed. Bind via
            // the snapshot's capturedAt: a mismatch means the deltas
            // belong to a DIFFERENT run's snapshot and applying them
            // would feed wrong ordinals into frame_repair.
            log("WARNING: para deltas snapshotCapturedAt=" + safe(paraDeltasData.snapshotCapturedAt) +
                " does not match loaded snapshot.capturedAt=" + safe(snapshotData.capturedAt) +
                " — STALE deltas (likely from a prior run whose write succeeded but the current run's write silently failed). Discarding to prevent ordinal corruption in frame_repair.");
            paraDeltasData = null;
        } else {
            var pdCount = 0, pdKey;
            for (pdKey in paraDeltasData.storyDeltas) {
                if (paraDeltasData.storyDeltas.hasOwnProperty(pdKey)) { pdCount++; }
            }
            log("Para deltas loaded: " + pdCount + " stories with deltas"
                + (paraDeltasData.snapshotCapturedAt
                    ? " (snapshot binding ✓ capturedAt=" + paraDeltasData.snapshotCapturedAt + ")"
                    : " (legacy file: no snapshotCapturedAt binding — cannot detect staleness)"));
        }
    }
    if (!paraDeltasData) {
        log("No para deltas (normal for CJK style merge runs)");
    }

    // 文档名校验（警告但不阻断，因为文件名可能在 Save As 后变化）
    if (snapshotData.documentName && safe(targetDoc.name) !== safe(snapshotData.documentName)) {
        log("WARNING: snapshot documentName=" + safe(snapshotData.documentName) +
            " does not match current document=" + safe(targetDoc.name));
        pushBundleIssue("document name mismatch: snapshot=" + safe(snapshotData.documentName) + " current=" + safe(targetDoc.name));
    }

    storyOrder = snapshotData.storyOrder || [];
    if (!storyOrder.length) {
        statusLine = "ERROR: Snapshot contains no stories.";
        log(statusLine);
        return;
    }
    log("Stories to repair: " + storyOrder.length);

    for (i = 0; i < storyOrder.length; i++) {
        storyId = storyOrder[i];
        log("Story loop enter: index=" + i + " storyId=" + storyId);
        try {
            rawSnap = snapshotData.stories[storyId];
            if (!rawSnap) {
                log("Story[" + i + "] skip: no snapshot data for storyId=" + storyId);
                pushBundleIssue("story[" + i + "] missing snapshot");
                continue;
            }
            beforeSnapshot = deserializeStorySnapshot(rawSnap);
            if (!beforeSnapshot || !beforeSnapshot.frames || !beforeSnapshot.frames.length) {
                log("Story[" + i + "] skip: empty snapshot for storyId=" + storyId);
                continue;
            }
            liveStory = resolveLiveStoryById(targetDoc, storyId);
            if (!isUsableStoryObject(liveStory)) {
                log("Story[" + i + "] skip: story not found in current document storyId=" + storyId);
                pushBundleIssue("story[" + i + "] not found storyId=" + storyId);
                continue;
            }
            var curStoryDeltas = (paraDeltasData && paraDeltasData.storyDeltas && paraDeltasData.storyDeltas[storyId]) || null;
            processStory(liveStory, beforeSnapshot, "story[" + i + "]", curStoryDeltas);
            log("Story loop exit: index=" + i + " storyId=" + storyId);
        } catch (eStory) {
            log("Story loop error: index=" + i + " storyId=" + storyId + " error=" + safe(eStory && eStory.message ? eStory.message : eStory));
            pushBundleIssue("story[" + i + "] skipped after exception");
        }
    }

    log("Acceptance export phase enter");
    exportAllPageImages(targetDoc, "current");
    log("Acceptance export phase exit");

    finalizeAcceptanceBundle(targetDoc);
    resolveTargetDocumentFocus(targetDoc);

    statusLine = "Repair complete: " + storyOrder.length + " story(s) processed.";
    log(statusLine);
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

function resetState() {
    lines = [];
    statusLine = "";
    acceptanceBundle = null;
    acceptanceBundleFinalized = false;
    targetDocRef = null;
    ACCEPTANCE_WATCH_PAGES = null;
}

// Internal: setup-only (no doScript wrap, no DOM mutation). Shared by
// runRepair (standalone — wraps in own doScript) and runRepairCore
// (caller's doScript already provides the undo block).
function _setupRepairInvocation(config) {
    config = config || {};

    // Reset all module-level state (require caches this module)
    resetState();

    // Resolve paths from config or defaults
    BASE_DIR = config.baseDir || RuntimePaths.getBaseDir();
    DATA_DIR = config.dataDir || RuntimePaths.getDataDir();
    LATEST_SNAPSHOT_PATH = joinPath(DATA_DIR, "before_snapshot_latest.json");
    PARA_DELTAS_PATH = joinPath(DATA_DIR, "para_deltas_latest.json");
    DEFAULT_OUT_LOG = joinPath(RuntimePaths.getLogDir(), "repair_after_apply_output.txt");
    OUT_PATH = config.outPath || DEFAULT_OUT_LOG;

    // Re-init FrameRepair with fresh log context
    FrameRepair.init({
        log: log,
        safe: safe,
        safeNumberString: safeNumberString,
        indesign: indesign,
        FrameHostAdapter: FrameHostAdapter,
        FramePartition: FramePartition,
        computeOrdinalAdjustment: computeOrdinalAdjustment
    });
}

// Internal: post-main cleanup shared by both entry points.
function _finalizeRepairInvocation() {
    try {
        if (acceptanceBundle) { finalizeAcceptanceBundle(targetDocRef); }
    } catch (e0) {
        log("Acceptance bundle finalize failed: " + safe(e0 && e0.message ? e0.message : e0));
    }

    writeTextFileObserved(OUT_PATH, lines.join("\n"), "repair-log");

    return { statusLine: statusLine, logLines: lines.length };
}

// Caller-wrapped variant: runs main() WITHOUT opening its own
// doScript ENTIRE_SCRIPT block. The caller is expected to have
// already opened one (e.g. reorganize_styles_inplace / import_v2 wrap
// preflight + main reorg + repair into a single undo unit so a single
// Cmd/Ctrl+Z reverts the whole pipeline).
//
// NOTE: must be called from inside an ENTIRE_SCRIPT undo block. If
// invoked outside one, repair operations will each become their own
// history item (defeats the contract).
function runRepairCore(config) {
    _setupRepairInvocation(config);
    log("runRepairCore: entered (assumed wrapped in caller's undo block)");
    try {
        main();
    } catch (eIn) {
        statusLine = "FAILED: " + (eIn && eIn.message ? eIn.message : eIn);
        log(statusLine);
        ensureAcceptanceBundle().errors.push(statusLine);
        pushBundleIssue(statusLine);
    }
    return _finalizeRepairInvocation();
}

// Standalone variant: opens its own ENTIRE_SCRIPT undo block. Used by
// repair_after_apply.idjs (Scripts Panel double-click) — caller has no
// outer undo block, so we provide one here.
function runRepair(config) {
    _setupRepairInvocation(config);
    log("runRepair: standalone mode — opening ENTIRE_SCRIPT 'Repair After Apply'");

    var ScriptLanguage = indesign.ScriptLanguage;
    var UndoModes = indesign.UndoModes;
    try {
        app.doScript(function () {
            try {
                main();
            } catch (eIn) {
                statusLine = "FAILED: " + (eIn && eIn.message ? eIn.message : eIn);
                log(statusLine);
                ensureAcceptanceBundle().errors.push(statusLine);
                pushBundleIssue(statusLine);
            }
        }, ScriptLanguage.JAVASCRIPT, undefined, UndoModes.ENTIRE_SCRIPT, "Repair After Apply");
    } catch (eDS) {
        statusLine = "FAILED: doScript wrapper " + (eDS && eDS.message ? eDS.message : eDS);
        log(statusLine);
        ensureAcceptanceBundle().errors.push(statusLine);
        pushBundleIssue(statusLine);
    }

    return _finalizeRepairInvocation();
}

module.exports = {
    runRepair: runRepair,
    runRepairCore: runRepairCore,
    resetState: resetState
};
