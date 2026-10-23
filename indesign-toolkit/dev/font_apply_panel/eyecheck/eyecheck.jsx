// eyecheck/eyecheck.jsx — the eye-check overlay (TODO #144 round 144, owner option C). See core.js for the contract.
//
// Props:  round     the parsed checklist (eyecheck/rounds/<round>.json)
//         save      (resultDoc) => Promise<{ ok, path?, error? }>   called after every answer (same file each time)
//         location  { path, temp }   where the file will be written (shown on the card; temp = no document folder)
//         document  a name for the result file's header (optional)
//
// Mount it as the LAST child of a position:relative container; it covers that container. It depends on nothing of the
// panel: the only things it reads are the data-eyecheck hooks in the tree it sits in.
//
// UXP: no transition / animation / opacity / gap / dasharray / inset / position:fixed / <button>. The layer itself has
// ZERO size (so it can never swallow a click) and every drawn piece is absolutely positioned inside it; the lit frames
// are pointer-events:none, the mask pieces and the card are ordinary hit-testable divs. The hole is EMPTY (four mask
// rectangles around it), which is what keeps the controls inside it clickable.
const { useState, useRef, useEffect, useLayoutEffect } = React;
const EC = window.EyeCheckCore;

function EyeCheck({ round, save, location, document: docName }) {
  const S = Object.assign({}, EC.STRINGS, (round && round.strings) || {});
  const items = round.items;
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [maskOff, setMaskOff] = useState(false);
  const [done, setDone] = useState(false);
  const [closed, setClosed] = useState(false);
  const [geom, setGeom] = useState({ w: 0, h: 0, frames: [], hole: null, missing: [], waiting: true, card: { w: 320, h: 260 } });
  const [saveInfo, setSaveInfo] = useState(null);
  const layerRef = useRef(null);
  const cardRef = useRef(null);
  const startedAt = useRef(new Date().toISOString());
  const sigRef = useRef('');
  const item = items[Math.min(idx, items.length - 1)];

  const measure = () => {
    const layer = layerRef.current; if (!layer || !layer.parentNode) return;
    const root = layer.parentNode;
    const o = root.getBoundingClientRect();
    const names = []; const seen = {};
    item.targets.concat(item.waitFor ? [item.waitFor] : []).concat(item.passThrough || []).forEach(t => { const p = EC.parseTarget(t); if (p && !seen[p.name]) { seen[p.name] = true; names.push(p.name); } });
    const map = EC.collectHooks(root, names);
    let frames = []; const missing = [];
    item.targets.forEach(t => {
      const p = EC.parseTarget(t); const r = EC.relRects(EC.pickTarget(map, p), o);
      if (r.length) frames = frames.concat(r); else missing.push(t);
    });
    const waiting = item.waitFor ? !EC.pickTarget(map, EC.parseTarget(item.waitFor)).length : frames.length === 0;
    // a click-away layer that is on screen opens the mask everywhere (see core.js validateRound passThrough)
    let pass = [];
    (item.passThrough || []).forEach(t => { pass = pass.concat(EC.relRects(EC.pickTarget(map, EC.parseTarget(t)), o)); });
    const u = EC.unionRect(frames);
    const hole = u ? EC.clipRect(EC.growRect(EC.unionRect(pass.length ? frames.concat(pass) : frames), 6), o.width, o.height) : null;
    const c = cardRef.current ? cardRef.current.getBoundingClientRect() : null;
    const card = { w: 320, h: c && c.height ? c.height : 260 };
    const g = { w: o.width, h: o.height, frames, hole, missing, waiting, card };
    const sig = JSON.stringify([idx, g.w, g.h, frames, hole, missing, waiting, Math.round(card.h)]);
    if (sig !== sigRef.current) { sigRef.current = sig; setGeom(g); }
  };
  // after every render (the card's own height changes with the text) and on a poll: the panel moves under us
  // (a notice appears, the list opens, a node is added), and there is no observer we can rely on in the host.
  useLayoutEffect(() => { measure(); });
  useEffect(() => {
    const t = setInterval(measure, 250);
    return () => clearInterval(t);
  }, [idx]);

  // save after every answer: the same file, rewritten. (The dialog's close event is not reliable in the host, so nothing
  // is kept for "the end".)
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!Object.keys(answers).length || typeof save !== 'function') return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const doc = EC.buildResult(round, { startedAt: startedAt.current, document: docName || null, location: location ? location.path : null }, answers, new Date().toISOString());
      Promise.resolve(save(doc)).then(r => setSaveInfo(r || { ok: false, error: 'no result' })).catch(e => setSaveInfo({ ok: false, error: String(e && e.message || e) }));
    }, 120);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [answers]);

  if (closed) return null;
  const a = answers[item.id] || {};
  const setVerdict = (v) => setAnswers(prev => Object.assign({}, prev, { [item.id]: { verdict: v, note: (prev[item.id] && prev[item.id].note) || '', at: new Date().toISOString(), missing: geom.missing.length ? geom.missing.slice() : undefined } }));
  const setChoice = (id) => setAnswers(prev => Object.assign({}, prev, { [item.id]: { verdict: 'choice', choice: id, note: (prev[item.id] && prev[item.id].note) || '', at: new Date().toISOString(), missing: geom.missing.length ? geom.missing.slice() : undefined } }));
  const setNote = (t) => setAnswers(prev => Object.assign({}, prev, { [item.id]: Object.assign({ verdict: null, at: null }, prev[item.id] || {}, { note: t }) }));
  const answered = a.verdict === 'ok' || a.verdict === 'problem' || a.verdict === 'choice';
  const last = idx === items.length - 1;
  const goNext = () => { if (!answered) return; if (last) setDone(true); else setIdx(idx + 1); };
  const goBack = () => { if (done) { setDone(false); return; } if (idx > 0) setIdx(idx - 1); };

  const masked = !done && !maskOff && !geom.waiting && !!geom.hole;
  const pos = EC.placeCard(geom.w, geom.h, masked ? geom.hole : null, geom.card, 12);
  const px = (n) => Math.round(n) + 'px';
  const tally = EC.buildResult(round, { startedAt: startedAt.current }, answers, '').summary;
  const locText = location ? EC.fmt(S.savedTo, { path: location.path }) + (location.temp ? ' ' + S.tempNote : '') : '';

  return (
    <div ref={layerRef} className="eyecheck-layer">
      {masked ? EC.maskRects(geom.w, geom.h, geom.hole).map(m => (
        <div key={m.name} className="eyecheck-dim" style={{ left: px(m.left), top: px(m.top), width: px(m.width), height: px(m.height) }} />
      )) : null}
      {(!done && !geom.waiting) ? geom.frames.map((f, i) => (
        <div key={i} className="eyecheck-frame" style={{ left: px(f.left - 3), top: px(f.top - 3), width: px(f.right - f.left + 6), height: px(f.bottom - f.top + 6) }} />
      )) : null}
      {(!done && !geom.waiting && geom.hole) ? (
        <div className="eyecheck-badge" style={{ left: px(Math.max(2, geom.frames[0].left - 4)), top: px(Math.max(2, geom.frames[0].top - 14)) }}>{idx + 1}</div>
      ) : null}
      <div ref={cardRef} className="eyecheck-card" style={{ left: px(pos.left), top: px(pos.top), width: '320px' }}>
        {done ? (
          <div>
            <div className="eyecheck-head"><b>{S.heading + ' ' + round.round}</b></div>
            <div className="eyecheck-title">{S.doneTitle}</div>
            <div className="eyecheck-sec">{EC.fmt(S.doneSummary, { m: tally.total, ok: tally.ok, problem: tally.problem, chosen: tally.chosen })}</div>
            <div className="eyecheck-foot">{saveInfo && saveInfo.ok === false ? EC.fmt(S.saveFailed, { error: saveInfo.error || '?' }) : (saveInfo && saveInfo.path ? EC.fmt(S.savedTo, { path: saveInfo.path }) : locText)}</div>
            <div className="eyecheck-nav">
              <div role="button" tabindex="0" className="eyecheck-btn" onClick={goBack}>{S.back}</div>
              <div role="button" tabindex="0" className="eyecheck-btn is-primary" onClick={() => setClosed(true)}>{S.close}</div>
            </div>
          </div>
        ) : (
          <div>
            <div className="eyecheck-head"><b>{S.heading + ' ' + round.round}</b><span className="eyecheck-count">{EC.fmt(S.item, { n: idx + 1, m: items.length })}</span></div>
            <div className="eyecheck-title">{item.title}</div>
            <div className="eyecheck-sec"><div className="eyecheck-label">{S.doLabel}</div><div className="eyecheck-text">{item.do}</div></div>
            <div className="eyecheck-sec"><div className="eyecheck-label">{S.expectLabel}</div><div className="eyecheck-text">{item.expect}</div></div>
            <div className="eyecheck-sec"><div className="eyecheck-label">{S.whyLabel}</div><div className="eyecheck-text">{item.why}</div></div>
            {geom.waiting ? <div className="eyecheck-status">{EC.fmt(S.waiting, { hooks: (item.waitFor ? [item.waitFor] : item.targets).join(', ') })}</div>
              : (geom.missing.length ? <div className="eyecheck-status">{EC.fmt(S.missing, { hooks: geom.missing.join(', ') })}</div> : null)}
            {item.choices ? (
              <div className="eyecheck-choices">
                {item.choices.map(c => (
                  <div key={c.id} role="button" tabindex="0" className={'eyecheck-choice' + (a.choice === c.id ? ' is-on' : '')} data-choice={c.id} onClick={() => setChoice(c.id)}>
                    <b>{c.id}</b>{'  ' + c.label}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="eyecheck-verdicts">
              {item.choices ? null : <div role="button" tabindex="0" className={'eyecheck-btn eyecheck-ok' + (a.verdict === 'ok' ? ' is-on' : '')} onClick={() => setVerdict('ok')}>{S.ok}</div>}
              {item.choices ? null : <div role="button" tabindex="0" className={'eyecheck-btn eyecheck-problem' + (a.verdict === 'problem' ? ' is-on' : '')} onClick={() => setVerdict('problem')}>{S.problem}</div>}
              <div role="button" tabindex="0" className="eyecheck-btn eyecheck-maskswitch" onClick={() => setMaskOff(v => !v)}>{maskOff ? '遮罩：关' : '遮罩：开'}</div>
            </div>
            <input type="text" className="eyecheck-note" placeholder={S.note} value={a.note || ''} onChange={(e) => setNote(e.target.value)} />
            <div className="eyecheck-nav">
              <div role="button" tabindex="0" className={'eyecheck-btn' + (idx === 0 ? ' is-off' : '')} onClick={goBack}>{S.back}</div>
              <div role="button" tabindex="0" className={'eyecheck-btn is-primary' + (answered ? '' : ' is-off')} onClick={goNext} title={answered ? undefined : (item.choices ? S.choose : S.chooseFirst)}>{last ? S.finish : S.next}</div>
            </div>
            <div className="eyecheck-foot">{saveInfo && saveInfo.ok === false ? EC.fmt(S.saveFailed, { error: saveInfo.error || '?' }) : (saveInfo && saveInfo.path ? EC.fmt(S.savedTo, { path: saveInfo.path }) : locText)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { EyeCheck });
