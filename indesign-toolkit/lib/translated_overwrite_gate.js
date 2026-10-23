"use strict";

/**
 * lib/translated_overwrite_gate.js — TODO #146 (owner 2026-10-19, option C: block AND back up).
 *
 * Running Import on the ORIGINAL document while <stem>.translated.indd already exists is a
 * fresh import: the existing file is overwritten (writeFileSync) and, when it is open, closed
 * without saving. Everything the translator did by hand in that copy is lost, and until now
 * nothing said so and nothing was backed up (the "no backup needed, it writes a NEW file"
 * comment was wrong whenever the file already existed).
 *
 * This module is the DECISION only (pure, Node-testable); the entry does the I/O:
 *   classifyExistence(lfsProbe, readProbe) → "exists" | "absent" | "unknown"
 *   decide(facts)                          → { action: "proceed" | "ask" | "refuse", reason, needBackup }
 *   askText(...) / refuseText(...)         → the user-visible wording (short, no dashes)
 *
 * Fail-closed throughout: an existence probe that cannot say yes or no is "unknown", and
 * unknown refuses. An open copy whose modified flag is not exactly false counts as modified.
 */

function _isNotFound(err) {
    if (!err) return false;
    if (err.code === "ENOENT") return true;
    var m = String((err && err.message) || err);
    return /ENOENT|no such file|not\s*found|can(?:no|')t find|could not find|does not exist|doesn't exist/i.test(m);
}

/**
 * Two independent probes (UXP's statSync once reported "absent" for a file that was on disk,
 * CLAUDE.md #26-補, so neither probe alone is trusted to say "absent"):
 *   lfsProbe  : { ok: true } the lfs entry resolved   | { ok: false, err } it did not
 *   readProbe : { ok: true } the bytes could be read  | { ok: false, err } they could not
 * "exists"  : either probe succeeded.
 * "absent"  : BOTH failed, and both failures read as not-found.
 * "unknown" : anything else (a probe that failed for another reason cannot prove absence).
 */
function classifyExistence(lfsProbe, readProbe) {
    if ((lfsProbe && lfsProbe.ok) || (readProbe && readProbe.ok)) return "exists";
    if (lfsProbe && lfsProbe.ok === false && readProbe && readProbe.ok === false
        && _isNotFound(lfsProbe.err) && _isNotFound(readProbe.err)) return "absent";
    return "unknown";
}

/**
 * docIsAtPath({name, path}, targetPath, normPath) → bool   (BRIDGE-4 closes stale copies by PATH, arch 2026-10-19)
 * Names repeat across folders, so a same-named document elsewhere is NOT the file. A document whose path
 * could not be read (path empty) might be the file: it counts, because the caller must not assume otherwise.
 */
function docIsAtPath(doc, targetPath, normPath) {
    if (!doc) return false;
    var base = String(targetPath || '').split(/[\\/]/).pop();
    if (String(doc.name) !== base) return false;
    var p = doc.path ? String(doc.path) : '';
    if (!p) return true;
    return normPath(p) === normPath(targetPath);
}

/**
 * facts = {
 *   existence : "exists" | "absent" | "unknown"       (classifyExistence)
 *   open      : bool                                  a document with the target's name is open
 *   modified  : bool | null | undefined               its modified flag (only meaningful when open)
 *   automated : bool                                  bridge / automationOptions run
 *   replaceOption : bool                              automationOptions.replaceExistingTranslated === true
 * }
 * → { action, reason, needBackup }
 *   reasons: "no_existing" | "open_modified" | "existence_unknown" | "exists_interactive" |
 *            "exists_automated_refused" | "exists_automated_replace"
 */
function decide(facts) {
    facts = facts || {};
    var open = facts.open === true;
    var ex = (facts.existence === "exists" || facts.existence === "absent") ? facts.existence : "unknown";   // anything else cannot answer
    var exists = ex === "exists";
    if (open && facts.modified !== false) {
        // Closing it would have to discard unsaved edits (or save them over the file we are
        // about to replace). Neither is ours to decide.
        return { action: "refuse", reason: "open_modified", needBackup: false };
    }
    if (ex === "unknown") return { action: "refuse", reason: "existence_unknown", needBackup: false };
    if (!exists && !open) return { action: "proceed", reason: "no_existing", needBackup: false };
    if (!exists && open) {
        // Open, unmodified, nothing on disk under that name: nothing can be lost.
        return { action: "proceed", reason: "no_existing", needBackup: false };
    }
    if (facts.automated) {
        return facts.replaceOption === true
            ? { action: "proceed", reason: "exists_automated_replace", needBackup: true }
            : { action: "refuse", reason: "exists_automated_refused", needBackup: false };
    }
    return { action: "ask", reason: "exists_interactive", needBackup: true };
}

// User-visible wording. Short, no dashes, button names say what they do (owner 2026-10-19).
function askText(translatedPath) {
    return {
        title: "Replace the translated copy?",
        lines: [
            "This document already has a translated copy:",
            String(translatedPath),
            "Importing from the original replaces it. Layout changes you made by hand in that copy will be lost. A backup is saved first.",
            "To update the copy instead, open the .translated.indd file and run Import there."
        ],
        replaceLabel: "Replace it",
        cancelLabel: "Cancel"
    };
}

function refuseText(reason, translatedPath) {
    var p = String(translatedPath || "");
    switch (reason) {
        case "open_modified":
            return "The translated copy is open and has unsaved changes:\n" + p + "\nSave or close it, then run Import again. Nothing was changed.";
        case "existence_unknown":
            return "Could not check whether a translated copy already exists:\n" + p + "\nNothing was changed. Run Import again, or check the folder.";
        case "exists_automated_refused":
            return "A translated copy already exists:\n" + p + "\nNothing was changed. Open that file and import there, or pass replaceExistingTranslated: true to replace it (a backup is saved first).";
        case "stale_copy_wont_close":
            return "That copy could not be closed:\n" + p + "\nClose it by hand, then run Import again. Nothing was changed.";
        default:
            return "Import stopped. Nothing was changed.";
    }
}

module.exports = {
    classifyExistence: classifyExistence,
    docIsAtPath: docIsAtPath,
    decide: decide,
    askText: askText,
    refuseText: refuseText,
    _isNotFound: _isNotFound
};
