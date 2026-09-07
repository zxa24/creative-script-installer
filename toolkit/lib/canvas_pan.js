"use strict";

// lib/canvas_pan.js — Pan-by-pointer-drag + programmatic zoom for
// modal <dialog> canvas. UXP idjs/Scripts Panel 上下文 only.
//
// 设计约束（详 findings.md）:
//   - wheel event 在 UXP modal <dialog> 完全不派发（probe 04/05 实测，11
//     binding 全 0；uxp-main docs 也无 wheel mention）→ zoom 只走程序 API
//   - CSS transitions/animations 在 UXP webview 不 supported（uxp-main
//     known-issues line 80）→ setScale 是 instant jump，不能 smooth
//   - Pointer Events 在 modal 内 native addEventListener OK（probe 03 验
//     255 events，probe 06 验 0.05ms avg / 1ms p99 @ 200 nodes）
//   - addEventListener options 只支持 capture（uxp HTMLDialogElement
//     reference line 936），passive 是 no-op
//
// Public API:
//   var ctrl = CanvasPan.attachPan(viewportEl, contentEl, opts);
//   ctrl.zoomIn() / zoomOut() / reset() / setScale(s, anchorX?, anchorY?)
//   ctrl.getState() → { x, y, scale }
//   ctrl.destroy()
//
// viewportEl: 容器, 必须 overflow:hidden + position:relative
// contentEl:  被 transform 的内容, position:absolute top:0 left:0 transform-origin:0 0
// opts:
//   minScale  (default 0.2)
//   maxScale  (default 4)
//   zoomStep  (default 1.2) —— zoomIn/Out 倍数
//   onChange  (default null) —— callback(state) 每次 pan/zoom 触发，
//             用于上游 recomputePorts 等几何相关更新
//   targetFilter (default null) —— (e) => boolean。返 false 时整个 onDown
//             早退（不 preventDefault、不开始 pan），把 pointerdown 让给
//             子元素 click/drag。用来过滤 button/port/grip 等交互目标，避免
//             "点哪都进入 pan 模式" 的吞 click 问题。默认 null 即不过滤
//             （兼容已有 font_mapping_panel 调用）。

function attachPan(viewport, content, opts) {
    opts = opts || {};
    var minScale = (typeof opts.minScale === "number") ? opts.minScale : 0.2;
    var maxScale = (typeof opts.maxScale === "number") ? opts.maxScale : 4;
    var zoomStep = (typeof opts.zoomStep === "number") ? opts.zoomStep : 1.2;
    var onChange = (typeof opts.onChange === "function") ? opts.onChange : null;
    var logger = (typeof opts.logger === "function") ? opts.logger : null;
    var targetFilter = (typeof opts.targetFilter === "function") ? opts.targetFilter : null;

    var state = { x: 0, y: 0, scale: 1 };
    var stats = {
        panEvents: 0,
        totalPanLatency: 0,
        maxPanLatency: 0,
        zoomEvents: 0,
        applyCount: 0,
        lastApply: null
    };

    function apply(source) {
        var t0 = (new Date()).getTime();
        content.style.transformOrigin = "0 0";
        // 用 translate3d 强制 GPU layer compositor，避免 CPU 全 repaint
        // (UXP webview 实测：拖到画面边缘 fps 高 = repaint 跟 pixel 数挂钩)
        var tStr = "translate3d(" + state.x.toFixed(1) + "px," + state.y.toFixed(1) + "px,0) scale(" + state.scale.toFixed(4) + ")";
        content.style.transform = tStr;
        var latency = (new Date()).getTime() - t0;
        stats.applyCount++;
        stats.lastApply = { value: tStr, latency: latency };
        if (logger) {
            try {
                var cs = window.getComputedStyle(content);
                var rect = content.getBoundingClientRect();
                logger("apply[" + (source || "?") + "] set=" + tStr
                    + "  computed.transform='" + cs.transform + "'"
                    + "  computed.transformOrigin='" + cs.transformOrigin + "'"
                    + "  rect=" + Math.round(rect.width) + "x" + Math.round(rect.height)
                    + "  latency=" + latency + "ms");
            } catch (e) {
                logger("apply[" + (source || "?") + "] logger-error: " + e.message);
            }
        }
        if (onChange) {
            try { onChange({ x: state.x, y: state.y, scale: state.scale }); } catch (e) {}
        }
    }
    apply("init");

    var origCursor = viewport.style.cursor;
    viewport.style.cursor = "grab";

    var dragState = null;

    function onDown(e) {
        if (e.button !== 0) return;  // 仅 left button
        // Filter out interactive targets (button / port / grip / input) BEFORE
        // preventDefault — otherwise click handlers downstream are suppressed
        // and "click anywhere starts pan, can't press Done / drag ports".
        if (targetFilter && !targetFilter(e)) return;
        // 不抢 child element 的 pointerdown（如果 child 已 stopPropagation 不会到这）
        dragState = { sx: e.clientX, sy: e.clientY, x0: state.x, y0: state.y };
        try { viewport.setPointerCapture(e.pointerId); } catch (er) {}
        viewport.style.cursor = "grabbing";
        e.preventDefault();
    }
    function onMove(e) {
        if (!dragState) return;
        var t0 = (new Date()).getTime();
        state.x = dragState.x0 + (e.clientX - dragState.sx);
        state.y = dragState.y0 + (e.clientY - dragState.sy);
        apply("pan");
        var latency = (new Date()).getTime() - t0;
        stats.panEvents++;
        stats.totalPanLatency += latency;
        if (latency > stats.maxPanLatency) stats.maxPanLatency = latency;
    }
    function onUp(e) {
        if (!dragState) return;
        try { viewport.releasePointerCapture(e.pointerId); } catch (er) {}
        viewport.style.cursor = "grab";
        dragState = null;
    }

    viewport.addEventListener("pointerdown", onDown);
    viewport.addEventListener("pointermove", onMove);
    viewport.addEventListener("pointerup", onUp);
    viewport.addEventListener("pointercancel", onUp);

    function setScale(newS, anchorX, anchorY) {
        newS = Math.max(minScale, Math.min(maxScale, newS));
        if (Math.abs(newS - state.scale) < 1e-6) return;
        if (typeof anchorX !== "number" || typeof anchorY !== "number") {
            var rect = viewport.getBoundingClientRect();
            anchorX = rect.width / 2;
            anchorY = rect.height / 2;
        }
        var oldS = state.scale;
        // 保持 (anchorX, anchorY) 在 viewport-local screen 同位置
        state.x = anchorX - (anchorX - state.x) * (newS / oldS);
        state.y = anchorY - (anchorY - state.y) * (newS / oldS);
        state.scale = newS;
        stats.zoomEvents++;
        apply("zoom");
    }

    function zoomIn() { setScale(state.scale * zoomStep); }
    function zoomOut() { setScale(state.scale / zoomStep); }
    function reset() {
        state.x = 0; state.y = 0; state.scale = 1;
        apply("reset");
    }

    // TODO#82 — programmatic pan, for edge auto-scroll during a wire drag.
    // 🔴 It goes through the SAME path as reset(): mutate `state`, then apply().
    // Writing `content.style.transform` directly would leave state.x/y at the old
    // values, so the next pointermove would compute its delta from a stale origin
    // and the canvas would jump. That failure does not throw — it looks like the
    // canvas "twitching now and then", which is close to unattributable.
    // (Same shape as #27: a second source of truth for one value.)
    function panBy(dx, dy) {
        var nx = Number(dx), ny = Number(dy);
        if (!isFinite(nx) || !isFinite(ny)) return false;
        if (nx === 0 && ny === 0) return false;
        state.x += nx;
        state.y += ny;
        apply("panBy");
        return true;
    }

    // Exposed so a caller can assert that the reported state and the DOM agree —
    // the whole point of routing through apply() is that they cannot drift, and an
    // assertion is how that stays true rather than being believed.
    function readTransform() {
        try { return String(content.style.transform || ""); } catch (e) { return ""; }
    }

    function destroy() {
        viewport.removeEventListener("pointerdown", onDown);
        viewport.removeEventListener("pointermove", onMove);
        viewport.removeEventListener("pointerup", onUp);
        viewport.removeEventListener("pointercancel", onUp);
        viewport.style.cursor = origCursor;
    }

    function getState() {
        return { x: state.x, y: state.y, scale: state.scale };
    }

    function getStats() {
        return {
            panEvents: stats.panEvents,
            totalPanLatency: stats.totalPanLatency,
            avgPanLatency: stats.panEvents > 0 ? stats.totalPanLatency / stats.panEvents : 0,
            maxPanLatency: stats.maxPanLatency,
            zoomEvents: stats.zoomEvents,
            applyCount: stats.applyCount,
            lastApply: stats.lastApply
        };
    }

    return {
        panBy: panBy,
        readTransform: readTransform,
        setScale: setScale,
        zoomIn: zoomIn,
        zoomOut: zoomOut,
        reset: reset,
        getState: getState,
        getStats: getStats,
        destroy: destroy
    };
}

module.exports = { attachPan: attachPan };
