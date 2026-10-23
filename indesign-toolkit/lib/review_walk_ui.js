"use strict";

/**
 * lib/review_walk_ui.js — the dialogs of the document eye-check walk (TODO #151): one card per item, the summary,
 * the round picker, the "round is broken" notice. Plain DOM; the `document` is passed in, so the same code runs in
 * the UXP host and in the Chromium check (tests/review_walk_ui_check.js).
 *
 * Each call builds a NEW <dialog> (unique id, CLAUDE.md #14a; stable class `rw-dlg` for existence checks), shows it,
 * and resolves with what the owner did. Closing is the caller's business (closeDialog below), because the walk must
 * wait for app.modalState to read false before it touches the document (#30) — the UI module cannot see `app`.
 *
 * UXP RULES (CLAUDE.md #4 / #13 / #23 / #37 / #38, findings uxp-dialog-webview-api-gaps):
 *   · no <button> (host-drawn widget, CSS and events broken) ⇒ div role=button
 *   · no opacity, transition, animation, inset, flex gap, var(), calc() ⇒ "chosen" = background-color swap (it repaints)
 *   · elements are found by keeping references, never by a descendant selector (#23 silently returns null)
 *   · the box is fixed at showModal (#37): the shell carries an explicit pixel width / height computed BEFORE show,
 *     and every <img> carries its display width / height from the file header, so a late image load cannot get 0
 *   · named CJK family + weight 400 / 700 only (#4: weight 500 splits glyphs on the UA fallback)
 *   · × / Esc RESOLVE the showModal promise (tests/showmodal_close_path_tests.js) ⇒ handled with then(f, f)
 */

var _seq = 0;
// {placeholder} filling, the same as review_round_core.fmt (this module stays free of requires so it loads in a page)
function Core_fmt(t, vars) { return String(t || "").replace(/\{(\w+)\}/g, function (m0, k) { return vars && vars[k] !== undefined ? String(vars[k]) : m0; }); }
var FONT = "'Microsoft YaHei', 'PingFang SC', 'Adobe Clean', sans-serif";
var SHELL_W = 1000;           // the card's width; images fit inside SHELL_W - 2 * PAD
var PAD = 20;
var IMG_MAX_H = 320;          // tallest an image may be shown (two side by side share the width)
var LINE_H = 22;              // body text line height (15px font)
var CHAR_W = 15;              // a CJK character at 15px; Latin is narrower, so this over-estimates (safe)
var LAB_H = 18, SENT_GAP = 8;           // sentence label line, space after a sentence
var PAIR_GAP = 16;                      // space between the before and the after picture (owner 2026-10-22)

function _cls() { return "rw-dlg"; }
function _id() { return "rw-dlg-" + (++_seq) + "-" + Date.now().toString(36); }

var CSS = [
    "dialog.rw-dlg { padding: 0; margin: 0; border: 0; background: #262626; }",
    "dialog.rw-dlg input, dialog.rw-dlg textarea { margin: 0; }",
    ".rw-shell { background: #262626; color: #e8e8e8; font-family: " + FONT + "; font-size: 15px; font-weight: 400; padding: " + PAD + "px; box-sizing: border-box; overflow: hidden; }",
    // UXP's dialog ignores CSS float (host screenshot 2026-10-21: 「之前 / 之后」 ran together as 「之前之后」, the
    // counter and the right-hand buttons stayed left). Left / right is done with flex + space-between, the pattern the
    // export and reorganize dialogs already use on the host (no flex gap: margins instead, CLAUDE.md #13 list).
    ".rw-top { display: flex; justify-content: flex-end; font-size: 13px; color: #a8a8a8; height: 20px; line-height: 20px; white-space: nowrap; overflow: hidden; }",
    ".rw-top-r { margin-left: 16px; }",
    ".rw-title { font-size: 18px; font-weight: 700; line-height: 26px; margin-top: 6px; margin-bottom: 10px; }",
    ".rw-imgs { margin-bottom: 10px; }",
    ".rw-imgcol { display: inline-block; vertical-align: top; margin-right: 12px; }",
    ".rw-imglab { font-size: 13px; color: #a8a8a8; height: 18px; line-height: 18px; white-space: nowrap; text-align: center; }",
    ".rw-imghalf { display: inline-block; text-align: center; }",
    ".rw-img { display: block; border: 1px solid #555555; background: #ffffff; }",
    // the label sits on its own line above its sentence: a label column ran 「遇到的问题」 into its text (host 2026-10-21)
    ".rw-sent { line-height: " + LINE_H + "px; margin-bottom: " + SENT_GAP + "px; }",
    ".rw-lab { display: block; color: #9fc4ff; font-weight: 700; font-size: 13px; line-height: " + LAB_H + "px; height: " + LAB_H + "px; }",
    ".rw-sent-t { display: block; }",
    ".rw-note { background: #4a3b12; color: #ffd98a; line-height: " + LINE_H + "px; padding: 4px 8px; margin-bottom: 6px; }",
    ".rw-target { font-size: 13px; line-height: 20px; color: #a8a8a8; margin-bottom: 10px; }",
    ".rw-target.is-bad { color: #ff9b8a; }",
    ".rw-row { display: flex; justify-content: space-between; align-items: center; height: 34px; margin-bottom: 8px; }",
    ".rw-btn { display: inline-block; height: 32px; line-height: 32px; padding: 0 16px; margin-right: 10px; border: 1px solid #6a6a6a; background: #353535; color: #e8e8e8; cursor: pointer; font-size: 14px; }",
    ".rw-btn.is-on { background: #2f6fd6; border-color: #2f6fd6; color: #ffffff; }",
    ".rw-btn.is-bad.is-on { background: #b4442f; border-color: #b4442f; }",
    ".rw-btn.is-right { margin-right: 0; margin-left: 10px; }",
    ".rw-btn.is-primary { background: #2a5a2a; border-color: #3f8a3f; color: #ffffff; }",
    ".rw-notebox { display: block; width: " + (SHELL_W - 2 * PAD) + "px; height: 54px; box-sizing: border-box; background: #1c1c1c; color: #e8e8e8; border: 1px solid #555555; font-family: " + FONT + "; font-size: 14px; padding: 6px; }",
    ".rw-status { font-size: 12px; line-height: 18px; height: 18px; color: #a8a8a8; margin-bottom: 8px; overflow: hidden; }",
    ".rw-status.is-bad { color: #ff9b8a; }",
    ".rw-list-row { line-height: 26px; height: 26px; padding: 0 8px; cursor: pointer; overflow: hidden; }",
    ".rw-list-row.is-alt { background: #2e2e2e; }",
    ".rw-mark { display: inline-block; width: 64px; font-weight: 700; }",
    ".rw-mark.is-ok { color: #8fd18f; }",
    ".rw-mark.is-bad { color: #ff9b8a; }",
    ".rw-mark.is-none { color: #8a8a8a; }",
    ".rw-err { color: #ff9b8a; line-height: 20px; font-size: 13px; }",
    // the carousel (owner 2026-10-21): one member at a time; the left / right half of the picture = previous / next.
    // Every slide is built before show and switched with display (it repaints; opacity would not, CLAUDE.md #13); the
    // area is as tall as the tallest slide, so the box fixed at showModal() never has to grow (#37). No float (#43).
    ".rw-car { position: relative; margin-bottom: 4px; }",
    ".rw-car-half { position: absolute; top: 0px; cursor: pointer; background-color: transparent; }",
    ".rw-car-half:hover { background-color: rgba(255, 255, 255, 0.10); }",
    ".rw-carbtn.is-arrow { width: 28px; padding: 0px; text-align: center; font-size: 18px; font-weight: 700; }",
    ".rw-undo { font-size: 13px; color: #a8a8a8; line-height: 32px; }",
    ".rw-undo-link { color: #9fc4ff; cursor: pointer; text-decoration: underline; }",
    ".rw-notearea { margin-bottom: 6px; }",
    ".rw-notelabel { font-size: 13px; font-weight: 700; color: #9fc4ff; line-height: 18px; height: 18px; margin-bottom: 4px; }",
    ".rw-carinfo { display: flex; justify-content: space-between; align-items: center; height: 28px; margin-bottom: 8px; font-size: 13px; color: #c8c8c8; }",
    ".rw-carpos { display: inline-block; min-width: 64px; margin: 0px 8px; text-align: center; color: #e8e8e8; }",   // space from ‹ › (owner 2026-10-22, 1a)
    ".rw-carbtn { display: inline-block; height: 24px; line-height: 24px; padding: 0 10px; border: 1px solid #6a6a6a; background: #353535; color: #e8e8e8; cursor: pointer; font-size: 13px; }",
    ".rw-carbtn.is-jump { margin-left: 12px; }"
].join("\n");

function _el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
}
function _btn(doc, text, cls, hook) {
    var b = _el(doc, "div", "rw-btn" + (cls ? " " + cls : ""), text);
    b.setAttribute("role", "button");
    b.setAttribute("tabindex", "0");
    if (hook) b.setAttribute("data-rw", hook);
    return b;
}
function _on(el, fn) {
    el.addEventListener("click", fn);
    el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(e); } });
}
function _lines(text, width) {
    var per = Math.max(1, Math.floor(width / CHAR_W));
    return String(text || "").split(/\n/).reduce(function (n, seg) { return n + Math.max(1, Math.ceil(seg.length / per)); }, 0);
}

/**
 * layoutImages(images, maxW, maxH) → { items (with display w / h), stacked, height }.
 *   images = [{ role, src, w, h }] (w / h = file pixels from the header). One image takes the full width. A before +
 *   after pair sits side by side only if each keeps at least MIN_SIDE_SCALE of its pixels; otherwise the two stack
 *   (before above after), each at the full width. Host 2026-10-20: the importfix alert screenshots (1368–1900 px wide)
 *   came out at ~30 % side by side — the alert text, the very thing the item asks the owner to read, was ~4 px.
 */
// Side by side unless a picture would shrink below MIN_SIDE_SCALE (and stacking makes it ≥ 1.5× bigger). 0.35: the run3
// before / after renders sit at ~38 % side by side and the owner wants them side by side (2026-10-22); the importfix
// alert screenshots (~23–30 %, text unreadable) still stack. Was 0.6 until the pairs became separate pictures.
var MIN_SIDE_SCALE = 0.35;
function _fit(images, each, maxH) {
    return images.map(function (im) {
        var s = Math.min(1, each / im.w, maxH / im.h);
        return { role: im.role, src: im.src, w: Math.max(1, Math.round(im.w * s)), h: Math.max(1, Math.round(im.h * s)), scale: s };
    });
}
function layoutImages(images, maxW, maxH) {
    if (!images || !images.length) return { items: [], stacked: false, height: 0 };
    var ROW = 18 + 2 + 10;                                     // label row + border + margin
    if (images.length === 1) {
        var one = _fit(images, maxW - 2, maxH);
        one[0].cell = one[0].w + 2; delete one[0].scale;
        return { items: one, stacked: false, height: one[0].h + ROW };
    }
    // a before / after pair (owner 2026-10-22): two separate pictures side by side with a gap, each in its own cell, the
    // SAME height; the narrower one centred in its cell. Each picture has a 1px border on both sides (2px).
    var cell = Math.floor((maxW - PAIR_GAP) / 2), inner = cell - 2;
    var H = Math.min(maxH, Math.min.apply(null, images.map(function (im) { return inner * im.h / im.w; })), Math.min.apply(null, images.map(function (im) { return im.h; })));
    var side = images.map(function (im) { var sc = H / im.h; return { role: im.role, src: im.src, w: Math.max(1, Math.round(im.w * sc)), h: Math.max(1, Math.round(H)), scale: sc, cell: cell }; });
    // stack only when it clearly helps (≥ 1.5× bigger): very wide screenshots side by side were ~30 % (host 2026-10-20)
    var full = _fit(images, maxW - 2, maxH);
    if (side.some(function (x, i) { return x.scale < MIN_SIDE_SCALE && full[i].scale >= 1.5 * x.scale; })) {
        full.forEach(function (x) { x.cell = x.w + 2; delete x.scale; });
        return { items: full, stacked: true, height: full.reduce(function (n, x) { return n + x.h + ROW; }, 0) };
    }
    side.forEach(function (x) { delete x.scale; });
    return { items: side, stacked: false, height: Math.round(H) + ROW };
}

/**
 * cardHeight(model) → the pixel height the card needs. Pure (tested): the dialog fixes its box at show, so the
 * height has to be right before anything is drawn.
 */
// The carousel: one slide per member (a single item = one slide). Each slide is laid out like the old image row; the
// area is as tall as the tallest slide. Under it one line: the caption, and for more than one slide the position
// and 「跳到这一处」. Pure (tested).
function layoutSlides(slides, maxW) {
    if (!slides || !slides.length) return { slides: [], areaH: 0, height: 0 };
    var lays = slides.map(function (sl) { return layoutImages(sl.images, maxW, IMG_MAX_H); });
    var areaH = lays.reduce(function (n, l) { return Math.max(n, l.height); }, 0);
    var info = slides.length > 1 || slides.some(function (sl) { return !!sl.caption; });
    return { slides: lays, areaH: areaH, info: info, height: areaH + 4 + (info ? 28 + 8 : 0) };
}

function cardHeight(model) {
    var w = SHELL_W - 2 * PAD;
    var h = PAD * 2 + 20 + 6 + 26 + 10;                                       // counter line + title
    h += layoutSlides(model.slides, w).height;
    (model.sentences || []).forEach(function (p) { h += LAB_H + _lines(p[1], w) * LINE_H + SENT_GAP; });  // label above text
    if (model.note) h += _lines(model.note, w - 16) * LINE_H + 8 + 6;
    if (model.targetBad && model.targetText) h += 20 * _lines(model.targetText, w) + 10;   // only when selecting failed
    h += 42;                                                                 // answer row
    h += 18 + 4 + 54 + 6;                                                    // note label + box (always shown)
    if (model.statusText) h += 18 + 8;                                       // only when saving failed
    h += 42;                                                                 // nav row
    return h + 4;
}

// One slide's pictures: a single picture (之前 / 之后 centred over its halves) or a before / after pair.
function _imageRow(doc, imgs, S) {
    var row = _el(doc, "div", "rw-imgs");
    imgs.items.forEach(function (im, k) {
        var col = _el(doc, "div", "rw-imgcol");
        col.style.width = im.cell + "px";
        col.style.marginRight = (k === imgs.items.length - 1 || imgs.stacked) ? "0px" : PAIR_GAP + "px";
        if (imgs.stacked) { col.style.display = "block"; col.style.marginBottom = "8px"; }
        var lab = _el(doc, "div", "rw-imglab");
        lab.style.width = im.cell + "px";
        if (im.role === "image") {
            var half = Math.floor((im.w + 2) / 2);
            var lb = _el(doc, "span", "rw-imghalf", S.before), la = _el(doc, "span", "rw-imghalf", S.after);
            lb.style.width = half + "px"; la.style.width = (im.w + 2 - half) + "px";
            lb.setAttribute("data-rw", "lab-before"); la.setAttribute("data-rw", "lab-after");
            lab.appendChild(lb); lab.appendChild(la);
        } else lab.textContent = im.role === "before" ? S.before : S.after;
        col.appendChild(lab);
        var img = _el(doc, "img", "rw-img");
        img.setAttribute("data-rw", "img-" + im.role);
        img.width = im.w; img.height = im.h;
        img.style.width = im.w + "px"; img.style.height = im.h + "px";
        img.style.marginLeft = Math.floor((im.cell - im.w - 2) / 2) + "px";   // the narrower picture centred in its cell
        img.src = im.src;
        col.appendChild(img);
        row.appendChild(col);
    });
    return row;
}

function _dialog(doc, shellH) {
    var dlg = _el(doc, "dialog", _cls());
    dlg.id = _id();
    var style = _el(doc, "style");
    style.textContent = CSS;
    dlg.appendChild(style);
    var shell = _el(doc, "div", "rw-shell");
    shell.style.width = SHELL_W + "px";
    shell.style.height = shellH + "px";
    dlg.appendChild(shell);
    return { dlg: dlg, shell: shell };
}

// Show `dlg` and resolve with whatever `settle` was called with, or with `onDismiss()` if × / Esc closed it.
function _show(doc, dlg, wire, onDismiss) {
    return new Promise(function (resolve) {
        var done = false;
        function settle(v) { if (done) return; done = true; try { dlg.close("rw"); } catch (e) {} resolve({ value: v, dlg: dlg }); }
        wire(settle);
        doc.body.appendChild(dlg);
        try {
            var sm = dlg.showModal();
            if (sm && typeof sm.then === "function") sm.then(function () { settle(onDismiss()); }, function () { settle(onDismiss()); });
        } catch (e) { settle({ type: "error", error: String(e && e.message ? e.message : e) }); }
    });
}

/**
 * showItem(doc, model, S) → Promise<{ value: action, dlg }>
 *   model = { title, sentences:[[label, text, hook]], slides:[{ images:[{role,src,w,h}], caption }], current, note, targetText,
 *             targetBad, choices:[{id,label}]|null, verdict, choice, noteText, statusText, statusBad, isFirst, isLast }
 *   action = { type: "next"|"back"|"summary"|"look"|"member"|"close"|"error", verdict, choice, note, index }
 * Reading order (owner 2026-10-22): title → 遇到的问题 / 预期 → picture → position line → answers → navigation.
 */
// handlers.onNote(text): called when typing in the note box pauses (NOTE_IDLE_MS), so the walk can write the note
// to disk while the card is still open — a crash or a killed InDesign cannot take a typed note with it (arch
// 2026-10-21, after the owner's note on a choice item was lost). Optional.
var NOTE_IDLE_MS = 800;
function showItem(doc, model, S, handlers) {
    var built = _dialog(doc, cardHeight(model)), dlg = built.dlg, shell = built.shell;
    var cur = { verdict: model.verdict || null, choice: model.choice || null };
    var choiceCard = !!model.choices;

    // top line: only 「第 4 项 / 共 9 项 · 已答 0」 (the round title stays on the start page)
    var top = _el(doc, "div", "rw-top");
    var counter = _el(doc, "span", "rw-top-r", S.itemLine);
    counter.setAttribute("data-rw", "counter");
    top.appendChild(counter);
    shell.appendChild(top);
    shell.appendChild(_el(doc, "div", "rw-title", model.title));

    (model.sentences || []).forEach(function (p) {
        var r = _el(doc, "div", "rw-sent");
        r.appendChild(_el(doc, "span", "rw-lab", p[0]));
        var t = _el(doc, "span", "rw-sent-t", p[1]);
        t.setAttribute("data-rw", "sent-" + p[2]);   // never the bare field name: "problem" is also the 有问题 button
        r.appendChild(t);
        shell.appendChild(r);
    });
    // the round note: only on the first card of a session (the walk passes it once); the target line only when
    // selecting in the document failed — success is the caption on the position line (owner 2026-10-21)
    if (model.note) { var nt = _el(doc, "div", "rw-note", model.note); nt.setAttribute("data-rw", "round-note"); shell.appendChild(nt); }
    if (model.targetBad && model.targetText) {
        var tg = _el(doc, "div", "rw-target is-bad", model.targetText);
        tg.setAttribute("data-rw", "target");
        shell.appendChild(tg);
    }

    var W = SHELL_W - 2 * PAD, ls = layoutSlides(model.slides, W), slides = model.slides || [], many = slides.length > 1;
    var at = Math.max(0, Math.min(slides.length - 1, model.current || 0));
    var cap = null, pos = null, jump = null, prevBtn = null, nextBtn = null;

    // the picture area: one member at a time, each at the bottom of an area as tall as the tallest member (the
    // box is fixed at showModal, #37). Several members ⇒ two clickable halves (left = previous, right = next); hovering
    // a half brightens it (CSS :hover repaints background-color here — findings #script-dialog-hover-title). The ‹ ›
    // are in the position line under the pictures, not on them. No float (#43), no inset (#38).
    var car = _el(doc, "div", "rw-car"), slideEls = [];
    car.setAttribute("data-rw", "carousel");
    car.style.height = ls.areaH + "px";
    car.style.width = W + "px";
    slides.forEach(function (sl, k) {
        var el = _el(doc, "div", "rw-slide");
        el.setAttribute("data-rw", "slide-" + k);
        el.style.display = k === at ? "block" : "none";
        el.style.height = ls.areaH + "px";
        // bottom-aligned (owner 2026-10-22, 2a): all spare space above, so the position line always sits right under the
        // picture and the ‹ › never move. A pair shares one height (bottoms line up); a stacked pair moves down as one block.
        el.style.paddingTop = (ls.areaH - ls.slides[k].height) + "px";
        el.style.boxSizing = "border-box";
        el.appendChild(_imageRow(doc, ls.slides[k], S));
        car.appendChild(el);
        slideEls.push(el);
    });
    var halfL = null, halfR = null;
    if (many) {
        halfL = _el(doc, "div", "rw-car-half"); halfR = _el(doc, "div", "rw-car-half");
        [[halfL, 0, "car-left", S.carPrevHint], [halfR, Math.floor(W / 2), "car-right", S.carNextHint]].forEach(function (h) {
            var hw = h[1] ? W - h[1] : Math.floor(W / 2);
            h[0].style.left = h[1] + "px"; h[0].style.width = hw + "px"; h[0].style.height = ls.areaH + "px";
            h[0].setAttribute("data-rw", h[2]); h[0].setAttribute("title", h[3] || "");
            car.appendChild(h[0]);
        });
    }
    shell.appendChild(car);

    // the position line right under the pictures (owner 2026-10-22, round 4): caption · 「‹ 第 8 处 / 共 11 处 ›」 ·
    // 「在文档里选中这处」. The jump stays in this line: it acts on the member the line names, next to its number.
    if (ls.info) {
        var info = _el(doc, "div", "rw-carinfo");
        cap = _el(doc, "span", null, (slides[at] && slides[at].caption) || "");
        cap.setAttribute("data-rw", "caption");
        info.appendChild(cap);
        if (many) {
            var right = _el(doc, "div");
            // 「‹ 第 8 处 / 共 11 处 ›」 (owner 2026-10-22: the arrows under the picture, not on it)
            prevBtn = _el(doc, "div", "rw-carbtn is-arrow", "‹"); nextBtn = _el(doc, "div", "rw-carbtn is-arrow", "›");
            [[prevBtn, "car-prev", S.carPrevBtn], [nextBtn, "car-next", S.carNextBtn]].forEach(function (b) {
                b[0].setAttribute("role", "button"); b[0].setAttribute("tabindex", "0"); b[0].setAttribute("data-rw", b[1]); b[0].setAttribute("title", b[2] || "");
            });
            pos = _el(doc, "span", "rw-carpos", Core_fmt(S.carPosition, { k: at + 1, n: slides.length }));
            pos.setAttribute("data-rw", "position");
            jump = _el(doc, "div", "rw-carbtn is-jump", S.carJump);
            jump.setAttribute("role", "button"); jump.setAttribute("tabindex", "0"); jump.setAttribute("data-rw", "jump");
            right.appendChild(prevBtn); right.appendChild(pos); right.appendChild(nextBtn); right.appendChild(jump);
            info.appendChild(right);
        }
        shell.appendChild(info);
    }
    function showSlide(k) {
        var n = slides.length;
        k = ((k % n) + n) % n;                       // wraps: 11 → 1, 1 → 11
        slideEls[at].style.display = "none";
        slideEls[k].style.display = "block";
        at = k;
        if (cap) cap.textContent = slides[at].caption || "";
        if (pos) pos.textContent = Core_fmt(S.carPosition, { k: at + 1, n: n });
    }

    // answers (owner 2026-10-22): a plain card has [对，下一项] (main) and [有问题…]; 有问题… opens a titled note box and
    // the main button becomes [提交，下一项]. A choice card shows its choices (click a chosen one again to take it back)
    // and an always-open note box. 「已答：对 · 撤销」 appears only when the card opens already answered 对.
    var ans = _el(doc, "div", "rw-row"), ansL = _el(doc, "div"), ansR = _el(doc, "div"), btns = [];
    ans.appendChild(ansL); ans.appendChild(ansR);
    var main = null, probBtn = null, undoBox = null;
    function paint() {
        var marked = cur.verdict === "problem";
        btns.forEach(function (b) { b.el.className = "rw-btn" + (cur.verdict === "choice" && cur.choice === b.id ? " is-on" : ""); });
        if (main) main.textContent = marked ? S.submitNext : S.okNext;
        if (probBtn) probBtn.className = "rw-btn is-bad" + (marked ? " is-on" : "");
        if (undoBox) undoBox.style.display = cur.verdict === "ok" ? "inline-block" : "none";
    }
    if (choiceCard) {
        model.choices.forEach(function (c) {
            var b = _btn(doc, c.id + "  " + c.label, null, "choice-" + c.id);
            btns.push({ el: b, id: c.id });
            if (S.toggleHint) b.setAttribute("title", S.toggleHint);
            _on(b, function () {
                if (cur.verdict === "choice" && cur.choice === c.id) { cur.verdict = null; cur.choice = null; }   // click again = take back
                else { cur.verdict = "choice"; cur.choice = c.id; }
                paint();
            });
            ansL.appendChild(b);
        });
    } else {
        main = _btn(doc, S.okNext, "is-primary", "ok-next");
        probBtn = _btn(doc, S.problemOpen, "is-bad", "problem");
        ansL.appendChild(main); ansL.appendChild(probBtn);
        undoBox = _el(doc, "span", "rw-undo");
        undoBox.setAttribute("data-rw", "answered-ok");
        undoBox.appendChild(_el(doc, "span", null, S.answeredOk + " · "));
        var undo = _el(doc, "span", "rw-undo-link", S.undo);
        undo.setAttribute("role", "button"); undo.setAttribute("tabindex", "0"); undo.setAttribute("data-rw", "undo");
        undoBox.appendChild(undo);
        ansR.appendChild(undoBox);
        _on(undo, function () { cur.verdict = null; cur.choice = null; paint(); });
        // 「有问题」 only marks (owner 2026-10-22): click again = take the mark back; the note box is always there
        _on(probBtn, function () {
            cur.verdict = cur.verdict === "problem" ? null : "problem"; cur.choice = null;
            paint();
            if (cur.verdict === "problem") { try { box.focus(); } catch (e) {} }
        });
    }
    shell.appendChild(ans);

    // the note box, always shown (owner 2026-10-22, 2b), with a visible one-line label: a textarea placeholder is NOT
    // drawn in this dialog (host probe 2026-10-22)
    var noteArea = _el(doc, "div", "rw-notearea");
    var nl = _el(doc, "div", "rw-notelabel", choiceCard ? S.note : S.noteProblem);
    nl.setAttribute("data-rw", "note-label");
    noteArea.appendChild(nl);
    var box = _el(doc, "textarea", "rw-notebox");
    box.setAttribute("data-rw", "note");
    box.value = model.noteText || "";
    if (handlers && typeof handlers.onNote === "function") {
        var noteTimer = null, lastSent = box.value;
        box.addEventListener("input", function () {
            if (noteTimer) clearTimeout(noteTimer);
            noteTimer = setTimeout(function () { noteTimer = null; if (box.value !== lastSent) { lastSent = box.value; try { handlers.onNote(box.value); } catch (e) {} } }, NOTE_IDLE_MS);
        });
    }
    noteArea.appendChild(box);
    shell.appendChild(noteArea);
    paint();
    if (model.statusText) {   // only when saving failed: the owner does not need the file path (arch 2026-10-21)
        var status = _el(doc, "div", "rw-status" + (model.statusBad ? " is-bad" : ""), model.statusText);
        status.setAttribute("data-rw", "status");
        shell.appendChild(status);
    }

    // navigation (owner 2026-10-22): [◀ 上一项] [下一项 ▶] … [看汇总] [暂停，回文档看]; 下一项 ▶ = on, keeping whatever the card holds
    var nav = _el(doc, "div", "rw-row"), navL = _el(doc, "div"), navR = _el(doc, "div");
    var back = _btn(doc, S.back, null, "back"), skip = _btn(doc, S.skip, null, "skip");
    var sum = _btn(doc, S.finish, "is-right", "summary"), look = _btn(doc, S.look, "is-right", "look");
    look.setAttribute("title", S.lookHint);
    if (!model.isFirst) navL.appendChild(back);
    navL.appendChild(skip);
    navR.appendChild(sum); navR.appendChild(look);
    nav.appendChild(navL); nav.appendChild(navR);
    shell.appendChild(nav);

    function action(type, index) { return { type: type, verdict: cur.verdict, choice: cur.choice, note: box.value, index: index }; }
    var forward = model.isLast ? "summary" : "next";
    return _show(doc, dlg, function (settle) {
        if (!model.isFirst) _on(back, function () { settle(action("back")); });
        _on(skip, function () { settle(action(forward)); });
        _on(sum, function () { settle(action("summary")); });
        _on(look, function () { settle(action("look")); });
        if (many) {
            _on(halfL, function () { showSlide(at - 1); });
            _on(halfR, function () { showSlide(at + 1); });
            _on(prevBtn, function () { showSlide(at - 1); });
            _on(nextBtn, function () { showSlide(at + 1); });
            // 「在文档里选中这处」: the card closes, the walk selects this member in its document, the same card reopens on it
            _on(jump, function () { settle(action("member", at)); });
        }
        // 「对，下一项」 / 「提交，下一项」: answer and go on
        if (main) _on(main, function () { cur.verdict = cur.verdict === "problem" ? "problem" : "ok"; cur.choice = null; settle(action(forward)); });
    }, function () { return action("close"); });
}

/**
 * showList(doc, spec, S) → Promise<{ value: { type: "pick", index } | { type: "close" }, dlg }>
 *   The summary (rows = items with their marks) and the round picker share this: a heading, lines of text, rows to
 *   click, one close button. spec = { heading, lines:[text], errors:[text], rows:[{ mark, markKind, text }] }
 */
function showList(doc, spec, S) {
    var rows = spec.rows || [], lines = spec.lines || [], errs = spec.errors || [];
    var h = PAD * 2 + 20 + 6 + 26 + 10 + lines.length * LINE_H + errs.length * 20 + Math.min(rows.length, 24) * 26 + 16 + 42;
    var built = _dialog(doc, h), dlg = built.dlg, shell = built.shell;
    shell.appendChild(_el(doc, "div", "rw-top", S.heading));
    shell.appendChild(_el(doc, "div", "rw-title", spec.heading));
    lines.forEach(function (t) { shell.appendChild(_el(doc, "div", "rw-sent", t)); });
    errs.forEach(function (t) { var e = _el(doc, "div", "rw-err", t); e.setAttribute("data-rw", "error"); shell.appendChild(e); });
    var rowEls = [];
    rows.slice(0, 24).forEach(function (r, i) {
        var el = _el(doc, "div", "rw-list-row" + (i % 2 ? " is-alt" : ""));
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.setAttribute("data-rw", "row-" + i);
        if (r.mark !== undefined) el.appendChild(_el(doc, "span", "rw-mark is-" + (r.markKind || "none"), r.mark));
        el.appendChild(_el(doc, "span", null, r.text));
        shell.appendChild(el);
        rowEls.push(el);
    });
    shell.appendChild(_el(doc, "div", "rw-status", rows.length > 24 ? "…" : ""));
    var nav = _el(doc, "div", "rw-row"), close = _btn(doc, S.close, "is-right", "close");
    nav.style.justifyContent = "flex-end";
    nav.appendChild(close);
    shell.appendChild(nav);
    return _show(doc, dlg, function (settle) {
        rowEls.forEach(function (el, i) { _on(el, function () { settle({ type: "pick", index: i }); }); });
        _on(close, function () { settle({ type: "close" }); });
    }, function () { return { type: "close" }; });
}

/**
 * closeDialog(dlg, opts) — close, give the host time to really close it, wait until `isModal()` reads false
 * (the release is not immediate: findings cleanup-state-read-too-early), and only then remove it (#30: removing a
 * shown dialog that is still modal leaves app.modalState stuck at true). Returns { released, polls }.
 * If modalState never releases, the element is NOT removed — it is the only handle left to close it.
 */
async function closeDialog(dlg, opts) {
    opts = opts || {};
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var isModal = opts.isModal || function () { return false; };
    try { dlg.close("rw"); } catch (e) {}
    await sleep(100);
    var polls = 0, max = opts.maxPolls || 40;
    while (isModal() && polls < max) { await sleep(50); polls++; }
    var released = !isModal();
    if (released) { try { dlg.remove(); } catch (e2) {} }
    return { released: released, polls: polls };
}

var ReviewWalkUI = { NOTE_IDLE_MS: NOTE_IDLE_MS, CSS: CSS, layoutSlides: layoutSlides, SHELL_W: SHELL_W, layoutImages: layoutImages, cardHeight: cardHeight, showItem: showItem, showList: showList, closeDialog: closeDialog };
if (typeof module !== "undefined" && module.exports) module.exports = ReviewWalkUI;
if (typeof window !== "undefined") window.ReviewWalkUI = ReviewWalkUI;
