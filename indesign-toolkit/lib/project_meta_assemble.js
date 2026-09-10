"use strict";
/**
 * lib/project_meta_assemble.js — build the `_meta` object the export writes.
 *
 * 🔴 Why this is a lib and not 40 inline lines in the idjs, where it used to
 * live. Mutation testing (2026-08-23) killed only 5 of 8 mutants against the
 * inline version: the three survivors were all export-side gates whose tests
 * could only assert TEXT SHAPE ("this string is present / absent"), because a
 * UXP idjs cannot be executed from the suite. A text assertion says the code
 * looks right; it cannot say the code does the right thing — so
 *   · re-gating inferDefaults behind a condition,
 *   · turning gap-fill into unconditional overwrite,
 *   · adding a SECOND, earlier `und` write that beats the operator
 * all left the suite green. Extracting the logic makes each gate executable, so
 * a fixture can walk into it and a mutant can be killed by behaviour.
 * ⇒ **Untestable placement is itself a defect.** (findings `#28`.)
 *
 * Pure: no host, no I/O, no clock. Everything variable is injected, so a test
 * gets the same function the export gets — not a re-typed lookalike
 * (findings `#36③`).
 */

function _hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// ── 「空」的合法表达 ────────────────────────────────────────────────────
//
// 🔴 Why a shared table rather than an `if` per field. 2026-08-23, in one day,
// three fields fell over one at a time: project_name, then project_id, then
// target_language. Each fix looked complete until the host run found the next.
// The reading was not "we missed one" — it was "we will keep missing one".
//
// 🔴 Why the NEED is derived by EXECUTION, not read off the schema shape. The
// obvious derivation is `properties[k].type` — "does it allow null?". That is a
// SHAPE PROXY and it is wrong here: the schema has a top-level `oneOf` which
// overrides the per-property type. Measured:
//     workflow_mode:"translation" + target_language: absent -> INVALID
//                                                    null   -> INVALID
//                                                    ""     -> INVALID
//                                                    "zh-CN"-> valid
// So `null` — which `properties.target_language.type` plainly permits — is
// rejected. A derivation that read the property would have produced an invalid
// `_meta.json` and looked correct doing it.
// ⇒ `tests/meta_empty_representation_tests.js` derives the need by RUNNING
//   `validate()` on a fixture with each field emptied, and reconciles that
//   against this table. Add a constrained field to the schema and it goes red.
//
// ⚠ Each field gets ITS OWN legal form — ⛔ do not blanket-apply `und`:
//   both entries below happen to be BCP-47 language fields, where `und`
//   ("undetermined") is the registry's own answer. A future non-language field
//   would need a different representation, and the reconciliation test is what
//   forces that question to be asked.
var UNDETERMINED = "und";
var EMPTY_REPRESENTATION = {
    source_language: UNDETERMINED,
    target_language: UNDETERMINED
};

/**
 * isUndetermined(v) — the ONE place that answers "is this value a placeholder
 * standing in for 『nothing chosen』?".
 * 🔴 Shared on purpose. The import side normalises `und` back to "unset" before
 * font mapping sees it, and the export dialog's hint must not call `und`
 * "complete". Two copies of that judgement is the side-channel shape this repo
 * keeps paying for — so both callers require THIS function.
 * ⚠ `und` is a CONVENTION, not something the validator enforces: the pattern is
 * purely structural and `zz`/`qaa` validate identically. Exact match only — no
 * case folding, no "looks like a placeholder" widening.
 */
function isUndetermined(v) {
    return v === UNDETERMINED;
}

/**
 * applyEmptyRepresentations(meta) -> [fields that were rewritten]
 * Rewrites每个 empty-but-illegal field to its declared legal form, in place.
 * ⚠ Only touches absent / "" / whitespace / null — never an operator value.
 */
function applyEmptyRepresentations(meta) {
    var touched = [];
    Object.keys(EMPTY_REPRESENTATION).forEach(function (k) {
        var v = meta[k];
        var empty = (v === undefined || v === null)
            || (typeof v === "string" && !v.replace(/^\s+|\s+$/g, ""));
        if (!empty) return;
        meta[k] = EMPTY_REPRESENTATION[k];
        touched.push(k);
    });
    return touched;
}

/**
 * assembleExportMeta(input) -> { meta, notes }
 *
 * input:
 *   carried            — `_meta` carried off the doc label (may be partial/absent)
 *   inferred           — `ProjectMeta.inferDefaults(...).data` (doc-name derived)
 *   dialog             — the export dialog's answers (operator; wins over both)
 *   designer           — designer name for contributors
 *   schemaVersion      — CURRENT_SCHEMA_VERSION
 *   now                — ISO timestamp string
 *   generateProjectId  — fn(name) -> id
 *
 * notes: { filledFromInfer: [keys], undSubstituted: bool } — for the log line.
 * ⚠ notes exists so the caller can SAY what happened. A silent auto-fill is how
 * this subsystem got into trouble in the first place.
 */
function assembleExportMeta(input) {
    input = input || {};
    var carried = input.carried;
    var inferred = (input.inferred && typeof input.inferred === "object") ? input.inferred : {};
    var dialog = input.dialog;
    var meta = {};
    var notes = { filledFromInfer: [], undSubstituted: false };

    // ── 1. carried label (may be partial — that is the whole problem) ────
    if (carried && typeof carried === "object") {
        Object.keys(carried).forEach(function (k) { meta[k] = carried[k]; });
    }

    // ── 2. 🔴 gap-fill from inferDefaults — UNCONDITIONAL ────────────────
    //
    // This used to be an `else`: inferDefaults ran ONLY when there was no
    // carried meta at all. That `else` was the engine of the degrading loop —
    // a partial label bypassed the one mechanism that could heal it, so a
    // degraded label was strictly WORSE than no label (measured: 370B -> 115B
    // -> 66B, monotone, never self-healing).
    //
    // ⚠ Gap-fill, not overwrite: a key the carried meta HAS wins, whatever its
    // value — `null` is legal content for deadline/target_language. The lone
    // exception is `""`, which cannot be legal for anything inferDefaults
    // produces (project_name has minLength:1, project_id has a pattern), so an
    // empty there is a hole rather than a choice.
    Object.keys(inferred).forEach(function (k) {
        if (_hasOwn(meta, k) && meta[k] !== "" && meta[k] !== undefined) return;
        meta[k] = inferred[k];
        notes.filledFromInfer.push(k);
    });

    // ── 3. operator's dialog answers overlay both ────────────────────────
    if (dialog) {
        if (dialog.project_name) meta.project_name = dialog.project_name;
        if (dialog.source_language) meta.source_language = dialog.source_language;
        if (dialog.workflow_mode) meta.workflow_mode = dialog.workflow_mode;
        if (typeof dialog.target_language === "string") {
            // ⚠ The empty case is NOT decided here any more. It used to write
            // `null` for edit-only and `""` otherwise — and `""` is invalid for
            // EVERY workflow (measured), so that branch could only ever produce
            // an unwritable `_meta.json`. Empty now falls through to
            // applyEmptyRepresentations below, which is the single place that
            // knows what "nothing chosen" is allowed to look like.
            if (dialog.target_language === "") {
                if (((dialog.workflow_mode || meta.workflow_mode) === "edit-only")) meta.target_language = null;
                else delete meta.target_language;
            } else {
                meta.target_language = dialog.target_language;
            }
        }
        if (typeof dialog.deadline === "string") {
            meta.deadline = (dialog.deadline === "") ? null : dialog.deadline;
        }
    }

    if (!meta.contributors || typeof meta.contributors !== "object") meta.contributors = {};
    if (input.designer) meta.contributors.designer = input.designer;
    if (!meta.schema_version) meta.schema_version = input.schemaVersion;

    // ── 4. source_language: still empty -> BCP-47 `und` ──────────────────
    //
    // 🔴 Must come AFTER the overlay, or it beats the operator to it.
    // 🔴 Why a value at all: `source_language` is required AND has
    // `minLength: 2` + a pattern, and those are EXECUTED, not merely declared
    // (measured with a passing baseline and a reverse control). So `""` is
    // schema-INVALID — "just leave it empty" was never available.
    // ⚠ `und` is NOT machine-enforced: the pattern is purely structural and
    // `zz`/`qaa` validate identically. "Undetermined" is a CONVENTION between
    // writer and reader. Do not build anything that assumes the validator
    // protects it.
    var __emptied = applyEmptyRepresentations(meta);
    notes.emptyRepresented = __emptied;
    // kept for callers that only ever asked about the language
    notes.undSubstituted = __emptied.indexOf("source_language") >= 0;

    if (!meta.project_id && meta.project_name && typeof input.generateProjectId === "function") {
        meta.project_id = input.generateProjectId(meta.project_name);
    }
    if (!meta.created_at) meta.created_at = input.now;
    meta.updated_at = input.now;

    return { meta: meta, notes: notes };
}

module.exports = {
    assembleExportMeta: assembleExportMeta,
    // Shared so the export dialog's hint and the import-side normalisation ask
    // the SAME function — two copies of "is this a placeholder" is the
    // side-channel shape this repo keeps paying for.
    UNDETERMINED: UNDETERMINED,
    isUndetermined: isUndetermined,
    EMPTY_REPRESENTATION: EMPTY_REPRESENTATION,
    applyEmptyRepresentations: applyEmptyRepresentations
};
