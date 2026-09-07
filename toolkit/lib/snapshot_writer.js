"use strict";

// lib/snapshot_writer.js — Pure logic module for snapshot path generation.
// No fs/host dependencies. Caller provides writeFn for actual I/O.
// Shared by: snapshot_before_apply.idjs, cjk_style_apply.idjs,
//            test_random_paragraph_mutate.idjs, lib/repair_after_apply.js (reader)

function safeString(value) {
    if (value === undefined || value === null) { return ""; }
    return String(value);
}

/**
 * Extract base name from document name (strip extension + sanitize).
 * @param {string} docName - e.g. "My Doc.indd"
 * @returns {string} e.g. "My_Doc"
 */
function getDocBaseName(docName) {
    var name = safeString(docName);
    var dot = name.lastIndexOf(".");
    if (dot > 0) { name = name.substring(0, dot); }
    return name.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * Build doc-specific snapshot file path.
 * @param {string} docName - document name (e.g. "My Doc.indd")
 * @param {string} baseDir - base directory
 * @param {string} [sep] - path separator (auto-detected from baseDir if omitted)
 * @returns {string} e.g. "/base/My_Doc_before_snapshot.json"
 */
function getDocSnapshotPath(docName, baseDir, sep) {
    if (!sep) { sep = baseDir && baseDir.indexOf("\\") >= 0 ? "\\" : "/"; }
    var base = safeString(baseDir).replace(/[\\\/]+$/, "");
    return base + sep + getDocBaseName(docName) + "_before_snapshot.json";
}

/**
 * Build both snapshot paths (doc-specific + latest).
 * @param {string} docName
 * @param {string} baseDir
 * @param {string} [sep]
 * @returns {{ docSpecific: string, latest: string }}
 */
function buildSnapshotPaths(docName, baseDir, sep) {
    if (!sep) { sep = baseDir && baseDir.indexOf("\\") >= 0 ? "\\" : "/"; }
    var base = safeString(baseDir).replace(/[\\\/]+$/, "");
    return {
        docSpecific: base + sep + getDocBaseName(docName) + "_before_snapshot.json",
        latest: base + sep + "before_snapshot_latest.json"
    };
}

/**
 * Check if a doc-specific snapshot file exists.
 * Uses lstatSync (existsSync not available in UXP).
 * @param {string} snapshotPath
 * @param {object} fs - require("fs")
 * @returns {boolean}
 */
function snapshotExists(snapshotPath, fs) {
    try { fs.lstatSync(snapshotPath); return true; } catch (e) { return false; }
}

module.exports = {
    getDocBaseName: getDocBaseName,
    getDocSnapshotPath: getDocSnapshotPath,
    buildSnapshotPaths: buildSnapshotPaths,
    snapshotExists: snapshotExists
};
