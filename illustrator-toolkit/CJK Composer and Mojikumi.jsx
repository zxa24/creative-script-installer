#target illustrator

(function () {
    if (app.documents.length === 0) {
        alert("No document open.");
        return;
    }

    var doc = app.activeDocument;

    // ======================
    // 配置区：按需改这里
    // ======================

    // 应用范围： "selection" 仅所选；"document" 全文档
    // 通过弹窗让用户选择，默认全文档
    var hasSelection = doc.selection && (doc.selection.length > 0 || doc.selection.typename === "TextRange");
    var APPLY_TO = "document";
    if (hasSelection) {
        var choice = confirm("A selection was detected.\n\nOK - process only the selected text frames\nCancel - process every text frame in the document");
        if (choice) APPLY_TO = "selection";
    }

    // 书写器模式： "paragraph" = Every-line（更接近“段落/多行书写器”）
    //           "single"   = Single-line（单行书写器）
    var COMPOSER_MODE = "paragraph";

    // 是否尝试设置 Mojikumi / Kinsoku（决定中英数字间距、标点规则等）
    var SET_MOJIKUMI = true;
    var SET_KINSOKU  = true;

    // 如果你知道具体名字（不同语言界面名字可能不同），建议直接填死更稳：
    // 留空（""）= 让脚本自动挑一个“看起来像中文/日文”的预设；实在找不到就跳过
    var MOJIKUMI_NAME = "";
    var KINSOKU_NAME  = "";

    // 标点悬挂（Burasagari）：对“句号/逗号”等挤出边界有帮助（更像“标点挤压/悬挂”的一部分）
    var ENABLE_BURASAGARI = true; // true/false
    var BURASAGARI_MODE = BurasagariTypeEnum.Standard; // Standard / Forced / None :contentReference[oaicite:2]{index=2}

    // Bunri-Kinshi：防止特定字符被拆分（可选）
    var ENABLE_BUNRIKINSHI = true;

    // Tsume：压缩字符周围 Aki（百分比，越高越"紧"）；不想动就设为 null
    // 注意：这是"字符属性"，不是段落属性；会对选中的文字整体变紧。
    var TSUME_PERCENT = null; // 例如 0, 10, 20... 设 100 很激进

    // 标点挤压：仅对全角标点设置 Tsume，使其从全角压缩为约半角宽度
    var ENABLE_PUNCTUATION_SQUEEZE = true;
    var PUNCTUATION_TSUME = 50; // 标点 Tsume 百分比（50 约为半角）

    // 中英文/数字间距：在 CJK 与 Latin/数字相邻处添加 Aki 间距
    var ENABLE_CJK_LATIN_SPACING = true;
    var CJK_LATIN_AKI = 25; // 间距百分比（25 = 四分之一全角宽，即约 1/4 em）

    // 删除中英文之间的手动空格（因为已通过 Aki 控制间距，手动空格多余）
    var ENABLE_REMOVE_CJK_LATIN_SPACES = true;

    // ======================
    // 主逻辑
    // ======================

    var textFrames = [];
    if (APPLY_TO === "document") {
        for (var i = 0; i < doc.textFrames.length; i++) textFrames.push(doc.textFrames[i]);
        if (textFrames.length === 0) {
            alert("The document contains no text frames.");
            return;
        }
    } else {
        var sel = doc.selection;
        // 用文字工具选中文本时，doc.selection 是单个 TextRange 而非数组
        if (sel && sel.typename === "TextRange") {
            sel = [sel];
        }
        textFrames = collectTextFramesFromSelection(sel);
        if (textFrames.length === 0) {
            alert("Nothing is selected. Select a text frame, or a group containing one, first.");
            return;
        }
    }

    var useEveryLine = (COMPOSER_MODE === "paragraph");

    var mojikumiName = "";
    var kinsokuName = "";

    if (SET_MOJIKUMI) {
        mojikumiName = MOJIKUMI_NAME || guessSetName(doc.mojikumiSet, ["简体", "繁体", "中文", "Chinese", "JIS", "日本", "Japanese"]);
    }
    if (SET_KINSOKU) {
        kinsokuName  = KINSOKU_NAME  || guessSetName(doc.kinsokuSet,  ["简体", "繁体", "中文", "Chinese", "JIS", "日本", "Japanese"]);
    }

    var changedFrames = 0;
    var squeezedFrames = 0;
    var errors = [];
    var allSpaces = []; // 收集所有中英间空格，稍后统一确认

    for (var t = 0; t < textFrames.length; t++) {
        var tf = textFrames[t];
        if (!tf) continue;

        // locked / hidden 检查也可能抛异常（Legacy Text 等）
        try {
            if (tf.locked || tf.hidden) continue;
        } catch (e) {
            errors.push("Frame " + t + " status check failed: " + e.message);
            continue;
        }

        try {
            // 段落级：Composer / Mojikumi / Kinsoku / Burasagari / Bunri-Kinshi
            var paras = tf.paragraphs;
            for (var p = 0; p < paras.length; p++) {
                // 跳过末尾空段落（末尾换行符产生的空段落无法访问 paragraphAttributes）
                try { if (paras[p].length === 0) continue; } catch (epl) { continue; }

                var pa;
                try { pa = paras[p].paragraphAttributes; } catch (epa) { continue; }

                try { pa.everyLineComposer = useEveryLine; }
                catch (ec) { errors.push("everyLineComposer could not be set: " + ec.message); }

                if (SET_MOJIKUMI && mojikumiName) {
                    try { pa.mojikumi = mojikumiName; }
                    catch (em) { errors.push("Mojikumi could not be set: " + em.message); }
                }
                if (SET_KINSOKU && kinsokuName) {
                    try { pa.kinsoku = kinsokuName; }
                    catch (ek) { errors.push("Kinsoku could not be set: " + ek.message); }
                }

                if (ENABLE_BURASAGARI) {
                    try { pa.burasagariType = BURASAGARI_MODE; }
                    catch (eb) { errors.push("Burasagari could not be set: " + eb.message); }
                }
                if (ENABLE_BUNRIKINSHI) {
                    try { pa.bunriKinshi = true; }
                    catch (ebk) { errors.push("BunriKinshi could not be set: " + ebk.message); }
                }
            }

            // 字符级：Tsume（可选，全局）
            if (TSUME_PERCENT !== null) {
                tf.textRange.characterAttributes.Tsume = TSUME_PERCENT;
            }

            // 标点挤压：仅在文本框空间不足（溢出）时对全角标点设置 Tsume
            if (ENABLE_PUNCTUATION_SQUEEZE) {
                try {
                    var needSqueeze = (tf.kind === TextType.AREATEXT && tf.overflowLength > 0);
                    if (needSqueeze) {
                        applyPunctuationSqueeze(tf, PUNCTUATION_TSUME);
                        squeezedFrames++;
                    }
                } catch (eps) { errors.push("Punctuation compression failed: " + eps.message); }
            }

            // 删除中英文之间的手动空格（在添加 Aki 之前处理）
            if (ENABLE_REMOVE_CJK_LATIN_SPACES) {
                try {
                    var spaceResult = findCJKLatinSpaces(tf);
                    if (spaceResult.indices.length > 0) {
                        allSpaces.push({ frame: t, items: spaceResult.previews, indices: spaceResult.indices, tf: tf });
                    }
                } catch (ers) { errors.push("Space scan failed: " + ers.message); }
            }

            // 中英文/数字间距
            if (ENABLE_CJK_LATIN_SPACING) {
                try { applyCJKLatinSpacing(tf, CJK_LATIN_AKI); }
                catch (ecl) { errors.push("CJK/Latin spacing failed: " + ecl.message); }
            }

            changedFrames++;
        } catch (e) {
            errors.push("Frame " + t + " could not be processed: " + e.message);
        }
    }

    // 中英空格确认与删除
    var removedSpaces = 0;
    if (allSpaces.length > 0) {
        var totalSpaces = 0;
        var previewLines = [];
        for (var si = 0; si < allSpaces.length; si++) {
            totalSpaces += allSpaces[si].items.length;
            for (var sj = 0; sj < allSpaces[si].items.length; sj++) {
                previewLines.push(allSpaces[si].items[sj]);
            }
        }
        // 最多显示 20 条预览
        var displayLines = previewLines.slice(0, 20);
        var confirmMsg = "Found " + totalSpaces + " spaces between CJK and Latin text:\n\n" +
            displayLines.join("\n") +
            (previewLines.length > 20 ? "\n... and " + (previewLines.length - 20) + " more" : "") +
            "\n\nOK removes them, Cancel keeps them.";

        if (confirm(confirmMsg)) {
            // 从后往前删除，避免索引偏移
            for (var sd = allSpaces.length - 1; sd >= 0; sd--) {
                var indices = allSpaces[sd].indices;
                var tfRef = allSpaces[sd].tf;
                var chars = tfRef.textRange.characters;
                for (var sk = indices.length - 1; sk >= 0; sk--) {
                    try {
                        chars[indices[sk]].remove();
                        removedSpaces++;
                    } catch (erd) {}
                }
            }
        }
    }

    var msg = "Done.\n" +
        "Selected text frames: " + textFrames.length + "  processed: " + changedFrames + "\n" +
        "Composer: " + (useEveryLine ? "Every-line (paragraph)" : "Single-line") + "\n" +
        (SET_MOJIKUMI ? ("Mojikumi: " + (mojikumiName || "(not set / not found)")) + "\n" : "") +
        (SET_KINSOKU  ? ("Kinsoku: "  + (kinsokuName  || "(not set / not found)")) + "\n" : "") +
        (ENABLE_BURASAGARI ? ("Burasagari: " + BURASAGARI_MODE) + "\n" : "") +
        (ENABLE_PUNCTUATION_SQUEEZE ? ("Punctuation compression: " + (squeezedFrames > 0 ? squeezedFrames + " overset frames compressed, tsume " + PUNCTUATION_TSUME + "%" : "no overset, nothing compressed")) + "\n" : "") +
        (ENABLE_CJK_LATIN_SPACING ? ("CJK/Latin spacing, aki " + CJK_LATIN_AKI + "%") + "\n" : "") +
        (ENABLE_REMOVE_CJK_LATIN_SPACES ? ("Spaces removed: " + removedSpaces + "") + "\n" : "") +
        (TSUME_PERCENT !== null ? ("Global tsume: " + TSUME_PERCENT + "%") : "");

    if (errors.length > 0) {
        // 去重后显示
        var uniqueErrors = [];
        for (var ei = 0; ei < errors.length; ei++) {
            var dup = false;
            for (var ej = 0; ej < uniqueErrors.length; ej++) {
                if (uniqueErrors[ej] === errors[ei]) { dup = true; break; }
            }
            if (!dup) uniqueErrors.push(errors[ei]);
        }
        msg += "\n--- Errors ---\n" + uniqueErrors.join("\n");
    }

    alert(msg);

    // ======================
    // 工具函数
    // ======================

    function collectTextFramesFromSelection(sel) {
        var out = [];
        if (!sel || sel.length === 0) return out;

        for (var i = 0; i < sel.length; i++) {
            collect(sel[i], out);
        }
        // 去重
        var unique = [];
        for (var a = 0; a < out.length; a++) {
            var exists = false;
            for (var b = 0; b < unique.length; b++) {
                if (unique[b] === out[a]) { exists = true; break; }
            }
            if (!exists) unique.push(out[a]);
        }
        return unique;
    }

    function collect(item, out) {
        if (!item) return;

        if (item.typename === "TextFrame") {
            out.push(item);
            return;
        }

        // 选中的是文本范围（比如用文字工具选中一段）
        if (item.typename === "TextRange") {
            try {
                var p = item.parent;
                // parent 可能是 TextFrame，也可能是 Story
                if (p) {
                    if (p.typename === "TextFrame") {
                        out.push(p);
                    } else if (p.typename === "Story" && p.textFrames && p.textFrames.length > 0) {
                        for (var si = 0; si < p.textFrames.length; si++) {
                            out.push(p.textFrames[si]);
                        }
                    }
                }
            } catch (e) {}
            return;
        }

        // 组：递归找里面的 TextFrame
        if (item.typename === "GroupItem") {
            for (var i = 0; i < item.pageItems.length; i++) {
                collect(item.pageItems[i], out);
            }
            return;
        }
    }

    // 从 doc.mojikumiSet / doc.kinsokuSet 里猜一个名字（不同版本/语言返回结构可能不一样）
    function guessSetName(setObj, keywords) {
        var names = [];

        try {
            if (setObj && setObj.length !== undefined) {
                for (var i = 0; i < setObj.length; i++) names.push("" + setObj[i]);
            } else if (setObj) {
                for (var k in setObj) {
                    try {
                        // 有些实现会把名字当属性值
                        if (setObj.hasOwnProperty(k)) names.push("" + setObj[k]);
                    } catch (e1) {}
                }
            }
        } catch (e) {}

        // 过滤掉明显不是名字的
        var cleaned = [];
        for (var n = 0; n < names.length; n++) {
            var s = names[n];
            if (!s) continue;
            if (s === "[object Object]") continue;
            cleaned.push(s);
        }
        names = cleaned;

        // 关键词匹配
        for (var kw = 0; kw < keywords.length; kw++) {
            var key = keywords[kw];
            for (var j = 0; j < names.length; j++) {
                if (names[j].indexOf(key) !== -1) return names[j];
            }
        }

        // 没匹配到就用第一个
        return (names.length > 0) ? names[0] : "";
    }

    // 对全角标点字符设置 Tsume 实现标点挤压
    function applyPunctuationSqueeze(tf, tsume) {
        // CJK 全角标点（中文 + 日文常用）
        var punctuation = "\u3001\u3002\uFF0C\uFF0E\uFF1A\uFF1B\uFF01\uFF1F" + // 、。，．：；！？
            "\u300C\u300D\u300E\u300F" + // 「」『』
            "\u3010\u3011\u3008\u3009\u300A\u300B" + // 【】〈〉《》
            "\uFF08\uFF09\uFF3B\uFF3D\uFF5B\uFF5D" + // （）［］｛｝
            "\u2018\u2019\u201C\u201D" + // ''""
            "\u2014\u2026"; // —…
        var chars = tf.textRange.characters;
        for (var c = 0; c < chars.length; c++) {
            try {
                var ch = chars[c].contents;
                if (punctuation.indexOf(ch) !== -1) {
                    chars[c].characterAttributes.Tsume = tsume;
                }
            } catch (e) {}
        }
    }

    // 在 CJK 与 Latin/数字相邻处添加 Aki 间距
    function applyCJKLatinSpacing(tf, aki) {
        var chars = tf.textRange.characters;
        if (chars.length < 2) return;

        for (var c = 0; c < chars.length - 1; c++) {
            try {
                var cur = chars[c].contents.charCodeAt(0);
                var nxt = chars[c + 1].contents.charCodeAt(0);
                var curIsCJK = isCJK(cur);
                var nxtIsCJK = isCJK(nxt);
                var curIsLatin = isLatinOrDigit(cur);
                var nxtIsLatin = isLatinOrDigit(nxt);

                if (curIsCJK && nxtIsLatin) {
                    // CJK → Latin：在 CJK 字符右侧加间距
                    chars[c].characterAttributes.akiRight = aki / 100;
                } else if (curIsLatin && nxtIsCJK) {
                    // Latin → CJK：在 Latin 字符右侧加间距
                    chars[c].characterAttributes.akiRight = aki / 100;
                }
            } catch (e) {}
        }
    }

    function isCJK(code) {
        // CJK 统一汉字 + 扩展A/B + 兼容汉字
        return (code >= 0x4E00 && code <= 0x9FFF) ||   // 基本区
               (code >= 0x3400 && code <= 0x4DBF) ||   // 扩展A
               (code >= 0xF900 && code <= 0xFAFF) ||   // 兼容汉字
               (code >= 0x3040 && code <= 0x309F) ||   // 平假名
               (code >= 0x30A0 && code <= 0x30FF);     // 片假名
    }

    function isLatinOrDigit(code) {
        return (code >= 0x0041 && code <= 0x005A) ||   // A-Z
               (code >= 0x0061 && code <= 0x007A) ||   // a-z
               (code >= 0x0030 && code <= 0x0039);     // 0-9
    }

    // 扫描文本框中 CJK 与 Latin/数字之间的空格，返回索引和预览
    function findCJKLatinSpaces(tf) {
        var chars = tf.textRange.characters;
        var indices = [];
        var previews = [];
        var CONTEXT = 3; // 前后显示几个字符

        for (var c = 1; c < chars.length - 1; c++) {
            try {
                var ch = chars[c].contents;
                if (ch !== " " && ch !== "\u3000") continue; // 半角空格或全角空格

                var prevCode = chars[c - 1].contents.charCodeAt(0);
                var nextCode = chars[c + 1].contents.charCodeAt(0);

                var prevIsCJK = isCJK(prevCode);
                var nextIsCJK = isCJK(nextCode);
                var prevIsLatin = isLatinOrDigit(prevCode);
                var nextIsLatin = isLatinOrDigit(nextCode);

                // CJK [空格] Latin  或  Latin [空格] CJK
                if ((prevIsCJK && nextIsLatin) || (prevIsLatin && nextIsCJK)) {
                    indices.push(c);

                    // 生成预览：前后各取几个字符
                    var before = "";
                    var after = "";
                    for (var b = Math.max(0, c - CONTEXT); b < c; b++) {
                        try { before += chars[b].contents; } catch (e) {}
                    }
                    for (var a = c + 1; a <= Math.min(chars.length - 1, c + CONTEXT); a++) {
                        try { after += chars[a].contents; } catch (e) {}
                    }
                    previews.push("  \"" + before + "□" + after + "\"");
                }
            } catch (e) {}
        }
        return { indices: indices, previews: previews };
    }

})();
