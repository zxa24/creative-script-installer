"use strict";

// lib/utils.js — Shared pure utility functions (no InDesign host dependencies)

function getTimestamp() {
    var d = new Date();
    var h = String(d.getHours());
    var m = String(d.getMinutes());
    var s = String(d.getSeconds());
    var ms = String(d.getMilliseconds());
    while (h.length < 2) { h = "0" + h; }
    while (m.length < 2) { m = "0" + m; }
    while (s.length < 2) { s = "0" + s; }
    while (ms.length < 3) { ms = "0" + ms; }
    return "[" + h + ":" + m + ":" + s + "." + ms + "]";
}

function safe(value) {
    if (value === null || typeof value === "undefined") { return ""; }
    return String(value);
}

function safeNumberString(value) {
    var num = Number(value);
    if (isFinite(num)) { return String(Math.round(num * 1000) / 1000); }
    return safe(value);
}

function pushUnique(arr, value) {
    var i;
    for (i = 0; i < arr.length; i++) {
        if (arr[i] === value) { return; }
    }
    arr.push(value);
}

function getCollectionItem(collection, index) {
    if (!collection) { return null; }
    try {
        if (typeof collection.item === "function") { return collection.item(index); }
    } catch (e0) {}
    try { return collection[index]; } catch (e1) {}
    return null;
}

function trySet(target, key, value) {
    try { target[key] = value; return true; } catch (e0) {}
    return false;
}

module.exports = {
    getTimestamp: getTimestamp,
    safe: safe,
    safeNumberString: safeNumberString,
    pushUnique: pushUnique,
    getCollectionItem: getCollectionItem,
    trySet: trySet
};
