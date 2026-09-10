// font_apply_panel — presentational components (Focus-only build).
//
// Ported from docs/字体映射面板/v2/components.jsx. Removed everything
// non-Focus per user direction (2026-06-07):
//   - profile === 'quiet' / 'bold' branches all DELETED (Focus is the only
//     skin; the panel hardcodes profile='focus' in app.jsx)
//   - actual-weight dropdown REMOVED — weights are all listed and the
//     UI is read-only on `actual` (still a static <span>, no <div role="button" tabindex="0">)
//   - role chip, add-weight, remove-weight, role submenu all gone
//   - "Add font" button still present (additive structural edits remain useful)
//
// CSS still uses [data-profile="focus"] selector for backward compat with
// extracted panel.css; app.jsx applies data-profile="focus" to .app root.

const { useState, useRef, useEffect, useLayoutEffect } = React;

// ---- icons -----------------------------------------------------------------
const ICONS = {
  grip: 'M7 5h2v2H7zM11 5h2v2h-2zM7 9h2v2H7zM11 9h2v2h-2zM7 13h2v2H7zM11 13h2v2h-2z',
  plus: 'M9 4v10M4 9h10',
  more: 'M5 9h.01M9 9h.01M13 9h.01',
  star: 'M9 2.6l1.9 3.9 4.3.6-3.1 3 .7 4.2L9 12.9 5.2 14.3l.7-4.2-3.1-3 4.3-.6z',
  x: 'M5 5l8 8M13 5l-8 8',
  slant: 'M11.5 4L6.5 14',
  link: 'M7 11a3 3 0 0 1 0-4l2-2a3 3 0 1 1 4 4l-1 1M11 7a3 3 0 0 1 0 4l-2 2a3 3 0 1 1-4-4l1-1',
  search: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3zM12 12l3 3',
  chevron: 'M6 8l3 3 3-3',
  check: 'M4 9.5l3.2 3.2L14 6',
};

function Icon({ name, size = 18, stroke = 1.6, fill = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none"
      style={{ display: 'block', flex: 'none' }}>
      <path d={ICONS[name]} stroke={fill ? 'none' : 'currentColor'} fill={fill ? 'currentColor' : 'none'}
        strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- inline editable text --------------------------------------------------
// Double-click to edit. Enter commits, Escape cancels.
function Editable({ value, onCommit, className, mono, placeholder, title }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const ref = useRef(null);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select(); } }, [editing]);
  useEffect(() => { setV(value); }, [value]);
  if (editing) {
    return (
      <input ref={ref} className={`edit-input ${mono ? 'mono' : ''} ${className || ''}`} value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { setEditing(false); onCommit(v.trim() || value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.target.blur(); }
          if (e.key === 'Escape') { setV(value); setEditing(false); }
        }} />
    );
  }
  return (
    <span className={`editable ${mono ? 'mono' : ''} ${className || ''} ${!value ? 'is-empty' : ''}`}
      onDoubleClick={() => setEditing(true)} title={title || 'Double-click to edit'}>
      {value || placeholder}
    </span>
  );
}

// ---- port (pairing endpoint) ----------------------------------------------
// Advanced options (owner 2026-09-09):「LABEL 的默认不开」。
// 这些 title 是【开发期用来准确描述组件名】的（owner 原话），不是给操作员的文案 ——
// §13 对「折得进 operator 已有概念」的处置是闭嘴，所以默认不挂。返回 undefined 时
// React 整个省略该属性 ⇒ tooltip 引擎找不到任何东西，这点要紧：容器的 title 会遮住
// 子元素的（2026-09-08/09 实测），留一个空字符串反而会继续遮。
// ⚠ 只用于 LABEL 类（命名）。ACTION（说出看不见的手势）与 CONSEQUENCE（说出会发生什么）
//   两类【不】走这里 —— 它们是操作员需要而界面上看不出来的东西。
function devTitle(ctx, s) { return (ctx && ctx.devLabels) ? s : undefined; }

function Port({ ctx, side, addr, hue, title }) {
  const { drag } = ctx;
  const id = `${addr.lang}:${addr.font}:${addr.node}:${side}`;
  const isSource = drag && drag.type === 'wire' && drag.fromId === id;
  const wireActive = drag && drag.type === 'wire';
  const isTarget = wireActive && drag.overPort === id && drag.fromId !== id;
  // #48 (§14 连带): label wires are DERIVED from the pairing, so the
  // "drag OUT of the label port" gesture is closed — otherwise derived and
  // hand-drawn wires become two sources that fight at round-trip
  // (labelLinked is a bool; it cannot store which ones he drew). The port
  // stays a DROP target (node→label linking via app.jsx:654 is untouched)
  // and stays registered: it is still the fan-out anchor for derived wires.
  const isLabel = addr.lang === '__label__';
  return (
    <div role="button" tabindex="0"
      className={`port port-${side} ${hue ? 'is-paired' : ''} ${isSource ? 'is-source' : ''} ${isTarget ? 'is-target' : ''} ${wireActive ? 'wire-armed' : ''} ${isLabel ? 'is-derived' : ''}`}
      style={hue ? { '--ph': hue } : undefined}
      data-port={id}
      ref={(el) => ctx.registerPort(id, el)}
      onPointerDown={(e) => { e.stopPropagation(); if (!isLabel) ctx.onStartWire(e, addr, side); }}
      title={title || 'Port — drag to pair across languages'} />
  );
}

// ---- #54ⓒ delete-confirm (owner 2026-08-20) --------------------------------
// owner REVERSED his own earlier "b: 不用确认" and asked for a confirm popup,
// then — after seeing the first build — ruled on its FORM:
//   「弹窗改成和点 done 时的弹窗一致，不用系统原生的」
//
// 🪦 The first build used a nested `<dialog>.showModal()`. It WORKED (measured:
// the second modal opens above the panel's own, the outer survives its close,
// the bridge is fine) and owner confirmed its buttons were pressable — but a UXP
// `<dialog>` is a real OS window (it gets its own HWND; that was measured too),
// so it read as a SYSTEM frame sitting on the panel. That is what he rejected.
// ⇒ Form is now the panel's OWN popup idiom: an in-panel overlay + box.
// ⚠ Do NOT "restore" the nested dialog as a robustness improvement — the native
// look is the entire reason it was rejected. The probe was not wasted: it is why
// we could pick this form knowing the other one was genuinely available.
//
// 🔴 Reuses the Done-time popup's CSS classes VERBATIM (.tofu-pop-overlay /
// .tofu-pop / .tofu-pop-msg / .tofu-pop-btns / .tofu-pop-cancel /
// .tofu-pop-ignore) instead of defining a lookalike. arch: 「照它的形态做，别自己
// 另调一套」— a second set of near-identical rules IS the drift this sheet already
// suffers from (#51). Consequence worth knowing: it therefore inherits that
// popup's red warning skin. If owner wanted neutral that is a class swap, not a
// redesign — flagged to arch rather than silently deviated from.
//
// Button semantics map 1:1 onto the Done popup, which is why the classes fit:
//   .tofu-pop-cancel = emphasised (blue, weight 600) SAFE choice -> 取消
//   .tofu-pop-ignore = secondary grey PROCEED choice             -> 删除
// The safe option carrying the emphasis is that popup's own convention, and it is
// part of what makes this survivable without a "cannot be undone" sentence.
//
// 🔴 owner DELETED two sentences an earlier draft carried — "角度设置一并消失"
// and "不可撤销". That is a RULING, not an oversight: he wants ONE question and
// nothing else. Do NOT restore them by appealing to design-intent §13 ("说清
// 后果") — that appeal has already been considered and overruled. Recorded here
// AND in TODO#54ⓒ so the ruling survives reading either one alone.
// 🔴 #54ⓒ ② (owner 2026-08-22: 「再点击无反应，也没有弹窗」).
// "Nothing happened" is the least diagnosable report there is, and this flow had
// NO trace at all: the confirm has no fail-closed branch, so a rejected promise
// inside the async onClick is swallowed by the event system and the screen simply
// does not change. Every decision point in the delete flow now says what it did.
//
// TWO channels on purpose:
//   - `console` for a live UDT session;
//   - a ring buffer on `window.__fapTrace`, because the UXP console is NOT
//     readable from the bridge, and the plugin context PERSISTS between runs
//     (#14b) — so after the operator clicks, the trace can still be read with
//     `execute_indesign_code`, without asking him to reproduce anything.
// Capped so a long session cannot grow it without bound.
// 🔴 SESSION STAMP. The buffer lives on `window`, and the plugin context
// SURVIVES between runs (#14b) — so without a marker a reader can pick up the
// PREVIOUS panel session's lines and conclude from them. `_fapSession` is
// module-scope, and components.jsx is re-evaluated on every panel open, so each
// open gets a fresh id automatically; the first trace of a session also writes a
// visible separator. Use `window.fapTraceLatest()` to read only this session.
var _fapSession = null;
function fapTrace(what, detail) {
    try {
        if (!window.__fapTrace) window.__fapTrace = [];
        if (!_fapSession) {
            _fapSession = "s" + Date.now().toString(36);
            window.__fapTrace.push("=== panel session " + _fapSession + " opened " + new Date().toISOString() + " ===");
        }
        var line = _fapSession + " " + new Date().toISOString() + " " + what +
            (detail === undefined ? "" : " " + JSON.stringify(detail));
        window.__fapTrace.push(line);
        if (window.__fapTrace.length > 200) window.__fapTrace.shift();
        if (typeof console !== "undefined" && console.log) console.log("[fap] " + line);
    } catch (e) { /* tracing must never be the thing that breaks */ }
}

// ② A modal question is up: raise/lower the flag that hides native host widgets.
// See panel.css .fap-modal-up for WHY hiding beats stacking here.
//
// 🔴 REFCOUNTED, and that is the point. Two different popups raise this flag — the
// React-rendered Done/tofu warning and the hand-built italic-delete confirm — and a
// plain add/remove pair lets whichever one closes first un-hide the widgets while
// the other is still on screen. The counter is the single owner; the callers only
// say "one more" / "one fewer".
// ⚠ Never let this throw: a failed decrement would strand the panel with every
// native control hidden, which is a far worse bug than the one being fixed.
function fapModalScrim(on) {
    try {
        var n = (window.__fapModalDepth || 0) + (on ? 1 : -1);
        window.__fapModalDepth = n < 0 ? 0 : n;
        var root = document.documentElement;
        if (!root) return;
        if (window.__fapModalDepth > 0) root.classList.add("fap-modal-up");
        else root.classList.remove("fap-modal-up");
    } catch (e) { /* a cosmetic flag must never break the panel */ }
}

// Read back ONLY the current panel session. 🔴 This is the call to use from the
// bridge: `window.fapTraceLatest()`. Reading the raw buffer risks quoting a
// previous run — exactly the mistake the session stamp exists to prevent.
// ⚠ If the ring buffer has already dropped this session's opening separator, it
// says so rather than silently returning a partial slice as if it were whole.
function fapTraceLatest() {
    var all = (typeof window !== "undefined" && window.__fapTrace) ? window.__fapTrace : [];
    if (!_fapSession) return { session: null, truncated: false, lines: [], note: "no trace yet this session" };
    var start = -1;
    for (var i = all.length - 1; i >= 0; i--) {
        if (String(all[i]).indexOf("=== panel session " + _fapSession + " ") === 0) { start = i; break; }
    }
    var lines = (start >= 0) ? all.slice(start) : all.filter(function (l) {
        return String(l).indexOf(_fapSession + " ") === 0;
    });
    return { session: _fapSession, truncated: start < 0, lines: lines };
}

function confirmItalicDelete(fontName, weightLabel) {
    fapTrace("confirmItalicDelete:enter", { font: fontName, weight: weightLabel });
  return new Promise(resolve => {
    // Anchored inside `.app`, which carries position:relative for exactly this
    // (panel.css:48, added for the Done popup). Falling back to body would still
    // show it, just unanchored — never silently no-op.
    // 🔴 getElementsByClassName, not querySelector: #23 measured that this
    // webview's selector engine returns null SILENTLY for some shapes, and it
    // fooled this line once already. Also trace WHICH host was used — anchoring
    // to body instead of .app would put the overlay in a container with no size.
    const _apps = document.getElementsByClassName('app');
    // ⚠ LAST, not first. The launcher sweeps stale <dialog>s at open, but if a
    // dead panel shell ever does survive it sits EARLIER in document order, and
    // anchoring the popup inside it would put the question somewhere the operator
    // cannot see or click — which is indistinguishable from "the click did
    // nothing" (#14/#14a: a residual shell is a real failure mode here, not a
    // hypothetical). The live panel is always the most recently mounted one.
    const host = (_apps && _apps.length ? _apps[_apps.length - 1] : document.body);
    // 🔴 `count` is the diagnostic: >1 means a stale shell is present and this
    // popup may be landing in the wrong one; 0 means it fell back to <body>, which
    // has no size in this webview (闸门 4) and would be invisible.
    fapTrace('confirmItalicDelete:host', { usedApp: !!(_apps && _apps.length), count: _apps ? _apps.length : 0 });

    const overlay = document.createElement('div');
    // Second class = this feature's own stable hook (#14: existence checks key
    // on a CLASS, never a fixed id).
    overlay.className = 'tofu-pop-overlay ital-del-overlay';
    const box = document.createElement('div');
    // is-neutral: reuse the Done popup's STRUCTURE, not its warning skin.
    // owner 2026-08-20:「复用 Done 的类不需要红，因为不是 done」— the red
    // belongs to the pre-apply WARNING's meaning, not to "popup". The modifier
    // overrides three colour declarations only; every geometry/layout rule still
    // comes from .tofu-pop, so the popup's shape keeps a single source of truth.
    // ① owner 2026-08-22:「把弹窗位置移到中间」. `is-centered` is a modifier on
    // THIS box only — .tofu-pop itself still parks top-right for the Done/tofu
    // warning that owns that position. Moving the shared class would have
    // relocated a popup owner did not ask about.
    box.className = 'tofu-pop is-neutral is-centered';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Confirm delete');

    const msg = document.createElement('div');
    msg.className = 'tofu-pop-msg';
    // owner's exact wording — one question, nothing after it.
    // ⑤ English UI (owner). ⚠ Still ONE question with nothing after it —
    // owner removed the two consequence sentences on 2026-08-20 and that ruling
    // survives the translation; do not let English tempt a second line back in.
    msg.textContent = 'Delete the italic copy of \u201c' + fontName + ' ' + weightLabel + '\u201d?';
    const row = document.createElement('div');
    row.className = 'tofu-pop-btns';

    // 🔴 #56 is the bug of getting only ONE of these two right, so both are
    // deliberate: (a) `div role=button`, because a native <button> is a broken
    // host widget in a UXP dialog (闸门 4); (b) role="button" is also the FIRST
    // token of app.jsx's PAN_SKIP_SEL, so the canvas pan handler treats it as
    // interactive instead of starting a pan. A raw <button> satisfies neither.
    const mkBtn = (cls, label) => {
      const b = document.createElement('div');
      b.setAttribute('role', 'button');
      b.tabIndex = 0;
      b.className = cls;
      b.textContent = label;
      return b;
    };
    const cancel = mkBtn('tofu-pop-cancel', 'Cancel');
    const ok = mkBtn('tofu-pop-ignore', 'Delete');

    let done = false;
    // Idempotent: Esc, a button, and the click-outside path can all land.
    // Whoever is first wins; the rest are no-ops.
    const finish = val => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      // ② Lowered HERE and nowhere else: finish() is already the single idempotent
      // exit (Esc, both buttons and click-outside all land on it, and `done` makes
      // the rest no-ops), so the counter can never be decremented twice for one popup.
      fapModalScrim(false);
      try { overlay.remove(); } catch (e) {}   // #14: DOM removal is the real "gone"
      fapTrace('confirmItalicDelete:answered', { deleted: val });
      resolve(val);
    };
    // Esc = cancel (arch). This form is NOT a <dialog>, so there is no native
    // `cancel` event to lean on — a document-level capture listener is the only
    // channel, and finish() removes it so it can never outlive the popup.
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    document.addEventListener('keydown', onKey, true);

    cancel.addEventListener('click', e => { e.stopPropagation(); finish(false); });
    ok.addEventListener('click', e => { e.stopPropagation(); finish(true); });
    // Click-outside = 取消, same as the Done popup. Deleting must never be the
    // outcome of a stray click, so the outside path resolves FALSE.
    overlay.addEventListener('click', () => finish(false));
    box.addEventListener('click', e => e.stopPropagation());

    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(msg); box.appendChild(row);
    overlay.appendChild(box);
    host.appendChild(overlay);
    fapModalScrim(true);   // ② native widgets must not float over this question

    // Default focus = 取消 (arch). Deferred a tick: this round measured that
    // geometry/focus are not settled in the same turn as insertion.
    setTimeout(() => { try { cancel.focus(); } catch (e) {} }, 0);
    // 🔴 Did it actually land in the DOM, and does it have a size? If the popup
    // is built but measures 0x0 the operator can neither see nor answer it, and the
    // promise stays pending forever — which looks exactly like "the click did
    // nothing".
    // ⚠ Deferred by a REAL delay, not one tick: measured (probe 20260822_01)
    // that one tick after insertion the box reads 0x0 while 300ms after showModal
    // the SAME element reads 320x82. A 0ms read would have reported "no size" on
    // every healthy run and sent the next reader hunting a CSS bug that is not
    // there (CLAUDE.md #17-补 — it already cost this line one wrong conclusion).
    setTimeout(() => {
      try {
        const inDom = document.getElementsByClassName('ital-del-overlay').length;
        const r = box.getBoundingClientRect();
        fapTrace('confirmItalicDelete:shown', { overlays: inDom, w: Math.round(r.width), h: Math.round(r.height) });
      } catch (e) { fapTrace('confirmItalicDelete:shown:threw', String(e && e.message || e)); }
    }, 300);
  });
}

// ---- a weight / merge-group node ------------------------------------------
// In Focus mode actual is static text; no actualMenu (user removed dropdown).
// `italicInfo` is resolved ONCE by FontCard and passed in (it needs the same
// value to decide whether to render the copy sibling). Resolving it here too
// would walk config.pairs a second time for every visible node on every render —
// and every angle-drag pointermove is a render. This panel has a pan/perf history;
// don't re-earn it.
function WeightNode({ ctx, lang, font, node, italicInfo, italicBase }) {
  const { drag } = ctx;
  const addr = { lang: lang.id, font: font.id, node: node.id };
  // #45 — hover detection via NATIVE pointerenter/leave on the node root
  // (probe 20260813_16: both fire with standard semantics in this dialog —
  // parent leave does not mis-fire on child entry; React synthetic hover
  // never dispatches here, gate-4a). ctx is recreated per render, so the
  // listeners read it through a ref — the effect binds once per node addr.
  const hlRootRef = React.useRef(null);
  const hlCtxRef = React.useRef(ctx);
  hlCtxRef.current = ctx;
  React.useEffect(() => {
    const el = hlRootRef.current;
    if (!el) return;
    const a = { lang: lang.id, font: font.id, node: node.id };
    const enter = () => { const c = hlCtxRef.current; if (c.onNodeHover) c.onNodeHover(a); };
    const leave = () => { const c = hlCtxRef.current; if (c.onNodeHover) c.onNodeHover(null); };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
    };
  }, [lang.id, font.id, node.id]);
  const dragging = drag && drag.type === 'node' && drag.node === node.id && drag.font === font.id;
  const over = drag && drag.type === 'node' && drag.font === font.id && drag.overNode === node.id && !dragging;
  const mode = over ? drag.dropMode : null;
  const hue = ctx.nodeHue(addr);
  const wireActive = drag && drag.type === 'wire';
  const wireDim = wireActive && !ctx.wireConnectable(addr) && !(drag.from && drag.from.lang === addr.lang && drag.from.font === addr.font && drag.from.node === addr.node);

  const matched = !!hue;
  const usedCount = node.kind === 'weight'
    ? (node.weight.used || 0)
    : node.members.reduce((n, m) => n + (m.used || 0), 0);
  const used = usedCount > 0;
  const state = matched ? 'matched' : used ? 'todo' : 'available';

  // 8D-ext-bypair-tofu-ux Phase 2: tofu-risk early warning. A node that is used
  // in the doc but UNPAIRED (state==='todo') on the SOURCE side (NOT a CJK target
  // column — cjkLangs is the seeded SoT, same set the end byPair sweep gates on)
  // will, after translation to the CJK target, carry CJK on an unmapped font →
  // some text won't display. Red outline cues the operator to wire it (or ignore
  // at Done). Fires on weight/group nodes. node-level (== wiredNodeIds/render granularity).
  // Red outline is shown ONLY after Done detected unpaired fonts (ctx.tofuFlagActive),
  // not live while the operator is mapping (user direction 2026-06-20). state==='todo'
  // = used-in-doc + unpaired; !cjkLangs = source side.
  const _cjkLangs = (window.__fap && window.__fap.cjkLangs) || {};
  const _unpaired = (state === 'todo') && !_cjkLangs[lang.code];
  const tofuWarn = !!ctx.tofuFlagActive && _unpaired;

  // owner 2026-09-08: 「未配对的标签在配对后不显示」+「每个字重节点都直接显示出了什么错」.
  // Same split the not-installed chip already uses, and for the same reason: the RED
  // OUTLINE is Done-gated and loud (user direction 2026-06-20, unchanged), while a
  // chip is a quiet always-on statement of fact that is useful WHILE pairing. Before
  // this, the unpaired class had the outline and NO label — so a node could be red
  // with nothing on it saying what was wrong, and the two red classes (unpaired /
  // not-installed) were indistinguishable at a glance.
  // It disappears on pairing for free: `state` leaves 'todo' the moment the node is
  // wired, so the chip is live — no extra clearing logic, and nothing to keep in sync.
  // ⚠ The hover text is NOT newly invented. It restates the mechanism recorded 20 lines
  // above (…carry CJK on an unmapped font → some text won't display), per this file's
  // own standing rule: every clause in these tooltips is a measured behaviour, do not
  // add one without a measurement. Two false tooltips have already been fixed here.
  const _unpairedPop = 'Used in the document, but this weight is not paired yet. After translation its CJK text lands on a font with no mapping, so some text will not display. Pair it, or ignore at Done.';
  const UnpairedChip = _unpaired ? (
    <span className="unpaired-chip">
      unpaired
      <span className="chip-pop">{_unpairedPop}</span>
    </span>
  ) : null;

  // W3 — the config declares this face but this machine does not have it (the
  // family picker only ever lists installed families, so an absent one is
  // invisible rather than flagged — this marking is how it becomes visible).
  // GUARD lives upstream now: an EMPTY installedFamilies ("could not
  // enumerate" — standalone web preview, no host) makes the adapter attach NO
  // _missingFaceKeys, so nodeMissingFaces returns [] everywhere and neither
  // chip nor outline can fire.
  //
  // ⚠ The tooltip used to say the weight would "land on a substitute font". That was
  // FALSE, and false in the REASSURING direction — it taught "this will look a bit
  // different" when the truth is "this mapping will not run at all". Verified in the
  // code, twice, before rewriting:
  //   byPair_char_sweep.js:221-228 — a stage1Reject entry never enters validByPair,
  //     so the swap does not execute and the text keeps its ORIGINAL font. Its own
  //     comment: "do NOT pass the entry to resolve/apply (would substitute an
  //     uninstalled font)".
  //   style_applier.js:1600-1602 — !resolved → reason "face_not_installed",
  //     "skip + surface, NO ghost". No substitution is produced anywhere.
  // Same standard as the parked-member banner: every clause here is a measured
  // behaviour. Do not add one without a measurement.
  //
  // #28e — face-level (family, weight) test, closing the family-level hole the
  // note below froze: a present family missing ONE weight (Whitney with no Book)
  // used to get no chip — a clean bill of health in the case that most needs the
  // warning. nodeMissingFaces (data.jsx) is THE single predicate (red outline +
  // chip both derive from this one call). The keys are HOST-probed at
  // open/import with the byPair Stage-1 gate's own function
  // (byPair_script_coverage.checkDstFaceInstalled via lib/font_face_missing.js),
  // so the marking predicts exactly what the sweep will skip — and when TODO#34
  // teaches that gate to resolve twin spellings, this marking follows for free.
  // The red outline is Done-gated, SAME lifecycle as the tofu red above
  // (owner 2026-08-13 final: 「和已有未配对提示一致」— fires on Done-detection,
  // stays through the popup's 取消 so the operator can see which nodes it
  // meant, clears on any data edit). This is only visible-in-principle because
  // the Done popup's 取消 returns TO the panel (verified — same button
  // semantics as tofu); a Done-gated red with no popup would be structurally
  // invisible, which is why the short-lived "always-on" variant existed
  // between the 08-12 no-prompt ruling and the 08-13 CTA ruling.
  const _missFaces = window.nodeMissingFaces
    ? window.nodeMissingFaces(ctx.missingFaceKeys, font.name, node) : [];
  const missWarn = !!ctx.missFlagActive && _missFaces.length > 0;

  // The chip shares the red outline's PREDICATE (the one nodeMissingFaces
  // call above — unified so the two can never disagree about facts) but NOT
  // its timing, and the timing split is DELIBERATE (owner 2026-08-13:「红框
  // 第一步不需要显示，但 not installed 要第一步就要显示」). This is the
  // panel's native grammar: chip-class marks (`In doc × N`, `not installed`)
  // are quiet, always-on statements of fact — useful WHILE pairing; red-
  // outline-class marks (tofu red, miss red) are loud, Done-time, and demand
  // an action. Unify the predicate to never lie; split the timing so loudness
  // matches urgency. Do NOT "re-unify" the timing — that was tried and
  // overruled.
  //
  // ⚠ DROPPED HERE, DELIBERATELY AND ON RECORD (arch: 不许无声消失): the old
  // FAMILY-level live branch (`!installedFamilies[font.name]`) also chipped
  // doc-present fonts OUTSIDE the config whose whole family is absent. For
  // those there is NO mapping to skip, so this chip's tooltip ("这条映射会被
  // 跳过") was FALSE for them — the third false-tooltip of this shape, so the
  // branch goes. But a TRUE claim is dropped with it: "this document uses a
  // font this machine does not have" — which affects how the doc LOOKS on
  // this machine (preview / proofing / exported PDF), a different sentence
  // from what the red outline says (pipeline skip). Whether THAT deserves its
  // own marking is a separate design-intent §13 question — reported to arch,
  // who owns the new #28 arm for it. Do not quietly resurrect it here.
  const _missWhat = font.name + ' · ' + _missFaces.join(' / ');
  // #28e-alias epilogue (2026-08-12): the alias-wording branch that lived here
  // (「名字对不上」chip for faces installed under a twin spelling) was DELETED
  // as unreachable, not as a feature cut: after TODO#34 the gate itself runs
  // the same ①-④ resolver these faces used to need, so "judged missing yet
  // twin-resolvable" is constructively near-empty. The residual is exactly
  // #34's UNFIXED half (resolver fail-open proposes a name whose status is
  // unreadable → the gate's strict recheck rejects): should that state occur,
  // this chip degrades to 本机没有 — itself a shaky claim under unreadable
  // status. That residual belongs to TODO#34, not to this panel. The
  // capability (does this face have another installed spelling?) survives in
  // lib/font_face_missing.js, deliberately unwired.
  // 🔴 owner 2026-09-08:「hover 标签时没有小弹窗用于解释」. The explanation was a
  // native `title=`, and this sheet already records why that cannot work here:
  // the panel's working reveals are pure-CSS :hover on a display-switched CHILD
  // (.chip-pop / .merged-pop), because "React synthetic hover does not dispatch
  // inside a UXP <dialog>". So this chip has carried an explanation nobody could
  // ever see — same shape as the three other "correct mechanism, never on the
  // real path" defects found today. `title` is kept as a harmless fallback for
  // any host that does honour it; .chip-pop is the one that actually shows.
  const _missPop = _missWhat + ' is not installed on this machine. This mapping is skipped when applied — the text keeps the font it already has; it is not swapped for another one.';
  const MissChip = _missFaces.length > 0 ? (
    <span className="miss-chip">
      not installed
      <span className="chip-pop">{_missPop}</span>
    </span>
  ) : null;

  // univ-italic §3 — "build an italic copy" affordance. On weight nodes AND on
  // merge groups (keyed off the group's representative — see italicBaseWeightOf;
  // a group REPLACES its member weight nodes, so gating on kind==='weight' would
  // leave every merged weight permanently unable to declare italic HOW). The base
  // weight token comes in as `italicBase` — do NOT reach for node.weight.actual,
  // which does not exist on a group node.
  //
  // D5(a): the BASE node is never edited — not its data, and not its shape. The
  // chip therefore stays PRESENT once a copy exists. It used to be removed, so
  // clicking it made the base row visibly change (the control vanished) and the
  // new sibling read as "the original node was modified" — which is exactly what
  // the operator reported seeing. What the click produces is a DERIVED SIBLING
  // below; the base keeps its own weight, untouched, because a base that slants
  // would slant every ordinary run of that weight (D4).
  //
  // 🪦 AC⑧ RETIRED by TODO#54ⓒ-定案 (owner 2026-08-19). AC⑧ said "once a copy
  // exists the chip is present but INERT (hover-revealed, dimmer, not clickable)".
  // Owner reversed it: a copy-bearing chip is now PERSISTENT + clickable, and the
  // click DELETES the copy. `is-inert` is retired with it — this is a semantic
  // inversion, not an extra branch, so the old class is gone rather than kept
  // alongside. What survives from AC⑧ is only its shape-stability intent (the
  // base row itself is still never rewritten).
  //
  // 🔴 Delete addresses `italicInfo.key` — the SAME winner key whose entry made
  // hasCopy true (app.jsx italicInfo: entry = italic_by_winner[key]). That is the
  // structural answer to #49e's "auto faux can land on a NON-representative
  // member, so make sure you delete the right winner key": read-key and write-key
  // are one expression here, so they cannot drift apart. Deleting the entry also
  // takes the angle with it — angle/mode live INSIDE the entry object, so there
  // is no second store to sweep.
  const hasCopy = !!(italicInfo && italicInfo.entry);
  // owner 2026-09-08:「斜体按钮也加上小弹窗，有小弹窗的都去掉原生注释」. Same wording as
  // the dead `title=` it replaces — this moves the sentence onto a carrier that
  // renders, it does not rewrite it.
  const _italPop = hasCopy
    ? ('Delete the italic copy — asks first, then removes the derived node just below. The slant angle goes with it. This base weight is never changed either way; click again afterwards to re-create the copy.')
    : ('Add an italic copy — a DERIVED node appears below declaring how this weight slants when text is marked italic (synthetic slant, starts at 15°). The base weight itself is never touched: a slanted base would slant every ordinary run of this weight.'
      + (node.kind === 'group'
        ? ' NOTE: this merge group is covered through its representative (' + italicBase + ') only. The other merged weights keep their own spelling in the config, so a run in one of them is NOT covered by this copy.'
        : ''));
  /* 🔴 owner 2026-09-09：「拖上去后等于点击，改成拖时不出现斜体按钮」。
     两件事一起解决：拖动中不该冒出这个按钮（视觉），而且**在它上面松手会
     触发它的 onClick** —— #96 的点火栈逐帧记着：
       up -> applyReorder（提交重排） … 紧接着 onClick -> createItalicVariant
     一个手势里既重排又建了个 operator 从没想建的斜体副本。

     ⚠ 为什么不用 CSS 藏（`body.grabbing .ital-add{display:none}`）：
       `grabbing` 是在 pointerup 的【捕获阶段】被清掉的，而 `click` 在那之后
       才派发 ⇒ 到 click 时按钮已经"回来了"，CSS 挡不住那一下。
     ⇒ 拖动中【根本不渲染】它：不在 DOM 里就没有 handler 可被触发，这条是硬的。
     ⚠ 但要留住它占的位置，否则拖动一开始整行就变窄、落点跟着位移
       —— 拖动过程中改变命中几何是另一类 bug。所以下面的 .ital-slot
       在拖动时【无条件】占位（含 has-copy 那种常驻按钮的情形）。 */
  const _dragging = !!(ctx && ctx.drag);
  const ItalicAdd = (italicInfo && italicBase && !_dragging) ? (
    <div role="button" tabindex="0"
      className={'ital-add' + (hasCopy ? ' has-copy' : '')}
      onClick={async () => {
        // owner 2026-08-20 REVERSED his 08-19 "no confirm": deletion now asks.
        // The has-copy fill/hover cues stay, but they no longer carry the
        // misclick defence on their own — the confirm does.
        fapTrace('I:click', { hasCopy: hasCopy, base: italicBase, font: font.name,
                              hasInfo: !!italicInfo, hasEntry: !!(italicInfo && italicInfo.entry) });
        if (!hasCopy) { ctx.createItalicVariant(lang.code, font.name, italicBase); return; }
        // Named with what the operator sees: `italicBase` is the same token the
        // derived node renders as its `baseLabel`, so the question points at the
        // row he is looking at (not at the winner key underneath, which can be a
        // different font when the weight maps onto a pair target).
        // 🔴 try/catch is REQUIRED, not defensive dressing: this is an async
        // handler, so a throw here becomes an unhandled rejection that the event
        // system swallows — the screen just does not change, which is precisely
        // what the operator reported. Failing closed is right; failing closed
        // SILENTLY is what made it undiagnosable.
        let yes = false;
        try {
          yes = await confirmItalicDelete(font.name, italicBase);
        } catch (e) {
          fapTrace('I:confirm:threw', String(e && e.message || e));
          return;   // fail closed — never delete because the question failed
        }
        fapTrace('I:confirm:result', { deleted: yes });
        if (yes) ctx.deleteItalicVariant(italicInfo.key);
      }}>
      <span className="ital-add-glyph">I</span>
      {/* owner ⑧-2: hover outline = display-switched ring child (this round's
          mechanism: :hover restyle applies display, not opacity). */}
      <span className="ital-add-ring" />
      <span className="chip-pop">{_italPop}</span>
    </div>
  ) : null;

  // 8D-ext-MM step 4 — representative marker. Non-null only when THIS node is a
  // member of a pair whose lang has ≥2 members (an MM same-lang member). Reuses
  // the merge-group star pattern below (.rep / Icon "star"): filled on the rep,
  // unfilled on the others; click → become the rep (zero menu/confirm); hover →
  // tooltip explaining what it is + how to change. Gate-4 compliant (div
  // role=button, plain CSS class — no min/calc/var).
  const repInfo = ctx.pairRepInfo ? ctx.pairRepInfo(addr) : null;
  // Star popup (owner 2026-08-13, ⑩ wording 2026-08-14) — same .chip-pop
  // mechanism, but a DIFFERENT layer than the chip's popup: the star's
  // sentence says what the star IS, and renders on EVERY star,
  // operator-authored reps included; the chip's popup says why THIS pick was
  // the machine's, and only exists on auto ones.
  // ⑩ (#49a final): CONDITIONAL tense, deliberately — the config is a brand
  // asset reused across projects and directions, so a star on EITHER side is
  // the standing answer to "which weight when translating INTO this
  // language"; the panel does not (and need not) know which way THIS run
  // translates. Do not reintroduce "this time"/"only one can be used when
  // translating" (present tense reads as this-run and is false on the
  // side not being translated into), and do not write "has no effect now"
  // (same trap, inverted).
  // ⑪ (owner 2026-08-14): the sentence FORKS on this star's own state — the
  // previous generic wording ("the starred weight is the one used…") was true
  // on both stars but hovering a HOLLOW star no longer told you WHICH one.
  // Lesson pinned: a sentence that is true everywhere sometimes buys that
  // truth by dropping information; the fix is one sentence per state, not one
  // sentence for all states. Both carry the WHY (§12): the other language has
  // no one-for-one weight match, so one weight stands for the group.
  const RepStar = repInfo ? (
    <div role="button" tabindex="0" className={`rep ${repInfo.isRep ? 'is-rep' : ''}`}
      onClick={() => ctx.setPairRep(repInfo.pairId, repInfo.langCode, repInfo.libMember)}>
      <Icon name="star" size={13} fill={repInfo.isRep} />
      <span className="chip-pop">{repInfo.isRep
        ? 'The other language has no one-for-one weight match, so one weight stands for the group — when translating into this language, it is THIS one. Click another star to change that.'
        : 'The other language has no one-for-one weight match, so one weight stands for the group — when translating into this language, the OTHER starred weight is used, not this one. Click this star to use this one instead.'}</span>
    </div>
  ) : null;
  // #33d mitigation (owner 限期豁免的缓解件, 2026-08-13): when the REP was
  // picked by the machine (rep-normalize effect's first-connected invention,
  // NOT an operator star-click and NOT loaded from the config), say so on the
  // node. Hover = self-built .chip-pop, ONE sentence — which sentence forks on
  // provenance (owner: inherited state and feedback-to-a-gesture must not
  // share one line): 'load' = invented while opening the config, 'wire' =
  // invented right after the operator's own member-add. The chip TEXT stays
  // "auto-picked" for both (true either way; two words would be a second
  // vocabulary). The star right next to it is the existing change gesture, so
  // both sentences point there — no new gesture. The notice clears the moment
  // the operator clicks any star for this (pair, lang).
  const RepAutoTag = (repInfo && repInfo.isRep && repInfo.autoSet) ? (
    <span className="rep-auto-tag">
      auto-picked
      <span className="chip-pop">{repInfo.autoSource === 'load'
        ? 'This representative was picked automatically when the config was opened — the file named none for this language. Click a star to change it.'
        : 'A same-language member just joined, so a representative was picked automatically. Click a star to change it.'}</span>
    </span>
  ) : null;

  // 🔴 owner 2026-09-08 实测：hover `In doc × N` 弹出来的是 `Weight node`，而不是那个
  // chip 自己的 `In document · used in N places`（就在下面几十行）。两件事：
  //   ① 原生 title 在这个 webview 里【是活的】—— 我上一轮那条推断「面板里 45 个 title
  //      大概率也不显示」被这个读数直接推翻，作废。它当时就标着「推断不是实测」，
  //      而推翻它的正是 owner 一次 hover。
  //   ② 真正的问题是【节点级 title 盖住了它所有子元素的】。而它自己说的是 `Weight node`
  //      —— 对着一个明显就是字重节点的方框，信息量为零，却在压掉几十句有内容的解释。
  // ⇒ 去掉它。子元素的解释才浮得上来；同时也满足 owner「有小弹窗的都去掉原生注释」——
  //   这个节点里已经有三个 .chip-pop 子元素，而它的原生 tooltip 正好覆在它们上面。
  // ⚠ 判别性后果，一次 hover 即可验：去掉之后 hover `In doc × N` 应当显示
  //   `In document · used in N places`。若仍显示别的，说明还有第二层在盖。
  return (
    <div className={`node is-${state} ${used ? 'is-used' : 'is-unused'} ${dragging ? 'is-dragging' : ''} ${mode ? 'drop-' + mode : ''} ${node.kind === 'group' ? 'is-group' : ''} ${wireDim ? 'wire-dim' : ''} ${(ctx.hlDimNode && ctx.hlDimNode(addr)) ? 'hl-dim' : ''} ${tofuWarn ? 'is-tofu-warn' : ''} ${missWarn ? 'is-miss-warn' : ''}`}
      ref={hlRootRef}
      data-node={node.id}
      style={{ gap: "4px" }}>
      {/* TODO#83 — transparent hit area spanning the gap to each neighbour.
          It sits INSIDE the hover root, so pointerenter/leave on that root now
          cover the margin band too: #15 measured that entering a child does not
          re-fire the parent's enter and leaving into a child does not fire its
          leave, so the parent's hover region simply extends over this box.
          🔴 A real child, not ::before — .port proves absolutely-positioned real
          children hit-test here; "does a pseudo-element count as hit area" is an
          untested assumption in this webview and did not need to be bought.
          ⚠ It must stay FIRST and carry no background: it covers the whole node,
          so anything visible on it would paint over the content. Geometry lives
          in panel.css (.node-hit), tied to the 9px margin by an arithmetic test. */}
      <div className="node-hit" aria-hidden="true" />
      {/* #28e-port (W1's leftover half): port lighting is PER-SIDE — lit iff
          this side is the endpoint of a logical wire (ctx.portLit derives from
          the SAME deriveLogicalWires list the renderer draws). The node-level
          `hue` still colors the node state; it no longer lights both ports
          (a paired node's label-facing L port used to glow with no wire on
          that side — owner: 只有实际有连接的端口才变蓝). Fallback to `hue`
          only when ctx.portLit is absent (standalone preview shims). */}
      <Port ctx={ctx} side="L" addr={addr} hue={ctx.portLit ? ctx.portLit(addr, 'L') : hue} />

      <div className="node-grip" title="Drag to merge / reorder"
        onPointerDown={(e) => ctx.onStartNode(e, lang.id, font.id, node.id)}>
        <Icon name="grip" size={16} stroke={1.4} />
      </div>

      <div className="node-main">
        {node.kind === 'weight' ? (
          <div className="map-row">
            <span className="member-name is-static">{node.weight.actual}</span>
            <div className="map-right">
              {/* owner ⑦ (2026-08-13): the add-italic button sits LEFT of the
                  not-installed chip. */}
              {ItalicAdd}
              {((italicInfo && italicBase) && (_dragging || !hasCopy))
                ? <span className={"ital-slot" + (_dragging ? " ital-slot-drag" : "")} /> : null}
              {MissChip}
              {UnpairedChip}
              {used && (
                <span className="use-chip">
                  In doc{usedCount > 1 ? ` × ${usedCount}` : ''}
                  <span className="chip-pop">{`In document · used in ${usedCount} place${usedCount > 1 ? 's' : ''}`}</span>
                </span>
              )}
              {RepAutoTag}
              {RepStar}
            </div>
          </div>
        ) : (
          <div className="group-body">
            <div className="group-tag">
              <span className="merged-label">merged
                <span className="merged-pop">Acts as one weight</span>
              </span>
              {ItalicAdd}
              {((italicInfo && italicBase) && (_dragging || !hasCopy))
                ? <span className={"ital-slot" + (_dragging ? " ital-slot-drag" : "")} /> : null}
              {MissChip}
              {UnpairedChip}
              {RepAutoTag}
              {RepStar}
              {used && (
                <span className="use-chip">
                  In doc{usedCount > 1 ? ` × ${usedCount}` : ''}
                  <span className="chip-pop">{`In document · used in ${usedCount} place${usedCount > 1 ? 's' : ''}`}</span>
                </span>
              )}
              <div role="button" tabindex="0" className="unbind" onClick={() => ctx.unmergeAll(font.id, node.merge.id)}
                title="Unbind — split back into separate weights">unbind</div>
            </div>
            {node.members.map((m) => (
              <div className="map-row member" key={m.id}>
                <span className="member-name is-static">{m.actual}</span>
                <div className="map-right">
                  <div role="button" tabindex="0" className={`rep ${node.merge.rep === m.id ? 'is-rep' : ''}`}
                    title={node.merge.rep === m.id ? 'Representative weight' : 'Set as representative'}
                    onClick={() => ctx.setRep(font.id, node.merge.id, m.id)}>
                    <Icon name="star" size={13} fill={node.merge.rep === m.id} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Port ctx={ctx} side="R" addr={addr} hue={ctx.portLit ? ctx.portLit(addr, 'R') : hue} />
    </div>
  );
}

// ---- italic copy: a per-weight HOW declaration (univ-italic §3) -----------
// NOT a wireable node. The #17 ancestor of this component was an INDEPENDENT
// node with L/R ports that a source wired INTO, so the pairing machinery could
// derive a variant from it (the Y-model). §3 is explicit that the copy does not
// participate in pairing: it is the base weight's HOW declaration and nothing
// else. So: no ports, no wireConnectable, no unwired-Done warning, no node id of
// its own — it renders off the winner-keyed entry in ctx.data.italic_by_winner
// and its identity IS that key. An orphan is unrepresentable.
//
// Gate-4a (KEPT from #17, load-bearing): the slider DRAG uses NATIVE pointer
// listeners — React's delegated pointer events don't fire inside a UXP <dialog>;
// onClick and the degree <input> DO fire, so the chips/typing use React handlers.
function ItalicAngleInput({ value, onCommit }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  // A non-numeric commit REVERTS rather than committing: clampAngle maps garbage
  // to the 15° default, so committing a typo would silently rewrite a deliberate
  // 25° copy to 15° — a value change the operator never asked for and cannot see
  // they caused. Escape already reverts; blur must not be more destructive.
  const commit = () => {
    if (String(v).trim() === '' || !isFinite(Number(v))) { setV(String(value)); return; }
    onCommit(v);
  };
  // ② The ghost is a plain <span> that takes this control's place while a modal
  // question is up (panel.css .fap-modal-up). It exists because .iv-deg is the one
  // owner reported and it sits INLINE in a weight row: hiding the input outright
  // would collapse 30px and visibly shuffle the row behind the popup. It is
  // display:none the rest of the time, so it costs no layout (⚠ and therefore
  // measures 0x0 to a probe that reads it while hidden — CLAUDE #13d②).
  return (
    <React.Fragment>
      <input className="iv-deg mono" value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.target.blur(); }
          if (e.key === 'Escape') { setV(String(value)); e.target.blur(); }
        }}
        title="Slant angle 1–60° (editable). 0 is not offered: the apply side reads 0 as “no angle set” and substitutes 15°, so a copy shown as 0° would slant 15°. To stop this weight slanting, delete the copy." />
      <span className="iv-deg-ghost mono" aria-hidden="true">{v}</span>
    </React.Fragment>
  );
}

function ItalicVariantNode({ ctx, baseLabel, fontName, info, dimmed, hoverAddr }) {
  const IVK = (window.__fap && window.__fap.libItalicKeys) || null;
  const FX_MAX = (IVK && IVK.SKEW_MAX) || 30;
  const entry = info.entry;
  const isFaux = !!entry && entry.mode === 'faux';
  // Displayed angle is CLAMPED, because the store keeps entries verbatim (that is
  // what makes an untouched round-trip byte-equal) and an IMPORTED config can carry
  // values the panel itself would never author. Showing them raw makes the UI lie:
  // a stored `angle: 0` would render "0°" while lookup substitutes 15° — and this
  // very component's tooltip tells the operator that state cannot exist. A stored
  // 45 would show 45 with the slider pinned at max. So we show what would actually
  // apply. The stored value is still emitted verbatim until the operator edits it,
  // at which point clampAngle writes the shown value back.
  const rawDeg = (entry && typeof entry.angle === 'number') ? entry.angle
    : ((IVK && IVK.DEFAULT_FAUX_ANGLE) || 15);
  const deg = (IVK && typeof IVK.clampAngle === 'function') ? IVK.clampAngle(rawDeg) : rawDeg;
  const degIsCoerced = deg !== rawDeg;
  const pct = Math.max(0, Math.min(100, (deg / FX_MAX) * 100));
  const trackRef = useRef(null);

  // NOTE (review B1 — Rules of Hooks): useRef above + useEffect below are called
  // UNCONDITIONALLY every render, BEFORE any early return, so the hook count stays
  // stable on a surviving same-key fiber (e.g. when the mode flips to `real` and the
  // track stops rendering). The effect then no-ops via `!track`.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const degAt = (clientX) => {
      const r = track.getBoundingClientRect();
      const ratio = r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
      return Math.round(ratio * FX_MAX);
    };
    let dragging = false;
    const onDown = (e) => {
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch (er) {}
      ctx.setItalicAngle(info.key, degAt(e.clientX)); e.stopPropagation();
    };
    const onMove = (e) => { if (dragging) ctx.setItalicAngle(info.key, degAt(e.clientX)); };
    const onUp = (e) => { dragging = false; try { track.releasePointerCapture(e.pointerId); } catch (er) {} };
    track.addEventListener('pointerdown', onDown);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onUp);
    return () => {
      track.removeEventListener('pointerdown', onDown);
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
      track.removeEventListener('pointercancel', onUp);
    };
  }, [info.key, FX_MAX]);

  // #69 (owner 2026-08-22: hovering the copy row gives no feedback, and it does
  // not read as part of its base's group). MEASURED before changing anything
  // (rig 20260822_02 section 2b): hovering this row dimmed 0/7 nodes — it was
  // never a hover SOURCE. It already works as a dim TARGET (hovering an unrelated
  // weight dims it 1/1), so only the arming half was missing.
  // 🔴 It reports its BASE's address, not one of its own: this row has no port
  // and belongs to no pairing, so the relation set it lives in is exactly its
  // base's. Sending a private address would highlight a set of one and make the
  // row look MORE detached, not less.
  // Same NATIVE pointerenter/leave as WeightNode — React synthetic hover does not
  // dispatch in this dialog (app.jsx:1797 / probe 20260813_16).
  const ivRootRef = React.useRef(null);
  const ivCtxRef = React.useRef(ctx);
  ivCtxRef.current = ctx;
  const ivAddrKey = hoverAddr ? (hoverAddr.lang + ":" + hoverAddr.font + ":" + hoverAddr.node) : "";
  React.useEffect(() => {
    const el = ivRootRef.current;
    if (!el || !hoverAddr) return;
    const a = { lang: hoverAddr.lang, font: hoverAddr.font, node: hoverAddr.node };
    const enter = () => { const c = ivCtxRef.current; if (c.onNodeHover) c.onNodeHover(a); };
    const leave = () => { const c = ivCtxRef.current; if (c.onNodeHover) c.onNodeHover(null); };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
    };
  }, [ivAddrKey]);

  if (!entry) return null;

  // The copy can sit under a node that is NOT its own winner: a whole-range-swap
  // source (CJK→CJK / Latin→Latin) has its runs re-fonted onto the pair's target,
  // so the config is stored — and shown — under THAT font. Say so instead of
  // letting the operator think this column is what slants.
  const viaPair = info.winner && info.winner.viaPair;
  const target = viaPair ? (info.winner.font + ' ' + info.winner.weight) : null;
  // No target language picked yet AND a pair could still swap this weight away →
  // which font this copy ends up describing is not decided. Say it out loud; a
  // copy stored under a font that carries nothing after import is precisely the
  // silent miss this editor is keyed to avoid.
  const undecided = info.winner && info.winner.indeterminate;

  return (
    <div ref={ivRootRef} className={`node italic-variant-node ${dimmed ? 'hl-dim' : ''}`} data-italic-key={info.key}
      title={'Italic copy — how this weight slants. The base weight is untouched'
        + (viaPair ? ('; applies to ' + target + ', which this weight maps onto') : '')
        + '. Hover the mode chips for what each does.'}>
      <div className="node-main">
        <div className="iv-head">
          {/* 🔴 The ↳ that used to sit here was placed for an AC⑧ clause — and AC⑧
              was RETIRED on 2026-08-19 (TODO.md:1277, `#54ⓒ-定案`, owner's own call).
              Its ONLY surviving half is 「base 行本身不被改写」 (row shape stability),
              which this element never carried.
              ⚠ So the comment that stood here was stale for four days before it was
              touched — and the first rewrite of it (same commit, corrected here) said
              “AC⑧ is now carried by …”, i.e. handed a RETIRED clause forward as if live.
              ⚠ 「AC⑧」 is overloaded in this repo: at :453 it means “the chip goes inert”,
              in task_plan it means referential integrity and rename-safety. Citing it
              without naming the clause is how a dead one keeps getting quoted.
              What actually marks this row as a copy: `.iv-copy-tag` “italic copy”
              plus the 26px indent on `.italic-variant-node`.
              🔴 The `↳` glyph that used to sit here was REMOVED per owner
              2026-08-23 (TODO#79, ruling 3A). His reason, verbatim:
              「这是副本，可通过字重中的斜体标签表示」.
              ⚠ This edits an ACCEPTED AC, so it is recorded here rather than left as a
              silent deletion — and the comment is rewritten with it: a comment that
              still explains a removed element reads as if it were still true.
              ⚠ The `↳` also carried a title (“Derived from … which is itself
              unchanged”). That sentence survives on the PARENT node's own title
              (“Italic copy — how this weight slants. The base weight is untouched”),
              via the same title mechanism — verified before deleting, not assumed. */}
          <span className="iv-copy-name">{baseLabel}</span>
          <span className="iv-copy-tag">italic copy</span>
          {/* #41 — auto-added notice. owner 2026-08-13 (supersedes the earlier
              "show the angle in the notice"): the chip says WHY, the slider
              below says HOW MUCH — repeating the number here was redundant
              (the angle is already visible and editable one row down). Hover =
              self-built .chip-pop, ONE sentence stating the trigger conditions
              from the code path (translator italic demand in THIS package +
              this weight had no italic configured — computeAutoFauxAdditions's
              exact predicate). Rendered ONLY for entries added THIS session
              (ctx.autoFauxKeys); a config-loaded entry was already accepted
              and shows nothing (约束二: first time, per-weight). */}
          {ctx.autoFauxKeys && ctx.autoFauxKeys[info.key] && (
            <span className="iv-auto-tag">
              auto-added
              <span className="chip-pop">This italic copy was added by the machine because the package contains translator-marked italics on this weight and it had no italic set up — the slider below sets the angle.</span>
            </span>
          )}
          {viaPair && <span className="iv-via" title={'Stored on the paired target: ' + target}>→ {target}</span>}
          {undecided && (
            <span className="iv-undecided"
              title="No primary (target) language is selected, and this weight is paired across languages — so whether it keeps its own font or is swapped onto its pair's target is not decided yet. Pick the Primary language in the top bar to pin where this copy applies.">
              ⚠ pick Primary lang
            </span>
          )}
          <div role="button" tabindex="0" className="iv-del"
            title={'Delete italic copy — asks first. This weight then stops slanting (it is surfaced as unconfigured, like an unpaired weight).'
              + (viaPair ? ' This is the ONE entry for ' + target + ': every weight that maps onto it shows the same copy, and deleting it here removes it for all of them.' : '')}
            onClick={async () => {
              // 🔴 owner 2026-08-22 eye-verify: 「直接点 x 无弹窗但正常移除」.
              // The confirm was wired onto the `I` button only, so THIS path —
              // the one that looks most like a delete — deleted with no question.
              // owner's 08-20 ruling was about the ACTION (delete an italic copy),
              // not about one button, so both entry points ask the same thing,
              // through the same function, with the same wording.
              // ⚠ Do not "simplify" by asking in only one place again: these are
              // two different components, and the ✕ is the obvious one to reach for.
              fapTrace('X:click', { base: baseLabel, font: fontName });
              let yes = false;
              try {
                yes = await confirmItalicDelete(fontName || (info.winner && info.winner.font) || '', baseLabel);
              } catch (e) {
                fapTrace('X:confirm:threw', String(e && e.message || e));
                return;   // same fail-closed rule as the I path
              }
              fapTrace('X:confirm:result', { deleted: yes });
              if (yes) ctx.deleteItalicVariant(info.key);
            }}>
            <Icon name="x" size={11} />
          </div>
        </div>
        {/* NO real/faux selector. A copy is ALWAYS faux (user 2026-08-07,
            charter §7.4: "真斜体不是一种实现方式"). A real italic face is a
            WEIGHT, not an implementation choice — a run already using one keeps
            it untouched and needs no config at all, so there is nothing for the
            operator to pick between here. Building a faux copy on a weight that
            HAS a real italic stays legal: wanting more slant than the real face
            is a legitimate intent, and it is not this program's place to rule
            that a downgrade. `mode:"real"` remains in the schema and reachable by
            hand-editing the config, which is why the apply path keeps its block
            as a safety floor — it is simply not authorable here. */}
        {!isFaux && (
          <div className="iv-mode-row">
            <span className="iv-cap is-none"
              title="This entry says mode:&quot;real&quot;, which this panel no longer authors — it came from a hand-edited config. Left exactly as it is; the apply path still honours it (and blocks if the exact italic face is missing). Drag an angle to convert it to a faux copy.">
              mode: real (from file)
            </span>
          </div>
        )}
        {isFaux && (
          <div className="iv-slider-row">
            <div className="iv-track" ref={trackRef} title="Drag to set slant 1–60°">
              <div className="iv-fill" style={{ width: pct + '%' }} />
              <div className="iv-knob" style={{ left: pct + '%' }} />
            </div>
            <ItalicAngleInput value={deg} onCommit={(val) => ctx.setItalicAngle(info.key, val)} />
            <span className="iv-unit">°</span>
            {degIsCoerced && (
              <span className="iv-undecided"
                title={'This copy was imported with angle ' + rawDeg + ', which is outside the 1–30° the panel writes. '
                  + deg + '° is what would actually apply. Editing the angle stores ' + deg + '°.'}>
                ⚠ was {rawDeg}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- shared picker drag-scroll + custom thumb hook ------------------------
// Used by both FamilyPickerCard (font family list) and LangPickerColumn
// (language preset list). UXP modal <dialog> native scrollbar is unstyleable
// + non-responsive to drag in nested transform context (verified 2026-06-07
// scroll probe); JS drag-to-scroll on list body + custom thumb overlay
// + clip-overhang width hide the native bar. Returns dragStateRef so callers
// can suppress accidental item-select after a drag (check .moved in onClick).
function usePickerScroll(listRef, thumbRef) {
  const dragStateRef = useRef(null);
  const thumbDragRef = useRef(null);
  const DRAG_THRESHOLD = 4;
  useEffect(() => {
    const list = listRef.current;
    const thumb = thumbRef.current;
    if (!list) return;
    const syncThumb = () => {
      if (!thumb) return;
      const trackH = list.clientHeight;
      const contentH = list.scrollHeight;
      if (contentH <= trackH) { thumb.style.display = 'none'; return; }
      thumb.style.display = '';
      const thumbH = Math.max(24, (trackH / contentH) * trackH);
      const range = trackH - thumbH;
      const ratio = contentH > trackH ? list.scrollTop / (contentH - trackH) : 0;
      thumb.style.height = thumbH + 'px';
      thumb.style.top = (ratio * range) + 'px';
    };
    syncThumb();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(syncThumb) : null;
    if (ro) ro.observe(list);
    list.addEventListener('scroll', syncThumb);
    const onListDown = (e) => {
      if (e.target && e.target.closest && e.target.closest('.picker-thumb')) return;
      dragStateRef.current = { sy: e.clientY, st: list.scrollTop, pid: e.pointerId, moved: false };
      try { list.setPointerCapture(e.pointerId); } catch (er) {}
    };
    const onListMove = (e) => {
      const d = dragStateRef.current;
      if (!d) return;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.abs(dy) > DRAG_THRESHOLD) d.moved = true;
      if (d.moved) { list.scrollTop = d.st - dy; syncThumb(); }
    };
    const onListUp = (e) => {
      const d = dragStateRef.current;
      if (!d) return;
      try { list.releasePointerCapture(e.pointerId); } catch (er) {}
      setTimeout(() => { dragStateRef.current = null; }, 0);
    };
    list.addEventListener('pointerdown', onListDown);
    list.addEventListener('pointermove', onListMove);
    list.addEventListener('pointerup', onListUp);
    list.addEventListener('pointercancel', onListUp);
    const onThumbDown = (e) => {
      if (!thumb) return;
      e.stopPropagation();
      const trackH = list.clientHeight;
      const thumbH = thumb.offsetHeight;
      thumbDragRef.current = { sy: e.clientY, startTop: parseFloat(thumb.style.top) || 0, range: trackH - thumbH, pid: e.pointerId };
      try { thumb.setPointerCapture(e.pointerId); } catch (er) {}
    };
    const onThumbMove = (e) => {
      const d = thumbDragRef.current;
      if (!d || d.range <= 0) return;
      const dy = e.clientY - d.sy;
      const newTop = Math.max(0, Math.min(d.range, d.startTop + dy));
      const ratio = newTop / d.range;
      list.scrollTop = ratio * (list.scrollHeight - list.clientHeight);
      syncThumb();
    };
    const onThumbUp = (e) => {
      const d = thumbDragRef.current;
      if (!d) return;
      try { thumb.releasePointerCapture(e.pointerId); } catch (er) {}
      thumbDragRef.current = null;
    };
    if (thumb) {
      thumb.addEventListener('pointerdown', onThumbDown);
      thumb.addEventListener('pointermove', onThumbMove);
      thumb.addEventListener('pointerup', onThumbUp);
      thumb.addEventListener('pointercancel', onThumbUp);
    }
    return () => {
      if (ro) ro.disconnect();
      list.removeEventListener('scroll', syncThumb);
      list.removeEventListener('pointerdown', onListDown);
      list.removeEventListener('pointermove', onListMove);
      list.removeEventListener('pointerup', onListUp);
      list.removeEventListener('pointercancel', onListUp);
      if (thumb) {
        thumb.removeEventListener('pointerdown', onThumbDown);
        thumb.removeEventListener('pointermove', onThumbMove);
        thumb.removeEventListener('pointerup', onThumbUp);
        thumb.removeEventListener('pointercancel', onThumbUp);
      }
    };
  }, []);
  return dragStateRef;
}

// ---- language picker column (inline, replaces LanguageColumn while pending) -
// Triggered by "+ Add language" — same UX as FamilyPickerCard but at the
// column level. User picks lang preset inline; finalizePendingLang then
// sets the lang fields and pushes a pending font card (which renders as
// FamilyPickerCard, completing the two-step add flow without overlays).
function LangPickerColumn({ ctx, lang }) {
  const [query, setQuery] = useState('');
  const presentCodes = ctx.data.languages
    .filter(l => !l.pendingLang && l.code)
    .map(l => l.code);
  // Keep ALL presets in list; mark already-added with `isPresent` and render
  // them grayed out + disabled (user requested 2026-06-07 — visual cue that
  // they exist already, vs silently filtering them out).
  const presets = (window.LANG_PRESETS || []).map(p =>
    Object.assign({}, p, { isPresent: presentCodes.includes(p.code) })
  );
  const q = query.trim();
  const ql = q.toLowerCase();
  // Filter presets by code OR resolved Intl.DisplayNames OR preset.name
  const resolveName = window.getLangDisplayName || ((c, f) => f || c);
  const filtered = q
    ? presets.filter(p => {
        if (p.code.toLowerCase().indexOf(ql) >= 0) return true;
        if (p.name.toLowerCase().indexOf(ql) >= 0) return true;
        var disp = resolveName(p.code, p.name);
        if (disp && disp.toLowerCase().indexOf(ql) >= 0) return true;
        return false;
      })
    : presets;

  // Free BCP 47 input: if query looks like a valid tag AND isn't already in
  // filtered list / present columns, surface "Add custom tag" affordance.
  const isValid = window.isValidBcp47 || ((t) => !!t);
  const queryLooksLikeTag = q && isValid(q);
  const queryAlreadyPresent = q && presentCodes.indexOf(q) >= 0;
  const queryInPresets = q && presets.some(p => p.code.toLowerCase() === ql);
  const showCustom = queryLooksLikeTag && !queryAlreadyPresent && !queryInPresets;

  const listRef = useRef(null);
  const thumbRef = useRef(null);
  const dragStateRef = usePickerScroll(listRef, thumbRef);

  const onItemClick = (e, preset) => {
    if (dragStateRef.current && dragStateRef.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (preset.isPresent) {
      // Already in another column — no-op click, just visual feedback
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    ctx.finalizePendingLang(lang.id, preset);
  };
  const onCustomClick = (e) => {
    if (dragStateRef.current && dragStateRef.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    var preset = {
      code: q,
      name: resolveName(q, q),
      script: 'Ag',
      family: "'Hanken Grotesk'",
    };
    ctx.finalizePendingLang(lang.id, preset);
  };

  // Render as the SAME visual unit as FamilyPickerCard — single .font-card
  // .font-card-picker. Wrapped in .column.column-picker which is made
  // transparent/borderless via CSS so only the inner card shows (no
  // double-frame). Provides the 300px column slot for canvas-inner layout.
  return (
    <div className="column column-picker">
      <div className="font-card font-card-picker" title={devTitle(ctx,"Pick a language")}>
        <div className="font-head">
          <span className="font-name picker-title">Pick a language</span>
          <div role="button" tabindex="0" className="icon-btn"
            title={devTitle(ctx,"Cancel")} onClick={() => ctx.removeLang(lang.id)}>
            <Icon name="x" size={15} />
          </div>
        </div>
        <div className="picker-search">
          <Icon name="search" size={13} stroke={1.7} />
          <input
            className="picker-search-input"
            placeholder="Search or type BCP 47 tag (e.g. bo-CN)…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <div role="button" tabindex="0" className="picker-search-clear"
              title={devTitle(ctx,"Clear")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setQuery('')}>
              <Icon name="x" size={11} stroke={1.9} />
            </div>
          )}
        </div>
        <div className="picker-list-wrap">
          <div className="picker-list" ref={listRef}>
            {showCustom && (
              <div role="button" tabindex="0" className="picker-item picker-item-custom"
                onClick={onCustomClick}
                title={"Add custom BCP 47 tag: " + q}>
                <span className="picker-item-name">
                  + Add <span className="mono">{q}</span> · {resolveName(q, q)}
                </span>
                <span className="picker-item-count">custom</span>
              </div>
            )}
            {filtered.length === 0 && !showCustom && (
              <div className="picker-empty">No matches</div>
            )}
            {filtered.map(preset => {
              const disp = resolveName(preset.code, preset.name);
              return (
                <div role="button" tabindex="0" key={preset.code}
                  className={"picker-item" + (preset.isPresent ? " picker-item-disabled" : "")}
                  onClick={(e) => onItemClick(e, preset)}
                  title={preset.isPresent
                    ? disp + " (" + preset.code + ") — already added"
                    : disp + " (" + preset.code + ")"}>
                  <span className="picker-item-name">{disp}</span>
                  <span className="picker-item-count">
                    {preset.isPresent ? "added" : preset.code}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="picker-thumb" ref={thumbRef} />
        </div>
      </div>
    </div>
  );
}

// ---- family picker card (inline, replaces FontCard while pending) ---------
// User clicks "+ Add font" or "+ Add language" → a pending font is pushed
// into the column. This card renders in its place with a search input + a
// scrollable list of installed font families. Click a family →
// ctx.finalizePendingFont(lang, font, familyName) replaces the pending font
// with the real one (full weight list auto-populated).
function FamilyPickerCard({ ctx, lang, font }) {
  const [query, setQuery] = useState('');
  const families = ctx.installedFamilies || {};
  const names = Object.keys(families).sort();
  const q = query.trim().toLowerCase();
  const filtered = q ? names.filter(n => n.toLowerCase().indexOf(q) >= 0) : names;
  const MAX_SHOW = 120; // long lists kill paint; refine search to narrow
  const shown = filtered.slice(0, MAX_SHOW);
  const overflow = filtered.length - shown.length;

  // Drag-to-scroll list body + custom thumb — see usePickerScroll comment.
  const listRef = useRef(null);
  const thumbRef = useRef(null);
  const dragStateRef = usePickerScroll(listRef, thumbRef);

  const onItemClick = (e, name) => {
    if (dragStateRef.current && dragStateRef.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    ctx.finalizePendingFont(lang.id, font.id, name);
  };
  return (
    <div className="font-card font-card-picker" title={devTitle(ctx,"Pick a font family")}>
      <div className="font-head">
        <span className="font-name picker-title">Pick a font family</span>
        <div role="button" tabindex="0" className="icon-btn"
          title={devTitle(ctx,"Cancel")} onClick={() => ctx.removeFont(lang.id, font.id)}>
          <Icon name="x" size={15} />
        </div>
      </div>
      <div className="picker-search">
        <Icon name="search" size={13} stroke={1.7} />
        <input
          className="picker-search-input"
          placeholder="Search font family…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)} />
        {query && (
          <div role="button" tabindex="0" className="picker-search-clear"
            title={devTitle(ctx,"Clear")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setQuery('')}>
            <Icon name="x" size={11} stroke={1.9} />
          </div>
        )}
      </div>
      <div className="picker-list-wrap">
        <div className="picker-list" ref={listRef}>
          {shown.length === 0 && (
            <div className="picker-empty">No matches</div>
          )}
          {shown.map(name => (
            <div role="button" tabindex="0" key={name} className="picker-item"
              onClick={(e) => onItemClick(e, name)}
              title={name}>
              <span className="picker-item-name">{name}</span>
              <span className="picker-item-count">{(families[name] || []).length}w</span>
            </div>
          ))}
          {overflow > 0 && (
            <div className="picker-empty">+ {overflow} more · refine search</div>
          )}
        </div>
        {/* Custom thumb overlays the (non-responsive) native InDesign
            scrollbar — gives the user an actual draggable scroll handle. */}
        <div className="picker-thumb" ref={thumbRef} />
      </div>
    </div>
  );
}

// ---- font card -------------------------------------------------------------
// Focus mode: no role chip, no add weight, no role menu. "More" menu only
// has Remove font (matching v2 §5.6 Focus reduction).
function FontCard({ ctx, lang, font }) {
  if (font.pendingFamily) {
    return <FamilyPickerCard ctx={ctx} lang={lang} font={font} />;
  }
  // 8D-ext-A.1: fold eg merged_in weights into the canonical (presentation-only).
  // A family whose every weight is folded renders nothing — it disappears into
  // the canonical's card.
  const foldedSet = window.egFoldedWeightSet(ctx.data && ctx.data.equivalence_groups, lang.code,
    ctx.mmFoldSkipByLang && ctx.mmFoldSkipByLang[lang.code]);
  const { nodes, folded } = window.deriveVisibleNodes(font, foldedSet);
  if (folded) return null;
  const moreMenu = (e) => ctx.openMenu(e.currentTarget, [
    { head: 'Font' },
    { label: 'Remove font', danger: true, onClick: () => ctx.removeFont(lang.id, font.id) },
  ]);
  // owner 2026-09-08：这里原有一个卡片级的原生 tooltip，内容是卡片名本身（同义反复）。
  // 祖先的 title 会盖住它全部子元素的，所以它在用一句零信息量的话压掉下面每个节点上的
  // 具体解释。去掉 .node 那一层之后浮上来的正是它（owner 实测：先看到节点级那句，
  // 去掉后看到卡片级这句）。⇒ column / font-card / node 是同一条遮挡链，一次拆完，
  // 否则每去一层就露出下一层，owner 要反复回报。
  return (
    <div className="font-card">
      <div className="font-head">
        <Editable value={font.name} onCommit={(v) => ctx.setFontName(font.id, v)}
          className="font-name" title="Font name — double-click to edit" />
        <div role="button" tabindex="0" className="icon-btn" title={devTitle(ctx,"More")} onClick={moreMenu}><Icon name="more" size={15} /></div>
      </div>
      <div className="nodes">
        {nodes.map((n) => {
          // univ-italic §3: the italic copy renders as a visible derived sibling
          // right under its base weight. It is presentation of the winner-keyed
          // entry, not a node in the graph — hence no id of its own and no ports.
          const base = window.italicBaseWeightOf(n);
          const ii = (ctx.italicInfo && base) ? ctx.italicInfo(lang.code, font.name, base) : null;
          return [
            <WeightNode key={n.id} ctx={ctx} lang={lang} font={font} node={n} italicInfo={ii} italicBase={base} />,
            (ii && ii.entry)
              ? <ItalicVariantNode key={n.id + '__ital'} ctx={ctx} baseLabel={base} fontName={font.name} info={ii}
                  /* #69: hovering the copy arms its BASE's relation set. */
                  hoverAddr={{ lang: lang.id, font: font.id, node: n.id }}
                  /* #45: the derived copy is visually glued under its base
                     weight — it follows THAT node's dim state (dimming the
                     base but not the copy reads as a broken card). */
                  dimmed={ctx.hlDimNode ? ctx.hlDimNode({ lang: lang.id, font: font.id, node: n.id }) : false} />
              : null
          ];
        })}
      </div>
    </div>
  );
}

// ---- language column -------------------------------------------------------
function LanguageColumn({ ctx, lang }) {
  if (lang.pendingLang) {
    return <LangPickerColumn ctx={ctx} lang={lang} />;
  }
  // 同上，再上一层：这里原有一个列级的原生 tooltip，内容同样是元素名本身。见 font-card
  // 那处的说明；三层一次拆完。
  return (
    <div className="column" style={{ fontFamily: 'var(--ui)' }}>
      <div className="col-head">
        <span className="specimen" style={{ fontFamily: lang.family }} title={devTitle(ctx,"Script specimen")}>{lang.script}</span>
        <div className="col-titles">
          <Editable value={lang.name} onCommit={(v) => ctx.setLangName(lang.id, v)}
            className="col-name" title="Language name — double-click to edit" />
          <span className="col-code mono" title={devTitle(ctx,"Language code")}>{lang.code}</span>
        </div>
        <div role="button" tabindex="0" className="icon-btn" title={devTitle(ctx,"Language menu")}
          onClick={(e) => ctx.openMenu(e.currentTarget, [
            { label: 'Remove language', danger: true, onClick: () => ctx.removeLang(lang.id) },
          ])}>
          <Icon name="more" size={15} />
        </div>
      </div>
      <div className="col-body">
        {lang.fonts.map((f) => <FontCard key={f.id} ctx={ctx} lang={lang} font={f} />)}
        <div role="button" tabindex="0" className="add-font" onClick={(e) => ctx.addFont(lang.id, e.currentTarget)} title={devTitle(ctx,"Add font")}>
          <Icon name="plus" size={14} /> Add font
        </div>
      </div>
    </div>
  );
}

// ---- unified-weight label card (left naming lane) -------------------------
function LabelCard({ ctx, pairing, top }) {
  const addr = { lang: '__label__', font: pairing.id, node: '' };
  // #54ⓑ (owner 「应该」): the label card is a hover trigger, same wiring as
  // WeightNode — native pointerenter/leave (probe-verified semantics, React
  // synthetic hover doesn't dispatch here) feeding the SAME ctx.onNodeHover /
  // hoverHl. The label pseudo-addr resolves inside computeHoverRelationSet to
  // the pairing's full member set + pid — identical to hovering a member.
  const hlRootRef = React.useRef(null);
  const hlCtxRef = React.useRef(ctx);
  hlCtxRef.current = ctx;
  React.useEffect(() => {
    const el = hlRootRef.current;
    if (!el) return;
    const a = { lang: '__label__', font: pairing.id, node: '' };
    const enter = () => { const c = hlCtxRef.current; if (c.onNodeHover) c.onNodeHover(a); };
    const leave = () => { const c = hlCtxRef.current; if (c.onNodeHover) c.onNodeHover(null); };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
    };
  }, [pairing.id]);
  const linked = pairing.labelLinked;
  const drag = ctx.drag;
  const wireActive = drag && drag.type === 'wire';
  const isWireSource = wireActive && drag.from && drag.from.lang === '__label__' && drag.from.font === pairing.id;
  const wireDim = wireActive && !isWireSource && !ctx.wireConnectable(addr);
  const labelMenu = (e) => ctx.openMenu(e.currentTarget, [
    { head: 'Unified weight name' },
    { search: true, placeholder: `Current: ${pairing.label || 'Unnamed'} · type or pick`, submit: (v) => ctx.setPairingLabel(pairing.id, v) },
    ...window.SEMANTIC_WEIGHTS.map((s) => ({
      label: s, checked: pairing.label === s, onClick: () => ctx.setPairingLabel(pairing.id, s),
    })),
  ]);
  return (
    <div ref={hlRootRef} className={`label-card ${linked ? 'is-linked' : 'is-loose'} ${wireDim ? 'wire-dim' : ''} ${(ctx.hlDimPid && ctx.hlDimPid(pairing.id)) ? 'hl-dim' : ''}`} style={{ top }}
      title={linked ? 'Unified weight name' : 'Unified weight name — not linked; drag a weight\'s port onto this card\'s port to connect'}>
      {/* #54ⓐ (owner 2026-08-14): chevron removed so the ✕ sits at the right
          edge consistently — the name stays clickable (title carries the
          affordance), and the freed width feeds the ✕↔port gap (#51 high-risk:
          port hover-scale used to overlap the ✕ by ~0.9px). */}
      <div role="button" tabindex="0" className="label-name" onClick={labelMenu} title="Weight name — click to edit">
        <span className="lc-txt">{pairing.label || 'Unnamed'}</span>
      </div>
      <div role="button" tabindex="0" className="label-x" title="Remove unified weight" onClick={() => ctx.removePairing(pairing.id)}>
        <Icon name="x" size={11} stroke={1.9} />
      </div>
      <Port ctx={ctx} side="R" addr={addr} hue={linked ? pairing.hue : null} title="Label port — its wires are derived from the pairing; to link, drag a weight's port onto it" />
    </div>
  );
}

// ─── Phase 8D-ext-0 components ─────────────────────────────────────────

// D4 EnforcerToggle: checkbox controlling the post-apply script_font_enforcer
// pass. Default ON. The entry script also runs eligibility detection; if
// doc has no `_T_Latin_*` GREP + CJK psFont co-style, the enforcer call is
// a no-op (panel still records user intent).
function EnforcerToggle({ value, onChange, eligibility }) {
  const tooltip = eligibility && eligibility.reasons && eligibility.reasons.length
    ? "Enforcer not applicable: " + eligibility.reasons.join("; ")
    : "Run script_font_enforcer after font apply — fixes naked Latin chars in mixed-script paragraphs";
  return (
    <label className="enforcer-toggle" title={tooltip}>
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="enforcer-toggle-label">Apply script font enforcer</span>
      {eligibility && eligibility.reasons && eligibility.reasons.length ? (
        <span className="enforcer-toggle-warn">(not applicable)</span>
      ) : null}
    </label>
  );
}

// 🪦 ConfirmableMergeBanner REMOVED (owner 2026-08-20, TODO#58).
// It asked "family X has both <Book> and <Regular> in this doc — merge them?".
// owner retired that question outright: 「只有在当前实现下确认可合并的且不在配置
// 文件中的再合并，其他不合并也不提醒」— the collision set is now neither merged
// nor mentioned.
//
// 🔴 Two things worth keeping straight for whoever reads #56 later:
//   1. It is RETIRED, not repaired. #56 reported these buttons "doing nothing";
//      the 2026-08-20 diagnosis showed the merge really happened and was simply
//      invisible (egFoldedWeightSet folds cross-family only). Reviving this
//      banner revives that defect.
//   2. Its two controls were raw <button> elements — the #56 tag. Deleting the
//      component takes those 2 with it. 🔴 The OTHER 3 raw <button> sites in
//      this file (RecombinationReviewStrip's unmerge, and the two ul-skip-btn)
//      are DELIBERATELY untouched: they belong to live features and are still
//      #56's business. Do not read this removal as "#56 is handled".
// RecombinationReviewStrip — review + undo for groups the machine made unasked.
// (Name kept for the CSS/consumer surface; it is no longer recombination-specific.)
//
// 🔴 TODO#58 (2026-08-20) — THE CLAIM THIS STRIP MAKES ON SCREEN CHANGED.
// It used to say "judged by name", and that was honest: A.1 grouped spellings via
// normalize() + STYLE_ALIAS_TABLE. The criterion is now FACE IDENTITY — two
// spellings are merged only when the font engine reports the same
// `Font.postscriptName` for both, with `status === "INSTALLED"` and a non-empty
// name required (measured: two unrelated NOT_AVAILABLE faces both report "" and
// do not throw, so a bare equality test merges strangers). Leaving the old
// wording would have told the operator to double-check a guess that is no longer
// being made — and would have hidden what they SHOULD check: everything the
// criterion could not prove and therefore did NOT merge (TODO#58 (5) readout).
//
// 🪦 The old "KNOWN LIMITATION: an eg from an IMPORTED config folds in the tree
// but has no un-merge row" is FIXED, by the fix its own note proposed: `merged`
// is now DERIVED from data.equivalence_groups (every `_origin: machine-auto` eg),
// so the scan's batch and the panel's batch both get a row. An imported config's
// egs still have no row — deliberately: `_origin` is stripped at export (#33d), so
// after a round trip a machine-made entry is indistinguishable from a curated one
// and the machine must not claim the right to retract it.
//
// Groups may now be SAME-family (Gotham Book ≡ Gotham Regular — one face, two
// names), so the copy no longer says "across families".
//
// 🪦 READ-ONLY since owner's 姿态甲 (2026-08-20). The Un-merge button is gone.
// owner did not ask "do we want un-merge?" — he asked 「目前确定合并的都肯定是应该
// 被合并的吗，有没有误合并的可能性，没有的话就不加上可拆的逻辑了」, and the two
// measurements said the control was already doubly lame: un-merge was LOSSY
// (unmergeAll sends every re-pointed member back to the rep), and its dismissal
// was session-only state, so an un-merged group came straight back on reopen.
// 🔴 This strip answers the VISIBILITY half of owner's ask, which is the half
// that survived. Do not restore the button because this comment mentions it —
// earn it with a real observed mis-merge first.
// `merged` records: { normalized_key, canonical:{font,weight,homeLang},
//                     members:[{family,style,used,...}] }.
function RecombinationReviewStrip({ merged }) {
  if (!Array.isArray(merged) || merged.length === 0) return null;
  return (
    <div className="confirmable-merge-banner recombination-banner recombination-review">
      <div className="cmb-title">
        Auto-merged {merged.length} font spelling{merged.length !== 1 ? 's' : ''} that name the same face:
      </div>
      <div className="cmb-subnote">
        The font engine reports one installed face under both names, so they are
        one row and you connect them once.
      </div>
      {merged.map((g, i) => {
        const canon = g.canonical || {};
        const others = (g.members || []).filter(
          m => !(m.family === canon.font && m.style === canon.weight));
        return (
          <div key={g.normalized_key || i} className="cmb-row recombination-row">
            <span className="cmb-info">
              <span className="recomb-member is-canonical">
                <strong>{canon.font}</strong>
                <span className="recomb-style"> / {canon.weight || "Regular"}</span>
                <span className="recomb-meta"> (canonical)</span>
              </span>
              {others.map((m, mi) => (
                <span key={mi} className="recomb-member">
                  <span className="recomb-equiv"> · </span>
                  <strong>{m.family}</strong>
                  <span className="recomb-style"> / {m.style || "Regular"}</span>
                  <span className="recomb-meta"> (used {m.used || 0})</span>
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// 8D-ext-B (2026-06-09) — UnresolvedLangSection
// Renders per-lang sections of unresolved (pair, sourceFont, sourceWeight) buckets
// from `unresolvedByLang` (provided by lib/font_mapping_doc_scan.buildUnresolvedByLang).
// Each lang section groups its rows by pair so user can see exactly which pair is
// missing a member for that lang. Per-row actions:
//   • "Pick font..." (select) — calls addPairMember(pairingId, lang, font, weight)
//       Triggers re-scan upstream so the row disappears when resolved.
//   • "Skip & Continue" — calls setSkip(pairingId, lang, 'skip') so applyOnePara
//       silently ignores actions matching this (pair, lang).
// Empty unresolvedByLang → component renders nothing (no DOM cost).
function UnresolvedLangSection({ ctx }) {
  if (!ctx) return null;
  const { unresolvedByLang, skipDecisions, setSkip, addPairMember, data } = ctx;
  if (!unresolvedByLang) return null;
  const langs = Object.keys(unresolvedByLang).filter(
    code => Array.isArray(unresolvedByLang[code]) && unresolvedByLang[code].length > 0
  );
  if (langs.length === 0) return null;

  function langLabel(code) {
    const l = (data && data.languages || []).find(x => x.code === code);
    return l ? l.name : code;
  }
  function fontsForLang(code) {
    const l = (data && data.languages || []).find(x => x.code === code);
    if (!l) return [];
    const out = [];
    (l.fonts || []).forEach(f => {
      (f.weights || []).forEach(w => {
        const weightStr = w.actual || w.semantic || "";
        if (weightStr) out.push({ font: f.name, weight: weightStr });
      });
    });
    return out;
  }

  return (
    <div className="unresolved-lang-sections">
      {langs.sort().map(lang => {
        const rows = unresolvedByLang[lang];
        const totalTsr = rows.reduce((s, r) => s + (r.tsrCount || 0), 0);
        const fontOptions = fontsForLang(lang);
        return (
          <div key={lang} className="unresolved-lang-section">
            <div className="ul-section-head">
              <span className="ul-warn-icon">⚠</span>
              <span className="ul-lang-label">{langLabel(lang)}</span>
              <span className="ul-lang-code">({lang})</span>
              <span className="ul-tsr-count">
                {totalTsr} TSR{totalTsr !== 1 ? 's' : ''} unresolved across {rows.length} pair{rows.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="ul-section-body">
              {rows.map((row, ri) => {
                const skipKey = row.pairingId + "|" + lang;
                const isSkipped = skipDecisions && skipDecisions[skipKey] === 'skip';
                return (
                  <div key={ri} className={"ul-pair-row" + (isSkipped ? " is-skipped" : "")}>
                    <div className="ul-pair-info">
                      <span className="ul-pair-name">Pair {row.pairingId}</span>
                      <span className="ul-source-font">
                        <strong>{row.sourceFont}</strong> / {row.sourceWeight}
                      </span>
                      <span className="ul-tsr-mini">
                        {row.tsrCount} TSR{row.tsrCount !== 1 ? 's' : ''}
                      </span>
                      {row.sampleParaIds && row.sampleParaIds.length > 0 ? (
                        <span className="ul-sample-paras" title={devTitle(ctx,"Sample paragraph ids")}>
                          paras: {row.sampleParaIds.slice(0, 3).join(', ')}
                        </span>
                      ) : null}
                    </div>
                    <div className="ul-pair-actions">
                      {isSkipped ? (
                        <button className="ul-skip-btn ul-unskip"
                          onClick={() => setSkip(row.pairingId, lang, undefined)}
                          title="Restore (un-skip)">
                          ↶ Un-skip
                        </button>
                      ) : (
                        <div className="ul-actions-row">
                          {fontOptions.length > 0 ? (
                            <select className="ul-font-picker"
                              defaultValue=""
                              onChange={(e) => {
                                if (!e.target.value) return;
                                const idx = parseInt(e.target.value, 10);
                                const opt = fontOptions[idx];
                                if (!opt) return;
                                addPairMember(row.pairingId, lang, opt.font, opt.weight);
                                e.target.value = "";
                              }}>
                              <option value="">Pick a font for {langLabel(lang)}…</option>
                              {fontOptions.map((opt, oi) => (
                                <option key={oi} value={String(oi)}>
                                  {opt.font} / {opt.weight}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="ul-no-fonts"
                              title={"Add a font under the " + langLabel(lang) + " column first"}>
                              (add font in {langLabel(lang)} column)
                            </span>
                          )}
                          <button className="ul-skip-btn"
                            onClick={() => setSkip(row.pairingId, lang, 'skip')}
                            title="Skip this (pair, lang) — apply will ignore actions for these TSRs">
                            Skip & Continue
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, {
  Icon, Editable, Port, WeightNode, FontCard, FamilyPickerCard,
  LanguageColumn, LangPickerColumn, LabelCard,
  EnforcerToggle,
  RecombinationReviewStrip,
  UnresolvedLangSection,
  // #54ⓒ: exported not because React needs it (same-scope call), but so the
  // verification rig can drive the confirm popup directly from the bridge
  // (`window.confirmItalicDelete('Gotham','Book')`) without first having to
  // reproduce a copy-bearing node.
  confirmItalicDelete,
  fapTrace,
  fapTraceLatest
});
