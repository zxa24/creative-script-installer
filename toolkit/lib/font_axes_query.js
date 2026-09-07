"use strict";

// font_axes_query.js
//
// 给一个 family 名（如 "Myriad Variable Concept"），枚举 itemByName 一组
// 标准 style 候选 → 返回该 family 实际有哪些 weight / width / italic 物理
// master，以及对应 CSS font-weight / font-stretch / font-style 数字。
//
// UXP webview 没有 FontFace API + document.fonts，无法从浏览器侧查 axis 上
// 下限；InDesign DOM 也只暴露 style 字符串 + postscriptName，不暴露 OS/2 数
// 字。所以唯一可拿数据 = itemByName 枚举 + postscript 名解码。
//
// 用法（在 idjs 里）：
//
//     var FAQ = require("../lib/font_axes_query.js");
//     var axes = FAQ.queryFontAxes("Myriad Variable Concept");
//     // → {
//     //     family: "Myriad Variable Concept",
//     //     weights: [
//     //       { style: "Light", css_weight: 300, postscript: "MyriadConceptRoman-Light" },
//     //       { style: "Regular", css_weight: 400, postscript: "..." }, ...
//     //     ],
//     //     widths: [{ style: "Condensed", css_stretch: "condensed", ... }],
//     //     italics: [{ style: "Italic", css_style: "italic" }, ...]
//     //   }
//
// 注意 family-CSS 分裂：Windows 把 DengXian 三档注册成 'DengXian Light' /
// 'DengXian' / 'DengXian Bold' 三个独立 CSS family；InDesign 仍报同 family。
// 本 helper 返回 InDesign 视角的 weights，CSS 用时还要看 Chromium 是否分裂
// （需要视觉验证或 Windows GDI 查询，不在 helper 职责内）。

// 标准字重候选（style → CSS font-weight 数字）
// 顺序很重要：高频/常见 style 名放前面，让 postscript 去重先认这些。
// InDesign 对未装的 style 仍返 isValid=true + fallback 字体 postscript（通常
// Regular）—— 顺序反了会让稀有名（Thin/Book/L）把 Regular 那一条占掉。
var STANDARD_WEIGHTS = [
    // 必占先（实物理 master 的常见名）
    { style: "Regular",      css_weight: 400 },
    { style: "Bold",         css_weight: 700 },
    { style: "Light",        css_weight: 300 },
    { style: "Medium",       css_weight: 500 },
    { style: "Semibold",     css_weight: 600 },
    { style: "Black",        css_weight: 900 },
    // 同义名
    { style: "Normal",       css_weight: 400 },
    { style: "SemiBold",     css_weight: 600 },
    { style: "Demibold",     css_weight: 600 },
    { style: "DemiBold",     css_weight: 600 },
    { style: "Demi",         css_weight: 600 },
    { style: "Heavy",        css_weight: 800 },
    // 极端档
    { style: "Thin",         css_weight: 100 },
    { style: "Hairline",     css_weight: 100 },
    { style: "ExtraLight",   css_weight: 200 },
    { style: "UltraLight",   css_weight: 200 },
    { style: "ExtraBold",    css_weight: 800 },
    { style: "UltraBold",    css_weight: 800 },
    { style: "DemiLight",    css_weight: 350 },
    { style: "Book",         css_weight: 380 },
    // 数字 W1-W9（Apple / Hiragino）
    { style: "W1", css_weight: 100 },
    { style: "W2", css_weight: 200 },
    { style: "W3", css_weight: 300 },
    { style: "W4", css_weight: 400 },
    { style: "W5", css_weight: 500 },
    { style: "W6", css_weight: 600 },
    { style: "W7", css_weight: 700 },
    { style: "W8", css_weight: 800 },
    { style: "W9", css_weight: 900 },
    // 单字母后缀（Adobe Std CJK）
    { style: "L", css_weight: 300 },
    { style: "R", css_weight: 400 },
    { style: "M", css_weight: 500 },
    { style: "B", css_weight: 700 }
];

// 宽度档（style → CSS font-stretch）
var STANDARD_WIDTHS = [
    { style: "UltraCondensed",  css_stretch: "ultra-condensed",  pct: 50  },
    { style: "ExtraCondensed",  css_stretch: "extra-condensed",  pct: 62.5 },
    { style: "Condensed",       css_stretch: "condensed",        pct: 75  },
    { style: "SemiCondensed",   css_stretch: "semi-condensed",   pct: 87.5 },
    // "Normal" = 100% 是默认，不单独枚举（在 weight 表里）
    { style: "SemiExtended",    css_stretch: "semi-expanded",    pct: 112.5 },
    { style: "SemiExpanded",    css_stretch: "semi-expanded",    pct: 112.5 },
    { style: "Extended",        css_stretch: "expanded",         pct: 125 },
    { style: "Expanded",        css_stretch: "expanded",         pct: 125 },
    { style: "ExtraExtended",   css_stretch: "extra-expanded",   pct: 150 },
    { style: "UltraExtended",   css_stretch: "ultra-expanded",   pct: 200 }
];

// 斜体候选（style → CSS font-style + 可能附带 weight）
var STANDARD_ITALICS = [
    { style: "Italic",        css_style: "italic", css_weight: 400 },
    { style: "Oblique",       css_style: "oblique", css_weight: 400 },
    { style: "Light Italic",  css_style: "italic", css_weight: 300 },
    { style: "Medium Italic", css_style: "italic", css_weight: 500 },
    { style: "Semibold Italic", css_style: "italic", css_weight: 600 },
    { style: "Bold Italic",   css_style: "italic", css_weight: 700 },
    { style: "Black Italic",  css_style: "italic", css_weight: 900 }
];

function _probeMaster(family, style, app) {
    var name = family + "\t" + style;
    try {
        var f = app.fonts.itemByName(name);
        if (f && f.isValid && f.postscriptName) {
            return { name: name, style: style, postscript: f.postscriptName };
        }
    } catch (e) {}
    return null;
}

// 主 API：给 family 名，返回 axes 描述
function queryFontAxes(family) {
    var indesign = require("indesign");
    var app = indesign.app;
    var out = {
        family: family,
        weights: [],
        widths: [],
        italics: [],
        all_masters: []          // postscript 去重后的所有 master 列表
    };
    var seenPs = {};

    STANDARD_WEIGHTS.forEach(function (cand) {
        var hit = _probeMaster(family, cand.style, app);
        if (hit && !seenPs[hit.postscript]) {
            seenPs[hit.postscript] = true;
            out.weights.push({
                style: cand.style,
                css_weight: cand.css_weight,
                postscript: hit.postscript
            });
            out.all_masters.push({ style: cand.style, postscript: hit.postscript });
        }
    });

    STANDARD_WIDTHS.forEach(function (cand) {
        var hit = _probeMaster(family, cand.style, app);
        if (hit && !seenPs[hit.postscript]) {
            seenPs[hit.postscript] = true;
            out.widths.push({
                style: cand.style,
                css_stretch: cand.css_stretch,
                stretch_pct: cand.pct,
                postscript: hit.postscript
            });
            out.all_masters.push({ style: cand.style, postscript: hit.postscript });
        }
    });

    STANDARD_ITALICS.forEach(function (cand) {
        var hit = _probeMaster(family, cand.style, app);
        if (hit && !seenPs[hit.postscript]) {
            seenPs[hit.postscript] = true;
            out.italics.push({
                style: cand.style,
                css_style: cand.css_style,
                css_weight: cand.css_weight,
                postscript: hit.postscript
            });
            out.all_masters.push({ style: cand.style, postscript: hit.postscript });
        }
    });

    // 汇总：weight 范围下/上限（取 css_weight 数字的 min/max）
    if (out.weights.length > 0) {
        var ws = out.weights.map(function (w) { return w.css_weight; });
        out.weight_range = { min: Math.min.apply(null, ws), max: Math.max.apply(null, ws) };
    }
    if (out.widths.length > 0) {
        var ws2 = out.widths.map(function (w) { return w.stretch_pct; });
        out.width_range = { min_pct: Math.min.apply(null, ws2), max_pct: Math.max.apply(null, ws2) };
    }
    out.has_italic = out.italics.length > 0;

    return out;
}

module.exports = {
    queryFontAxes: queryFontAxes,
    STANDARD_WEIGHTS: STANDARD_WEIGHTS,
    STANDARD_WIDTHS: STANDARD_WIDTHS,
    STANDARD_ITALICS: STANDARD_ITALICS
};
