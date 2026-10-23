"use strict";

var POINTS_PER_INCH = 72;
var POINTS_PER_PICA = 12;
var PICA_LIKE_MAX_PAGE_BOUND = 200;

function toNumber(value, fallback) {
    var num = Number(value);
    return isNaN(num) ? fallback : num;
}

function copyBoundsArray(bounds) {
    return [
        Number(bounds[0]),
        Number(bounds[1]),
        Number(bounds[2]),
        Number(bounds[3])
    ];
}

function normalizePageLimit(rawLimit, currentBound) {
    var numericLimit = toNumber(rawLimit, NaN);
    var numericCurrent = toNumber(currentBound, NaN);

    if (isNaN(numericLimit)) {
        return numericCurrent;
    }
    if (!isNaN(numericCurrent) && numericLimit >= numericCurrent) {
        return numericLimit;
    }
    if (numericLimit > 0 && numericLimit <= PICA_LIKE_MAX_PAGE_BOUND) {
        return numericLimit * POINTS_PER_PICA;
    }
    return numericLimit;
}

function normalizeMeasurementUnitName(unitValue) {
    var raw = String(unitValue || "").toUpperCase();
    if (raw.indexOf("INCH") >= 0) {
        return "INCHES";
    }
    if (raw.indexOf("PICA") >= 0) {
        return "PICAS";
    }
    return raw;
}

function resolveDocumentFromObject(obj) {
    var current = obj;
    while (current) {
        if (current.constructor && current.constructor.name === "Document") {
            return current;
        }
        if (current.parent === current) {
            break;
        }
        current = current.parent;
    }
    return null;
}

function getStoryTextContainerById(story, frameId) {
    var i;
    var frame;
    if (!story || !story.textContainers || typeof frameId === "undefined" || frameId === null) {
        return null;
    }
    for (i = 0; i < story.textContainers.length; i++) {
        frame = typeof story.textContainers.item === "function" ? story.textContainers.item(i) : story.textContainers[i];
        if (frame && String(frame.id) === String(frameId)) {
            return frame;
        }
    }
    return null;
}

function setFrameRight(frame, rightValue) {
    var bounds = copyBoundsArray(frame.geometricBounds);
    bounds[3] = Number(rightValue);
    frame.geometricBounds = bounds;
    return true;
}

function setFrameBottom(frame, bottomValue) {
    var bounds = copyBoundsArray(frame.geometricBounds);
    bounds[2] = Number(bottomValue);
    frame.geometricBounds = bounds;
    return true;
}

function restoreFrameBounds(frame, bounds) {
    frame.geometricBounds = copyBoundsArray(bounds);
}

function getPageRightLimit(frame) {
    var page = frame && frame.parentPage;
    var doc;
    var bounds;
    var rawLimit;
    if (page && page.bounds) {
        bounds = page.bounds;
        rawLimit = bounds[3];
    } else {
        doc = resolveDocumentFromObject(frame);
        if (doc && doc.documentPreferences) {
            rawLimit = doc.documentPreferences.pageWidth;
        }
    }
    if (typeof rawLimit === "undefined" || rawLimit === null) {
        return Number(frame.geometricBounds[3]);
    }
    return normalizePageLimit(rawLimit, Number(frame.geometricBounds[3]));
}

function getPageBottomLimit(frame) {
    var page = frame && frame.parentPage;
    var doc;
    var bounds;
    var rawLimit;
    if (page && page.bounds) {
        bounds = page.bounds;
        rawLimit = bounds[2];
    } else {
        doc = resolveDocumentFromObject(frame);
        if (doc && doc.documentPreferences) {
            rawLimit = doc.documentPreferences.pageHeight;
        }
    }
    if (typeof rawLimit === "undefined" || rawLimit === null) {
        return Number(frame.geometricBounds[2]);
    }
    return normalizePageLimit(rawLimit, Number(frame.geometricBounds[2]));
}

function inferMeasurementMode(doc, axis) {
    var unitName;
    var pages;
    var bounds;
    var dimension;
    if (doc && doc.viewPreferences) {
        unitName = normalizeMeasurementUnitName(axis === "horizontal" ? doc.viewPreferences.horizontalMeasurementUnits : doc.viewPreferences.verticalMeasurementUnits);
        if (unitName === "INCHES" || unitName === "PICAS") {
            return unitName;
        }
    }
    pages = doc && doc.pages;
    if (pages && pages.length) {
        bounds = typeof pages.item === "function" ? pages.item(0).bounds : pages[0].bounds;
        if (bounds) {
            dimension = axis === "horizontal" ? bounds[3] : bounds[2];
            if (toNumber(dimension, 0) > 0 && toNumber(dimension, 0) <= PICA_LIKE_MAX_PAGE_BOUND) {
                return "PICAS";
            }
        }
    }
    return "POINTS";
}

function convertPointsToHorizontalUnits(doc, points) {
    var mode = inferMeasurementMode(doc, "horizontal");
    if (mode === "INCHES") {
        return Number(points) / POINTS_PER_INCH;
    }
    if (mode === "PICAS") {
        return Number(points) / POINTS_PER_PICA;
    }
    return Number(points);
}

function convertPointsToVerticalUnits(doc, points) {
    var mode = inferMeasurementMode(doc, "vertical");
    if (mode === "INCHES") {
        return Number(points) / POINTS_PER_INCH;
    }
    if (mode === "PICAS") {
        return Number(points) / POINTS_PER_PICA;
    }
    return Number(points);
}

module.exports = {
    copyBoundsArray: copyBoundsArray,
    normalizePageLimit: normalizePageLimit,
    resolveDocumentFromObject: resolveDocumentFromObject,
    getStoryTextContainerById: getStoryTextContainerById,
    setFrameRight: setFrameRight,
    setFrameBottom: setFrameBottom,
    restoreFrameBounds: restoreFrameBounds,
    getPageRightLimit: getPageRightLimit,
    getPageBottomLimit: getPageBottomLimit,
    convertPointsToHorizontalUnits: convertPointsToHorizontalUnits,
    convertPointsToVerticalUnits: convertPointsToVerticalUnits
};
