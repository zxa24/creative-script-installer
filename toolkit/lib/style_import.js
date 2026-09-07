"use strict";

var indesign = require("indesign");
var app = indesign.app;
var ImportFormat = indesign.ImportFormat;
var GlobalClashResolutionStrategy = indesign.GlobalClashResolutionStrategy;

function safeString(value) {
    if (value === null || typeof value === "undefined") {
        return "";
    }
    return String(value);
}

function normalizeName(value) {
    return safeString(value).toLowerCase();
}

function sameName(a, b) {
    return normalizeName(a) === normalizeName(b);
}

function isDefaultParagraphStyleName(name) {
    return name === "$ID/[No paragraph style]" || name === "$ID/NormalParagraphStyle";
}

function listParagraphStyles(doc, excludeDefaults) {
    var styles = [];
    var seen = {};
    var allStyles;
    var i;
    var ps;
    var name;

    if (!doc || !doc.allParagraphStyles) {
        return styles;
    }

    allStyles = doc.allParagraphStyles;
    for (i = 0; i < allStyles.length; i++) {
        ps = typeof allStyles.item === "function" ? allStyles.item(i) : allStyles[i];
        if (!ps) {
            continue;
        }
        name = safeString(ps.name);
        if (!name) {
            continue;
        }
        if (excludeDefaults && isDefaultParagraphStyleName(name)) {
            continue;
        }
        if (!seen[name]) {
            seen[name] = true;
            styles.push(name);
        }
    }

    styles.sort();
    return styles;
}

function findParagraphStyleByName(doc, styleName) {
    var allStyles;
    var i;
    var ps;
    var name;

    if (!doc || !styleName || !doc.allParagraphStyles) {
        return null;
    }

    allStyles = doc.allParagraphStyles;
    for (i = 0; i < allStyles.length; i++) {
        ps = typeof allStyles.item === "function" ? allStyles.item(i) : allStyles[i];
        if (!ps) {
            continue;
        }
        name = safeString(ps.name);
        if (sameName(name, styleName)) {
            return ps;
        }
    }
    return null;
}

function openSourceDocument(sourcePath) {
    return app.open(sourcePath);
}

function closeDocNoSave(doc) {
    if (!doc) {
        return;
    }
    try {
        doc.close(indesign.SaveOptions.NO);
    } catch (e0) {
        try {
            doc.close();
        } catch (e1) {}
    }
}

function importTextStylesOfficial(targetDoc, sourcePath) {
    targetDoc.importStyles(
        ImportFormat.TEXT_STYLES_FORMAT,
        sourcePath,
        GlobalClashResolutionStrategy.LOAD_ALL_WITH_OVERWRITE
    );
}

module.exports = {
    safeString: safeString,
    sameName: sameName,
    isDefaultParagraphStyleName: isDefaultParagraphStyleName,
    listParagraphStyles: listParagraphStyles,
    findParagraphStyleByName: findParagraphStyleByName,
    openSourceDocument: openSourceDocument,
    closeDocNoSave: closeDocNoSave,
    importTextStylesOfficial: importTextStylesOfficial
};
