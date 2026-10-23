"use strict";
// eyecheck/core.js — the pure half of the eye-check mode (TODO #144 round 144, arch 2026-10-19, owner option C).
//
// WHAT THE MODE IS: the panel can put a mask over itself, cut a lit frame with a number around the thing a
// checklist item is about, and show a card next to it: what to do, what you should see, why it matters. The owner
// answers OK / Problem (+ a note) per item, and the answers are written to disk for arch to read.
//
// MAINTENANCE CONTRACT (the owner's point):
//   · the checklist is DATA: eyecheck/rounds/<round>.json. A new round = a new file, no component change.
//   · the checklist finds things ONLY through data-eyecheck="<name>" hooks (never a class or a DOM shape).
//     A target may say "name#2" to mean the third element carrying that hook.
//   · this file knows nothing about the font panel. It is plain ES5 so it runs in the UXP host, in Node tests and
//     in the Chromium probe unchanged.
//
// UXP RULES it is written against (CLAUDE.md #4, #13, #23, #38): no selector engine (hooks are found by walking
// getElementsByTagName("*")), rectangles from getBoundingClientRect, no opacity / transition / animation / gap /
// dasharray / inset anywhere that this mode draws (the component and the CSS follow the same list).

var HOOK_ATTR = "data-eyecheck";
var HOOK_RE = /^[a-z0-9][a-z0-9-]*$/;
var ROUND_RE = /^[A-Za-z0-9_-]+$/;

// Chrome strings. A round file may override any of them in `strings` (the owner reads Chinese).
var STRINGS = {
    heading: "眼验",
    item: "第 {n} 项 / 共 {m} 项",
    doLabel: "要做什么",
    expectLabel: "应该看到什么",
    whyLabel: "为什么要看",
    ok: "对",
    problem: "有问题",
    note: "备注（可选）",
    back: "上一项",
    next: "下一项",
    finish: "完成",
    waiting: "等这一步出现：{hooks}",
    missing: "还没出现：{hooks}",
    chooseFirst: "先点「对」或「有问题」",
    savedTo: "结果文件：{path}",
    saveFailed: "写盘失败：{error}",
    tempNote: "（没有文档路径，写在临时目录）",
    doneTitle: "全部看完",
    doneSummary: "共 {m} 项：对 {ok}，有问题 {problem}，已选 {chosen}",
    choose: "请选一个",
    close: "关闭遮罩"
};

function fmt(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m0, k) { return (vars && vars[k] !== undefined) ? String(vars[k]) : m0; });
}

// "name" or "name#3" ⇒ { name, index } (index null = every element with that hook); anything else ⇒ null
function parseTarget(t) {
    if (typeof t !== "string") return null;
    var m = /^([a-z0-9][a-z0-9-]*)(?:#(\d+))?$/.exec(t);
    if (!m) return null;
    return { name: m[1], index: m[2] === undefined ? null : parseInt(m[2], 10) };
}

// A checklist must be complete enough that a card is never empty: id, title, do, expect, why, >=1 target.
function validateRound(round) {
    var errors = [];
    if (!round || typeof round !== "object") return { ok: false, errors: ["round is not an object"] };
    if (typeof round.round !== "string" || !ROUND_RE.test(round.round)) errors.push("round: needs a name of letters, digits, - or _");
    if (!Array.isArray(round.items) || !round.items.length) { errors.push("items: needs at least one item"); return { ok: false, errors: errors }; }
    var seen = {};
    round.items.forEach(function (it, i) {
        var at = "items[" + i + "]";
        if (!it || typeof it !== "object") { errors.push(at + ": not an object"); return; }
        ["id", "title", "do", "expect", "why"].forEach(function (k) {
            if (typeof it[k] !== "string" || !it[k].replace(/\s+/g, "")) errors.push(at + "." + k + ": missing or empty");
        });
        if (typeof it.id === "string") {
            if (seen[it.id]) errors.push(at + ".id: duplicate " + it.id);
            seen[it.id] = true;
        }
        if (!Array.isArray(it.targets) || !it.targets.length) errors.push(at + ".targets: needs at least one hook");
        else it.targets.forEach(function (t, j) { if (!parseTarget(t)) errors.push(at + ".targets[" + j + "]: not a hook name (" + JSON.stringify(t) + ")"); });
        if (it.passThrough !== undefined) {
            // hooks of click-away layers that cover the panel while something is open (a popup list): while one is on
            // screen the mask yields everywhere, so the owner can click away. They are never framed or numbered.
            if (!Array.isArray(it.passThrough)) errors.push(at + ".passThrough: not a list");
            else it.passThrough.forEach(function (t, j) { if (!parseTarget(t)) errors.push(at + ".passThrough[" + j + "]: not a hook name"); });
        }
        if (it.waitFor !== undefined && !(typeof it.waitFor === "string" && parseTarget(it.waitFor))) errors.push(at + ".waitFor: not a hook name");
        if (it.choices !== undefined) {
            // a decision item: instead of OK / Problem the owner picks one of the listed answers (rule choices, not defects)
            if (!Array.isArray(it.choices) || it.choices.length < 2) errors.push(at + ".choices: needs at least two answers");
            else {
                var cs = {};
                it.choices.forEach(function (c, j) {
                    if (!c || typeof c.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(c.id)) errors.push(at + ".choices[" + j + "].id: needs letters / digits");
                    else if (cs[c.id]) errors.push(at + ".choices[" + j + "].id: duplicate " + c.id);
                    else cs[c.id] = true;
                    if (!c || typeof c.label !== "string" || !c.label.replace(/\s+/g, "")) errors.push(at + ".choices[" + j + "].label: missing or empty");
                });
            }
        }
        if (it.testSteps !== undefined) {
            if (!Array.isArray(it.testSteps)) errors.push(at + ".testSteps: not a list");
            else it.testSteps.forEach(function (s, j) { if (!_stepKind(s)) errors.push(at + ".testSteps[" + j + "]: unknown step"); });
        }
    });
    return { ok: errors.length === 0, errors: errors };
}
// testSteps are used by the tests only (what the owner does during the item). The component ignores them.
function _stepKind(s) {
    if (!s || typeof s !== "object") return null;
    if (typeof s.click === "string" && parseTarget(s.click)) return "click";
    if (s.drag && typeof s.drag === "object" && parseTarget(s.drag.hook) && isFinite(s.drag.dx) && isFinite(s.drag.dy)) return "drag";
    if (s.clickAt && typeof s.clickAt === "object" && parseTarget(s.clickAt.hook) && isFinite(s.clickAt.fx) && isFinite(s.clickAt.fy)) return "clickAt";
    if (isFinite(s.wait)) return "wait";
    return null;
}

// every hook a round names (targets + waitFor), as { name: true }
function hooksOf(round) {
    var out = {};
    ((round && round.items) || []).forEach(function (it) {
        (it.targets || []).concat(it.waitFor ? [it.waitFor] : []).concat(it.passThrough || []).forEach(function (t) { var p = parseTarget(t); if (p) out[p.name] = true; });
    });
    return out;
}

// One pass over the tree: { name: [element, ...] } for the wanted hook names. Document order.
function collectHooks(root, names) {
    var want = {}, out = {};
    names.forEach(function (n) { want[n] = true; out[n] = []; });
    if (!root || typeof root.getElementsByTagName !== "function") return out;
    var all = root.getElementsByTagName("*");
    for (var i = 0; i < all.length; i++) {
        var v = all[i].getAttribute ? all[i].getAttribute(HOOK_ATTR) : null;
        if (v && want[v]) out[v].push(all[i]);
    }
    return out;
}
function pickTarget(map, parsed) {
    var list = (map && map[parsed.name]) || [];
    if (parsed.index === null) return list.slice();
    return list[parsed.index] ? [list[parsed.index]] : [];
}

// rectangles relative to `origin` ({left,top}); elements with no area (display:none, detached) are dropped
function relRects(elements, origin) {
    var out = [];
    elements.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (!(r.width > 0.5 || r.height > 0.5)) return;   // no area at all (display:none, detached)
        // a straight line has a box with no height (a horizontal wire): give it a body so it can be framed
        var cx = (r.left + r.right) / 2 - origin.left, cy = (r.top + r.bottom) / 2 - origin.top;
        var w = Math.max(r.width, 8), h = Math.max(r.height, 8);
        out.push({ left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2 });
    });
    return out;
}
function unionRect(rects) {
    if (!rects || !rects.length) return null;
    var u = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    rects.forEach(function (r) {
        if (r.left < u.left) u.left = r.left; if (r.top < u.top) u.top = r.top;
        if (r.right > u.right) u.right = r.right; if (r.bottom > u.bottom) u.bottom = r.bottom;
    });
    return u;
}
function growRect(r, pad) { return { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad }; }
function clipRect(r, w, h) {
    return { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(w, r.right), bottom: Math.min(h, r.bottom) };
}

// The mask is four rectangles around the hole (never one rectangle with a hole in it: no clip-path, no blend).
// They tile the container exactly, so nothing outside the hole is left uncovered and the hole itself is empty.
function maskRects(w, h, hole) {
    var hl = Math.max(0, Math.min(w, hole.left)), hr = Math.max(hl, Math.min(w, hole.right));
    var ht = Math.max(0, Math.min(h, hole.top)), hb = Math.max(ht, Math.min(h, hole.bottom));
    return [
        { name: "top", left: 0, top: 0, width: w, height: ht },
        { name: "bottom", left: 0, top: hb, width: w, height: h - hb },
        { name: "left", left: 0, top: ht, width: hl, height: hb - ht },
        { name: "right", left: hr, top: ht, width: w - hr, height: hb - ht }
    ].filter(function (m) { return m.width > 0 && m.height > 0; });
}

// Where the card goes: right of the hole if it fits, else left, else below, else above, else pinned bottom-right.
// Always clamped inside the container. `card` = { w, h }.
function placeCard(w, h, hole, card, gap) {
    var g = gap === undefined ? 12 : gap;
    function clampX(x) { return Math.max(g, Math.min(w - card.w - g, x)); }
    function clampY(y) { return Math.max(g, Math.min(h - card.h - g, y)); }
    if (!hole) return { left: clampX(w - card.w - g), top: clampY(h - card.h - g), side: "corner" };
    var cy = clampY((hole.top + hole.bottom) / 2 - card.h / 2), cx = clampX((hole.left + hole.right) / 2 - card.w / 2);
    if (hole.right + g + card.w + g <= w) return { left: hole.right + g, top: cy, side: "right" };
    if (hole.left - g - card.w - g >= 0) return { left: hole.left - g - card.w, top: cy, side: "left" };
    if (hole.bottom + g + card.h + g <= h) return { left: cx, top: hole.bottom + g, side: "below" };
    if (hole.top - g - card.h - g >= 0) return { left: cx, top: hole.top - g - card.h, side: "above" };
    return { left: clampX(w - card.w - g), top: clampY(h - card.h - g), side: "corner" };
}

function compactStamp(d) {
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "_" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}
// <docDir>/script_outputs/eyecheck/<round>_<stamp>.json ; no document folder ⇒ the temp dir, and `temp:true` so the
// panel can say so. The name is fixed for one session (the stamp is the START), every save rewrites the same file.
function resultPath(docDir, tempDir, round, stamp) {
    var name = round + "_" + stamp + ".json";
    var base = docDir || tempDir || "";
    var sep = (base.indexOf("\\") >= 0) ? "\\" : "/";
    if (!docDir) return { path: base ? (base.replace(/[\\/]+$/, "") + sep + "eyecheck_" + name) : "eyecheck_" + name, dir: base, temp: true };
    var dir = docDir.replace(/[\\/]+$/, "") + sep + "script_outputs" + sep + "eyecheck";
    return { path: dir + sep + name, dir: dir, temp: false };
}

// The file arch reads: one entry per checklist item (in list order), with the checklist id and a time.
// `answers` = { id: { verdict: "ok"|"problem", note, at } }. An unanswered item is written with verdict null.
function buildResult(round, meta, answers, now) {
    var items = round.items.map(function (it, i) {
        var a = (answers && answers[it.id]) || null;
        return { n: i + 1, id: it.id, title: it.title, verdict: a ? a.verdict : null, choice: a && a.choice ? a.choice : undefined,
            note: a ? (a.note || "") : "", answered_at: a ? a.at : null, missing_hooks: a && a.missing ? a.missing : undefined };
    });
    var ok = 0, problem = 0, chosen = 0;
    items.forEach(function (x) { if (x.verdict === "ok") ok++; else if (x.verdict === "problem") problem++; else if (x.verdict === "choice") chosen++; });
    return {
        round: round.round, round_title: round.title || null, started_at: meta.startedAt, updated_at: now,
        document: meta.document || null, location: meta.location || null,
        summary: { total: items.length, answered: ok + problem + chosen, ok: ok, problem: problem, chosen: chosen },
        items: items
    };
}

var EyeCheckCore = {
    HOOK_ATTR: HOOK_ATTR, STRINGS: STRINGS, fmt: fmt, parseTarget: parseTarget, validateRound: validateRound, hooksOf: hooksOf,
    collectHooks: collectHooks, pickTarget: pickTarget, relRects: relRects, unionRect: unionRect, growRect: growRect, clipRect: clipRect,
    maskRects: maskRects, placeCard: placeCard, compactStamp: compactStamp, resultPath: resultPath, buildResult: buildResult,
    stepKind: _stepKind
};
if (typeof module !== "undefined" && module.exports) module.exports = EyeCheckCore;
if (typeof window !== "undefined") window.EyeCheckCore = EyeCheckCore;
