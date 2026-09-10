// font_apply_panel — Focus-only build, merged with toolkit pan/culling layer.
//
// Source merge points:
//   - data model + wire pairing + label cards + invariants:
//       docs/字体映射面板/v2/app.jsx (2026-06-07 update)
//   - pan via lib/canvas_pan.js + viewport culling + pan-期间 simplified shell:
//       translation_mvp_uxp/dev/font_mapping_panel/app.jsx — DELETED 2026-08-23
//       (owner ruled: orphaned, no entry mounted it, content last touched 2026-06).
//       Read it at git rev 6ec315a if you need the original pan implementation.
//       ⚠ Do NOT confuse with lib/font_mapping_panel_ui.js / _adapter.js — those
//       share the name and are LIVE.
//   - external apply hook: window.__fap.{initialData, onDone}
//     set by font_apply_panel.idjs entry before mount
//
// Removed vs v2 source (per user direction 2026-06-07):
//   - Quiet / Bold profile branches: hardcoded profile='focus'
//   - profile-switch UI in topbar: removed
//   - localStorage persistence: removed
//   - Import / Export JSON buttons: removed (no lfs adapter in this MVP)

const { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } = React;

const clone = (o) => JSON.parse(JSON.stringify(o));
const findFont = (data, fid) => {
  for (const l of data.languages) {
    const f = l.fonts.find(x => x.id === fid);
    if (f) return f;
  }
  return null;
};
const weightIdsOfNode = (font, nodeId) => {
  const m = (font.merges || []).find(x => x.id === nodeId);
  if (m) return [...m.members];
  return [nodeId];
};
const memberSemantic = (data, mem) => {
  const f = findFont(data, mem.font);
  if (!f) return '';
  const grp = (f.merges || []).find(m => m.id === mem.node);
  const wid = grp ? (grp.members.includes(grp.rep) ? grp.rep : grp.members[0]) : mem.node;
  const w = f.weights.find(x => x.id === wid);
  return w ? w.semantic : '';
};
const leadMember = (data, members) => {
  const ord = {}; data.languages.forEach((l, i) => { ord[l.id] = i; });
  return [...members].sort((a, b) => (ord[a.lang] ?? 99) - (ord[b.lang] ?? 99))[0];
};
// 8D-ext-MM step 4 — resolve a panel-form pairing member ({lang:L_id,
// font:F_id, node:w_id|merge_id}) to lib form ({font: <name>, weight: <str>}).
// Resolution matches font_mapping_panel_adapter._resolvePanelMember: font name +
// (actual||semantic), and for a merge-group node the representative weight using
// the SAME guarded fallback — `members.includes(rep) ? rep : members[0]` (the
// adapter was unified to this guard in step-4 [C], so a stale merge.rep resolves
// identically on both paths). This member returns no lang (callers already know
// it); the adapter additionally returns lang. Keeping them in lockstep is what
// lets the stored representative equal the member panelDataToConfig emits
// (validateBrandConfig II-c requires rep ∈ pair members).
const resolveMemberToLib = (data, member) => {
  const langObj = (data.languages || []).find(l => l.id === member.lang || l.code === member.lang);
  if (!langObj) return null;
  const fontObj = (langObj.fonts || []).find(f => f.id === member.font);
  if (!fontObj) return null;
  let w = (fontObj.weights || []).find(x => x.id === member.node);
  if (!w) {
    const mg = (fontObj.merges || []).find(m => m.id === member.node);
    if (mg) {
      const repId = mg.members.includes(mg.rep) ? mg.rep : mg.members[0];
      w = (fontObj.weights || []).find(x => x.id === repId);
    }
  }
  if (!w) return null;
  return { font: fontObj.name, weight: w.actual || w.semantic };
};

// UXP webview has no document.elementFromPoint — iterate matching elements
// manually. See findings.md UXP-platform section "elementFromPoint".
function hitTestBySelector(sel, x, y) {
  const els = document.querySelectorAll(sel);
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return els[i];
  }
  return null;
}

function App() {
  // Optional initial data passed by the idjs entry (real-doc scan result).
  // Fallback to sample for standalone web preview.
  const [data, setData] = useState(() => {
    if (window.__fap && window.__fap.initialData) return window.__fap.initialData;
    return window.buildSample();
  });
  const [drag, setDrag] = useState(null);
  const [menu, setMenu] = useState(null);
  const [portPos, setPortPos] = useState({});

  // Phase 8D-ext-0 state (per task_plan r8):
  //   skipDecisions: { "pairIdx|lang" → "skip" } — C3-relaxed per-(pairId,lang) skip
  //   runEnforcer:   bool — D4 enforcer checkbox; default ON (entry script will
  //                  detect eligibility and tooltip if doc doesn't qualify)
  //   unresolvedByLang: lib-provided per-pair grouped data; B-section will read
  //                      this (8D-ext-0 only plumbs state, B owns rendering)
  const [skipDecisions, setSkipDecisions] = useState({});
  // D4: default ON only if doc is eligible (codex r1 P1-4 fix).
  const [runEnforcer, setRunEnforcer] = useState(() => {
    const elig = (window.__fap && window.__fap.enforcerEligibility) || null;
    return elig ? !!elig.eligible : true;
  });
  const [unresolvedByLang, setUnresolvedByLang] = useState(
    (window.__fap && window.__fap.initialUnresolvedByLang) || {}
  );
  // 8D-ext-C (2026-06-09) — primary language. Entry script can provide
  // `window.__fap.primaryLang` (sourced from _meta.target_language when
  // 8D-ext-A is wired); we fall back to "" so the topbar defaults to the
  // first detectable lang. Stored in panel ctx for downstream consumers
  // (UnresolvedLangSection rendering ordering, future apply-mode gating).
  const [primaryLang, setPrimaryLang] = useState(
    (window.__fap && window.__fap.primaryLang) || ""
  );
  // TODO#58 (2026-08-20) — automatic merging is now decided by FACE IDENTITY.
  // 🪦 `recombCandidates` / `recombDismissed` (8D-ext-A) RETIRED together with
  // their producer: they held `detectRecombinationCandidates` output, i.e. names
  // run through normalize() + STYLE_ALIAS_TABLE. owner: 「不应该是确定的方法用于判断
  // 它们是绝对一致的再合并吗，而不是靠表面的名称」.
  //   identityBuild:     the whole `buildIdentityGroups` result — `.groups` to
  //                      commit, `.skipped` / `.skippedCounts` to report.
  //                      Recomputed as `data` changes (same cadence as before).
  //                      Seeded from the scan, which already graded the document's
  //                      own fonts before any config existed.
  //   identityApply:     the last `applyIdentityGroups` result — the source of
  //                      `blockedByOperator` and of the eg set `overlaps` is read
  //                      from.
  //   🪦 identityDismissed REMOVED (owner 2026-08-20, 姿态甲). It backed an
  //     un-merge affordance that owner retired after asking the right question —
  //     not "do we want un-merge?" but 「目前确定合并的都肯定是应该被合并的吗，
  //     有没有误合并的可能性」. Two measured answers said the affordance was
  //     already doubly lame:
  //       - un-merge was LOSSY: applyMerge re-points N members onto the group but
  //         unmergeAll sends them all back to the REP, so a second line could not
  //         return to the weight it came from;
  //       - dismissal was `useState({})`, pure session state — un-merge it, reopen
  //         the panel, and the group is simply back.
  //     The criterion is deterministic (postscriptName, INSTALLED + non-empty +
  //     equal), so "the machine guessed wrong" is not a case that arises.
  //     🔴 earn-it: if a real mis-merge is ever observed, THAT is when to build
  //     un-merge — with the real case in hand. Do not pre-build it from this note.
  const [identityBuild, setIdentityBuild] = useState(() => {
    const seed = (window.__fap && window.__fap.identityReadout) || null;
    return {
      groups: [],
      skipped: (seed && seed.details && seed.details.skipped) || [],
      skippedCounts: seed
        ? { notInstalled: seed.notInstalled, noPostscriptName: seed.noPostscriptName,
            lookupFailed: seed.lookupFailed }
        : { notInstalled: 0, noPostscriptName: 0, lookupFailed: 0 }
    };
  });
  const [identityApply, setIdentityApply] = useState(null);
  // 8D-ext-A: the auto-merge review strip is COLLAPSED by default into a top-bar button
  // (user 2026-06-17) — it ate the top of the panel. Click the "N auto-merged" button to
  // reveal/hide the strip. 🪦 It listed "un-merge controls" until owner's 姿态甲
  // (2026-08-20) made the strip read-only; the tooltip said so on screen too.
  const [showRecomb, setShowRecomb] = useState(false);
  // ── Advanced options (owner 2026-09-09) ────────────────────────────────────
  // Why this exists: F1 (9206764) lifted every leaf above the `.node-hit` overlay,
  // which turned a large set of native `title=` attributes into things the OPERATOR
  // now sees. owner: 「很多地方，之前是用来开发时用来更准确描述组件名称的」 —— i.e.
  // they were DEV aids naming components, never operator copy. §13's rule for a
  // thing that folds into what the operator already knows is 闭嘴, so they must not
  // be on by default; but they are still useful when working on the panel, so they
  // are kept behind a switch rather than deleted.
  // Defaults are owner's: LABEL off, popups on.
  const [showAdv, setShowAdv] = useState(false);
  const [devLabels, setDevLabels] = useState(false);   // component-name titles (dev aid)
  const [hoverPops, setHoverPops] = useState(true);    // the panel's own .chip-pop explanations
  // ⚠ SCOPE OF THIS ROUND: the switch gates the 12 pure-LABEL titles in
  // components.jsx (via ctx.devLabels → its own devTitle helper). app.jsx has
  // ~12 title sites of its own that have NOT been classified into
  // LABEL / ACTION / CONSEQUENCE yet, so they are untouched and still always on.
  // No local helper is defined here on purpose — an uncalled one would later read
  // as "this file was done".
  // 8D-ext-MM step 5 (on-reject surface 2) — concise inline action error. Set
  // when Done/Export hit an INVALID config (validateBrandConfig fail); the panel
  // stays open + shows the reason so the mapping is never silently dropped.
  // Per UX 设计原则: inline (NOT a debug popup/alert), cleared on next data edit.
  const [actionError, setActionError] = useState(null);
  // 🪦 `actionNotice` RETIRED (A10, owner 2026-08-28: 去掉什么都没导入提示).
  // It carried exactly one message — "the picker returned nothing" — and owner
  // ruled that an operator who pressed Cancel does not need to be told they did.
  // 🔴 Retired, NOT silenced: classifyPickerOutcome now returns kind:"log" for that
  // outcome and handleImport/handleExport write it to the panel trace, so a device
  // that hands back empty is still findable via window.fapTraceLatest().
  // ⚠ Nothing else ever set this state (grep 2026-08-28: two call sites, both the
  // picker), so removing the state removes a banner that could no longer appear —
  // leaving it would tell the next reader that neutral notices exist here. If a
  // second neutral message is ever needed, bring it back with its own reason.
  // 8D-ext-bypair-tofu-ux Phase 2: Done-time confirm for source-present-unpaired
  // doc fonts (tofu risk). null = hidden; a number = count of flagged nodes → popup.
  const [tofuWarn, setTofuWarn] = useState(null);
  // tofuFlagActive: red outlines are NOT shown live — only AFTER Done detects unpaired
  // doc fonts (user direction 2026-06-20). Set true on Done-detection; STAYS true through
  // "取消" so the operator can see which nodes to wire; cleared on any data edit (wire/edit
  // re-evaluates at the next Done). The popup (tofuWarn) is the count; this gates the red.
  const [tofuFlagActive, setTofuFlagActive] = useState(false);
  // #28e: Done-time confirm for config faces not installed on this machine —
  // MIRRORS the tofu pair above (popup content state + red-outline gate state,
  // set on Done-detection, red STAYS through 取消, both cleared on data edit).
  // owner 2026-08-13 (final, supersedes the 08-12 evening "也不提示"): the
  // no-prompt rule applies only to what is FOLDED into concepts the operator
  // already has (an alias auto-merged into an ordinary pairing needs no words);
  // a genuinely-missing font demands 退出脚本 → 装字体 → 重新运行 — an action
  // OUTSIDE the panel — so it MUST get a CTA. That is exactly tofu's shape.
  const [missWarn, setMissWarn] = useState(null);
  const [missFlagActive, setMissFlagActive] = useState(false);

  useEffect(() => { setActionError(null); setTofuWarn(null); setTofuFlagActive(false); setMissWarn(null); setMissFlagActive(false); }, [data]);

  // ② The React-rendered Done/tofu popup raises the same flag the hand-built
  // italic-delete confirm does — see panel.css .fap-modal-up and fapModalScrim.
  // 🔴 Raised on ENTERING the up state and lowered by the cleanup on leaving it, so
  // the pair is always balanced even if both warnings appear and disappear together
  // (the effect does not re-run while `tofuWarn||missWarn` stays truthy for the same
  // deps, and when it does re-run the cleanup pays back the previous raise first).
  const modalUp = !!(tofuWarn || missWarn);
  useEffect(() => {
    if (!modalUp) return;
    window.fapModalScrim(true);
    return () => window.fapModalScrim(false);
  }, [modalUp]);

  // 8D-ext-MM step 5 (Part B) — resolve every pairing's members to lib form
  // ({lang CODE, font, weight}) so MM-membership can be computed in lib terms.
  const resolvedPairLibs = useMemo(() => (data.pairings || []).map(pair =>
    (pair.members || []).map(m => {
      const ml = resolveMemberToLib(data, m);
      if (!ml) return null;
      const lo = (data.languages || []).find(l => l.id === m.lang || l.code === m.lang);
      return { lang: lo ? (lo.code || lo.id) : m.lang, font: ml.font, weight: ml.weight };
    }).filter(Boolean)
  ), [data]);

  // MM-member fold-skip set, per lang CODE, keyed "font␟weight" (egFoldedWeightSet
  // key form). A (font,weight) is an MM member iff its lang has ≥2 members in the
  // SAME pairing. A.1 twin-fold + the egFoldedWeightSet display fold must SKIP
  // these — explicit MM intent owns the weight (B side 2). This inline computation
  // is the LIVE path for the A.1↔MM remediation. font_mapping_pairs.mmMemberKeySet
  // is its Node-testable MIRROR (same key logic, "font|weight" form) so the key
  // rule is unit-tested — it is NOT a production caller of this and validates
  // nothing at runtime.
  const mmFoldSkipByLang = useMemo(() => {
    const byLang = {};
    resolvedPairLibs.forEach(members => {
      const byCode = {};
      members.forEach(m => { (byCode[m.lang] = byCode[m.lang] || []).push(m); });
      Object.keys(byCode).forEach(code => {
        if (byCode[code].length < 2) return;
        const set = byLang[code] = byLang[code] || {};
        byCode[code].forEach(m => { set[m.font + '␟' + m.weight] = true; });
      });
    });
    return byLang;
  }, [resolvedPairLibs]);

  // 🪦 confirmMerge / dismissMerge RETIRED (owner 2026-08-20, TODO#58).
  // They served the A4 alias-collision banner: "family has BOTH Book and Regular
  // in the doc — merge them?". owner ruled that set is neither merged nor asked
  // about: 「只有在当前实现下确认可合并的且不在配置文件中的再合并，其他不合并也不提醒」.
  // 🔴 Retired, NOT fixed — and the difference matters for #56, which reported
  // that this banner's buttons appeared to do nothing. Diagnosis (2026-08-20)
  // found the merge DID happen; it was invisible because egFoldedWeightSet folds
  // cross-family only. The entry is gone now, so #56 closes as NO LONGER
  // APPLICABLE. If this banner is ever revived, #56 is live again with it.

  // 8D-ext-A — ensure (langCode, font, weight) exists in the panel languages
  // tree so panelDataToConfig emits it into fonts_by_language[langCode]. This
  // is the A2 augmentation: validateBrandConfig requires every eg member's
  // (font|weight) to be present under fonts_by_language[eg.lang], else export
  // rejects. Mirrors addPairMember's ensure-langObj/fontObj/weightObj logic
  // (app.jsx:127) but keyed by an explicit lang CODE (= eg.lang), not a pair.
  function _ensureFontInLang(d, langCode, font, weight) {
    let langObj = (d.languages || []).find(l => (l.code === langCode || l.id === langCode));
    if (!langObj) {
      const id = 'L_' + String(langCode).replace(/-/g, '_');
      langObj = { id, code: langCode, name: langCode, script: '·', family: 'sans-serif', fonts: [] };
      d.languages = (d.languages || []).concat([langObj]);
    }
    let fontObj = (langObj.fonts || []).find(f => f.name === font);
    if (!fontObj) {
      fontObj = {
        id: 'F_' + String(font).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase(),
        name: font, role: 'Body', weights: [], merges: []
      };
      langObj.fonts = (langObj.fonts || []).concat([fontObj]);
    }
    const hasWeight = (fontObj.weights || []).some(w =>
      (w.actual === weight || w.semantic === weight));
    if (!hasWeight) {
      fontObj.weights = (fontObj.weights || []).concat([{
        id: 'w_' + String(font).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()
            + '_' + String(weight).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase(),
        semantic: weight, actual: weight, used: 0
      }]);
    }
  }

  // 8D-ext-A.1 — discriminate a RECOMBINATION eg (this feature, cross-family)
  // from an A4 confirmMerge eg (same-family alias merge). Both shapes are
  // structurally identical; the ONLY tell is family: a recomb eg has at least
  // one cross-family merged_in (mi.font !== canonical.font), an A4 eg has none.
  // All A.1 code that matches egs must AND this in, else it leaks into A4 egs
  // that happen to share a canonical font+weight.
  // 🪦 `_isRecombEg` RETIRED (TODO#58 ②, 2026-08-20). It inferred an eg's ORIGIN
  // from its SHAPE — "has a cross-family merged_in" was used as a proxy for "A.1
  // made this". That proxy is wrong in BOTH directions, and one of them is a
  // defect that predates this change:
  //   • FALSE POSITIVE (live today): the scan's own A4 auto batch groups raw
  //     spelling variants, so `Whitney` + `whitney` lands in one eg and satisfies
  //     "cross-family" — the module's OWN documented example. Measured offline
  //     against the real producer: _isRecombEg(that eg) === true. So all four
  //     call sites below could already act on an eg that A.1 never made.
  //     (Reachability is another matter — InDesign normalises an INSTALLED
  //     family's spelling on assignment, so a well-formed doc is unlikely to
  //     produce it. Logged separately; "hard to reach" is not "absent".)
  //   • FALSE NEGATIVE (arrives with the new criterion): identity grouping by
  //     postscriptName yields SAME-family groups too (Gotham Book + Gotham
  //     Regular), which the shape test would not recognise as machine-made.
  //
  // ⇒ Origin is now STATED, not inferred. `_origin: "machine-auto"` is stamped by
  // whoever creates the group without asking (doc_scan's auto batch;
  // confirmRecombination below).
  //
  // 🔴 The question every call site is really asking is NOT "is this
  // cross-family" but "did the machine create this WITHOUT BEING ASKED, and may
  // it therefore retract it?" An eg with no marker was authored by the operator
  // or loaded from a config file: never auto-delete it — let the loud validator
  // reject happen instead. That asymmetry is deliberate.
  function _isMachineAuto(eg) {
    return !!(eg && eg._origin === 'machine-auto');
  }

  // 🪦 `_egAlreadyCovers` RETIRED (TODO#58 wiring, 2026-08-20) — the panel no
  // longer answers "is this merge already here?" itself. `applyIdentityGroups` is
  // the single write entry point and does the containment check inside the lib,
  // where the AT-MOST-ONE-eg invariant is also enforced.
  //
  // 🔴 The lesson it existed for is still load-bearing and now lives there:
  // _isMachineAuto answers "MAY I RETRACT THIS?", which is NOT the same question as
  // "IS THIS MERGE ALREADY HERE?". Conflating them costs a round trip — export
  // strips `_origin` (session-only by design) → the operator re-imports → the very
  // groups this panel made come back UNMARKED → a provenance-keyed idempotency
  // check goes blind → they are re-created → duplicates accumulate on every
  // save/reopen cycle. ⚠ (When this was written nothing downstream rejected the
  // result. As of audit round 5 validateBrandConfig DOES refuse an overlapping
  // group set — but duplicates that merely accumulate identically are still not
  // an error, and "the validator will catch it" is not a reason to relax the rule
  // here: a loud reject at Done is a far worse outcome than never creating the
  // duplicate.) Existence is judged by CONTENT, never by origin.
  // (Guarded by font_mapping_panel_passthrough_tests "#58 idempotency survives the
  // export/reimport round trip", now aimed at applyIdentityGroups directly.)

  // TODO#58 — the identity-group key an un-merge / dismissal is recorded under.
  // There is no normalized name any more, so a group is identified by what it
  // actually is: (lang, canonical).
  function _egKey(lang, font, weight) {
    return String(lang) + '␟' + String(font) + '␟' + String(weight);
  }

  // 🪦 `_refreshIdentityRows` REMOVED with option (1b) (audit round 2).
  // See lib/font_identity_groups.js for why the whole approach was reverted: the
  // `w` field it needed was a second source of truth for "which weight is this
  // member", and six A-class findings were all that same shape. The contradiction
  // it targeted is caught by validateBrandConfig's cross-pairing check instead.

  // TODO#58 (3) — THE SINGLE WRITE ENTRY POINT for machine-made groups.
  // Everything goes through lib `applyIdentityGroups`, which enforces the
  // invariant this panel cannot enforce by itself: a given (lang, font, weight)
  // belongs to AT MOST ONE eg. 🔴 That is not tidiness — getCanonical returns
  // the FIRST matching eg in array order (measured: reversing the array changed
  // the answer). ⚠ validateBrandConfig DID NOT reject overlaps when this was
  // written (measured then: ok:true, zero errors) — IT DOES NOW (audit round 5),
  // so a double claim is no longer invisible downstream. This guard is still the
  // right place: a loud reject at Done/Export is a far worse outcome for the
  // operator than never creating the overlap in the first place.
  // 🔴 This was the LAST survivor of that stale-claim family; the other three were
  // corrected in round 5. Do not use it to argue the invariant can be relaxed.
  //
  // 🔴 Groups an operator authored (or a config file supplied) are never
  // extended, re-parented or re-stamped — they come back in `blockedByOperator`
  // instead (design-intent §8: the config is authoritative).
  //
  // Returns the readout so the caller can report the five counters.
  function _applyIdentityGroupsTo(d, groups) {
    const FIGlib = window.__fap && window.__fap.libIdentityGroups;
    if (!FIGlib || !groups || !groups.length) return null;
    const res = FIGlib.applyIdentityGroups(d.equivalence_groups || [], groups);
    d.equivalence_groups = res.egs;
    // A2 augmentation: canonical + every merged_in must live in
    // fonts_by_language[lang], else validateBrandConfig / exportJson reject.
    // (The retired confirmMerge skipped this and produced configs that failed
    // their own validator — see font_identity_groups.js pickCanonical.)
    (res.egs || []).forEach(eg => {
      if (!eg || !eg.canonical) return;
      _ensureFontInLang(d, eg.lang, eg.canonical.font, eg.canonical.weight);
      (eg.merged_in || []).forEach(mi => _ensureFontInLang(d, eg.lang, mi.font, mi.weight));
    });
    return res;
  }

  // 🪦 `unmergeIdentityGroup` REMOVED (owner 2026-08-20, 姿态甲 — machine decides).
  // See the identityDismissed note above for the two measurements that made the
  // affordance not worth keeping (lossy re-point + session-only dismissal).
  // The review strip below stays, read-only: owner asked for the merges to be
  // VISIBLE; the "and revocable" half is what 姿态甲 resolved.

  // TODO#58 (c) — the review strip, DERIVED from the data instead of mirrored.
  //
  // 🪦 `autoMerged` used to be a useState list that ONLY `confirmRecombination`
  // wrote to. Consequence, and the reason owner asked for "可撤销": groups that
  // arrived with the SCAN had no record, so they folded weights in the tree with
  // NO un-merge row anywhere — the machine had done something the operator could
  // neither see nor undo. (The component's own header even names this fix:
  // "Fix-when-needed: derive this strip from data.equivalence_groups".)
  //
  // 🔴 Both batches now come from one place, so "has a row" is not a property
  // of which code path made the group — it is a property of the group being
  // machine-made at all. A mirror list cannot drift from the data if there is no
  // mirror list.
  //
  // 🔴 MOTIVE, since it changed under the same button: the criterion is
  // deterministic now, so this is not "the machine guessed, fix it". It is the
  // other half of the bargain the automatic path makes — merge only what can be
  // proven, and show every merge you made.
  //
  // ⚠ After export→re-import the panel's own groups come back WITHOUT `_origin`
  // (session-only by design, #33d: once on disk a machine-made entry is
  // indistinguishable from a curated one) ⇒ no row, and no auto-retraction
  // either. That is the same rule applied consistently, not an oversight.
  const autoMerged = useMemo(() => {
    const usedBy = {};
    ((window.__fap && window.__fap.documentFonts) || []).forEach(df => {
      usedBy[df.font + '␟' + df.weight] = df.used || 0;
    });
    return ((data && data.equivalence_groups) || [])
      .filter(eg => _isMachineAuto(eg) && eg.canonical)
      .map(eg => ({
        normalized_key: _egKey(eg.lang, eg.canonical.font, eg.canonical.weight),
        canonical: { font: eg.canonical.font, weight: eg.canonical.weight, homeLang: eg.lang },
        members: [{
          family: eg.canonical.font, style: eg.canonical.weight,
          used: usedBy[eg.canonical.font + '␟' + eg.canonical.weight] || 0
        }].concat((eg.merged_in || []).map(mi => ({
          family: mi.font, style: mi.weight,
          used: usedBy[mi.font + '␟' + mi.weight] || 0
        })))
      }));
  }, [data]);

  // B4 representative_by_lang per-pair state. Lifted into `data.pairings`
  // mutation directly (data is source of truth); this state mirrors UI hints
  // so we know which pairs need the first-connect hint pulse.
  // (No separate state object — mutate data.pairings[i].representative_by_lang.)

  // Phase 8D-ext-0 P1 fix: addPairMember context API.
  // Adds (lang, font, weight) to pair[pairIdx].members + ensures
  // fonts_by_language[lang] has the (font, weight) entry. Compatible with
  // panel v2 data shape: also adds the language bucket + font + weight in
  // the panel tree if absent. Triggers a re-resolve (host-side scan when
  // user clicks Done).
  const addPairMember = useCallback((pairIdx, lang, font, weight) => {
    setData(prev => {
      // Deep-clone via JSON for predictable immutability (matches mutate())
      const d = JSON.parse(JSON.stringify(prev));
      let langObj = (d.languages || []).find(l => (l.code === lang || l.id === lang));
      if (!langObj) {
        const id = 'L_' + String(lang).replace(/-/g, '_');
        langObj = { id, code: lang, name: lang, script: '·', family: 'sans-serif', fonts: [] };
        d.languages = (d.languages || []).concat([langObj]);
      }
      let fontObj = (langObj.fonts || []).find(f => f.name === font);
      if (!fontObj) {
        fontObj = {
          id: 'F_' + String(font).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase(),
          name: font, role: 'Body', weights: [], merges: []
        };
        langObj.fonts = (langObj.fonts || []).concat([fontObj]);
      }
      let weightObj = (fontObj.weights || []).find(w =>
        (w.actual === weight || w.semantic === weight));
      if (!weightObj) {
        weightObj = {
          id: 'w_' + String(font).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()
              + '_' + String(weight).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase(),
          semantic: weight, actual: weight, used: 0
        };
        fontObj.weights = (fontObj.weights || []).concat([weightObj]);
      }
      const pair = (d.pairings || [])[pairIdx];
      if (pair) {
        if (!Array.isArray(pair.members)) pair.members = [];
        // 8D-ext-MM step 4 [B]: same-lang multi-member is ALLOWED (one lang →
        // multiple weights fan-in), matching applyPair + the lib twin
        // panel_adapter.addPairMember. Reject ONLY an exact-duplicate
        // {lang,font,node} member (idempotency). The auto-rep normalize effect
        // then sets representative_by_lang for the now-≥2 lang.
        const isExactDup = pair.members.some(m =>
          m.lang === langObj.id && m.font === fontObj.id && m.node === weightObj.id);
        if (!isExactDup) {
          pair.members = pair.members.concat([{
            lang: langObj.id, font: fontObj.id, node: weightObj.id
          }]);
        }
      }
      return d;
    });
    setUnresolvedByLang(prev => {
      const next = {};
      Object.keys(prev).forEach(k => {
        next[k] = prev[k].filter(e => !(e.pairingId === pairIdx && k === lang));
        if (next[k].length === 0) delete next[k];
      });
      return next;
    });
  }, []);

  // Skip & Continue (8D-ext-0 C3-relaxed state contract)
  const setSkip = useCallback((pairIdx, lang, value) => {
    const key = pairIdx + "|" + lang;
    setSkipDecisions(prev => {
      const next = Object.assign({}, prev);
      if (value === 'skip') next[key] = 'skip';
      else delete next[key];
      return next;
    });
  }, []);

  // Focus is the ONLY profile in this build. Selector-based CSS still uses
  // [data-profile="focus"] so we set it on .app root for backward compat.
  const profile = 'focus';

  // Viewport culling state (from toolkit pan-perf work) — outside-of-viewport
  // language columns unmount to a placeholder div, cutting DOM count.
  const [vcOn, setVcOn] = useState(true);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 999 });
  const viewportOffsetXRef = useRef(0);
  const vcThrottleRef = useRef(null);

  // Pan-期间 React state-driven simplification: while dragging the background,
  // unmount font cards' inner content into a height-preserving shell so paint
  // cost drops. columnHeightsRef snapshots heights BEFORE the unmount to
  // prevent layout shift mid-pan.
  // TODO#81 — owner 2026-08-23 asked for the pan-time simplified shell to be
  // TURNED OFF but NOT REMOVED. Flipping this to `true` restores it whole.
  // 🔴 It is a module-level constant rather than a UI toggle on purpose: owner
  // did not ask for a switch in the interface, and shipping one would decide a
  // question he has not been asked (#60's lesson: leaving structure for an
  // unchosen option chooses half of it for him).
  const SIMPLIFIED_SHELL_DURING_PAN = false;
  const [isPanning, setIsPanning] = useState(false);
  const columnHeightsRef = useRef({});

  const innerRef = useRef(null);
  const canvasRef = useRef(null);
  const portEls = useRef({});
  const dragRef = useRef(null);
  const panCtrlRef = useRef(null);
  // Refs kept fresh each render so the capture-phase pointerdown listener (added
  // once in the pan useEffect) can read the latest wires + menu callbacks
  // without re-binding. The listener intercepts wire clicks geometrically
  // (UXP webview ignores pointer-events:stroke — findings.md
  // #uxp-dialog-webview-api-gaps) and opens Remove-pairing instead of panning.
  const wiresRef = useRef([]);
  const openMenuRef = useRef(null);
  const removePairingRef = useRef(null);
  const updateDrag = (d) => { dragRef.current = d; setDrag(d); };

  // Pan / interaction filter — pointerdowns landing on these elements should
  // pass through to React handlers (Done button click, port drag-to-pair,
  // grip drag-to-merge, inline edit input). Without this, canvas_pan's
  // preventDefault() swallows clicks and "click anywhere → starts pan, can't
  // press anything" (user verified 2026-06-07).
  //
  // NOTE: <button> elements are replaced with `<div role="button">` toolkit-
  // wide to dodge the UXP webview OS-level button overlay quirk (see
  // findings.md uxp-platform). So `[role="button"]` is what catches our
  // clickable divs — `button` tag selector matches nothing now.
  // `.font-card-picker` covers the inline family-picker scrollable list +
  // search; without it, scrollbar drag inside the card triggers canvas pan.
  const PAN_SKIP_SEL = '[role="button"], input, textarea, select, a, .port, .node-grip, [data-port], [data-node-grip], .font-card-picker, .picker-list, .picker-search';
  const isInteractiveTarget = useCallback((e) => {
    if (!e || !e.target || !e.target.closest) return false;
    return !!e.target.closest(PAN_SKIP_SEL);
  }, []);

  /* 🔴 #96 真因（读数逼出来的，不是推测）：日志 20:45:09 里
       DATA:set = **恰好一次调用**（createItalicVariant <- onClick），
       而它的 updater 被执行了 50+ 次（inv3…inv50），**每次都返回新对象**；
       同一段时间里 DATA:effect 报了 51 次 `changed`。
       ⇒ **一次 setData 调用产生了 51 个不同的 data 身份。**

     React 每轮 render 会【重放】队列里的 updater。对纯函数这是幂等的 ——
     而本 updater 每次执行都 `clone(prev)`，于是**重放一次就换一个身份**：
       data 换身份 → 所有 [data] effect 重跑 → 其中 setPortPos /
       setUnresolvedByLang 无守卫、每次写新对象 → 逼出下一轮 render →
       再一次重放 → 永动 → 撞满嵌套上限 → React 抛 #185 → 整棵树卸载 → 面板全黑。

     ⚠ 上一版我加的守卫比的是 `d` vs `prev`，只拦"什么都没改"。
       而这一次 createItalicVariant **确实改了东西**，守卫放行是对的 ——
       所以那次修法被证伪，**病不在空操作，在【重放不稳定】**。
     修法 = 让 updater 对同一个 prev 幂等：重放时返回**同一个结果对象**。 */
  const mutate = (fn) => {
  /* ⚠ 记忆必须是【每次调用各自一份】(闭包内)，⛔ 不能是组件级共享的一份。
     实测代价(2026-09-09 离线): 首版用了共享的 useRef ⇒ 同一批次里
     mutate(fnA) 之后 mutate(fnB) 拿到同一个 prev ⇒ 命中缓存、返回 fnA 的结果,
     **fnB 的编辑被静默丢掉**。harness 立刻从「重排 4 · 合并 6」掉到「0 · 0」——
     比原 bug 更糟, 而且不报错。
     🔴 抓到它的是【覆盖计数器】("真发生了几次重排/合并"), 不是性质检查 ——
     性质检查那一行当时是绿的(1 次调用 -> 0 个身份, 比值 0.0, 判为"满足")。
     一个只看比值的检查, 分不开「不再乱变」和「根本没做事」。 */
  let memoPrev = null, memoOut = null, memoHas = false;
  return setData(prev => {
    // 同一个 prev 再次进来 = React 在重放【这一次】更新, 不是一次新的编辑
    // ⇒ 交回同一个对象, 否则身份每重放一次就变一次(= #96 的真因)。
    if (memoHas && memoPrev === prev) return memoOut;
    const d = clone(prev);
    fn(d);
    // TODO #32(a): a parked member (see parkedOf below) belongs to ONE pairing. If
    // that pairing is gone the operator deleted it — an explicit act — so drop the
    // entry with it. Central here rather than in each remove* handler: it is the
    // single funnel every edit passes through, and a dangling entry would otherwise
    // sit in state until export quietly ignored it (and could, in principle, be
    // re-adopted by a later pairing that happened to reuse the id).
    if (Array.isArray(d.unplaceableMembers) && d.unplaceableMembers.length) {
      const live = new Set((d.pairings || []).map(p => p.id));
      d.unplaceableMembers = d.unplaceableMembers.filter(u => u && live.has(u.pairingId));
    }
    /* 🔴 #96 —— 这里原本是无条件 `return d;`。
       `d` 是 `clone(prev)`，所以**哪怕 `fn(d)` 一个字节都没改，它也是个新对象** ⇒
       React 的 `Object.is` 永远判"变了" ⇒ 无法 bail out ⇒ 每次调用必然重渲染。
       后果不是慢一点：任何依赖 `data`（或依赖由 data 派生的 useMemo）的 effect
       只要调 `mutate`，就是一个**无条件自触发**的循环 —— 撞满 50 层嵌套更新后
       React 抛 #185，整棵树卸载，owner 看到的就是「面板整片变黑」。
       🔴 这不是推测，是读数：2026-09-09 20:04 那份日志里逐字写着
         `CHANGED mutate@728 < createItalicVariant < onClick   eg=0 rep=2:[] -> eg=0 rep=2:[]`
       —— **前后完全一样，却被记为 CHANGED**，因为身份变了。
       修法 = 让「没改动」在 React 眼里也是「没改动」。
       ⚠ 代价是一次序列化比较；本函数上面已经做了一次 JSON 克隆，同一数量级。
       ⚠ 它只认 JSON 可见的差异 —— 本模型本来就靠 JSON 克隆做不可变更新，
         口径一致；若将来引入非 JSON 值（Map/Set/undefined），这条要跟着改。 */
    let same = false;
    try { same = JSON.stringify(d) === JSON.stringify(prev); } catch (e) { same = false; }
    const out = same ? prev : d;
    // 记下 (prev -> out)，供 React 重放【本次】更新时原样交回（见上方长注释）。
    memoPrev = prev; memoOut = out; memoHas = true;
    return out;
  });
  };

  // ---------- port registry & geometry ----------
  const registerPort = useCallback((id, el) => {
    if (el) portEls.current[id] = el; else delete portEls.current[id];
  }, []);

  // SVG sits at .canvas-inner inset:0 — its bbox is the reference frame for
  // port positions. Using inner's border-box drifts when padding is non-zero.
  const recomputePorts = useCallback(() => {
    const inner = innerRef.current; if (!inner) return;
    const svg = inner.querySelector('.wires');
    const c = (svg || inner).getBoundingClientRect();
    const next = {};
    for (const id in portEls.current) {
      const el = portEls.current[id];
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
    }
    /* 🔴 #96：这里原本无条件 `setPortPos(next)`，而 `next` 每次都是新对象
       ⇒ 每跑一次就必然重渲染一次。它自己不成环（portPos 不在任何 effect 依赖里，
       全仓 grep 过），**但它是循环的"泵"**：只要别处让 data 换了身份，
       本 effect 就跟着跑、跟着逼出下一轮 render，让重放继续。
       量到的位置写不动就别写 —— 位置没变时返回 prev。 */
    setPortPos(prev => {
      const a = Object.keys(prev), b = Object.keys(next);
      if (a.length === b.length) {
        let same = true;
        for (let i = 0; i < b.length; i++) {
          const k = b[i], p = prev[k], q = next[k];
          if (!p || p.x !== q.x || p.y !== q.y) { same = false; break; }
        }
        if (same) return prev;
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => { recomputePorts(); }, [data, visibleRange, recomputePorts]);

  // CanvasPan: transform-based pan because UXP <dialog> overflow:auto + wheel
  // events are not delivered (panel.css overrides .canvas { overflow:hidden }
  // at file end). viewport culling computed in throttled onChange so React
  // doesn't reconcile per-pointermove.
  useEffect(() => {
    const cv = canvasRef.current;
    const inner = innerRef.current;
    if (!cv || !inner || !window.CanvasPan) return;
    const ctrl = window.CanvasPan.attachPan(cv, inner, {
      minScale: 1,
      maxScale: 1,
      // Skip pan if pointerdown lands on a button / port / grip / input —
      // let React handle the click / drag instead.
      targetFilter: (e) => !isInteractiveTarget(e),
      onChange: (s) => {
        viewportOffsetXRef.current = s.x;
        if (vcThrottleRef.current) return;
        vcThrottleRef.current = setTimeout(() => {
          vcThrottleRef.current = null;
          const cvEl = canvasRef.current;
          if (!cvEl) return;
          const cvWidth = cvEl.getBoundingClientRect().width;
          const COL_FULL = 346; // panel.css .column 300 + canvas-inner gap 46
          const scrollX = -viewportOffsetXRef.current;
          const first = Math.floor(scrollX / COL_FULL);
          const last = Math.floor((scrollX + cvWidth) / COL_FULL);
          const start = Math.max(0, first - 1);
          const end = last + 2;
          setVisibleRange(prev => (prev.start === start && prev.end === end) ? prev : { start, end });
        }, 80);
      },
    });
    panCtrlRef.current = ctrl;

    // Wire-click interceptor (the wire-click-delete fix). UXP webview only
    // honors pointer-events:none, so the wire <path>'s pointer-events:stroke is
    // ignored and a click on a wire never targets the path — it lands on the
    // canvas and CanvasPan starts a pan (its targetFilter can't catch the path
    // because the path was never the target). So we hit-test geometrically here.
    //
    // CAPTURE phase on cv runs BEFORE CanvasPan's bubble-phase onDown on the
    // same element; calling stopPropagation() in capture prevents the event
    // from ever reaching the bubble phase → CanvasPan.onDown never fires → no
    // pan. On a wire hit we open the same Remove-pairing menu the (dead)
    // onClick used to.
    const onWireCaptureDown = (e) => {
      if (e.button !== 0) return;
      // Exclude interactive targets (ports / node-grips / buttons) FIRST — ports
      // sit AT wire endpoints, so a geometric ≤9px test would otherwise hijack a
      // port-drag (esp. dragging from an already-connected port for MM
      // multi-connect). Same filter the pan uses; only an empty-canvas pointerdown
      // over a wire CURVE (target not interactive) reaches the geometric test.
      if (isInteractiveTarget(e)) return;
      if (!window.WireHitTest || !wiresRef.current.length) return;
      // Convert clientX/Y into canvas-inner content coords — the frame portPos
      // (and thus the wire endpoints) live in: relative to the .wires SVG bbox,
      // which moves WITH the pan transform, so the subtraction cancels the pan
      // offset (scale is locked to 1, so no scale factor needed).
      const svg = inner.querySelector('.wires');
      const c = (svg || inner).getBoundingClientRect();
      const pt = { x: e.clientX - c.left, y: e.clientY - c.top };
      const hit = window.WireHitTest.wireHitTest(pt, wiresRef.current, 9);
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      const cx = e.clientX, cy = e.clientY;
      if (openMenuRef.current) {
        openMenuRef.current({
          getBoundingClientRect: () => ({
            left: cx, top: cy, bottom: cy, right: cx, width: 0, height: 0,
          }),
        }, [
          { head: 'Pairing' },
          { label: 'Remove pairing', danger: true,
            onClick: () => { if (removePairingRef.current) removePairingRef.current(hit.pid); } },
        ]);
      }
    };
    cv.addEventListener('pointerdown', onWireCaptureDown, true);

    const cvWidth = cv.getBoundingClientRect().width;
    const COL_FULL_INIT = 346;
    const lastInit = Math.floor(cvWidth / COL_FULL_INIT);
    setVisibleRange({ start: 0, end: lastInit + 2 });
    const onResize = () => recomputePorts();
    window.addEventListener('resize', onResize);
    const t = setTimeout(() => recomputePorts(), 300);
    return () => {
      ctrl.destroy();
      cv.removeEventListener('pointerdown', onWireCaptureDown, true);
      panCtrlRef.current = null;
      window.removeEventListener('resize', onResize);
      clearTimeout(t);
      if (vcThrottleRef.current) { clearTimeout(vcThrottleRef.current); vcThrottleRef.current = null; }
    };
  }, [recomputePorts]);

  // pointerdown/up: snapshot column heights then setIsPanning so simplification
  // shell can preserve layout. UXP webview lacks :scope pseudo-class — use
  // Array.from(children).filter instead.
  useEffect(() => {
    const cv = canvasRef.current;
    const inner = innerRef.current;
    if (!cv || !inner) return;
    const onDown = (e) => {
      if (e.button !== 0) return;
      // Same filter as canvas_pan — don't enter simplified-shell mode when
      // user is clicking Done, dragging a port, dragging a grip, or typing.
      if (isInteractiveTarget(e)) return;
      const cols = Array.from(inner.children).filter(c => c.classList && c.classList.contains('column'));
      const heights = {};
      cols.forEach((c, idx) => { heights[idx] = c.offsetHeight; });
      columnHeightsRef.current = heights;
      // TODO#81 (owner 2026-08-23): 「平移画布时关闭简化 ui 的逻辑但不移除」.
      // 🔴 OFF, NOT REMOVED. Every branch below is intact — the CSS rules
      // (.canvas-inner.panning …), the stripped-column render (`if (isPanning)`),
      // the wire/label suppression, and the height snapshot above. This one flag
      // is the ONLY thing that arms them, so turning it back on is a one-word edit
      // and nothing had to be reconstructed.
      //
      // ⚠ WHAT IS UNKNOWN, stated rather than implied — the two halves differ:
      //   · React half (isPanning): certainly took effect — it stops rendering
      //     wires and label cards and swaps each column for a head-only shell.
      //   · CSS half (.panning): 🔴 UNMEASURED whether it ever did anything.
      //     `.panning .port{display:none}` computes to `none` (measured
      //     2026-08-23) yet the port's rect is UNCHANGED (13x13), so it changes
      //     no layout; whether it changes PAINT, and whether
      //     `.panning .node{pointer-events:none}` actually blocks hit-testing,
      //     needs a pixel rig / OS input and has NOT been run.
      // ⇒ 🔴 Do not delete any of this on the assumption it was dead: that
      //   question is open, and the answer decides whether deleting is safe.
      if (SIMPLIFIED_SHELL_DURING_PAN) {
        inner.classList.add('panning');
        setIsPanning(true);
      }
    };
    const onUp = () => {
      inner.classList.remove('panning');
      setIsPanning(false);
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    return () => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
    };
  }, []);

  // ---------- global pointer handling (UXP elementFromPoint workaround) ----
  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current; if (!d) return;
      if (d.type === 'node') {
        moveGhost(e.clientX, e.clientY);   // 纯 DOM 写入，不进 state（见 makeGhost 上方注释）
        /* owner 2026-09-09:「两个节点之间有一部分 gap 被认为是 node 区之外」——
           属实, 而且原因已有记录: #83 为【hover】把 gap 覆盖掉了(.node-hit 覆盖层
           上下各外扩 5.5px), 可【拖动的落点判定】用的是节点自身的 rect, 不含那层
           ⇒ 光标跨过 gap 时落点指示会断一下, 那 9px 不属于任何落点区。
           改为命中同一块 .node-hit: 它的几何是量过的 —— 2×(5.5−1)=9=gap,
           两块正好衔接、不重叠(panel.css:193 段, 另有算术测试守着) ⇒
           gap 上半归上面那个节点的"after"带, 下半归下面那个的"before"带,
           而这两者本来就是【同一个插入点】。没有死区, 也没有二义。
           ⚠ 落点档位(rel)也随之改用命中区的 rect ——
             若仍拿节点 rect 算, 命中来自扩展区时 rel 会落在 [0,1] 之外。
           ⚠ 保留对 [data-node] 的回退: 不是每个节点都保证有 .node-hit
             (幽灵那份就被我特意剥掉了), 缺了就退回原行为, 不是静默失效。 */
        let hitEl = hitTestBySelector('.node-hit', e.clientX, e.clientY);
        let nodeEl = hitEl && hitEl.closest ? hitEl.closest('[data-node]') : null;
        if (!nodeEl) { nodeEl = hitTestBySelector('[data-node]', e.clientX, e.clientY); hitEl = nodeEl; }
        let overNode = null, dropMode = null;
        if (nodeEl) {
          const overId = nodeEl.dataset.node;
          const font = findFont(data, d.font);
          const sameFont = font && (font.weights.some(w => w.id === overId) || (font.merges || []).some(m => m.id === overId));
          if (sameFont && overId !== d.node) {
            const r = (hitEl || nodeEl).getBoundingClientRect();
            const rel = (e.clientY - r.top) / r.height;
            let mode = rel < 0.3 ? 'before' : rel > 0.7 ? 'after' : 'merge';
            /* owner 2026-09-09:「拖一个字重时它上下相邻的不作为可改变排序的位置,
               因为无意义」。确实是空操作: 把 X 插到【它的下一个】之前 = X 没动;
               插到【它的上一个】之后 = 同理。
               🔴 这也解释了早先量到的"重排大片无效带"(探针: 165 次拖动里 155 次
                  是空操作) —— 那些位置一直显示成可落点, 落下去却什么都不发生。
                  现在它们干脆不再显示为落点, 提示退回中性那句。
               ⚠ 次序取自【同一张 font-card 内】的 DOM 顺序, 不是全局 [data-node]:
                 全局列表跨语言列, 相邻在视觉上并不相邻。 */
            if (mode !== 'merge') {
              try {
                const card = nodeEl.closest('.font-card');
                const seq = card
                  ? Array.prototype.map.call(card.querySelectorAll('[data-node]'), (el) => el.dataset.node)
                  : [];
                const iD = seq.indexOf(d.node), iO = seq.indexOf(overId);
                if (iD >= 0 && iO >= 0 &&
                    ((mode === 'before' && iO === iD + 1) || (mode === 'after' && iO === iD - 1))) {
                  mode = null;   // 无意义的落点：不给指示、不给提示、落下去也不做事
                }
              } catch (eSeq) {}
            }
            if (mode) { overNode = overId; dropMode = mode; }
          }
        }
        setGhostHint(dropMode);
        updateDrag({ ...d, overNode, dropMode });
      } else if (d.type === 'wire') {
        const portEl = hitTestBySelector('[data-port]', e.clientX, e.clientY);
        const overPort = portEl ? portEl.dataset.port : null;
        const svg = innerRef.current.querySelector('.wires');
        const c = (svg || innerRef.current).getBoundingClientRect();
        updateDrag({ ...d, overPort, cursor: { x: e.clientX - c.left, y: e.clientY - c.top } });
        // TODO#82 — near an edge, scroll the canvas so a port on another screenful
        // can be reached (owner: 「靠近窗口四周时移动画布」).
        // 🔴 The arithmetic lives in lib/edge_autopan.js as a pure function, so the
        // half a machine CAN check (which way, how far, clamping, corners) is checked.
        // ⚠ What stays owner's: whether it actually scrolls and whether it feels right
        // — that needs a real pointer (#13b) and cannot be driven from here.
        // ⚠ Culling is suspended for the whole drag (see the render below): without
        // that, this very scroll would turn the column it is heading towards into an
        // empty spacer and delete the target it exists to reach.
        try {
          const cvEl = canvasRef.current;
          const pan = panCtrlRef.current;
          if (cvEl && pan && pan.panBy && window.EdgeAutoPan) {
            const vr = cvEl.getBoundingClientRect();
            const delta = window.EdgeAutoPan.edgeAutoPanDelta(
              { x: e.clientX, y: e.clientY },
              { left: vr.left, top: vr.top, right: vr.right, bottom: vr.bottom });
            if (delta.dx || delta.dy) pan.panBy(delta.dx, delta.dy);
          }
        } catch (eAp) { /* auto-pan is an assist; never let it break the drag */ }
      }
    };
    const up = () => {
      const d = dragRef.current; if (!d) return;
      if (d.type === 'node' && d.overNode && d.dropMode) {
        if (d.dropMode === 'merge') applyMerge(d.font, d.node, d.overNode);
        else applyReorder(d.font, d.node, d.overNode, d.dropMode);
      } else if (d.type === 'wire' && d.overPort) {
        const fromLabel = d.from.lang === '__label__';
        const tp = d.overPort.split(':');
        const toLabel = tp[0] === '__label__';
        if (fromLabel && !toLabel) {
          linkLabel(d.from.font, { lang: tp[0], font: tp[1], node: tp[2] });
        } else if (toLabel && !fromLabel) {
          linkLabel(tp[1], d.from);
        } else if (!fromLabel && !toLabel) {
          if (!(tp[0] === d.from.lang && tp[1] === d.from.font && tp[2] === d.from.node)) {
            applyPair(d.from, { lang: tp[0], font: tp[1], node: tp[2] });
          }
        }
      }
      document.body.classList.remove('grabbing');
      killGhost();
      updateDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [data]);

  // ---------- drag starters ----------
  /* 拖动幽灵（owner 2026-09-09:「拖动时节点能否跟随鼠标」）。
     🔴 完全走 React 之外 —— 建一次 DOM、之后每次 pointermove 只改 transform。
        理由不是性能洁癖: 把光标坐标放进 state 就等于【每帧再触发一次渲染】,
        而 #96 刚刚证明这条路上一次多余的渲染循环会把整个面板打黑。
        幽灵不进 state, 拖动期间 React 一次都不必重渲染。
     🔴 克隆体必须剥掉 data-node(连同所有后代): 落点判定走
        hitTestBySelector('[data-node]', x, y) —— 一个跟着鼠标跑、永远盖在
        指针底下的 [data-node] 会把每一次落点都判成它自己。
        再加 pointer-events:none 双保险。
     ⚠ opacity 写在【创建时的内联样式】里, 不在运行时改 —— 本仓已记:
        UXP webview 里运行时改 opacity 是"只写不显"(初次挂载的值才会画出来)。 */
  const ghostRef = useRef(null);
  const killGhost = () => {
    const g = ghostRef.current;
    ghostRef.current = null;
    /* 🔴 这一行原本是 `if (g && g.parentNode) … removeChild(g)` —— 而 `g` 是
       `{el, offX, …}` 这个【对象】，不是 DOM 节点 ⇒ `g.parentNode` 恒为
       undefined ⇒ **主清理路径从一开始就是死的**，幽灵全靠 window 捕获阶段
       那道兜底擦掉。
       ⚠ 更值得记的是：探针的「⑧ 松手后清除 ✅」当时是【绿的】——
         因为兜底把它擦了。两道机制里坏了一道，而读数完全看不出来。
         ⇒ 有兜底的地方，"结果对"证明不了"主路径对"。
       另：提示现在不是幽灵的子节点了，必须单独收，否则删了幽灵、提示还挂着。 */
    if (g) {
      for (const el of [g.el, g.hint]) {
        if (el && el.parentNode) { try { el.parentNode.removeChild(el); } catch (e) {} }
      }
    }
  };
  const makeGhost = (srcEl, x, y) => {
    killGhost();
    if (!srcEl) return;
    let clone;
    try { clone = srcEl.cloneNode(true); } catch (e) { return; }
    try {
      clone.removeAttribute('data-node');
      const inner = clone.querySelectorAll('[data-node]');
      for (let i = 0; i < inner.length; i++) inner[i].removeAttribute('data-node');
      // 命中覆盖层在幽灵上没有意义, 去掉免得它参与任何测量
      const hits = clone.querySelectorAll('.node-hit');
      for (let i = 0; i < hits.length; i++) hits[i].remove();
      /* 斜体按钮也要剥掉。起手那一刻源节点正被 hover(指针就在它的手柄上),
         所以它的 .ital-add 是显示着的, 会被一起克隆进来 ——
         那与 owner 要的「拖动时不出现斜体按钮」自相矛盾: 真节点上藏了,
         却有一个跟着鼠标飞。留下同尺寸的 .ital-slot 顶位, 幽灵不变形。 */
      const adds = clone.querySelectorAll('.ital-add');
      for (let i = 0; i < adds.length; i++) {
        const ph = document.createElement('span');
        ph.className = 'ital-slot ital-slot-drag';
        try { adds[i].parentNode.replaceChild(ph, adds[i]); } catch (e) { adds[i].remove(); }
      }
    } catch (e) {}
    const r = srcEl.getBoundingClientRect();
    /* owner 2026-09-09:「拖的时候光标在点击前的 port 的上方」——
       首版把节点【居中到光标】(x - w/2, y - h/2), 于是一按下去整个节点就跳一下,
       光标落到了节点里【另一个】位置(常常正好压在 port 上)。
       正确做法是留住抓取偏移: 光标始终停在它按下时抓住的那一点上,
       节点看起来是被"拈起来", 而不是被吸到光标中心。 */
    const offX = x - r.left, offY = y - r.top;
    clone.classList.add('drag-ghost');
    clone.style.cssText = 'position:fixed;left:0;top:0;margin:0;'
      + 'width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px;'
      + 'pointer-events:none;z-index:9999;opacity:0.85;'
      + 'transform:translate(' + Math.round(x - offX) + 'px,'
      + Math.round(y - offY) + 'px);';
    /* owner 选 1A + 2C：提示跟着幽灵走，且文案带上"为什么"。
       挂成幽灵的子元素 ⇒ 自动跟随，不必单独维护第二个坐标。
       position:absolute + top:100% ⇒ 贴在幽灵下沿；nowrap + 固定定位祖先
       ⇒ 它再长也不参与任何布局，不会把谁挤走。 */
    /* 🔴 提示【不能】做成幽灵的子元素。owner 实测「文本超过背景」：
       绝对定位 + left:0 + right:auto 的收缩宽度会被【容器宽度】封顶，
       而幽灵只有一个节点那么宽 ⇒ 背景框被截到节点宽，nowrap 的文字照样溢出去。
       本表里 .chip-pop 是靠写死 width:230px + 允许换行绕过去的；对拖动提示
       更干净的办法是把它挪出幽灵：自己 position:fixed，容器就是视口
       ⇒ 收缩宽度按内容走，不需要 max-content 这类在本 webview 里没有先例的
       关键字（全表只有一处 min-content 先例）。
       代价 = 每帧多写一次 transform（可忽略），清理选择器要一并覆盖它。 */
    const hint = document.createElement('div');
    hint.className = 'drag-hint';
    hint.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:10000;';
    ghostRef.current = { el: clone, offX: offX, offY: offY, hint: hint, h: r.height };
    try { (document.querySelector('dialog') || document.body).appendChild(hint); } catch (e) {}
    const host = document.querySelector('dialog') || document.body;
    try { host.appendChild(clone); } catch (e) { ghostRef.current = null; }
  };
  /* 3A：⛔ 不做机器判断（不去比 postscriptName 判定"是否真的一样"）——
     判错了会把人误导去合并两个其实不同的字重，代价不对称。
     文案只说明合并【是用来做什么的】，让 operator 自己看。 */
  const GHOST_HINT = {
    before: 'Release to reorder',
    after: 'Release to reorder',
    merge: 'Release to merge — these look like the same weight',
    none: "Drop at a node's edge to reorder · on a node to merge",
  };
  const setGhostHint = (mode) => {
    const g = ghostRef.current;
    if (!g || !g.hint) return;
    const t = GHOST_HINT[mode || 'none'] || GHOST_HINT.none;
    if (g.hint.textContent !== t) g.hint.textContent = t;   // 只在真变了时写 DOM
    g.hint.className = 'drag-hint' + (mode === 'merge' ? ' is-merge' : '');
  };
  const moveGhost = (x, y) => {
    const g = ghostRef.current;
    if (!g || !g.el) return;
    g.el.style.transform = 'translate(' + Math.round(x - g.offX) + 'px,'
      + Math.round(y - g.offY) + 'px)';
    if (g.hint) {
      g.hint.style.transform = 'translate(' + Math.round(x - g.offX) + 'px,'
        + Math.round(y - g.offY + g.h + 6) + 'px)';
    }
  };

  const onStartNode = (e, lang, font, node) => {
    e.preventDefault();
    document.body.classList.add('grabbing');
    try {
      const host = e.currentTarget && e.currentTarget.closest
        ? e.currentTarget.closest('[data-node]') : null;
      makeGhost(host, e.clientX, e.clientY);
    } catch (eG) {}
    updateDrag({ type: 'node', lang, font, node, overNode: null, dropMode: null });
  };
  const onStartWire = (e, addr, side) => {
    e.preventDefault();
    document.body.classList.add('grabbing');
    const svg = innerRef.current.querySelector('.wires');
    const c = (svg || innerRef.current).getBoundingClientRect();
    updateDrag({
      type: 'wire', from: addr, side,
      fromId: `${addr.lang}:${addr.font}:${addr.node}:${side}`,
      overPort: null,
      cursor: { x: e.clientX - c.left, y: e.clientY - c.top },
    });
  };

  // ---------- merge / reorder ----------
  function applyMerge(fontId, dragId, targetId) {
    mutate(d => {
      const f = findFont(d, fontId);
      const dragW = weightIdsOfNode(f, dragId);
      const tgtW = weightIdsOfNode(f, targetId);
      const all = [...new Set([...tgtW, ...dragW])];
      const existingRep = (f.merges || []).find(m => m.id === targetId)?.rep || tgtW[0];
      const absorbed = new Set([dragId, targetId, ...all]);
      f.merges = (f.merges || []).filter(m =>
        !all.includes(m.id) &&
        !m.members.some(x => all.includes(x)) &&
        m.id !== dragId &&
        m.id !== targetId
      );
      const newMergeId = window.uid('mg');
      f.merges.push({ id: newMergeId, members: all, rep: all.includes(existingRep) ? existingRep : all[0] });
      d.pairings.forEach(p => {
        p.members.forEach(me => { if (me.font === fontId && absorbed.has(me.node)) me.node = newMergeId; });
        const seen = new Set();
        p.members = p.members.filter(me => {
          const k = `${me.lang}:${me.font}:${me.node}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      });
      const others = f.weights.filter(w => !all.includes(w.id));
      const grouped = all.map(id => f.weights.find(w => w.id === id)).filter(Boolean);
      const pos = f.weights.findIndex(w => w.id === tgtW[0]);
      const before = others.filter(w => f.weights.indexOf(w) < pos);
      const after = others.filter(w => f.weights.indexOf(w) >= pos);
      f.weights = [...before, ...grouped, ...after];
    });
  }
  function applyReorder(fontId, dragId, targetId, mode) {
    mutate(d => {
      const f = findFont(d, fontId);
      const dragW = weightIdsOfNode(f, dragId);
      // 🔴 2026-09-09: `.filter(Boolean)` was missing here while `applyMerge` (:903)
      // has it on the identical line. A stale merge-member id makes `.find` return
      // undefined, which then goes INTO `f.weights` — and the next render
      // dereferences it. There is no error boundary anywhere in this panel
      // (grep: 0 hits for componentDidCatch / getDerivedStateFromError), so a throw
      // during render unmounts the WHOLE tree and `#root` goes empty, exposing the
      // dialog's own near-black gradient at full size. That is a candidate mechanism
      // for owner's 2026-09-09「拖动时整个面板会变成黑色」.
      // ⚠ INFERENCE, not reproduced: I have not shown that a stale id occurs. The
      // guard is justified on its own (the sibling line has it, asymmetry unexplained)
      // and is not offered as a confirmed fix for the black panel.
      const moving = dragW.map(id => f.weights.find(w => w.id === id)).filter(Boolean);
      let rest = f.weights.filter(w => !dragW.includes(w.id));
      const tgtFirst = weightIdsOfNode(f, targetId)[0];
      let idx = rest.findIndex(w => w.id === tgtFirst);
      if (mode === 'after') {
        const tgtW = weightIdsOfNode(f, targetId);
        idx = rest.findIndex(w => w.id === tgtW[tgtW.length - 1]) + 1;
      }
      rest.splice(idx, 0, ...moving);
      f.weights = rest;
    });
  }

  // ---------- pairing (v2 invariants intact) -------------------------------
  const sameAddr = (a, b) => a.lang === b.lang && a.font === b.font && a.node === b.node;

  // TODO #32(a) / #29 — members the adapter could not place on any node (the
  // machine lacks the font, the config names a weight this roster does not carry).
  // They ride along on data.unplaceableMembers and are re-emitted verbatim at
  // export; on canvas they have no port, so p.members undercounts the pairing.
  // Every prune below must count them, otherwise deleting an UNRELATED font drops
  // the pairing under the ≥2 rule and takes a parked member with it — the same
  // silent destruction this fix removes, just triggered from a different button.
  const parkedOf = (d, pid) =>
    (d.unplaceableMembers || []).filter(u => u && u.pairingId === pid);
  const pairMemberCount = (d, p) => (p.members || []).length + parkedOf(d, p.id).length;

  function applyPair(a, b) {
    const prev = data;
    const d = JSON.parse(JSON.stringify(prev));
    const pa = d.pairings.find(p => p.members.some(m => sameAddr(m, a)));
    const pb = d.pairings.find(p => p.members.some(m => sameAddr(m, b)));
    if (pa && pb && pa === pb) return;
    // 8D-ext-MM step 4 (I): same-lang multi-member is now ALLOWED (the
    // validator gates invalid configs at export; the panel just constructs).
    // Exact-duplicate {lang,font,node} members are still prevented — every
    // branch dedups via sameAddr. representative_by_lang is auto-derived by the
    // first-connected effect below, not here.
    if (pa && pb) {
      pb.members.forEach(m => { if (!pa.members.some(x => sameAddr(x, m))) pa.members.push(m); });
      // TODO #32(a): pb's parked members move with pb's visible ones. Without this
      // they would still point at a pairing id that no longer exists and be dropped
      // at export — merging two pairings would silently delete them.
      parkedOf(d, pb.id).forEach(u => { u.pairingId = pa.id; });
      d.pairings = d.pairings.filter(p => p !== pb);
    } else if (pa) {
      pa.members.push(b);
    } else if (pb) {
      pb.members.push(a);
    } else {
      const members = [a, b];
      const ord = {}; d.languages.forEach((l, i) => { ord[l.id] = i; });
      const lead = leadMember(d, members);
      const seed = window.closestPreset(memberSemantic(d, lead));
      const includesLeftmost = members.some(m => ord[m.lang] === 0);
      const newPair = { id: window.uid('P'), hue: window.PAIR_COLOR, members,
        label: seed, labelLinked: includesLeftmost };
      d.pairings.push(newPair);
    }
    setData(d);
  }

  function removePairing(pid) { mutate(d => { d.pairings = d.pairings.filter(p => p.id !== pid); }); }
  const setPairingLabel = (pid, v) => mutate(d => { const p = d.pairings.find(x => x.id === pid); if (p) p.label = v; });
  function linkLabel(pid, addr) {
    mutate(d => {
      const p = d.pairings.find(x => x.id === pid); if (!p) return;
      // 8D-ext-MM step 4 [P2]: a distinct same-lang member can now link via the
      // label lane (matches node-to-node MM construction) — the old same-lang
      // reject was a SILENT no-op. Exact-dup is still skipped by the push guard
      // below; the normalize effect then sets representative_by_lang.
      d.pairings.forEach(q => { if (q !== p) q.members = q.members.filter(m => !sameAddr(m, addr)); });
      if (!p.members.some(m => sameAddr(m, addr))) p.members.push(addr);
      p.labelLinked = true;
      d.pairings = d.pairings.filter(q => pairMemberCount(d, q) >= 1);
    });
  }

  // W1 (owner: "两侧端口不应该是亮的，只有在实际有连接的时候才变蓝") ---------
  // The lit port and the drawn wire used to encode two DIFFERENT facts: lit meant
  // "is a member of some pairing", the wire meant "two rendered ports, cross-lang".
  // They diverge in several ways; the one that bites is a member whose only
  // counterpart is unplaceable — it lit up as paired while nothing was connected,
  // and because `matched = !!hue` feeds `state`, that node was ALSO exempt from the
  // tofu red outline and missing from the Done popup's count. A parked member
  // silently disarmed the warning built to catch un-mapped source fonts.
  //
  // The predicate is deliberately a DATA one — "this member has ≥1 counterpart in
  // ANOTHER language that resolves to a real node" — NOT "a wire got drawn this
  // frame". Keying it to drawn wires / portPos would make ports blink off during a
  // pan, because off-screen columns render as bare spacers and never register their
  // ports; this panel has a pan-performance history and must not re-earn it.
  // It also fixes the same-lang case honestly: a pairing whose members are all one
  // language genuinely has no connection (the wire loop skips same-lang by design).
  //
  // Precomputed per data change rather than walked per call: nodeHue runs for every
  // node on every render (and every angle-drag pointermove is a render).
  const nodeIdSet = useMemo(() => {
    const s = new Set();
    (data.languages || []).forEach(l => (l.fonts || []).forEach(f => {
      (f.weights || []).forEach(w => s.add(f.id + ':' + w.id));
      (f.merges || []).forEach(g => s.add(f.id + ':' + g.id));
    }));
    return s;
  }, [data]);

  const litMemberHue = useMemo(() => {
    const out = new Map();
    const resolves = (m) => !!m && nodeIdSet.has(m.font + ':' + m.node);
    (data.pairings || []).forEach(p => {
      const ms = p.members || [];
      ms.forEach(m => {
        // A counterpart must be in another LANGUAGE and must land on a node that
        // actually exists. Parked members are not in ms at all, so a pairing whose
        // only cross-lang partner was parked correctly yields no counterpart here.
        const connected = ms.some(o => o !== m && o.lang !== m.lang && resolves(o));
        if (connected) out.set(`${m.lang}:${m.font}:${m.node}`, p.hue);
      });
    });
    return out;
  }, [data, nodeIdSet]);

  const nodeHue = useCallback((addr) => {
    return litMemberHue.get(`${addr.lang}:${addr.font}:${addr.node}`) || null;
  }, [litMemberHue]);

  // 8D-ext-MM step 4 — representative marker query for a weight/group node.
  // Returns null unless `addr` is a member of a pair where its lang has ≥2
  // members (i.e. an MM same-lang member that needs a representative marker).
  // Otherwise → { isRep, pairId, langCode, libMember:{font,weight} }. langCode
  // is the lang CODE (representative_by_lang is code-keyed; members use L_id).
  // #33d mitigation (owner 2026-08-13 「1B 宽」限期豁免的缓解件): session-only
  // record of (pairId|langCode) reps the rep-normalize EFFECT invented (the
  // machine's first-connected pick). An operator star-click (setPairRep)
  // clears the key — his decision, nothing to flag. Config-loaded valid reps
  // never enter this set (the effect's KEEP branch doesn't fire SET). Session
  // state only: NOTHING here changes any persisted output.
  // Value = provenance enum, not a bare true (owner 2026-08-13: the two
  // machine-pick situations must not share one sentence): 'load' = invented
  // while digesting a freshly imported config (inherited state — the file
  // named no rep), 'wire' = invented right after an in-session member
  // addition (feedback to the operator's own gesture — wire/merge/picker all
  // land here). Same ONE map; the chip text stays "auto-picked" for both.
  const [autoRepKeys, setAutoRepKeys] = useState({});
  // True exactly while the NEXT rep-normalize detection pass digests
  // just-imported data (initial mount + handleImport); the effect consumes
  // it and flips it off, so every later pass attributes to 'wire'.
  const repSourceIsLoadRef = useRef(true);

  const pairRepInfo = useCallback((addr) => {
    const p = data.pairings.find(pp => pp.members.some(m => sameAddr(m, addr)));
    if (!p) return null;
    const sameLang = p.members.filter(m => m.lang === addr.lang);
    if (sameLang.length < 2) return null;
    const langObj = (data.languages || []).find(l => l.id === addr.lang || l.code === addr.lang);
    const langCode = langObj ? (langObj.code || langObj.id) : addr.lang;
    const thisLib = resolveMemberToLib(data, addr);
    if (!thisLib) return null;
    const rep = p.representative_by_lang && p.representative_by_lang[langCode];
    const isRep = !!(rep && rep.font === thisLib.font && rep.weight === thisLib.weight);
    return { isRep, pairId: p.id, langCode, libMember: thisLib,
      autoSet: !!autoRepKeys[p.id + '|' + langCode],     // #33d — machine-picked this session
      autoSource: autoRepKeys[p.id + '|' + langCode] || null }; // 'load' | 'wire'
  }, [data, autoRepKeys]);

  // 8D-ext-MM step 4 — click a member's marker → it becomes the representative
  // (zero menu, zero confirm, per user UX 2026-06-14). langCode + libMember
  // come straight from pairRepInfo so they already match a pair member.
  const setPairRep = useCallback((pairId, langCode, libMember) => {
    setData(prev => {
      const d = JSON.parse(JSON.stringify(prev));
      const pair = (d.pairings || []).find(p => p.id === pairId);
      if (!pair) return prev;
      if (!pair.representative_by_lang) pair.representative_by_lang = {};
      pair.representative_by_lang[langCode] = { font: libMember.font, weight: libMember.weight };
      return d;
    });
    // #33d: an explicit star click IS the operator's decision — the
    // machine-picked notice for this (pair, lang) comes off.
    setAutoRepKeys(prev => {
      const k = pairId + '|' + langCode;
      if (!prev[k]) return prev;
      const n = Object.assign({}, prev);
      delete n[k];
      return n;
    });
  }, []);

  const wireConnectable = useCallback((addr) => {
    const d = drag;
    if (!d || d.type !== 'wire' || !d.from) return true;
    const from = d.from;
    const fromLabel = from.lang === '__label__';
    const toLabel = addr.lang === '__label__';
    if (sameAddr(from, addr)) return false;
    if (fromLabel && toLabel) return false;
    // 8D-ext-MM step 4 [P2]: label-lane is consistent with node-to-node — a
    // distinct same-lang member IS connectable (MM). Only an exact-duplicate
    // member (already linked) stays dimmed as a no-op.
    if (fromLabel) {
      const p = data.pairings.find(x => x.id === from.font);
      if (!p) return true;
      if (p.members.some(m => sameAddr(m, addr))) return false;
      return true;
    }
    if (toLabel) {
      const p = data.pairings.find(x => x.id === addr.font);
      if (!p) return true;
      if (p.members.some(m => sameAddr(m, from))) return false;
      return true;
    }
    const pa = data.pairings.find(p => p.members.some(m => sameAddr(m, from)));
    const pb = data.pairings.find(p => p.members.some(m => sameAddr(m, addr)));
    // Already the same pair → connecting is a no-op; keep it dimmed.
    if (pa && pb && pa === pb) return false;
    // 8D-ext-MM step 4 (I): same-lang across DIFFERENT pairs / singletons is now
    // a valid MM connection (one lang → multiple weights, validator gates at
    // export). So we no longer dim same-lang node targets. Exact-duplicate
    // members can't arise here: sameAddr(from, addr) already returned false
    // above and a node lives in at most one pair (applyPair also dedups).
    return true;
  }, [drag, data]);

  // ---------- editing handlers ---------------------------------------------
  const setFontName = (fid, v) => mutate(d => { findFont(d, fid).name = v; });
  const setLangName = (lid, v) => mutate(d => { d.languages.find(l => l.id === lid).name = v; });
  const setRep = (fid, mid, wid) => mutate(d => {
    const m = findFont(d, fid).merges.find(x => x.id === mid); if (m) m.rep = wid;
  });
  const unmergeAll = (fid, mid) => mutate(d => {
    const f = findFont(d, fid); const m = (f.merges || []).find(x => x.id === mid); if (!m) return;
    const rep = m.members.includes(m.rep) ? m.rep : m.members[0];
    f.merges = f.merges.filter(x => x.id !== mid);
    d.pairings.forEach(p => p.members.forEach(me => {
      if (me.font === fid && me.node === mid) me.node = rep;
    }));
  });
  // Add font to a language column — pushes a pending font card; user picks
  // family inline (no overlay menu).
  const addFont = (lid) => {
    mutate(d => {
      const lang = d.languages.find(l => l.id === lid);
      if (lang) lang.fonts.push(buildPendingFont());
    });
  };
  const removeFont = (lid, fid) => mutate(d => {
    const l = d.languages.find(x => x.id === lid);
    l.fonts = l.fonts.filter(f => f.id !== fid);
    d.pairings.forEach(p => { p.members = p.members.filter(m => m.font !== fid); });
    d.pairings = d.pairings.filter(p => pairMemberCount(d, p) >= 2);
  });
  const removeLang = (lid) => mutate(d => {
    d.languages = d.languages.filter(l => l.id !== lid);
    d.pairings.forEach(p => { p.members = p.members.filter(m => m.lang !== lid); });
    d.pairings = d.pairings.filter(p => pairMemberCount(d, p) >= 2);
  });

  // ---------- univ-italic §7.4 ② — per-weight italic HOW (real / faux + angle) ----
  // The store is `data.italic_by_winner`: { contract-K winner key → the
  // brand_config.italic_by_weight entry }. Keyed by WINNER, not by panel node —
  // that is the whole point. `italic_config.lookup` is called at apply time with
  // the family the run actually lands in (style_applier.js:1619 `resolved.family`,
  // style_sheet_builder.js:2309, italic_apply.js:104), so anything keyed by the
  // source column's spelling would type-check and never match: a silently dropped
  // operator choice. A map keyed by winner also makes AC⑤ structural — two source
  // columns resolving onto one winner CANNOT hold two rival entries.
  //
  // NO node ids, no ports, no membership, no slotKey: deliberately not the #17
  // Y-model. A copy has no existence apart from its winner key, so orphan-pruning
  // (the old pruneOrphanFaux) has nothing to prune.
  const IVK = (window.__fap && window.__fap.libItalicKeys) || null;

  // lib-form config for winner resolution. cv.config is used even when validate
  // FAILS (mid-edit states are routinely invalid) — resolveWinner reads only
  // pairs/equivalence_groups, which are well-formed either way.
  const libConfigForItalic = useMemo(() => {
    const fap = window.__fap;
    if (!fap || !fap.libPanelAdapter) return null;
    try { return fap.libPanelAdapter.panelDataToConfig(data).config || null; }
    catch (e) { return null; }
  }, [data]);

  // Winner-resolution options (univ-italic §7.4 ②):
  //  • resolveInstalledFont — the pipeline's own installed-name resolver, bound to
  //    the live doc by font_panel_env (contract K r3: the family a run lands in is
  //    also rewritten at style-write time). Absent when no document is open →
  //    resolveWinner keeps the names as given, no throw inside render.
  //  • dominantLang — deliberately NOT passed: `window.__fap` carries no doc-level
  //    dominant language. fap.scanTsrMap holds a PER-TSR dominantLang, and the
  //    pipeline consults it per TSR (font_mapping_resolve.js:719-756); collapsing
  //    those into one doc-level lang would be a rule the resolver does not have.
  //    So with primaryLang="(auto)" the chain's "scanner" outcome stays
  //    indeterminate — surfaced, never guessed.
  const italicWinnerOpts = useMemo(() => {
    const r = window.__fap && window.__fap.resolveInstalledFont;
    return { resolveInstalledFont: (typeof r === 'function') ? r : null };
  }, []);

  // italicInfo(langCode, fontName, weight) → { key, winner, entry|null }
  // `key` is what every mutation below addresses; `winner.viaPair` tells the UI
  // this weight's runs land on ANOTHER font, so it can say so.
  // 🔴 2026-09-09 —— 这里原本是【渲染路径上的裸解引用】：resolveWinner 可能返回 null /
  // 缺字段，而 winner.font 直接取用，既无 null 检查也无 try/catch。
  // 它紧邻的 italicOrphans（下方）调用【同一个库】却是包了 try/catch 的 —— 这个不对称
  // 一直没有解释。
  // 为什么它要紧：本面板【没有任何 error boundary】（grep componentDidCatch /
  // getDerivedStateFromError = 0 命中），React 18 createRoot 一旦在渲染中抛出就
  // 卸载整棵树，#root 变空 ⇒ 露出 dialog 自己那层近黑渐变。
  // owner 2026-09-09 的现场描述与此吻合：「除了系统窗口本身，里面全黑，
  // 光标在整个窗口范围内是抓手抓住的状态」——【内容没了但光标状态还在】，
  // 正是「React 树死了、而拖动的 CSS 光标仍挂在非 React 的外层」这一形状。
  // 而他撞见它的位置是【拖到斜体按钮上】，正是本函数被求值的地方。
  // ⚠ 仍标推断：我没有复现，也没有证明 resolveWinner 会返回 null。守卫凭它自己站得住
  //   （兄弟行有、不对称无解释），失败时返回 null 与 `if (!IVK) return null` 同语义 ——
  //   调用方本来就要处理 null。
  const italicInfo = (langCode, fontName, weight) => {
    if (!IVK) return null;
    try {
      const winner = IVK.resolveWinner(libConfigForItalic, langCode, fontName, weight, primaryLang, italicWinnerOpts);
      if (!winner || !winner.font) return null;
      const key = IVK.variantKey(winner.font, winner.weight);
      const entry = (data.italic_by_winner || {})[key] || null;
      return { key: key, winner: winner, entry: entry };
    } catch (e) {
      // 不静默：写进面板自己的 trace 环形缓冲，owner 关掉面板后
      // window.fapTraceLatest() 还看得到 —— 否则这就成了「守住了但没人知道守过」。
      try { window.fapTrace && window.fapTrace('italicInfo:threw', String(e && e.message || e)); } catch (e2) {}
      return null;
    }
  };

  // (The shared exact-italic probe that fed the D2b hint and the Done gate is gone
  // with them — the panel no longer authors `real`, so there is nothing left to hint
  // about or to refuse. window.__fap.hasExactItalic stays available for a future
  // consumer; keeping a dead ctx entry would only imply a component still reads it.)

  // Entries the operator cannot see on any node (AC⑦ / 3B). Listed, never pruned:
  // "no claimant" is also what environment drift looks like, and pruning would then
  // erase live configuration during an ordinary session.
  const italicOrphans = useMemo(() => {
    if (!IVK || typeof IVK.findOrphanEntries !== 'function') return [];
    try {
      return IVK.findOrphanEntries(data, libConfigForItalic, primaryLang, italicWinnerOpts);
    } catch (e) { return []; }
  }, [data, libConfigForItalic, primaryLang]);

  // TODO #32(a) / #29 — pair members that reached the panel but no node can show.
  // Same doctrine as italicOrphans above: listed, never pruned, still written out
  // on Done. Derived (not stored) so it can never disagree with the live pairings —
  // an entry whose pairing the operator deleted stops rendering at once.
  const unplaceableMembers = useMemo(() => {
    const list = (data && data.unplaceableMembers) || [];
    if (!list.length) return [];
    const byId = {};
    (data.pairings || []).forEach(p => { byId[p.id] = p; });
    return list
      .filter(u => u && byId[u.pairingId])
      .map(u => {
        const p = byId[u.pairingId];
        return Object.assign({}, u, { pairingLabel: (p.label || '').trim() || p.id });
      });
  }, [data]);

  // F2 (design F) — the one verb on a parked row: put it on a node.
  //
  // Grammatically identical to the panel's existing answer for "a pair has no member
  // here" (UnresolvedLangSection's "Pick a font…"), except the pick is PRE-FILLED:
  // the config already names the exact triple, so the operator supplies consent, not
  // information. Reuses _ensureFontInLang — the same call the equivalence-group path
  // already makes for exactly this requirement — so the node, its roster entry and
  // the wire all come from the machinery that builds every other node.
  //
  // Undo is not invented either: the node is an ordinary font card, so `Remove font`
  // already undoes it.
  const materializeParked = (entry) => mutate(d => {
    if (!entry) return;
    const p = (d.pairings || []).find(x => x.id === entry.pairingId);
    if (!p) return;                       // pairing went away → nothing to attach to
    _ensureFontInLang(d, entry.lang, entry.font, entry.weight);
    // Re-read the ids _ensureFontInLang settled on (it reuses an existing lang/font
    // when there is one, so these are not always freshly generated).
    const langObj = (d.languages || []).find(l => l.code === entry.lang || l.id === entry.lang);
    const fontObj = langObj && (langObj.fonts || []).find(f => f.name === entry.font);
    const wObj = fontObj && (fontObj.weights || []).find(w =>
      w.actual === entry.weight || w.semantic === entry.weight);
    if (!langObj || !fontObj || !wObj) return;
    const addr = { lang: langObj.id, font: fontObj.id, node: wObj.id };
    if (!p.members.some(m => sameAddr(m, addr))) p.members.push(addr);
    // The row goes because a PERSON removed it — the whole point of design F.
    d.unplaceableMembers = (d.unplaceableMembers || []).filter(u =>
      !(u && u.pairingId === entry.pairingId && u.lang === entry.lang
        && u.font === entry.font && u.weight === entry.weight));
  });

  // ── #41 (design-intent §6, 2026-08-13 修订) — translator-marked italics ⇒
  // auto-add faux@12 on the CJK weight, AND SAY SO on the node. Trigger is the
  // moment a demanded SOURCE face is wired to a CJK weight (this effect runs on
  // that very state change — instant feedback on the operator's action, not a
  // load-time sweep over all weights: "需要不是存在"). The decision is pure
  // (data.jsx computeAutoFauxAdditions, Node-tested); this effect only applies
  // it. Absent-only: an entry loaded from the config (= already accepted) or
  // hand-made is NEVER touched. autoFauxKeys is SESSION state — the first-time
  // notice renders only for keys added in THIS session; after export+reimport
  // the entry arrives via the config and no notice shows (约束二, per-weight).
  const AUTO_FAUX_ANGLE = 12;   // owner default (§6 修订); manual copies stay at IVK.DEFAULT_FAUX_ANGLE=15 (§3:126)
  const [autoFauxKeys, setAutoFauxKeys] = useState({});
  const fapItalicDemand = (window.__fap && window.__fap.italicDemandFaces) || null;
  useEffect(() => {
    if (!fapItalicDemand || !IVK || typeof window.computeAutoFauxAdditions !== 'function') return;
    const _cjk = (window.__fap && window.__fap.cjkLangs) || {};
    const adds = window.computeAutoFauxAdditions(
      resolvedPairLibs, fapItalicDemand, _cjk, data.italic_by_winner || {},
      (m) => {
        const winner = IVK.resolveWinner(libConfigForItalic, m.lang, m.font, m.weight, primaryLang, italicWinnerOpts);
        if (!winner || winner.indeterminate) return null;   // never guess a target (§7.4 chain)
        return { key: IVK.variantKey(winner.font, winner.weight), font: winner.font, weight: winner.weight };
      });
    if (!adds.length) return;
    mutate(d => {
      if (!d.italic_by_winner) d.italic_by_winner = {};
      adds.forEach(a => {
        if (!d.italic_by_winner[a.key]) d.italic_by_winner[a.key] = IVK.newFauxEntry(a.font, a.weight, AUTO_FAUX_ANGLE);
      });
    });
    setAutoFauxKeys(prev => {
      const n = Object.assign({}, prev);
      adds.forEach(a => { n[a.key] = true; });
      return n;
    });
  }, [resolvedPairLibs, fapItalicDemand, libConfigForItalic, primaryLang]);

  const createItalicVariant = (langCode, fontName, weight) => mutate(d => {
    if (!IVK) return;
    const winner = IVK.resolveWinner(libConfigForItalic, langCode, fontName, weight, primaryLang, italicWinnerOpts);
    const key = IVK.variantKey(winner.font, winner.weight);
    if (!d.italic_by_winner) d.italic_by_winner = {};
    if (d.italic_by_winner[key]) return;                       // 1:1 by winner key (D3 / §3:130)
    // Born VALID at faux@15 (§3:126) — there is no mode-less draft state, so the
    // operator can never see a copy that quietly behaves as "unconfigured".
    d.italic_by_winner[key] = IVK.newFauxEntry(winner.font, winner.weight);
  });

  // Kept but NOT reachable from the UI: the real/faux selector is gone, and a
  // hand-edited mode:"real" entry renders no slider either (ItalicVariantNode gates
  // the slider row on isFaux), so the only panel action on such an entry is delete.
  // Retained because `mode` still exists in the schema and this is the single place
  // that would set it if a converting control is ever added; the apply path keeps
  // honouring mode:"real" meanwhile. (An earlier comment here claimed dragging an
  // angle converts the entry — it cannot, because there is no slider to drag.)
  const setItalicMode = (key, mode) => mutate(d => {
    const e = d.italic_by_winner && d.italic_by_winner[key];
    if (!e || (mode !== 'real' && mode !== 'faux')) return;
    e.mode = mode;
    // Keep the angle across a real→faux→real round trip; lookup() ignores angle
    // for `real`, so carrying it costs nothing and preserves the operator's dial.
    if (mode === 'faux' && typeof e.angle !== 'number') e.angle = IVK.DEFAULT_FAUX_ANGLE;
  });
  const setItalicAngle = (key, deg) => mutate(d => {
    const e = d.italic_by_winner && d.italic_by_winner[key];
    if (!e) return;
    e.angle = IVK.clampAngle(deg);
    e.mode = 'faux';        // dialling an angle IS choosing faux
  });
  // Delete = drop the config entry. Per §3 (read through the §7 decision) the
  // weight then behaves as UNCONFIGURED: upright + surfaced like an unpaired
  // weight — NOT "reverts to some default italic". Nothing is stamped here.
  const deleteItalicVariant = (key) => mutate(d => {
    if (d.italic_by_winner) delete d.italic_by_winner[key];
  });

  const openMenu = (anchor, items) => {
    const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    setMenu({ rect, items });
  };

  // Installed font families (family → [styles]) — injected by entry idjs at
  // startup via `window.__fap.installedFamilies`. Used by Add language /
  // Add font pickers so user can pick any installed family and we
  // auto-populate that family's full weight list.
  const installedFamilies = (window.__fap && window.__fap.installedFamilies) || {};
  const installedFamilyNames = Object.keys(installedFamilies).sort();

  // Build a font object from a chosen family name + all that family's
  // installed styles. Falls back to a single "Regular" weight if the family
  // isn't in the installedFamilies map (manual / user-typed name).
  const buildFontFromFamily = (familyName) => {
    const styles = installedFamilies[familyName] || ['Regular'];
    return {
      id: window.uid('F'),
      name: familyName,
      role: 'Body',
      weights: styles.map(s => ({
        id: window.uid('w'),
        semantic: s,
        actual: s,
        used: 0,
      })),
      merges: [],
    };
  };

  // Build a placeholder "pending" font — rendered as an inline family picker
  // card by components.jsx FontCard. User picks a family → finalizePendingFont
  // replaces the placeholder with the real font + full weight list.
  const buildPendingFont = () => ({
    id: window.uid('F'),
    name: '',
    role: 'Body',
    weights: [],
    merges: [],
    pendingFamily: true,
  });

  // Add language column — pushes a placeholder column with pendingLang:true.
  // LanguageColumn dispatches to LangPickerColumn which shows inline lang
  // picker (search + scrollable preset list, same UX as family picker). User
  // picks a preset → finalizePendingLang sets fields + pushes pending font.
  // No overlay menu — keeps consistent with Add font flow.
  const addLang = () => {
    mutate(d => d.languages.push({
      id: window.uid('L'),
      code: '',
      name: '',
      script: '?',
      family: '',
      fonts: [],
      pendingLang: true,
    }));
  };

  const finalizePendingLang = (lid, preset) => {
    mutate(d => {
      const lang = d.languages.find(l => l.id === lid);
      if (!lang) return;
      lang.code = preset.code;
      lang.name = preset.name;
      lang.script = preset.script;
      lang.family = preset.family;
      delete lang.pendingLang;
      // Push a pending font card so user picks family next (two-step add).
      if (!lang.fonts || lang.fonts.length === 0) {
        lang.fonts = [buildPendingFont()];
      }
    });
  };

  // Replace a pending font with the real one — full weights for picked family.
  const finalizePendingFont = (lid, fid, familyName) => {
    mutate(d => {
      const lang = d.languages.find(l => l.id === lid);
      if (!lang) return;
      const font = lang.fonts.find(f => f.id === fid);
      if (!font) return;
      const styles = installedFamilies[familyName] || ['Regular'];
      font.name = familyName;
      font.weights = styles.map(s => ({
        id: window.uid('w'),
        semantic: s,
        actual: s,
        used: 0,
      }));
      font.merges = [];
      delete font.pendingFamily;
    });
  };

  // ---------- TODO#58 ② — upstream named a target language that has no fonts ----
  //
  // owner's rule, verbatim: 「上游已指定目标语言 ∧ 配置里该语言还没有任何字体
  // ⇒ 直接进入选字体那一步；直接导出则不写任何东西，下次再自动触发」
  // and, explicitly: 🔴 拒绝记录「已忽略」状态.
  //
  // That last clause is why there is no state here to find: the "next time it fires
  // again" behaviour is not implemented, it is what you GET when nothing is written
  // down. A dismissed-flag would have been the natural thing to add and is exactly
  // what owner refused — so the only durable trace this may leave is a font the
  // operator actually picked.
  //
  // 🔴 The second clause is load-bearing and was MEASURED, not reasoned:
  // tests/spikes/spike_58_2_pending_card_writes_nothing.js. Opening the step means
  // pushing a card, and for a language with no column yet it also means creating the
  // column — and the config rebuild used to emit `"zh-TW": []` for any column that
  // existed, so merely LOOKING at the picker and exporting would have marked the
  // operator's config. panelDataToConfig now drops empty language keys that the
  // source config did not already have (4 gate tests in the adapter suite).
  //
  // Read from `window.__fap.primaryLang` — the UPSTREAM value — not from the
  // primaryLang state: the antecedent is 「上游已指定」, so an operator picking a
  // language in the topbar dropdown must NOT trigger this. In the standalone
  // (double-click) launcher nothing supplies it, so the antecedent is simply false
  // and the whole rule stays dark — no switch, no parameter, nothing reserved.
  //
  // ⚠ Language comparison goes through libIdentityGroups.sameLang, the same
  // function the grouping engine uses. Upstream may say `zh-Hans-CN` where the
  // column says `zh-CN`; "one side normalized, the other raw" is a bug shape this
  // subsystem has produced four times, and sharing the comparator is what makes the
  // two sides agree by construction rather than by anyone remembering to.
  const targetLangJumpDone = useRef(false);
  useEffect(() => {
    if (targetLangJumpDone.current) return;
    const fap = window.__fap || {};
    const upstream = fap.primaryLang || '';
    if (!upstream) return;                 // antecedent false → stay dark
    // Set BEFORE the mutate: this fires at most once per session whatever the
    // outcome, including the "already configured, nothing to do" outcome.
    targetLangJumpDone.current = true;
    const A = fap.libPanelAdapter;
    const G = fap.libIdentityGroups;
    if (!A || typeof A.planTargetLanguageEntry !== 'function') return;
    mutate(d => {
      const plan = A.planTargetLanguageEntry(
        d.languages, upstream, window.LANG_PRESETS,
        G && G.sameLang
      );
      if (!plan) return;                   // 🔴 null is the answer most of the time
      let col;
      if (plan.kind === 'column') {
        col = Object.assign({ id: window.uid('L') }, plan.column);
        if (!Array.isArray(d.languages)) d.languages = [];
        d.languages.push(col);
      } else {
        col = (d.languages || []).find(l => l && l.code === plan.code);
        if (!col) return;                  // planned against a column that vanished
      }
      // The pick-a-font step IS the pending card — FontCard renders it as the inline
      // family picker (the same two-step flow finalizePendingLang already uses).
      col.fonts = [buildPendingFont()];
    });
  }, []);

  const handleDone = (opts) => {
    // 8D-ext-MM step 5 (on-reject surface 2) — validate BEFORE handing the config
    // to the entry script. An INVALID config must not silently degrade (importer
    // would log "cancelled"; standalone apply would no-op). Keep the panel OPEN +
    // show a concise inline error so the user can fix the mapping. Per UX 设计原则:
    // inline error, no debug popup. The auto-unmerge effect resolves A.1↔MM (II-d)
    // conflicts upstream; anything still invalid here (e.g. an A4-merge/MM overlap
    // that is not auto-unmergeable) is surfaced loudly rather than dropped.
    const fap = window.__fap;
    if (fap && fap.libPanelAdapter && typeof fap.libPanelAdapter.panelDataToConfig === 'function') {
      const cv = fap.libPanelAdapter.panelDataToConfig(data);
      if (!cv.ok) {
        setActionError('Mapping is invalid — nothing was applied: ' + (cv.errors || []).slice(0, 3).join('; '));
        return;
      }
    }
    // The OQ-2 Done gate is GONE: it existed to refuse a `real` the font could not
    // honour, and this panel no longer authors `real` at all (charter §7.4,
    // 2026-08-07 — "真斜体不是一种实现方式"). A hand-edited config can still carry
    // mode:"real", which is why the APPLY path keeps its block as the safety floor;
    // a gate here would have nothing left to catch.
    setActionError(null);
    // W1: "wired" must mean the SAME thing here as it does for the port — a member
    // with a real cross-lang counterpart. Building this from raw membership is what
    // let a node whose only partner was unplaceable count as paired, skip the red
    // outline, and stay out of this very count.
    const wiredNodeIds = new Set();
    (data.pairings || []).forEach(p => (p.members || []).forEach(m => {
      if (nodeHue({ lang: m.lang, font: m.font, node: m.node })) wiredNodeIds.add(m.node);
    }));
    // 8D-ext-bypair-tofu-ux Phase 2: source-present-unpaired (tofu-risk) Done-confirm.
    // Count VISIBLE nodes (deriveVisibleNodes — same set WeightNode renders, so the
    // count == # of red outlines) that are used-in-doc + unpaired (not in wiredNodeIds)
    // + source-side (lang NOT a CJK target column, via the seeded cjkLangs SoT).
    // forceTofu (from the popup's "ignore & continue") bypasses — NOT a state flag, to
    // avoid the async-setState same-tick stale read.
    // #28e (owner 2026-08-13 CTA ruling): missing faces DO gate Done again —
    // same detection shape as tofu. SAME derivation as the render
    // (deriveVisibleNodes + the same fold args) and THE same predicate
    // WeightNode renders from (window.nodeMissingFaces on
    // data._missingFaceKeys), so popup count == # of red outlines by
    // construction. Iterates ALL langs (unlike tofu's source-side filter —
    // byPair dst faces live in the CJK target columns). Ignorable by design
    // (owner: 「可忽略的」) — forceTofu bypasses both checks, Done never refused.
    if (!(opts && opts.forceTofu === true)) {
      const _cjk = (fap && fap.cjkLangs) || {};
      let _tofuCount = 0;
      let _missCount = 0;
      const _missFaceLabels = [];
      (data.languages || []).forEach(l => {
        const _folded = window.egFoldedWeightSet(data.equivalence_groups, l.code,
          (mmFoldSkipByLang && mmFoldSkipByLang[l.code]) || null);
        (l.fonts || []).forEach(f => {
          window.deriveVisibleNodes(f, _folded).nodes.forEach(n => {
            if (!_cjk[l.code]) {   // CJK target column → not a source font
              const uc = n.kind === 'weight'
                ? (n.weight.used || 0)
                : (n.members || []).reduce((a, m) => a + (m.used || 0), 0);
              if (uc > 0 && !wiredNodeIds.has(n.id)) _tofuCount++;
            }
            const _mf = window.nodeMissingFaces
              ? window.nodeMissingFaces(data._missingFaceKeys, f.name, n) : [];
            if (_mf.length > 0) {
              _missCount++;
              _mf.forEach(w => _missFaceLabels.push(f.name + ' · ' + w));
            }
          });
        });
      });
      if (_tofuCount > 0 || _missCount > 0) {
        setTofuFlagActive(_tofuCount > 0);
        setTofuWarn(_tofuCount > 0 ? _tofuCount : null);
        setMissFlagActive(_missCount > 0);
        setMissWarn(_missCount > 0 ? { count: _missCount, faces: _missFaceLabels } : null);
        return;
      }
    }
    setTofuWarn(null);
    setMissWarn(null);
    if (fap && typeof fap.onDone === 'function') {
      // Phase 8D-ext-0: pass skipDecisions + runEnforcer to entry script.
      // UNIFY-converge Phase 1 B-core (③ target-lang chain): thread the
      // user-selected primaryLang so the panel adapter can resolve the CJK
      // target authoritatively (priority chain step 2) instead of leaning on
      // the scanner's Han→zh-CN collapse. Empty "" → falls through the chain.
      try { fap.onDone(data, skipDecisions, runEnforcer, primaryLang); }
      catch (e) { console.error('[font_apply_panel] onDone threw:', e); }
    }
  };

  // Codex r2 P1-4 fix: recompute unresolvedByLang whenever data.pairings
  // changes. We use the host-provided lib (window.__fap.libDocScan) +
  // tsrMap (window.__fap.scanTsrMap) which entry script attaches at startup.
  useEffect(() => {
    const fap = window.__fap;
    if (!fap || !fap.libDocScan || !fap.libPanelAdapter || !fap.scanTsrMap) return;
    try {
      const cv = fap.libPanelAdapter.panelDataToConfig(data);
      if (!cv.ok) {
        // Invalid config (e.g. mid-edit) — keep last value
        return;
      }
      const u = fap.libDocScan.buildUnresolvedByLang(fap.scanTsrMap, cv.config);
      /* 🔴 #96：原本无条件 `setUnresolvedByLang(u)`，而 `u` 每次都是新构造
         ⇒ 内容一样也照样换身份、照样重渲染。与 setPortPos 同为循环的"泵"。
         紧邻下面的 setIdentityBuild 早就用了内容比较（`JSON.stringify` 相等则
         返回 prev）——**正确范式就在旁边三行**，这里只是漏了。 */
      setUnresolvedByLang(prevU => {
        try { if (JSON.stringify(prevU) === JSON.stringify(u)) return prevU; } catch (eU) {}
        return u;
      });

      // TODO#58 — recompute the identity groups against the current config.
      // 🪦 replaces `detectRecombinationCandidates` (normalize() +
      // STYLE_ALIAS_TABLE). The universe is the same as before — document fonts ∪
      // the config's own source fonts — so a canonical that lives only in the
      // config still joins its group; what changed is the CRITERION: two spellings
      // group only when `Font.postscriptName` says they are one installed face.
      //
      // 🔴 If `fontIdentity` is missing (a host that did not bind it) we emit
      // NOTHING. There is deliberately no name-based fallback: the whole point of
      // this change is that a merge happens only when identity can be PROVEN.
      const FIGlib = fap.libIdentityGroups;
      if (FIGlib && typeof fap.fontIdentity === 'function') {
        // The universe rule (document fonts ∪ config source fonts, and where each
        // one's `lang` comes from) lives in the lib so it is covered by the gate
        // rather than only by opening this dialog.
        const entries = FIGlib.buildPanelEntries(
          fap.documentFonts, fap.byFamilyHomeLang, cv.config.fonts_by_language);
        const build = FIGlib.buildIdentityGroups(entries, fap.fontIdentity);
        // Content-compared: this effect runs on every `data` change, and a fresh
        // object each time would re-enter the commit effect (and re-render) even
        // when the answer did not move.
        setIdentityBuild(prev => (prev && JSON.stringify(prev) === JSON.stringify(build)) ? prev : build);
      }
    } catch (e) {
      // swallow; partial data during edit
    }
  }, [data]);

  // TODO#58 — commit every PROVEN identity group (no per-row click, as before).
  // 🔴 What changed is not the automation, it is what is allowed to trigger it:
  // the machine now merges only what `Font.postscriptName` proves is one face, and
  // stays out of everything else. "Merged less" is an accepted, REPORTED outcome
  // (the (5) readout); "merged two different faces" is not.
  //
  // Two guards survive from A.1 verbatim, for reasons that did not change:
  //   • MM ownership — never fold a weight an operator explicitly MM-connected,
  //     else the fold re-creates the II-d (A/MM overlap) conflict that the
  //     auto-unmerge effect below just resolved → fold ⇄ unmerge loop. Explicit
  //     operator intent outranks anything the machine does on its own.
  //   • dismissal — an un-merged group is not re-created this session.
  // TERMINATION: `applyIdentityGroups` is idempotent (it only ever ADDS members
  // that are not already there), and we return `prev` untouched when it reports
  // nothing added/extended/re-parented → no state change → fixpoint.
  useEffect(() => {
    const FIGlib = window.__fap && window.__fap.libIdentityGroups;
    if (!FIGlib || !identityBuild.groups.length) return;

    const eligible = [];
    identityBuild.groups.forEach(g => {
      const lang = g.lang || 'en';
      const mmSkip = mmFoldSkipByLang[lang] || {};
      if (mmSkip[g.canonical.font + '␟' + g.canonical.weight]) return;   // MM owns the canonical
      const members = (g.merged_in || []).filter(
        m => !mmSkip[m.font + '␟' + m.weight]);                          // …or an individual member
      if (!members.length) return;
      eligible.push({ lang, canonical: g.canonical, merged_in: members, _origin: 'machine-auto' });
    });
    if (!eligible.length) return;

    // Graded against the CURRENT render's egs so the readout can name what an
    // operator eg refused to give up; the write below re-derives from `prev`, so a
    // concurrent setData cannot be lost.
    const preview = FIGlib.applyIdentityGroups((data && data.equivalence_groups) || [], eligible);
    setIdentityApply(prev => (prev && JSON.stringify(prev) === JSON.stringify(preview)) ? prev : preview);
    setData(prev => {
      const d = JSON.parse(JSON.stringify(prev));
      if (!Array.isArray(d.equivalence_groups)) d.equivalence_groups = [];
      const res = _applyIdentityGroupsTo(d, eligible);
      if (!res) return prev;
      if (!res.added.length && !res.extended.length && !res.reparented.length) return prev;
      return d;
    });
  }, [identityBuild, mmFoldSkipByLang]);

  // #58 ③ / 6C (owner): at load, SAY which groups the font engine disproves —
  // both weights installed here, but reporting different PostScript names, so
  // "these are one face" is not uncertain, it is wrong. Give one click to drop the
  // wrong member.
  //
  // 🔴 NEVER a silent repair. owner was explicit that his config is not to be
  // edited behind his back (design-intent §8), and these groups can be perfectly
  // deliberate on another machine — the criterion only speaks for THIS one.
  // 🔴 Silence whenever the engine cannot answer: not installed, empty
  // PostScript name, or a lookup that throws ⇒ NOT listed. "I could not check" is
  // not evidence of "wrong" (the lib helper enforces this; the tests pin it).
  const falsifiableGroups = useMemo(() => {
    const FIGlib = window.__fap && window.__fap.libIdentityGroups;
    const idOf = window.__fap && window.__fap.fontIdentity;
    if (!FIGlib || typeof FIGlib.findFalsifiableGroups !== 'function' || typeof idOf !== 'function') return [];
    try { return FIGlib.findFalsifiableGroups((data && data.equivalence_groups) || [], idOf); }
    catch (e) { return []; }
  }, [data]);

  // 🪦 `dropGroupMember` RETIRED with the strip (A11, owner 2026-08-28: a11 去掉提示).
  // It was the strip's one verb ("Not the same font"); with no strip there is no
  // click to serve, and a handler nothing can call is a claim that an affordance
  // exists. lib removeGroupMember and its unit tests stay — the LIBRARY is not the
  // UI, and re-adding a surface for it later should not have to rebuild the verb.

  // A11 — the criterion still RUNS, it just no longer interrupts. owner removed the
  // strip under the panel's standing UI rule (提示类发版前清掉), not because the
  // finding stopped mattering, so this publishes it on the same channel the five
  // identity counters already use: window.__fap for a probe/bridge read, plus one
  // trace line per session so it is in the record of a run nobody was watching.
  // 🔴 Answering arch's 顺手确认 honestly: BEFORE this, the strip was the ONLY place a
  // disproved group was visible anywhere — remove it with nothing added and the
  // finding would have vanished from the product entirely.
  // ⚠ The body lives in the LIB (reportFalsifiableGroups), not here, and the reason
  // is not tidiness: while it sat in this effect, mutations that disabled it survived
  // the entire offline suite, because nothing in Node can execute a line of app.jsx.
  // What is left here is the one call no offline test can reach — pinned instead by
  // a host probe (see tests/spikes/mutations/quiet_surfaces.py NOTES).
  // ⚠ `window.` prefix, not a bare call: app.jsx reaches components.jsx symbols
  // through the global object everywhere else (window.Icon), because the two files
  // are separate (0,eval) evaluations and only that convention is exercised in
  // production. Same reason the picker branches say window.fapTrace.
  const falsTraceRef = useRef('');
  useEffect(() => {
    const FIGlib = window.__fap && window.__fap.libIdentityGroups;
    if (!FIGlib || typeof FIGlib.reportFalsifiableGroups !== 'function') return;
    falsTraceRef.current = FIGlib.reportFalsifiableGroups(
      falsifiableGroups, falsTraceRef.current,
      { publish: gs => { if (window.__fap) window.__fap.falsifiableGroups = gs; },
        trace: window.fapTrace });
  }, [falsifiableGroups]);

  // TODO#58 (5) — the five counters, DERIVED. 🔴 They stay APART: there is no
  // total and no "issues" rollup, because owner's question is 「因为没装而没合」 and
  // that is `notInstalled` ALONE. The other four are different kinds of event —
  // see lib/font_identity_groups.js summarizeIdentityReadout for what each means
  // and why `overlaps` is the only one that affects the PRODUCT rather than just
  // meaning "merged less".
  //
  // Derived rather than stored because two effects were otherwise both patching one
  // state object — build-time knows three of the counters, commit-time knows the
  // other two — and whichever ran last decided what the panel reported.
  // 🔴 NOT rendered anywhere yet, on purpose: WHERE (and whether) the operator
  // should see these is a product decision arch is taking to owner. Exposed on
  // `window.__fap` so the host log / a probe can read it without a UI.
  const identityReadout = useMemo(() => {
    const FIGlib = window.__fap && window.__fap.libIdentityGroups;
    if (!FIGlib) return null;
    return FIGlib.summarizeIdentityReadout(
      identityBuild, identityApply,
      (identityApply && identityApply.egs) || (data && data.equivalence_groups) || []);
  }, [identityBuild, identityApply, data]);

  // Published for the host log / a probe. ⚠ This OVERWRITES the scan's seed value
  // with the live one; the seed is only read at mount, and the scan's own copy
  // stays in scanResult.identity_readout if anyone needs the before picture.
  useEffect(() => {
    if (window.__fap) window.__fap.identityReadout = identityReadout;
  }, [identityReadout]);

  // 8D-ext-MM step 5 (B side 1) — A.1↔MM auto-unmerge. When the user MM-connects
  // a weight that A.1 already auto-folded into a recombination eg (same lang),
  // that (lang,font,weight) becomes BOTH an MM multi-member AND an eg merged_in →
  // validateBrandConfig II-d (A/MM overlap) would reject, and the offending node
  // may be hidden by the fold (hard to un-connect). Explicit MM intent outranks
  // the auto fold: delete the conflicting RECOMB eg (un-fold) here, BEFORE
  // export/validate.
  // TERMINATION: this effect re-runs on EVERY data change — `mmFoldSkipByLang`
  // is a new object reference each render (useMemo on `resolvedPairLibs`, itself
  // useMemo on `data`), so deleting an eg DOES retrigger it; it just no-ops.
  // Convergence rests on two things, NOT on dep-array stability:
  //   (a) this effect is DELETE-ONLY + idempotent — `return prev` when nothing
  //       was removed → no state change → no re-render → fixpoint; and
  //   (b) the identity commit effect's MM-ownership guard prevents re-creating an
  //       eg that was deleted because MM owns it, so there is no delete⇄re-create
  //       loop. (It no longer needs a dismissal set — owner retired un-merge,
  //       姿态甲 2026-08-20, so nothing else deletes one of our groups.)
  // (Operator-authored / imported egs are NOT auto-unmerged — they carry no
  // `_origin`, so if one ever overlaps an MM member, II-d still trips at
  // Done/Export and handleDone surfaces it non-silently: the "auto-unmerge
  // impossible → loud reject" fallback.)
  useEffect(() => {
    setData(prev => {
      const d = JSON.parse(JSON.stringify(prev));
      if (!Array.isArray(d.equivalence_groups) || !d.equivalence_groups.length) return prev;
      const removed = [];
      d.equivalence_groups = d.equivalence_groups.filter(eg => {
        if (!_isMachineAuto(eg)) return true;
        const mmSkip = mmFoldSkipByLang[eg.lang] || {};
        const collides = (eg.merged_in || []).some(mi => mi && mmSkip[mi.font + '␟' + mi.weight])
          || (eg.canonical && mmSkip[eg.canonical.font + '␟' + eg.canonical.weight]);
        if (collides) removed.push(eg);
        return !collides;
      });
      if (!removed.length) return prev;
      return d;
    });
    // 🪦 The `setAutoMerged` mirror that used to live here is GONE (TODO#58 (c)).
    // The review strip is DERIVED from `data.equivalence_groups` now, so deleting
    // the eg above IS the removal of its row — there is no second list to keep in
    // step, and therefore no way for the two to disagree.
  }, [mmFoldSkipByLang]);

  // 8D-ext-MM step 4 — representative_by_lang normalize effect (replaces the old
  // length===2 hint+accept machinery, per user UX 2026-06-14). This is the panel
  // twin of lib font_mapping_ops._normalizeReps and enforces the SAME invariant:
  // for each pairing, rep[langCode] exists IFF that lang has ≥2 members, and its
  // {font,weight} equals a member (first-connected by default; keep the user's
  // valid choice). It does BOTH:
  //   • PRUNE — delete any rep key whose lang now has ≤1 member or is absent.
  //     This closes [A]: removeFont/removeLang drop a lang to 1 but leave an
  //     orphan rep pointing at the deleted font → validateBrandConfig lenient
  //     cross-ref reject → panelDataToConfig ok:false → host config:null →
  //     importer silently applies NO font mapping. Pruning keeps the config valid
  //     so removeFont/removeLang need no rep-specific code of their own.
  //   • SET/KEEP — auto first-connected rep for ≥2-member langs.
  // Runs on every data change so it catches ALL paths (applyPair, addPairMember
  // picker, label link, merge, removeFont/removeLang). Idempotent: returns the
  // SAME prev ref when nothing changes, so the [data] dep converges in ≤2 cycles.
  // NB: members use lang IDs (L_en) but rep is lang-CODE-keyed (en) — group by
  // CODE so prune compares like-for-like.
  useEffect(() => {
    // #33d mitigation: the SET branch below is the machine INVENTING a rep
    // (first-connected). Record which (pairId|langCode) it fires for, so the
    // node can say so (session-only; cleared by an explicit setPairRep).
    // Detection walks `data` (this effect's own dep) while the mutation walks
    // `prev` — the file's established sibling-walk pattern (see the
    // auto-unmerge effect + setAutoMerged above); the VALIDITY predicate is
    // the one shared function below so the condition itself cannot fork.
    const _repIsValid = (rep, memLibs) => !!(rep && rep.font && rep.weight &&
      memLibs.some(ml => ml.font === rep.font && ml.weight === rep.weight));
    const machineSet = [];
    {
      const codeOfD = (langId) => {
        const lo = (data.languages || []).find(l => l.id === langId || l.code === langId);
        return lo ? (lo.code || lo.id) : langId;
      };
      (data.pairings || []).forEach(pair => {
        if (!Array.isArray(pair.members)) return;
        const byCode = {};
        pair.members.forEach(m => { const c = codeOfD(m.lang); (byCode[c] = byCode[c] || []).push(m); });
        Object.keys(byCode).forEach(code => {
          const mems = byCode[code];
          if (mems.length < 2) return;
          const memLibs = mems.map(m => resolveMemberToLib(data, m)).filter(Boolean);
          if (memLibs.length < 2) return;
          const rep = pair.representative_by_lang && pair.representative_by_lang[code];
          if (!_repIsValid(rep, memLibs)) machineSet.push(pair.id + '|' + code);
        });
      });
    }
    // Provenance: this pass digests either just-imported data ('load' — the
    // ref is armed by mount/handleImport and consumed here) or the result of
    // an in-session gesture ('wire'). Consumed AFTER the walk so every key
    // detected in the same pass gets the same source.
    const repSource = repSourceIsLoadRef.current ? 'load' : 'wire';
    repSourceIsLoadRef.current = false;
    if (machineSet.length) {
      setAutoRepKeys(prev => {
        let any = false;
        const n = Object.assign({}, prev);
        machineSet.forEach(k => { if (!n[k]) { n[k] = repSource; any = true; } });
        return any ? n : prev;
      });
    }
    setData(prev => {
      let changed = false;
      const d = JSON.parse(JSON.stringify(prev));
      const codeOf = (langId) => {
        const lo = (d.languages || []).find(l => l.id === langId || l.code === langId);
        return lo ? (lo.code || lo.id) : langId;
      };
      (d.pairings || []).forEach(pair => {
        if (!Array.isArray(pair.members)) return;
        const byCode = {};
        pair.members.forEach(m => { const c = codeOf(m.lang); (byCode[c] = byCode[c] || []).push(m); });
        // 1) PRUNE rep keys for codes with ≤1 member (or absent)
        if (pair.representative_by_lang) {
          Object.keys(pair.representative_by_lang).forEach(code => {
            const mems = byCode[code];
            if (!mems || mems.length < 2) { delete pair.representative_by_lang[code]; changed = true; }
          });
        }
        // 2) SET/KEEP first-connected valid rep for ≥2-member codes
        Object.keys(byCode).forEach(code => {
          const mems = byCode[code];
          if (mems.length < 2) return;
          const memLibs = mems.map(m => resolveMemberToLib(d, m)).filter(Boolean);
          if (memLibs.length < 2) return; // unresolvable mid-edit — wait
          if (!pair.representative_by_lang) pair.representative_by_lang = {};
          const rep = pair.representative_by_lang[code];
          if (!_repIsValid(rep, memLibs)) {
            pair.representative_by_lang[code] = { font: memLibs[0].font, weight: memLibs[0].weight };
            changed = true;
          }
        });
        // 3) drop an emptied container (keeps round-trip clean)
        if (pair.representative_by_lang && Object.keys(pair.representative_by_lang).length === 0) {
          delete pair.representative_by_lang; changed = true;
        }
      });
      return changed ? d : prev;
    });
  }, [data]);

  // Export shared context for B-section component (added via window.__fap.ctx)
  useEffect(() => {
    if (window.__fap) {
      window.__fap.ctx = {
        unresolvedByLang,
        skipDecisions, setSkip,
        runEnforcer, setRunEnforcer,
        addPairMember,
        data, setData,
        primaryLang, setPrimaryLang  // 8D-ext-C
      };
    }
  }, [unresolvedByLang, skipDecisions, runEnforcer, data, setSkip, addPairMember, primaryLang]);

  // Import / Export — entry script provides window.__fap.{importJson, exportJson}
  // using UXP lfs.getFileForOpening / getFileForSaving. Both return
  // { ok, data?, path?, reason? }. 8D-ext-MM step 5 (gate-4 + UX 原则): all error
  // paths route to the inline `actionError` banner — window.alert reliability
  // inside a UXP <dialog> modal is suspect (could be silent), so it is NOT used.
  const handleImport = async () => {
    if (!window.__fap || typeof window.__fap.importJson !== 'function') {
      setActionError('Import unavailable (fap.importJson is missing).');
      return;
    }
    const r = await window.__fap.importJson();
    if (!r.ok) {
      // 🔴 THIS LINE USED TO READ:
      //     if (r.reason !== 'user cancelled') setActionError('Import failed: ' + r.reason);
      // — and that silent `return` on a cancel is the whole dead-end owner hit
      // (2026-08-22): the picker is falsy for BOTH "cancelled" and "device returned
      // nothing", so a device fault looked exactly like a click that did nothing.
      // No stuck state was ever involved; the button stayed live the whole time.
      // The decision now lives in lib/picker_outcome.js so it can be tested in Node
      // and so BOTH hosts share it.
      // ⚠ If the host is older and did not hand one over, we surface rather than
      // fall back to the old behaviour — a fallback here would silently restore the bug.
      const classify = window.__fap.classifyImportOutcome;
      const verdict = classify ? classify(r) : { kind: 'error', text: 'Import failed: ' + r.reason };
      // A10: "log" is quiet ON SCREEN, never quiet in the record. Dropping the text
      // here is the whole original defect wearing a new coat, so the trace write is
      // the branch's only job and picker_outcome_tests.js asserts this source.
      if (verdict.kind === 'log') window.fapTrace('import:quiet', { reason: r.reason, text: verdict.text });
      else setActionError(verdict.text);
      return;
    }
    // Basic shape check
    if (!r.data || !Array.isArray(r.data.languages)) {
      setActionError('Import: that file is not panel state (no languages[]).');
      return;
    }
    setData(r.data);
    // #43: ONE call decides what a fresh Import resets. The rule (and the
    // reasoning for each entry, including the two that must NOT be reset here)
    // lives in data.jsx `computeImportStateReset` — pure, therefore testable;
    // this function only applies it. Before the 2026-08-22 sweep this block was
    // three hand-written lines that had grown one patch at a time, and five
    // more session maps were silently surviving the import.
    const __reset = window.computeImportStateReset(r.data, window.__fap);
    setSkipDecisions(__reset.skipDecisions);
    setAutoMerged(__reset.autoMerged);
    setRecombDismissed(__reset.recombDismissed);
    setConfirmableMerges(__reset.confirmableMerges);
    setPrimaryLang(prev => __reset.keepPrimaryLang(prev));
    setAutoRepKeys(__reset.autoRepKeys);
    setAutoFauxKeys(__reset.autoFauxKeys);
    // Any rep the normalize pass now invents is inherited state ('load'),
    // not feedback to a gesture.
    repSourceIsLoadRef.current = true;
  };
  const handleExport = async () => {
    if (!window.__fap || typeof window.__fap.exportJson !== 'function') {
      setActionError('Export unavailable (fap.exportJson is missing).');
      return;
    }
    const r = await window.__fap.exportJson(data);
    // 🔴 Swept with the import side: `getFileForSaving` is falsy for BOTH a
    // cancel and a device that returned nothing, and this branch swallowed that
    // single reason exactly as silently. Same classifier, different noun — a second
    // copy of the decision is how the two hosts drifted apart to begin with.
    // 8D-ext-MM step 5 still holds: an invalid config surfaces inline, not as a popup.
    const classifyX = window.__fap.classifyExportOutcome;
    const vx = classifyX ? classifyX(r) : (r.ok ? { kind: 'ok', text: '' }
                                               : { kind: 'error', text: 'Export failed: ' + r.reason });
    // Same routing as import, from the same classifier — see the A10 note there.
    if (vx.kind === 'log') { window.fapTrace('export:quiet', { reason: r.reason, text: vx.text }); setActionError(null); }
    else if (vx.kind === 'error') setActionError(vx.text);
    else setActionError(null);
  };

  // #28e-port (W1's leftover half): logical wire set + per-side port lighting.
  // Derived from pairings ONLY (data.jsx deriveLogicalWires — the same list the
  // wire renderer consumes below), NOT from rendered wires/portPos: culling
  // must never change the lit set (pan-flicker), and a second partner
  // computation would drift from the wire loop. A port is lit iff it is the
  // endpoint of some logical wire ON ITS SIDE.
  const langOrder = {};
  data.languages.forEach((l, i) => { langOrder[l.id] = i; });
  const logicalWires = window.deriveLogicalWires
    ? window.deriveLogicalWires(data.pairings, langOrder) : [];
  const portLitMap = {};
  logicalWires.forEach(w => { portLitMap[w.from] = w.hue; portLitMap[w.to] = w.hue; });
  const portLit = (addr, side) => portLitMap[`${addr.lang}:${addr.font}:${addr.node}:${side}`] || null;

  // #45 — hover a weight ⇒ its relation set stays, the rest dims.
  // Detection: native pointerenter/pointerleave on the node root (probe
  // 20260813_16: standard W3C semantics verified in THIS dialog — parent
  // leave does NOT mis-fire on child entry, so no flicker path; React
  // synthetic hover never dispatches here, gate-4a). Single state source:
  // hoverHl is the ONLY place highlight lives — null ⇒ no dim class anywhere,
  // so a stuck half-highlight is unconstructible (no second state to drift).
  // Drag disables it: wire-dim already owns that visual channel during drags
  // (one channel, one meaning — arch-confirmed), the gate ref keeps stale
  // enter events from re-arming mid-drag.
  const [hoverHl, setHoverHl] = useState(null);
  const hoverDragGate = useRef(false);
  useEffect(() => {
    hoverDragGate.current = !!drag;
    if (drag) setHoverHl(h => (h ? null : h));
  }, [drag]);
  const onNodeHover = useCallback((addr) => {
    if (hoverDragGate.current) return;
    setHoverHl(addr);
  }, []);
  const hoverRel = useMemo(() => (hoverHl && window.computeHoverRelationSet)
    ? window.computeHoverRelationSet(hoverHl, data.pairings) : null, [hoverHl, data]);
  // Renderer applies these; it never re-derives membership (SoT discipline).
  /* owner 2026-09-09 选 B′：#45 的 dim 只在【关系集里真有别人】时才压暗。
     Why：dim 的用途是"把这个字重连到谁"从一堆交叉连线里择出来(#45)。
     若这个字重根本没配对, 关系集只有它自己 —— 压暗其余五个什么都没告诉你,
     只是让面板变黑。owner 报的「hover 时某个节点变深」就是这个场景。
     ⚠ 判据用关系集大小, 不用"pairings 是否为空": 一个字重可能在别处有配对
       而本身没有, 那时它的关系集仍是 {self}, 同样不该 dim。 */
  const hoverRelActive = useMemo(() => {
    if (!hoverRel || !hoverRel.nodes) return false;
    let n = 0;
    for (const k in hoverRel.nodes) { n++; if (n > 1) return true; }
    return false;
  }, [hoverRel]);
  const hlDimNode = useCallback((addr) =>
    !!(hoverRelActive && hoverRel && !hoverRel.nodes[`${addr.lang}:${addr.font}:${addr.node}`]),
    [hoverRel, hoverRelActive]);
  const hlDimPid = useCallback((pid) =>
    !!(hoverRelActive && hoverRel && !hoverRel.pids[pid]), [hoverRel, hoverRelActive]);

  const ctx = {
    data, drag, registerPort, nodeHue, openMenu, profile, wireConnectable,
    devLabels,                // Advanced options — component-name titles (dev aid, default off)
    portLit,                  // #28e-port — per-side lighting (logical wire endpoints)
    onNodeHover, hlDimNode, hlDimPid,   // #45 — hover relation-set highlight
    onStartNode, onStartWire,
    setFontName, setLangName, setRep, unmergeAll,
    addFont, removeFont, removeLang,
    removePairing, setPairingLabel,
    installedFamilies, finalizePendingFont, finalizePendingLang,
    pairRepInfo, setPairRep,  // 8D-ext-MM step 4 — MM same-lang representative marker
    mmFoldSkipByLang,         // 8D-ext-MM step 5 — A.1 fold-skip for MM-owned weights
    tofuFlagActive,           // 8D-ext-bypair-tofu-ux Phase 2 — red outline only after Done-detect
    missFlagActive,           // #28e — missing-font red outline, same Done-gated lifecycle (owner 2026-08-13)
    missingFaceKeys: data._missingFaceKeys,   // #28e — adapter precompute (nodeMissingFaces input)
    // univ-italic §7.4 ② — per-weight italic HOW, keyed by contract-K winner
    italicInfo, createItalicVariant, setItalicMode, setItalicAngle, deleteItalicVariant,
    autoFauxKeys,    // #41 — session-added auto-faux winner keys (first-time notice gate)
    italicOrphans,   // AC⑦ orphan block
    unplaceableMembers, materializeParked,   // TODO #32(a) / design F
  };

  // ---------- wire geometry -------------------------------------------------
  // Cubic-bezier control points for the gentle S between port A and B.
  const wireCtrl = (a, b) => {
    const dx = Math.max(36, Math.abs(b.x - a.x) * 0.42);
    return { c1: { x: a.x + dx, y: a.y }, c2: { x: b.x - dx, y: b.y } };
  };
  const wirePath = (a, b) => {
    const { c1, c2 } = wireCtrl(a, b);
    return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
  };
  // Wire descriptor carrying both the SVG path string AND its endpoints +
  // control points, so the geometric hit-test (window.WireHitTest) can measure
  // cursor→curve distance without re-deriving port positions. Needed because
  // UXP webview ignores pointer-events:stroke on the <path> (findings.md
  // #uxp-dialog-webview-api-gaps) — clicks are caught geometrically instead.
  const wireGeom = (a, b) => {
    const { c1, c2 } = wireCtrl(a, b);
    return { d: wirePath(a, b), a, b, c1, c2 };
  };
  // #28e-port: geometry pass ONLY — the wire topology (incl. the 8D-ext-MM
  // step-4 cross-lang/same-lang rules and the labelLinked gate) lives in
  // data.jsx deriveLogicalWires, shared with the port-lighting map above.
  // A logical wire whose endpoint is culled out of the viewport (no portPos
  // entry) just skips its geometry; the lit set is unaffected by construction.
  const wires = [];
  logicalWires.forEach(w => {
    const A = portPos[w.from];
    const B = portPos[w.to];
    // 🔴 `from`/`to` are carried through VERBATIM from deriveLogicalWires. They
    // are the ids of the ports this wire is SUPPOSED to connect, and the pixel
    // rig's endpoint gate needs them to say "the right port" instead of merely
    // "a port" (measured: an endpoint moved by ~2× the 47px port pitch lands
    // inside a DIFFERENT port and the weaker check passes).
    // ⛔ Do NOT re-assemble these strings here from lang/font/node — that would
    //   be a second source of truth for an id deriveLogicalWires already owns.
    if (A && B) wires.push({ id: w.id, pid: w.pid, hue: w.hue, from: w.from, to: w.to, ...wireGeom(A, B) });
  });
  let live = null;
  if (drag && drag.type === 'wire' && drag.cursor) {
    const A = portPos[drag.fromId];
    if (A) live = drag.side === 'R' ? wirePath(A, drag.cursor) : wirePath(drag.cursor, A);
  }

  // Keep the capture-listener's refs pointing at this render's values (wires
  // carry endpoints for the geometric hit-test; openMenu/removePairing are
  // recreated each render). The listener itself is bound once in the pan
  // useEffect and reads through these refs.
  wiresRef.current = wires;
  openMenuRef.current = openMenu;
  removePairingRef.current = removePairing;

  // ---------- unified-weight (label) card positions ------------------------
  const labelCards = data.pairings.map((p, i) => {
    const ms = [...p.members].sort((a, b) => langOrder[a.lang] - langOrder[b.lang]);
    const lead = ms[0];
    const lp = lead && portPos[`${lead.lang}:${lead.font}:${lead.node}:L`];
    return { p, y: lp ? lp.y : (70 + i * 70) };
  });

  // `no-pops` is a ROOT class, not a per-element edit: the .chip-pop reveal is
  // pure-CSS `:hover` on ~8 carriers, so one ancestor class switches them all.
  // ⚠ display, not opacity — opacity is write-only at runtime in this dialog
  // (pixel-probed 2026-08-14, panel.css:258-271).
  return (
    <div className={`app ${hoverPops ? '' : 'no-pops'}`} data-profile={profile}>
      {/* 8D-ext-bypair-tofu-ux Phase 2: top-right Done-confirm for source-present
          unpaired doc fonts. Designer-friendly wording (no "tofu"). [取消] is the
          emphasis/primary button; [忽略并继续] secondary; clicking the overlay
          (outside the box) = 取消. 闸门4: div-buttons + overlay onClick (no
          elementFromPoint). The box is anchored top-right via .app{position:relative}. */}
      {/* #28e (owner 2026-08-13 CTA ruling): the missing-font section mirrors
          the tofu popup verbatim — same overlay (click-outside = 取消), same
          box/anchor, same two buttons with the same semantics (忽略并继续
          bypasses via forceTofu — Done is NEVER refused, owner: 「可忽略的」;
          取消 returns TO THE PANEL, which is what makes the Done-gated red
          outlines visible afterwards — mirror precondition verified). Every
          sentence has a measured source:
          - 不会执行/保持原字体: byPair_char_sweep.js:221-228 (stage1Reject
            never enters validByPair) + style_applier.js:1600-1602
            (face_not_installed → skip, NO ghost substitution).
          - 退出脚本→装→重新运行, NOT 「重新导入」: installedFamilies is a
            launch-time snapshot (font_mapping_panel_ui.js Step 1a) — in-panel
            Import does not refresh it.
          - 换成本机有的字体 is really doable in-panel: the + Add font picker
            lists ONLY installed families (components.jsx:721-743
            FamilyPickerCard reads ctx.installedFamilies), wire to the new node.
          No probability words, no implementation vocabulary (owner: 过于面向
          ai 不符合用户认知). */}
      {/* owner 2026-08-13: the WHOLE popup is English (option b — align with the
          panel's own UI language), one font per line, one step per line, one
          button-consequence per line. Scope is THIS component only; the other
          Chinese blocks in the panel are a separate line item owned by arch.
          ⚠ Tense/certainty is deliberate and MUST stay split: "will not run"
          (miss) is a CERTAINTY (stage1Reject never enters validByPair);
          "may not display correctly" (tofu) is GENUINE uncertainty. Do not
          "unify the tone" in either direction. Every sentence maps 1:1 to the
          measured Chinese original (sources: byPair_char_sweep.js:221-228,
          style_applier.js:1600-1602, launch-snapshot installedFamilies,
          FamilyPickerCard components.jsx:721-743, button handlers below). */}
      {(tofuWarn || missWarn) ? (
        <div className="tofu-pop-overlay" onClick={() => { setTofuWarn(null); setMissWarn(null); }}>
          <div className="tofu-pop" role="dialog" aria-label="Pre-apply notices"
            onClick={(e) => e.stopPropagation()}>
            {tofuWarn ? (
              <div className="tofu-pop-msg">
                {tofuWarn} font{tofuWarn > 1 ? 's' : ''} appear{tofuWarn > 1 ? '' : 's'} in this
                document but {tofuWarn > 1 ? 'are' : 'is'} not paired — after applying, some text
                may not display correctly.
              </div>
            ) : null}
            {missWarn ? (
              /* Bold spots follow arch's copy spec verbatim (2026-08-13, option a —
                 scoped font-weight:700 spans, NOT a global b/strong rule): the
                 title line, the words "will not run" ONLY (NOT "will not be
                 replaced with a substitute" — two bolds in one breath dilute
                 each other; that sentence's weight is carried by standing
                 alone), the "To make these mappings work:" heading, and the
                 lead word of each button-consequence line (matching the button
                 labels). tofu section deliberately untouched — its emphasis
                 hierarchy is a separate owner decision. */
              <div className="tofu-pop-msg">
                <div style={{ fontWeight: 700 }}>{missWarn.faces.length} font{missWarn.faces.length > 1 ? 's are' : ' is'} not installed on this machine:</div>
                {missWarn.faces.map((fc, fi) => (
                  <div key={fi} style={{ paddingLeft: '12px' }}>{fc}</div>
                ))}
                <div>
                  Mappings that use them <span style={{ fontWeight: 700 }}>will not run</span> — that
                  text keeps its current font. It will not be replaced with a substitute.
                </div>
                <div style={{ fontWeight: 700 }}>To make these mappings work:</div>
                <div style={{ paddingLeft: '12px' }}>1. Quit this script</div>
                <div style={{ paddingLeft: '12px' }}>2. Install the font{missWarn.faces.length > 1 ? 's' : ''}</div>
                <div style={{ paddingLeft: '12px' }}>3. Run the script again</div>
                <div>
                  Or point these mappings at a font this machine has
                  (“+ Add font” lists installed fonts only).
                </div>
                <div><span style={{ fontWeight: 700 }}>Ignore and continue</span>: all other mappings are applied; the ones above stay as they are.</div>
                <div><span style={{ fontWeight: 700 }}>Cancel</span>: back to the panel; nothing is applied.</div>
                {(unplaceableMembers && unplaceableMembers.length) ? (
                  <div>
                    Note: installing fonts will not clear the blue box above — those entries
                    are the config file disagreeing with itself, unrelated to what is installed.
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="tofu-pop-btns">
              <div role="button" tabindex="0" className="tofu-pop-ignore"
                onClick={() => { setTofuWarn(null); setMissWarn(null); handleDone({ forceTofu: true }); }}
                title="Apply without addressing these notices">Ignore and continue</div>
              <div role="button" tabindex="0" className="tofu-pop-cancel"
                onClick={() => { setTofuWarn(null); setMissWarn(null); }}
                title="Back to the panel">Cancel</div>
            </div>
          </div>
        </div>
      ) : null}
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span className="brand-name">Folio</span>
          <span className="brand-sub">font apply</span>
        </div>
        <div className="topbar-actions">
          {/* 8D-ext-C (2026-06-09) — primary language dropdown.
              Lists every code in data.languages; default tracks
              window.__fap.primaryLang (entry can source from _meta when
              8D-ext-A is wired). Changes propagate through ctx so the
              unresolved-lang section can use it for ordering / filtering
              and future apply-mode gating can read the same value. */}
          <label className="primary-lang-picker" title="Primary (target) language for this doc">
            <span className="primary-lang-label">Primary:</span>
            <select
              value={primaryLang}
              onChange={(e) => setPrimaryLang(e.target.value)}
            >
              <option value="">(auto)</option>
              {(data.languages || []).map(l => (
                <option key={l.id} value={l.code}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
          </label>
          {/* D4 enforcer checkbox (8D-ext-0). Eligibility detection happens
              entry-side; if not eligible, panel still shows the toggle but
              the entry script no-ops the enforcer call. */}
          <window.EnforcerToggle
            value={runEnforcer}
            onChange={setRunEnforcer}
            eligibility={(window.__fap && window.__fap.enforcerEligibility) || null}
          />
          {/* 8D-ext-A: collapsed auto-merge review — button shows the count, toggles the
              strip below (default hidden so it doesn't eat the top of the panel). */}
          {autoMerged.length > 0 && (
            <div role="button" tabindex="0" className={`ghost ${showRecomb ? 'is-on' : ''}`}
              onClick={() => setShowRecomb(v => !v)}
              title="Font spellings the machine merged as one face — click to see which">
              {autoMerged.length} auto-merged <window.Icon name="chevron" size={13} />
            </div>
          )}
          {/* Advanced options — same shape as the auto-merged strip above:
              a ghost button that toggles a strip below, default collapsed so it
              does not eat the top of the panel. */}
          <div role="button" tabindex="0" className={`ghost ${showAdv ? 'is-on' : ''}`}
            onClick={() => setShowAdv(v => !v)}
            title="Advanced options">
            Advanced <window.Icon name="chevron" size={13} />
          </div>
          <div role="button" tabindex="0" className="ghost" onClick={handleImport}
            title="Import panel state from JSON file">
            Import
          </div>
          <div role="button" tabindex="0" className="ghost" onClick={handleExport}
            title="Export current panel state to JSON file">
            Export
          </div>
          <div role="button" tabindex="0" className="primary" onClick={() => handleDone()} title="Apply font mappings to document (undoable)">
            <window.Icon name="check" size={15} /> Done
          </div>
        </div>
      </header>

      {/* 8D-ext-MM step 5 (on-reject surface 2) — concise inline error when
          Done/Export hit an invalid config. NOT a debug popup; cleared on the
          next data edit. Plain px / colors (gate 4: dialog CSS var()/calc()
          may not resolve). */}
      {actionError ? (
        <div role="alert" style={{
          margin: '8px 16px', padding: '8px 12px', borderRadius: '6px',
          background: '#3a1d1d', border: '1px solid #a33', color: '#ffd7d7',
          fontSize: '12px', lineHeight: '1.4'
        }}>{actionError}</div>
      ) : null}

      {/* 🪦 The neutral `.fap-notice` banner lived here until A10 (owner 2026-08-28).
          It carried exactly one message — "the picker returned nothing" — and owner
          ruled that telling someone they pressed Cancel is noise. The message did not
          become untrue, it moved: classifyPickerOutcome returns kind:"log" and
          handleImport/handleExport write it to the panel trace. If a probe is looking
          for `.fap-notice`, read window.fapTraceLatest() instead. */}

      {/* univ-italic AC⑦ (3B) — italic config entries no weight node can reach.
          READ-ONLY + per-entry delete, deliberately NOT auto-pruned: "no claimant"
          is also what environment drift looks like (the installed-name resolver
          absent, or a font spelled differently on this machine), so pruning would
          silently erase live configuration during an ordinary session. Rendered
          only when non-empty, so the normal panel is unchanged. Plain px / literal
          colours (gate 4: var()/calc() may not resolve inside a UXP dialog). */}
      {/* 🪦 The `.fals-strip` lived here until A11 (owner 2026-08-28: a11 去掉提示).
          It listed equivalence groups this machine's font engine disproves (both
          weights installed, different PostScript names) with one "Not the same font"
          verb per row. Removed under the panel's standing UI rule that notice-shaped
          surfaces are cleared before release.
          🔴 The CRITERION was not removed — findFalsifiableGroups, its 14 unit tests
          and its mutation coverage are untouched, and the result is now published to
          window.__fap.falsifiableGroups + one panel-trace line (see the effect near
          the useMemo). A group this machine can prove wrong is still discoverable;
          it just no longer stops the operator to say so.
          ⚠ Consequence to state plainly: nothing on screen mentions it any more, so
          if the finding is ever wanted back in front of a person it needs a NEW
          decision about where — not a revert of this block. */}
      {(italicOrphans && italicOrphans.length) ? (
        <div style={{
          margin: '8px 16px', padding: '8px 12px', borderRadius: '6px',
          background: '#2a2418', border: '1px solid #6b5a2e', color: '#e8dcc0',
          fontSize: '12px', lineHeight: '1.5'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '4px' }}>
            Italic settings: {italicOrphans.length} with no owner
          </div>
          <div style={{ opacity: '0.85', marginBottom: '6px' }}>
            These entries are in the brand_config, but no weight node currently resolves to
            their key — a font or weight may have been removed, an equivalence group may have
            changed, or this is a different machine (where the full font name differs). They
            are still written out with Done and are <b>never deleted automatically</b>; remove
            them one by one once you are sure they are not needed.
          </div>
          {italicOrphans.map(o => (
            <div key={o.key} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '3px 0', fontFamily: 'var(--mono)'
            }}>
              <span style={{ flex: '1' }}>
                {o.entry.font} · {o.entry.weight} · {o.entry.mode}
                {o.entry.mode === 'faux' && typeof o.entry.angle === 'number' ? ' ' + o.entry.angle + '°' : ''}
              </span>
              <div role="button" tabindex="0"
                title={'Delete this orphaned entry from the config. Nothing else changes.'}
                onClick={() => ctx.deleteItalicVariant(o.key)}
                style={{
                  padding: '1px 8px', borderRadius: '4px', cursor: 'pointer',
                  border: '1px solid #6b5a2e', color: '#e8dcc0', fontSize: '11px'
                }}>Delete</div>
            </div>
          ))}
        </div>
      ) : null}

      {/* TODO #32(a) / #29 — design F. Pair members the config names but no node
          can carry: their (lang, font, weight) is not in fonts_by_language, which
          is exactly what validateBrandConfig already rejects — so this is not a
          new condition, it is the validator's existing verdict arriving through
          the one door that never called it (importJson / seedConfig).
          The block REPORTS; it never refuses, and the machine never resolves one
          on its own. Each row carries the validator's own sentence (why it cannot
          be placed — which the triple alone does not say) and one verb. Rendered
          only when non-empty, so the normal panel is unchanged. Plain px /
          literal colours (gate 4: var()/calc() may not resolve in a UXP dialog). */}
      {(unplaceableMembers && unplaceableMembers.length) ? (
        <div className="unplaceable-block" style={{
          margin: '8px 16px', padding: '8px 12px', borderRadius: '6px',
          background: '#1d2a33', border: '1px solid #3d6b86', color: '#cfe6f2',
          fontSize: '12px', lineHeight: '1.5'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '4px' }}>
            Pairing members: {unplaceableMembers.length} cannot be placed on a node here
          </div>
          {/* Every sentence below states a MEASURED behaviour — see
              tests/font_mapping_panel_unplaceable_tests.js and the 2026-08-12 host
              run. Two earlier sentences were removed for being untrue: "撤销"
              (Remove font is not an inverse — it lands in a third state) and
              "文件里其它任何内容都不改" (the live seed path unions doc-present +
              installed styles into the roster, so other entries CAN appear; the
              guarantee that holds is the narrower one stated here). Do not add a
              claim here without a measurement behind it. */}
          <div style={{ opacity: '0.85', marginBottom: '6px' }}>
            These members are written in the config's pairs, but their font / weight is not in
            this language's font list
            (<span style={{ fontFamily: 'var(--mono)' }}>fonts_by_language</span>) —
            so there is no node that can show them. The second line of each row is the reason
            the validator gave.
            <br />
            <b>Do nothing</b>: on Done / Export these members are written back into their
            original pairing <b>verbatim</b>, and <b>no</b> entry is added to the font list
            because of them.
            <br />
            Click <b>“Place on a node”</b>: this font / weight is added to the language's font
            list (the same thing Add font does), and the node appears <b>immediately</b>,
            connected into this pairing.
            <br />
            Afterwards, <b>More → Remove font</b> on that font card <b>deletes the member from
            the pairing</b> — that is <b>not</b> an undo of the previous step; this row does
            <b>not</b> come back.
          </div>
          {unplaceableMembers.map((u, i) => (
            <div className="unplaceable-row"
              key={u.pairingId + '|' + u.lang + '|' + u.font + '|' + u.weight + '|' + i}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '4px 0',
                borderTop: i === 0 ? 'none' : '1px solid #2b3f4d'
              }}>
              <div style={{ flex: '1', minWidth: '0' }}>
                <div style={{ fontFamily: 'var(--mono)' }}>
                  Pairing <b>{u.pairingLabel}</b> · {u.lang} · {u.font} · {u.weight}
                </div>
                {u.diagnostic ? (
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: '11px', opacity: '0.7', marginTop: '1px'
                  }}>{u.diagnostic}</div>
                ) : null}
              </div>
              <div role="button" tabindex="0" className="unplaceable-place"
                title={'Add ' + u.font + ' \u00b7 ' + u.weight + ' to the font list for ' + u.lang + ' (the same thing Add font does) and connect it into this pairing. Afterwards, More \u2192 Remove font deletes the member from the pairing.'}
                onClick={() => ctx.materializeParked(u)}
                style={{
                  flex: 'none', padding: '2px 10px', borderRadius: '4px', cursor: 'pointer',
                  border: '1px solid #3d6b86', color: '#cfe6f2', fontSize: '11px', whiteSpace: 'nowrap'
                }}>Place on a node</div>
            </div>
          ))}
        </div>
      ) : null}


      {/* TODO#58 — review strip for every group the machine made without asking,
          scan batch and panel batch alike, derived from data.equivalence_groups.
          Empty list → component returns null. */}
      {showAdv && (
        <div className="adv-panel">
          <label className="adv-row">
            <input type="checkbox" checked={hoverPops}
              onChange={(e) => setHoverPops(e.target.checked)} />
            <span className="adv-label">Hover explanations</span>
            <span className="adv-note">the panel's own dark popups on chips and buttons</span>
          </label>
          <label className="adv-row">
            <input type="checkbox" checked={devLabels}
              onChange={(e) => setDevLabels(e.target.checked)} />
            <span className="adv-label">Component name labels</span>
            <span className="adv-note">development aid — names each control on hover, using the OS tooltip</span>
          </label>
        </div>
      )}
      {showRecomb && (
        <window.RecombinationReviewStrip
          merged={autoMerged}
        />
      )}

      {/* 8D-ext-MM step 4: the representative is now chosen inline on the
          weight rows of a multi-member pair (auto first-connected + click a
          star to move it) — the old hint/accept banner was debug-only and is
          removed (user UX 2026-06-14). */}

      {/* 8D-ext-B (2026-06-09) — UnresolvedLangSection
          Renders per-lang grouped sub-rows showing which pairs are missing
          a member for a lang detected in the doc. Zero overhead when
          unresolvedByLang is empty (component returns null). */}
      <window.UnresolvedLangSection ctx={ctx} />

      <div className="canvas" ref={canvasRef}>
        <div className="canvas-inner" ref={innerRef}>
          {/* NOTE: this onClick is a DEAD fallback — UXP webview ignores
              pointer-events:stroke, so the path is never the pointer target and
              this never fires. The real wire-click handling is the capture-phase
              geometric hit-test in the pan useEffect. Kept as a harmless no-op
              that would auto-activate if a future UXP honors pointer-events. */}
          <svg className="wires wires-hit" style={{ pointerEvents: 'none' }}>
            {!isPanning && wires.map(w => (
              <path key={w.id} d={w.d} className="wire-hit"
                onClick={e => {
                  e.stopPropagation();
                  openMenu({
                    getBoundingClientRect: () => ({
                      left: e.clientX, top: e.clientY, bottom: e.clientY,
                      right: e.clientX, width: 0, height: 0,
                    }),
                  }, [
                    { head: 'Pairing' },
                    { label: 'Remove pairing', danger: true, onClick: () => removePairing(w.pid) },
                  ]);
                }}
                style={{ pointerEvents: 'stroke' }} />
            ))}
          </svg>

          {data.languages.map((l, i) => {
            // TODO#82 — culling is SUSPENDED while a wire is being dragged.
            // 🔴 Not a convenience: it is what stops the auto-pan from destroying its
            // own target. Edge auto-scroll changes the pan state -> onChange narrows
            // `visibleRange` -> the column being scrolled TOWARDS turns into an empty
            // spacer, and its ports stop being registered. The operator would watch
            // the canvas move to the place they aimed at and find nothing there.
            // ⚠ MEASURED (probes/20260823_14, 5-language fixture): at rest culling is
            // NOT engaged — `visibleRange` is still the initial wide range, all columns
            // render, and off-screen ports ARE in the DOM with real rects. It engages
            // only after a pan. So this suspension changes nothing until something pans,
            // which is exactly when it is needed.
            var cullSuspended = !!(drag && drag.type === 'wire');
            if (vcOn && !cullSuspended && (i < visibleRange.start || i >= visibleRange.end)) {
              return <div key={l.id} style={{ width: 300, flexShrink: 0 }} />;
            }
            if (isPanning) {
              const snapHeight = columnHeightsRef.current[i];
              return (
                <div key={l.id} className="column" style={snapHeight ? { minHeight: snapHeight } : undefined}>
                  <div className="col-head">
                    <div className="specimen" style={{ fontFamily: l.family }}>{l.script || '·'}</div>
                    <div className="col-titles">
                      <div className="col-name">{l.name}</div>
                      <div className="col-code mono">{l.code}</div>
                    </div>
                  </div>
                  <div className="col-body">
                    {l.fonts.map(f => {
                      // 8D-ext-A.1: fold-aware so placeholder heights match the
                      // real (folded) card and don't jump on pan start/end.
                      const foldedSet = window.egFoldedWeightSet(data.equivalence_groups, l.code, mmFoldSkipByLang[l.code]);
                      const { nodes, folded } = window.deriveVisibleNodes(f, foldedSet);
                      if (folded) return null;
                      // #51: the .nodes wrapper is NOT cosmetic here. The real
                      // column nests nodes inside .font-card > .nodes, so node
                      // spacing comes from `.nodes > * + *` (9px) while CARD
                      // spacing comes from `.col-body > * + *` (16px). Flattened
                      // straight into .col-body, every placeholder node would eat
                      // the 16px card gap => skeleton taller than the real column
                      // => the jump this block's own comment promises not to have.
                      // (It was already wrong before #51 — 11px vs 18px — just
                      // small enough not to be noticed.)
                      return (
                        <div className="nodes" key={f.id}>
                          {nodes.map(n => (
                            <div
                              key={f.id + '-' + n.id}
                              className={`node ${n.kind === 'group' ? 'is-group' : ''}`}
                              style={{ minHeight: n.kind === 'group' ? 50 : 26 }}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return <window.LanguageColumn key={l.id} ctx={ctx} lang={l} />;
          })}

          {/* unified-weight naming lane (far left, aligned to each pairing) */}
          <div className="label-lane">
            <span className="lane-title" title="Unified weight names">Weight names</span>
          </div>
          {!isPanning && labelCards.map(lc => (
            <window.LabelCard key={lc.p.id} ctx={ctx} pairing={lc.p} top={lc.y} />
          ))}

          {/* Add language column placeholder — last child of canvas-inner so
              it sits to the right of all language columns. */}
          <div role="button" tabindex="0" className="add-column" onClick={() => addLang()}
            title="Add language column">
            <window.Icon name="plus" size={22} />
            <span>Add language</span>
          </div>

          <svg className="wires wires-over" style={{ pointerEvents: 'none' }}>
            {!isPanning && wires.map(w => (
              // #45: wire dim rides the re-render (inline style attribute
              // update), NOT a :hover restyle — CLAUDE.md #13 does not apply.
              // data-from/data-to: a machine hook, no styling, no behaviour
              // (#34). It is what lets a probe say WHICH ports this wire owes
              // its endpoints to, without re-deriving anything.
              <path key={w.id} d={w.d} className="wire"
                data-from={w.from} data-to={w.to}
                style={{ stroke: w.hue, opacity: hlDimPid(w.pid) ? 0.22 : 1 }} />
            ))}
            {live && <path d={live} className="wire wire-live"
              style={{ stroke: drag.from ? (nodeHue(drag.from) || 'var(--accent)') : 'var(--accent)' }} />}
          </svg>
        </div>
      </div>

      <footer className="statusbar">
        <span>{data.languages.length} languages · {data.languages.reduce((n, l) => n + l.fonts.length, 0)} fonts · {data.pairings.length} pairings</span>
        <span className="hint">Drag a port to pair across languages · drag a node's grip to merge or reorder</span>
      </footer>

      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ---------- menu (with search-input combobox) -----------------------------
function Menu({ menu, onClose }) {
  const ref = useRef(null);
  const searchRef = useRef(null);
  const searchItem = menu.items.find((it) => it.search);
  const [query, setQuery] = useState(searchItem && searchItem.initial ? searchItem.initial : '');
  const [pos, setPos] = useState({ left: menu.rect.left, top: menu.rect.bottom + 6, opacity: 0 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let left = menu.rect.left, top = menu.rect.bottom + 6;
    if (left + r.width > window.innerWidth - 10) left = window.innerWidth - r.width - 10;
    if (top + r.height > window.innerHeight - 10) top = menu.rect.top - r.height - 6;
    setPos({ left: Math.max(10, left), top: Math.max(10, top), opacity: 1 });
  }, [menu]);
  useEffect(() => {
    setQuery(searchItem && searchItem.initial ? searchItem.initial : '');
  }, [menu]);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('pointerdown', h), 0);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('pointerdown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const hasExact = menu.items.some((it) => it.label && it.label.toLowerCase() === q);
  return (
    <div className="menu" ref={ref} style={pos}>
      {menu.items.map((it, i) => {
        if (it.head) return <div className="menu-head" key={i}>{it.head}</div>;
        if (it.sep) return <div className="menu-sep" key={i} />;
        if (it.search) return (
          <div className="menu-search" key={i}>
            <window.Icon name="search" size={13} stroke={1.7} />
            <input
              ref={searchRef}
              className="menu-search-input"
              placeholder={it.placeholder || 'Search…'}
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && it.submit) {
                  const v = query.trim();
                  if (v) { it.submit(v); onClose(); }
                }
              }}
            />
            {query &&
              <div role="button" tabindex="0" className="menu-search-clear" title="Clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setQuery(''); searchRef.current && searchRef.current.focus(); }}>
                <window.Icon name="x" size={12} stroke={1.9} />
              </div>}
          </div>
        );
        if (q && it.label && !it.custom && !it.label.toLowerCase().includes(q)) return null;
        return (
          <div role="button" tabindex="0" key={i} className={`menu-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}`}
            onClick={() => { it.onClick && it.onClick(); onClose(); }}>
            <span className="mi-check">{it.checked ? '✓' : ''}</span>
            <span className={it.custom ? 'mi-custom' : ''}>{it.label}</span>
          </div>
        );
      })}
      {searchItem && searchItem.submit && q && !hasExact &&
        <div role="button" tabindex="0" className="menu-item"
          onClick={() => { searchItem.submit(query.trim()); onClose(); }}>
          <span className="mi-check" />
          <span className="mi-custom">Use "{query.trim()}"</span>
        </div>}
    </div>
  );
}

/* 🔴 2026-09-09 —— owner 报「拖动时整个面板变黑、光标在整个窗口内是抓手抓住的状态」，
   两轮之后仍无变化。前两次我各猜了一个抛出点（applyReorder 的 .filter(Boolean)、
   italicInfo 的裸解引用），都按预注册被证伪 —— 但被证伪的是那两个【猜测】，
   不是【机制】：机制那半有判别性证据 —— owner 明确说「除了系统窗口本身，里面全黑」，
   即那张圆角卡片本身没了。这只有「React 树整个卸载、#root 变空、露出 body 那层近黑
   渐变（panel.css:28-35）」解释得通；任何 CSS 改色的理论都会把卡片边框留在原地。
   而 body.grabbing 是在 React handler 里加的（:859,864）、也只在 React handler 里删
   （:848）⇒ 树一死就没人删了，抓手因此卡住 —— 两个症状同一个根。

   所以这次不再猜第三个抛出点。装一个 error boundary，把【任何】抛出变成一条读数：
     · 屏幕上给出错误本身，而不是一片黑 —— owner 一眼就能把它念给我；
     · 同时写进 fapTrace 环形缓冲 ⇒ 面板关掉后仍会被 12b_panel_trace 转存进 JSON 日志。
   ⚠ 它【不修】那个抛出，它让抛出报出自己的名字。这是仪器 + 降级，不是修复。 */
class PanelErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null, stack: null }; }
  static getDerivedStateFromError(err) {
    return { err: String((err && err.message) || err) };
  }
  componentDidCatch(err, info) {
    const stack = (info && info.componentStack) ? String(info.componentStack) : '';
    // 先落 trace（面板关掉后还读得到），再落控制台。两条都包 try —— 一个报错的
    // 报错处理器会把唯一的线索也吃掉。
    try {
      window.fapTrace && window.fapTrace('BOUNDARY:caught', {
        message: String((err && err.message) || err),
        stack: stack.split('\n').slice(0, 12).join(' | ')
      });
    } catch (e2) {}
    try { console.error('[fap] boundary caught', err, stack); } catch (e3) {}
    // 树死了就没人清 body.grabbing 了（:848 在 React handler 里）。这里补一刀，
    // 否则光标会一直卡在抓手上、看起来像「整个窗口都被拖住了」。
    try { document.body.classList.remove('grabbing'); } catch (e4) {}
    this.setState({ stack: stack });
  }
  render() {
    if (!this.state.err) return this.props.children;
    // ⚠ 用显式四边、不用 inset:0 —— UXP webview 的 CSS 支持面是逐条踩出来的
    // （panel.css 里 flex gap 就是死的）。若 inset 不被支持，这个盒子会是 0 尺寸
    // ⇒ 又是一片黑 ⇒ 我会把「仪器没显示」误读成「机制被证伪」。
    // 这是本次唯一一个能把【我自己的仪器故障】伪装成【结论】的地方，所以不省这一行。
    const box = { position:'fixed', top:'0', right:'0', bottom:'0', left:'0',
                  display:'flex', alignItems:'center',
                  justifyContent:'center', padding:'24px', zIndex:9999 };
    const card = { maxWidth:'760px', width:'100%', background:'#1b1113',
                   border:'1px solid #e5484d', borderRadius:'12px', padding:'20px 22px',
                   color:'#f3d6d8', font:'13px/1.55 ui-sans-serif, system-ui, sans-serif' };
    return (
      <div style={box}>
        <div style={card}>
          <div style={{fontSize:'15px', fontWeight:600, marginBottom:'8px', color:'#ff9ea2'}}>
            面板出错了（不是黑屏 —— 这就是那个错误本身）
          </div>
          <div style={{marginBottom:'10px'}}>
            这条信息已同时写进日志的 <code>12b_panel_trace</code>，关掉面板也不会丢。
            把下面这行念给我就够了：
          </div>
          <div style={{background:'#120c0d', border:'1px solid #3a2224', borderRadius:'8px',
                       padding:'10px 12px', font:'12px/1.5 ui-monospace, Consolas, monospace',
                       whiteSpace:'pre-wrap', wordBreak:'break-word'}}>
            {this.state.err}
            {this.state.stack ? '\n\n' + this.state.stack.split('\n').slice(0, 8).join('\n') : ''}
          </div>
        </div>
      </div>
    );
  }
}

/* 同一根的另一半：body.grabbing 的清理不该只归 React handler 所有。
   指针一抬（或被系统取消）就无条件清掉 —— 这条在【捕获阶段】挂在 window 上，
   任何组件的 handler 抛出都影响不到它。 */
try {
  const _clearGrab = function () {
    try { document.body.classList.remove('grabbing'); } catch (e) {}
    // 幽灵是 React 之外的 DOM ⇒ 树一旦被卸载就没人删它，会永远挂在屏幕上。
    // 这条兜底与清 grabbing 同理，挂在捕获阶段，不依赖组件还活着。
    try {
      const gs = document.querySelectorAll('.drag-ghost, .drag-hint');
      for (let i = 0; i < gs.length; i++) gs[i].remove();
    } catch (e) {}
  };
  window.addEventListener('pointerup', _clearGrab, true);
  window.addEventListener('pointercancel', _clearGrab, true);
} catch (eG) {}

ReactDOM.createRoot(document.getElementById('root')).render(
  <PanelErrorBoundary><App /></PanelErrorBoundary>
);
