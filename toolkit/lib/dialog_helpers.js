"use strict";

// lib/dialog_helpers.js — UXP HTML <dialog> 工具集
//
// 解决 Scripts Panel modal dialog 的尺寸问题：CSS `height: auto / fit-content`
// 走 :modal max-block-size fallback 被裁；CSS `max-height: none` 不生效。
// 必须用 auto-measure-then-pin 模式：showModal hidden 测内容 scrollHeight + close
// + re-showModal pin 具体 px。
//
// 详细原理见 findings.md html-dialog-sizing + react-in-uxp 章节。
//
// 沉淀来源：2026-05-29 probe 02 / 06-11 排查。

// ---------------------------------------------------------------------------
// 工具：等浏览器 paint 真正落地
// ---------------------------------------------------------------------------

function _waitPaint() {
    return new Promise(function (resolve) {
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                setTimeout(resolve, 30);
            });
        });
    });
}

// ---------------------------------------------------------------------------
// measureDialogContent — 多指标交叉测 dialog 内容真实总高
// 防 scrollHeight 漏算或 children 累加漏算
// ---------------------------------------------------------------------------

function measureDialogContent(dlg) {
    var scrollH = dlg.scrollHeight;
    var childrenH = 0;
    for (var i = 0; i < dlg.children.length; i++) {
        var r = dlg.children[i].getBoundingClientRect();
        childrenH += r.height;
    }
    return Math.max(scrollH, Math.round(childrenH));
}

// ---------------------------------------------------------------------------
// showModalAutoHeight — 一键解决 dialog 尺寸问题
//
// 流程：
//   1. visibility:hidden + style.height:auto + appendChild
//   2. showModal hidden（user 看不到中间状态）
//   3. 可选 reactRenderFn（如有 React 渲染，flushSync 同步 commit）
//   4. 等 paint（双 rAF + 30ms）
//   5. measure 内容真实高
//   6. close + 100ms 等真正关闭
//   7. pin style.height = realH + buffer + visibility:visible
//   8. re-showModal 让浏览器按新 height 重 layout
//
// 参数：
//   dlg                — HTMLDialogElement
//   options.reactRenderFn  — 可选；用于 ReactDOM.flushSync 包裹
//                            （如 () => root.render(<App/>)）
//   options.buffer         — 可选；pin height 时额外加的缓冲 px（默认 4）
//   options.maxHeight      — 可选；上限值，超过用此值（防内容过大爆出 host popup）
//
// 返回：Promise<{ measuredHeight: number, pinnedHeight: number }>
//
// 用法：
//   var dlg = document.createElement("dialog");
//   dlg.style.cssText = "width:480px; max-width:none; max-height:none; ...";
//   dlg.innerHTML = "...";
//   var root = ReactDOM.createRoot(dlg.querySelector("#root"));
//   var result = await DialogHelpers.showModalAutoHeight(dlg, {
//     reactRenderFn: function () { root.render(React.createElement(App)); }
//   });
//   // dialog 现在显示中、用户能交互。等用户关闭 dialog 后清理：
//   // dlg.close(); dlg.remove();
// ---------------------------------------------------------------------------

async function showModalAutoHeight(dlg, options) {
    options = options || {};
    var buffer = (typeof options.buffer === "number") ? options.buffer : 4;
    var maxHeight = options.maxHeight || null;

    // 1. visibility:hidden + height:auto
    dlg.style.visibility = "hidden";
    if (!dlg.style.height) dlg.style.height = "auto";
    if (!dlg.parentNode) document.body.appendChild(dlg);

    // 2. showModal hidden
    dlg.showModal();

    // 3. React render 同步 commit（如提供）
    if (typeof options.reactRenderFn === "function") {
        var ReactDOM = options.ReactDOM
            || (typeof globalThis !== "undefined" ? globalThis.ReactDOM : null);
        if (ReactDOM && typeof ReactDOM.flushSync === "function") {
            ReactDOM.flushSync(options.reactRenderFn);
        } else {
            options.reactRenderFn();
        }
    }

    // 4. 等 paint 落地
    await _waitPaint();

    // 5. measure
    var realH = measureDialogContent(dlg);
    if (maxHeight && realH > maxHeight) realH = maxHeight;

    // 6. close + 100ms 等真正 close
    dlg.close();
    await new Promise(function (r) { setTimeout(r, 100); });

    // 7. pin height + visible
    var pinned = realH + buffer;
    dlg.style.height = pinned + "px";
    dlg.style.visibility = "visible";

    // 8. re-showModal
    dlg.showModal();

    return { measuredHeight: realH, pinnedHeight: pinned };
}

// ---------------------------------------------------------------------------
// reflowDialogHeight — 内容动态变化时（如 React state 改 → render 出更多行）
// 重新测量 + pin 新 height
//
// 用法：在 React state 变化的 effect 中调用，或加 ResizeObserver 自动触发
// ---------------------------------------------------------------------------

async function reflowDialogHeight(dlg, options) {
    options = options || {};
    var buffer = (typeof options.buffer === "number") ? options.buffer : 4;
    var maxHeight = options.maxHeight || null;

    // 释放 height 约束让浏览器重 layout
    var prevHeight = dlg.style.height;
    dlg.style.height = "auto";

    await _waitPaint();

    var realH = measureDialogContent(dlg);
    if (maxHeight && realH > maxHeight) realH = maxHeight;

    dlg.style.height = (realH + buffer) + "px";
    return { measuredHeight: realH, pinnedHeight: realH + buffer, prevHeight: prevHeight };
}

// ---------------------------------------------------------------------------
// applyStandardDialogStyle — 给 dialog 设标准 CSS 防被裁
// 必须的：width 显式、max-width/max-height: none 覆盖 :modal 默认
// 不设 height（让 showModalAutoHeight 测后 pin）
// ---------------------------------------------------------------------------

function applyStandardDialogStyle(dlg, width) {
    dlg.style.width = (width || 480) + "px";
    dlg.style.maxWidth = "none";
    dlg.style.maxHeight = "none";
    if (!dlg.style.height) dlg.style.height = "auto";
}

module.exports = {
    showModalAutoHeight: showModalAutoHeight,
    reflowDialogHeight: reflowDialogHeight,
    measureDialogContent: measureDialogContent,
    applyStandardDialogStyle: applyStandardDialogStyle
};
