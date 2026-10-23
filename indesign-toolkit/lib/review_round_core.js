"use strict";

/**
 * lib/review_round_core.js — the pure half of the document eye-check walk (TODO #151, owner 2026-10-20).
 *
 * WHAT THE WALK IS: review_walk.idjs takes one round (a folder holding round.json + images), shows the items one
 * at a time — before / after image, one sentence on the situation, one on what was done — selects the item's target
 * object in its document, and records the owner's answer. This file is everything that does not touch the host:
 * round validation, image header sizes, the answer file and where a resumed walk starts.
 *
 * CONTRACT
 *   · A round is DATA. The script never names a round, a document or an item (arch 2026-10-20).
 *   · Every validation error says WHICH item and WHICH field ("items[3] growth-p1-553 · situation: missing"), so
 *     whoever writes a round can fix it without reading this file.
 *   · The answer file keeps the field names of emphrel's #150 panel eye-check (verdict / choice / note / answered_at /
 *     summary), so arch reads both with one reader. Fields #150 does not have (target_check, docs, orphans,
 *     resume_id) are additions, never renames.
 *   · Answers are never dropped: an answer whose item left the round (or whose choice was removed) moves to
 *     `orphans`, with the text it had.
 *
 * Plain ES5 + no requires, so it loads unchanged in the UXP host and in Node tests.
 */

var ROUND_RE = /^[A-Za-z0-9_-]+$/;
var ID_RE = /^[A-Za-z0-9_-]+$/;
var IMAGE_RE = /\.(png|jpe?g)$/i;
var ITEM_KEYS = { id: 1, title: 1, caption: 1, rule: 1, group: 1, rep: 1, flag: 1, problem: 1, expect: 1, situation: 1, done: 1, image: 1, before: 1, after: 1, target: 1, choices: 1 };
var TARGET_KEYS = { doc: 1, page: 1, frame: 1, story: 1, para: 1 };
var ROUND_KEYS = { round: 1, title: 1, note: 1, groups: 1, items: 1, strings: 1 };
// Groups (owner 2026-10-21: 「只给我看不同的、真要我看的」; design approved by arch the same day). A round may list
// groups: { key: { title, problem, expect, note?, auto_pass? } } and mark members with "group": key. A group is ONE
// card: the representative large (the member with "rep": true, else the first), the others as thumbnails; one answer
// is written to every member. Never grouped: items with choices or "flag": true (they need the owner on their own).
// auto_pass: { evidence, compared } = arch / a worker compared it with an approved reference (CLAUDE.md #42); the
// group gets no card, only a one-line pass, and its rows carry auto_pass — `verdict` stays the human's answer only.
var GROUP_KEYS = { title: 1, rule: 1, problem: 1, expect: 1, note: 1, auto_pass: 1 };
// caption: the short line under the picture ("Product-7 · 第 2 页"); rule: the rule code (④, ⑩ …) kept in the data
// for arch, never on the card (owner 2026-10-21: titles carry no rule codes).
var VERDICTS = { ok: 1, problem: 1, choice: 1 };

// Chrome strings; a round may override any of them in `strings` (unknown keys are refused, a typo would be silent).
var STRINGS = {
    heading: "眼验",
    item: "第 {n} 项 / 共 {m} 项 · 已答 {a}",
    problemLabel: "遇到的问题",
    expectLabel: "预期",
    situationLabel: "什么情况",
    doneLabel: "做了什么",
    carPosition: "第 {k} 处 / 共 {n} 处",
    carJump: "在文档里选中这处",
    carPrevHint: "点左半：上一处",
    carPrevBtn: "上一处",
    carNextBtn: "下一处",
    carNextHint: "点右半：下一处",
    groupCount: "{n} 处",
    autoPassLine: "{n} 处与认可样一致（机器比对，不用看）：{titles}",
    before: "之前",
    after: "之后",
    ok: "对",
    problem: "有问题",
    note: "备注（可选：为什么这样选，或看到了什么）",
    noteProblem: "备注（选了「有问题」时，写下看到了什么）",
    back: "◀ 上一项",
    skip: "下一项 ▶",   // owner 2026-10-22: it keeps the card as it is (was 「跳过 ▶」)
    finish: "看汇总",
    look: "暂停，回文档看",
    lookHint: "进度保留，再双击脚本从这一项接着",
    okNext: "对，下一项",
    problemOpen: "有问题",
    submitNext: "提交，下一项",
    answeredOk: "已答：对",
    undo: "撤销",
    chooseFirst: "先点「对」/「有问题」或选一个选项",
    targetSelected: "已在文档里选中：{doc} 第 {page} 页 {what}",
    targetMissing: "没能选中目标：{reason}",
    targetNone: "这一项没有文档里的对象。",
    savedTo: "回答写在：{path}",
    saveFailed: "写盘失败：{error}",
    doneTitle: "全部看完",
    doneSummary: "共 {m} 项：对 {ok}，有问题 {problem}，已选 {chosen}，未答 {left}",
    close: "关闭",
    pickRound: "选一轮",
    noRounds: "{dir} 里没有轮次（每轮一个文件夹，里面放 round.json）",
    roundBroken: "这一轮的 round.json 有问题，没法开始：",
    answersBroken: "answers.json 读不了，没有动它：{error}",
    toggleHint: "再点一次可撤销"
};

function fmt(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m0, k) { return (vars && vars[k] !== undefined) ? String(vars[k]) : m0; });
}
function strings(round) {
    var out = {}, k;
    for (k in STRINGS) out[k] = STRINGS[k];
    var o = round && round.strings;
    if (o && typeof o === "object") for (k in o) if (STRINGS.hasOwnProperty(k) && typeof o[k] === "string") out[k] = o[k];
    return out;
}
function _nonEmpty(s) { return typeof s === "string" && s.replace(/\s+/g, "") !== ""; }
function _isAbs(p) { return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^\//.test(p); }
function _isPosInt(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n && n > 0; }
function _isNonNegInt(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n && n >= 0; }

// An image path in a round is relative to the round folder unless it is absolute.
function resolvePath(roundDir, p) {
    if (_isAbs(p)) return p;
    var base = String(roundDir || "").replace(/[\\/]+$/, "");
    var sep = base.indexOf("\\") >= 0 ? "\\" : "/";
    return base + sep + String(p).replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep);
}

// The image fields of an item, as [{ role: "image"|"before"|"after", path }] in display order.
function imagesOf(item) {
    var out = [];
    if (!item) return out;
    if (item.image !== undefined) out.push({ role: "image", path: item.image });
    if (item.before !== undefined) out.push({ role: "before", path: item.before });
    if (item.after !== undefined) out.push({ role: "after", path: item.after });
    return out;
}
// Every image path a round names, resolved — the host checks these for existence before calling validateRound
// (UXP's fs.statSync answers "missing" for files that exist, CLAUDE.md #26-补, so the check is injected).
function imagePaths(round, roundDir) {
    var out = [];
    ((round && round.items) || []).forEach(function (it) {
        imagesOf(it).forEach(function (im) { if (typeof im.path === "string" && im.path) out.push(resolvePath(roundDir, im.path)); });
    });
    return out;
}

/**
 * validateRound(round, opts) → { ok, errors: [string] }
 *   opts.roundDir  folder of round.json (for relative image paths)
 *   opts.exists    function(absPath) → true / false; omitted ⇒ existence is not checked (said so in `unchecked`)
 *   opts.imageSize function(absPath) → {w,h} | null; omitted ⇒ format is judged by extension only
 */
function validateRound(round, opts) {
    opts = opts || {};
    var errors = [];
    if (!round || typeof round !== "object" || Array.isArray(round)) return { ok: false, errors: ["round.json: not an object"] };
    Object.keys(round).forEach(function (k) { if (!ROUND_KEYS[k] && k.charAt(0) !== "_") errors.push("round." + k + ": unknown field"); });
    if (typeof round.round !== "string" || !ROUND_RE.test(round.round)) errors.push("round: needs a name of letters, digits, - or _");
    if (round.title !== undefined && !_nonEmpty(round.title)) errors.push("title: empty");
    if (round.note !== undefined && typeof round.note !== "string") errors.push("note: not text");
    if (round.strings !== undefined) {
        if (!round.strings || typeof round.strings !== "object") errors.push("strings: not an object");
        else Object.keys(round.strings).forEach(function (k) {
            if (!STRINGS.hasOwnProperty(k)) errors.push("strings." + k + ": unknown string");
            else if (typeof round.strings[k] !== "string") errors.push("strings." + k + ": not text");
        });
    }
    if (!Array.isArray(round.items) || !round.items.length) { errors.push("items: needs at least one item"); return { ok: false, errors: errors }; }
    var groups = round.groups, members = {};
    if (groups !== undefined) {
        if (!groups || typeof groups !== "object" || Array.isArray(groups)) { errors.push("groups: not an object"); groups = {}; }
        else Object.keys(groups).forEach(function (k) {
            var g = groups[k], gf = "groups." + k;
            members[k] = [];
            if (!ID_RE.test(k)) errors.push(gf + ": key needs letters, digits, - or _");
            if (!g || typeof g !== "object" || Array.isArray(g)) { errors.push(gf + ": not an object"); return; }
            Object.keys(g).forEach(function (f) { if (!GROUP_KEYS[f] && f.charAt(0) !== "_") errors.push(gf + "." + f + ": unknown field"); });
            ["title", "problem", "expect"].forEach(function (f) { if (!_nonEmpty(g[f])) errors.push(gf + "." + f + ": missing or empty"); });
            if (g.auto_pass !== undefined) {
                var ap = g.auto_pass;
                if (!ap || typeof ap !== "object" || !_nonEmpty(ap.evidence) || !_nonEmpty(ap.compared)) errors.push(gf + ".auto_pass: needs evidence (path) and compared (what was compared)");
                else if (opts.exists && !opts.exists(resolvePath(opts.roundDir, ap.evidence))) errors.push(gf + ".auto_pass.evidence: file not found (" + resolvePath(opts.roundDir, ap.evidence) + ")");
            }
        });
    } else groups = {};
    var seen = {};
    round.items.forEach(function (it, i) {
        var at = "items[" + i + "]" + (it && typeof it.id === "string" && it.id ? " " + it.id : "");
        if (!it || typeof it !== "object" || Array.isArray(it)) { errors.push(at + ": not an object"); return; }
        Object.keys(it).forEach(function (k) { if (!ITEM_KEYS[k] && k.charAt(0) !== "_") errors.push(at + " · " + k + ": unknown field"); });
        if (typeof it.id !== "string" || !ID_RE.test(it.id)) errors.push(at + " · id: needs letters, digits, - or _");
        else { if (seen[it.id]) errors.push(at + " · id: duplicate"); seen[it.id] = true; }
        if (!_nonEmpty(it.title)) errors.push(at + " · title: missing or empty");
        if (it.flag !== undefined && typeof it.flag !== "boolean") errors.push(at + " · flag: true or false");
        if (it.caption !== undefined && !_nonEmpty(it.caption)) errors.push(at + " · caption: empty");
        if (it.rule !== undefined && !_nonEmpty(it.rule)) errors.push(at + " · rule: empty");
        if (it.rep !== undefined && it.rep !== true) errors.push(at + " · rep: only true");
        // the two sentences (owner 2026-10-21): 遇到的问题 (problem) + 预期 (expect). Rounds written before that say
        // 什么情况 (situation) + 做了什么 (done) and are still read as they are — never both pairs in one item.
        var oldPair = it.situation !== undefined || it.done !== undefined, newPair = it.problem !== undefined || it.expect !== undefined;
        if (it.group !== undefined) {
            // a member takes its group's sentences; its own would never be shown, so they are refused
            if (typeof it.group !== "string" || !members[it.group]) errors.push(at + " · group: not a key of round.groups (" + JSON.stringify(it.group) + ")");
            else members[it.group].push(it);
            if (oldPair || newPair) errors.push(at + " · group: a group member has no sentences of its own (they come from groups." + it.group + ")");
            if (it.choices !== undefined) errors.push(at + " · group: an item with choices is never grouped (it needs a decision of its own)");
            if (it.flag === true) errors.push(at + " · group: a flagged item is never grouped (it needs the owner on its own)");
        } else {
            if (it.rep !== undefined) errors.push(at + " · rep: only on a group member");
            if (oldPair && newPair) errors.push(at + " · problem/expect: use problem + expect (or the older situation + done), not both pairs");
            else (oldPair ? ["situation", "done"] : ["problem", "expect"]).forEach(function (k) { if (!_nonEmpty(it[k])) errors.push(at + " · " + k + ": missing or empty"); });
        }

        // images: one side-by-side picture, or a before AND an after — never a mix, never none
        var ims = imagesOf(it);
        var hasCombined = it.image !== undefined, hasPair = it.before !== undefined || it.after !== undefined;
        if (!ims.length) errors.push(at + " · image: needs \"image\" (one side-by-side picture) or \"before\" + \"after\"");
        else if (hasCombined && hasPair) errors.push(at + " · image: use \"image\" OR \"before\"+\"after\", not both");
        else if (hasPair && (it.before === undefined || it.after === undefined)) errors.push(at + " · " + (it.before === undefined ? "before" : "after") + ": missing (a pair needs both)");
        ims.forEach(function (im) {
            var f = at + " · " + im.role;
            if (!_nonEmpty(im.path)) { errors.push(f + ": empty path"); return; }
            if (!IMAGE_RE.test(im.path)) { errors.push(f + ": not a .png / .jpg (" + im.path + ")"); return; }
            var abs = resolvePath(opts.roundDir, im.path);
            if (opts.exists && !opts.exists(abs)) { errors.push(f + ": file not found (" + abs + ")"); return; }
            if (opts.imageSize && !opts.imageSize(abs)) errors.push(f + ": not a readable PNG / JPEG (" + abs + ")");
        });

        if (it.target !== undefined) _validateTarget(it.target, at, errors);
        if (it.choices !== undefined) {
            if (!Array.isArray(it.choices) || it.choices.length < 2) errors.push(at + " · choices: needs at least two");
            else {
                var cs = {};
                it.choices.forEach(function (c, j) {
                    var cf = at + " · choices[" + j + "]";
                    if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) errors.push(cf + ".id: needs letters / digits");
                    else if (cs[c.id]) errors.push(cf + ".id: duplicate " + c.id);
                    else cs[c.id] = true;
                    if (!c || !_nonEmpty(c.label)) errors.push(cf + ".label: missing or empty");
                });
            }
        }
    });
    Object.keys(members).forEach(function (k) {
        var ms = members[k];
        if (ms.length < 2) errors.push("groups." + k + ": needs at least two members (has " + ms.length + ")");
        if (ms.filter(function (m) { return m.rep === true; }).length > 1) errors.push("groups." + k + ": more than one member with rep: true");
    });
    return { ok: errors.length === 0, errors: errors, unchecked: opts.exists ? [] : ["image files were not checked for existence"] };
}

/**
 * unitsOf(round) → { units: [{ key, group, items, rep }], auto: [{ key, group, items }] }
 *   A unit is one card: a single item (key null) or a group, placed where its first member stands. Groups with
 *   auto_pass get no card (they are listed in `auto`). Assumes a validated round.
 */
function unitsOf(round) {
    var groups = round.groups || {}, units = [], auto = [], byKey = {};
    round.items.forEach(function (it) {
        if (it.group === undefined) { units.push({ key: null, group: null, items: [it], rep: 0 }); return; }
        var u = byKey[it.group];
        if (!u) {
            u = byKey[it.group] = { key: it.group, group: groups[it.group], items: [], rep: 0 };
            (groups[it.group] && groups[it.group].auto_pass ? auto : units).push(u);
        }
        if (it.rep === true) u.rep = u.items.length;
        u.items.push(it);
    });
    return { units: units, auto: auto };
}
// Where a walk opens, counted in cards: the card holding the item the owner left from, else the first card with an
// unanswered member, else the summary (units.length). Returns { index, member }.
function unitStart(units, state) {
    var rid = state && state.resume_id;
    if (rid) for (var i = 0; i < units.length; i++) for (var j = 0; j < units[i].items.length; j++) if (units[i].items[j].id === rid) return { index: i, member: j };
    for (var k = 0; k < units.length; k++) if (units[k].items.some(function (it) { return !isAnswered(state, it.id); })) return { index: k, member: units[k].rep };
    return { index: units.length, member: 0 };
}
// What a card shows as already answered: the verdict / choice when every member has the same one, else nothing
// (a mixed group shows no answer, and leaving it untouched changes nothing). The note: the first non-empty one.
function unitAnswer(state, unit) {
    var first = state.answers[unit.items[0].id] || null, same = !!(first && first.verdict);
    unit.items.forEach(function (it) { var a = state.answers[it.id]; if (!a || !first || a.verdict !== first.verdict || a.choice !== first.choice) same = false; });
    var note = "";
    unit.items.forEach(function (it) { var a = state.answers[it.id]; if (!note && a && a.note) note = a.note; });
    return { verdict: same ? first.verdict : null, choice: same ? first.choice : null, note: note };
}

function _validateTarget(t, at, errors) {
    var f = at + " · target";
    if (!t || typeof t !== "object" || Array.isArray(t)) { errors.push(f + ": not an object"); return; }
    Object.keys(t).forEach(function (k) { if (!TARGET_KEYS[k]) errors.push(f + "." + k + ": unknown field (doc / page / frame / story / para)"); });
    if (typeof t.doc !== "string" || !_isAbs(t.doc) || !/\.indd$/i.test(t.doc)) errors.push(f + ".doc: needs an absolute path to a .indd");
    if (!_nonEmpty(typeof t.page === "number" ? String(t.page) : t.page)) errors.push(f + ".page: missing (the page name as InDesign shows it, e.g. \"1\")");
    var hasFrame = t.frame !== undefined, hasStory = t.story !== undefined || t.para !== undefined;
    if (hasFrame && hasStory) errors.push(f + ": frame OR story+para, not both");
    else if (!hasFrame && !hasStory) errors.push(f + ": needs frame (an id) or story + para");
    else if (hasFrame) { if (!_isPosInt(t.frame)) errors.push(f + ".frame: needs a positive whole number (the frame id)"); }
    else {
        if (!_isPosInt(t.story)) errors.push(f + ".story: needs a positive whole number (the story id)");
        if (!_isNonNegInt(t.para)) errors.push(f + ".para: needs a whole number ≥ 0 (paragraph number in the story, from 0)");
    }
}

// ── image headers ────────────────────────────────────────────────────────────────────────────────────────────
// The dialog fixes its box at showModal() (CLAUDE.md #37): an <img> that loads afterwards gets 0 height. So the
// display size is computed from the file header BEFORE show and written on the element.
function imageSize(bytes) {
    if (!bytes || bytes.length < 24) return null;
    var b = bytes;
    // PNG: 89 50 4E 47 0D 0A 1A 0A, then the IHDR chunk: width / height as big-endian uint32 at 16 / 20
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
        var w = ((b[16] << 24) >>> 0) + (b[17] << 16) + (b[18] << 8) + b[19];
        var h = ((b[20] << 24) >>> 0) + (b[21] << 16) + (b[22] << 8) + b[23];
        return (w > 0 && h > 0) ? { w: w, h: h, type: "png" } : null;
    }
    // JPEG: walk the segments to the first start-of-frame (C0–CF, except C4 / C8 / CC)
    if (b[0] === 0xFF && b[1] === 0xD8) {
        var i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xFF) return null;
            var m = b[i + 1];
            if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
            var len = (b[i + 2] << 8) + b[i + 3];
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
                var jh = (b[i + 5] << 8) + b[i + 6], jw = (b[i + 7] << 8) + b[i + 8];
                return (jw > 0 && jh > 0) ? { w: jw, h: jh, type: "jpeg" } : null;
            }
            if (len < 2) return null;
            i += 2 + len;
        }
    }
    return null;
}
// bytes → base64, for a data: URL (no btoa assumed in the UXP script context).
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes) {
    var out = [], i, n = bytes.length;
    for (i = 0; i + 2 < n; i += 3) {
        var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out.push(B64.charAt(v >> 18 & 63) + B64.charAt(v >> 12 & 63) + B64.charAt(v >> 6 & 63) + B64.charAt(v & 63));
    }
    if (n - i === 1) { var a = bytes[i] << 16; out.push(B64.charAt(a >> 18 & 63) + B64.charAt(a >> 12 & 63) + "=="); }
    else if (n - i === 2) { var b = (bytes[i] << 16) | (bytes[i + 1] << 8); out.push(B64.charAt(b >> 18 & 63) + B64.charAt(b >> 12 & 63) + B64.charAt(b >> 6 & 63) + "="); }
    return out.join("");
}
function dataUrl(bytes, type) { return "data:image/" + (type === "jpeg" ? "jpeg" : "png") + ";base64," + toBase64(bytes); }

// Scale (w,h) to fit inside (maxW,maxH), never up. Whole pixels.
function fitSize(w, h, maxW, maxH) {
    var s = Math.min(1, maxW / w, maxH / h);
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ── answers ──────────────────────────────────────────────────────────────────────────────────────────────────
// FNV-1a 32-bit of the round text: tells arch which version of round.json the answers belong to.
function roundHash(text) {
    var h = 0x811c9dc5;
    var s = String(text);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 0x01000193) : (h * 0x01000193) | 0; }
    return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}

/**
 * loadState(round, prev, now) → { state } | { error }
 *   prev = the parsed answers.json of an earlier walk, or null. A file of ANOTHER round is refused (never merged).
 *   Answers are matched by item id. An answer whose item left the round, or whose choice no longer exists, moves to
 *   `orphans` (kept, with its text) and the item counts as unanswered again.
 */
function loadState(round, prev, now) {
    var state = { started_at: now, sessions: 1, answers: {}, orphans: [], resume_id: null, docs: [] };
    if (!prev) return { state: state };
    if (typeof prev !== "object" || !Array.isArray(prev.items)) return { error: "answers.json has no items list" };
    if (prev.round !== round.round) return { error: "answers.json belongs to round \"" + prev.round + "\", not \"" + round.round + "\"" };
    state.started_at = prev.started_at || now;
    state.sessions = (prev.sessions | 0) + 1;
    state.orphans = Array.isArray(prev.orphans) ? prev.orphans.slice() : [];
    state.docs = Array.isArray(prev.docs) ? prev.docs.slice() : [];
    var byId = {};
    round.items.forEach(function (it) { byId[it.id] = it; });
    prev.items.forEach(function (p) {
        if (!p) return;
        // no verdict: unanswered, or answered then cleared by clicking the chosen button again. A note written on it
        // is kept (owner 2026-10-21: the note survives a deselect); the item still counts as unanswered.
        if (!p.verdict) {
            if (byId[p.id] && (p.note || p.cleared_at)) state.answers[p.id] = { verdict: null, note: p.note || "", at: null, cleared_at: p.cleared_at || null, target_check: p.target_check };
            return;
        }
        var it = byId[p.id];
        var reason = null;
        if (!it) reason = "item no longer in the round";
        else if (p.verdict === "choice" && !(it.choices || []).some(function (c) { return c.id === p.choice; })) reason = "choice " + p.choice + " no longer offered";
        else if (p.verdict === "choice" && !it.choices) reason = "item no longer has choices";
        else if (p.verdict !== "choice" && it.choices) reason = "item now asks for a choice";
        if (reason) {
            state.orphans.push({ id: p.id, title: p.title, verdict: p.verdict, choice: p.choice, note: p.note || "", answered_at: p.answered_at || null, orphaned_at: now, reason: reason });
            return;
        }
        state.answers[p.id] = { verdict: p.verdict, choice: p.choice, note: p.note || "", at: p.answered_at || null, target_check: p.target_check };
    });
    if (typeof prev.resume_id === "string" && byId[prev.resume_id]) state.resume_id = prev.resume_id;
    return { state: state };
}

// Where a walk opens: the item the owner left from to look at the document, else the first unanswered item, else
// the summary (index = items.length).
function startIndex(round, state) {
    var items = round.items;
    if (state && state.resume_id) for (var i = 0; i < items.length; i++) if (items[i].id === state.resume_id) return i;
    for (var j = 0; j < items.length; j++) if (!isAnswered(state, items[j].id)) return j;
    return items.length;
}

// Record (or replace) an answer. Returns null when accepted, else why not — the dialog shows it and keeps the item.
function recordAnswer(round, state, id, ans, now) {
    var it = null;
    round.items.forEach(function (x) { if (x.id === id) it = x; });
    if (!it) return "unknown item " + id;
    if (!ans || !VERDICTS[ans.verdict]) return "verdict must be ok / problem / choice";
    if (it.choices && ans.verdict !== "choice") return "this item asks for a choice";
    if (!it.choices && ans.verdict === "choice") return "this item has no choices";
    if (ans.verdict === "choice" && !it.choices.some(function (c) { return c.id === ans.choice; })) return "unknown choice " + ans.choice;
    var prev = state.answers[id];
    state.answers[id] = { verdict: ans.verdict, choice: ans.verdict === "choice" ? ans.choice : undefined, note: String(ans.note || ""),
        at: now, target_check: ans.target_check !== undefined ? ans.target_check : (prev ? prev.target_check : undefined) };
    return null;
}
// The short line under a picture: the item's own caption, else "<document> · 第 n 页" from its target, else nothing.
function captionOf(item) {
    if (_nonEmpty(item.caption)) return item.caption;
    if (!item.target) return "";
    var doc = String(item.target.doc).replace(/^.*[\\/]/, "").replace(/\.indd$/i, "").replace(/\.translated$/i, "");
    return doc + " · 第 " + item.target.page + " 页";
}

// The two sentences of a card, with their labels: [[label, text, field], [label, text, field]].
function sentencesOf(item, S) {
    if (item.situation !== undefined || item.done !== undefined) return [[S.situationLabel, item.situation, "situation"], [S.doneLabel, item.done, "done"]];
    return [[S.problemLabel, item.problem, "problem"], [S.expectLabel, item.expect, "expect"]];
}

/**
 * setDraftNote — a note on an item with no verdict (never answered, or taken back). Saved like any answer
 * (arch 2026-10-21: a note on a never-answered item must reach answers.json); the item stays unanswered.
 * An emptied note on an item that was never answered removes the row's entry again.
 */
function setDraftNote(state, id, note) {
    var a = state.answers[id];
    if (a && a.verdict) { a.note = String(note || ""); return; }
    if (note) state.answers[id] = { verdict: null, note: String(note), at: null, cleared_at: a ? a.cleared_at || null : null, target_check: a ? a.target_check : undefined };
    else if (a) { if (a.cleared_at) a.note = ""; else delete state.answers[id]; }
}

// An item counts as answered only with a verdict: a cleared item (note kept, verdict null) is unanswered.
function isAnswered(state, id) { var a = state && state.answers[id]; return !!(a && a.verdict); }
function answeredCount(state) { return Object.keys((state && state.answers) || {}).filter(function (id) { return isAnswered(state, id); }).length; }

/**
 * clearAnswer — the owner clicked the already-chosen button again (owner 2026-10-21: 「加一个再点击按钮撤销选中的逻辑」;
 * a misclick had recorded "OK" for an item he had not checked). Verdict and choice go back to null, answered_at to
 * null, the note stays, and cleared_at says when — written to answers.json like any answer.
 * Returns null when cleared, else why not.
 */
function clearAnswer(state, id, now) {
    var a = state.answers[id];
    if (!a || !a.verdict) return "not answered";
    state.answers[id] = { verdict: null, note: a.note || "", at: null, cleared_at: now, target_check: a.target_check };
    return null;
}
// A note can change without a verdict (typed, then the owner went back): keep it on the answer if there is one.
function setNote(state, id, note) { if (state.answers[id]) state.answers[id].note = String(note || ""); }
// The outcome of resolving / selecting an item's target, kept even before the owner answers.
function setTargetCheck(state, id, check) {
    state.checks = state.checks || {};
    state.checks[id] = check;
    if (state.answers[id]) state.answers[id].target_check = check;
}
// The document list: one entry per path, first sighting wins for modified_before / opened_by_script.
function noteDoc(state, rec) {
    for (var i = 0; i < state.docs.length; i++) if (state.docs[i].path === rec.path) {
        if (rec.modified_after !== undefined) state.docs[i].modified_after = rec.modified_after;
        return state.docs[i];
    }
    state.docs.push(rec);
    return rec;
}

// The file arch reads. Items in round order; an unanswered item is written with verdict null.
function buildAnswerFile(round, meta, state, now) {
    var ok = 0, problem = 0, chosen = 0, autoPass = 0, groups = round.groups || {};
    var items = round.items.map(function (it, i) {
        var a = state.answers[it.id] || null;
        var tc = a && a.target_check !== undefined ? a.target_check : (state.checks && state.checks[it.id]);
        if (a && a.verdict === "ok") ok++; else if (a && a.verdict === "problem") problem++; else if (a && a.verdict === "choice") chosen++;
        var row = { n: i + 1, id: it.id, title: it.title, verdict: a ? a.verdict : null, note: a ? (a.note || "") : "", answered_at: a ? a.at : null };
        if (a && !a.verdict && a.cleared_at) row.cleared_at = a.cleared_at;
        if (a && a.verdict === "choice") { row.choice = a.choice; (it.choices || []).forEach(function (c) { if (c.id === a.choice) row.choice_label = c.label; }); }
        if (it.target) row.target = it.target;
        if (tc !== undefined) row.target_check = tc;
        if (it.group !== undefined) {
            row.group = it.group;
            var ap = groups[it.group] && groups[it.group].auto_pass;
            if (ap) { row.auto_pass = { evidence: ap.evidence, compared: ap.compared }; autoPass++; }
        }
        return row;
    });
    return {
        round: round.round, round_title: round.title || null, round_hash: meta.roundHash || null, round_file: meta.roundFile || null,
        started_at: state.started_at, updated_at: now, sessions: state.sessions, resume_id: state.resume_id || null,
        summary: { total: items.length, answered: ok + problem + chosen, ok: ok, problem: problem, chosen: chosen, auto_pass: autoPass },
        items: items, orphans: state.orphans, docs: state.docs,
        // set when a card did not release app.modalState and the walk stopped (review_walk_flow); arch must see it
        host_warning: state.host_warning || null
    };
}

function answersPath(roundDir) {
    var base = String(roundDir || "").replace(/[\\/]+$/, "");
    return base + (base.indexOf("\\") >= 0 ? "\\" : "/") + "answers.json";
}

// ── target check (pure judgement over what the host read back) ───────────────────────────────────────────────
/**
 * judgeTarget(target, rb) → { found, selected, page_shown, reason }
 *   rb = { found, foundReason, selection: [{ id, kind, storyId, start, end }], objectPage, activePage,
 *          targetStart, targetEnd }   (all as read on the host after selecting)
 * selected: a frame target ⇒ the selection is exactly that one frame; a paragraph target ⇒ the selection is text
 * of that story whose range covers the paragraph. page_shown: the window's active page is the target's page AND the
 * object really sits on that page (a round that names the wrong page is reported, not hidden).
 */
function judgeTarget(target, rb) {
    if (!rb || !rb.found) return { found: false, selected: false, page_shown: false, reason: (rb && rb.foundReason) || "not found" };
    var sel = rb.selection || [];
    var selected = false, why = [];
    if (target.frame !== undefined) {
        selected = sel.length === 1 && sel[0].id === target.frame;
        if (!selected) why.push("selection is " + (sel.length ? sel.map(function (s) { return s.kind + " " + s.id; }).join(", ") : "empty") + ", not frame " + target.frame);
    } else {
        var s0 = sel.length === 1 ? sel[0] : null;
        selected = !!(s0 && s0.storyId === target.story && typeof s0.start === "number" && s0.start <= rb.targetStart && s0.end >= rb.targetEnd);
        if (!selected) why.push("selection does not cover story " + target.story + " paragraph " + target.para);
    }
    var want = String(target.page);
    var onPage = rb.objectPage !== undefined && rb.objectPage !== null && String(rb.objectPage) === want;
    var shown = rb.activePage !== undefined && rb.activePage !== null && String(rb.activePage) === want;
    if (!onPage) why.push("object is on page " + rb.objectPage + ", round says " + want);
    if (!shown) why.push("window shows page " + rb.activePage);
    return { found: true, selected: selected, page_shown: onPage && shown, reason: why.length ? why.join("; ") : null };
}

var ReviewRoundCore = {
    STRINGS: STRINGS, fmt: fmt, strings: strings, resolvePath: resolvePath, imagesOf: imagesOf, imagePaths: imagePaths,
    validateRound: validateRound, captionOf: captionOf, unitsOf: unitsOf, unitStart: unitStart, unitAnswer: unitAnswer, imageSize: imageSize, fitSize: fitSize, roundHash: roundHash, toBase64: toBase64, dataUrl: dataUrl,
    loadState: loadState, startIndex: startIndex, recordAnswer: recordAnswer, clearAnswer: clearAnswer, setDraftNote: setDraftNote, sentencesOf: sentencesOf, isAnswered: isAnswered, answeredCount: answeredCount, setNote: setNote, setTargetCheck: setTargetCheck,
    noteDoc: noteDoc, buildAnswerFile: buildAnswerFile, answersPath: answersPath, judgeTarget: judgeTarget
};
if (typeof module !== "undefined" && module.exports) module.exports = ReviewRoundCore;
if (typeof window !== "undefined") window.ReviewRoundCore = ReviewRoundCore;
