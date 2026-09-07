"use strict";

var LABEL_PREFIX = "translation_mvp_uxp.runner.";

function labelKey(name) {
    return LABEL_PREFIX + String(name || "");
}

function getLabel(app, name) {
    try {
        if (app && typeof app.extractLabel === "function") {
            return String(app.extractLabel(labelKey(name)) || "");
        }
    } catch (e0) {}
    return "";
}

function parseBoolean(value, fallback) {
    var text = String(value || "").toLowerCase();
    if (text === "1" || text === "true" || text === "yes" || text === "on") {
        return true;
    }
    if (text === "0" || text === "false" || text === "no" || text === "off") {
        return false;
    }
    return !!fallback;
}

function isRunnerActive(app) {
    return parseBoolean(getLabel(app, "active"), false);
}

function shouldSuppressDialogs(app) {
    return isRunnerActive(app) && parseBoolean(getLabel(app, "suppress_dialogs"), false);
}

function getOutputPath(app, fallback) {
    var outputPath = getLabel(app, "output_path");
    return outputPath || String(fallback || "");
}

function getMutationMode(app, fallback) {
    var mode = getLabel(app, "mutation_mode");
    if (mode === "append" || mode === "trim") {
        return mode;
    }
    return fallback;
}

function getCleanupOptions(app, fallback) {
    var result = fallback || {
        removeSoftReturns: true,
        removeSpaces: true,
        collapseEmptyLines: true
    };

    if (!isRunnerActive(app)) {
        return result;
    }

    return {
        removeSoftReturns: parseBoolean(getLabel(app, "cleanup_soft_returns"), result.removeSoftReturns),
        removeSpaces: parseBoolean(getLabel(app, "cleanup_spaces"), result.removeSpaces),
        collapseEmptyLines: parseBoolean(getLabel(app, "cleanup_collapse_empty_lines"), result.collapseEmptyLines)
    };
}

function parseIntegerLabel(value, fallback) {
    var num = Number(value);
    if (isFinite(num) && Math.floor(num) === num) {
        return num;
    }
    return fallback;
}

function getTargetStoryId(app, fallback) {
    return parseIntegerLabel(getLabel(app, "target_story_id"), fallback);
}

function getTargetParagraphOrdinal(app, fallback) {
    return parseIntegerLabel(getLabel(app, "target_paragraph_ordinal"), fallback);
}

module.exports = {
    labelKey: labelKey,
    getLabel: getLabel,
    isRunnerActive: isRunnerActive,
    shouldSuppressDialogs: shouldSuppressDialogs,
    getOutputPath: getOutputPath,
    getMutationMode: getMutationMode,
    getCleanupOptions: getCleanupOptions,
    getTargetStoryId: getTargetStoryId,
    getTargetParagraphOrdinal: getTargetParagraphOrdinal
};
