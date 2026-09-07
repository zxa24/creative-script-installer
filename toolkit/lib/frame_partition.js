"use strict";

var Contract = require("./frame_repair_contract");

function getFirstItem(collection) {
    if (!collection || !collection.length) {
        return null;
    }
    if (typeof collection.item === "function") {
        return collection.item(0);
    }
    return collection[0] || null;
}

function getLastItem(collection) {
    var index;
    if (!collection || !collection.length) {
        return null;
    }
    index = collection.length - 1;
    if (typeof collection.item === "function") {
        return collection.item(index);
    }
    return collection[index] || null;
}

function getParagraphStartFromCharacter(characterObj) {
    var paragraphObj;
    try {
        if (!characterObj || !characterObj.paragraphs || !characterObj.paragraphs.length) {
            return -1;
        }
        paragraphObj = getFirstItem(characterObj.paragraphs);
        if (!paragraphObj) {
            return -1;
        }
        return Number(paragraphObj.index);
    } catch (e0) {
        return -1;
    }
}

function getParagraphOrdinals(frame, firstParaStart, lastParaStart) {
    var story, storyParas, i, sp, spStart;
    var firstOrd = -1, lastOrd = -1;
    if (firstParaStart < 0 && lastParaStart < 0) { return { first: -1, last: -1 }; }
    try {
        story = frame.parentStory;
        if (!story || !story.paragraphs || !story.paragraphs.length) {
            return { first: -1, last: -1 };
        }
        storyParas = story.paragraphs;
        for (i = 0; i < storyParas.length; i++) {
            sp = typeof storyParas.item === "function" ? storyParas.item(i) : storyParas[i];
            if (!sp) { continue; }
            spStart = Number(sp.index);
            if (firstOrd < 0 && spStart === firstParaStart) {
                firstOrd = i;
            }
            if (spStart === lastParaStart) {
                lastOrd = i;
            }
            if (spStart > lastParaStart) { break; }
        }
    } catch (e0) {}
    return { first: firstOrd, last: lastOrd };
}

function getFramePartition(frame) {
    var characters;
    var count;
    var firstChar;
    var lastChar;
    var firstParaStart, lastParaStart, ordinals;

    characters = frame && frame.characters;
    count = characters && characters.length ? Number(characters.length) : 0;
    if (!count) {
        return Contract.createPartitionSnapshot({
            empty: true,
            firstCharIdx: -1,
            lastCharIdx: -1,
            firstParaStart: -1,
            lastParaStart: -1,
            firstParaOrdinal: -1,
            lastParaOrdinal: -1
        });
    }

    firstChar = getFirstItem(characters);
    lastChar = getLastItem(characters);
    firstParaStart = getParagraphStartFromCharacter(firstChar);
    lastParaStart = getParagraphStartFromCharacter(lastChar);
    ordinals = getParagraphOrdinals(frame, firstParaStart, lastParaStart);
    return Contract.createPartitionSnapshot({
        empty: false,
        firstCharIdx: firstChar ? Number(firstChar.index) : -1,
        lastCharIdx: lastChar ? Number(lastChar.index) : -1,
        firstParaStart: firstParaStart,
        lastParaStart: lastParaStart,
        firstParaOrdinal: ordinals.first,
        lastParaOrdinal: ordinals.last
    });
}

function adjacentConstraintHolds(partitionA, partitionB) {
    if (!partitionA || !partitionB || partitionA.empty || partitionB.empty) {
        return true;
    }
    if (partitionA.lastCharIdx < 0 || partitionB.firstCharIdx < 0) {
        return true;
    }
    return partitionA.lastCharIdx + 1 === partitionB.firstCharIdx;
}

function sampleStoryPartitions(story, captureFrameSnapshot, getFrameById) {
    var frames = [];
    var i;
    var frame;
    var snapshot;

    if (!story || !story.textContainers || !story.textContainers.length) {
        return frames;
    }

    for (i = 0; i < story.textContainers.length; i++) {
        frame = typeof story.textContainers.item === "function" ? story.textContainers.item(i) : story.textContainers[i];
        if (!frame) {
            continue;
        }
        if (typeof captureFrameSnapshot === "function") {
            snapshot = captureFrameSnapshot(frame, i);
        } else {
            snapshot = Contract.createFrameSnapshot({
                id: frame.id,
                index: i,
                partition: getFramePartition(frame)
            });
        }
        frames.push(snapshot);
    }

    return frames;
}

function repairStoryFrames(story, targetPartitions, repairAdapter) {
    var ContractLocal = require("./frame_repair_contract");
    var result;
    var adapter;
    var i;
    var targetFrame;
    var liveFrame;
    var threaded;
    var confirmedBoundsById = {};

    adapter = ContractLocal.validateRepairAdapter(repairAdapter);
    result = ContractLocal.createRepairSection();
    threaded = adapter.isThreaded(targetPartitions);

    for (i = 0; i < targetPartitions.frames.length; i++) {
        targetFrame = targetPartitions.frames[i];
        liveFrame = adapter.getLiveFrame(story, targetFrame);
        if (!liveFrame) {
            adapter.pushUnique(result.skipped, "frame[" + i + "] not found");
            adapter.log("repair skip frame[" + i + "] not found");
            continue;
        }
        if (adapter.frameMatches(story, targetPartitions, i)) {
            adapter.rememberConfirmed(confirmedBoundsById, targetFrame.id, liveFrame);
            adapter.pushUnique(result.skipped, "frame[" + i + "] already matches target boundary");
            continue;
        }

        result.attempted += 1;
        if (adapter.repairFrame(story, liveFrame, targetFrame, targetPartitions, i, threaded, confirmedBoundsById).ok) {
            adapter.rememberConfirmed(confirmedBoundsById, targetFrame.id, liveFrame);
            adapter.pushUnique(result.fixed, "frame[" + i + "] restored");
            continue;
        }

        adapter.pushUnique(result.failed, "frame[" + i + "] unable to restore original boundary");
        if (threaded) {
            adapter.abortThreaded(story, targetPartitions, result, "repair blocked at frame[" + i + "]");
            return result;
        }
        adapter.recompose(story);
    }

    return result;
}

module.exports = {
    getFramePartition: getFramePartition,
    adjacentConstraintHolds: adjacentConstraintHolds,
    sampleStoryPartitions: sampleStoryPartitions,
    repairStoryFrames: repairStoryFrames
};
