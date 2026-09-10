"use strict";

// lib/story_utils.js — Frame/Story detection and collection utilities

var utils = require("./utils.js");
var safe = utils.safe;
var getCollectionItem = utils.getCollectionItem;

function isTextFrameObject(obj) {
    var name = "";
    try { name = safe(obj.constructor && obj.constructor.name); } catch (e0) {}
    return name === "TextFrame";
}

function isFrameLocked(frame) {
    try { if (frame.locked) { return true; } } catch (e0) {}
    try { if (frame.itemLayer && frame.itemLayer.locked) { return true; } } catch (e1) {}
    return false;
}

function isFrameVisible(frame) {
    try { if (frame.visible === false) { return false; } } catch (e0) {}
    try { if (frame.itemLayer && frame.itemLayer.visible === false) { return false; } } catch (e1) {}
    return true;
}

function isUsableStoryObject(story) {
    if (!story) { return false; }
    try { if (story.isValid === false) { return false; } } catch (e0) { return false; }
    try { if (!story.textContainers) { return false; } } catch (e1) { return false; }
    return true;
}

function getUnrepairableFrameReason(frame) {
    if (!isTextFrameObject(frame)) { return "non-text container"; }
    if (isFrameLocked(frame)) { return "locked frame"; }
    if (!isFrameVisible(frame)) { return "hidden frame or hidden layer"; }
    return "";
}

/**
 * Collect repairable story IDs from a document.
 * @param {Document} doc - InDesign document
 * @param {function} [log] - Optional logging function; if omitted, skip messages are silent
 * @returns {string[]} Array of story ID strings
 */
function collectRepairableStories(doc, log) {
    var result = [];
    var seen = {};
    var story, storyId, frame, reason, i, j;
    if (!log) { log = function () {}; }
    if (!doc || !doc.stories || !doc.stories.length) { return result; }
    for (i = 0; i < doc.stories.length; i++) {
        story = getCollectionItem(doc.stories, i);
        if (!isUsableStoryObject(story)) { continue; }
        if (!story.textContainers || !story.textContainers.length) { continue; }
        storyId = safe(story.id);
        if (seen[storyId]) { continue; }
        reason = "";
        for (j = 0; j < story.textContainers.length; j++) {
            frame = getCollectionItem(story.textContainers, j);
            reason = getUnrepairableFrameReason(frame);
            if (reason) { break; }
        }
        if (reason) {
            log("skip storyId=" + storyId + " reason=" + reason);
            continue;
        }
        seen[storyId] = true;
        result.push(storyId);
    }
    return result;
}

/**
 * Find a live story object by its ID.
 * @param {Document} doc - InDesign document
 * @param {string} storyId - Story ID to find
 * @returns {Story|null}
 */
function resolveLiveStoryById(doc, storyId) {
    var i, story;
    if (!doc || !doc.stories || !doc.stories.length) { return null; }
    for (i = 0; i < doc.stories.length; i++) {
        story = getCollectionItem(doc.stories, i);
        if (!isUsableStoryObject(story)) { continue; }
        try { if (safe(story.id) === safe(storyId)) { return story; } } catch (e0) {}
    }
    return null;
}

module.exports = {
    isTextFrameObject: isTextFrameObject,
    isFrameLocked: isFrameLocked,
    isFrameVisible: isFrameVisible,
    isUsableStoryObject: isUsableStoryObject,
    getUnrepairableFrameReason: getUnrepairableFrameReason,
    collectRepairableStories: collectRepairableStories,
    resolveLiveStoryById: resolveLiveStoryById
};
