"use strict";

/**
 * lib/auto_source_guard.js — which document an AUTOMATED import may write into
 * (task_plan.md#ac-import-hardening P5, 2026-09-25).
 *
 * Why: automationOptions.sourcePath used to be honoured only when NO document
 * was open; otherwise the import silently ran on app.activeDocument. On
 * 2026-09-22 that wrote the zh-HK translation into — and saved over — the ja
 * deliverable (findings automation-sourcepath-ignored-when-docs-open).
 *
 * Rule: with a sourcePath, the import only ever touches that file.
 *   no docs open                    → "open"     (open sourcePath, as before)
 *   sourcePath is the active doc    → "proceed"
 *   sourcePath open but not active  → "activate" (bring it to front, then proceed)
 *   sourcePath not among open docs  → "refuse"   (never fall back to the active doc)
 * Without a sourcePath (interactive use) → "interactive": unchanged semantics,
 * the active document is the target.
 *
 * Path comparison is textual after normalising case and separators. A path
 * that names the same file differently (8.3 short name, mapped drive vs UNC)
 * compares unequal ⇒ "refuse" — the safe side of the error.
 */

function normPath(p) {
    return String(p == null ? "" : p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * @param sourcePath  string|null  automationOptions.sourcePath
 * @param openDocs    [{ path, name, active }]
 * @returns {{ action: string, index?: number, message?: string }}
 */
function decide(sourcePath, openDocs) {
    var docs = openDocs || [];
    if (!sourcePath) return { action: "interactive" };
    if (!docs.length) return { action: "open" };
    var want = normPath(sourcePath);
    for (var i = 0; i < docs.length; i++) {
        if (normPath(docs[i].path) === want) {
            return docs[i].active ? { action: "proceed", index: i } : { action: "activate", index: i };
        }
    }
    return {
        action: "refuse",
        message: "Automated import refused: automationOptions.sourcePath is not among the open documents.\n"
            + "sourcePath: " + sourcePath + "\n"
            + "Open: " + docs.map(function (d) { return (d.active ? "* " : "") + (d.path || d.name); }).join(" | ") + "\n"
            + "Nothing was changed. Close the other documents (or open the sourcePath document) and run again."
    };
}

module.exports = { normPath: normPath, decide: decide };
