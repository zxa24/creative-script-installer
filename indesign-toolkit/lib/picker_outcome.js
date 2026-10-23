// picker_outcome.js — TODO: the dead-end import (owner 2026-08-22 眼验当场撞到)
//
// 🔴 THE DEFECT THIS EXISTS FOR
// `getFileForOpening` returns a falsy value for BOTH "the operator pressed Cancel"
// and "the picker handed back nothing". Both hosts collapsed that into one reason
// string, `"user cancelled"`, and `handleImport` then RETURNED SILENTLY on it.
// ⇒ clicking Import did nothing at all — no import, no error, no trace.
// That is what owner reported as「导入再也触发不了」.
//
// ⚠ It was NOT a stuck state. There is no busy/guard flag anywhere in handleImport,
// the failure branch sets no state, and the error banner clears on `[data]` and
// renders after </header> so it never covers the button. Read-code, 2026-08-23.
// 🔴 CLAUDE.md #14b already recorded this conflation. We wrote it down and then let
// it live in production until it reached owner.
//
// 🔴 WHAT WE CAN AND CANNOT TELL APART — read this before "improving" the reasons.
// At the `!f` site the two cases are INDISTINGUISHABLE. So this module does NOT
// invent a distinction it cannot make:
//     PICKER_NOTHING  the picker returned nothing. Operator cancelled, OR the
//                     device handed back empty. WE DO NOT KNOW WHICH.
//     PICKER_THREW    the picker threw. That is not something an operator does.
// Two values, both honest. The wording shown to the operator says exactly this —
// it must never claim "failed" for PICKER_NOTHING, because most of the time it IS
// an ordinary cancel.
//
// The rule being applied is the same one #58's identity gate runs on:
// **when the engine cannot answer, say so — do not answer for it.**
//
// ── A10 (owner 2026-08-28 眼验): 「去掉什么都没导入提示」 ────────────────────
// 🔴 PICKER_NOTHING no longer interrupts the operator. Pressing Cancel is a
// deliberate act and does not need to be reported back to the person who did it.
// It is NOT silent: the kind is now "log", and the caller writes it to the panel
// trace (window.fapTraceLatest()), so a device that hands back empty is still
// discoverable after the fact.
//
// 🔴 READ THIS BEFORE "restoring" the notice or "simplifying" the kinds.
// arch asked for the two halves to be split: drop the CANCEL half, keep the
// DEVICE-RETURNED-EMPTY half visible. **That split is not implementable here and
// never was** — the header above says why: at the `!f` site the two causes are
// indistinguishable, and PICKER_NOTHING is the single value that covers both.
// The two values this module actually has are NOTHING vs THREW, and the split
// that IS implementable is the one now in force:
//     PICKER_NOTHING (cancel OR empty, unknowable) -> "log"   quiet, recorded
//     PICKER_THREW   (a genuine device fault)      -> "error" loud, on screen
// ⚠ The residual risk is stated, not hidden: a picker that returns empty WITHOUT
// throwing is now quiet on screen. That is the price of owner's ruling, and the
// trace is what keeps it findable. Do not "fix" it by making cancels shout again
// without taking it back to owner.
"use strict";

var PICKER_NOTHING = "picker-returned-nothing";
var PICKER_THREW = "picker-threw";

// classifyPickerOutcome : (result, action) -> { kind, text }
//   action  "import" | "export"  — the ONLY thing that differs between them is
//                                   the noun in the sentence.
//   kind "ok"      succeeded, nothing to surface
//   kind "log"     recorded, NOT shown: an outcome the operator either caused on
//                  purpose (cancel) or must be able to find afterwards (empty
//                  device). The caller MUST write `text` to the panel trace.
//   kind "error"   something genuinely went wrong; shown on screen
//
// 🔴 There is deliberately no "silent" kind. "log" is not silence — a caller that
// drops the text on the floor puts the original dead-end back. The wiring test at
// the bottom of picker_outcome_tests.js is what stops that.
// ⚠ ONE core, two thin wrappers. Export has the same conflation as import
// (`getFileForSaving` is falsy for cancel AND for a device that returned nothing),
// and a second copy of this decision would drift — which is exactly how the two
// host copies of importJson drifted apart in the first place.
function classifyPickerOutcome(res, action) {
    var verb = (action === "export") ? "exported" : "imported";
    if (res && res.ok) return { kind: "ok", text: "" };
    var reason = (res && res.reason) ? String(res.reason) : "";

    if (reason === PICKER_NOTHING) {
        // ⚠ Wording is part of the fix: it reports what happened without
        // asserting which of the two causes it was. It now goes to the trace
        // rather than to the operator (A10), so it may read like a log line —
        // but it still may not claim to know which cause it was, because the
        // person reading the trace is drawing the same conclusion from it.
        return {
            kind: "log",
            text: "No file was chosen — nothing was " + verb + ". " +
                  "(Cancel, or the file chooser returned nothing; the two are " +
                  "indistinguishable at this call site.)"
        };
    }
    if (reason === PICKER_THREW || reason.indexOf(PICKER_THREW) === 0) {
        return {
            kind: "error",
            text: "The file chooser failed to open" +
                  (res && res.detail ? " (" + res.detail + ")" : "") +
                  ". Nothing was " + verb + "."
        };
    }
    // Legacy value: older hosts in the same persistent plugin context may still
    // return it (#14b — the plugin context outlives a single run). ⚠ It must land
    // in the SAME bucket as PICKER_NOTHING: it means the same thing, and letting
    // it diverge would make the panel's behaviour depend on which host copy
    // happens to be resident.
    if (reason === "user cancelled") {
        return { kind: "log", text: "No file was chosen — nothing was " + verb + "." };
    }
    var label = (action === "export") ? "Export failed: " : "Import failed: ";
    return { kind: "error", text: label + (reason || "unknown reason") };
}

function classifyImportOutcome(res) { return classifyPickerOutcome(res, "import"); }
function classifyExportOutcome(res) { return classifyPickerOutcome(res, "export"); }

var _api = {
    PICKER_NOTHING: PICKER_NOTHING,
    PICKER_THREW: PICKER_THREW,
    classifyPickerOutcome: classifyPickerOutcome,
    classifyImportOutcome: classifyImportOutcome,
    classifyExportOutcome: classifyExportOutcome
};
if (typeof module !== "undefined" && module.exports) module.exports = _api;
if (typeof globalThis !== "undefined") globalThis.PickerOutcome = _api;
