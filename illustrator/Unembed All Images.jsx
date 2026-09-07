// UnembedAllImages.jsx
// Export all embedded images to a folder and relink as external files.
// Optionally remove broken PlacedItems (including locked/hidden ones).

(function () {
    if (app.documents.length === 0) {
        alert("No document is open.");
        return;
    }

    var doc = app.activeDocument;

    if (!doc.fullName) {
        alert("Document has not been saved. Please save first.");
        return;
    }

    var docFolder = doc.fullName.parent;

    // --- Unlock all layers and items ---
    function unlockAll() {
        for (var li = 0; li < doc.layers.length; li++) {
            try {
                doc.layers[li].locked = false;
                doc.layers[li].visible = true;
            } catch (_) {}
            if (doc.layers[li].layers.length > 0) {
                for (var si = 0; si < doc.layers[li].layers.length; si++) {
                    try {
                        doc.layers[li].layers[si].locked = false;
                        doc.layers[li].layers[si].visible = true;
                    } catch (_) {}
                }
            }
        }
        for (var i = 0; i < doc.pageItems.length; i++) {
            try {
                doc.pageItems[i].locked = false;
                doc.pageItems[i].hidden = false;
            } catch (_) {}
        }
    }

    unlockAll();

    // --- Collect broken PlacedItems ---
    var broken = [];
    for (var i = 0; i < doc.placedItems.length; i++) {
        var pi = doc.placedItems[i];
        try {
            var f = pi.file;
            if (!f || !f.exists) broken.push(pi);
        } catch (_) {
            broken.push(pi);
        }
    }

    // --- Collect embedded RasterItems ---
    var embedded = [];
    for (var i = 0; i < doc.rasterItems.length; i++) {
        var ri = doc.rasterItems[i];
        if (!ri.embedded) continue;
        embedded.push(ri);
    }

    if (embedded.length === 0 && broken.length === 0) {
        alert("No embedded images or broken links found.");
        return;
    }

    // --- Default output folder: doc folder/Linked_assets, increment if exists ---
    function getDefaultFolder() {
        var base = docFolder + "/Linked_assets";
        var folder = new Folder(base);
        if (!folder.exists) return folder;
        var n = 1;
        while (true) {
            folder = new Folder(base + "_" + n);
            if (!folder.exists) return folder;
            n++;
        }
    }

    var outputFolder = getDefaultFolder();

    // --- UI ---
    var dlg = new Window("dialog", "Asset Management");
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];

    dlg.add("statictext", undefined, "Embedded images: " + embedded.length + "    Broken links: " + broken.length);

    var chkEmbed = dlg.add("checkbox", undefined, "Export all embedded images and relink as external files");
    chkEmbed.value = true;
    chkEmbed.enabled = embedded.length > 0;

    var chkBroken = dlg.add("checkbox", undefined, "Remove all broken links");
    chkBroken.value = false;
    chkBroken.enabled = broken.length > 0;

    var dirGroup = dlg.add("group");
    dirGroup.add("statictext", undefined, "Output folder:");
    var dirLabel = dirGroup.add("statictext", undefined, outputFolder.fsName);
    dirLabel.characters = 40;
    var dirBtn = dirGroup.add("button", undefined, "Change...");
    dirBtn.onClick = function () {
        var sel = Folder.selectDialog("Select output folder", outputFolder);
        if (sel) {
            outputFolder = sel;
            dirLabel.text = outputFolder.fsName;
        }
    };

    var btnGroup = dlg.add("group");
    btnGroup.alignment = ["center", "top"];
    btnGroup.add("button", undefined, "Run", { name: "ok" });
    btnGroup.add("button", undefined, "Cancel", { name: "cancel" });

    if (dlg.show() !== 1) return;

    var doEmbed = chkEmbed.value;
    var doBroken = chkBroken.value;

    if (!doEmbed && !doBroken) return;

    // --- Remove broken links ---
    var brokenRemoved = 0;
    if (doBroken) {
        for (var i = broken.length - 1; i >= 0; i--) {
            try {
                broken[i].remove();
                brokenRemoved++;
            } catch (_) {}
        }
    }

    // --- Export and relink embedded images ---
    var successCount = 0;
    var errors = [];

    if (doEmbed && embedded.length > 0) {
        if (!outputFolder.exists) outputFolder.create();

        var origInteraction = app.userInteractionLevel;
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

        var baseName = doc.fullName.name.replace(/\.[^\.]+$/, "");

        for (var i = 0; i < embedded.length; i++) {
            var ri = embedded[i];
            try {
                var fileName = baseName + "_img_" + (i + 1) + ".psd";
                var outFile = new File(outputFolder + "/" + fileName);

                var bounds = ri.geometricBounds;
                var w = bounds[2] - bounds[0];
                var h = bounds[1] - bounds[3];

                var preset = new DocumentPreset();
                preset.width = w;
                preset.height = h;
                preset.colorMode = doc.documentColorSpace;

                var tempDoc = app.documents.addDocument(doc.documentColorSpace, preset);
                var dupItem = ri.duplicate(tempDoc.layers[0]);
                var newAbRect = tempDoc.artboards[0].artboardRect;
                dupItem.position = [newAbRect[0], newAbRect[1]];

                var psdOpts = new ExportOptionsPhotoshop();
                psdOpts.resolution = 300;
                tempDoc.exportFile(outFile, ExportType.PHOTOSHOP, psdOpts);

                tempDoc.close(SaveOptions.DONOTSAVECHANGES);

                if (outFile.exists) {
                    var placed = doc.placedItems.add();
                    placed.file = outFile;
                    placed.position = ri.position;
                    placed.width = ri.width;
                    placed.height = ri.height;

                    try {
                        placed.move(ri, ElementPlacement.PLACEBEFORE);
                    } catch (_) {}

                    ri.remove();
                    successCount++;
                }
            } catch (e) {
                errors.push("Image " + (i + 1) + ": " + e.message);
                try {
                    while (app.documents.length > 1) {
                        var cur = app.activeDocument;
                        var curPath = "";
                        try { curPath = cur.fullName.fsName; } catch (_) {}
                        if (curPath !== doc.fullName.fsName) {
                            cur.close(SaveOptions.DONOTSAVECHANGES);
                        } else {
                            break;
                        }
                    }
                } catch (_) {}
            }
        }

        app.userInteractionLevel = origInteraction;
    }

    // --- Result ---
    var result = "Done:\n";
    if (successCount > 0) result += "  " + successCount + "/" + embedded.length + " image(s) exported and relinked\n";
    if (brokenRemoved > 0) result += "  " + brokenRemoved + " broken link(s) removed\n";
    if (successCount > 0) result += "  Output folder: " + outputFolder.fsName + "\n";
    if (errors.length > 0) {
        result += "\nErrors:\n" + errors.join("\n");
    }
    alert(result);
})();
