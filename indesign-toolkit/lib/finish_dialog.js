"use strict";

/**
 * lib/finish_dialog.js — TODO #153: the window the import ends with (replaces the native "Import v2" alert).
 * It only DRAWS what lib/finish_problems.buildWindow built and calls back for [Show]; it decides nothing about what is a problem.
 *
 *   showFinishWindow({ win, showTarget(target) -> Promise<{ok, reason}>, log }) -> Promise<{ closedBy: "done" | "closed" }>
 *
 * Why this shape (host readings 2026-10-20 / 21):
 *   - A UXP <dialog>, not app.dialogs: the native alert drops the bridge while it is open.
 *   - NON-MODAL (dialog.show(), like ProcessingDialog): selecting and turning the page work while it is open, app.modalState stays
 *     false, so [Show] navigates with the window up and the window stays.
 *   - Unique id per show + stable class "fin-dlg" (CLAUDE.md #14a); content is built BEFORE show() (#37: the shell is sized at show time,
 *     so the body scrolls inside a fixed height); close() then a turn of the event loop then remove() (findings: dialog.close() is not sync).
 *   - A script cannot open a browser or a file from this host (openPath rejects every extension, openExternal rejects https and file,
 *     no clipboard; probe 2026-10-21): [How to fix] EXPANDS its steps in place and shows the docs address as selectable text;
 *     [Open report] reveals the report path as selectable text. Nothing here pretends to open anything.
 */

function esc(s) { return String(s == null ? "" : s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;"); }
var _seq = 0;
var FOOTER_H = 52;   // the footer (Done) stays outside the scrolling area, always visible

function css(id) {
    var q = "#" + id;
    return [
        q + " { padding: 0; border: 1px solid #494949; background: #1f1f1f; color: #e6e6e6; color-scheme: dark; max-width: none; max-height: none; }",
        q + " .fin-body { font-family: 'Adobe Clean', sans-serif; box-sizing: border-box; background: #1f1f1f; }",
        q + " .fin-scroll { box-sizing: border-box; padding: 18px 22px 0 22px; overflow-y: auto; }",
        q + " h2 { margin: 0 0 10px 0; font-size: 15px; font-weight: 600; color: #f0f0f0; }",
        q + " h3 { margin: 14px 0 4px 0; font-size: 13px; font-weight: 600; color: #f5a142; }",
        q + " p { margin: 3px 0 6px 0; font-size: 12px; color: #c8c8c8; }",
        q + " .fin-row { display: flex; align-items: center; margin: 3px 0; font-size: 12px; }",
        q + " .fin-page { width: 34px; color: #9b9b9b; }",
        q + " .fin-text { flex: 1; color: #e6e6e6; overflow: hidden; }",
        q + " .fin-status { width: 150px; margin-left: 8px; color: #9b9b9b; font-size: 11px; }",
        q + " .fin-fix { margin: 6px 0 4px 0; padding: 8px 10px; background: #2a2a2a; }",
        q + " .fin-fix p { color: #e6e6e6; }",
        q + " .fin-copy { width: 100%; box-sizing: border-box; padding: 4px 6px; font-size: 11px; background: #151515; color: #e6e6e6; border: 1px solid #494949; }",
        q + " .fin-footer { box-sizing: border-box; padding: 12px 22px; text-align: right; border-top: 1px solid #333; }",
        q + " button { margin-left: 8px; padding: 4px 12px; font-size: 12px; }"
    ].join(" ");
}

function heightFor(win) {
    var h = 150, g = win.groups || [];
    for (var i = 0; i < g.length; i++) h += 110 + 30 * (g[i].rows || []).length + (g[i].howToFix ? 20 : 0);
    if (win.reportPath) h += 30;
    return Math.max(230, Math.min(660, h));
}

function build(win, id) {
    var h = [];
    h.push("<style>" + css(id) + "</style>");
    var total = heightFor(win);
    h.push('<div class="fin-body" style="width:560px;height:' + total + 'px">');
    h.push('<div class="fin-scroll" style="height:' + (total - FOOTER_H) + 'px">');
    h.push("<h2>" + esc(win.title) + "</h2>");
    (win.groups || []).forEach(function (g, gi) {
        h.push('<div class="fin-group" data-g="' + gi + '">');
        h.push("<h3>" + esc(g.heading) + "</h3>");
        h.push("<p>" + esc(g.consequence) + "</p>");
        (g.rows || []).forEach(function (r, ri) {
            h.push('<div class="fin-row">'
                + '<span class="fin-page">' + (r.page ? "p" + esc(r.page) : "") + "</span>"
                + '<span class="fin-text">' + esc(r.text) + "</span>"
                + '<span class="fin-status" data-s="' + gi + ":" + ri + '"></span>'
                + (r.target ? '<button type="button" class="fin-show" data-g="' + gi + '" data-r="' + ri + '">Show</button>' : "")
                + "</div>");
        });
        h.push("<p>" + esc(g.advice) + (g.howToFix ? ' <button type="button" class="fin-howto" data-g="' + gi + '">' + esc(g.howToFix.label) + "</button>" : "") + "</p>");
        if (g.howToFix) {
            h.push('<div class="fin-fix" data-f="' + gi + '" style="display:none">'
                + (g.howToFix.steps || []).map(function (s) { return "<p>" + esc(s) + "</p>"; }).join("")
                + "<p>More in the docs (select and copy):</p>"
                + '<input type="text" readonly class="fin-copy" value="' + esc(g.howToFix.url) + '" />'
                + "</div>");
        }
        h.push("</div>");
    });
    if (win.reportPath) {
        h.push('<div class="fin-group"><p>The full report lists every item.'
            + ' <button type="button" class="fin-report">Open report</button></p>'
            + '<div class="fin-fix" data-report="1" style="display:none"><p>Copy this path into Explorer to open the report:</p>'
            + '<input type="text" readonly class="fin-copy" value="' + esc(win.reportPath) + '" /></div></div>');
    }
    h.push("</div>");
    h.push('<div class="fin-footer" style="height:' + FOOTER_H + 'px"><button type="button" class="fin-done">Done</button></div>');
    h.push("</div>");
    return h.join("");
}

function showFinishWindow(opts) {
    opts = opts || {};
    var win = opts.win, log = opts.log || function () {};
    // injectable: tests must not touch the global (async test modules run concurrently)
    var doc = opts.document || (typeof document !== "undefined" ? document : undefined);
    if (!doc) return Promise.resolve({ closedBy: "no-dom" });
    var id = "fin-dlg-" + (++_seq) + "-" + Date.now().toString(36);
    var dlg = doc.createElement("dialog");
    dlg.id = id; dlg.className = "fin-dlg";
    dlg.innerHTML = build(win, id);
    doc.body.appendChild(dlg);
    try { dlg.style.width = "562px"; } catch (e0) {}

    var done = false, resolveOuter, watch = null;
    var finished = new Promise(function (res) { resolveOuter = res; });
    function finish(how) { if (done) return; done = true; try { if (watch) clearInterval(watch); } catch (e) {} resolveOuter({ closedBy: how }); }

    function all(sel) { return dlg.querySelectorAll(sel); }
    function each(list, fn) { for (var i = 0; i < list.length; i++) fn(list[i], i); }
    // after an expand, bring the block into view inside the scrolling area (a script cannot grow the box, #37)
    function reveal(el) {
        var sc = dlg.querySelector(".fin-scroll");
        try { if (typeof el.scrollIntoView === "function") { el.scrollIntoView(); return; } } catch (e0) {}
        try { if (sc && typeof el.offsetTop === "number") sc.scrollTop = el.offsetTop; } catch (e1) {}
    }
    function statusEl(g, r) { return dlg.querySelector('[data-s="' + g + ":" + r + '"]'); }

    each(all(".fin-show"), function (b) {
        b.addEventListener("click", function () {
            var g = Number(b.getAttribute("data-g")), r = Number(b.getAttribute("data-r"));
            var row = win.groups[g].rows[r], st = statusEl(g, r);
            if (st) st.textContent = "Showing...";
            b.disabled = true;
            Promise.resolve(opts.showTarget ? opts.showTarget(row.target) : { ok: false, reason: "not available" }).then(function (res) {
                if (st) st.textContent = res && res.ok ? "Shown" : "Could not show: " + (res && res.reason ? res.reason : "unknown");
                b.disabled = false;
            }, function (e) { if (st) st.textContent = "Could not show: " + (e && e.message ? e.message : e); b.disabled = false; });
        });
    });
    each(all(".fin-howto"), function (b) {
        b.addEventListener("click", function () {
            var f = dlg.querySelector('[data-f="' + b.getAttribute("data-g") + '"]');
            if (f) { f.style.display = f.style.display === "none" ? "block" : "none"; if (f.style.display === "block") reveal(f); }
        });
    });
    each(all(".fin-report"), function (b) {
        b.addEventListener("click", function () {
            var f = dlg.querySelector('[data-report="1"]');
            if (f) { f.style.display = "block"; reveal(f); var inp = f.querySelector("input"); try { inp.focus(); inp.select(); } catch (e) {} }
        });
    });
    each(all(".fin-copy"), function (inp) { inp.addEventListener("focus", function () { try { inp.select(); } catch (e) {} }); });
    each(all(".fin-done"), function (b) { b.addEventListener("click", function () { finish("done"); }); });

    try { dlg.show(); } catch (eShow) { log("finish window: show() threw: " + (eShow && eShow.message ? eShow.message : eShow)); finish("closed"); }
    // the title-bar close box: how it reads on this host is checked on the host; if the element is gone the window is gone
    // Host reading 2026-10-21: after the title-bar x the element stays connected and visible-less, but dlg.open reads false (while up it is
    // true). So: closed = gone from the DOM, or open went false after we saw it true (armed: never trust a first false).
    var sawOpen = false;
    try { watch = setInterval(function () { if (dlg.open === true) sawOpen = true; if (!dlg.isConnected || (sawOpen && dlg.open === false)) finish("closed"); }, 1000); } catch (eW) {}

    return finished.then(function (r) {
        // close, let the event loop run, remove (dialog.close() is not synchronous)
        try { dlg.close(); } catch (e1) {}
        return new Promise(function (res) {
            setTimeout(function () { try { dlg.remove(); } catch (e2) {} res(r); }, 200);
        });
    });
}

module.exports = { showFinishWindow: showFinishWindow, build: build, heightFor: heightFor, esc: esc };
