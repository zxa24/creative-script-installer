"use strict";

/**
 * lib/host_env_guard.js — host 环境护栏：进场自检 + 作用域式偏好开关
 *
 * 治的病（2026-08-07 实测·见 findings.md#adobe-fonts-auto-activation-jams-the-task-queue）：
 * 打开一个字体来自 `Document fonts/` 的文档、却没带那个文件夹 → InDesign 向
 * Adobe Fonts 请求自动激活 → 若该字体不在 Adobe Fonts（如授权字库 Dax Pro），
 * 请求**永不返回** → 后台任务卡在 RUNNING → 队列越堆越长（实测堆到 550 条、
 * 16 分钟零变化）。**卡死的任务无法被脚本取消**（`cancel`/`suspend`/`resume`
 * 在活任务上全是 `undefined`，只有 `waitForTask` 存在）→ 唯一解法是重启 InDesign。
 *
 * 所以本模块两件事：
 *   1. `findStuckFontActivations` —— 进场自检。已经堵了就**大声拒绝开跑**，
 *      而不是一头扎进去（因为跑完也救不回来，只能重启）。
 *   2. `withSafeHostEnv` —— 作用域式关掉自动激活 + 压交互，`finally` 恢复。
 *      **只在我们自动跑的时候关**，不改 user 交互使用时的行为。
 *
 * 与 design-intent §8 同向：自动激活是一种**静默兜底**（背地里替我们补字体），
 * 而管线立场是「config 权威·缺则显式·NO fallback」。关掉它之后，缺字体从
 * 「挂起一个永不返回的后台任务」变成「`doc.fonts` 里一条 NOT_AVAILABLE」——
 * 一个可读、可当闸的信号。
 *
 * 纯度：所有 host 对象经参数注入（app / indesign），故 Node 侧可用 mock 测。
 */

// ---------------------------------------------------------------------------
// 判据基线（2026-08-07 实测·跑之前量的，不是事后凑的）
// ---------------------------------------------------------------------------
// 0 doc、刚重启          backgroundTasks.length = 0
// 1 doc 刚开             = 22   （Check Links ×4 RUNNING + 内部绘制任务）
// 1 doc 开完 ~30s        = 0    （正常排空）
// 堵塞态                 = 550  （4 条 Adding Font 卡 RUNNING，16 分钟零变化）
//
// ⇒ **判据不能是任务总数**：正常开一个文档就有 22 条，几十秒排空；546 条内部
//   绘制任务会把信号完全淹掉。判据必须是「`Adding Font` 卡在 RUNNING」。
//   （这个仓在「诊断字段没量过正常值就当闸」上已经栽过五次，见
//   findings.md#pipeline-hard-gate-must-attach-to-the-save-gate 的配套资产表。）

var FONT_TASK_NAME = "Adding Font";
var DEFAULT_CONFIRM_MS = 1200;

/**
 * _tallyTasks — 单次采样。
 *
 * ⚠ `app.backgroundTasks` 是**活集合**：任务会在迭代过程中完成并从集合里消失。
 * 写成 `for (i = 0; i < bt.length; i++)` 会让 `bt.length` 每轮重算 → 集合缩短时
 * 循环**提前退出**，量出来的数比真实值少（实测：total 报 22，只遍历到 5 条就停了）。
 * 所以**先把 length 固定下来**再循环，并对已消失的项做容错。
 */
function _tallyTasks(app) {
    var out = { total: 0, byName: {}, byStatus: {}, fontTasks: [] };
    if (!app || !app.backgroundTasks) return out;
    var bt = app.backgroundTasks;
    var n = bt.length;            // ← 固定，别在循环条件里重算
    out.total = n;
    for (var i = 0; i < n; i++) {
        var name = "(gone)", status = "(gone)", id = null;
        try {
            var t = bt.item(i);
            // UXP enum 不能用 === 比（每次访问新建 wrapper）→ 一律 stringify 取尾段。
            // 见 CLAUDE.md「UXP host 对象不可 === 比较」。
            name = String(t.name);
            status = String(t.status).split(".").pop();
            id = t.id;
        } catch (e) { /* 迭代期间任务完成并消失 —— 容错，不让自检自己抛 */ }
        out.byName[name] = (out.byName[name] || 0) + 1;
        out.byStatus[status] = (out.byStatus[status] || 0) + 1;
        if (name === FONT_TASK_NAME && status === "RUNNING") {
            out.fontTasks.push({ id: id, status: status });
        }
    }
    return out;
}

/**
 * findStuckFontActivations — 两次采样，取交集。
 *
 * 为什么要两次：一个**正在正常进行**的字体激活也短暂处于 RUNNING。单次采样
 * 区分不了「正在激活」和「永远激活不完」。两次采样之间仍是同一个 id 且仍
 * RUNNING → 判定卡死。（实测卡死的那批 id 1013/1014/1015/1085 跨 40 分钟不变。）
 *
 * @param {Object} app          注入的 InDesign app
 * @param {Object} [opts]       { confirmMs, sleep } —— sleep 可注入，便于 Node 测
 * @returns {{stuck: Array, sampleA: Object, sampleB: Object, jammed: boolean}}
 */
function findStuckFontActivations(app, opts) {
    opts = opts || {};
    var confirmMs = (typeof opts.confirmMs === "number") ? opts.confirmMs : DEFAULT_CONFIRM_MS;
    var a = _tallyTasks(app);
    if (a.fontTasks.length === 0) {
        // 快路：一条都没有就不必等第二次采样
        return { stuck: [], sampleA: a, sampleB: null, jammed: false };
    }
    if (typeof opts.sleep === "function") { opts.sleep(confirmMs); }
    else { var t0 = Date.now(); while (Date.now() - t0 < confirmMs) { /* busy-wait：UXP 无同步 sleep */ } }
    var b = _tallyTasks(app);
    var bIds = {};
    for (var i = 0; i < b.fontTasks.length; i++) { bIds[String(b.fontTasks[i].id)] = true; }
    var stuck = [];
    for (var j = 0; j < a.fontTasks.length; j++) {
        var id = String(a.fontTasks[j].id);
        if (bIds[id]) stuck.push(a.fontTasks[j]);
    }
    return { stuck: stuck, sampleA: a, sampleB: b, jammed: stuck.length > 0 };
}

/**
 * formatJamReport — 给 operator 看的话，不是给日志看的。
 * 明说「必须重启」，因为脚本救不了（无 cancel 接口）。
 */
function formatJamReport(res) {
    if (!res || !res.jammed) return "";
    var ids = [];
    for (var i = 0; i < res.stuck.length; i++) ids.push(res.stuck[i].id);
    return "InDesign 的后台任务队列已被卡死的字体激活堵住："
        + res.stuck.length + " 个「" + FONT_TASK_NAME + "」任务停在 RUNNING（id "
        + ids.join(", ") + "），队列共 " + res.sampleA.total + " 条。\n"
        + "原因：某个文档缺字体 → InDesign 向 Adobe Fonts 请求自动激活 → 该字体不在 "
        + "Adobe Fonts 上 → 请求永不返回。\n"
        + "⚠ 脚本无法取消后台任务（DOM 没有 cancel 接口）——**请重启 InDesign 后再跑**。";
}

/**
 * withSafeHostEnv — 作用域式压交互 + 关自动激活，finally 必恢复。
 *
 * 承 findings.md:244「worker host 脚本务必 finally 恢复 userInteractionLevel」，
 * 同一个模式加一个字段：`app.fontSyncPreferences.autoActivateFont`
 * （DOM 文档 FontSyncPreference·**单数 Font**·Boolean·实测可读可写）。
 *
 * 容错：老版本 InDesign 若没有 fontSyncPreferences，静默跳过该项（不抛），
 * 但**照常压 userInteractionLevel** —— 少一层防护好过整个入口挂掉。
 *
 * @param {Object} app        注入的 app
 * @param {Object} indesign   注入的 indesign 模块（取 UserInteractionLevels）
 * @param {Function} fn       要跑的东西
 * @returns fn 的返回值
 */
function withSafeHostEnv(app, indesign, fn) {
    var prevUIL = null, hadUIL = false;
    var prevAuto = null, hadAuto = false;
    try {
        try {
            prevUIL = app.scriptPreferences.userInteractionLevel;
            hadUIL = true;
            app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT;
        } catch (e1) { hadUIL = false; }
        try {
            var fsp = app.fontSyncPreferences;
            if (fsp && typeof fsp.autoActivateFont === "boolean") {
                prevAuto = fsp.autoActivateFont;
                hadAuto = true;
                fsp.autoActivateFont = false;
            }
        } catch (e2) { hadAuto = false; }
        return fn();
    } finally {
        // 恢复顺序与设置相反；每项各自 try，一项失败不能连累另一项
        if (hadAuto) { try { app.fontSyncPreferences.autoActivateFont = prevAuto; } catch (e3) {} }
        if (hadUIL) { try { app.scriptPreferences.userInteractionLevel = prevUIL; } catch (e4) {} }
    }
}

module.exports = {
    findStuckFontActivations: findStuckFontActivations,
    formatJamReport: formatJamReport,
    withSafeHostEnv: withSafeHostEnv,
    FONT_TASK_NAME: FONT_TASK_NAME,
    _internal: { _tallyTasks: _tallyTasks }
};
