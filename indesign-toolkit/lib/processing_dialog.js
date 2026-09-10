"use strict";

/**
 * lib/processing_dialog.js
 *
 * UXP HTML 非模态"处理中"提示框：消息 + 动态省略号 + 进度条。
 *
 * 为什么用 dialog.show()（非模态）而不是 showModal()：
 *   2026-05-28 probe (20260528_02 / 20260528_03 / 20260528_07) 验证：
 *     - showModal() 阻塞 InDesign DOM 部分操作（doc.close 抛
 *       "Cannot handle the request because a modal dialog or alert is active"）
 *     - show() 不阻塞 doc.add / doc.close / doc.save 等 InDesign DOM 调用
 *
 * Public API:
 *   show(message) → controller {
 *     update(msg, percent?)    — 改文字；percent 0-100 时把进度条移到该位置
 *     close()                  — 关闭弹窗（关之前自动推到 100%）
 *   }
 *
 * 用法：
 *   var p = ProcessingDialog.show("Importing translation package");
 *   try {
 *     p.update("Applying translations to paragraphs", 35);
 *     ... work ...
 *     p.update("Running frame repair", 83);
 *     ... work ...
 *   } finally {
 *     p.close();
 *   }
 *
 * 已知限制（probe 09 / 10 验证、5/28 真实 import 复现）：
 *   sync app.doScript(fn, ENTIRE_SCRIPT) 期间 V8 事件循环全停 ——
 *   setInterval / 进度条 transition / CSS keyframe / DOM patch 全排队。
 *   dialog 在这种长 sync 块（典型：v2_pipeline 内部 commit 阶段 ~40s）
 *   期间看起来"假死"是结构性限制，不是 UI bug。caller 进 sync 块前应
 *   update 到"约一半"位置 + 诚实文案告知用户"期间不动"。
 */

// TODO#50 (2026-08-14, HWND-measured): the NATIVE shell freezes at show()-time
// layout (+16x39 chrome) and NEVER follows later reflows — content growing past
// the frozen shell gets CLIPPED (probe 20260814_02: 124px content in a 94px
// shell = 30px cut), content shrinking leaves the gray ring the owner reported.
// Explicit size set BEFORE show() drives the shell exactly (P4: 576x259 =
// 560x220+chrome). So: FIXED dialog size, content fills it, messages wrap
// inside it. Size is derived from the LONGEST enumerated production message
// ("Applying translations + style cleanup (InDesign busy ~50s, no progress
// shown)", 79 chars → 2 lines at 368px inner width; line 18px) — enumeration
// in DEV_LOG 2026-08-14 #50. Change a message beyond ~2 lines → revisit height.
var DLG_W = 420, DLG_H = 116;
// TODO#50 round 2 (2026-08-14, probe 20260814_06 R1/R2 判别): the persistent
// plugin context KEEPS a native-shell registration per dialog id — ghost shells
// from earlier closed dialogs get REUSED when a later dialog shows with the
// SAME id, and a corrupted registration reproduces its broken geometry
// (measured: id "proc-dlg" -> 6339x128 desktop-wide strip; identical code under
// a fresh id -> correct 436x155). So every show() uses a UNIQUE id; the stable
// class "proc-dlg" is the existence-check hook (DOM-presence checks must query
// the class, never a fixed id).
var _dlgSeq = 0;
function _buildStyles(id) {
    return [
    '#' + id + ' {',
    '  padding: 0; border: 1px solid #494949;',
    '  width: ' + DLG_W + 'px; height: ' + DLG_H + 'px; box-sizing: border-box;',
    '  background: #1f1f1f; color: #e6e6e6; color-scheme: dark;',
    '}',
    '#' + id + ' .body { font-family: "Adobe Clean", sans-serif; padding: 22px 26px;',
    '  height: 100%; box-sizing: border-box; overflow: hidden; }',
    '#' + id + ' h3 { margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #f0f0f0; }',
    '#' + id + ' .msg {',
    '  font-size: 12px; color: #c8c8c8; display: flex; align-items: center;',
    '  min-height: 18px;',
    '}',
    '#' + id + ' .dots { display: inline-block; width: 24px; margin-left: 2px; color: #2680eb; font-weight: 600; }',
    '#' + id + ' .progress-track {',
    '  height: 4px; background: #393939; border-radius: 2px;',
    '  margin-top: 12px; overflow: hidden;',
    '}',
    '#' + id + ' .progress-fill {',
    '  height: 100%; background: #2680eb;',
    '  width: 0%; transition: width 250ms ease;',
    '}'
    ].join("\n");
}

function show(message) {
    if (typeof document === "undefined") {
        return { update: function () {}, close: function () {} };
    }

    // unique id per show (see the round-2 note above); stable class for checks
    var id = "proc-dlg-" + (++_dlgSeq) + "-" + Date.now().toString(36);
    var dlg = document.createElement("dialog");
    dlg.id = id;
    dlg.className = "proc-dlg";
    dlg.innerHTML = '<style>' + _buildStyles(id) + '</style>'
        + '<div class="body">'
        + '  <h3>Processing</h3>'
        + '  <div class="msg"><span id="' + id + '-msg"></span><span class="dots" id="' + id + '-dots"></span></div>'
        + '  <div class="progress-track"><div class="progress-fill" id="' + id + '-fill"></div></div>'
        + '</div>';
    document.body.appendChild(dlg);

    var msgEl = dlg.querySelector("#" + id + "-msg");
    var dotsEl = dlg.querySelector("#" + id + "-dots");
    var fillEl = dlg.querySelector("#" + id + "-fill");
    if (msgEl) msgEl.textContent = String(message || "Working");

    // TODO#50: belt-and-braces — inline size BEFORE show() (the shell freezes at
    // show()-time layout; CSS width/height above should suffice, inline makes it
    // independent of stylesheet timing).
    try { dlg.style.width = DLG_W + "px"; dlg.style.height = DLG_H + "px"; } catch (eSz) {}
    // 非模态显示
    try { dlg.show(); } catch (e) {}

    // 动态省略号（仅 dots，去掉了 elapsed/ETA — 在 sync doScript 期间
    // setInterval 本身也被阻塞，elapsed 永远显示为最后一次回调的值，
    // 加上去反而误导用户）
    var dotCount = 0;
    var iv = null;
    try {
        iv = setInterval(function () {
            dotCount = (dotCount + 1) % 4;
            if (dotsEl) {
                var s = "";
                for (var i = 0; i < dotCount; i++) s += ".";
                dotsEl.textContent = s;
            }
        }, 400);
    } catch (eI) {}

    var closed = false;
    return {
        update: function (newMessage, percent) {
            if (closed) return;
            try { if (typeof newMessage === "string" && msgEl) msgEl.textContent = newMessage; } catch (e) {}
            if (typeof percent === "number" && isFinite(percent)) {
                var p = Math.max(0, Math.min(100, percent));
                try { if (fillEl) fillEl.style.width = p + "%"; } catch (eF) {}
            }
        },
        close: function () {
            if (closed) return;
            closed = true;
            try { if (iv) clearInterval(iv); } catch (e) {}
            // 收尾推到 100% 给用户最后视觉反馈
            try { if (fillEl) fillEl.style.width = "100%"; } catch (eF) {}
            try { dlg.close(); } catch (e) {}
            try { dlg.remove(); } catch (e) {}
        }
    };
}

module.exports = {
    show: show
};
