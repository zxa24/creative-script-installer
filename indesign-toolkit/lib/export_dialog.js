"use strict";

/**
 * lib/export_dialog.js
 *
 * HTML-based export-package dialog for export_translation_package.idjs.
 * Replaces the legacy lfs.getFolder() native picker with a richer dialog:
 *
 *   - Output directory text input (defaults to <docDir>/<docname>_translation_package_<ts>)
 *   - "Browse..." button → opens lfs.getFolder() to pick a parent dir
 *   - Unsaved-document warning + "Save Now" button when doc is untitled / dirty
 *   - OK / Cancel
 *
 * Dark theme + reactive state matching reorganize_dialog_v2.
 *
 * Public API:
 *   showExportDialog(app, opts) → { outputDir, designer, project_name,
 *                                   source_language, target_language,
 *                                   workflow_mode, deadline } | null
 *
 *   opts:
 *     - doc            ← required; the active InDesign document
 *     - defaultDocDir  ← string; doc's parent dir resolved by caller (since
 *                        doc.fullName is async in UXP)
 *     - defaultLeafName ← string; suggested package folder name (e.g.
 *                        "doc_translation_package_20260528_154322")
 *     - defaultDesigner / defaultProjectName / defaultSourceLang /
 *       defaultTargetLang / defaultWorkflow ← pre-fills for the project-metadata
 *                        fields (from a carried _meta, if any). A3a'.
 *     - languageOptions ← [{ code, label }] for the source/target selects
 *                        (canonical list from lib/lang_script_table.js).
 *     - lfs            ← uxp.storage.localFileSystem (passed in so caller
 *                        controls UXP import path)
 *     - exportLog      ← optional logger function for breadcrumbs
 */

var LabelDelegate = require("./dialog_label_delegate.js");

function _esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 🪦 REMOVED 2026-08-28 (owner ruling): the project-metadata area does not talk
// to the operator any more — no three-state hint, no "edit only if needed", no
// "fill these in or the package carries nothing". Owner, after eye-verifying:
// 「B1 未提示，但也不应该提示，允许留空」·「edit only 这个东西之后要去掉，在交互上
// 不需要让用户知道」.
//
// ⚠ Deleted rather than hidden, on purpose. Everything that went with it —
// `_metaHintText`, `_META_FIELD_LABEL`, `assessCarriedMeta` and the
// metaState/metaMissing plumbing — existed ONLY to choose that sentence. A live
// assessment nothing renders is how a removed feature comes back by accident.
//
// 🔴 Checked BY EXECUTION before removing, that this does not turn a warned loss
// into a silent one: with every metadata field left blank the export still
// assembles a SCHEMA-VALID _meta.json, because inferDefaults(docName) supplies
// project_name/project_id and the dialog always returns a workflow_mode
// (measured 2026-08-28 against a passing control; pinned in
// tests/export_meta_silent_area_tests.js). By then the old "none" wording —
// "this package will carry no metadata" — was simply FALSE.
// ⚠ That validity rests on `und` standing in for an empty source_language:
// source_language is required with minLength 2, so absent / "" / null are all
// schema-INVALID in BOTH workflow modes (measured). Whoever removes `und`
// re-opens exactly the silent loss this note says is not there.

// TODO#53 (2026-08-14 #14a): fixed dialog ids are a time bomb — the persistent
// plugin context keeps a native-shell registration PER ID, and a later dialog
// with the same id can inherit a corrupted ghost shell's geometry (measured on
// proc-dlg: 6339x128 desktop-wide strip while DOM read green). Selector moved
// to the stable CLASS; the id is unique per show (existence checks must query
// the class, never a fixed id).
var _dlgSeq = 0;
var DIALOG_STYLES = [
    'dialog.export-dlg {',
    '  padding: 0; border: 1px solid #494949;',
    '  max-width: none; max-height: none;',  // neutralise the UA :modal max-block-size cap
    '  background: #1f1f1f; color: #e6e6e6; color-scheme: dark;',
    '}',
    // The REAL pixel size lives on this fixed-size CHILD (not the <dialog>), so the
    // OS window locks to it at showModal time — the proven font_mapping_panel_ui
    // pattern. Opaque bg + overflow-y:auto contain the content INSIDE the box (a
    // bare <dialog> is overflow:visible, so taller content renders OUTSIDE = the
    // "cut off / overflows window" symptom). Width/height are set inline per docState.
    '.export-shell {',
    '  max-width: none !important; max-height: none !important;',
    '  box-sizing: border-box; overflow-y: auto;',
    '  background: #1f1f1f;',
    '}',
    '.export-body { font-family: "Adobe Clean", sans-serif; padding: 18px 22px; background: #1f1f1f; color: #e6e6e6; }',
    '.export-body h2 { margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: #f0f0f0; }',
    '.export-body p { margin: 4px 0 10px 0; font-size: 12px; color: #9b9b9b; }',
    '.export-body label { font-size: 12px; color: #e6e6e6; }',
    '.export-body .field-row { margin: 6px 0; }',
    '.export-body .field-row .hint { margin: 1px 0 0 0; }',
    '.export-body .field-row label { display: block; margin-bottom: 4px; }',
    '.export-body .field-row .path-line { display: flex; gap: 6px; align-items: center; }',
    '.export-body .field-row input[type="text"], .export-body .field-row select {',
    '  flex: 1; padding: 5px 8px; font-size: 12px;',
    '  background: #2a2a2a; color: #e6e6e6;',
    '  border: 1px solid #5a5a5a; border-radius: 2px;',
    '}',
    '.export-body .field-row select { width: 100%; }',
    '.export-body .field-row > input[type="text"], .export-body .meta-2col > div input[type="text"] { width: 100%; box-sizing: border-box; }',  // single + columned inputs full-width like the selects
    '.export-body .field-row input[type="text"]:focus, .export-body .field-row select:focus { border-color: #2680eb; outline: none; }',
    '.export-body .meta-2col { display: flex; gap: 12px; }',
    '.export-body .meta-2col > div { flex: 1; }',
    '.export-body button {',
    '  background: #393939; color: #e6e6e6; border: 1px solid #5a5a5a;',
    '  border-radius: 3px; padding: 5px 12px; font-size: 12px; cursor: pointer;',
    '}',
    '.export-body button:hover:not([disabled]) { background: #464646; border-color: #6f6f6f; }',
    '.export-body button[disabled] { opacity: 0.35; cursor: not-allowed; }',
    '.export-body .footer { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }',
    '.export-body .footer button { padding: 5px 16px; }',
    '.export-body .footer button.primary { background: #2680eb; border-color: #2680eb; color: #fff; }',
    '.export-body .footer button.primary:hover { background: #378ef0; border-color: #378ef0; }',
    '.export-body .warning {',
    '  margin: 10px 0; padding: 10px 12px;',
    '  background: #3d2a1a; border: 1px solid #b86d2a; border-radius: 3px;',
    '  display: flex; align-items: center; gap: 12px;',
    '}',
    '.export-body .warning .icon { font-size: 16px; color: #f5a142; flex: 0 0 auto; }',
    '.export-body .warning .msg { flex: 1; font-size: 12px; color: #f0d0a0; }',
    '.export-body .warning button { background: #5a4020; border-color: #b86d2a; color: #f5d8a8; }',
    '.export-body .warning button:hover:not([disabled]) { background: #6d4d28; border-color: #d18546; }',
    '.export-body .hint { font-size: 11px; color: #7c7c7c; margin: 2px 0 0 0; }'
].join("\n");

// Read the current "saved" + "modified" state from the doc. UXP InDesign
// reports `saved` (bool — has a backing file) and `modified` (bool — has
// unsaved changes). Mirror those into a simple flag the dialog renders on.
async function _readDocState(doc) {
    var hasPath = false, modified = false;
    try {
        var fn = doc.fullName;
        if (fn && typeof fn.then === "function") fn = await fn;
        if (fn && (fn.nativePath || fn.fsName)) hasPath = true;
    } catch (e) {}
    try { modified = !!doc.modified; } catch (e) {}
    return {
        unsaved: !hasPath || modified,
        untitled: !hasPath,
        modified: modified
    };
}

// Try to save the doc. Returns true on success. For untitled docs, opens
// the native save-as picker. For named docs, calls doc.save() directly.
async function _saveDocument(doc, lfs, exportLog) {
    var log = exportLog || function () {};
    var fnNow = null;
    try {
        fnNow = doc.fullName;
        if (fnNow && typeof fnNow.then === "function") fnNow = await fnNow;
    } catch (e) {}
    var hasPath = fnNow && (fnNow.nativePath || fnNow.fsName);
    try {
        if (hasPath) {
            log("export-dialog: doc.save() on existing path");
            await doc.save();
            return true;
        }
        // Untitled — must Save As. Use lfs.getFileForSaving with .indd extension.
        log("export-dialog: untitled doc, opening Save As picker");
        var saveFile = await lfs.getFileForSaving("Untitled.indd", { types: ["indd"] });
        if (!saveFile) return false;
        var savePath = saveFile.nativePath || saveFile.fsName;
        if (!savePath) return false;
        await doc.save(savePath);
        return true;
    } catch (eSave) {
        log("export-dialog: save threw " + (eSave && eSave.message || eSave));
        return false;
    }
}

async function showExportDialog(app, opts) {
    if (typeof document === "undefined") return null;
    opts = opts || {};
    var doc = opts.doc;
    var lfs = opts.lfs;
    var exportLog = opts.exportLog || function () {};
    if (!doc || !lfs) return null;

    var defaultDocDir = opts.defaultDocDir || "";
    var defaultLeafName = opts.defaultLeafName || "translation_package";
    var defaultDesigner = opts.defaultDesigner || "";
    var defaultProjectName = opts.defaultProjectName || "";
    var defaultSourceLang = opts.defaultSourceLang || "";
    var defaultTargetLang = opts.defaultTargetLang || "";
    var defaultWorkflow = opts.defaultWorkflow || "translation";
    var defaultDeadline = opts.defaultDeadline || "";
    var languageOptions = opts.languageOptions || []; // [{ code, label }] from caller (lang_script_table)
    var sep = (defaultDocDir.indexOf("\\") >= 0) ? "\\" : "/";

    function _optsHtml(items, selected, emptyLabel) {
        var html = '<option value="">' + _esc(emptyLabel) + '</option>';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var val = (typeof it === "string") ? it : it.code;
            var lab = (typeof it === "string") ? it : (it.label || it.code);
            html += '<option value="' + _esc(val) + '"' + (val === selected ? ' selected' : '') + '>' + _esc(lab) + '</option>';
        }
        return html;
    }

    var docState = await _readDocState(doc);

    var dlg = document.createElement("dialog");
    // TODO#53: unique id (see note at DIALOG_STYLES) + stable class for checks
    dlg.id = "export-dlg-" + (++_dlgSeq) + "-" + Date.now().toString(36);
    dlg.className = "export-dlg";

    var initialPath = defaultDocDir ? (defaultDocDir + sep + defaultLeafName) : "";

    function _warningHtml(state) {
        if (!state.unsaved) return "";
        var msg = state.untitled
            ? "Document has never been saved. Save it first so the package can sit next to the .indd."
            : "Document has unsaved changes. Save before exporting so the package reflects your latest edits.";
        return '<div class="warning" id="save-warning">'
            + '  <span class="icon">⚠</span>'
            + '  <div class="msg">' + _esc(msg) + '</div>'
            + '  <button id="save-now-btn" type="button">Save document</button>'
            + '</div>';
    }

    dlg.innerHTML = '<style>' + DIALOG_STYLES + '</style>'
        + '<div class="export-shell" style="width:680px;height:' + (docState.unsaved ? 635 : 575) + 'px;">'
        + '<div class="export-body">'
        + '  <h2>Export Translation Package</h2>'
        + '  <p>The document will NOT be modified. The package is written to the folder you choose below.</p>'
        + '  <div id="warning-container">' + _warningHtml(docState) + '</div>'
        + '  <div class="field-row">'
        + '    <label for="out-path">Output directory:</label>'
        + '    <div class="path-line">'
        + '      <input type="text" id="out-path" value="' + _esc(initialPath) + '">'
        + '      <button id="browse-btn" type="button">Browse…</button>'
        + '    </div>'
        + '  </div>'
        + '  <div class="field-row">'
        + '    <label for="carry-path">Carry version history from a previous package (optional):</label>'
        + '    <div class="path-line">'
        + '      <input type="text" id="carry-path" value="" placeholder="Leave blank for a normal export (no version history)">'
        + '      <button id="carry-browse-btn" type="button">Browse…</button>'
        + '    </div>'
        + '    <p class="hint">Pick the previous export <b>.zip</b> to append this export as a new version. Blank = today’s export, unchanged.</p>'
        + '  </div>'
        + '  <div class="field-row">'
        + '    <label for="pm-project-name">Project name:</label>'
        + '    <input type="text" id="pm-project-name" maxlength="200" value="' + _esc(defaultProjectName) + '" placeholder="Project name">'
        + '  </div>'
        + '  <div class="field-row meta-2col">'
        + '    <div>'
        + '      <label for="pm-source-lang">Source language:</label>'
        + '      <select id="pm-source-lang">' + _optsHtml(languageOptions, defaultSourceLang, "— select —") + '</select>'
        + '    </div>'
        + '    <div>'
        + '      <label for="pm-target-lang">Target language:</label>'
        + '      <select id="pm-target-lang">' + _optsHtml(languageOptions, defaultTargetLang, "— none (edit-only) —") + '</select>'
        + '    </div>'
        + '  </div>'
        + '  <div class="field-row meta-2col">'
        + '    <div>'
        + '      <label for="pm-workflow">Workflow:</label>'
        + '      <select id="pm-workflow">'
        + '        <option value="translation"' + (defaultWorkflow === "translation" ? " selected" : "") + '>translation</option>'
        + '        <option value="edit-only"' + (defaultWorkflow === "edit-only" ? " selected" : "") + '>edit-only</option>'
        + '        <option value="bilingual"' + (defaultWorkflow === "bilingual" ? " selected" : "") + '>bilingual</option>'
        + '      </select>'
        + '    </div>'
        + '    <div>'
        + '      <label for="pm-deadline">Deadline:</label>'
        + '      <input type="text" id="pm-deadline" maxlength="30" value="' + _esc(defaultDeadline) + '" placeholder="YYYY-MM-DD">'
        + '    </div>'
        + '    <div>'
        + '      <label for="designer-name">Designer (you):</label>'
        + '      <input type="text" id="designer-name" maxlength="200" value="' + _esc(defaultDesigner) + '" placeholder="Your name">'
        + '    </div>'
        + '  </div>'
        + '  <div class="footer">'
        + '    <button id="export-cancel-btn" type="button">Cancel</button>'
        + '    <button id="export-ok-btn" type="button" class="primary"' + (docState.unsaved ? ' disabled' : '') + '>OK</button>'
        + '  </div>'
        + '</div>'   // .export-body
        + '</div>';  // .export-shell

    document.body.appendChild(dlg);
    LabelDelegate.wireLabelClicks(dlg);   // 点 label 文本也能切换关联 input

    var pathInput = dlg.querySelector("#out-path");
    var okBtn = dlg.querySelector("#export-ok-btn");
    var browseBtn = dlg.querySelector("#browse-btn");
    var carryInput = dlg.querySelector("#carry-path");
    var carryBrowseBtn = dlg.querySelector("#carry-browse-btn");

    // Optional "previous package" picker (version carry-forward). Picks a .zip;
    // blank = normal export (AC7 zero-regression, no versions/ written).
    if (carryBrowseBtn) {
        carryBrowseBtn.addEventListener("click", async function () {
            try {
                var picked = await lfs.getFileForOpening({ types: ["zip"] });
                if (picked) {
                    var pp = picked.nativePath || picked.fsName || "";
                    if (pp) carryInput.value = pp;
                }
            } catch (eCarry) {
                exportLog("carry browse threw: " + (eCarry && eCarry.message || eCarry));
            }
        });
    }

    browseBtn.addEventListener("click", async function () {
        try {
            var picked = await lfs.getFolder();
            if (picked && picked.nativePath) {
                // Keep the existing leaf folder name (let user have changed it).
                var cur = pathInput.value || "";
                var lastSep = Math.max(cur.lastIndexOf("\\"), cur.lastIndexOf("/"));
                var leaf = (lastSep >= 0 && lastSep < cur.length - 1) ? cur.substring(lastSep + 1) : defaultLeafName;
                var pickedPath = picked.nativePath;
                var pickedSep = (pickedPath.indexOf("\\") >= 0) ? "\\" : "/";
                pathInput.value = pickedPath + pickedSep + leaf;
            }
        } catch (eBrowse) {
            exportLog("browse threw: " + (eBrowse && eBrowse.message || eBrowse));
        }
    });

    // Save button — only present when doc.unsaved. After save, refresh
    // the warning + enable OK + repopulate path field if doc was untitled.
    function _wireSaveBtn() {
        var btn = dlg.querySelector("#save-now-btn");
        if (!btn) return;
        btn.addEventListener("click", async function () {
            btn.disabled = true;
            btn.textContent = "Saving…";
            try {
                var ok = await _saveDocument(doc, lfs, exportLog);
                if (ok) {
                    // Re-resolve doc dir if was untitled
                    try {
                        var fnNow = doc.fullName;
                        if (fnNow && typeof fnNow.then === "function") fnNow = await fnNow;
                        var fnPath = (fnNow && (fnNow.nativePath || fnNow.fsName)) || "";
                        if (fnPath && (!pathInput.value || pathInput.value === initialPath)) {
                            var ls = Math.max(fnPath.lastIndexOf("\\"), fnPath.lastIndexOf("/"));
                            var docDirNew = ls > 0 ? fnPath.substring(0, ls) : "";
                            var nsep = (docDirNew.indexOf("\\") >= 0) ? "\\" : "/";
                            if (docDirNew) pathInput.value = docDirNew + nsep + defaultLeafName;
                        }
                    } catch (eFn) {}
                    // Remove the warning + enable OK
                    var w = dlg.querySelector("#save-warning");
                    if (w) w.parentNode.removeChild(w);
                    okBtn.disabled = false;
                } else {
                    btn.disabled = false;
                    btn.textContent = "Save document";
                }
            } catch (eClick) {
                btn.disabled = false;
                btn.textContent = "Save document";
                exportLog("save-now click threw: " + (eClick && eClick.message || eClick));
            }
        });
    }
    _wireSaveBtn();

    var resolveOuter;
    var resultPromise = new Promise(function (r) { resolveOuter = r; });

    function _val(id) {
        var el = dlg.querySelector(id);
        return el ? (el.value || "").replace(/^\s+|\s+$/g, "") : "";
    }
    okBtn.addEventListener("click", function () {
        var p = _val("#out-path");
        if (!p) return; // ignore empty submit
        try { dlg.close("ok"); } catch (e) {}
        resolveOuter({
            outputDir: p,
            carryPackage: _val("#carry-path"),
            designer: _val("#designer-name"),
            project_name: _val("#pm-project-name"),
            source_language: _val("#pm-source-lang"),
            target_language: _val("#pm-target-lang"),
            workflow_mode: _val("#pm-workflow") || "translation",
            deadline: _val("#pm-deadline")
        });
    });
    dlg.querySelector("#export-cancel-btn").addEventListener("click", function () {
        try { dlg.close("cancel"); } catch (e) {}
        resolveOuter(null);
    });

    // The fixed-size .export-shell child (sized inline above) carries the real
    // pixel dimensions, so the OS window locks to it at showModal time — the
    // proven font_mapping_panel_ui pattern. A bare showModal is correct here: NO
    // dlg.style.height (setting height on the <dialog> only sizes the box top-down
    // while the auto-height body overflows OUTSIDE it; that path is "honored" only
    // in the MCP layout box, not the user-mode OS window — findings.md:866-877), and
    // NO showModalAutoHeight (its requestAnimationFrame wait can hang under bridge).
    try {
        var sm = dlg.showModal();
        if (sm && typeof sm.then === "function") {
            sm.catch(function () { resolveOuter(null); });
        }
    } catch (eShow) {
        resolveOuter(null);
    }

    var result = await resultPromise;
    try { dlg.remove(); } catch (e) {}
    return result;
}

module.exports = {
    showExportDialog: showExportDialog
};
