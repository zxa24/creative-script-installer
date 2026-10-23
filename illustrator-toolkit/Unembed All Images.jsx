// UnembedAllImages.jsx
// Export all embedded images to a folder and relink them as external files.
// Optionally remove broken PlacedItems.
//
// v2 (2026-09-18) - export core rewritten around doc.imageCapture:
//   * Native-resolution PNG by default: resolution is derived from the image's own pixel
//     dimensions (rasterItem.boundingBox) instead of a fixed 300 ppi, so the exported file
//     has exactly the original pixel count - no resampling. Verified pixel-identical
//     (max channel delta 0) on a 6-artboard document.
//   * No temporary documents. The old code duplicated each raster into a temp document,
//     which is slow and can crash Illustrator's heap; now the image is moved to a temporary
//     layer inside the same document and captured there.
//   * Non-destructive: layer/item lock + visibility states are snapshotted and restored.
//     The old unlockAll() made every hidden item visible permanently.
//   * Relinked image is put back into the SAME parent and z-position (clipping groups keep
//     clipping), keeps the original hidden state, and its bounds are verified (< 0.01 pt)
//     before the embedded original is deleted. Any failure rolls back and keeps the original.
//   * Output names carry the native pixel size and never overwrite an existing file.
//
// Traps encoded here (learned the hard way, do not "simplify" them away):
//   1. ImageCaptureOptions.resolution has a minimum of 72. An image used at less than 72 ppi
//      can only be captured at 72 (slightly more pixels than native, no quality loss, but it
//      is one resample). Such images are reported as "upsampled".
//   2. Hiding the other page items does NOT work for an image inside a group - hiding its
//      parent group hides the image itself and the capture comes out fully transparent.
//      Moving it to a temporary layer is the only reliable isolation.
//   3. A hidden layer cannot be modified. Order must be: move -> hide others -> capture ->
//      restore visibility -> move back. Doing it the other way throws
//      "Target layer cannot be modified" / "Cannot modify a layer that is locked".
//   4. Never delete an existing file to make room for an export: if the later capture fails,
//      an already-good link has been destroyed.

(function () {
    if (app.documents.length === 0) {
        alert("No document is open.");
        return;
    }

    var doc = app.activeDocument;

    if (doc.layers.length && doc.layers[0].name === "Isolation Mode") {
        alert("The document is in Isolation Mode. Press Esc to exit, then run again.");
        return;
    }

    if (!doc.fullName) {
        alert("Document has not been saved. Please save first.");
        return;
    }

    var docFolder = doc.fullName.parent;

    // ---------- collect ----------
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

    var embedded = [];
    for (var i = 0; i < doc.rasterItems.length; i++) {
        if (doc.rasterItems[i].embedded) embedded.push(doc.rasterItems[i]);
    }

    if (embedded.length === 0 && broken.length === 0) {
        alert("No embedded images or broken links found.");
        return;
    }

    function nativePx(r) {
        var bb = r.boundingBox;                       // [0, h, w, 0] in image pixels
        return [Math.abs(bb[2] - bb[0]), Math.abs(bb[1] - bb[3])];
    }
    function impliedPpi(r) {
        var g = r.geometricBounds;
        return nativePx(r)[0] * 72 / (g[2] - g[0]);
    }

    var lowPpi = 0;
    for (var i = 0; i < embedded.length; i++) if (impliedPpi(embedded[i]) < 72) lowPpi++;

    // ---------- output folder ----------
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

    // ---------- UI ----------
    var dlg = new Window("dialog", "Asset Management");
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];

    dlg.add("statictext", undefined, "Embedded images: " + embedded.length + "    Broken links: " + broken.length);

    var chkEmbed = dlg.add("checkbox", undefined, "Export all embedded images and relink as external files");
    chkEmbed.value = true;
    chkEmbed.enabled = embedded.length > 0;

    var fmtPanel = dlg.add("panel", undefined, "Export format");
    fmtPanel.orientation = "column";
    fmtPanel.alignChildren = ["left", "top"];
    fmtPanel.margins = 12;
    var rbPng = fmtPanel.add("radiobutton", undefined, "PNG at native resolution (lossless, recommended)");
    var rbPsd = fmtPanel.add("radiobutton", undefined, "PSD at 300 ppi (legacy; resamples every image)");
    rbPng.value = true;
    if (lowPpi > 0) {
        fmtPanel.add("statictext", undefined,
            lowPpi + " image(s) are used below 72 ppi and will be captured at 72 ppi (one resample).");
    }

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
    var usePng = rbPng.value;
    if (!doEmbed && !doBroken) return;

    // ---------- remove broken links ----------
    var brokenRemoved = 0;
    if (doBroken) {
        for (var i = broken.length - 1; i >= 0; i--) {
            try {
                var b = broken[i];
                try { b.locked = false; b.hidden = false; } catch (_) {}
                try { if (b.layer) { b.layer.locked = false; b.layer.visible = true; } } catch (_) {}
                b.remove();
                brokenRemoved++;
            } catch (_) {}
        }
    }

    // ---------- export helpers ----------
    // Unique name, never overwrites: <docBase>_<w>x<h>[_n].<ext>
    function uniqueFile(folder, base, ext) {
        var f = new File(folder + "/" + base + "." + ext), n = 1;
        while (f.exists) { f = new File(folder + "/" + base + "_" + (++n) + "." + ext); }
        return f;
    }

    // Capture one raster at native resolution, without touching anything else permanently.
    function captureNative(r, outFile) {
        var g = r.geometricBounds, px = nativePx(r);
        var res = px[0] * 72 / (g[2] - g[0]), upsampled = false;
        if (res < 72) { res = 72; upsampled = true; }     // trap 1

        var parent = r.parent, idx = -1;
        for (var i = 0; i < parent.pageItems.length; i++) if (parent.pageItems[i] === r) idx = i;
        var above = (idx > 0) ? parent.pageItems[idx - 1] : null;

        var wasHidden = r.hidden, wasLocked = r.locked;
        var tmp = doc.layers.add();
        tmp.name = "__unembed_tmp";
        var states = [], err = "";

        try {
            if (wasLocked) r.locked = false;
            if (wasHidden) r.hidden = false;
            r.move(tmp, ElementPlacement.PLACEATBEGINNING);                    // trap 2 + 3: move first
            for (var L = 0; L < doc.layers.length; L++) {
                var ly = doc.layers[L];
                if (ly === tmp) continue;
                states.push([ly, ly.visible, ly.locked]);
                ly.locked = false;
                ly.visible = false;
            }
            app.redraw();
            var opt = new ImageCaptureOptions();
            opt.resolution = res;
            opt.antiAliasing = false;
            opt.transparency = true;
            doc.imageCapture(outFile, [g[0], g[1], g[2], g[3]], opt);
        } catch (e) {
            err = e.message ? e.message : String(e);
        }
        for (var s = 0; s < states.length; s++) {                              // restore visibility first
            states[s][0].visible = states[s][1];
            states[s][0].locked = states[s][2];
        }
        try {                                                                   // then move back
            if (above) r.move(above, ElementPlacement.PLACEAFTER);
            else r.move(parent, ElementPlacement.PLACEATBEGINNING);
        } catch (e2) {
            err += (err ? " | " : "") + "restore: " + (e2.message ? e2.message : String(e2));
        }
        if (wasHidden) { try { r.hidden = true; } catch (_) {} }
        if (wasLocked) { try { r.locked = true; } catch (_) {} }
        try { tmp.remove(); } catch (_) {}
        app.redraw();

        return { ok: (!err && outFile.exists), err: err, res: res, upsampled: upsampled,
                 px: px, wasHidden: wasHidden };
    }

    // Legacy path: temp document + PSD at 300 ppi (kept for workflows that need PSD).
    function exportPsd300(r, outFile) {
        var err = "";
        try {
            var b = r.geometricBounds;
            var preset = new DocumentPreset();
            preset.width = b[2] - b[0];
            preset.height = b[1] - b[3];
            preset.colorMode = doc.documentColorSpace;
            var tempDoc = app.documents.addDocument(doc.documentColorSpace, preset);
            var dup = r.duplicate(tempDoc.layers[0]);
            var ab = tempDoc.artboards[0].artboardRect;
            dup.position = [ab[0], ab[1]];
            var o = new ExportOptionsPhotoshop();
            o.resolution = 300;
            tempDoc.exportFile(outFile, ExportType.PHOTOSHOP, o);
            tempDoc.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = doc;
        } catch (e) {
            err = e.message ? e.message : String(e);
            try {
                while (app.documents.length > 1) {
                    var cur = app.activeDocument, p = "";
                    try { p = cur.fullName.fsName; } catch (_) {}
                    if (p !== doc.fullName.fsName) cur.close(SaveOptions.DONOTSAVECHANGES);
                    else break;
                }
            } catch (_) {}
        }
        return { ok: (!err && outFile.exists), err: err, res: 300, upsampled: false,
                 px: nativePx(r), wasHidden: r.hidden };
    }

    // ---------- export + relink ----------
    var successCount = 0, upsampledCount = 0, errors = [];

    if (doEmbed && embedded.length > 0) {
        if (!outputFolder.exists) outputFolder.create();

        var origInteraction = app.userInteractionLevel;
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

        var baseName = doc.fullName.name.replace(/\.[^\.]+$/, "");

        for (var i = 0; i < embedded.length; i++) {
            var ri = embedded[i];
            try {
                if (!ri.embedded) continue;
                var g = ri.geometricBounds;
                var ptW = g[2] - g[0], ptH = g[1] - g[3];
                var px = nativePx(ri);
                var ext = usePng ? "png" : "psd";
                var outFile = uniqueFile(outputFolder, baseName + "_" + px[0] + "x" + px[1], ext);   // trap 4

                var cap = usePng ? captureNative(ri, outFile) : exportPsd300(ri, outFile);
                if (!cap.ok) {
                    errors.push("Image " + (i + 1) + " (" + px[0] + "x" + px[1] + "): " + cap.err);
                    continue;
                }

                // place it back into the SAME parent / z position
                var placed = doc.layers[0].placedItems.add();
                placed.file = outFile;
                placed.move(ri, ElementPlacement.PLACEBEFORE);

                var nb = placed.geometricBounds;
                placed.resize(ptW / (nb[2] - nb[0]) * 100, ptH / (nb[1] - nb[3]) * 100);
                nb = placed.geometricBounds;
                placed.translate(g[0] - nb[0], g[1] - nb[1]);
                placed.name = ri.name;
                if (cap.wasHidden) placed.hidden = true;

                var fin = placed.geometricBounds;
                var exact = Math.abs(fin[0] - g[0]) < 0.01 && Math.abs(fin[1] - g[1]) < 0.01 &&
                            Math.abs((fin[2] - fin[0]) - ptW) < 0.01 && Math.abs((fin[1] - fin[3]) - ptH) < 0.01;
                if (!exact) {                                   // roll back, keep the embedded original
                    placed.remove();
                    errors.push("Image " + (i + 1) + ": placement mismatch, kept embedded");
                    continue;
                }

                ri.remove();
                successCount++;
                if (cap.upsampled) upsampledCount++;
            } catch (e) {
                errors.push("Image " + (i + 1) + ": " + (e.message ? e.message : String(e)));
            }
        }

        app.userInteractionLevel = origInteraction;
        app.redraw();
    }

    // ---------- report ----------
    var result = "Done:\n";
    if (successCount > 0) {
        result += "  " + successCount + "/" + embedded.length + " image(s) exported and relinked\n";
        result += "  Format: " + (usePng ? "PNG at native resolution" : "PSD at 300 ppi") + "\n";
        if (upsampledCount > 0) result += "  " + upsampledCount + " image(s) captured at the 72 ppi minimum (used below 72 ppi)\n";
        result += "  Output folder: " + outputFolder.fsName + "\n";
    }
    if (brokenRemoved > 0) result += "  " + brokenRemoved + " broken link(s) removed\n";
    result += "  Embedded images left in document: " + doc.rasterItems.length + "\n";
    if (errors.length > 0) result += "\nErrors:\n" + errors.join("\n");
    alert(result);
})();
