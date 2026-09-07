"use strict";
/**
 * lib/project_meta_uxp.js — wire the FROZEN project_meta core lib for UXP idjs.
 *
 * The webapp loads the schema as a <script>-embedded JS module (file:// can't
 * fetch local JSON); UXP can require() the UMD core lib directly but must read
 * the schema .json off disk, resolved against the runtime base dir (so it works
 * under both bridge-driven and double-click entry).
 *
 * The core lib + its deps live under the frozen require-graph dir
 * lib/vendor/project_meta/ (byte-synced from app-folio canonical; do NOT edit
 * those — they're drift-gated). This loader is the IT-side glue, NOT frozen.
 *
 * Usage:
 *   var PM = await require("./lib/project_meta_uxp.js").load();
 *   PM.parse(text) / PM.validate(obj) / PM.serialize(obj) / PM.inferDefaults(ctx)
 *
 * Idempotent: setSchema runs once; later load() returns the same configured PM.
 */
var common = require("./translation_common.js");
var RuntimePaths = require("./runtime_paths.js");
var ProjectMeta = require("./vendor/project_meta/project_meta.js");
var Assemble = require("./project_meta_assemble.js");

var _configured = false;

async function load() {
    if (!_configured) {
        var baseDir = await RuntimePaths.bootstrap();
        if (!baseDir) {
            throw new Error("project_meta_uxp: RuntimePaths.bootstrap() returned empty base dir");
        }
        var sep = (baseDir.indexOf("\\") >= 0) ? "\\" : "/";
        var schemaPath = baseDir + sep + "lib" + sep + "vendor" + sep
            + "project_meta" + sep + "project_meta.schema.json";
        var raw = common.readUtf8File(schemaPath);
        var schema = JSON.parse(raw);
        ProjectMeta.setSchema(schema);
        _configured = true;
    }
    return ProjectMeta;
}

/**
 * summarizeValidationErrors(errors) -> { count, missing[], other[], text }
 *
 * Turn a `ProjectMeta.validate()` error array into something a log line can say
 * truthfully.
 *
 * 🔴 Why this exists at all. The export used to print `errors[0]`. The validator
 * walks the schema's `required` array in order and pushes one error per missing
 * key; `project_id` is at index 1 and `project_name` at index 2. So a run that
 * was missing THREE required keys printed exactly like a run missing one — and
 * nothing anywhere said "there are more". Measured on a real export 2026-08-22.
 *
 * ⚠ `count` is reported next to the list on purpose: a list can be truncated by
 * whatever renders it, and then it under-states the problem again. A number
 * cannot be truncated into a smaller true number.
 *
 * ⚠ It reports; it does not judge. Whether a given failure should block, warn,
 * or pop a dialog is decided by the caller (and, for the dialog, by the owner).
 */
function summarizeValidationErrors(errors) {
    var missing = [];
    var other = [];
    var list = (errors && errors.length) ? errors : [];
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e === null || e === undefined) continue;
        if (typeof e === "string") {
            var ms = /missing required property:\s*(\S+)/.exec(e);
            if (ms) { missing.push(ms[1]); } else { other.push(e); }
            continue;
        }
        var where = e.path || e.instancePath || "";
        var msg = e.message || "";
        var m = /missing required property:\s*(\S+)/.exec(msg);
        if (m) { missing.push(m[1]); continue; }
        other.push((where ? where + " " : "") + (msg || JSON.stringify(e)));
    }
    var text = "count=" + list.length
        + (missing.length ? " missing=[" + missing.join(",") + "]" : "")
        + (other.length ? " other=[" + other.join(" ; ") + "]" : "");
    return { count: list.length, missing: missing, other: other, text: text };
}

// ── Which required fields the OPERATOR actually has to supply ────────────
//
// 🔴 `OPERATOR_REQUIRED` below is a WRITTEN-DOWN LIST, and a written-down list's
// holes are always "the ones nobody added". If the schema gains a new required
// field that the operator must type, this list will not know: the hint keeps
// saying `full`, the package still cannot be written, and NOTHING goes red.
// ⇒ `tests/export_meta_hint_tests.js` reconciles it against the real schema:
//      OPERATOR_REQUIRED  ===  schema.required − (AUTO_FILLED ∪ DERIVED ∪ DIALOG_DEFAULTED)
//   Change the schema and the arithmetic stops balancing, so the next person is
//   forced to decide which bucket the new field belongs in — instead of the
//   question never being asked.
//
// The three exemption sets, each with the reason it is exempt:
//   AUTO_FILLED       — the export writes them on every run, unconditionally
//   DERIVED           — minted from another field (so it is that field's problem)
//   DIALOG_DEFAULTED  — the dialog ships a non-empty default, so it cannot come
//                       back empty even if he never touches it
// ⚠ These sets are claims about OTHER code. The reconciliation test also checks
// the AUTO_FILLED claim against the export's source, because a set that merely
// asserts something about a distant file is exactly the kind of thing that rots.
var AUTO_FILLED = ["schema_version", "created_at", "updated_at"];
var DERIVED = ["project_id"];              // minted from project_name
var DIALOG_DEFAULTED = ["workflow_mode"];  // dialog default "translation"

var OPERATOR_REQUIRED = ["project_name", "source_language"];

// 🪦 assessCarriedMeta REMOVED 2026-08-28 (owner ruling): the export dialog no
// longer says anything about carried metadata, and this function's ONLY job was
// to pick which sentence it said. See the tombstone in lib/export_dialog.js for
// the ruling and for the check that removing it loses no data.

module.exports = {
    load: load,
    summarizeValidationErrors: summarizeValidationErrors,
    OPERATOR_REQUIRED: OPERATOR_REQUIRED,
    // Exported so the reconciliation test can do the arithmetic against the real
    // schema rather than against a second copy of these names.
    AUTO_FILLED: AUTO_FILLED,
    DERIVED: DERIVED,
    DIALOG_DEFAULTED: DIALOG_DEFAULTED
};
