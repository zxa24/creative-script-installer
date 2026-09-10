"use strict";

// lib/translation_common.js — UXP module version of translation_common.jsxinc
// Shared utilities for export_translation_package.idjs and import_translations.idjs.
// Usage: var common = require("./lib/translation_common.js");

var fs = require("fs");
var utils = require("./utils.js");
var getCollectionItem = utils.getCollectionItem;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}

function pad3(n) {
    if (n < 10) { return "00" + n; }
    if (n < 100) { return "0" + n; }
    return String(n);
}

function utcIsoNow() {
    var d = new Date();
    return d.getUTCFullYear() + "-" +
        pad2(d.getUTCMonth() + 1) + "-" +
        pad2(d.getUTCDate()) + "T" +
        pad2(d.getUTCHours()) + ":" +
        pad2(d.getUTCMinutes()) + ":" +
        pad2(d.getUTCSeconds()) + "." +
        pad3(d.getUTCMilliseconds()) + "Z";
}

function compactTimestampNow() {
    var d = new Date();
    return String(d.getFullYear()) +
        pad2(d.getMonth() + 1) +
        pad2(d.getDate()) + "_" +
        pad2(d.getHours()) +
        pad2(d.getMinutes()) +
        pad2(d.getSeconds());
}

// ---------------------------------------------------------------------------
// File I/O (UXP: fs.readFileSync/writeFileSync, throwing on failure)
// ---------------------------------------------------------------------------

function readUtf8File(filePath) {
    var text = fs.readFileSync(filePath, "utf-8");
    // Strip UTF-8 BOM if present (M-IMP-1)
    if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) {
        text = text.substring(1);
    }
    return text;
}

function writeUtf8File(filePath, text) {
    fs.writeFileSync(filePath, text, "utf-8");
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

function normalizeSoftBreaks(text) {
    var s = String(text === undefined || text === null ? "" : text);
    s = s.replace(/\u0003/g, "\n");
    s = s.replace(/[ \t]*\n+[ \t]*/g, " ");
    return s;
}

function hashDjb2Hex(text) {
    var s = String(text === undefined || text === null ? "" : text);
    var h = 5381;
    var i, code, hex;
    for (i = 0; i < s.length; i++) {
        code = s.charCodeAt(i);
        h = ((h << 5) + h + code) & 0x7fffffff;
    }
    hex = h.toString(16);
    while (hex.length < 8) { hex = "0" + hex; }
    return hex;
}

function normalizeText(text) {
    var s = normalizeSoftBreaks(text);
    s = s.replace(/[\uFEFF\u200B\u200C\u200D\u0007]/g, "");
    return s.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

function sourceHashForText(text) {
    return hashDjb2Hex(normalizeText(text));
}

// ---------------------------------------------------------------------------
// Character / text detection
// ---------------------------------------------------------------------------

function isSpecialControlCharCode(code) {
    return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31);
}

function isAnchoredObjectOnlyText(s) {
    if (s === undefined || s === null) { return false; }
    var t = String(s).replace(/[\r\n\s]/g, "");
    return t.length > 0 && t.replace(/\uFFFC/g, "").length === 0;
}

function paragraphTextNoReturn(para) {
    var text = "";
    if (!para || !para.isValid) { return text; }
    try { text = para.contents; } catch (e0) { text = ""; }
    if (text.length > 0 && text.charAt(text.length - 1) === "\r") {
        text = text.substring(0, text.length - 1);
    }
    return normalizeSoftBreaks(text);
}

// ---------------------------------------------------------------------------
// DOM type helpers (Gate 15: constructor.name identical in UXP and ExtendScript)
// ---------------------------------------------------------------------------

function objectTypeName(obj) {
    var name = "";
    if (!obj) { return ""; }
    try {
        if (obj.constructor && obj.constructor.name) {
            name = String(obj.constructor.name);
        }
    } catch (e0) {}
    if (!name) {
        try {
            if (obj.reflect && obj.reflect.name) {
                name = String(obj.reflect.name);
            }
        } catch (e1) {}
    }
    return name;
}

function isTypeName(obj, expected) {
    return objectTypeName(obj).toLowerCase() === String(expected === undefined || expected === null ? "" : expected).toLowerCase();
}

function findAncestorByType(startObj, expectedTypeName, maxDepth) {
    var cur = startObj;
    var depth = 0;
    var limit = Number(maxDepth);
    if (!isFinite(limit) || limit <= 0) { limit = 12; }
    while (cur && depth < limit) {
        try { if (cur.isValid === false) { break; } } catch (e0) {}
        if (isTypeName(cur, expectedTypeName)) { return cur; }
        try {
            if (!cur.parent || cur.parent === cur) { break; }
            cur = cur.parent;
        } catch (e1) { break; }
        depth += 1;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Page index helper
// ---------------------------------------------------------------------------

function getPageIndexFromContainer(container, masterPageMap) {
    var page = null;
    var idx = -1;
    var pgId;
    try {
        page = container.parentPage;
        if (page && page.isValid) {
            if (masterPageMap) {
                pgId = String(page.id);
                if (masterPageMap.byId.hasOwnProperty(pgId)) {
                    return masterPageMap.byId[pgId];
                }
            }
            idx = page.documentOffset;
        }
    } catch (e0) { idx = -1; }
    return idx;
}

// ---------------------------------------------------------------------------
// Table cell meta helpers
// Uses getCollectionItem for UXP collection access (Gate 3: .item(i) required)
// ---------------------------------------------------------------------------

function detectTableCellMetaForParagraph(para) {
    var probes = [];
    var i, probe, cell, table;
    var rowIdx = -1, colIdx = -1, rowSpan = 1, colSpan = 1, tableId = -1, tableIndex = -1;
    var cellParas = null, paraIndexInCell = -1, paraCountInCell = 0;
    var cellUid = "", tableUid = "";
    if (!para || !para.isValid) { return null; }

    probes.push(para);
    try {
        if (para.insertionPoints && para.insertionPoints.length > 0) {
            probes.push(getCollectionItem(para.insertionPoints, 0));
        }
    } catch (e0) {}
    try {
        if (para.characters && para.characters.length > 0) {
            probes.push(getCollectionItem(para.characters, 0));
        }
    } catch (e1) {}
    try {
        if (para.texts && para.texts.length > 0) {
            probes.push(getCollectionItem(para.texts, 0));
        }
    } catch (e2) {}

    cell = null;
    for (i = 0; i < probes.length; i++) {
        probe = probes[i];
        cell = findAncestorByType(probe, "Cell", 14);
        if (cell) { break; }
    }
    if (!cell || !cell.isValid) { return null; }

    table = findAncestorByType(cell, "Table", 10);
    if (!table || !table.isValid) { return null; }

    try { rowIdx = Number(cell.parentRow.index); } catch (e3) { rowIdx = -1; }
    try { colIdx = Number(cell.parentColumn.index); } catch (e4) { colIdx = -1; }
    try { rowSpan = Number(cell.rowSpan); } catch (e5) { rowSpan = 1; }
    try { colSpan = Number(cell.columnSpan); } catch (e6) { colSpan = 1; }
    try { tableId = Number(table.id); } catch (e7) { tableId = -1; }
    try { tableIndex = Number(table.index); } catch (e8) { tableIndex = -1; }

    if (!isFinite(rowIdx) || rowIdx < 0) { rowIdx = -1; }
    if (!isFinite(colIdx) || colIdx < 0) { colIdx = -1; }
    if (!isFinite(rowSpan) || rowSpan <= 0) { rowSpan = 1; }
    if (!isFinite(colSpan) || colSpan <= 0) { colSpan = 1; }
    if (!isFinite(tableId) || tableId < 0) { tableId = -1; }
    if (!isFinite(tableIndex) || tableIndex < 0) { tableIndex = -1; }

    try { cellParas = cell.paragraphs; } catch (e9) { cellParas = null; }
    if (cellParas && cellParas.length > 0) {
        paraCountInCell = Number(cellParas.length);
        for (i = 0; i < cellParas.length; i++) {
            try {
                var cp = getCollectionItem(cellParas, i);
                if (cp === para) { paraIndexInCell = i; break; }
            } catch (e10) {}
            try {
                var cp2 = getCollectionItem(cellParas, i);
                if (cp2 && cp2.isValid && para.id === cp2.id) { paraIndexInCell = i; break; }
            } catch (e11) {}
        }
    }
    if (!isFinite(paraCountInCell) || paraCountInCell < 0) { paraCountInCell = 0; }

    if (tableId >= 0) { tableUid = "table_" + String(tableId); }
    else if (tableIndex >= 0) { tableUid = "table_idx_" + String(tableIndex); }
    else { tableUid = "table_unknown"; }

    if (rowIdx >= 0 && colIdx >= 0) { cellUid = tableUid + "_r" + String(rowIdx) + "_c" + String(colIdx); }
    else { cellUid = tableUid + "_cell_unknown"; }

    return {
        table_id: tableId, table_index: tableIndex, table_uid: tableUid,
        cell_uid: cellUid, cell_row: rowIdx, cell_col: colIdx,
        row_span: rowSpan, col_span: colSpan,
        cell_para_index: paraIndexInCell, cell_para_count: paraCountInCell,
        table_ref: table
    };
}

function buildTableCellMetaFromObjects(tableObj, cellObj, paraIndexInCell, paraCountInCell) {
    var rowIdx = -1, colIdx = -1, rowSpan = 1, colSpan = 1, tableId = -1, tableIndex = -1;
    var tableUid = "", cellUid = "";
    var cellName = "";
    var m = null;
    var columnCount = -1;
    var cellIndex = -1;
    var paraIdx = Number(paraIndexInCell);
    var paraCount = Number(paraCountInCell);
    if (!tableObj || !tableObj.isValid || !cellObj || !cellObj.isValid) { return null; }

    try { rowIdx = Number(cellObj.parentRow.index); } catch (e0) { rowIdx = -1; }
    try { colIdx = Number(cellObj.parentColumn.index); } catch (e1) { colIdx = -1; }
    try { rowSpan = Number(cellObj.rowSpan); } catch (e2) { rowSpan = 1; }
    try { colSpan = Number(cellObj.columnSpan); } catch (e3) { colSpan = 1; }
    try { tableId = Number(tableObj.id); } catch (e4) { tableId = -1; }
    try { tableIndex = Number(tableObj.index); } catch (e5) { tableIndex = -1; }
    try {
        cellName = (cellObj.name === undefined || cellObj.name === null) ? "" : String(cellObj.name);
    } catch (e6) { cellName = ""; }
    m = /^(\d+):(\d+)$/.exec(cellName);
    if (m) {
        if (rowIdx < 0) { rowIdx = Number(m[2]); }
        if (colIdx < 0) { colIdx = Number(m[1]); }
    }
    if (rowIdx < 0 || colIdx < 0) {
        try { columnCount = Number(tableObj.columns.length); } catch (e7) { columnCount = -1; }
        try { cellIndex = Number(cellObj.index); } catch (e8) { cellIndex = -1; }
        if (isFinite(columnCount) && columnCount > 0 && isFinite(cellIndex) && cellIndex >= 0) {
            if (rowIdx < 0) { rowIdx = Math.floor(cellIndex / columnCount); }
            if (colIdx < 0) { colIdx = cellIndex % columnCount; }
        }
    }

    if (!isFinite(rowIdx) || rowIdx < 0) { rowIdx = -1; }
    if (!isFinite(colIdx) || colIdx < 0) { colIdx = -1; }
    if (!isFinite(rowSpan) || rowSpan <= 0) { rowSpan = 1; }
    if (!isFinite(colSpan) || colSpan <= 0) { colSpan = 1; }
    if (!isFinite(tableId) || tableId < 0) { tableId = -1; }
    if (!isFinite(tableIndex) || tableIndex < 0) { tableIndex = -1; }
    if (!isFinite(paraIdx) || paraIdx < 0) { paraIdx = -1; }
    if (!isFinite(paraCount) || paraCount < 0) { paraCount = 0; }

    if (tableId >= 0) { tableUid = "table_" + String(tableId); }
    else if (tableIndex >= 0) { tableUid = "table_idx_" + String(tableIndex); }
    else { tableUid = "table_unknown"; }
    if (rowIdx >= 0 && colIdx >= 0) { cellUid = tableUid + "_r" + String(rowIdx) + "_c" + String(colIdx); }
    else { cellUid = tableUid + "_cell_unknown"; }

    return {
        table_id: tableId, table_index: tableIndex, table_uid: tableUid,
        cell_uid: cellUid, cell_row: rowIdx, cell_col: colIdx,
        row_span: rowSpan, col_span: colSpan,
        cell_para_index: paraIdx, cell_para_count: paraCount,
        table_ref: tableObj
    };
}

// ---------------------------------------------------------------------------
// Fallback-tid encoding for table-cell paragraphs.
// Shared between export (produces fallback tids when no XML tid is found)
// and import-state label writer (must mirror the same encoding so next-round
// export's tid matches the stored key). Stable across content edits because
// it depends only on table structure (table_id/index + row/col/cell_para_index),
// not on paragraph character offsets within story.
// ---------------------------------------------------------------------------

function tableCellSyntheticIndex(cellMeta, fallbackIdx) {
    var idx = Number(fallbackIdx);
    var row = Number(cellMeta && cellMeta.cell_row);
    var col = Number(cellMeta && cellMeta.cell_col);
    var cp = Number(cellMeta && cellMeta.cell_para_index);
    var tableId = Number(cellMeta && cellMeta.table_id);
    var tableIndex = Number(cellMeta && cellMeta.table_index);
    var tablePart = 0;
    if (!isFinite(idx) || idx < 0) {
        idx = 0;
    }
    if (!isFinite(cp) || cp < 0) {
        cp = 0;
    }
    if (!(isFinite(row) && row >= 0 && isFinite(col) && col >= 0)) {
        return idx;
    }
    if (isFinite(tableId) && tableId >= 0) {
        tablePart = tableId;
    } else if (isFinite(tableIndex) && tableIndex >= 0) {
        tablePart = 500000 + tableIndex;
    }
    return 1000000000 + tablePart * 1000000 + row * 1000 + col * 10 + cp;
}

// ---------------------------------------------------------------------------
// XML helpers (Gate 6: xmlAttributes.itemByName/add work identically in UXP)
// ---------------------------------------------------------------------------

function getXmlAttr(element, attrName) {
    var attr, value;
    if (!element || !element.isValid) { return ""; }
    try {
        attr = element.xmlAttributes.itemByName(attrName);
        if (attr && attr.isValid) {
            value = attr.value;
            return value === undefined || value === null ? "" : String(value);
        }
    } catch (e0) {}
    return "";
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
    pad2: pad2,
    pad3: pad3,
    utcIsoNow: utcIsoNow,
    compactTimestampNow: compactTimestampNow,
    readUtf8File: readUtf8File,
    writeUtf8File: writeUtf8File,
    normalizeSoftBreaks: normalizeSoftBreaks,
    hashDjb2Hex: hashDjb2Hex,
    normalizeText: normalizeText,
    sourceHashForText: sourceHashForText,
    isSpecialControlCharCode: isSpecialControlCharCode,
    isAnchoredObjectOnlyText: isAnchoredObjectOnlyText,
    paragraphTextNoReturn: paragraphTextNoReturn,
    objectTypeName: objectTypeName,
    isTypeName: isTypeName,
    findAncestorByType: findAncestorByType,
    getPageIndexFromContainer: getPageIndexFromContainer,
    detectTableCellMetaForParagraph: detectTableCellMetaForParagraph,
    buildTableCellMetaFromObjects: buildTableCellMetaFromObjects,
    tableCellSyntheticIndex: tableCellSyntheticIndex,
    getXmlAttr: getXmlAttr
};
