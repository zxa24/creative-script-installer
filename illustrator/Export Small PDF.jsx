// ExportSmallPDF.jsx
// 将当前 Illustrator 文档导出为 PDF / 保存 / 打包

(function () {
    if (app.documents.length === 0) {
        alert("No document open.");
        return;
    }

    var doc = app.activeDocument;

    if (!doc.fullName) {
        alert("Save the document before running this.");
        return;
    }

    var docFile = doc.fullName;
    var docFolder = docFile.parent;
    var baseName = docFile.name.replace(/\.[^\.]+$/, "");

    // 弹窗选择操作
    var dlg = new Window("dialog", "Quick Actions");
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];

    var chkSmallPDF = dlg.add("checkbox", undefined, "Export smallest PDF");
    var chkLargePDF = dlg.add("checkbox", undefined, "Export largest PDF");
    var chkSave = dlg.add("checkbox", undefined, "Save document");
    var chkPackage = dlg.add("checkbox", undefined, "Package");

    chkSmallPDF.value = true; // 默认勾选

    var btnGroup = dlg.add("group");
    btnGroup.alignment = ["center", "top"];
    btnGroup.add("button", undefined, "OK", { name: "ok" });
    btnGroup.add("button", undefined, "Cancel", { name: "cancel" });

    if (dlg.show() !== 1) return;

    var doSmallPDF = chkSmallPDF.value;
    var doLargePDF = chkLargePDF.value;
    var doSave = chkSave.value;
    var doPackage = chkPackage.value;

    if (!doSmallPDF && !doLargePDF && !doSave && !doPackage) return;

    var origPath = docFile.fullName;
    var exported = false;

    // 保存文档
    if (doSave) {
        doc.save();
    }

    // 导出最小 PDF
    if (doSmallPDF) {
        var smallFile = new File(docFolder + "/" + baseName + "_smallest.pdf");
        var counter = 1;
        while (smallFile.exists) {
            smallFile = new File(docFolder + "/" + baseName + "_smallest_" + counter + ".pdf");
            counter++;
        }
        var smallOpts = new PDFSaveOptions();
        smallOpts.pDFPreset = "[Smallest File Size]";
        doc.saveAs(smallFile, smallOpts);
        doc.close(SaveOptions.DONOTSAVECHANGES);
        doc = app.open(new File(origPath));
        if (smallFile.exists) exported = true;
    }

    // 导出最大 PDF
    if (doLargePDF) {
        var largeFile = new File(docFolder + "/" + baseName + "_highquality.pdf");
        var counter2 = 1;
        while (largeFile.exists) {
            largeFile = new File(docFolder + "/" + baseName + "_highquality_" + counter2 + ".pdf");
            counter2++;
        }
        var largeOpts = new PDFSaveOptions();
        largeOpts.pDFPreset = "[High Quality Print]";
        doc.saveAs(largeFile, largeOpts);
        doc.close(SaveOptions.DONOTSAVECHANGES);
        doc = app.open(new File(origPath));
        if (largeFile.exists) exported = true;
    }

    // 如果有导出文件则打开目录
    if (exported) {
        var folder = new Folder(docFolder);
        folder.execute();
    }

    // 打包放最后执行，避免与 saveAs 冲突
    if (doPackage) {
        app.executeMenuCommand("Package Menu Item");
    }
})();
