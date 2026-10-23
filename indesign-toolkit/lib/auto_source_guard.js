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

/**
 * enforceActive(app, path) -> { ok, action, message, openDocuments }      (host, async)
 *
 * For automated entries that work on `app.activeDocument` (cjk_style_apply; the export
 * has the same steps inline): make the document at `path` the active one, or refuse.
 *   not among the open documents      → refuse (this never opens a document itself)
 *   open but not active               → activate it
 *   then the active document's path is READ BACK and must equal `path` — an activation
 *   that silently did nothing is a refusal, not a run on whatever is in front.
 * Documents are identified by path: production documents and development copies carry
 * the same file names, so a name proves nothing (DocX-1, 2026-10-03).
 * On refusal nothing has been read from or written to any document.
 */
async function enforceActive(app, path) {
    var res = { ok: false, action: "", message: "", openDocuments: [] };
    async function pathOf(d) {
        try {
            var fn = d.fullName;
            if (fn && typeof fn.then === "function") fn = await fn;
            return (fn && fn.nativePath) ? String(fn.nativePath) : String(fn || "");
        } catch (e) { return ""; }
    }
    var want = normPath(path), active = "", els = [];
    try { active = normPath(await pathOf(app.activeDocument)); } catch (eA) {}
    try { els = app.documents.everyItem().getElements(); } catch (eE) { els = []; }
    for (var i = 0; i < els.length; i++) {
        var p = await pathOf(els[i]), nm = "";
        try { nm = String(els[i].name); } catch (eN) {}
        res.openDocuments.push({ path: p, name: nm, active: !!active && normPath(p) === active });
    }
    var d = decide(String(path), res.openDocuments);
    res.action = d.action;
    if (d.action === "refuse" || d.action === "open") {
        res.message = "Refused: the document named by the path is not among the open documents (" + path + "). Nothing was read or changed.";
        return res;
    }
    if (d.action === "activate") {
        try { app.activeDocument = els[d.index]; }
        catch (eAct) { res.message = "Refused: the document could not be made active (" + (eAct && eAct.message || eAct) + "). Nothing was changed."; return res; }
    }
    var now = "";
    try { now = normPath(await pathOf(app.activeDocument)); } catch (eNow) {}
    if (now !== want) {
        res.message = "Refused: the active document is not the one named by the path (active: " + now + "). Nothing was changed.";
        return res;
    }
    res.ok = true;
    return res;
}

module.exports = { normPath: normPath, decide: decide, enforceActive: enforceActive };
