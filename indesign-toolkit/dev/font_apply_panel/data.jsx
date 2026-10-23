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
/* 🔴 #138 item 2 (2026-10-03) — 两张卡不许叠在一起。
   修前：领头成员的端口量不到时，y 退回 `70 + i*70` —— 一个**按下标**算的位置，与真实的行
   毫无关系 ⇒ 它会正好落在另一张卡所在的那一行上，把那张卡整张盖住（arch 的 UXP 眼验：
   Import 后「Regular」压在「Bold Italic」下面；删掉一张卡后下标前移，被盖住的换成「Light」
   —— 位置跟着下标走，正是这条兜底的指纹）。被盖住的卡点不到也拖不到。
   修法（仍是 (data, portPos) 的纯函数，返回顺序不变 = pairings 的顺序）：
     ① 锚点 = 领头语言里**第一个量得到 L 口**的成员（原来只看 ms[0]）。
     ② 没有锚点的卡不再按下标摆，排到所有有锚点的卡**下面**，逐张相隔一个卡距。
        一张有锚点的都没有时，保留原来的 `70 + k*70`（那时没有可撞的行）。
     ③ 最后统一过一遍：按 y 升序，后一张至少比前一张低一个卡距 —— 两张卡锚到同一行
        （或相邻很近的两行）时也不叠。被推开的那张 `nudged: true`。
   ⚠ LABEL_CARD_PITCH = 卡高 38（实测 20260911_03）+ 6。列里相邻两行的行距实测 47 > 44
     ⇒ 正常一行一卡时第 ③ 步一张都不动。⛔ 卡高改了这个数要跟着改（tests/label_card_layout_tests.js 钉着）。 */
var LABEL_CARD_PITCH = 44;
/* TODO #142 ① (2026-10-06): the document fonts AS THE PANEL NOW KNOWS THEM.
   The adapter folds a document face into its config family when the name-identity rule
   proves they are one font (panelData.fontNameAliases.aliases). Everything in the panel
   that still reads the host's raw documentFonts (the #58 identity-group universe, the
   review strip's usage column) must see the same fold — otherwise #58 rebuilds the
   document spelling as an equivalence-group member and re-creates the second card the
   fold just removed (host 2026-10-06: "Dax Pro (OTF)" came back with four weights and no
   usage). Pure: (documentFonts, fontNameAliases) → documentFonts with aliased faces
   renamed to the config family. No aliases ⇒ the input, untouched. */
function applyNameAliasesToDocFonts(documentFonts, fontNameAliases) {
    var list = Array.isArray(documentFonts) ? documentFonts : [];
    var al = fontNameAliases && Array.isArray(fontNameAliases.aliases) ? fontNameAliases.aliases : [];
    if (!al.length) return list;
    var map = {};
    al.forEach(function (a) { if (a && a.docFamily && a.style && a.configFamily) map[a.docFamily + '|' + a.style] = a.configFamily; });
    return list.map(function (df) {
        if (!df) return df;
        var to = map[df.font + '|' + df.weight];
        if (!to) return df;
        var o = {}; for (var k in df) if (Object.prototype.hasOwnProperty.call(df, k)) o[k] = df[k];
        o.font = to; o.documentName = df.font;
        return o;
    });
}


/* #144 (owner 2026-10-10): the bold-on-another-font evidence, made presentable.
   ① foldReportFamily: the import report spells a font the way the DOCUMENT does ("Dax Pro (OTF)"). The panel has
      already proven that spelling is the config's font (panelData.fontNameAliases), so the report's names go through the
      same table: the paragraph font no longer shows a second name for the same font.
   ② ffFaces / ffNodeStatus / ffNeededFaces: the faces the CHOSEN answer lands on, and for each one where it lives on the
      canvas: an existing node (also the grey installed-only ones: no placeholder is added next to a real node, arch
      2026-10-10), a placeholder in the family's own card, or the waiting area when the card does not exist. All derived
      from data + report, nothing stored: nothing here can reach the export. */
function foldReportFamily(name, style, fontNameAliases) {
    var al = fontNameAliases && Array.isArray(fontNameAliases.aliases) ? fontNameAliases.aliases : [];
    var hit = null;
    al.forEach(function (a) { if (!hit && a && a.docFamily === name && a.configFamily && (a.style === style || !style)) hit = a.configFamily; });
    if (!hit) al.forEach(function (a) { if (!hit && a && a.docFamily === name && a.configFamily) hit = a.configFamily; });
    return hit || name;
}
function ffFoldItems(items, fontNameAliases) {
    return (items || []).filter(function (x) { return x && x.dimension !== 'italic'; }).map(function (x) {
        var o = {}; for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) o[k] = x[k];
        o.docFamily = x.family;   // the document's spelling: the usage index is keyed by it
        o.family = foldReportFamily(x.family, x.style, fontNameAliases);
        o.body_family = x.body_family ? foldReportFamily(x.body_family, null, fontNameAliases) : x.body_family;
        ['own', 'body'].forEach(function (w) {
            if (x[w] && x[w].family) o[w] = { family: foldReportFamily(x[w].family, x[w].style, fontNameAliases), style: x[w].style, installed: x[w].installed };
        });
        return o;
    });
}
/* #144 (owner 2026-10-11): the ff notice is ONE notice with ONE choice (config key emphasis_foreign_family is a single
   value for every family), but its text is per FAMILY. ffFamilyGroups: [{ family, docFamily, style, items, own, body }]
   in order of first appearance. ffGroupIsNew: the family's own bold has no node on the canvas yet (unknown faces, e.g.
   an older report, count as not new). ffGroupSentence / ffNoticeTitle: the owner's wording, no dashes. */
function ffFamilyGroups(items) {
    var order = [], by = {};
    (items || []).forEach(function (it) {
        if (!it || !it.family) return;
        var g = by[it.family];
        if (!g) { g = by[it.family] = { family: it.family, docFamily: it.docFamily || it.family, style: it.style || 'Regular', items: [], own: null, body: null }; order.push(g); }
        g.items.push(it);
        if (!g.own && it.own && it.own.family) g.own = it.own;
        if (!g.body && it.body && it.body.family) g.body = it.body;
    });
    return order;
}
function ffGroupIsNew(data, g, homeLangOf) {
    return !!(g && g.own && ffNodeStatus(data, g.own, homeLangOf).kind !== 'node');
}
function ffGroupSentence(g, isNew) {
    var use;
    if (g && g.own && g.body) {
        var own = g.own.family + ' ' + g.own.style, body = g.body.family + ' ' + g.body.style;
        // import side (style_applier.js: a face that is not installed lands nothing and says so): an own bold that is not
        // installed is never suggested, the sentence says so and offers the paragraph font or installing it
        use = g.own.installed === false
            ? (own + " is not installed. Use the paragraph's " + body + ", or install it.")
            : ('Use ' + own + ", or the paragraph's " + body + '.');
    } else use = "Use its own font, or the paragraph's font.";
    return isNew ? ('Bold was added to text in ' + g.family + ', which has no bold here yet. ' + use) : use;
}
function ffNoticeTitle(groups, anyNew, demand) {
    if (!groups || !groups.length) return 'Bold on words in another font' + (demand ? ' (' + demand + ')' : '');
    var n = groups.map(function (g) { return g.family; }), names;
    if (n.length === 1) names = n[0];
    else if (n.length === 2) names = n[0] + ' and ' + n[1];
    else if (n.length === 3) names = n[0] + ', ' + n[1] + ' and ' + n[2];
    else names = n[0] + ', ' + n[1] + ' and ' + (n.length - 2) + ' more';
    return (anyNew ? 'Set up a bold for ' : 'Choose a bold for text in ') + names;
}

// distinct faces an answer lands on: [{ family, style, installed }]
function ffFaces(items, which) {
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
        var f = it && it[which];
        if (!f || !f.family) return;
        var k = f.family + '|' + f.style;
        if (seen[k]) return; seen[k] = 1; out.push({ family: f.family, style: f.style, installed: !!f.installed });
    });
    return out;
}
// where this face is on the canvas: { kind: 'node', langId, fontId, nodeId } | { kind: 'ghost', langId, fontId } | { kind: 'waiting', langId }
function ffNodeStatus(data, face, homeLangOf) {
    var langs = (data && data.languages) || [], cardHit = null, want = String(face.style || '').toLowerCase();
    for (var i = 0; i < langs.length; i++) {
        var fonts = langs[i].fonts || [];
        for (var j = 0; j < fonts.length; j++) {
            if (fonts[j].name !== face.family) continue;
            var ws = fonts[j].weights || [];
            for (var k = 0; k < ws.length; k++) {
                var wn = String(ws[k].actual || ws[k].semantic || '').toLowerCase();
                if (wn === want && !ws[k].copy_of) return { kind: 'node', langId: langs[i].id, fontId: fonts[j].id, nodeId: ws[k].id };
            }
            if (!cardHit) cardHit = { kind: 'ghost', langId: langs[i].id, fontId: fonts[j].id };
        }
    }
    if (cardHit) return cardHit;
    var home = homeLangOf ? homeLangOf(face.family) : null, lang = null;
    for (var m = 0; m < langs.length; m++) if (langs[m].code === home || langs[m].id === home) { lang = langs[m]; break; }
    if (!lang) lang = langs[0] || null;
    return { kind: 'waiting', langId: lang ? lang.id : null };
}
// #144 (arch 2026-10-11): the same three-way rule for a pair member the config names in ONE language column
// (a "parked" member). Real node => marker; the family's card in THAT column => placeholder in it; else the waiting area of
// that column. (By definition a parked face has no node there, so 'node' only appears if the operator added it meanwhile.)
function ffNodeStatusInLang(data, langCode, family, style) {
    var langs = (data && data.languages) || [], lang = null, want = String(style || '').toLowerCase();
    for (var i = 0; i < langs.length; i++) if (langs[i].code === langCode || langs[i].id === langCode) { lang = langs[i]; break; }
    if (!lang) return { kind: 'waiting', langId: langs[0] ? langs[0].id : null };
    var fonts = lang.fonts || [];
    for (var j = 0; j < fonts.length; j++) {
        if (fonts[j].name !== family) continue;
        var ws = fonts[j].weights || [];
        for (var k = 0; k < ws.length; k++) {
            if (String(ws[k].actual || ws[k].semantic || '').toLowerCase() === want && !ws[k].copy_of) return { kind: 'node', langId: lang.id, fontId: fonts[j].id, nodeId: ws[k].id };
        }
        return { kind: 'ghost', langId: lang.id, fontId: fonts[j].id };
    }
    return { kind: 'waiting', langId: lang.id };
}
// the faces of the CHOSEN answer with their canvas status: [{ family, style, installed, status }]
function ffNeededFaces(data, items, choice, homeLangOf) {
    if (choice !== 'own' && choice !== 'body') return [];
    return ffFaces(items, choice).map(function (f) { return { family: f.family, style: f.style, installed: f.installed, status: ffNodeStatus(data, f, homeLangOf) }; });
}
// does EITHER answer land on a face that has no node anywhere on the canvas? (decides which sentence the notice opens with)
function ffHasNewFace(data, items, homeLangOf) {
    return ffFaces(items, 'own').concat(ffFaces(items, 'body')).some(function (f) { return ffNodeStatus(data, f, homeLangOf).kind !== 'node'; });
}

/* TODO #142 ⑤ (owner 2026-10-06): the notification area's MODEL — which notices exist, which group
   they go in, and what "decide by recommendation" would do. Pure, so the Done gate and the panel
   read the same answer. Groups (design note design_142_wires_notifications.md):
     decide — the designer has to choose (or a failure that needs them); top of the area
     check  — the machine did something worth a look; nothing to choose
   input: { actionError, ff: { has, value, demand }, orphanLines, unplaceable, italicOrphans,
            migration, rejectedAliases, ack: { key: true } }
   A decide notice that was acknowledged ("Keep as is") moves to check as kept.
   Recommendations (arch + owner 2026-10-06; A1 = own, A2–A4 = keep, A5 none). */
var NOTICE_RECOMMEND = {
    ff: { value: 'own', label: 'Use its own font',
          why: 'Keeps the font the designer chose for those words. The paragraph’s font is not forced onto them.' },
    orphanLines: { value: 'keep', label: 'Keep as is',
          why: 'Written back to the config unchanged. A line that matches no card has no effect here, and deleting it cannot be undone.' },
    unplaceable: { value: 'keep', label: 'Keep as is',
          why: 'Written back into their pairing as they are. Where to place them is not something the panel can guess.' },
    italicOrphans: { value: 'keep', label: 'Keep as is',
          why: 'Still written out with Done. Settings are never deleted on your behalf.' }
};
function noticeState(input) {
    var i = input || {};
    var ack = i.ack || {};
    var decide = [], check = [];
    if (i.actionError) decide.push({ key: 'actionError', needsYou: true });
    var ff = i.ff || {};
    var ffSet = ff.value === 'body' || ff.value === 'own';
    if (!ffSet && (ff.has || (Number(ff.demand) || 0) > 0)) decide.push({ key: 'ff', recommended: NOTICE_RECOMMEND.ff });
    else if (ffSet) check.push({ key: 'ff' });
    [['orphanLines', i.orphanLines], ['unplaceable', i.unplaceable], ['italicOrphans', i.italicOrphans]].forEach(function (p) {
        if (!p[1] || !p[1].length) return;
        if (ack[p[0]]) check.push({ key: p[0], kept: true });
        else decide.push({ key: p[0], recommended: NOTICE_RECOMMEND[p[0]] });
    });
    if (i.migration && i.migration.ran) check.push({ key: 'migration' });
    if (i.rejectedAliases && i.rejectedAliases.length) check.push({ key: 'rejectedAliases' });
    if (Number(i.autoMerged) > 0) check.push({ key: 'autoMerged' });
    var undecided = decide.filter(function (d) { return !d.needsYou; }).length;
    return { decide: decide, check: check, undecided: undecided };
}
/* what "decide by recommendation" does, as data: { foreignFamily: 'own'|undefined, ack: [keys], needsYou: [keys] } */
function recommendedDecisions(state) {
    var out = { foreignFamily: undefined, ack: [], needsYou: [] };
    (state && state.decide || []).forEach(function (d) {
        if (d.needsYou) { out.needsYou.push(d.key); return; }
        if (d.key === 'ff') out.foreignFamily = d.recommended.value;
        else out.ack.push(d.key);
    });
    return out;
}

function labelCardLayout(data, portPos) {
    var langOrder = {};
    (data.languages || []).forEach(function (l, i) { langOrder[l.id] = i; });
    var out = (data.pairings || []).map(function (p, i) {
        var ms = (p.members || []).slice().sort(function (a, b) {
            return (langOrder[a.lang] || 0) - (langOrder[b.lang] || 0);
        });
        var lead = ms[0];
        var lp = null;
        for (var k = 0; lead && k < ms.length && !lp; k++) {
            if (ms[k].lang !== lead.lang) break;
            lp = portPos[ms[k].lang + ':' + ms[k].font + ':' + ms[k].node + ':L'] || null;
        }
        return { p: p, lead: lead || null, y: lp ? lp.y : null, anchored: !!lp, nudged: false, _i: i };
    });
    var maxAnchored = null;
    out.forEach(function (c) { if (c.anchored && (maxAnchored === null || c.y > maxAnchored)) maxAnchored = c.y; });
    var k2 = 0;
    out.forEach(function (c) {
        if (c.anchored) return;
        c.y = maxAnchored === null ? (70 + k2 * 70) : (maxAnchored + (k2 + 1) * LABEL_CARD_PITCH);
        k2++;
    });
    var order = out.slice().sort(function (a, b) { return (a.y - b.y) || (a._i - b._i); });
    for (var j = 1; j < order.length; j++) {
        var min = order[j - 1].y + LABEL_CARD_PITCH;
        if (order[j].y < min) { order[j].y = min; order[j].nudged = true; }
    }
    out.forEach(function (c) { delete c._i; });
    return out;
}

function deriveLogicalWires(pairings, langOrder, ghosts) {
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
    /* TODO #142 ② (owner 2026-10-06, 画法 A): a pairing is drawn as a CHAIN through ADJACENT
       columns only — design-intent §14「节点只连接相邻的」applied to the member wires. Before
       this, every cross-language pair of members got a wire (N·(N−1)/2 per pairing, 15 at six
       languages, 62 on the eye fixture), and the wires to non-adjacent columns ran across
       the columns in between — the tangle owner reported (#66). Now: members are grouped by
       column; wires go from every member of one present column (R) to every member of the
       NEXT present column (L); a column with no member is bridged (`bridged: true`, drawn
       dashed). Same-language members never wire to each other (unchanged).
       ⚠ The lit-port rule rides on this list unchanged: a member in a middle column is lit on
       both sides, an end member on one — exactly what the chain draws. */
    // #144 (owner 2026-10-11): a parked pair member shown as a placeholder takes part in the CHAIN (so its line is drawn to
    // it), never in the label wires above (the label card is anchored on real members only). It is flagged `ghost`.
    const gm = (ghosts || []).filter(g => g && g.pairingId === p.id).map(g => ({ lang: g.lang, font: g.font, node: g.node, ghost: true }));
    const byCol = {};
    ms.concat(gm).forEach(m => { const c = langOrder[m.lang] || 0; (byCol[c] = byCol[c] || []).push(m); });
    const cols = Object.keys(byCol).map(Number).sort((a, b) => a - b);
    for (let c = 0; c + 1 < cols.length; c++) {
      const A = byCol[cols[c]], B = byCol[cols[c + 1]];
      const bridged = cols[c + 1] - cols[c] > 1;
      A.forEach((a, i) => B.forEach((b, j) => {
        wires.push({
          id: `${p.id}_${cols[c]}_${i}_${cols[c + 1]}_${j}`, pid: p.id, hue: p.hue,
          from: `${a.lang}:${a.font}:${a.node}:R`,
          to: `${b.lang}:${b.font}:${b.node}:L`,
          bridged,
          ghost: !!(a.ghost || b.ghost),
        });
      }));
    }
  });
  return wires;
}

/* TODO #142 ②-3: the one operation "remove THIS wire" has under the chain drawing — split the
   pairing at the gap the wire crosses. Members in the wire's left column and every column to
   its left stay in the pairing (its card, name and emphasis lines stay with them); members in
   the wire's right column and beyond go to a NEW pairing — or, when that is a single member,
   simply leave (a pairing needs two members; the member becomes unpaired).
   Pure: (pairing, langOrder, fromPortId) → { left: members[], right: members[] }. The port id
   is the wire's `from` ("lang:font:node:R"); the column boundary is that member's column. */
function splitPairingAtWire(pairing, langOrder, fromPortId) {
  const lang = String(fromPortId || '').split(':')[0];
  const cut = langOrder[lang];
  const left = [], right = [];
  (pairing && pairing.members || []).forEach(m => { ((langOrder[m.lang] || 0) <= (cut || 0) ? left : right).push(m); });
  return { left, right };
}

// 🪦 #41 auto-faux decision (translator italic ⇒ machine-added faux@12 on the CJK
// weight) — retired by #ac-emphasis-relations §7.6 I-5 (conflict table 13 = c, owner 已定 21).

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
// ⚠ Live set is now THREE: skipDecisions / autoRepKeys / keepPrimaryLang
// (the #41 auto-faux session map retired, #ac-emphasis-relations I-5). If you add a key here you MUST add the setter in handleImport —
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
  deriveLogicalWires,
  splitPairingAtWire,   // #142 ②-3 — "remove this wire" = split the pairing at that gap  // #28e-port — one wire-set SoT for renderer + per-side port lighting
  labelCardLayout,     // 🅐′ 2026-09-11 — 标签卡 y 的唯一来源（渲染期与测量期共用）
  noticeState, recommendedDecisions, NOTICE_RECOMMEND,   // #142 ⑤ — notification area model
  applyNameAliasesToDocFonts,   // #142 ① — document fonts after the identity fold
  foldReportFamily, ffFoldItems, ffFaces, ffNodeStatus, ffNeededFaces, ffHasNewFace, ffNodeStatusInLang,
  ffFamilyGroups, ffGroupIsNew, ffGroupSentence, ffNoticeTitle,   // #144 2026-10-11: per-family wording   // #144 — ff evidence, folded names, needed faces
  LABEL_CARD_PITCH,    // #138 item 2 — 两张卡之间的最小中心距
  computeHoverRelationSet, // #45 — hover relation set (single derivation, #44 swaps only this)
  italicBaseWeightOf,
  getLangDisplayName, isValidBcp47,
});
