// import_timing.js — TODO#42-orig「反向的那一半」：选完文件之后那段静默，时间花在哪
//
// ⛔ 仪器，不是功能。它只记时间戳、只写日志；不弹窗、不改任何用户可见行为、不改控制流。
//    每个公开函数都自己吞掉异常 —— 仪器坏了，import 照跑。
//
// ── 为什么要一个独立的时间线，而不是「加几行 plog」────────────────────────
// `import_integrated.idjs` 里 plog 在 `_fsRef` 赋值之后才可用，而选文件 / 解压 / 日志目录解析
// 全在那之前 ⇒ 那一段在那里调 plog 是【静默 no-op】（findings#plog-is-a-silent-noop-before-its-deps，
// 且 tests/import_cancel_silent_tests.js 禁止死窗口里出现 plog）。
// ⇒ 本模块在 picker 返回处就开始记，攒在数组里，等调用方 `attachSink(plog)` 时一次性 flush，
//   之后的每个点直接写。攒着的每一行同时 console.log 一份：死窗口里的早退（zip 解压失败）
//   走不到 attachSink，那种情况至少开着 UDT 控制台时看得见。
//
// ── 模型：顺序打点，一个点结束「上一个点到它」这一段 ─────────────────────
//   mark(label, kind)  ⇒ 一行：elapsed_ms（自上一个点）+ at_ms（自锚点；锚点之前为负）
//   每行都带 from="<上一个点的 label>" —— 某些点在这次运行里没走到（分支跳过）时，
//   下一段会吞掉被跳过的那段；`from` 让这件事【在读数里可见】，⛔ 不靠读者记得分支。
//   整条时间线首尾相接、无缝隙 ⇒ 没有「没被任何一段认领」的时间（这是构造保证，⛔ 不是核出来的）。
//
// ── kind：给 #42 第 1 问「该覆盖哪几段」的分类输入 ────────────────────────
//   compute            屏幕上没有本脚本的窗口，operator 看到的是「什么都没发生」
//   compute_window_up  已经 showModal 了一个窗口，但它还不能交互（字体面板 showModal 之后
//                      还要同步编译三份 JSX —— 同步段期间窗口【可能根本没画出来】，本仪器分不清）
//   interactive        在等 operator（选文件 / 点对话框）—— 这段长 ≠ 卡
//   unsubdivided       ProcessingDialog 出现之后的整段，本线不细分；⚠ 其中可能含交互（Hook B 等）
//
// ── 这把尺子量不到的（读数前先读这段）────────────────────────────────────
//   · 分辨率 = Date.now() 的 1ms；⛔ 别把个位数 ms 的差读成信号。
//   · interactive 段 = 「showModal 调了 → 对话框函数返回」，含窗口【首帧画出】的延迟。
//     「showModal 调了」≠「画出来了」—— 要分开这两件必须上 paint rig（CLAUDE.md #13b），
//     本仪器不假装能分。
//   · sink 每写一行是一次文件 append（日志常在网络盘）⇒ 仪器自己的开销算进了下一段。
//     量级是每点一次小写；若某段读数与点数同阶，先怀疑仪器。
//
// ── 预注册（2026-09-13，写于任何读数出现之前；⛔ 读数出来后不许回头改这一节）───
//   H1 慢在解压：`zip decompress`（纯 JS inflate）或 `zip write entries` 单段占
//      「picker 返回 → 第一个 interactive 段」的大头，且随包大小变化。
//   H2 慢在某个交互窗口【出现之前的准备】：字体面板的 `font enumerate` / `doc scan` /
//      `babel require` / JSX 编译，或 Hook A 的 `scanActiveDoc` 是大段 compute ——
//      表现为 operator 点完上一个对话框后又「卡」一阵才出下一个窗口。
//   H3 慢在 operator 自己：长的全是 interactive 段，compute 合计很小 ⇒「卡」不是在等计算。
//   H4 三者都不是：picker 返回 → ProcessingDialog 这一整段合计很短（几秒以内）⇒ owner 感到的
//      「卡半天」主体不在本线测量的这段：要么在 ProcessingDialog 出现之后（`unsubdivided`
//      那一行），要么在 picker【出现之前】（锚点之前、at_ms 为负的那几行）。
//   ⚠ 相邻已量事实（task_plan.md:1458，一次真实 import 511.68s）⛔ 不作前提 —— 它是 H4 的候选，
//     只有这份读数能判它落在哪一段。

"use strict";

var KINDS = {
    ORIGIN: "origin",
    COMPUTE: "compute",
    COMPUTE_WINDOW_UP: "compute_window_up",
    INTERACTIVE: "interactive",
    UNSUBDIVIDED: "unsubdivided"
};

var TAG = "[import-timing]";

function _pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }

function createTimeline(opts) {
    opts = opts || {};
    var now = (typeof opts.now === "function") ? opts.now : function () { return Date.now(); };
    var mirror = (typeof opts.mirror === "function") ? opts.mirror
        : function (line) { try { console.log(line); } catch (e) {} };

    var marks = [];          // { label, kind, t, detail }
    var anchorT = null;
    var sink = null;
    var pending = [];        // lines rendered before a sink existed

    function _emit(line) {
        if (sink) {
            try { sink(line); } catch (e) {}
        } else {
            pending.push(line);
            try { mirror(line); } catch (e2) {}
        }
    }

    function _row(i) {
        var m = marks[i];
        var prev = i > 0 ? marks[i - 1] : null;
        return TAG + " #" + (i < 10 ? "0" : "") + i + " " + _pad(m.kind, 17)
            + " elapsed_ms=" + _pad(prev ? (m.t - prev.t) : "-", 7)
            + " at_ms=" + _pad(m.t - anchorT, 8)
            + " seg=\"" + m.label + "\""
            + (prev ? " from=\"" + prev.label + "\"" : "")
            + (m.detail ? " | " + m.detail : "");
    }

    function mark(label, kind, detail) {
        try {
            marks.push({ label: String(label), kind: kind || KINDS.COMPUTE, t: now(),
                         detail: (detail == null) ? "" : String(detail) });
            // at_ms needs the anchor. Rows before it are held and rendered by anchor(),
            // so every printed at_ms is against ONE base.
            if (anchorT !== null) _emit(_row(marks.length - 1));
        } catch (e) {}
    }

    // Anchor = at_ms zero: the moment the most recent mark was taken. Call it right after
    // the mark that ends the picker segment. Held rows are rendered now, with negative at_ms.
    function anchor() {
        try {
            if (anchorT !== null || !marks.length) return;
            anchorT = marks[marks.length - 1].t;
            for (var i = 0; i < marks.length; i++) _emit(_row(i));
        } catch (e) {}
    }

    function attachSink(fn) {
        try {
            if (typeof fn !== "function" || sink) return;
            sink = fn;
            var lines = pending; pending = [];
            for (var i = 0; i < lines.length; i++) { try { sink(lines[i]); } catch (e) {} }
        } catch (e2) {}
    }

    // Totals per kind over [anchor, last mark].
    // ⚠ No "sum == span" check here on purpose: consecutive differences telescope, so that
    // identity holds by construction and a check on it could never fail (CLAUDE.md #28 —
    // a control that cannot fail is not a control). What CAN go wrong is the clock itself
    // (Date.now is wall time; a system clock adjustment mid-import makes a segment negative
    // and silently shifts the totals) — that is counted and printed.
    function summarize(title) {
        var out = { byKind: {}, spanMs: 0, sumMs: 0, longest: null, negativeSegments: 0 };
        try {
            if (anchorT === null) { _emit(TAG + " summary(" + title + "): no anchor — nothing measured after the picker"); return out; }
            for (var i = 1; i < marks.length; i++) {
                var m = marks[i], prev = marks[i - 1];
                if (prev.t < anchorT) continue;           // segment began before the anchor
                var d = m.t - prev.t;
                if (d < 0) out.negativeSegments++;
                out.byKind[m.kind] = (out.byKind[m.kind] || 0) + d;
                out.sumMs += d;
                if (!out.longest || d > out.longest.ms) out.longest = { ms: d, label: m.label, kind: m.kind };
            }
            out.spanMs = marks[marks.length - 1].t - anchorT;
            var parts = [];
            for (var k in out.byKind) {
                if (Object.prototype.hasOwnProperty.call(out.byKind, k)) parts.push(k + "=" + out.byKind[k]);
            }
            _emit(TAG + " summary(" + title + "): span_ms=" + out.spanMs
                + (out.negativeSegments ? " CLOCK WENT BACKWARDS in " + out.negativeSegments
                    + " segment(s) - totals are not trustworthy" : "")
                + " | " + (parts.join(" ") || "(no segments after anchor)")
                + (out.longest ? " | longest=\"" + out.longest.label + "\" " + out.longest.kind + " " + out.longest.ms + "ms" : ""));
        } catch (e) {}
        return out;
    }

    return {
        mark: mark,
        anchor: anchor,
        attachSink: attachSink,
        summarize: summarize,
        _marks: function () { return marks.slice(); }
    };
}

module.exports = { createTimeline: createTimeline, KINDS: KINDS, TAG: TAG };
