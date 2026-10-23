"use strict";

/**
 * lib/review_walk_flow.js — the walk loop of review_walk.idjs (TODO #151), with everything it touches injected, so
 * resume / look / close / save order are tested offline (tests/review_walk_flow_tests.js).
 *
 * deps = {
 *   ui:       { showItem(model, S) → Promise<{value, dlg}>, showList(spec, S) → Promise<{value, dlg}> },
 *   close:    async (dlg) → { released }          // closes the card and waits for app.modalState to read false
 *   navigate: async (state, item) → check | null  // only called while no card is open
 *   read:     async (path) → text | null          // null = no such file
 *   write:    (path, text) → void (throws on failure)
 *   images:   (item) → [{ role, src, w, h }]
 *   docsModified: async (docs) → void            // refresh docs[].modified_after at the end
 *   now:      () → ISO string
 * }
 * The order inside one item is fixed: navigate → save → show card → close card (wait for release) → record → save.
 * A card that does not release app.modalState stops the walk (opening another would stack modals).
 */

var Core = (typeof require === "function") ? require("./review_round_core.js") : null;

function _targetLine(S, it, j, baseName) {
    if (!it.target) return { text: S.targetNone, bad: false };
    if (j && j.selected && j.page_shown) {
        var what = it.target.frame !== undefined ? "框 " + it.target.frame : "story " + it.target.story + " 第 " + it.target.para + " 段";
        return { text: Core.fmt(S.targetSelected, { doc: baseName(it.target.doc), page: it.target.page, what: what }), bad: false };
    }
    return { text: Core.fmt(S.targetMissing, { reason: (j && j.reason) || "?" }), bad: true };
}

/**
 * walk(loaded, ansPath, deps) → { answersFile, summary, docs } | { stopped }
 *   loaded = { round, hash, file }
 * The walk goes card by card (Core.unitsOf): one card per single item, one per group. On a group card the owner
 * sees the representative large and every member as a thumbnail; clicking a thumbnail selects that member in its
 * document and shows it large (the card closes, the walk navigates, the same group card opens again). An answer
 * on a group card is written to every member.
 */
async function walk(loaded, ansPath, deps) {
    var round = loaded.round;
    var S = Core.strings(round);
    var baseName = function (p) { return String(p).replace(/^.*[\\/]/, ""); };
    var prev = null, raw = await deps.read(ansPath);
    if (raw !== null && raw !== undefined) {
        try { prev = JSON.parse(raw); }
        catch (e) { return await _stop(deps, S, round, ansPath, Core.fmt(S.answersBroken, { error: String(e && e.message || e) })); }
    }
    var ls = Core.loadState(round, prev, deps.now());
    if (ls.error) return await _stop(deps, S, round, ansPath, Core.fmt(S.answersBroken, { error: ls.error }));
    var cut = Core.unitsOf(round), units = cut.units, n = units.length;
    var state = ls.state, start = Core.unitStart(units, state), idx = start.index;
    var focus = {};                     // card index → member shown (and selected in its document)
    var noteShown = false;              // the round note is shown on the first card of a session only (owner 2026-10-21)
    if (idx < n) focus[idx] = start.member;
    state.resume_id = null;
    var saveErr = null;
    function save() {
        var f = Core.buildAnswerFile(round, { roundHash: loaded.hash, roundFile: loaded.file }, state, deps.now());
        try { deps.write(ansPath, JSON.stringify(f, null, 2)); saveErr = null; } catch (e) { saveErr = String(e && e.message || e); }
    }
    function unitDone(u) { return u.items.every(function (x) { return Core.isAnswered(state, x.id); }); }
    save();

    while (true) {
        if (idx >= n) {
            var f = Core.buildAnswerFile(round, {}, state, deps.now()), sm = f.summary;
            var doneCards = units.filter(unitDone).length;
            var rows = units.map(function (u, i) {
                var ua = Core.unitAnswer(state, u);
                var mark = ua.verdict === "ok" ? S.ok : ua.verdict === "problem" ? S.problem : ua.verdict === "choice" ? ua.choice : "—";
                var kind = ua.verdict === "ok" || ua.verdict === "choice" ? "ok" : ua.verdict === "problem" ? "bad" : "none";
                var title = u.key ? u.group.title + " · " + Core.fmt(S.groupCount, { n: u.items.length }) : u.items[0].title;
                return { mark: mark, markKind: kind, text: (i + 1) + ". " + title + (ua.note ? " — " + ua.note : "") };
            });
            var lines = [Core.fmt(S.doneSummary, { m: n, ok: units.filter(function (u) { return Core.unitAnswer(state, u).verdict === "ok"; }).length,
                problem: units.filter(function (u) { return Core.unitAnswer(state, u).verdict === "problem"; }).length,
                chosen: units.filter(function (u) { return Core.unitAnswer(state, u).verdict === "choice"; }).length, left: n - doneCards })];
            if (cut.auto.length) lines.push(Core.fmt(S.autoPassLine, { n: sm.auto_pass, titles: cut.auto.map(function (u) { return u.group.title; }).join("；") }));
            lines.push(saveErr ? Core.fmt(S.saveFailed, { error: saveErr }) : Core.fmt(S.savedTo, { path: ansPath }));
            var rs = await deps.ui.showList({ heading: doneCards === n ? S.doneTitle : (round.title || round.round), lines: lines, rows: rows }, S);
            var cs = await deps.close(rs.dlg);
            if (!cs.released) { state.host_warning = "a card did not release app.modalState at " + deps.now(); save(); return { stopped: "modalState not released" }; }
            if (rs.value && rs.value.type === "pick") { idx = rs.value.index; continue; }
            break;
        }
        var unit = units[idx], mi = focus[idx] !== undefined ? focus[idx] : unit.rep, it = unit.items[mi];
        var ids = unit.items.map(function (x) { return x.id; });
        var j = it.target ? await deps.navigate(state, it) : null;
        if (j) Core.setTargetCheck(state, it.id, j);     // the file carries it even if the owner never answers
        save();
        var a0 = Core.unitAnswer(state, unit), tl = _targetLine(S, it, j, baseName);
        var model = {
            roundTitle: round.title || round.round, title: unit.key ? unit.group.title : it.title, sentences: Core.sentencesOf(unit.key ? unit.group : it, S),
            slides: unit.items.map(function (x) { return { images: deps.images(x), caption: Core.captionOf(x) }; }), current: mi,
            note: noteShown ? "" : (round.note || ""), targetText: tl.bad ? tl.text : "", targetBad: tl.bad,
            choices: it.choices || null, verdict: a0.verdict, choice: a0.choice, noteText: a0.note,
            // the card shows a status line only when saving failed; the file path is on the summary page
            statusText: saveErr ? Core.fmt(S.saveFailed, { error: saveErr }) : "", statusBad: !!saveErr,
            isFirst: idx === 0, isLast: idx === n - 1
        };
        S.itemLine = Core.fmt(S.item, { n: idx + 1, m: n, a: units.filter(unitDone).length });
        // the note is written while typing pauses, not only when the card closes (no exit path may drop it)
        noteShown = true;
        var r = await deps.ui.showItem(model, S, { onNote: function (text) { ids.forEach(function (id) { Core.setDraftNote(state, id, text); }); save(); } });
        var a = (r && r.value) || { type: "close" };
        var cl = await deps.close(r && r.dlg);
        if (a.verdict) {
            ids.forEach(function (id) { Core.recordAnswer(round, state, id, { verdict: a.verdict, choice: a.choice, note: a.note }, deps.now()); });
        } else if (a0.verdict) {
            // the card opened answered and came back with no verdict: the owner clicked the chosen button again to
            // take the answer back (owner 2026-10-21). Clear it (every member); the note stays.
            ids.forEach(function (id) { if (Core.isAnswered(state, id)) Core.clearAnswer(state, id, deps.now()); if (a.note !== undefined && a.note !== null) Core.setNote(state, id, a.note); });
        } else if (a.note !== undefined && a.note !== null) {
            ids.forEach(function (id) { Core.setDraftNote(state, id, a.note); });
        }
        if (!cl.released) {
            // The card did not let go of InDesign: opening another card would stack modals. Stop; say so in the file.
            state.host_warning = "a card did not release app.modalState at " + deps.now();
            save();
            return { stopped: "modalState not released" };
        }
        if (a.type === "look") { state.resume_id = it.id; save(); break; }
        save();
        if (a.type === "member" && unit.key && a.index >= 0 && a.index < unit.items.length) { focus[idx] = a.index; continue; }
        if (a.type === "next") idx = Math.min(n, idx + 1);
        else if (a.type === "back") idx = Math.max(0, idx - 1);
        else if (a.type === "summary") idx = n;
        else break;                      // close (× / Esc) or error
    }
    if (deps.docsModified) await deps.docsModified(state.docs);
    save();
    return { answersFile: ansPath, summary: Core.buildAnswerFile(round, {}, state, deps.now()).summary, docs: state.docs, saveError: saveErr };
}

async function _stop(deps, S, round, ansPath, msg) {
    var r = await deps.ui.showList({ heading: round.title || round.round, errors: [msg, ansPath] }, S);
    await deps.close(r.dlg);
    return { stopped: msg };
}

module.exports = { walk: walk };
