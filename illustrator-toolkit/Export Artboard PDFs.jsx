// ExportArtboardPDFs_v2.jsx
// Export each artboard as a separate PDF via duplicate to new document

(function () {
    if (app.documents.length === 0) {
        alert("No document open.");
        return;
    }

    var doc = app.activeDocument;

    if (!doc.fullName) {
        alert("Document not saved. Please save first.");
        return;
    }

    var docFile = doc.fullName;
    var docFolder = docFile.parent;

    var artboardCount = doc.artboards.length;

    if (artboardCount === 0) {
        alert("Document has no artboards.");
        return;
    }

    // --- Log (write-through) ---
    var logFilePath = null;
    function log(msg) {
        var line = new Date().toLocaleTimeString() + "  " + msg;
        $.writeln(line);
        if (logFilePath) {
            try {
                var f = new File(logFilePath);
                f.open("a");
                f.encoding = "UTF-8";
                f.writeln(line);
                f.close();
            } catch (_) {}
        }
    }
    function initLog(folder) {
        logFilePath = folder + "/ExportArtboardPDFs_v2_log.txt";
        try {
            var f = new File(logFilePath);
            f.open("w");
            f.encoding = "UTF-8";
            f.write("");
            f.close();
        } catch (_) {}
    }

    // --- Verify framework ---
    var verifyResults = [];
    function verify(name, condition) {
        var status = condition ? "PASS" : "FAIL";
        log("[Verify] " + status + ": " + name);
        verifyResults.push({ name: name, pass: condition });
        return condition;
    }

    log("Document: " + docFile.fsName);
    log("Artboards: " + artboardCount);

    // --- Embedded bleed config (hidden PathItem + Tag) ---
    var CONFIG_ITEM_NAME = "__ExportArtboardPDFs__";

    function readConfig() {
        try {
            for (var k = 0; k < doc.pageItems.length; k++) {
                if (doc.pageItems[k].name === CONFIG_ITEM_NAME) {
                    var tag = doc.pageItems[k].tags.getByName("config");
                    var parts = tag.value.split("|");
                    var vals = parts[0].split(",");
                    return {
                        top: parseFloat(vals[0]) || 0,
                        bottom: parseFloat(vals[1]) || 0,
                        left: parseFloat(vals[2]) || 0,
                        right: parseFloat(vals[3]) || 0,
                        unit: parts[1] || "mm"
                    };
                }
            }
        } catch (_) {}
        return null;
    }

    function writeConfig(cfg) {
        try {
            var item = null;
            for (var k = 0; k < doc.pageItems.length; k++) {
                if (doc.pageItems[k].name === CONFIG_ITEM_NAME) {
                    item = doc.pageItems[k];
                    break;
                }
            }
            if (!item) {
                item = doc.layers[0].pathItems.add();
                item.name = CONFIG_ITEM_NAME;
                item.hidden = true;
            }
            var tag;
            try {
                tag = item.tags.getByName("config");
            } catch (_) {
                tag = item.tags.add();
                tag.name = "config";
            }
            tag.value = cfg.top + "," + cfg.bottom + "," + cfg.left + "," + cfg.right + "|" + cfg.unit;
        } catch (e) {
            log("Failed to write config: " + e.message);
        }
    }

    var savedConfig = readConfig();
    log("Saved bleed config: " + (savedConfig ? savedConfig.top + "," + savedConfig.bottom + "," + savedConfig.left + "," + savedConfig.right + " " + savedConfig.unit : "none"));

    // --- Broken link detection ---
    // 0 = no broken links, 1 = skip during export, 2 = delete from document
    var brokenAction = 0;
    var brokenCount = 0;
    for (var bl = 0; bl < doc.placedItems.length; bl++) {
        try {
            var blFile = doc.placedItems[bl].file;
            if (!blFile || !blFile.exists) brokenCount++;
        } catch (_) {
            brokenCount++;
        }
    }
    if (brokenCount > 0) {
        var brokenDlg = new Window("dialog", "Broken Links");
        brokenDlg.orientation = "column";
        brokenDlg.alignChildren = ["fill", "top"];
        brokenDlg.add("statictext", undefined, "Detected " + brokenCount + " broken link(s).");
        brokenDlg.add("statictext", undefined, "These may cause export to hang or produce empty files.");
        var btnRelink = brokenDlg.add("button", undefined, "Relink - select folder to find missing files");
        var btnSkip = brokenDlg.add("button", undefined, "Skip during export (keep in document)");
        var btnDelete = brokenDlg.add("button", undefined, "Delete from document");
        var btnCancel = brokenDlg.add("button", undefined, "Cancel export");
        btnRelink.onClick = function () {
            var relinkFolder = Folder.selectDialog("Select folder containing the missing files");
            if (!relinkFolder) return;
            var relinked = 0, notFound = 0;
            for (var rl = 0; rl < doc.placedItems.length; rl++) {
                var rpi = doc.placedItems[rl];
                try {
                    var rpf = rpi.file;
                    if (rpf && rpf.exists) continue;
                    var origName = "";
                    try { origName = rpf.name; } catch (_) {}
                    if (!origName) { notFound++; continue; }
                    var newFile = new File(relinkFolder + "/" + origName);
                    if (newFile.exists) {
                        rpi.relink(newFile);
                        relinked++;
                    } else {
                        notFound++;
                    }
                } catch (_) { notFound++; }
            }
            if (notFound === 0) {
                alert("All " + relinked + " link(s) relinked successfully.");
                brokenAction = 0;
            } else {
                alert("Relinked: " + relinked + ", still missing: " + notFound);
                brokenCount = notFound;
                brokenAction = 1;
            }
            brokenDlg.close();
        };
        btnSkip.onClick = function () { brokenAction = 1; brokenDlg.close(); };
        btnDelete.onClick = function () { brokenAction = 2; brokenDlg.close(); };
        btnCancel.onClick = function () { brokenAction = -1; brokenDlg.close(); };
        brokenDlg.show();
        if (brokenAction === -1) return;
        log("Broken links: " + brokenCount + ", action: " + (brokenAction === 0 ? "relinked" : brokenAction === 1 ? "skip" : "delete"));
    }

    // --- UI ---
    var PRESETS = ["[Smallest File Size]", "[High Quality Print]", "[Press Quality]", "[PDF/X-1a:2001]", "[PDF/X-4:2008]"];
    var UNITS = ["mm", "pt", "in", "px"];
    var UNIT_TO_PT = { mm: 2.834645669, pt: 1, "in": 72, px: 1 };

    var dlg = new Window("dialog", "Export Artboards as PDF");
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];

    dlg.add("statictext", undefined, artboardCount + " artboard(s) - export each as separate file");
    dlg.add("statictext", undefined, "File names come from artboard names. Rename artboards in the Artboards panel.");
    dlg.add("statictext", undefined, "Files saved to a new folder next to the document.");

    // --- PDF output ---
    var pdfGroup = dlg.add("group");
    var chkPDF = pdfGroup.add("checkbox", undefined, "PDF");
    chkPDF.value = true;
    var pdfPresetDrop = pdfGroup.add("dropdownlist", undefined, PRESETS);
    pdfPresetDrop.selection = 0;
    chkPDF.onClick = function () { pdfPresetDrop.enabled = chkPDF.value; };

    // --- Print PDF output ---
    var printGroup = dlg.add("group");
    var chkPrint = printGroup.add("checkbox", undefined, "Print PDF");
    chkPrint.value = false;
    var printPresetDrop = printGroup.add("dropdownlist", undefined, PRESETS);
    printPresetDrop.selection = 1; // High Quality Print
    printPresetDrop.enabled = false;

    // Bleed panel (follows Print PDF)
    var bleedPanel = dlg.add("group");
    bleedPanel.orientation = "column";
    bleedPanel.alignChildren = ["fill", "top"];

    if (!savedConfig) {
        var hint1 = bleedPanel.add("statictext", undefined, "Enter bleed values for this document.");
        hint1.characters = 45;
        var hint2 = bleedPanel.add("statictext", undefined, "Save the document after export to keep these settings.");
        hint2.characters = 55;
    }

    var bleedRow1 = bleedPanel.add("group");
    var lblBleed = bleedRow1.add("statictext", undefined, "Bleed");
    lblBleed.characters = 5;
    var unitDropdown = bleedRow1.add("dropdownlist", undefined, UNITS);
    var savedUnitIdx = savedConfig ? (function () { for (var u = 0; u < UNITS.length; u++) { if (UNITS[u] === savedConfig.unit) return u; } return 2; })() : 2; // default: in
    unitDropdown.selection = savedUnitIdx;
    if (savedConfig) {
        var lblSaved = bleedRow1.add("statictext", undefined, "(saved)");
        lblSaved.characters = 8;
    }

    var bleedRow2 = bleedPanel.add("group");
    var lblTop = bleedRow2.add("statictext", undefined, "Top:");
    lblTop.characters = 3;
    var bleedTop = bleedRow2.add("edittext", undefined, savedConfig ? String(savedConfig.top) : "0.125");
    bleedTop.characters = 4;
    bleedRow2.add("statictext", undefined, "").characters = 1; // spacer
    var lblBottom = bleedRow2.add("statictext", undefined, "Bottom:");
    lblBottom.characters = 6;
    var bleedBottom = bleedRow2.add("edittext", undefined, savedConfig ? String(savedConfig.bottom) : "0.125");
    bleedBottom.characters = 4;
    bleedRow2.add("statictext", undefined, "").characters = 1; // spacer
    var lblLeft = bleedRow2.add("statictext", undefined, "Left:");
    lblLeft.characters = 3;
    var bleedLeft = bleedRow2.add("edittext", undefined, savedConfig ? String(savedConfig.left) : "0.125");
    bleedLeft.characters = 4;
    bleedRow2.add("statictext", undefined, "").characters = 1; // spacer
    var lblRight = bleedRow2.add("statictext", undefined, "Right:");
    lblRight.characters = 4;
    var bleedRight = bleedRow2.add("edittext", undefined, savedConfig ? String(savedConfig.right) : "0.125");
    bleedRight.characters = 4;

    bleedPanel.enabled = false;
    chkPrint.onClick = function () {
        printPresetDrop.enabled = chkPrint.value;
        bleedPanel.enabled = chkPrint.value;
    };

    // --- AI output ---
    var chkAI = dlg.add("checkbox", undefined, ".ai File");
    chkAI.value = false;

    var btnGroup = dlg.add("group");
    btnGroup.alignment = ["center", "top"];
    var exportBtn = btnGroup.add("button", undefined, "Export", { name: "ok" });
    btnGroup.add("button", undefined, "Cancel", { name: "cancel" });

    // Update export button state
    function updateExportBtn() {
        exportBtn.enabled = chkPDF.value || chkPrint.value || chkAI.value;
    }
    var origPdfClick = chkPDF.onClick;
    chkPDF.onClick = function () { if (origPdfClick) origPdfClick(); updateExportBtn(); };
    var origPrintClick = chkPrint.onClick;
    chkPrint.onClick = function () { if (origPrintClick) origPrintClick(); updateExportBtn(); };
    chkAI.onClick = function () { updateExportBtn(); };
    updateExportBtn();

    if (dlg.show() !== 1) return;

    var doPDF = chkPDF.value;
    var doPrint = chkPrint.value;
    var doAI = chkAI.value;

    if (!doPDF && !doPrint && !doAI) {
        alert("No output selected.");
        return;
    }

    var pdfPreset = pdfPresetDrop.selection.text;
    var printPreset = printPresetDrop.selection.text;

    // Bleed config
    var bleedUnit = unitDropdown.selection.text;
    var bleedScale = UNIT_TO_PT[bleedUnit] || 1;
    var bleedRaw = {
        top: parseFloat(bleedTop.text) || 0,
        bottom: parseFloat(bleedBottom.text) || 0,
        left: parseFloat(bleedLeft.text) || 0,
        right: parseFloat(bleedRight.text) || 0,
        unit: bleedUnit
    };
    var bleedCfg = {
        top: bleedRaw.top * bleedScale,
        bottom: bleedRaw.bottom * bleedScale,
        left: bleedRaw.left * bleedScale,
        right: bleedRaw.right * bleedScale
    };
    if (doPrint) {
        writeConfig(bleedRaw);
        log("Bleed config stored: " + bleedRaw.top + "," + bleedRaw.bottom + "," + bleedRaw.left + "," + bleedRaw.right + " " + bleedRaw.unit);
    }

    // Auto-create output folder: docFolder/timestamp
    var now = new Date();
    var timeStr = now.getFullYear()
        + ("0" + (now.getMonth() + 1)).slice(-2)
        + ("0" + now.getDate()).slice(-2)
        + "_" + ("0" + now.getHours()).slice(-2)
        + ("0" + now.getMinutes()).slice(-2);
    var outputFolder = new Folder(docFolder + "/" + timeStr + "_export");
    if (!outputFolder.exists) outputFolder.create();
    initLog(outputFolder);

    log("Output: " + outputFolder.fsName);
    if (doPDF) log("PDF: " + pdfPreset);
    if (doPrint) log("Print PDF: " + printPreset + " + Marks & Bleeds");
    if (doAI) log("AI: enabled");

    // Suppress save dialogs (version compat, color profile, etc.), restore at end
    var origInteraction = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

    // --- Handle broken links ---
    if (brokenAction === 2) {
        // Delete only top-level broken PlacedItems (parent is Layer).
        // Nested ones (parent is GroupItem) are left for duplicateSkipBroken
        // to handle during export - both remove() and relink() on nested
        // items corrupt document state and cause newDoc.close() to destroy
        // the original document.
        var removed = 0, nestedSkipped = 0;
        for (var br = doc.placedItems.length - 1; br >= 0; br--) {
            var isBr = false;
            try {
                var bf = doc.placedItems[br].file;
                if (!bf || !bf.exists) isBr = true;
            } catch (_) { isBr = true; }
            if (isBr) {
                if (doc.placedItems[br].parent.typename === "Layer") {
                    try { doc.placedItems[br].remove(); removed++; } catch (_) {}
                } else {
                    nestedSkipped++;
                }
            }
        }
        log("Deleted " + removed + " top-level broken link(s)" +
            (nestedSkipped > 0 ? ", " + nestedSkipped + " nested (skipped during export)" : ""));
    }

    // --- Helpers ---

    function sanitizeFileName(name) {
        return name.replace(/[\\\/:\*\?"<>\|]/g, "_");
    }

    function rectsIntersect(r1, r2) {
        return !(r1[2] < r2[0] || r2[2] < r1[0] || r1[3] > r2[1] || r2[3] > r1[1]);
    }

    function isBrokenPlacedItem(item) {
        if (item.typename !== "PlacedItem") return false;
        try { var f = item.file; return (!f || !f.exists); }
        catch (_) { return true; }
    }

    function hasBrokenLink(item) {
        if (item._blc !== undefined) return item._blc;
        var result = false;
        if (isBrokenPlacedItem(item)) {
            result = true;
        } else if (item.typename === "GroupItem") {
            for (var c = 0; c < item.pageItems.length; c++) {
                if (hasBrokenLink(item.pageItems[c])) { result = true; break; }
            }
        }
        item._blc = result;
        return result;
    }

    // Remove broken PlacedItems from a duplicated group in newDoc.
    function removeBrokenFromCopy(grp) {
        var removed = 0;
        for (var i = grp.pageItems.length - 1; i >= 0; i--) {
            var child = grp.pageItems[i];
            if (isBrokenPlacedItem(child)) {
                try { child.remove(); removed++; } catch (_) {}
            } else if (child.typename === "GroupItem" && hasBrokenLink(child)) {
                removed += removeBrokenFromCopy(child);
            }
        }
        return removed;
    }

    // Duplicate item to target, preserving group structure.
    // For groups with broken links: duplicate whole group, then remove
    // broken PlacedItems from the copy (preserves clipping/opacity).
    function duplicateSkipBroken(item, target) {
        if (isBrokenPlacedItem(item)) return 1;
        if (item.typename === "GroupItem" && hasBrokenLink(item)) {
            try {
                var copy = item.duplicate(target);
                return removeBrokenFromCopy(copy);
            } catch (_) { return 0; }
        }
        try { item.duplicate(target); } catch (_) {}
        return 0;
    }

    // --- Document structure diagnostics ---
    var colorSpace = doc.documentColorSpace;
    log("=== Document Structure ===");
    log("Layers: " + doc.layers.length);
    for (var li = 0; li < doc.layers.length; li++) {
        var ly = doc.layers[li];
        log("  Layer[" + li + "]: \"" + ly.name + "\" items=" + ly.pageItems.length + " sublayers=" + ly.layers.length);
        for (var pi = 0; pi < Math.min(ly.pageItems.length, 20); pi++) {
            var item = ly.pageItems[pi];
            var pType = item.parent.typename;
            var info = item.typename + " parent=" + pType;
            try { info += " bounds=[" + item.geometricBounds + "]"; } catch (_) { info += " bounds=N/A"; }
            if (item.typename === "GroupItem") info += " items=" + item.pageItems.length;
            log("    [" + pi + "] " + info);
        }
    }
    log("=== Begin Export ===");

    var successCount = 0;
    var errors = [];

    // Cache artboard info to avoid stale references
    var abInfos = [];
    for (var a = 0; a < artboardCount; a++) {
        var _ab = doc.artboards[a];
        var _r = _ab.artboardRect;
        abInfos.push({
            name: _ab.name,
            rect: [_r[0], _r[1], _r[2], _r[3]],
            w: _r[2] - _r[0],
            h: _r[1] - _r[3]
        });
    }

    for (var i = 0; i < artboardCount; i++) {
        var abInfo = abInfos[i];
        var abRect = abInfo.rect;
        var abW = abInfo.w;
        var abH = abInfo.h;
        var abName = sanitizeFileName(abInfo.name);

        log("--- Artboard " + (i + 1) + "/" + artboardCount + ": " + abInfo.name + " ---");
        log("  Size: " + Math.round(abW) + " x " + Math.round(abH) + " pt");
        log("  Rect: [" + abRect + "]");

        try {
            // === Step 1: Select items intersecting artboard ===
            try { doc.activate(); } catch (_) {}
            app.redraw();

            var itemsToCopy = [];
            for (var j = 0; j < doc.pageItems.length; j++) {
                var pi = doc.pageItems[j];
                if (pi.parent.typename !== "Layer") continue;
                // Skip broken PlacedItems if user chose "skip"
                if (brokenAction === 1 && pi.typename === "PlacedItem") {
                    try {
                        var pf = pi.file;
                        if (!pf || !pf.exists) continue;
                    } catch (_) { continue; }
                }
                try {
                    var bounds = pi.geometricBounds;
                    if (rectsIntersect(abRect, bounds)) {
                        itemsToCopy.push(pi);
                    }
                } catch (_) {}
            }
            log("  Step1: Found " + itemsToCopy.length + " intersecting top-level items (total pageItems=" + doc.pageItems.length + ")");
            verify("Artboard " + (i + 1) + " items > 0", itemsToCopy.length > 0);

            if (itemsToCopy.length === 0) {
                log("  Skipping empty artboard");
                continue;
            }

            // === Step 2: New document + duplicate items ===
            var preset = new DocumentPreset();
            preset.width = abW;
            preset.height = abH;
            preset.colorMode = colorSpace;
            var newDoc = app.documents.addDocument(colorSpace, preset);
            var newAbRect = newDoc.artboards[0].artboardRect;
            log("  Step2: New doc artboard rect: [" + newAbRect + "]");

            // Measure duplicate offset with probe element
            var firstSrcPos = itemsToCopy[0].position;
            var probe = itemsToCopy[0].duplicate(newDoc.layers[0]);
            var firstDstPos = probe.position;
            var dupDx = firstDstPos[0] - firstSrcPos[0];
            var dupDy = firstDstPos[1] - firstSrcPos[1];
            probe.remove();
            log("  Step2: Duplicate offset dx=" + Math.round(dupDx) + " dy=" + Math.round(dupDy));

            // Pre-scan: which top-level items contain broken links?
            var hasBroken = [];
            for (var d = 0; d < itemsToCopy.length; d++) {
                hasBroken[d] = hasBrokenLink(itemsToCopy[d]);
            }

            // Duplicate bottom-to-top (preserve z-order), skipping broken PlacedItems
            var t1 = new Date().getTime();
            var skippedBroken = 0;
            for (var d = itemsToCopy.length - 1; d >= 0; d--) {
                if (hasBroken[d]) {
                    skippedBroken += duplicateSkipBroken(itemsToCopy[d], newDoc.layers[0]);
                } else {
                    try { itemsToCopy[d].duplicate(newDoc.layers[0]); } catch (_) {}
                }
            }
            log("  [Timing] duplicate: " + (new Date().getTime() - t1) + "ms");
            if (skippedBroken > 0) log("  Step2: Skipped " + skippedBroken + " broken PlacedItem(s)");
            var t2 = new Date().getTime();
            newDoc.activate();
            app.redraw();
            log("  [Timing] activate+redraw: " + (new Date().getTime() - t2) + "ms");

            // Artboard = original rect + duplicate offset
            newDoc.artboards[0].artboardRect = [
                abRect[0] + dupDx, abRect[1] + dupDy,
                abRect[2] + dupDx, abRect[3] + dupDy
            ];
            log("  Step2: Duplicated " + newDoc.pageItems.length + " items, artboard rect [" + newDoc.artboards[0].artboardRect + "]");

            var pastedCount = newDoc.pageItems.length;
            log("  Step2: " + pastedCount + " items in new doc");

            // Log first few items for diagnostics
            for (var p = 0; p < Math.min(pastedCount, 3); p++) {
                var pi = newDoc.pageItems[p];
                var info = pi.typename;
                if (pi.typename === "GroupItem") {
                    info += " clipped=" + pi.clipped + " items=" + pi.pageItems.length;
                }
                log("  Step2: Item[" + p + "] " + info + " bounds=[" + pi.geometricBounds + "]");
            }

            verify("Artboard " + (i + 1) + " pasted > 0", pastedCount > 0);

            // === Step 3: Remove items outside artboard ===
            var finalAbRect = newDoc.artboards[0].artboardRect;
            if (pastedCount > 0) {
                var removeCount = 0;
                for (var r = newDoc.pageItems.length - 1; r >= 0; r--) {
                    try {
                        var item = newDoc.pageItems[r];
                        if (item.parent.typename !== "Layer") continue;
                        var rb = item.geometricBounds;
                        if (!rectsIntersect(finalAbRect, rb)) {
                            item.remove();
                            removeCount++;
                        }
                    } catch (_) {}
                }
                log("  Step3: Removed " + removeCount + " outside items, kept " + (pastedCount - removeCount));
            }

            // Verify alignment
            if (newDoc.pageItems.length > 0) {
                var firstBounds = newDoc.pageItems[0].geometricBounds;
                var inBoard = rectsIntersect(finalAbRect, firstBounds);
                verify("Artboard " + (i + 1) + " first item in bounds", inBoard);
                log("  Step3: Artboard rect: [" + finalAbRect + "], first item bounds: [" + firstBounds + "]");
            }

            // === Step 3.5: Verify no broken PlacedItems remain ===
            // duplicateSkipBroken() should have excluded all broken links.
            var brokenInNew = 0;
            for (var bc = newDoc.placedItems.length - 1; bc >= 0; bc--) {
                try {
                    var bcf = newDoc.placedItems[bc].file;
                    if (!bcf || !bcf.exists) brokenInNew++;
                } catch (_) { brokenInNew++; }
            }
            if (brokenInNew > 0)
                log("  Step3.5: WARNING " + brokenInNew + " broken link(s) still in newDoc (unexpected)");

            // === Step 4: Export (multiple formats from same newDoc) ===

            // PDF
            if (doPDF) {
                var pdfFile = new File(outputFolder + "/" + abName + ".pdf");
                var pdfOpts = new PDFSaveOptions();
                pdfOpts.pDFPreset = pdfPreset;
                var t4 = new Date().getTime();
                log("  Step4: Saving PDF (" + pdfPreset + ")...");
                newDoc.saveAs(pdfFile, pdfOpts);
                log("  [Timing] PDF: " + (new Date().getTime() - t4) + "ms, " + Math.round(pdfFile.length / 1024) + " KB");
                if (pdfFile.exists) successCount++;
            }

            // Print PDF (with marks and bleeds)
            if (doPrint) {
                var printFile = new File(outputFolder + "/" + abName + "_print.pdf");
                var printOpts = new PDFSaveOptions();
                printOpts.pDFPreset = printPreset;
                printOpts.bleedOffsetRect = [
                    bleedCfg.left, bleedCfg.top,
                    bleedCfg.right, bleedCfg.bottom
                ];
                printOpts.trimMarks = true;
                printOpts.registrationMarks = true;
                printOpts.colorBars = true;
                printOpts.pageInformation = true;
                printOpts.trimMarkWeight = PDFTrimMarkWeight.TRIMMARKWEIGHT0125;
                printOpts.offset = 6;
                var t5 = new Date().getTime();
                log("  Step4: Saving Print PDF (" + printPreset + " + bleeds)...");
                newDoc.saveAs(printFile, printOpts);
                log("  [Timing] Print PDF: " + (new Date().getTime() - t5) + "ms, " + Math.round(printFile.length / 1024) + " KB");
                if (printFile.exists) successCount++;
            }

            // AI
            if (doAI) {
                var aiFile = new File(outputFolder + "/" + abName + ".ai");
                var aiOpts = new IllustratorSaveOptions();
                var t6 = new Date().getTime();
                log("  Step4: Saving AI...");
                newDoc.saveAs(aiFile, aiOpts);
                log("  [Timing] AI: " + (new Date().getTime() - t6) + "ms, " + Math.round(aiFile.length / 1024) + " KB");
                if (aiFile.exists) successCount++;
            }

            log("  [Debug] docs before close: " + app.documents.length);
            newDoc.close(SaveOptions.DONOTSAVECHANGES);
            log("  [Debug] docs after close: " + app.documents.length);

            try { doc.activate(); } catch (_) {}
            app.redraw();

        } catch (e) {
            errors.push("Artboard " + (i + 1) + " (" + abInfo.name + "): " + e.message);
            log("  Error: " + e.message);
        }

        // === End of loop: ensure original doc is active ===
        try {
            var safety = 0;
            while (app.documents.length > 1 && safety < 10) {
                safety++;
                try {
                    var cur = app.activeDocument;
                    var curPath = "";
                    try { curPath = cur.fullName.fsName; } catch (_) {}
                    if (curPath !== docFile.fsName) {
                        cur.close(SaveOptions.DONOTSAVECHANGES);
                    } else {
                        break;
                    }
                } catch (_) { break; }
            }
            if (app.documents.length > 0) {
                doc = app.activeDocument;
                try { doc.activate(); } catch (_) {}
            }
        } catch (_) {}
        if (app.documents.length > 0) {
            try { app.redraw(); } catch (_) {}
        }

        // Free memory between iterations
        try { $.gc(); } catch (_) {}
    }

    // --- Verify summary ---
    var passCount = 0;
    var failCount = 0;
    for (var v = 0; v < verifyResults.length; v++) {
        if (verifyResults[v].pass) passCount++;
        else failCount++;
    }
    log("=== Verify: " + passCount + " PASS, " + failCount + " FAIL ===");
    var outputTypes = (doPDF ? 1 : 0) + (doPrint ? 1 : 0) + (doAI ? 1 : 0);
    var expectedTotal = artboardCount * outputTypes;
    log("=== Export complete: " + successCount + "/" + expectedTotal + " files ===");

    // Restore interaction level
    app.userInteractionLevel = origInteraction;

    // --- Result ---
    var msg = "Export complete: " + successCount + "/" + expectedTotal + " files (" + artboardCount + " artboards x " + outputTypes + " formats)";
    msg += "\nVerify: " + passCount + " PASS, " + failCount + " FAIL";
    if (errors.length > 0) {
        msg += "\n\nErrors:\n" + errors.join("\n");
    }
    msg += "\n\nLog saved to output folder";
    alert(msg);

    if (successCount > 0) {
        outputFolder.execute();
    }
})();
