"use strict";

/**
 * lib/font_mapping_doc_scan.js — Phase 8D-ext-0 doc scanner (lib layer)
 *
 * Scans the active InDesign document for font usage and produces both:
 *   1) panel-friendly data for the UI (per-family home_lang + per-style used count)
 *   2) lib-config-friendly outputs (documentFonts list, unresolvedByLang per-pair
 *      diff against a given brand config, mismatchedTSRs for B-side UI)
 *
 * Migrated from dev/font_apply_panel/lib_font_doc_scan.js (561 LOC across two
 * MVP files) per task_plan Phase 8D-ext-0 (commit 1ab792d r8). Preserves the
 * 11 MVP-empirical details listed in that plan section.
 *
 * Public API (Node-test + UXP both):
 *   scanActiveDoc(opts) → {
 *     ok, elapsedMs, totalTsrs, skippedTsrs, totalChars,
 *     documentFonts: [{ font, weight, used }],         // for detectUnmatchedItems
 *     byFamilyHomeLang: { family: langCode },           // home_lang argmax
 *     tsrMap: [{ storyIdx, idxStart, idxEnd, dominantLang, sourceFont, sourceWeight }],
 *     unresolvedByLang: { lang → [{ pairingId, sourceFont, sourceWeight, tsrCount, sampleParaIds }] },
 *     confirmable_merges: [{ lang, family, styles: [a, b], reason }],  // alias-collision probe
 *     equivalence_groups_auto: [{ lang, canonical:{font,weight}, merged_in:[{font,weight}] }],
 *     identity_readout: { notInstalled, noPostscriptName, lookupFailed,
 *                         blockedByOperator, overlaps, details },   // TODO#58 (5)
 *     panelData: { name, languages: [...], pairings: [] }  // panel UI shape
 *   }
 *
 * Helpers exported for testing + apply_to_doc reuse:
 *   classifyCodepoint, tallyContents, pickHomeLang,
 *   readTsrFontFamilyStyle,   // MVP detail #1: Font.name tab-split is sole reliable accessor
 *   styleAlias,               // ~15-item style alias table (collision PROBE only)
 *   buildUnresolvedByLang     // 8D-ext-0 P1a fix: per-pair grouped (not global set diff)
 *
 * Preserved MVP-empirical details (per task_plan 8D-ext-0 "11 MVP 实证细节"):
 *   #1  Font.name tab-split (not .fontStyleName which throws on some TSR Font refs)
 *   #2  isolated-module `app` resolution (require("indesign").app try/catch)
 *   #3  installed-style augmentation (caller-provided installedFamilies map)
 *   #4  neutral-char neutral (punct/digits/whitespace don't bias tally)
 *   #5  tie-break order CJK first ['zh-CN','ja','ko','th','zh-TW','en']
 *   #10 empty / all-neutral skip in dominant-lang classification
 *   #11 (Skip & Continue belongs to apply_to_doc / resolve; not here)
 */

var FMP;
try { FMP = require("./font_mapping_pairs.js"); } catch (e) { FMP = null; }

// 🪦 8D-ext-A `font_recombination` is NO LONGER REQUIRED HERE (TODO#58, 2026-08-20).
// It was the A.1 name-heuristic producer (normalize() + STYLE_ALIAS_TABLE); the
// merge criterion is now face identity, so this module must not be able to reach
// it at all — `recombination_candidates` and the `detectRecombinationCandidates`
// re-export are both gone. The module itself survives for diagnostics/tests only.
//
// TODO#58 (1): the deterministic identity grouper. Pure leaf (no `app`), the host
// lookup is injected below, so this stays Node-testable.
var FIG;
try { FIG = require("./font_identity_groups.js"); } catch (eFIG) { FIG = null; }

// MVP detail #2: isolated-module app resolution.
// In Scripts Panel double-click runs, `require()` creates an isolated module
// scope so the entry script's `var app = ...` is invisible. `require("indesign")`
// is the only reliable way. In Node tests, this throws — we tolerate it
// because pure functions don't need `app`.
var app;
try { app = require("indesign").app; } catch (eReq) {}

// ---------------------------------------------------------------------------
// makeIdentityLookup (TODO#58) — the HOST half of the identity criterion
// ---------------------------------------------------------------------------
// `(family, style)` STRINGS in, the font engine's own answer out. Returns null
// for "could not ask"; the caller fails closed on that.
//
// 🔴 Resolved via `app.fonts.itemByName(family + TAB + style)` — deliberately
// NOT from a TSR's appliedFont object. MVP detail #1 (this module's own header)
// records that reading `fontStyleName` off some TSR Font refs THROWS, which is
// why readTsrFontFamilyStyle only ever touches `.name`. itemByName is the
// accessor that was actually measured (panelfix 2026-08-20: 3 real pairs + 2
// fictional, zero throws).
//
// 🔴 `status` is read FIRST and every property gets its OWN try/catch: a
// NOT_AVAILABLE face returns postscriptName "" WITHOUT throwing while location /
// fullName / fontStyleName all throw.
//
// 🔴 NEVER enumerate `app.fonts` here (CLAUDE.md #21: a full enumeration kills
// the bridge). Single-point itemByName only, memoized — the panel asks once per
// visible node per render and the answer is constant for a given install state.
//
// It lives in THIS module rather than font_panel_env.js so that both consumers —
// the scan (below) and the panel (`fap.fontIdentity`) — get literally the same
// function. font_panel_env exists precisely because two hosts drifting apart on a
// shared field has bitten this panel twice already.
function makeIdentityLookup(appRef) {
    var A = appRef || app;
    var memo = {};
    return function (family, style) {
        var k = String(family) + "\t" + String(style);
        if (Object.prototype.hasOwnProperty.call(memo, k)) return memo[k];
        var out = null;
        try {
            var f = A.fonts.itemByName(k);
            if (f) {
                out = { status: null, postscriptName: "", selfFamily: null, selfStyle: null };
                try { out.status = String(f.status); } catch (e1) {}
                try { out.postscriptName = f.postscriptName ? String(f.postscriptName) : ""; } catch (e2) {}
                try { out.selfFamily = String(f.fontFamily); } catch (e3) {}
                try { out.selfStyle = String(f.fontStyleName); } catch (e4) {}
            }
        } catch (eLookup) {
            out = null;
        }
        memo[k] = out;
        return out;
    };
}

// ---------------------------------------------------------------------------
// Language presets (for panelData rendering — UI only)
// ---------------------------------------------------------------------------
var LANG_PRESETS_BY_CODE = {
    'en':    { name: 'English',              script: 'Ag', family: "'Hanken Grotesk'" },
    // The `script` values below are specimen GLYPHS, not text: they are rendered
    // in a CJK face to preview it. '永' is the conventional Han specimen. Do NOT
    // translate them - a Latin letter previews nothing about a CJK font.
    'zh-CN': { name: 'Simplified Chinese',   script: '永', family: "'Noto Sans SC'" },
    'zh-TW': { name: 'Traditional Chinese',  script: '繁', family: "'Noto Sans TC'" },
    'ja':    { name: 'Japanese',             script: 'あ', family: "'Noto Sans JP'" },
    'ko':    { name: 'Korean',               script: '한', family: "'Noto Sans KR'" },
    'th':    { name: 'Thai',                 script: 'ก', family: "'Hanken Grotesk'" }
};

// MVP detail #4: codepoint → lang bucket, neutral = ""
function classifyCodepoint(cp) {
    if (cp >= 0x3040 && cp <= 0x30FF) return 'ja';
    if (cp >= 0x31F0 && cp <= 0x31FF) return 'ja';
    if (cp >= 0xAC00 && cp <= 0xD7AF) return 'ko';
    if (cp >= 0x1100 && cp <= 0x11FF) return 'ko';
    if (cp >= 0x0E00 && cp <= 0x0E7F) return 'th';
    if (cp >= 0x4E00 && cp <= 0x9FFF) return 'zh-CN';
    if (cp >= 0x3400 && cp <= 0x4DBF) return 'zh-CN';
    if ((cp >= 0x0041 && cp <= 0x005A) || (cp >= 0x0061 && cp <= 0x007A)) return 'en';
    if (cp >= 0x00C0 && cp <= 0x024F) return 'en';
    return '';
}

function tallyContents(text) {
    var t = { 'en': 0, 'zh-CN': 0, 'zh-TW': 0, 'ja': 0, 'ko': 0, 'th': 0 };
    if (!text) return t;
    for (var i = 0; i < text.length; i++) {
        var b = classifyCodepoint(text.charCodeAt(i));
        if (b) t[b]++;
    }
    return t;
}

// MVP detail #5: tie-break CJK first
var DOM_LANG_ORDER = ['zh-CN', 'ja', 'ko', 'th', 'zh-TW', 'en'];

// MVP detail #10: empty-or-neutral → null (skippedNoLang)
function pickDominantLang(text) {
    if (!text || !text.replace(/\s+/g, '')) return null;
    var t = tallyContents(text);
    var best = null, bestCount = -1;
    for (var i = 0; i < DOM_LANG_ORDER.length; i++) {
        var lang = DOM_LANG_ORDER[i];
        if (t[lang] > bestCount) { best = lang; bestCount = t[lang]; }
    }
    return bestCount > 0 ? best : null;
}

function pickHomeLang(familyMap) {
    var totals = { 'en': 0, 'zh-CN': 0, 'zh-TW': 0, 'ja': 0, 'ko': 0, 'th': 0 };
    for (var style in familyMap) {
        if (!Object.prototype.hasOwnProperty.call(familyMap, style)) continue;
        var lc = familyMap[style].langCounts;
        for (var k in lc) {
            if (Object.prototype.hasOwnProperty.call(lc, k)) totals[k] += lc[k];
        }
    }
    // 8D-ext-FL: `>0` guard mirrors pickDominantLang(:109). Init bestCount=0 (not
    // -1) so an all-neutral family (every langCount 0) keeps the `best='en'` init
    // instead of falling through to DOM_LANG_ORDER[0]==='zh-CN'. Real (>0) ties
    // still break CJK-first (strict `>` + zh-CN leads DOM_LANG_ORDER).
    var best = 'en';
    var bestCount = 0;
    for (var i = 0; i < DOM_LANG_ORDER.length; i++) {
        var lang = DOM_LANG_ORDER[i];
        if (totals[lang] > bestCount) { best = lang; bestCount = totals[lang]; }
    }
    return best;
}

// ---------------------------------------------------------------------------
// 8D-ext-FL: font home-lang by INTRINSIC identity (writingScript → name), not
// by usage.病根 = usage circularity (judging a font's identity from the chars
// it was mis-applied to). Pure leaves — Node-testable, no `app`.
// ---------------------------------------------------------------------------

// InDesign Font.writingScript (Number, read-only) → home lang. Probe-verified
// 2026-06-12: 0=Latin/en · 1=ja · 3=ko · 25=zh (Chinese). Unknown code → tier-3.
var WS_LANG = { 0: 'en', 1: 'ja', 3: 'ko', 25: 'zh-CN' };

// Curated, FULL-NAME-anchored CJK family-name allowlist. NEVER bare-substring
// "SC"/"Gothic"/"Han"/"Song"/"Ming"/"Kai" — `Cormorant SC` (Latin small-caps),
// `Century Gothic` (Latin) MUST stay non-CJK. Each romanized pattern anchors the
// complete family token(s). v1: all Chinese → zh-CN (no 繁简 split). Order:
// JP/KR-specific Noto/Source-Han variants BEFORE the generic Chinese fallback.
var CJK_NAME_ALLOWLIST = [
    // ── Noto CJK (suffix only matched WITH the Noto Sans/Serif base) ──
    { re: /\bNoto\s+(?:Sans|Serif)(?:\s+CJK)?\s+JP\b/i, lang: 'ja' },
    { re: /\bNoto\s+(?:Sans|Serif)(?:\s+CJK)?\s+KR\b/i, lang: 'ko' },
    { re: /\bNoto\s+(?:Sans|Serif)(?:\s+CJK)?\s+(?:SC|TC|HK)\b/i, lang: 'zh-CN' },
    { re: /\bNoto\s+(?:Sans|Serif)\s+CJK\b/i, lang: 'zh-CN' },
    // ── Source Han (suffix only matched WITH the Source Han base) ──
    { re: /\bSource\s+Han\s+(?:Sans|Serif)\s+(?:JP|J)\b/i, lang: 'ja' },
    { re: /\bSource\s+Han\s+(?:Sans|Serif)\s+(?:KR|K)\b/i, lang: 'ko' },
    // Broadened: any `Source Han <face>` (e.g. "Source Han Code") with no JP/KR
    // suffix defaults zh-CN (Adobe's pan-CJK family is Chinese-first). Still
    // anchored to the full "Source Han" base — no bare token.
    { re: /\bSource\s+Han\b/i, lang: 'zh-CN' },
    // ── Chinese (zh-CN) ──
    { re: /\b(?:N?SimSun|SimHei|FangSong|KaiTi)\b/i, lang: 'zh-CN' },
    { re: /\bMicrosoft\s+YaHei\b/i, lang: 'zh-CN' },
    { re: /\bMicrosoft\s+JhengHei\b/i, lang: 'zh-CN' },   // TC; v1 → zh-CN
    { re: /\bPingFang\b/i, lang: 'zh-CN' },
    { re: /\bST(?:Song|Heiti|Kaiti|Fangsong|Zhongsong|Xihei|Hupo|Liti|Xinwei|Caiyun)\b/i, lang: 'zh-CN' },
    { re: /\bAdobe\s+(?:Song|Heiti|Kaiti|Fangsong|Ming)\s+Std\b/i, lang: 'zh-CN' },
    { re: /\bP?MingLiU(?:-ExtB)?\b/i, lang: 'zh-CN' },
    { re: /\bDFKai-?SB\b/i, lang: 'zh-CN' },
    { re: /\bWenQuanYi\b/i, lang: 'zh-CN' },
    { re: /\bAR\s+PL\b/i, lang: 'zh-CN' },
    { re: /\bFounder\b/i, lang: 'zh-CN' },               // 方正 (romanized)
    { re: /\bHanYi\b/i, lang: 'zh-CN' },                 // 汉仪 (romanized)
    { re: /\bDengXian\b/i, lang: 'zh-CN' },              // 等线 (MS Office default SC; native 等线 handled by Han fallback)
    { re: /\bSongti\s+(?:SC|TC)\b/i, lang: 'zh-CN' },    // Apple Songti SC/TC (Chinese)
    // ── Japanese (ja) — each "Gothic"/"Mincho" anchored to its family token ──
    // Hiragino Sans GB is Apple's CHINESE face (GB = GuoBiao) — must match BEFORE
    // the generic Hiragino→ja (first-match-wins) so it isn't mis-tagged ja.
    { re: /\bHiragino\s+Sans\s+GB\b/i, lang: 'zh-CN' },
    { re: /\bHiragino\b/i, lang: 'ja' },
    { re: /\bYu\s*(?:Gothic|Mincho)\b/i, lang: 'ja' },
    { re: /\bMS\s+(?:P|UI\s+)?Gothic\b/i, lang: 'ja' },
    { re: /\bMS\s+P?Mincho\b/i, lang: 'ja' },
    { re: /\bMeiryo\b/i, lang: 'ja' },
    { re: /\bKozuka\s+(?:Gothic|Mincho)\b/i, lang: 'ja' },
    // ── Korean (ko) ──
    { re: /\bMalgun\s+Gothic\b/i, lang: 'ko' },
    { re: /\b(?:Batang|Gulim|Dotum|Gungsuh)(?:Che)?\b/i, lang: 'ko' },
    { re: /\bNanum(?:Gothic|Myeongjo|Barun|Square|Pen|Brush)?\b/i, lang: 'ko' }
];

// Native-script CJK family names whose Han characters would otherwise read as
// zh-CN under the generic script fallback but are actually JA. Explicit, checked
// before the fallback. (Hangul/Kana native names self-identify by script.)
// Matched against Japanese font NAMES as they actually appear. Data, not UI.
// Do NOT translate: the names on the system are these strings.
var CJK_NATIVE_JA = ['明朝', '丸ゴシック', '角ゴシック'];

// Generic fallback: classify by the family NAME's own codepoints. Kana → ja,
// Hangul → ko, Han → zh-CN (the documented native-name case). Kana/Hangul win
// over Han if both present.
function _nameScriptLang(family) {
    var hasHan = false;
    for (var i = 0; i < family.length; i++) {
        var cp = family.charCodeAt(i);
        if ((cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0x31F0 && cp <= 0x31FF)) return 'ja';   // Hiragana/Katakana
        if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF)) return 'ko';   // Hangul
        if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) hasHan = true;  // Han
    }
    return hasHan ? 'zh-CN' : null;
}

// _cjkFontByName(family) → 'zh-CN' | 'ja' | 'ko' | null, from the family NAME.
// Romanized allowlist (anchored) first, then JA native-Han exceptions, then the
// generic native-script fallback.
function _cjkFontByName(family) {
    var f = String(family || "");
    if (!f) return null;
    for (var i = 0; i < CJK_NAME_ALLOWLIST.length; i++) {
        if (CJK_NAME_ALLOWLIST[i].re.test(f)) return CJK_NAME_ALLOWLIST[i].lang;
    }
    for (var j = 0; j < CJK_NATIVE_JA.length; j++) {
        if (f.indexOf(CJK_NATIVE_JA[j]) >= 0) return 'ja';
    }
    return _nameScriptLang(f);
}

// resolveFontHomeLang(family, familyMap, writingScript) — 3-tier intrinsic
// identity priority:
//   1. writingScript known code (0/1/3/25)            → its lang (authoritative)
//   2. writingScript null (unreadable / NOT_AVAILABLE) → name identity; non-CJK
//      name → 'en' (Latin default; IGNORE usage — held chars may be misapplied)
//   3. writingScript UNKNOWN number (not 0/1/3/25)     → tier-3 usage argmax
//      (pickHomeLang, now `>0`-guarded). Rare residual, not the main path.
function resolveFontHomeLang(family, familyMap, writingScript) {
    if (typeof writingScript === 'number' && !isNaN(writingScript)) {
        if (Object.prototype.hasOwnProperty.call(WS_LANG, writingScript)) {
            return WS_LANG[writingScript];
        }
        return pickHomeLang(familyMap || {});   // unknown numeric code → tier 3
    }
    var byName = _cjkFontByName(family);         // ws null/unreadable → tier 2
    return byName || 'en';
}

// MVP detail #1: Font.name tab-split is sole reliable accessor.
// Single source of truth for "how to read appliedFont without tripping
// fontStyleName" — apply_to_doc also uses this helper.
// ─── TODO#71 2B: batched TSR reads ───────────────────────────────────────────
//
// 🔴 THE RISK THIS FUNCTION EXISTS TO MAKE TESTABLE.
// `everyItem()` fetches N values in one bridge call instead of N. Measured on
// this repo's own document (probes/20260823_10, 116 ranges):
//     characters.item(0).index per-TSR   2492ms      everyItem().index         60ms
//     characters.item(-1).index per-TSR  3720ms      everyItem().index+length 123ms
//     appliedFont per-TSR                1278ms      everyItem().appliedFont   64ms
// ⚠ But the danger is NOT that the batch fails to arrive. It is that the arrays
// come back and DO NOT LINE UP with the ranges — off by one, or a different
// length. That failure DOES NOT THROW: every record still gets a number, just
// the wrong one, and every tally, tsrMap entry and applied font after it
// silently belongs to a different range.
//
// So the zip is pulled out here as a pure function with one job: either hand
// back records that provably line up, or hand back null and let the caller use
// the per-TSR reads it already has.
//
// 🔴 Fail direction: null => fall back to the slow, known-correct path. A wrong
// alignment is worse than a slow scan — #58's rule again: when the engine
// cannot answer, do not answer for it.
//
// Equivalence of index / index+length-1 with the per-TSR reads is MEASURED, not
// assumed: 116/116 ranges on this document (83 story-direct + 33 in table cells),
// 0 mismatches, 0 throws. ⚠ One document; footnotes and overset not separated out.
function alignTsrBatch(n, indexes, lengths, fonts, contents) {
    if (!n || n < 0) return null;
    if (!indexes || !lengths || !fonts) return null;
    if (indexes.length !== n || lengths.length !== n || fonts.length !== n) return null;
    // `contents` is OPTIONAL: callers that do not batch it still get the old
    // behaviour. When it IS supplied it must be the same shape, or the whole
    // batch is void - a contents array of the wrong length would hand every
    // range somebody else's text without throwing.
    var wantContents = (contents !== undefined && contents !== null);
    if (wantContents && contents.length !== n) return null;
    var out = [];
    for (var i = 0; i < n; i++) {
        var idx = Number(indexes[i]);
        var len = Number(lengths[i]);
        // A range with no numeric index, or a non-positive length, is not something
        // this function can vouch for. One bad entry voids the WHOLE batch rather
        // than leaving a hole that reads like a real record.
        if (!isFinite(idx) || !isFinite(len) || len <= 0) return null;
        // 🔴 THE GATE. A pure zip cannot see a shifted array by itself — every
        // record still gets a number, just the wrong one. What CAN see it is a
        // structural invariant of the data: ranges partition their container
        // contiguously, so each index must be exactly where the previous one ended.
        // MEASURED before this check was written (probes/20260823_10): 80/80
        // adjacent pairs contiguous, 0 exceptions. A batch whose index or length
        // array is off by one breaks this on the first pair.
        // ⚠ It does NOT catch a shifted FONT array — nothing at this layer can.
        //   The defence there is that all three arrays are fetched from the SAME
        //   collection in the same expression; the caller must keep it that way.
        if (i > 0 && idx !== out[i - 1].idxEnd + 1) return null;
        var rec = { idxStart: idx, idxEnd: idx + len - 1, font: fonts[i] };
        if (wantContents) {
            // 🔴 A SECOND, INDEPENDENT invariant, and the only thing here that can
            // catch a shifted CONTENTS or LENGTHS array: the two arrays are fetched
            // separately, so `contents[i]` having exactly `lengths[i]` characters is a
            // cross-check between them. A one-off shift breaks it on the first range
            // whose neighbour has a different size.
            // ⚠ NOT assumed to hold: TSR `contents` is tag-ised in UXP (CLAUDE #1),
            //   so a range containing markers may serialise longer than its length. If
            //   that happens this gate voids the batch and the caller falls back to the
            //   per-item reads - correct, just slower. `contentsRejected` below makes
            //   that fallback VISIBLE instead of silently costing a second.
            var cv = String(contents[i] === undefined || contents[i] === null ? "" : contents[i]);
            if (cv.length !== len) return null;
            rec.contents = cv;
        }
        out.push(rec);
    }
    return out;
}

// TODO#71 2B: the same parsing, but taking the Font VALUE rather than the range,
// so a batched `everyItem().appliedFont` entry can reuse it unchanged.
// ⚠ readTsrFontFamilyStyle keeps its signature: other callers use it.
function readFontFamilyStyle(f) {
    var family = "", style = "";
    try {
        var _f = f;
        var f = _f;
        if (typeof f === "string") {
            var parts = f.split("\t");
            family = parts[0] || "";
            style = parts[1] || "";
        } else if (f) {
            var n = "";
            try { n = String(f.name); } catch (eN) { n = ""; }
            if (n) {
                var p = n.split("\t");
                family = p[0] || "";
                style = p[1] || "";
            } else {
                try { family = String(f.fontFamily); } catch (eFF) {}
            }
        }
    } catch (eApp) {}
    if (!style) style = "Regular";
    return { family: family, style: style };
}

function readTsrFontFamilyStyle(tsr) {
    var f = null;
    try { f = tsr.appliedFont; } catch (e) { return { family: "", style: "Regular" }; }
    return readFontFamilyStyle(f);
}

// ---------------------------------------------------------------------------
// alias table + collision PROBE  (the A4 auto-merger is retired — see below)
// ---------------------------------------------------------------------------
// 🪦 `canonicalKey` and `buildCanonicalIndex` DELETED (TODO#58, 2026-08-20).
// They existed for one purpose: key two spellings together by lowercase+despace
// so the A4 batch could auto-merge them. owner retired that criterion —
// 「不应该是确定的方法用于判断它们是绝对一致的再合并吗，而不是靠表面的名称」 — and
// the replacement (buildIdentityGroups, keyed on Font.postscriptName) needs no
// name normalisation at all. They are deleted rather than left exported so that
// "grep for live callers" can actually answer the question.
//
// 🔴 What SURVIVES here is `styleAlias` + STYLE_ALIAS_TABLE, and it survives as
// a DIAGNOSTIC, not as a merge criterion: the only thing left that reads it is
// detectConfirmableCollisions below, which merges nothing — it reports that two
// alias-equivalent spellings are BOTH genuinely in use. arch kept that branch
// deliberately (no other producer can answer that question, and it costs nothing).
// Do not let it creep back into a merge decision.

// ~15-item style alias table — bidirectional class → canonical form.
// Lowercase keys; lookup case-insensitive.
var STYLE_ALIAS_TABLE = [
    // Regular class
    { canonical: "regular", aliases: ["regular", "roman", "book", "normal", "plain"] },
    // Italic class
    { canonical: "italic", aliases: ["italic", "oblique", "ital"] },
    // Bold class
    { canonical: "bold", aliases: ["bold", "demibold", "semibold", "demi", "semi", "600"] },
    { canonical: "heavy", aliases: ["heavy", "black", "ultra", "ultrabold", "ultra bold", "800", "900"] },
    // Light class
    { canonical: "light", aliases: ["light", "thin", "ultralight", "ultra light", "200", "300"] },
    // Medium class (distinct from regular)
    { canonical: "medium", aliases: ["medium", "500"] },
    // Combined classes (italic variants)
    { canonical: "bolditalic", aliases: ["bolditalic", "bold italic", "demibolditalic", "semibolditalic"] },
    { canonical: "lightitalic", aliases: ["lightitalic", "light italic"] }
];

function styleAlias(style) {
    var s = String(style || "").toLowerCase().replace(/\s+/g, "");
    for (var i = 0; i < STYLE_ALIAS_TABLE.length; i++) {
        var entry = STYLE_ALIAS_TABLE[i];
        for (var j = 0; j < entry.aliases.length; j++) {
            if (entry.aliases[j].replace(/\s+/g, "") === s) return entry.canonical;
        }
    }
    return null;
}

// 🪦 `detectMergesAndCollisions` RENAMED to `detectConfirmableCollisions`, and
// its AUTO-MERGE HALF IS GONE (TODO#58, 2026-08-20). The rename is the point: the
// old name promised a merger, and grepping for the merger is how the next person
// checks that the heuristic really stopped running. Nothing produces
// `equivalence_groups_auto` from names any more — scanActiveDoc builds it from
// buildIdentityGroups (face identity), and the two do NOT run side by side.
//
// 🔴 Why the auto half had to go and not merely be gated: it keyed on
// lowercase+despace, so it could fold two spellings without ever asking whether
// they name the same FACE. In practice it was close to inert (measured on a
// document with its fonts installed: egCount 0, because InDesign normalises an
// INSTALLED family's spelling on assignment) — which is exactly why leaving it
// running "just in case" would have been worse than useless: rare enough never to
// be noticed, wrong on the same principle owner rejected.
//
// WHAT THIS STILL DOES — the collision probe, unchanged:
// family X has both "Book" and "Regular" in the raw scan; they are alias-
// equivalent but BOTH genuinely in use, so a merge would be lossy. It is the only
// producer that can tell "both spellings are really used" apart from "two names
// for one face", and it costs nothing. 🔴 It reports; it never merges.
// (It currently has no UI — #56 retired the banner — so today it is data only.)
//
// ⚠ MEASURED OVERLAP (host run, panelfix 2026-08-20): a pair can now be BOTH a
// confirmable collision here AND an identity merge over in equivalence_groups_auto.
// Real reading from that run — `Source Han Sans CN` Regular + Normal:
//   confirmable_merges: alias_class "regular", reason "auto-merge would be lossy"
//   equivalence_groups_auto: merged, because the engine reports ONE postscriptName
//                            (SourceHanSansCN-Normal) for both spellings
// The two are not in conflict — they answer different questions ("are both
// spellings in use?" vs "are they the same face?") — but this branch's `reason`
// STRING now says something untrue about that particular pair.
// It is left as-is deliberately: nothing consumes it today, and rewording it is a
// product decision that belongs with whoever gives this branch a UI again.
// 🔴 If you are that person: fix the wording FIRST. Under the old name-only
// criterion "lossy" was always right; it no longer is.
function detectConfirmableCollisions(byFamilyMap, homeLangByFamily) {
    var confirmable_merges = [];


    // Collision: alias-equivalent but BOTH raw entries exist
    var seenAliasGroupsByFamily = {}; // family → { aliasCanonical → [styles] }
    for (var family in byFamilyMap) {
        if (!Object.prototype.hasOwnProperty.call(byFamilyMap, family)) continue;
        var seen = {};
        for (var style in byFamilyMap[family]) {
            if (!Object.prototype.hasOwnProperty.call(byFamilyMap[family], style)) continue;
            var ac = styleAlias(style);
            if (!ac) continue;
            if (!seen[ac]) seen[ac] = [];
            seen[ac].push(style);
        }
        for (var aliasClass in seen) {
            if (!Object.prototype.hasOwnProperty.call(seen, aliasClass)) continue;
            if (seen[aliasClass].length >= 2) {
                confirmable_merges.push({
                    lang: homeLangByFamily[family] || 'en',
                    family: family,
                    styles: seen[aliasClass].slice(),
                    alias_class: aliasClass,
                    reason: "both styles exist in doc; auto-merge would be lossy"
                });
            }
        }
    }

    return { confirmable_merges: confirmable_merges };
}

// ---------------------------------------------------------------------------
// gatherTallies — iterate every TSR + emit raw tally + tsrMap
// ---------------------------------------------------------------------------
// Returns:
//   {
//     byFamily: { family → { style → { count, langCounts } } },
//     tsrMap:   [{ storyIdx, idxStart, idxEnd, dominantLang, sourceFont, sourceWeight }],
//     totalChars, totalTsrs, skippedTsrs
//   }
//
// MVP detail #6: capture story-relative idx range, not TSR ref (which becomes
// stale post-mutate). Use tsr.characters.item(0).index + item(-1).index.
function gatherTallies(doc) {
    var byFamily = {};
    var tsrMap = [];
    // #71: which CALL inside the per-TSR loop costs the time. Counters only —
    // nothing is skipped, cached or reordered. 🔴 Date.now() is called a few
    // times per TSR; at ~144ms per TSR that is noise, and the alternative
    // (guessing which host property is the slow one) is what this round exists to
    // avoid.
    var _tw = { fontRead: 0, contents: 0, charIndex: 0, tally: 0, tsrs: 0 };
    // 🔴 MEASURED 2026-08-23 (probes/20260823_13): whichever read touches a range
    // FIRST pays ~14ms; the same read costs ~0.2ms if something touched the range
    // before it. The cost belongs to the first touch, NOT to any one property.
    // ⇒ a profiler that only reports ms-per-property structurally attributes that
    //   tax to whichever read happens to be first, and the next person to read this
    //   table will aim at the wrong target. (Today's example: `contents` went
    //   8ms -> 1216ms without being touched by the change, purely by becoming first.)
    // So the touch ORDER ships next to the ms, as a reading rather than as a warning
    // written somewhere else — the confusion is then visible in the data itself.
    _tw.firstTouch = { fontRead: 0, contents: 0, charIndex: 0 };
    function ensure(family, style) {
        if (!byFamily[family]) byFamily[family] = {};
        if (!byFamily[family][style]) {
            byFamily[family][style] = {
                count: 0,
                langCounts: { 'en': 0, 'zh-CN': 0, 'zh-TW': 0, 'ja': 0, 'ko': 0, 'th': 0 }
            };
        }
        return byFamily[family][style];
    }

    var totalChars = 0;
    var totalTsrs = 0;
    var skippedTsrs = 0;

    // Codex r1+r2 P2-2 fix: helper to process per-TSR in either story or cell
    // context. cellPath, if set, identifies the cell-owned text container
    // ({tableIdx, cellIdx, textIdx}) so apply_to_doc can address the right
    // text. For story-direct TSRs cellPath is null.
    // `pre` is one record from alignTsrBatch, or null. When present it carries the
    // two values this loop used to buy one host round-trip at a time. When absent
    // — batch unavailable, or it did not line up — the original per-TSR reads run
    // unchanged, so the slow path stays the reference implementation rather than
    // becoming dead code nobody exercises.
    function processTsr(tsr, storyIdx, cellPath, pre) {
        totalTsrs++;
        _tw.tsrs++;
        // Which read touched THIS range first. A batched value costs no touch, so
        // reads that consume `pre` do not mark.
        var _first = null;
        function _mark(label) { if (!_first) { _first = label; _tw.firstTouch[label]++; } }
        var _t = Date.now();
        if (!pre) _mark("fontRead");
        var fs = pre ? readFontFamilyStyle(pre.font) : readTsrFontFamilyStyle(tsr);
        _tw.fontRead += Date.now() - _t;
        if (!fs.family) { skippedTsrs++; return; }

        var contents = "";
        _t = Date.now();
        if (pre && typeof pre.contents === "string") {
            // batched: costs no touch, so it does not _mark
            contents = pre.contents;
        } else {
            _mark("contents");
            try { contents = String(tsr.contents); } catch (eC) {}
        }
        _tw.contents += Date.now() - _t;
        if (!contents) return;

        _t = Date.now();
        var t = tallyContents(contents);
        _tw.tally += Date.now() - _t;
        var rec = ensure(fs.family, fs.style);
        var charsInTsr = contents.length;
        rec.count += charsInTsr;
        totalChars += charsInTsr;
        for (var k in t) {
            if (Object.prototype.hasOwnProperty.call(t, k)) rec.langCounts[k] += t[k];
        }

        var idxStart = -1, idxEnd = -1;
        var _ti = Date.now();
        if (pre) {
            // Equivalence measured on every range of a real document
            // (probes/20260823_10): 116/116, 0 mismatches, 0 throws.
            idxStart = pre.idxStart;
            idxEnd = pre.idxEnd;
        } else {
            _mark("charIndex");
            try {
                idxStart = tsr.characters.item(0).index;
                idxEnd = tsr.characters.item(-1).index;
            } catch (eIdx) {}
        }
        _tw.charIndex += Date.now() - _ti;

        var dom = pickDominantLang(contents);
        if (idxStart >= 0 && idxEnd >= 0) {
            tsrMap.push({
                storyIdx: storyIdx,
                idxStart: idxStart,
                idxEnd: idxEnd,
                dominantLang: dom,
                sourceFont: fs.family,
                sourceWeight: fs.style,
                charsInTsr: charsInTsr,
                paraId: _paraIdFor(tsr),
                cellPath: cellPath || null  // null = story-direct; else cell-owned
            });
        }
    }

    // 🔴 All three arrays come from the SAME collection object in the SAME
    // expression. alignTsrBatch can catch an index/length shift (contiguity) but
    // NOTHING at that layer can catch a shifted FONT array — keeping the three
    // fetches together is the only defence, so they stay in one place.
    function prefetchBatch(col, n) {
        if (!n) return null;
        try {
            // 🔴 contents is batched too. Measured (probes/20260823_18, 83 ranges):
            //     col.item(i) object fetch      607ms
            //     obj.contents per item         578ms   (already warm - the fetch touched it)
            //     col.everyItem().contents       84ms
            // ⚠ The saving is NOT 578-84. A batched read costs no FIRST TOUCH
            //   (#71's firstTouch.contents=116 shows contents was the first toucher on
            //   every range), so batching it removes the object fetch as well: the fast
            //   path stops touching the range at all. ≈ 1101ms on this document.
            // ⚠ All four arrays come from the SAME collection in ONE expression -
            //   alignTsrBatch's gates depend on that and cannot check it themselves.
            return alignTsrBatch(n, col.everyItem().index, col.everyItem().length,
                                 col.everyItem().appliedFont, col.everyItem().contents);
        } catch (eB) { return null; }
    }

    for (var s = 0; s < doc.stories.length; s++) {
        var story = doc.stories.item(s);

        // Main story-level TSRs (cellPath=null)
        var _sN = 0;
        try { _sN = story.textStyleRanges.length; } catch (eN) { _sN = 0; }
        var _sPre = prefetchBatch(story.textStyleRanges, _sN);
        for (var r = 0; r < _sN; r++) {
            var _p = _sPre ? _sPre[r] : null;
            // 🔴 When the batch carries contents there is nothing left that needs
            // the range OBJECT, so it is never fetched. processTsr reads `tsr` only for
            // `.contents` and for the characters.item() fallback, and both are on the
            // no-batch path. Fetching it anyway cost 607ms/83 ranges for nothing.
            if (_p && typeof _p.contents === "string") { processTsr(null, s, null, _p); continue; }
            var tsr;
            try { tsr = story.textStyleRanges.item(r); }
            catch (eIt) { skippedTsrs++; continue; }
            processTsr(tsr, s, null, _p);
        }

        // Codex r1 P2-2 fix: table cell text is NOT part of story.textStyleRanges.
        // Walk story.tables[] → table.cells[] → cell.texts[0].textStyleRanges
        // (per cjk_style_apply.idjs:587 pattern).
        try {
            var tables = story.tables;
            var nTables = 0;
            try { nTables = tables.length; } catch (eTl) {}
            for (var ti = 0; ti < nTables; ti++) {
                var table = tables.item(ti);
                var cells = table.cells;
                var nCells = 0;
                try { nCells = cells.length; } catch (eCl) {}
                for (var ci = 0; ci < nCells; ci++) {
                    var cell = cells.item(ci);
                    var cellTexts;
                    try { cellTexts = cell.texts; } catch (eTx) { continue; }
                    var nTexts = 0;
                    try { nTexts = cellTexts.length; } catch (eTL) {}
                    for (var xi = 0; xi < nTexts; xi++) {
                        var ctext;
                        try { ctext = cellTexts.item(xi); } catch (eGT) { continue; }
                        var ctsrs;
                        try { ctsrs = ctext.textStyleRanges; } catch (eTS) { continue; }
                        var nTsrs = 0;
                        try { nTsrs = ctsrs.length; } catch (eTL2) {}
                        // codex r2 P2-2 fix: emit cellPath so action executor
                        // can address story.tables[T].cells[C].texts[X]
                        var cp = { tableIdx: ti, cellIdx: ci, textIdx: xi };
                        var _cPre = prefetchBatch(ctsrs, nTsrs);
                        for (var cti = 0; cti < nTsrs; cti++) {
                            var ctsr;
                            try { ctsr = ctsrs.item(cti); }
                            catch (eIt2) { skippedTsrs++; continue; }
                            processTsr(ctsr, s, cp, _cPre ? _cPre[cti] : null);
                        }
                    }
                }
            }
        } catch (eAll) { /* tables not available — skip */ }
    }

    // #71 — per-call totals for the TSR loop (see _tw above)

    return {
        callTimings: _tw,
        byFamily: byFamily,
        tsrMap: tsrMap,
        totalChars: totalChars,
        totalTsrs: totalTsrs,
        skippedTsrs: skippedTsrs
    };
}

// Lightweight paragraph ID — paragraph index within story for sample link.
function _paraIdFor(tsr) {
    try {
        var paras = tsr.paragraphs;
        if (paras && paras.length > 0) {
            var p = paras.item(0);
            return p.index;
        }
    } catch (e) {}
    return -1;
}

// ---------------------------------------------------------------------------
// buildUnresolvedByLang — codex r2 plan-audit P1a fix: per-pair grouped
// ---------------------------------------------------------------------------
// For each TSR with dominant lang X, for each pair the source font belongs
// to, check if pair has a member for X. If not, accumulate this TSR under
// unresolvedByLang[X] as one entry per (pairId, sourceFont, sourceWeight).
//
// Plan note: this is per-pair grouped, NOT global set diff
// (`documentLangsSet \ pairingCoveredLangs` would miss case where lang is
// covered by another pair but the misapplied TSR uses a different pair).
function buildUnresolvedByLang(tsrMap, config) {
    var unresolvedByLang = {};
    if (!config || !Array.isArray(config.pairs)) return unresolvedByLang;

    // Index pairs by font-belongs-to-pair: which pair contains (lang, font, weight)?
    // pairsByMember: { "lang|font|weight" → [{pairIdx, pair}] }
    var pairsByMember = {};
    for (var pi = 0; pi < config.pairs.length; pi++) {
        var pair = config.pairs[pi];
        if (!pair || !Array.isArray(pair.members)) continue;
        for (var mi = 0; mi < pair.members.length; mi++) {
            var m = pair.members[mi];
            if (!m || !m.lang || !m.font || !m.weight) continue;
            var key = m.lang + "|" + m.font + "|" + m.weight;
            if (!pairsByMember[key]) pairsByMember[key] = [];
            pairsByMember[key].push({ pairIdx: pi, pair: pair });
        }
    }

    for (var i = 0; i < tsrMap.length; i++) {
        var t = tsrMap[i];
        if (!t.dominantLang) continue;
        // Find pairs that contain this TSR's source font (in any lang)
        // — we need to know which pairs are "responsible" for this TSR
        // for purposes of asking "did this pair cover the dominantLang?"
        var matchedPairs = [];
        for (var pmKey in pairsByMember) {
            if (!Object.prototype.hasOwnProperty.call(pairsByMember, pmKey)) continue;
            // pmKey = "lang|font|weight". Split on the FIRST two "|" only — a font
            // or weight is assumed "|"-free (same assumption the producer makes).
            var b1 = pmKey.indexOf("|");
            var b2 = pmKey.indexOf("|", b1 + 1);
            var mLang = pmKey.slice(0, b1);
            var mFont = pmKey.slice(b1 + 1, b2);
            var mWeight = pmKey.slice(b2 + 1);
            // B-ui A-3 fix (equiv-aware ownership): match the TSR's source font to
            // a pair member EQUIVALENCE-aware, sharing resolve_core's notion of
            // "pair covers this source". A doc font that is a merged_in ALIAS of a
            // member (or a member that is itself an alias of the doc's canonical)
            // must still count as owned — otherwise an alias mismatch wrongly
            // reports the run as unresolved. Fold BOTH sides to canonical under
            // the member's lang before comparing (getCanonical is identity when no
            // equivalence_groups / no match, so raw configs are unaffected).
            var rawMatch = (mFont === t.sourceFont && mWeight === t.sourceWeight);
            var equivMatch = false;
            if (!rawMatch && FMP && typeof FMP.getCanonical === "function") {
                var cSrc = FMP.getCanonical(config, mLang, t.sourceFont, t.sourceWeight);
                var cMem = FMP.getCanonical(config, mLang, mFont, mWeight);
                equivMatch = (cSrc.font === cMem.font && cSrc.weight === cMem.weight);
            }
            if (rawMatch || equivMatch) {
                matchedPairs = matchedPairs.concat(pairsByMember[pmKey]);
            }
        }

        // For each matched pair, check if pair has a member with the TSR's
        // dominantLang. If not → record under unresolvedByLang[dom].
        var seenPairs = {};
        for (var mp = 0; mp < matchedPairs.length; mp++) {
            var pi2 = matchedPairs[mp].pairIdx;
            if (seenPairs[pi2]) continue;
            seenPairs[pi2] = true;
            var p = matchedPairs[mp].pair;
            var hasDomLang = false;
            for (var mi2 = 0; mi2 < p.members.length; mi2++) {
                if (p.members[mi2].lang === t.dominantLang) { hasDomLang = true; break; }
            }
            if (hasDomLang) continue;

            if (!unresolvedByLang[t.dominantLang]) unresolvedByLang[t.dominantLang] = [];
            // Find or add per-(pairIdx, sourceFont, sourceWeight) bucket
            var bucket = null;
            for (var b = 0; b < unresolvedByLang[t.dominantLang].length; b++) {
                var bb = unresolvedByLang[t.dominantLang][b];
                if (bb.pairingId === pi2 && bb.sourceFont === t.sourceFont && bb.sourceWeight === t.sourceWeight) {
                    bucket = bb;
                    break;
                }
            }
            if (!bucket) {
                bucket = {
                    pairingId: pi2,
                    sourceFont: t.sourceFont,
                    sourceWeight: t.sourceWeight,
                    tsrCount: 0,
                    sampleParaIds: []
                };
                unresolvedByLang[t.dominantLang].push(bucket);
            }
            bucket.tsrCount++;
            if (bucket.sampleParaIds.length < 5 && t.paraId >= 0 &&
                bucket.sampleParaIds.indexOf(t.paraId) < 0) {
                bucket.sampleParaIds.push(t.paraId);
            }
        }
    }
    return unresolvedByLang;
}

// ---------------------------------------------------------------------------
// buildPanelData — for UI rendering (MVP shape, kept for back-compat)
// ---------------------------------------------------------------------------
// MVP detail #3: optional installedFamiliesMap → augment each font's weight
// list with installed-but-not-doc-used styles (used=0).
// 8D-ext-FL: byFamilyHomeLang is the intrinsic (writingScript→name) per-family
// classification from scanActiveDoc — the single source of truth for which
// language COLUMN a family lands in. The panel display IS the user-visible
// symptom, so it must agree with that intrinsic call (else the FM2 case — a
// not-installed Latin source font holding Chinese — still shows under zh-CN).
// Fall back to the usage-based pickHomeLang only when not supplied (back-compat
// for no-arg / other callers).
function buildPanelData(tallies, brandName, installedFamiliesMap, byFamilyHomeLang) {
    var langBuckets = {};

    // Codex r3 P1-4 fix: scope F_id / w_id by lang. Same family in different
    // home_langs would otherwise share IDs and React lookup/removal would
    // conflate them.
    for (var family in tallies.byFamily) {
        if (!Object.prototype.hasOwnProperty.call(tallies.byFamily, family)) continue;
        var familyMap = tallies.byFamily[family];
        var lang = (byFamilyHomeLang && Object.prototype.hasOwnProperty.call(byFamilyHomeLang, family))
            ? byFamilyHomeLang[family]
            : pickHomeLang(familyMap);
        if (!langBuckets[lang]) langBuckets[lang] = [];

        var langScope = _sanitizeId(lang);
        var fontId = 'F_' + langScope + '_' + _sanitizeId(family);
        var weights = [];
        var seenStyles = {};
        for (var style in familyMap) {
            if (!Object.prototype.hasOwnProperty.call(familyMap, style)) continue;
            weights.push({
                id: 'w_' + langScope + '_' + _sanitizeId(family) + '_' + _sanitizeId(style),
                semantic: style,
                actual: style,
                used: familyMap[style].count
            });
            seenStyles[style] = true;
        }
        // MVP #3: installed-style augmentation
        if (installedFamiliesMap && installedFamiliesMap[family]) {
            var installedStyles = installedFamiliesMap[family];
            for (var i = 0; i < installedStyles.length; i++) {
                var st = installedStyles[i];
                if (seenStyles[st]) continue;
                weights.push({
                    id: 'w_' + langScope + '_' + _sanitizeId(family) + '_' + _sanitizeId(st),
                    semantic: st,
                    actual: st,
                    used: 0
                });
                seenStyles[st] = true;
            }
        }
        weights.sort(function (a, b) { return b.used - a.used; });
        langBuckets[lang].push({
            id: fontId,
            name: family,
            role: 'Body',
            weights: weights,
            merges: []
        });
    }

    var languages = [];
    var langOrder = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'th'];
    for (var i = 0; i < langOrder.length; i++) {
        var code = langOrder[i];
        var fonts = langBuckets[code];
        if (!fonts || fonts.length === 0) continue;
        var preset = LANG_PRESETS_BY_CODE[code] || { name: code, script: '·', family: 'sans-serif' };
        languages.push({
            id: 'L_' + code.replace(/-/g, '_'),
            code: code,
            name: preset.name,
            script: preset.script,
            family: preset.family,
            fonts: fonts
        });
    }

    return {
        name: brandName || 'Brand',
        languages: languages,
        pairings: []
    };
}

function _sanitizeId(s) {
    return String(s || "").replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// 8D-ext-FL host wiring: read a family's intrinsic writingScript (host-only).
// ---------------------------------------------------------------------------
// ws is per-FACE (a Font = family\tstyle) but home_lang is per-FAMILY → consult
// the highest-`.count` style first; if that face is NOT_AVAILABLE (reading
// writingScript throws "font family is not available"), fall through the
// remaining styles by descending count. NEVER iterate app.fonts — a 590-font
// scan blocks the UXP event loop >25s → bridge heartbeat disconnect; only look
// up the doc's own families via itemByName. Returns a Number ws, or null if no
// face of the family is installed/readable (→ resolveFontHomeLang tier-2 name).
function _readFamilyWritingScript(family, familyMap) {
    if (!app || !app.fonts) return null;
    try {
        var styles = [];
        for (var st in familyMap) {
            if (Object.prototype.hasOwnProperty.call(familyMap, st)) {
                styles.push({ style: st, count: (familyMap[st] && familyMap[st].count) || 0 });
            }
        }
        styles.sort(function (a, b) { return b.count - a.count; });
        if (!styles.length) styles.push({ style: 'Regular', count: 0 });
        for (var i = 0; i < styles.length; i++) {
            try {
                var f = app.fonts.itemByName(family + '\t' + styles[i].style);
                if (f && f.isValid) {
                    var ws = f.writingScript;  // throws if face NOT_AVAILABLE
                    if (typeof ws === 'number' && !isNaN(ws)) return ws;
                }
            } catch (eFace) { /* NOT_AVAILABLE face — try next style by count */ }
        }
    } catch (eAll) {}
    return null;
}

// ---------------------------------------------------------------------------
// scanActiveDoc — public entry
// ---------------------------------------------------------------------------
// opts.installedFamilies — { family: [styles] } for MVP #3 augmentation
// opts.config            — brand config for unresolvedByLang computation (optional)
function scanActiveDoc(opts) {
    opts = opts || {};
    if (!app || !app.documents || !app.documents.length) {
        return { ok: false, reason: 'no document open', data: null };
    }
    var doc = app.activeDocument;
    var t0 = Date.now();
    // #71 (owner: 「双击脚本后等待开面板的时间很长」). The launcher's first table put
    // 15867ms of a 16654ms startup inside this ONE function, so it is split here.
    // 🔴 MEASUREMENT ONLY — no work is reordered, skipped or cached. `_seg`
    // just stamps a label; the numbers ride out on the existing return value and
    // are written by the caller's existing log write (no extra flush).
    var _timings = {};
    var _segT = t0;
    function _seg(name) { _timings[name] = Date.now() - _segT; _segT = Date.now(); }
    var tallies;
    try { tallies = gatherTallies(doc); }
    catch (e) {
        return { ok: false, reason: 'gather failed: ' + (e.message || String(e)), data: null };
    }
    _seg("gatherTallies");
    try { _timings.gatherTalliesCalls = tallies.callTimings; } catch (eCT) {}
    var brand = '';
    try { brand = String(doc.name).replace(/\.indd$/i, ''); } catch (e) {}

    // 8D-ext-FL: home_lang by INTRINSIC identity (writingScript → name → usage),
    // not by usage argmax. Read each family's writingScript host-side and pass it
    // into the pure resolver. Fixes the FM2 bug where a Latin source font that
    // holds mis-applied CJK chars (Whitney on translated zh) was bucketed zh-CN.
    var byFamilyHomeLang = {};
    for (var family in tallies.byFamily) {
        if (!Object.prototype.hasOwnProperty.call(tallies.byFamily, family)) continue;
        var famMap = tallies.byFamily[family];
        var ws = _readFamilyWritingScript(family, famMap);
        byFamilyHomeLang[family] = resolveFontHomeLang(family, famMap, ws);
    }

    // """ + R + u""" home-lang resolution calls _readFamilyWritingScript ONCE PER FAMILY, and
    // that is a host round-trip — a prime suspect for the bulk of the time above.
    _seg("homeLangByFamily");

    // Alias-collision probe (reports only — see detectConfirmableCollisions).
    var mergeInfo = detectConfirmableCollisions(tallies.byFamily, byFamilyHomeLang);

    // TODO#58 — the auto batch, now by FACE IDENTITY instead of by spelling.
    // entries = every (family, style) the document actually uses, carrying its
    // home lang (an eg holds a single lang, so two spellings whose home langs
    // differ are not one group even if the face is identical) and its usage count
    // (canonical tier 2 tiebreak).
    // 🔴 `opts.identityOf` exists so a Node test can drive this without InDesign;
    // in the host it is the memoized itemByName lookup above. If the grouper could
    // not be loaded at all we emit NOTHING rather than falling back to the retired
    // name heuristic — fail closed, same as every other branch of this criterion.
    var identityEntries = [];
    for (var idf in tallies.byFamily) {
        if (!Object.prototype.hasOwnProperty.call(tallies.byFamily, idf)) continue;
        for (var ids in tallies.byFamily[idf]) {
            if (!Object.prototype.hasOwnProperty.call(tallies.byFamily[idf], ids)) continue;
            identityEntries.push({
                family: idf,
                style: ids,
                lang: byFamilyHomeLang[idf] || 'en',
                count: tallies.byFamily[idf][ids].count || 0
            });
        }
    }
    var identityGroups = [];
    var identityReadout = null;
    if (FIG) {
        var identityOf = (typeof opts.identityOf === "function") ? opts.identityOf : makeIdentityLookup();
        var idBuild = FIG.buildIdentityGroups(identityEntries, identityOf);
        identityGroups = idBuild.groups;
        // TODO#58 (5). At SCAN time there is no config yet, so the last two of the
        // five are structurally zero here: nothing can be blocked by an operator eg
        // that does not exist, and our own output cannot overlap itself (one entry
        // lands in exactly one bucket). They are still emitted, separately, so the
        // shape is the same one the panel reports and nobody has to guess whether a
        // missing field means zero or means "not measured".
        identityReadout = FIG.summarizeIdentityReadout(idBuild, null, identityGroups);
    }

    _seg("identityGroups");

    // documentFonts list (per fonts_by_language format)
    var documentFonts = [];
    for (var fam in tallies.byFamily) {
        if (!Object.prototype.hasOwnProperty.call(tallies.byFamily, fam)) continue;
        for (var sty in tallies.byFamily[fam]) {
            if (!Object.prototype.hasOwnProperty.call(tallies.byFamily[fam], sty)) continue;
            documentFonts.push({
                font: fam,
                weight: sty,
                used: tallies.byFamily[fam][sty].count
            });
        }
    }

    // unresolvedByLang per-pair grouped (vs brand config if provided)
    var unresolvedByLang = {};
    if (opts.config) {
        unresolvedByLang = buildUnresolvedByLang(tallies.tsrMap, opts.config);
    }

// 🪦 8D-ext-A `recombination_candidates` REMOVED (TODO#58, 2026-08-20).
    // It was the second name heuristic (normalize() + STYLE_ALIAS_TABLE) and the
    // panel auto-merged every candidate it produced. The panel now derives its own
    // groups from face identity via `fap.fontIdentity`, so this field would have
    // been a second, contradictory answer travelling in the same object.

    _seg("unresolvedByLang");
    var panelData = buildPanelData(tallies, brand || 'Document', opts.installedFamilies, byFamilyHomeLang);
    _seg("buildPanelData");

    return {
        ok: true,
        elapsedMs: Date.now() - t0,
        timings: _timings,          // #71 — per-phase ms inside this scan
        familyCount: Object.keys(byFamilyHomeLang).length,
        totalTsrs: tallies.totalTsrs,
        skippedTsrs: tallies.skippedTsrs,
        totalChars: tallies.totalChars,
        documentFonts: documentFonts,
        byFamilyHomeLang: byFamilyHomeLang,
        tsrMap: tallies.tsrMap,
        unresolvedByLang: unresolvedByLang,
        equivalence_groups_auto: identityGroups,       // TODO#58: by face identity
        identity_readout: identityReadout,             // TODO#58 (5)
        confirmable_merges: mergeInfo.confirmable_merges,
        panelData: panelData
    };
}

module.exports = {
    scanActiveDoc: scanActiveDoc,
    // Helpers exposed for testing + apply_to_doc reuse
    classifyCodepoint: classifyCodepoint,
    tallyContents: tallyContents,
    pickDominantLang: pickDominantLang,
    pickHomeLang: pickHomeLang,
    // 8D-ext-FL — font home-lang by intrinsic identity (pure, Node-testable)
    _cjkFontByName: _cjkFontByName,
    resolveFontHomeLang: resolveFontHomeLang,
    readTsrFontFamilyStyle: readTsrFontFamilyStyle,
    // TODO#71 2B - pure, so the misalignment risk can be tested in Node
    alignTsrBatch: alignTsrBatch,
    styleAlias: styleAlias,
    // TODO#58 — host half of the identity criterion; font_panel_env binds the
    // panel's `fap.fontIdentity` to THIS function so scan and panel cannot drift.
    makeIdentityLookup: makeIdentityLookup,
    buildUnresolvedByLang: buildUnresolvedByLang,
    detectConfirmableCollisions: detectConfirmableCollisions,
    // 🪦 `detectRecombinationCandidates` re-export DELETED (TODO#58). It was the
    // panel's only door to the A.1 name heuristic; removing the door is what makes
    // "grep for live callers" a real check instead of a promise.
    // For DI in tests (scan w/o real doc)
    _gatherTallies: gatherTallies,
    _buildPanelData: buildPanelData,
    _STYLE_ALIAS_TABLE: STYLE_ALIAS_TABLE,
    _DOM_LANG_ORDER: DOM_LANG_ORDER
};
