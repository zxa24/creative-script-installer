// font_apply_panel — data model + sample. Exported to window for app.jsx.
//
// Ported from docs/字体映射面板/v2/data.jsx with these toolkit adaptations:
//   - PAIR_HUES kept as single-color array (matches v2 unified-color decision)
//   - `used` field drives the "In doc" chip — populated at startup by the
//     idjs entry script after it scans the active document
//   - Sample data kept as fallback when no doc / scan fails
//
// Adapt nothing else — the data shape is the runtime contract between
// the panel UI and the apply layer.

let _idn = 1;
const uid = (p = 'id') => `${p}_${(_idn++).toString(36)}${Date.now().toString(36).slice(-3)}`;

// ---- BCP 47 language presets -----------------------------------------------
// Tags follow RFC 5646. Picker uses `code` as the canonical id and resolves
// the display label via `Intl.DisplayNames` at render time (verified work
// in UXP webview 2026-06-07; falls back to `name` if absent). `script` is
// the specimen glyph shown in language column header; `family` is the
// suggested font for that script when scan emits no dominant family.
// User can free-input any BCP 47 tag via picker search (validated by
// `isValidBcp47` below) for niche locales not in this list.
const LANG_PRESETS = [
  // CJKV
  // `script` is a specimen GLYPH rendered to preview a CJK face, not readable
  // text. Do NOT translate - a Latin letter previews nothing about the font.
  { code: 'zh-CN',  name: 'Simplified Chinese',           script: '永',  family: "'Noto Sans SC'" },
  { code: 'zh-TW',  name: 'Traditional Chinese (Taiwan)', script: '繁',  family: "'Noto Sans TC'" },
  { code: 'zh-HK',  name: 'Traditional Chinese (HK)',     script: '港',  family: "'Noto Sans HK'" },
  { code: 'ja',     name: 'Japanese',                     script: 'あ',  family: "'Noto Sans JP'" },
  { code: 'ko',     name: 'Korean',                       script: '한',  family: "'Noto Sans KR'" },
  { code: 'vi',     name: 'Vietnamese',                   script: 'Ăổ',  family: "'Hanken Grotesk'" },
  // Latin (Europe + global)
  { code: 'en',     name: 'English',                      script: 'Ag',  family: "'Hanken Grotesk'" },
  { code: 'fr',     name: 'French',                       script: 'Aé',  family: "'Hanken Grotesk'" },
  { code: 'de',     name: 'German',                       script: 'Aö',  family: "'Hanken Grotesk'" },
  { code: 'es',     name: 'Spanish',                      script: 'Añ',  family: "'Hanken Grotesk'" },
  { code: 'pt-BR',  name: 'Portuguese (Brazil)',          script: 'Aç',  family: "'Hanken Grotesk'" },
  { code: 'pt-PT',  name: 'Portuguese (Portugal)',        script: 'Aç',  family: "'Hanken Grotesk'" },
  { code: 'it',     name: 'Italian',                      script: 'Ai',  family: "'Hanken Grotesk'" },
  { code: 'nl',     name: 'Dutch',                        script: 'Aö',  family: "'Hanken Grotesk'" },
  { code: 'pl',     name: 'Polish',                       script: 'Aś',  family: "'Hanken Grotesk'" },
  { code: 'tr',     name: 'Turkish',                      script: 'Aı',  family: "'Hanken Grotesk'" },
  { code: 'sv',     name: 'Swedish',                      script: 'Aä',  family: "'Hanken Grotesk'" },
  { code: 'da',     name: 'Danish',                       script: 'Aæ',  family: "'Hanken Grotesk'" },
  { code: 'no',     name: 'Norwegian',                    script: 'Aø',  family: "'Hanken Grotesk'" },
  { code: 'fi',     name: 'Finnish',                      script: 'Aö',  family: "'Hanken Grotesk'" },
  { code: 'id',     name: 'Indonesian',                   script: 'Ag',  family: "'Hanken Grotesk'" },
  { code: 'ms',     name: 'Malay',                        script: 'Ag',  family: "'Hanken Grotesk'" },
  { code: 'sw',     name: 'Swahili',                      script: 'Ag',  family: "'Hanken Grotesk'" },
  // Cyrillic
  { code: 'ru',     name: 'Russian',                      script: 'Бг',  family: "'Noto Sans'" },
  { code: 'uk',     name: 'Ukrainian',                    script: 'Бі',  family: "'Noto Sans'" },
  { code: 'bg',     name: 'Bulgarian',                    script: 'Бд',  family: "'Noto Sans'" },
  { code: 'sr',     name: 'Serbian (Cyrillic)',           script: 'Ћ',   family: "'Noto Sans'" },
  // Middle Eastern / RTL
  { code: 'ar',     name: 'Arabic',                       script: 'ع',   family: "'Noto Sans Arabic'" },
  { code: 'he',     name: 'Hebrew',                       script: 'א',   family: "'Noto Sans Hebrew'" },
  { code: 'fa',     name: 'Persian',                      script: 'ف',   family: "'Noto Sans Arabic'" },
  { code: 'ur',     name: 'Urdu',                         script: 'ا',   family: "'Noto Nastaliq Urdu'" },
  // South Asian
  { code: 'hi',     name: 'Hindi',                        script: 'अ',   family: "'Noto Sans Devanagari'" },
  { code: 'bn',     name: 'Bengali',                      script: 'অ',   family: "'Noto Sans Bengali'" },
  { code: 'ta',     name: 'Tamil',                        script: 'அ',   family: "'Noto Sans Tamil'" },
  { code: 'te',     name: 'Telugu',                       script: 'అ',   family: "'Noto Sans Telugu'" },
  { code: 'ml',     name: 'Malayalam',                    script: 'അ',   family: "'Noto Sans Malayalam'" },
  { code: 'kn',     name: 'Kannada',                      script: 'ಅ',   family: "'Noto Sans Kannada'" },
  { code: 'gu',     name: 'Gujarati',                     script: 'અ',   family: "'Noto Sans Gujarati'" },
  { code: 'pa',     name: 'Punjabi',                      script: 'ਅ',   family: "'Noto Sans Gurmukhi'" },
  // Southeast Asian
  { code: 'th',     name: 'Thai',                         script: 'ก',   family: "'Noto Sans Thai'" },
  { code: 'my',     name: 'Burmese',                      script: 'က',   family: "'Noto Sans Myanmar'" },
  { code: 'km',     name: 'Khmer',                        script: 'ក',   family: "'Noto Sans Khmer'" },
  { code: 'lo',     name: 'Lao',                          script: 'ກ',   family: "'Noto Sans Lao'" },
  // African
  { code: 'am',     name: 'Amharic',                      script: 'አ',   family: "'Noto Sans Ethiopic'" },
];

// Resolve a BCP 47 tag to a localized display name via Intl.DisplayNames.
// Falls back to provided fallback / the tag itself. Lets the picker show
// friendly names even for free-input tags (e.g. "bo-CN" → "bo (China)").
function getLangDisplayName(code, fallback) {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
      var dn = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' });
      var n = dn.of(code);
      if (n && n !== code) return n;
    }
  } catch (e) {}
  return fallback || code;
}

// Lenient BCP 47 validation — 2-3 letter primary, optional subtags.
// Doesn't enforce full RFC 5646 grammar; good enough for picker free-input
// (rejects empty / obvious typos like spaces).
function isValidBcp47(tag) {
  if (!tag || typeof tag !== "string") return false;
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(tag.trim());
}

const SEMANTIC_WEIGHTS = ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'ExtraBold', 'Black'];

const PAIR_COLOR = '#5b9cf0';
const PAIR_HUES = [PAIR_COLOR];

// ---- sample data (fallback when no doc / scan fails) -----------------------
function buildSample() {
  return {
    name: 'Brand',
    languages: [
      {
        id: 'L_en', code: 'en', name: 'English', script: 'Ag', family: "'Hanken Grotesk'",
        fonts: [
          {
            id: 'F_en_disp', name: 'Aktiv Grotesk', role: 'Display',
            weights: [
              { id: 'w_en_d_r', semantic: 'Regular', actual: 'Regular', used: 0 },
              { id: 'w_en_d_m', semantic: 'Medium',  actual: 'Medium',  used: 0 },
              { id: 'w_en_d_b', semantic: 'Bold',    actual: 'Bold',    used: 0 },
            ],
            merges: [],
          },
        ],
      },
      {
        id: 'L_sc', code: 'zh-CN', name: 'Simplified Chinese', script: '永', family: "'Noto Sans SC'",
        fonts: [
          {
            id: 'F_sc_h', name: 'Source Han Sans SC', role: 'Display',
            weights: [
              { id: 'w_sc_r', semantic: 'Regular', actual: 'Regular', used: 0 },
              { id: 'w_sc_m', semantic: 'Medium',  actual: 'Medium',  used: 0 },
              { id: 'w_sc_b', semantic: 'Bold',    actual: 'Heavy',   used: 0 },
            ],
            merges: [],
          },
        ],
      },
    ],
    pairings: [],
  };
}

// ---- node derivation -------------------------------------------------------
// A font renders an ordered list of "nodes". A node is either a lone weight or
// a merge group. node.id is the weightId (lone) or mergeId (group).
function deriveNodes(font) {
  const inGroup = {};
  (font.merges || []).forEach(m => m.members.forEach(w => { inGroup[w] = m.id; }));
  const out = [];
  const seenGroup = {};
  font.weights.forEach(w => {
    const gid = inGroup[w.id];
    if (gid) {
      if (seenGroup[gid]) return;
      seenGroup[gid] = true;
      const m = font.merges.find(x => x.id === gid);
      const members = m.members
        .map(id => font.weights.find(w2 => w2.id === id))
        .filter(Boolean);
      out.push({ kind: 'group', id: gid, merge: m, members });
    } else {
      out.push({ kind: 'weight', id: w.id, weight: w });
    }
  });
  return out;
}

// 8D-ext-A.1 (2026-06-11) — equivalence-group fold helpers.
// egFoldedWeightSet collects the (font ␟ weight) keys that an eg's merged_in
// members occupy for one lang, so the font tree can HIDE those weight nodes,
// leaving only the canonical's single weight/port visible. INVARIANT:
// presentation-only fold, NEVER a data delete — panelDataToConfig still emits
// both weights (the merged_in doc fonts the apply side maps onto).
// 8D-ext-MM step 5 (B side 2): `mmSkipSet` (optional) = { "font␟weight": true }
// of (font,weight) that are MM multi-members for this lang. A weight MM owns is
// NEVER folded — explicit MM intent outranks the auto A.1 twin-fold, and folding
// an MM member would re-create the validateBrandConfig II-d (A/MM overlap) the
// auto-unmerge effect resolves. Keeps the node visible/connectable.
function egFoldedWeightSet(equivalenceGroups, langCode, mmSkipSet) {
  const set = {};
  (equivalenceGroups || []).forEach(eg => {
    if (!eg || eg.lang !== langCode) return;
    (eg.merged_in || []).forEach(mi => {
      if (!mi) return;
      // A.1 fold is CROSS-family only: fold a merged_in weight iff it belongs to
      // a different font than the canonical. This (a) leaves A4 same-family alias
      // merges' weights visible — they must not silently vanish from the tree —
      // and (b) guarantees the canonical card (font === eg.canonical.font) can
      // never enter the fold set, so the whole font can't disappear.
      if (eg.canonical && mi.font === eg.canonical.font) return;
      const k = mi.font + '␟' + mi.weight;  // ␟ U+241F separator
      if (mmSkipSet && mmSkipSet[k]) return; // MM owns this weight — don't fold
      set[k] = true;
    });
  });
  return set;
}

// deriveVisibleNodes filters deriveNodes(font) by foldedSet (P3-4 weight-node
// granularity): a 'weight' node is dropped iff its actual weight is in the set
// for this font; 'group' nodes always pass (merged_in are simple weights, never
// groups). Match on actual ONLY — merged_in.weight is the doc font's raw style
// token (= node weight.actual); the dropped `|| ...semantic` fallback could hide
// a sibling NON-merged weight whose semantic snaps to the same token.
// `folded` is true when EVERY node was folded away — the whole card disappears
// into the canonical. Presentation-only.
function deriveVisibleNodes(font, foldedSet) {
  const all = deriveNodes(font);
  if (!foldedSet) return { nodes: all, folded: false };
  const nodes = all.filter(n => {
    if (n.kind !== 'weight') return true;
    return !foldedSet[font.name + '␟' + n.weight.actual];
  });
  const folded = (nodes.length === 0 && all.length > 0);
  return { nodes, folded };
}

// #28e — THE face-level "this config face is not installed here" predicate.
// Both user-visible surfaces — WeightNode's red outline (+ chip) and
// handleDone's count/list — call THIS function on the SAME missingKeys, so
// they cannot disagree (two independent computations of "not installed" have
// drifted apart in this panel before; see font_mapping_panel_adapter.js W3
// notes). missingKeys is the adapter's precompute (panelData._missingFaceKeys):
// "font␟weight" keys of config-authored faces the byPair Stage-1 gate would
// skip, probed HOST-side at open/import (the webview has no app.fonts).
// null/absent = could-not-enumerate or no probe → always [] (show NOTHING —
// "green because it read nothing" is this repo's oldest disease, so unknown
// must render as silence, not as health).
// Returns the node's missing member weight tokens ([] when none): a 'weight'
// node speaks for itself, a merge-group answers for each member.
function nodeMissingFaces(missingKeys, fontName, node) {
  if (!Array.isArray(missingKeys) || missingKeys.length === 0 || !fontName || !node) return [];
  const set = {};
  missingKeys.forEach(k => { set[k] = true; });
  const weights = node.kind === 'weight'
    ? [node.weight && node.weight.actual]
    : (node.members || []).map(m => m && m.actual);
  return weights.filter(w => w && set[fontName + '␟' + w] === true);
}

// #28e-port (W1's leftover half, arch-approved 2026-08-13) — THE logical wire
// set, derived from pairings alone (NO portPos, NO render state). This single
// function feeds BOTH consumers so they cannot drift:
//   1. the wire renderer (app.jsx) maps each logical wire through portPos —
//      an endpoint culled out of the viewport just skips the geometry;
//   2. per-side port lighting: a port is lit iff it is the endpoint of some
//      LOGICAL wire (owner's principle "只有实际有连接的端口才变蓝" at SIDE
//      granularity — node-level lighting was the bug: a paired node's L port
//      glowed with no wire on that side).
// Keying lighting to the LOGICAL set (not the rendered wires) is deliberate:
// viewport culling drops rendered wires while panning, and lighting keyed to
// render output would flicker (this panel has a pan-perf history).
// 8D-ext-MM step 4 semantics preserved verbatim: a wire per CROSS-lang member
// pair, same-lang members never wire to each other; ms is lang-sorted so for
// i<j the cross pair has ms[i] on the LEFT column (R port) and ms[j] on the
// RIGHT column (L port). Label wires are ALWAYS derived (§14-b, 2026-09-11 —
// the old `labelLinked` gate is gone; see the tombstone below). (the label port's
// own hue logic already matches this and stays untouched).
/* 🔴 标签卡的 y —— **唯一来源**（2026-09-11，🅐′）。
   渲染期（app.jsx 的 labelCards）与测量期（recomputePorts 里给标签端口定位）
   **必须用同一个函数**：抄成两份就是第二个真相来源（`#27`），而这两份一旦漂，
   症状恰好又是"线和端口对不上" —— 与我们正在修的那个 bug 同形、极难区分。

   纯函数：只依赖 (data, portPos)。y 取【领头语言（最左存在列）成员的 L 口】的 y；
   拿不到就退回老的等距兜底 `70 + i*70`（保持既有行为，⛔ 不趁机改它）。
   ⚠ 卡片 CSS 是 `position:absolute; transform:translateY(-50%)` ⇒ **这个 y 是卡片的中心**，
   不是上边缘（panel.css:782-783；实测 20260911_03：卡高 38、端口卡内偏移 19 = 正中）。 */
function labelCardLayout(data, portPos) {
    var langOrder = {};
    (data.languages || []).forEach(function (l, i) { langOrder[l.id] = i; });
    return (data.pairings || []).map(function (p, i) {
        var ms = (p.members || []).slice().sort(function (a, b) {
            return (langOrder[a.lang] || 0) - (langOrder[b.lang] || 0);
        });
        var lead = ms[0];
        var lp = lead && portPos[lead.lang + ':' + lead.font + ':' + lead.node + ':L'];
        return { p: p, lead: lead || null, y: lp ? lp.y : (70 + i * 70) };
    });
}

function deriveLogicalWires(pairings, langOrder) {
  const wires = [];
  (pairings || []).forEach(p => {
    const ms = [...(p.members || [])].sort((a, b) => (langOrder[a.lang] || 0) - (langOrder[b.lang] || 0));
    // #48 (owner 2A, design-intent §14): label wires go to EVERY member of the
    // lead (leftmost-present) language — the column ADJACENT to the label
    // card, so §14's "only connect adjacent" holds; cross-lang members never
    // label-wire (that would be the rejected 2C). All fan out of the ONE
    // label port anchor (single portPos coordinate source; same single-anchor
    // multi-wire look the MM node ports already have).
    //
    // 🪦 2026-09-11 — 这里原本还有一道 `p.labelLinked &&` 闸，注释写着：
    //   「a pairing with no leftmost-column member has labelLinked=false from
    //    construction (app.jsx includesLeftmost) ⇒ no label wires —
    //    **unchanged behavior, do not "fix"**」
    // 🔴 **那句从此不成立，留碑不静默删** —— 它正是会让下一个人把本次改动改回去的那句。
    // 它当时描述的是一个真实行为，但那个行为本身就是 owner 2026-09-11 报的缺陷：
    // `labelLinked` 只有**会话内新建且含最左列成员**的配对才为 true，而**导入的**配对
    // 从 config 读（文件里没这个字段就是 false）⇒ **导入一份正常 config 后，
    // 标签端口是空圈、一条线都没有**。
    // ⇒ design-intent §14-b（owner 原话「这个不应用户拖，改成默认自动连且不能改」）：
    //   **标签线恒为派生** —— 只要配对有成员就连到领头语言的每一个成员。
    //   按 §14 自己的判据（「他会不会自己动手去连 —— 会，那机器就该已经连好」），
    //   这道闸本就不该在；§14 当时只收掉了「从标签往外拖」那一半。
    // ⚠ `labelLinked` 字段**不删**：渲染一律忽略，往返按原样保留（adapter 仍读仍写），
    //   ⛔ 不动既有 config 的字节形状。（arch 的保守默认，见 §14-b）
    if (ms[0]) {
      const leadLang = ms[0].lang;
      let li = 0;
      ms.forEach(m => {
        if (m.lang !== leadLang) return;
        wires.push({
          // pid is what downstream keys on (#45 hlDimPid, hue, context menu);
          // the per-member suffix only keeps React keys/ids unique.
          id: `${p.id}_lbl${li}`, pid: p.id, hue: p.hue,
          from: `__label__:${p.id}::R`,
          to: `${m.lang}:${m.font}:${m.node}:L`,
        });
        li++;
      });
    }
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        if (ms[i].lang === ms[j].lang) continue;   // same-lang members never wire to each other
        wires.push({
          id: `${p.id}_${i}_${j}`, pid: p.id, hue: p.hue,
          from: `${ms[i].lang}:${ms[i].font}:${ms[i].node}:R`,
          to: `${ms[j].lang}:${ms[j].font}:${ms[j].node}:L`,
        });
      }
    }
  });
  return wires;
}

// #41 (design-intent §6, 2026-08-13 修订) — auto-faux additions for translator-
// marked italics. PURE: decides WHAT to add; the app.jsx effect applies it.
//   pairLibs      [[{lang(code), font, weight}]] — resolvedPairLibs (lib form)
//   demandFaces   {"font␟weight": true} — SOURCE faces with a translator italic
//                 mark (lib/annot_italic_demand, threaded via __fap)
//   cjkLangs      { code: true } — the seeded CJK-target SoT
//   italicByWinner  data.italic_by_winner — existing entries (absent-only add)
//   resolveWinnerKey(member) → {key, font, weight}|null — injected (IVK +
//                 live config in app.jsx; a stub in Node tests)
// Trigger is "需要不是存在": a pairing must contain BOTH a demanded source face
// AND a CJK member; only that pairing's CJK members get faux. Dedup by winner
// key (MM identities collapse onto the rep's key via resolveWinner — AC⑤).
function computeAutoFauxAdditions(pairLibs, demandFaces, cjkLangs, italicByWinner, resolveWinnerKey) {
  const adds = [];
  if (!demandFaces) return adds;
  const seen = {};
  (pairLibs || []).forEach(members => {
    const hasDemand = (members || []).some(m =>
      m && !cjkLangs[m.lang] && demandFaces[m.font + '␟' + m.weight] === true);
    if (!hasDemand) return;
    (members || []).forEach(m => {
      if (!m || !cjkLangs[m.lang]) return;
      const w = resolveWinnerKey(m);
      if (!w || !w.key) return;
      if ((italicByWinner || {})[w.key]) return;   // already configured (incl. loaded from file)
      if (seen[w.key]) return;
      seen[w.key] = true;
      adds.push({ key: w.key, font: w.font, weight: w.weight });
    });
  });
  return adds;
}

// #45 — hover a weight ⇒ its RELATION SET stays, the rest dims. This is the
// ONE place that set is computed (renderer only applies classes; it must
// never re-derive "who relates to whom" — same SoT rule as deriveLogicalWires,
// and TODO#44's merge-shape change should need to swap ONLY this function).
// Set = the hovered member's pairing: ALL its members (cross-lang AND
// same-lang MM — the multi-to-one case is the whole pairing by construction)
// + that pairing's wires and label card (both keyed by pid downstream).
// Unpaired member ⇒ {self} — a PRODUCT ruling, not a missed case: "this
// weight has no relations" is itself the information the feature exists to
// show (owner 2026-08-13, arch-confirmed; no special-casing).
function computeHoverRelationSet(hoverAddr, pairings) {
  if (!hoverAddr) return null;
  const key = (m) => `${m.lang}:${m.font}:${m.node}`;
  const nodes = {};
  const pids = {};
  // #54ⓑ (owner 2026-08-15 「应该」): a LABEL CARD is a hover trigger too.
  // Label hover arrives as the label pseudo-addr ({lang:'__label__',
  // font:<pairing id>}) — the SAME address grammar ports/wires already use —
  // and resolves to the SAME set hovering any member yields: the pairing's
  // members + its pid (card and wires light via pid downstream). One
  // function, one hoverHl — no second derivation (the #45 rule).
  const p = (hoverAddr.lang === '__label__')
    ? (pairings || []).find(pp => pp.id === hoverAddr.font)
    : (pairings || []).find(pp => (pp.members || []).some(m =>
        m.lang === hoverAddr.lang && m.font === hoverAddr.font && m.node === hoverAddr.node));
  if (p) {
    (p.members || []).forEach(m => { nodes[key(m)] = true; });
    pids[p.id] = true;
  } else if (hoverAddr.lang !== '__label__') {
    nodes[key(hoverAddr)] = true;
  }
  return { nodes, pids };
}

// snap an arbitrary weight name to the closest preset (used to seed a unified label)
function closestPreset(sem) {
  const P = SEMANTIC_WEIGHTS;
  if (!sem) return 'Regular';
  if (P.includes(sem)) return sem;
  const low = sem.toLowerCase();
  const exact = P.find(p => p.toLowerCase() === low);
  if (exact) return exact;
  const part = P.find(p => low.includes(p.toLowerCase()) || p.toLowerCase().includes(low));
  return part || sem;
}

// univ-italic §7.4 ② — which weight token a node declares italic HOW for.
// A 'weight' node speaks for itself. A 'group' node (font.merges — the panel's
// own merge, NOT an equivalence_groups fold) REPLACES its member weight nodes in
// deriveNodes, so without this its members would have no route to declare HOW and
// would be permanently unconfigured at apply time. The group acts as one weight,
// and the representative is the member the config/apply side treats as that
// weight — so the rep's token is what the italic key must be built from.
// Falls back to the first member when the stored rep id is stale (same guarded
// fallback as _resolvePanelMember / resolveMemberToLib).
function italicBaseWeightOf(node) {
  if (!node) return null;
  if (node.kind === 'weight') return node.weight ? node.weight.actual : null;
  const members = node.members || [];
  if (!members.length) return null;
  const repId = node.merge && node.merge.rep;
  const rep = members.find(m => m.id === repId) || members[0];
  return rep ? (rep.actual || rep.semantic) : null;
}

function nodeLabel(node) {
  if (node.kind === 'weight') return node.weight.semantic;
  return node.members.map(m => m.semantic).join(' · ');
}

// ---- #43: what a fresh Import must reset --------------------------------
//
// Import is `setData(r.data)` — a WHOLE-CONFIG replacement. Every session-only
// map keyed by POSITION (`pairIdx|lang`) or by CONTENT (`normalized_key`,
// `family|alias_class`) therefore changes meaning underneath the operator: the
// key survives, the thing it named does not. The 2026-08-22 sweep found FIVE of
// these on top of the two already handled (#33d chip / #41 gate).
//
// 🔴 2026-09-10: THREE of those seven named state that TODO#58 had already deleted
// two days earlier, so `handleImport` was calling three undeclared setters and
// aborting mid-funnel. They are gone; the tombstone at the bottom of the return
// says, per name, what each was resetting and why removing it drops nothing.
// ⚠ Live set is now FOUR: skipDecisions / autoRepKeys / autoFauxKeys /
// keepPrimaryLang. If you add a key here you MUST add the setter in handleImport —
// and `tests/import_state_reset_tests.js` now checks BOTH halves: that the setter
// is called, AND that it EXISTS. The second half is the one that was missing.
//
// 🔴 PURE, so the rule can be tested — the panel itself cannot run under Node.
// `handleImport` only APPLIES what this returns, so adding a new session map
// means adding it HERE, not adding another line to handleImport (that function
// already carried three separate patches by the time of this sweep).
//
// ⚠ Deliberately NOT handled here: `unresolvedByLang` / `recombCandidates` /
// tofu+miss warnings. Those DO have an effect that recomputes them from the
// config; their bug is that the effect early-returns (keeping the previous
// value) while the config is momentarily invalid. Clearing them here would
// HIDE that early-return rather than fix it — and it also misfires outside
// Import. See TODO #32(e).
function computeImportStateReset(next, fap) {
    fap = fap || {};
    var langs = (next && Array.isArray(next.languages)) ? next.languages : [];
    // `primaryLang` names a language CODE. Keep it only if the new config still
    // has that language; else fall back to the launcher's suggestion, then "".
    // Keeping a code the config does not contain leaves the picker naming a
    // language that is not there.
    function keepPrimaryLang(prevPrimary) {
        for (var i = 0; i < langs.length; i++) {
            if (langs[i] && langs[i].code && langs[i].code === prevPrimary) return prevPrimary;
        }
        return fap.primaryLang || "";
    }
    return {
        // positional key `pairIdx|lang` — pairIdx is re-assigned every import
        skipDecisions: {},
        // already reset before this sweep — folded in so ONE place answers
        // "what does Import reset".
        autoRepKeys: {},
        autoFauxKeys: {},
        keepPrimaryLang: keepPrimaryLang
        /* ── 🪦 2026-09-10: three keys REMOVED, and why each one is not a
           silent drop ──────────────────────────────────────────────────────
           The 2026-08-22 sweep was written against the state list as it stood
           BEFORE TODO#58 landed (2026-08-20). #58 deleted the three useState
           hooks below; the sweep two days later still emitted keys for them and
           `handleImport` still called `setAutoMerged` / `setRecombDismissed` /
           `setConfirmableMerges` — three identifiers declared NOWHERE.
           🔴 Measured, not read (probes/20260910_01_import_reset_chromium.mjs):
           the first of them throws `ReferenceError: setAutoMerged is not defined`
           INSIDE an async handler ⇒ an unhandled rejection, no banner, no visible
           failure — and everything after it never ran. `setData` and
           `setSkipDecisions` had already gone out, so an import half-applied:
           config B was loaded while `primaryLang` stayed on config A's language.
           That is the exact leak class this funnel exists to close.

           · `autoMerged` — WAS: a useState list of merges made THIS session,
             written only by `confirmRecombination`, content-keyed by
             `normalized_key`. NOW: a useMemo over `data.equivalence_groups`
             (app.jsx TODO#58(c)). `setData(r.data)` already re-derives it, so
             there is nothing left to reset — a mirror cannot go stale if there
             is no mirror.
           · `recombDismissed` — WAS: which recombination candidates the operator
             dismissed; its bug was ABSENCE-type (a stale dismissal silently hid
             a candidate the new config legitimately raised). NOW: retired with
             its producer `detectRecombinationCandidates` (#58), and the successor
             identity path has NO dismissal state at all (`identityDismissed` also
             removed, owner 姿态甲 2026-08-20). ⚠ The absence-type risk is gone
             because the FEATURE is gone, not because it is handled: if the
             "earn-it" un-merge/dismiss affordance in app.jsx's tombstone is ever
             built, its session map belongs back HERE on day one.
           · `confirmableMerges` — WAS: a doc-scan product seeded once at mount
             whose only setters were filters, so after an import it was the
             PREVIOUS document's scan already whittled by the previous config's
             gestures; the fix was to re-seed rather than empty. NOW: the whole
             collision-banner line was retired (1f10eda, #58①②) — no state, no
             consumer in the panel. ⚠ `lib/font_panel_env.js:165` still fills
             `fap.confirmableMerges` from the scan; that producer now feeds
             nobody (noted, out of scope here).

           ⚠ NOT added in their place: `identityBuild` / `identityApply`, the #58
           successors. They are recomputed by an effect on `[data]` and carry the
           SAME early-return-on-invalid-config shape as `unresolvedByLang`
           (app.jsx, the `if (!cv.ok) return;` effect) ⇒ they belong to the
           deliberate NON-entry class below, not to this funnel. #58 replaced two
           session mirrors with derived state, so this funnel SHRANK; it did not
           grow. */
    };
}
Object.assign(window, {
    computeImportStateReset, // #43 — the ONE place that says what Import resets
  uid, LANG_PRESETS, SEMANTIC_WEIGHTS, PAIR_HUES, PAIR_COLOR,
  buildSample, deriveNodes, egFoldedWeightSet, deriveVisibleNodes, nodeLabel, closestPreset,
  nodeMissingFaces,   // #28e — shared face-level not-installed predicate
  deriveLogicalWires,  // #28e-port — one wire-set SoT for renderer + per-side port lighting
  labelCardLayout,     // 🅐′ 2026-09-11 — 标签卡 y 的唯一来源（渲染期与测量期共用）
  computeHoverRelationSet, // #45 — hover relation set (single derivation, #44 swaps only this)
  computeAutoFauxAdditions, // #41 — translator-italic auto-faux (pure decision, effect applies)
  italicBaseWeightOf,
  getLangDisplayName, isValidBcp47,
});
