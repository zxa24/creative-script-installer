#target illustrator

(function () {
    if (app.documents.length === 0) {
        alert("Open a document before running this script.");
        return;
    }

    var doc = app.activeDocument;

    // =========================
    // Minimal JSON fallback
    // =========================
    function _stringEscape(s) {
        return String(s)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t");
    }
    function simpleStringify(obj) {
        if (obj === null) return "null";
        var t = typeof obj;
        if (t === "number" || t === "boolean") return String(obj);
        if (t === "string") return '"' + _stringEscape(obj) + '"';
        if (obj instanceof Array) {
            var a = [];
            for (var i = 0; i < obj.length; i++) a.push(simpleStringify(obj[i]));
            return "[" + a.join(",") + "]";
        }
        if (t === "object") {
            var parts = [];
            for (var k in obj) {
                if (obj.hasOwnProperty(k)) {
                    parts.push('"' + _stringEscape(k) + '":' + simpleStringify(obj[k]));
                }
            }
            return "{" + parts.join(",") + "}";
        }
        return "null";
    }

    function safeStringify(obj) {
        if (typeof JSON !== "undefined" && JSON.stringify) return JSON.stringify(obj, null, 2);
        return simpleStringify(obj);
    }
    function safeParse(text) {
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
        return eval("(" + text + ")"); // local file only
    }

    // =========================
    // Halfwidth (ASCII) detector
    // =========================
    // 仅替换半角符号：这里按 ASCII 可打印字符（含空格）处理：0x20 - 0x7E
    // 覆盖英文、数字、常见标点符号、常见半角符号等
    function isHalfwidthASCIIChar(ch) {
        try {
            if (ch === null || ch === undefined) return false;
            if (ch.length !== 1) return false;
            var code = ch.charCodeAt(0);
            return (code >= 0x20 && code <= 0x7E);
        } catch (e) {
            return false;
        }
    }

    // =========================
    // Overset detector (AreaText only) + 兜底重算
    // =========================
    /**
     * Illustrator ExtendScript 没有稳定的 TextFrame.overflows
     * 用“总字符数 vs 可见行字符数(补偿行尾断行)”判断 overset
     * 仅对 AreaText 有意义
     *
     * 兜底：第一次计算异常/可疑，则 redraw 后重算一次
     */
    function isOversetAreaText(tf) {
        function computeOnce(_tf) {
            if (!_tf) return { ok: true, value: false, suspicious: false };
            if (_tf.kind !== TextType.AREATEXT) return { ok: true, value: false, suspicious: false };

            var total = 0;
            try {
                total = _tf.characters.length; // 通常包含 overset
            } catch (e1) {
                total = _tf.textRange.characters.length;
            }
            if (total <= 0) return { ok: true, value: false, suspicious: false };

            var lines = _tf.lines;
            if (!lines || lines.length === 0) {
                // 有字符但没有可见行，视为 overset
                return { ok: true, value: true, suspicious: true }; // suspicious：可能是排版状态未刷新
            }

            var visible = 0;
            for (var i = 0; i < lines.length; i++) {
                try {
                    visible += lines[i].characters.length;
                } catch (e2) { }
            }

            // 行尾断行补偿
            visible += Math.max(0, lines.length - 1);

            // 可疑条件：总字符>0 但可见字符为0（或明显不合理）
            var suspicious = false;
            if (total > 0 && visible === 0) suspicious = true;
            if (visible > total + 5) suspicious = true; // 极少数版本可能出现反向异常

            return { ok: true, value: (visible < total), suspicious: suspicious };
        }

        try {
            var r1 = computeOnce(tf);
            if (!r1.ok) return false;

            // 若第一次结果可疑，则 redraw 后再算一次兜底
            if (r1.suspicious) {
                try { app.redraw(); } catch (eR) { }
                var r2 = computeOnce(tf);
                if (r2 && r2.ok) return r2.value;
            }

            return r1.value;
        } catch (e) {
            // 兜底：异常时 redraw 后再试一次
            try { app.redraw(); } catch (eR2) { }
            try {
                var r3 = (function () {
                    // 简化再算一次，避免递归
                    if (!tf) return false;
                    if (tf.kind !== TextType.AREATEXT) return false;

                    var total = 0;
                    try { total = tf.characters.length; } catch (e1) { total = tf.textRange.characters.length; }
                    if (total <= 0) return false;

                    var lines = tf.lines;
                    if (!lines || lines.length === 0) return true;

                    var visible = 0;
                    for (var i = 0; i < lines.length; i++) {
                        try { visible += lines[i].characters.length; } catch (e2) { }
                    }
                    visible += Math.max(0, lines.length - 1);

                    return (visible < total);
                })();
                return r3;
            } catch (e2) {
                // 任何异常都别误触发扩框
                return false;
            }
        }
    }

    // =========================
    // Font helpers
    // =========================
    function fontLabel(tf) {
        var fam = tf.family ? String(tf.family) : "";
        var sty = tf.style ? String(tf.style) : "";
        if (fam || sty) return (fam + " " + sty).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        return String(tf.name);
    }

    function sortFontItems(arr) {
        arr.sort(function (a, b) {
            var A = a.label.toLowerCase(), B = b.label.toLowerCase();
            return A < B ? -1 : (A > B ? 1 : 0);
        });
        return arr;
    }

    function buildAllFontItems() {
        var fonts = app.textFonts;
        var arr = [];
        for (var i = 0; i < fonts.length; i++) {
            var tf = fonts[i];
            arr.push({ label: fontLabel(tf), font: tf, name: String(tf.name) });
        }
        return sortFontItems(arr);
    }

    // 扫描所有已打开文档中实际使用过的字体（按格式区段）
    function buildUsedFontItemsInDocument() {
        var used = {}; // key: font.name

        for (var d = 0; d < app.documents.length; d++) {
            var dDoc = app.documents[d];
            if (!dDoc) continue;

            var tfs = null;
            try { tfs = dDoc.textFrames; } catch (e0) { tfs = null; }
            if (!tfs) continue;

            for (var i = 0; i < tfs.length; i++) {
                try {
                    var segs = tfs[i].textRange.textRanges;
                    for (var r = 0; r < segs.length; r++) {
                        try {
                            var f = segs[r].characterAttributes.textFont;
                            if (f && f.name && !used[f.name]) {
                                used[f.name] = { label: fontLabel(f), font: f, name: String(f.name) };
                            }
                        } catch (e1) { }
                    }
                } catch (e2) { }
            }
        }

        var arr = [];
        for (var k in used) arr.push(used[k]);
        return sortFontItems(arr);
    }

    function findFontByNameInItems(items, fontName) {
        if (!fontName) return null;
        for (var i = 0; i < items.length; i++) {
            if (items[i].font && items[i].font.name === fontName) return items[i];
        }
        return null;
    }

    // =========================
    // Selection helpers
    // =========================
    function getSelectionAsArray() {
        var sel = doc.selection;
        if (!sel) return [];
        if (sel.typename) return [sel];              // TextRange 等单对象
        if (sel.length !== undefined) return sel;    // 正常数组
        return [sel];
    }

    function collectTextFramesFromGroup(groupItem, outArr) {
        var items = groupItem.pageItems;
        for (var j = 0; j < items.length; j++) {
            var it = items[j];
            if (!it) continue;
            if (it.typename === "TextFrame") outArr.push(it);
            else if (it.typename === "GroupItem") collectTextFramesFromGroup(it, outArr);
        }
    }

    function collectTextFramesFromSelectionItems(items, outArr) {
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it) continue;
            if (it.typename === "TextFrame") outArr.push(it);
            else if (it.typename === "GroupItem") collectTextFramesFromGroup(it, outArr);
        }
    }

    function getParentTextFrameFromTextRange(tr) {
        // 尝试向上找 TextFrame
        var p = tr;
        for (var i = 0; i < 10; i++) {
            if (!p) break;
            if (p.typename === "TextFrame") return p;
            if (p.parent) p = p.parent;
            else break;
        }
        return null;
    }

    function addUniqueFrame(arr, tf) {
        if (!tf) return;
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === tf) return;
        }
        arr.push(tf);
    }

    // =========================
    // Replace helpers
    // =========================

    // 原方案：按格式区段替换（整段替换）
    function replaceInTextRangeBySegments(textRange, fromToMap) {
        var replacedChars = 0;
        try {
            var segs = textRange.textRanges; // 连续格式区段
            for (var i = 0; i < segs.length; i++) {
                try {
                    var seg = segs[i];
                    var f = seg.characterAttributes.textFont;
                    if (f && f.name && fromToMap[f.name]) {
                        seg.characterAttributes.textFont = fromToMap[f.name];
                        try { replacedChars += seg.characters.length; } catch (eLen) { replacedChars += 1; }
                    }
                } catch (eSeg) { }
            }
        } catch (e) { }
        return replacedChars;
    }

    // 新功能：仅替换半角字符（逐字符）
    // 规则：若该字符当前 font 在 map 中，并且字符是 ASCII 半角，则把该字符 font 换成 map 目标 font
    function replaceHalfwidthInTextRange(textRange, fromToMap) {
        var replacedChars = 0;

        try {
            var chars = textRange.characters;
            var n = chars.length;

            // 大文档性能：每隔一段 redraw 一次（避免 UI 卡死/状态滞后）
            var REDRAW_EVERY = 800;

            for (var i = 0; i < n; i++) {
                try {
                    var ch = chars[i];
                    var s = "";
                    try { s = ch.contents; } catch (eC) { s = ""; }

                    if (!isHalfwidthASCIIChar(s)) continue;

                    var f = null;
                    try { f = ch.characterAttributes.textFont; } catch (eF) { f = null; }
                    if (!f || !f.name) continue;

                    var toFont = fromToMap[f.name];
                    if (!toFont) continue;

                    ch.characterAttributes.textFont = toFont;
                    replacedChars++;

                    if (i > 0 && (i % REDRAW_EVERY === 0)) {
                        try { app.redraw(); } catch (eR) { }
                    }
                } catch (e1) { }
            }
        } catch (e2) { }

        return replacedChars;
    }

    // =========================
    // Overflow fix (方案B：扩框，不改字号)
    // =========================
    function isAreaText(tf) {
        try {
            return (tf.kind === TextType.AREATEXT);
        } catch (e) {
            try { return !!tf.textPath; } catch (e2) { }
        }
        return false;
    }

    // 用 tf.lines
    function getLineCount(tf) {
        var lineCount = 0;
        try { lineCount = tf.lines.length; } catch (e) { lineCount = 0; }
        return lineCount;
    }

    function getJustify(tf) {
        try {
            if (tf.textRange.paragraphs.length > 0) {
                return tf.textRange.paragraphs[0].paragraphAttributes.justification;
            }
        } catch (e) { }
        return null;
    }

    function justifyToCategory(justify) {
        if (justify === null || justify === undefined) return "LEFT";
        var s = "";
        try { s = String(justify); } catch (e) { s = ""; }
        s = s.toUpperCase();

        if (s.indexOf("LEFT") >= 0) return "LEFT";
        if (s.indexOf("RIGHT") >= 0) return "RIGHT";
        if (s.indexOf("CENTER") >= 0) return "CENTER";
        if (s.indexOf("JUST") >= 0) return "CENTER";
        return "LEFT";
    }

    function expandAreaTextPath(tf, addW, addH, anchorCategory) {
        var p;
        try { p = tf.textPath; } catch (e) { p = null; }
        if (!p) return false;

        var left = p.left;
        var top = p.top;
        var width = p.width;
        var height = p.height;

        if (!(width > 0)) width = 1;
        if (!(height > 0)) height = 1;

        var right = left + width;
        var cx = left + width / 2;

        var newW = Math.max(1, width + addW);
        var newH = Math.max(1, height + addH);

        try { p.width = newW; } catch (eW) { }
        try { p.height = newH; } catch (eH) { }

        try {
            if (anchorCategory === "TOPLEFT") {
                p.left = left;
                p.top = top;
            } else if (anchorCategory === "TOPRIGHT") {
                p.left = right - newW;
                p.top = top;
            } else { // TOPCENTER
                p.left = cx - newW / 2;
                p.top = top;
            }
        } catch (ePos) { }

        return true;
    }

    function fixOverflowForFrame(tf, preWasOverflow, preLineCount, preJustifyCategory, singleLineStep, multiLineStep, maxLoops) {
        var result = { fixed: false, loops: 0, stillOverflow: false };

        if (!tf) return result;
        if (!isAreaText(tf)) return result;

        if (preWasOverflow) return result;
        if (!isOversetAreaText(tf)) return result;

        var isSingle = (preLineCount <= 1);
        var loops = 0;

        while (isOversetAreaText(tf) && loops < maxLoops) {

            if (isSingle) {
                var anchor = (preJustifyCategory === "RIGHT") ? "TOPRIGHT"
                    : (preJustifyCategory === "CENTER" ? "TOPCENTER" : "TOPLEFT");
                expandAreaTextPath(tf, singleLineStep, singleLineStep, anchor);
            } else {
                expandAreaTextPath(tf, 0, multiLineStep, "TOPLEFT");
            }

            loops++;
            if (loops % 3 === 0) app.redraw();
        }

        app.redraw();

        result.loops = loops;
        var afterOverflow = isOversetAreaText(tf);
        result.stillOverflow = afterOverflow;
        result.fixed = (!afterOverflow);
        return result;
    }

    // =========================
    // Dropdown helpers
    // =========================
    function clearDropdown(dd) {
        while (dd.items.length > 0) dd.remove(dd.items[0]);
    }

    function refillDropdown(dd, baseItems, filterText, preferredFontName) {
        var f = (filterText || "").toLowerCase();

        var keepName = preferredFontName;
        if (!keepName && dd.selection && dd._items && dd._items[dd.selection.index]) {
            keepName = dd._items[dd.selection.index].font
                ? dd._items[dd.selection.index].font.name
                : dd._items[dd.selection.index]._missingName;
        }

        var filtered = [];
        for (var i = 0; i < baseItems.length; i++) {
            var it = baseItems[i];
            if (!f ||
                it.label.toLowerCase().indexOf(f) !== -1 ||
                it.name.toLowerCase().indexOf(f) !== -1) {
                filtered.push(it);
            }
        }

        var injected = null;
        if (keepName) {
            var keepItem = findFontByNameInItems(baseItems, keepName);
            var keepIsInFiltered = false;
            for (var j = 0; j < filtered.length; j++) {
                if (filtered[j].font && filtered[j].font.name === keepName) { keepIsInFiltered = true; break; }
            }
            if (!keepIsInFiltered) {
                if (keepItem) {
                    injected = { label: "(selected) " + keepItem.label, font: keepItem.font, name: keepItem.name, _injected: true };
                } else {
                    injected = { label: "(missing) " + keepName, font: null, name: keepName, _missingName: keepName, _injected: true };
                }
            }
        }

        clearDropdown(dd);

        var finalItems = [];
        if (injected) finalItems.push(injected);
        for (var k = 0; k < filtered.length; k++) finalItems.push(filtered[k]);

        dd._items = finalItems;

        if (finalItems.length === 0) {
            dd.add("item", "(no matches)");
            dd.enabled = false;
            dd.selection = 0;
            return;
        }

        dd.enabled = true;
        for (var m = 0; m < finalItems.length; m++) dd.add("item", finalItems[m].label);

        var selIndex = 0;
        if (keepName) {
            for (var n = 0; n < finalItems.length; n++) {
                var fn = finalItems[n].font ? finalItems[n].font.name : finalItems[n]._missingName;
                if (fn === keepName) { selIndex = n; break; }
            }
        }
        dd.selection = selIndex;

        dd._missingName = null;
        if (finalItems[selIndex] && finalItems[selIndex]._missingName) dd._missingName = finalItems[selIndex]._missingName;
    }

    function getSelectedFont(dd) {
        if (!dd.enabled) return null;
        if (!dd.selection) return null;
        if (!dd._items || dd._items.length === 0) return null;
        return dd._items[dd.selection.index].font || null;
    }

    function getSelectedFontName(dd) {
        if (!dd.enabled || !dd.selection || !dd._items || dd._items.length === 0) return null;
        var it = dd._items[dd.selection.index];
        if (it.font) return it.font.name;
        if (it._missingName) return it._missingName;
        return null;
    }

    // =========================
    // Prepare font lists
    // =========================
    var allFontItems = buildAllFontItems();
    var usedFontItems = buildUsedFontItemsInDocument();

    // =========================
    // UI
    // =========================
    var dlg = new Window("dialog", "Replace Fonts", undefined, { resizeable: true });
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.spacing = 10;
    dlg.margins = 14;

    dlg.onResizing = dlg.onResize = function () {
        try { this.layout.resize(); } catch (e) { }
    };

    var gTop = dlg.add("group");
    gTop.orientation = "row";
    gTop.alignChildren = ["left", "center"];
    gTop.spacing = 8;

    gTop.add("statictext", undefined, "Filter:");
    var edtFilter = gTop.add("edittext", undefined, "");
    edtFilter.characters = 18;

    var btnSearch = gTop.add("button", undefined, "Search");
    var btnClear = gTop.add("button", undefined, "Clear");
    var btnLoad = gTop.add("button", undefined, "Load rules");
    var btnSave = gTop.add("button", undefined, "Save rules");

    var pPairs = dlg.add("panel", undefined, "Replacements (from → to)");
    pPairs.orientation = "column";
    pPairs.alignChildren = ["fill", "top"];
    pPairs.margins = 10;
    pPairs.spacing = 6;

    var gPairBtns = dlg.add("group");
    gPairBtns.orientation = "row";
    gPairBtns.alignChildren = ["left", "center"];
    gPairBtns.spacing = 12;

    var btnAdd = gPairBtns.add("button", undefined, "+ Add");
    var chkFromAll = gPairBtns.add("checkbox", undefined, "List all fonts in the From menu");
    chkFromAll.value = false;

    var chkAutoExpand = gPairBtns.add("checkbox", undefined, "Grow frames that overset after replacing");
    chkAutoExpand.value = true;

    // 新增：仅替换半角字符
    var chkHalfwidthOnly = gPairBtns.add("checkbox", undefined, "Halfwidth characters only (Latin, digits, punctuation)");
    chkHalfwidthOnly.value = false;

    var pScope = dlg.add("panel", undefined, "Scope");
    pScope.orientation = "column";
    pScope.alignChildren = ["left", "top"];
    pScope.margins = 10;
    var rbDoc = pScope.add("radiobutton", undefined, "Whole document");
    var rbSel = pScope.add("radiobutton", undefined, "Selection only (text frames or a text range)");
    rbDoc.value = true;

    var gBtns = dlg.add("group");
    gBtns.alignment = "right";
    var btnRun = gBtns.add("button", undefined, "Replace", { name: "ok" });
    var btnCancel = gBtns.add("button", undefined, "Cancel", { name: "cancel" });

    var pairRows = [];

    function relayout() {
        try {
            dlg.layout.layout(true);
            dlg.layout.resize();
        } catch (e) { }
    }

    function getFromBaseItems() {
        return chkFromAll.value ? allFontItems : usedFontItems;
    }

    function nextUnusedFromFontName() {
        var candidate = usedFontItems.length ? usedFontItems : getFromBaseItems();
        var usedNames = {};
        for (var i = 0; i < pairRows.length; i++) {
            var nm = getSelectedFontName(pairRows[i].ddFrom);
            if (nm) usedNames[nm] = true;
        }
        for (var j = 0; j < candidate.length; j++) {
            var nm2 = candidate[j].font.name;
            if (!usedNames[nm2]) return nm2;
        }
        return null;
    }

    function clearAllPairRows() {
        for (var i = pairRows.length - 1; i >= 0; i--) {
            try { pPairs.remove(pairRows[i].group); } catch (e) { }
            pairRows.pop();
        }
        relayout();
    }

    function addPairRow(preferFromName, preferToName) {
        var rowG = pPairs.add("group");
        rowG.orientation = "row";
        rowG.alignChildren = ["left", "center"];
        rowG.spacing = 6;

        rowG.add("statictext", undefined, "From:");
        var ddFrom = rowG.add("dropdownlist", undefined, []);
        ddFrom.preferredSize = [220, 24];

        rowG.add("statictext", undefined, "→ To:");
        var ddTo = rowG.add("dropdownlist", undefined, []);
        ddTo.preferredSize = [220, 24];

        var btnDel = rowG.add("button", undefined, "Remove");

        var rowObj = { group: rowG, ddFrom: ddFrom, ddTo: ddTo, btnDel: btnDel };
        pairRows.push(rowObj);

        var filterText = edtFilter.text || "";

        var fromBase = getFromBaseItems();
        if (fromBase.length === 0) {
            clearDropdown(ddFrom);
            ddFrom.add("item", "(no fonts found)");
            ddFrom.enabled = false;
            ddFrom.selection = 0;
            ddFrom._items = [];
        } else {
            refillDropdown(ddFrom, fromBase, filterText, preferFromName || null);
        }

        refillDropdown(ddTo, allFontItems, filterText, preferToName || null);

        btnDel.onClick = function () {
            for (var i = 0; i < pairRows.length; i++) {
                if (pairRows[i] === rowObj) {
                    try { pPairs.remove(rowObj.group); } catch (e) { }
                    pairRows.splice(i, 1);
                    break;
                }
            }
            relayout();
        };

        relayout();
    }

    function applyFilterToAll() {
        var txt = edtFilter.text || "";
        var fromBase = getFromBaseItems();

        for (var i = 0; i < pairRows.length; i++) {
            var fromKeep = getSelectedFontName(pairRows[i].ddFrom);
            var toKeep = getSelectedFontName(pairRows[i].ddTo);

            if (fromBase.length === 0) {
                clearDropdown(pairRows[i].ddFrom);
                pairRows[i].ddFrom.add("item", "(no fonts found)");
                pairRows[i].ddFrom.enabled = false;
                pairRows[i].ddFrom.selection = 0;
                pairRows[i].ddFrom._items = [];
            } else {
                refillDropdown(pairRows[i].ddFrom, fromBase, txt, fromKeep);
            }

            refillDropdown(pairRows[i].ddTo, allFontItems, txt, toKeep);
        }
    }

    btnSearch.onClick = function () { applyFilterToAll(); };
    btnClear.onClick = function () {
        edtFilter.text = "";
        applyFilterToAll();
        edtFilter.active = true;
    };
    chkFromAll.onClick = function () { applyFilterToAll(); };

    btnAdd.onClick = function () {
        var prefer = nextUnusedFromFontName();
        addPairRow(prefer, null);
    };

    addPairRow(null, null);

    // =========================
    // Save / Load rules
    // =========================
    function collectRulesForSave() {
        var rules = [];
        for (var i = 0; i < pairRows.length; i++) {
            var fromName = getSelectedFontName(pairRows[i].ddFrom);
            var toName = getSelectedFontName(pairRows[i].ddTo);
            if (!fromName || !toName) continue;
            rules.push({ from: fromName, to: toName });
        }
        return rules;
    }

    btnSave.onClick = function () {
        if (pairRows.length === 0) {
            alert("There are no replacements to save.");
            return;
        }

        var rules = collectRulesForSave();
        if (rules.length === 0) {
            alert("No complete rules to save. Choose a From and a To font for each row first.");
            return;
        }

        var file = File.saveDialog("Save font replacement rules as JSON", "JSON:*.json");
        if (!file) return;
        if (!/\.json$/i.test(file.name)) file = new File(file.fsName + ".json");

        var data = {
            version: 1,
            app: "Illustrator",
            savedAt: (new Date()).toString(),
            rules: rules
        };

        try {
            file.encoding = "UTF-8";
            file.lineFeed = "Unix";
            if (!file.open("w")) throw new Error("Could not write the file.");
            file.write(safeStringify(data));
            file.close();
            alert("Rules saved:\n" + file.fsName);
        } catch (e) {
            try { if (file && file.opened) file.close(); } catch (e2) { }
            alert("Save failed:\n" + e);
        }
    };

    btnLoad.onClick = function () {
        var file = File.openDialog("Load font replacement rules (JSON)", "JSON:*.json");
        if (!file) return;

        try {
            file.encoding = "UTF-8";
            if (!file.open("r")) throw new Error("Could not read the file.");
            var txt = file.read();
            file.close();

            var data = safeParse(txt);
            if (!data || !data.rules || !(data.rules instanceof Array)) {
                alert("That file is not a rules file (no rules array).");
                return;
            }

            clearAllPairRows();

            var oldFilter = edtFilter.text;
            edtFilter.text = "";

            for (var i = 0; i < data.rules.length; i++) {
                var r = data.rules[i];
                if (!r || !r.from || !r.to) continue;
                addPairRow(String(r.from), String(r.to));
            }

            if (pairRows.length === 0) addPairRow(null, null);

            edtFilter.text = oldFilter || "";
            alert("Loaded " + data.rules.length + " rules.\nFonts not present in the menus are shown as \"(missing) FontName\".");
        } catch (e) {
            try { if (file && file.opened) file.close(); } catch (e2) { }
            alert("Load failed:\n" + e);
        }
    };

    // =========================
    // Run
    // =========================
    btnRun.onClick = function () {
        if (pairRows.length === 0) {
            alert("Add at least one replacement first.");
            return;
        }

        var map = {};
        var duplicates = {};
        var validPairs = 0;
        var skippedMissing = [];

        for (var i = 0; i < pairRows.length; i++) {
            var fromName = getSelectedFontName(pairRows[i].ddFrom);
            var toName = getSelectedFontName(pairRows[i].ddTo);
            var fromFont = getSelectedFont(pairRows[i].ddFrom);
            var toFont = getSelectedFont(pairRows[i].ddTo);

            if (!fromName || !toName) {
                alert("Row " + (i + 1) + " is incomplete (From and To are both required).");
                return;
            }

            if (!fromFont) { skippedMissing.push("Row " + (i + 1) + ": From font is missing - " + fromName); continue; }
            if (!toFont) { skippedMissing.push("Row " + (i + 1) + ": To font is missing - " + toName); continue; }

            if (fromFont.name === toFont.name) continue;

            if (map[fromFont.name]) duplicates[fromFont.name] = true;
            else { map[fromFont.name] = toFont; validPairs++; }
        }

        if (validPairs === 0) {
            var msg0 = "No usable replacements. Every row either maps a font to itself or refers to a missing font.";
            if (skippedMissing.length) msg0 += "\n\nSkipped, font missing:\n- " + skippedMissing.join("\n- ");
            alert(msg0);
            return;
        }

        var dupList = [];
        for (var k in duplicates) dupList.push(k);
        if (dupList.length > 0) {
            alert("The same From font appears in more than one row.\n\nRemove or merge the duplicates and run again.\nDuplicates:\n- " + dupList.join("\n- "));
            return;
        }

        // ---------- Determine scope targets ----------
        var selArr = [];
        var framesToReplace = [];
        var rangesToReplace = [];
        var framesToFix = [];

        if (rbDoc.value) {
            for (var d = 0; d < doc.textFrames.length; d++) {
                addUniqueFrame(framesToReplace, doc.textFrames[d]);
                addUniqueFrame(framesToFix, doc.textFrames[d]);
            }
        } else {
            selArr = getSelectionAsArray();
            if (selArr.length === 0) {
                alert("Scope is set to Selection only, but nothing is selected.\n\nSelect a text frame or group with the Selection tool (V), or select text with the Type tool.");
                return;
            }

            for (var s = 0; s < selArr.length; s++) {
                if (selArr[s] && selArr[s].typename === "TextRange") {
                    rangesToReplace.push(selArr[s]);
                    var pTf = getParentTextFrameFromTextRange(selArr[s]);
                    if (pTf) addUniqueFrame(framesToFix, pTf);
                }
            }

            var tmpFrames = [];
            collectTextFramesFromSelectionItems(selArr, tmpFrames);
            for (var t = 0; t < tmpFrames.length; t++) {
                addUniqueFrame(framesToReplace, tmpFrames[t]);
                addUniqueFrame(framesToFix, tmpFrames[t]);
            }

            if (rangesToReplace.length === 0 && framesToReplace.length === 0) {
                alert("The selection contains no editable text.\n\nSelect a text frame or a group containing text, or select text with the Type tool.");
                return;
            }
        }

        // ---------- Pre-snapshot for overflow fix ----------
        var preInfos = [];
        if (chkAutoExpand.value) {
            for (var f = 0; f < framesToFix.length; f++) {
                var tf = framesToFix[f];
                if (!tf) continue;
                if (!isAreaText(tf)) continue;

                var wasOv = isOversetAreaText(tf);
                var lc = getLineCount(tf);
                var jc = justifyToCategory(getJustify(tf));

                preInfos.push({
                    tf: tf,
                    wasOverflow: wasOv,
                    lineCount: lc,
                    justifyCat: jc
                });
            }
        }

        // ---------- Do replacement ----------
        var totalReplaced = 0;
        var useHalfwidthOnly = chkHalfwidthOnly.value === true;

        var replaceFn = useHalfwidthOnly ? replaceHalfwidthInTextRange : replaceInTextRangeBySegments;

        for (var rr = 0; rr < rangesToReplace.length; rr++) {
            totalReplaced += replaceFn(rangesToReplace[rr], map);
        }

        for (var ff = 0; ff < framesToReplace.length; ff++) {
            totalReplaced += replaceFn(framesToReplace[ff].textRange, map);
        }

        // 关键：替换后强制刷新排版/lines 状态
        app.redraw();

        // ---------- Fix overflow (方案B) ----------
        var fixedCount = 0;
        var stillOverflowCount = 0;
        var consideredCount = 0;

        if (chkAutoExpand.value && preInfos.length > 0) {
            var SINGLE_STEP = 10;
            var MULTI_STEP = 12;
            var MAX_LOOPS = 200;

            for (var pi = 0; pi < preInfos.length; pi++) {
                var info = preInfos[pi];
                if (!info || !info.tf) continue;

                var before = info.wasOverflow;

                // 逐对象兜底刷新
                app.redraw();
                var after = isOversetAreaText(info.tf);

                if (!before && after) {
                    consideredCount++;

                    var rFix = fixOverflowForFrame(
                        info.tf,
                        before,
                        info.lineCount,
                        info.justifyCat,
                        SINGLE_STEP,
                        MULTI_STEP,
                        MAX_LOOPS
                    );

                    if (rFix.fixed) fixedCount++;
                    else stillOverflowCount++;
                }
            }
        }

        // ---------- Done ----------
        var doneMsg =
            "Replacement complete.\n" +
            "Rules applied: " + validPairs + "\n" +
            "Characters replaced: " + totalReplaced + "\n" +
            "Mode: " + (useHalfwidthOnly ? "halfwidth only (ASCII letters, digits, punctuation)" : "whole font runs");

        if (chkAutoExpand.value) {
            doneMsg += "\n\nFrames grown after overset:\n" +
                "Area type frames that overset only after replacing: " + consideredCount + "\n" +
                "fixed: " + fixedCount + "\n" +
                "still overset, needs manual work: " + stillOverflowCount;
        }

        if (skippedMissing.length) {
            doneMsg += "\n\nSkipped, font missing:\n- " + skippedMissing.join("\n- ");
        }

        alert(doneMsg);
        dlg.close(1);
    };

    btnCancel.onClick = function () { dlg.close(0); };

    dlg.show();

})();
