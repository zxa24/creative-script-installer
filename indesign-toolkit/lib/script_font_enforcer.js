"use strict";

// lib/script_font_enforcer.js — translation-agnostic post-apply pass.
//
// Problem this solves:
//   The cluster paragraph style architecture protects mixed-script paragraphs
//   via psFont (CJK fallback, e.g. Source Han Sans CN) + a nested GREP rule
//   that routes Latin chars to a `_T_Latin_*` character style. CJK chars
//   inherit psFont; Latin chars get the Latin font via GREP. This works
//   automatically for naked chars and for chars in pipeline-owned CSs
//   (`_T_*`). But InDesign's nested GREP rules DO NOT fire on chars that
//   carry an explicit non-[None] designer character style (e.g. "Hyperlink",
//   "BOLD emphasis"). Those chars take their font from the cascade:
//   CS → paragraph style → … — and if the designer CS itself has no
//   font, the chars fall through to psFont (CJK) regardless of their script.
//   Result: Latin chars inside Hyperlink wrapper render with the CJK font
//   (e.g. SHS Normal applied to "Client-A® VIPorter") OR — when something else
//   in the cluster repaints Hyperlink to a Latin font — CJK chars inside
//   Hyperlink wrapper render with the Latin font (= tofu).
//
// This pass forces script-appropriate fonts on chars wrapped in designer
// CSs, AS DIRECT OVERRIDES. Direct overrides win over both CS and GREP, so
// the designer CS itself is preserved (color, underline, position) while
// only the font is corrected.
//
// Scope:
//   Pure structural fix. Independent of source emphasis_runs, independent
//   of translation. Works on whatever text is currently in the paragraph
//   after target text has been written.
//
// Non-goals:
//   - Designer emphasis (Bold/color/superscript on Latin) still flows
//     through emphasis_runs / target_emphasis_runs / annotations.
//   - Pure-CJK or pure-Latin paragraphs need no help — the cluster style
//     already covers them.

var SC;
try { SC = require("./script_classifier.js"); } catch (e) { SC = null; }

function _safe(s) { try { return String(s || ""); } catch (e) { return ""; } }

// Identify CJK-rendering chars: Han (incl. Ext-A + Compatibility), Hiragana,
// Katakana, Hangul, CJK symbols/punctuation block, halfwidth/fullwidth forms.
// Mirrors the detector in emphasis_extractor._hasCJK so the two passes agree on
// what "CJK" means.
// NOT covered, despite what this comment claimed until 2026-08-06: Bopomofo
// U+3100-312F (zh-TW ruby / annotation) — verified false against the shipped
// class, and it was never in it. Whether the classifier SHOULD cover it is an
// open question, tracked together with the Hangul gap in v2_pipeline's sibling
// class: adding a range is a behaviour change and needs material in that script
// to verify against, so it is deliberately not done here.
// The class is written in \uXXXX ESCAPES on purpose — do NOT put literal
// CJK characters back. It used to hold the literal for U+F900, whose NFD
// decomposition is U+8C48; a normalizing edit rewrote the range start to
// U+8C48, silently widening the class over the surrogate block (so EVERY
// non-BMP char, emoji included, tested CJK), the PUA, and Yi/Vai/Lisu.
// Escapes cannot be eaten that way.
function _isCJKChar(ch) {
    if (!ch) return false;
    return /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch);
}

// Identify "Latin" chars whose font we want to keep as Latin: basic Latin,
// Latin-1 supplement, Latin Extended A/B, plus ASCII digits/punctuation.
// Whitespace + line/paragraph control chars don't need a font choice —
// skip them so we don't churn no-op overrides.
function _isLatinChar(ch) {
    if (!ch) return false;
    return /[ -~ -ɏ]/.test(ch);
}

// ── Neutral "smart punctuation" — script-ambiguous chars that NEITHER
// detector above claims. The General Punctuation block (U+2000–206F) sits
// between Latin Extended-B and the CJK blocks, so its quotes/dashes/ellipsis
// fall through both `_isCJKChar` and `_isLatinChar` and get ORPHANED in
// whatever font an earlier step (byPair swap / source) left them in:
//   - a French apostrophe U+2019 stranded in a CJK font renders FULL-WIDTH;
//   - a Simplified-Chinese quote U+201C stranded in a Latin font renders NARROW.
// (All of U+2018/2019/201C/201D/2014 are East-Asian-Width=Ambiguous, which is
// exactly why a naive "narrow→Latin" width rule mis-narrows CJK full-width
// quotes — see neutralPolicy below.) The set is the smart-punct an editor /
// translator actually emits; extend the regex as real docs surface more.
//   U+2010–2015  hyphen, non-breaking hyphen, figure/en/em dash, horizontal bar
//   U+2018–201F  all curly single/double + low/high quotation marks
//   U+2026       horizontal ellipsis
//   U+2032–2033  prime, double prime
//   U+2039–203A  single guillemets ‹ › (French nested quotes)
// ⚠ SoT: this set MUST stay identical to style_sheet_builder.js NEUTRAL_PUNCT_CLASS
// (the cluster GREP's neutral-join class). A cross-file agreement test pins them
// (tests/cluster_grep_repair_tests.js) — if they drift, the GREP joins a mark the
// enforcer/repair won't, or vice-versa = silent partial coverage.
var NEUTRAL_PUNCT_RE = /[‐-―‘-‟…′″‹›]/;
function _isNeutralPunct(ch) {
    if (!ch) return false;
    return NEUTRAL_PUNCT_RE.test(ch);
}

// Latin LETTERS only — NOT `_isLatinChar`, which also matches space / digits /
// ASCII punctuation. Used solely for NEIGHBOR-script detection when resolving
// a neutral punct char: we want the nearest char that genuinely signals
// CJK-vs-Latin script, so spaces / digits / punctuation stay transparent.
function _isLatinLetter(ch) {
    if (!ch) return false;
    return /[A-Za-zÀ-ɏḀ-ỿ]/.test(ch);
}

// Context-following resolver for a neutral punct char at index `i` in `text`:
// scan outward (both directions) for the nearest script-bearing LETTER (CJK
// glyph or Latin letter), skipping whitespace / digits / other neutral punct so
// the mark follows the WORD it bounds, not an adjacent space. Returns
// "cjk" | "latin" | null. Nearer side wins; on an exact-distance CJK-vs-Latin
// tie an OPENING quote (‘ / “) binds to the following token, every other mark to
// the preceding one (keeps a quote PAIR on one script — 他说“OpenAI” fonts BOTH
// quotes Latin). No letter either side but a digit adjacent → "latin" (a mark in
// a numeric range like "2013–2020" follows the digits, which route to Latin);
// otherwise → null (leave to the cascade).
// Neighbor detection is per UTF-16 code unit. A lone surrogate no longer reads as
// CJK: the class was narrowed to \uF900-\uFAFF, which removed D800-DFFF from it,
// so a mark whose only neighbor is astral (emoji / CJK Ext-B) now resolves to the
// other side or null rather than "cjk". Astral Han still reaches the CJK font via
// the whole-range fallback in font_mapping_apply_to_doc.js when a surrogate pair
// desyncs the offsets.
function _neutralContextScript(text, i) {
    if (typeof text !== "string") return null;
    var leftScript = null, leftDist = 0, leftDigit = false;
    for (var l = i - 1; l >= 0; l--) {
        var cl = text.charAt(l);
        if (_isCJKChar(cl)) { leftScript = "cjk"; leftDist = i - l; break; }
        if (_isLatinLetter(cl)) { leftScript = "latin"; leftDist = i - l; break; }
        if (cl >= "0" && cl <= "9") leftDigit = true;
    }
    var rightScript = null, rightDist = 0, rightDigit = false;
    var L = text.length;
    for (var r = i + 1; r < L; r++) {
        var cr = text.charAt(r);
        if (_isCJKChar(cr)) { rightScript = "cjk"; rightDist = r - i; break; }
        if (_isLatinLetter(cr)) { rightScript = "latin"; rightDist = r - i; break; }
        if (cr >= "0" && cr <= "9") rightDigit = true;
    }
    if (leftScript && rightScript) {
        if (leftScript === rightScript) return leftScript;
        if (rightDist < leftDist) return rightScript;
        if (leftDist < rightDist) return leftScript;
        // exact distance tie → bind by punctuation direction: an OPENING quote
        // binds to the following (inside) token, every other mark to the
        // preceding one — keeps a quote PAIR on one script.
        var ch = text.charAt(i);
        if (ch === "‘" || ch === "“") return rightScript; // ‘ “ open → inside
        return leftScript;                                          // else → preceding
    }
    if (leftScript || rightScript) return leftScript || rightScript;
    // No letter either side, but a digit is adjacent → follow the digits (Latin):
    // a mark inside a numeric range like "2013-2020" would otherwise orphan
    // full-width among narrow digits.
    if (leftDigit || rightDigit) return "latin";
    return null;
}

// Resolve a neutral punct char to a target script side under `policy`:
//   "skip"    → null    (legacy: enforcer ignores neutral punct entirely)
//   "width"   → "latin" (all narrow/ambiguous neutral punct → Latin; SIMPLE
//                but REGRESSES Simplified-Chinese full-width quotes, which are
//                EAW=Ambiguous and would then render narrow)
//   "context" → follow the nearest script-bearing neighbor (RECOMMENDED)
function _neutralTarget(text, i, policy) {
    if (policy === "width") return "latin";
    if (policy === "context") return _neutralContextScript(text, i);
    return null; // "skip" / unknown
}

// Which script side does a single char want, BEFORE run-outcome gating?
// CJK glyph → "cjk"; the existing Latin set (letters + space + ASCII
// digits/punct, unchanged for back-compat) → "latin"; neutral smart-punct →
// resolved per `neutralPolicy` using `scanText`/`scanIdx` for neighbor context;
// everything else → null (whitespace control / unresolved → cascade).
function _charScriptSide(c, scanText, scanIdx, neutralPolicy) {
    if (_isCJKChar(c)) return "cjk";
    if (_isLatinChar(c)) return "latin";
    if (neutralPolicy !== "skip" && _isNeutralPunct(c)) {
        return _neutralTarget(scanText, scanIdx, neutralPolicy);
    }
    return null;
}

// Classify a fontFamily name as CJK-script-capable. Used by the enforcer
// to decide whether an existing font is "good enough" — a CJK char with
// any CJK family is fine regardless of weight (so we don't stomp Bold
// applied by a prior pass like B1 source emphasis fallback). Conservative
// list — covers families our pipeline produces (SHS fallback + designer
// fonts) plus a few common third-party CJK families. Add as needed;
// misclassifying a CJK font as non-CJK only triggers extra stomps, not
// silent failures.
var CJK_FAMILY_RE = /(Source Han|Noto Sans (?:CJK|SC|TC|KR|JP)|Noto Serif (?:CJK|SC|TC|KR|JP)|MHei|MSung|MKai|STSong|STHeiti|STKaiti|STFangsong|SimSun|SimHei|SimKai|FangSong|YouYuan|LiSong|LiHei|BiauKai|MingLiU|PMingLiU|Microsoft JhengHei|Microsoft YaHei|DFKai|Yu Gothic|Yu Mincho|Hiragino|MS Gothic|MS Mincho|MS PGothic|MS PMincho|Meiryo|Osaka|Apple SD Gothic|Malgun Gothic|Batang|Dotum|Gulim|Gungsuh|Nanum|UD Digi|HGS|HGP)/i;
function _isCJKFamily(family) {
    if (!family) return false;
    return CJK_FAMILY_RE.test(String(family));
}

// Read appliedFont as a stable key (family + style joined). Empty string
// when the font ref can't be read.
function _fontKey(fontRef) {
    if (!fontRef || typeof fontRef === "string") return _safe(fontRef);
    var fam = "", sty = "";
    try { fam = _safe(fontRef.fontFamily); } catch (e) {}
    try { sty = _safe(fontRef.fontStyleName); } catch (e) {}
    return fam + "|" + sty;
}

// Just the family portion of a font key / font ref, for script-class checks.
function _fontFamily(fontRef) {
    if (!fontRef) return "";
    if (typeof fontRef === "string") {
        var s = String(fontRef);
        var p = s.indexOf("|");
        return p >= 0 ? s.substring(0, p) : s;
    }
    try { return _safe(fontRef.fontFamily); } catch (e) { return ""; }
}

// Read effective font on a Character. The .appliedFont property reflects
// the cascade outcome (CS → para style → GREP → direct override).
function _readCharFontRef(ch) {
    try { return ch.appliedFont; } catch (e) { return null; }
}

function _readCharCSName(ch) {
    try {
        var cs = ch.appliedCharacterStyle;
        return cs ? _safe(cs.name) : "";
    } catch (e) { return ""; }
}

function _isDesignerCS(csName) {
    if (!csName) return false;            // [None] or null
    if (csName === "[None]") return false;
    if (csName.indexOf("_T_") === 0) return false;  // pipeline-owned
    return true;
}

/**
 * Discover the paragraph's intended CJK and Latin fonts from its applied
 * paragraph style. CJK font = psStyle.appliedFont (cluster psFont is set
 * to the CJK fallback for mixed-script paragraphs). Latin font = first
 * nested GREP rule whose target CS name starts with `_T_Latin_` (the
 * cluster builder emits exactly one such GREP per cluster). Returns
 * { cjkFontRef, cjkFontKey, latinFontRef, latinFontKey } — any of which
 * may be null when the para style doesn't define that side (e.g. pure
 * Latin clusters with no CJK fallback need no enforcement).
 */
function _paraTargetFonts(para) {
    var out = { cjkFontRef: null, cjkFontKey: "", latinFontRef: null, latinFontKey: "" };
    var ps = null;
    try { ps = para.appliedParagraphStyle; } catch (e) {}
    if (!ps) return out;

    try {
        var psFont = ps.appliedFont;
        out.cjkFontRef = psFont;
        out.cjkFontKey = _fontKey(psFont);
    } catch (e) {}

    try {
        var greps = ps.nestedGrepStyles;
        var n = 0;
        try { n = greps.length; } catch (e) {}
        for (var i = 0; i < n; i++) {
            var g = greps.item(i);
            var targetCs = null;
            try { targetCs = g.appliedCharacterStyle; } catch (eCS) {}
            if (!targetCs) continue;
            var name = "";
            try { name = _safe(targetCs.name); } catch (eN) {}
            if (name.indexOf("_T_Latin_") !== 0) continue;
            var lf = null;
            try { lf = targetCs.appliedFont; } catch (eLF) {}
            if (lf) {
                out.latinFontRef = lf;
                out.latinFontKey = _fontKey(lf);
                break;
            }
        }
    } catch (e) {}

    return out;
}

// Is `curKey` (a "Family|Style" font key) on the preserve list for the
// given script side (cjk=true → CJK side, false → Latin side)?
function _isPreserved(preserve, curKey, cjk) {
    if (!preserve) return false;
    for (var i = 0; i < preserve.length; i++) {
        var e = preserve[i];
        if (e && e.key === curKey && e.cjk === cjk) return true;
    }
    return false;
}

// Tally a non-enforce outcome ("preserved" / "scriptmatch" / "notarget")
// into the matching legacy stat bucket.
function _tallySkip(stats, outcome) {
    if (outcome === "preserved") stats.skippedPreservedFont++;
    else if (outcome === "scriptmatch") stats.skippedScriptMatch++;
    else stats.skippedNoTargets++; // "notarget"
}

// Write one contiguous run [a..b] (para-local char indices) to the target
// font in a SINGLE DOM write. itemByRange takes two Character specifiers
// from the SAME collection (para.characters) so the indices are interpreted
// para-locally — no story-global vs cell-local ambiguity (gate#3/#11). A
// run is the batch unit: collapses N per-char appliedFont writes (InDesign's
// slowest op) into one.
function _flushRun(paraChars, a, b, target, targets, stats) {
    if (b < a) return;
    var ref = (target === "cjk") ? targets.cjkFontRef : targets.latinFontRef;
    var cnt = b - a + 1;
    try {
        var rng = paraChars.itemByRange(paraChars.item(a), paraChars.item(b));
        rng.appliedFont = ref;
        if (target === "cjk") stats.cjkEnforced += cnt;
        else stats.latinEnforced += cnt;
    } catch (e) {
        // Mirror the old per-char loop's error accounting: a failed N-char
        // range write is N failed char writes, not one (callers aggregate
        // stats.errors). codex-audit P3.
        stats.errors += cnt;
    }
}

// Scan one designer-CS run (already snapshotted into `d`) char-by-char by
// SCRIPT CLASS — CS name + current font are uniform across the run (that's
// what defines a TextStyleRange), so the only per-char variable is whether
// the glyph is CJK or Latin. A single run can still mix scripts (CJK+Latin
// under one designer CS, the GREP-doesn't-fire case this pass exists for),
// so we coalesce ONLY contiguous same-target chars and flush each maximal
// same-target stretch as one range write — never feeding Latin chars a CJK
// font or vice versa. `base` is the run's para-local start offset.
function _enforceRun(paraChars, base, d, targets, stats, paraCtx, neutralPolicy) {
    var n = d.len;
    var text = d.text;
    // Aggregate .contents is raw (gate#1: para/range .contents is NOT
    // tag-ized, only Character.contents is), so positions map 1:1 to chars
    // in the common case. If a marker/inline object desyncs the count, fall
    // back to reading each char's contents — correctness over speed for the
    // rare misaligned run.
    var aligned = (typeof text === "string" && text.length === n);

    // Neighbor-context source for neutral-punct resolution (neutralPolicy !==
    // "skip"). Prefer full-paragraph text — neutral marks at a run boundary
    // need the neighbor in the ADJACENT run — falling back to the run's own
    // text (resolves the common in-run case: "don't", "你好") when para text
    // isn't 1:1 aligned, and to none (→ skip) when neither is usable.
    var usePara = !!(paraCtx && paraCtx.aligned && typeof paraCtx.text === "string");
    var scanText = usePara ? paraCtx.text : (aligned ? text : null);
    var scanBase = usePara ? base : 0;

    var runStart = -1, runTarget = null; // "cjk" | "latin" | null
    for (var p = 0; p < n; p++) {
        var c;
        if (aligned) {
            c = text.charAt(p);
        } else {
            try { c = _safe(paraChars.item(base + p).contents); } catch (eR) { c = ""; }
        }

        var side = _charScriptSide(c, scanText, scanBase + p, neutralPolicy);

        var tgt = null;
        if (side === "cjk") {
            if (d.cjkOutcome === "enforce") tgt = "cjk";
            else _tallySkip(stats, d.cjkOutcome);
        } else if (side === "latin") {
            if (d.latinOutcome === "enforce") tgt = "latin";
            else _tallySkip(stats, d.latinOutcome);
        } else {
            // Whitespace / CR / symbols / digits / unresolved neutral punct —
            // cascade handles them.
            stats.skippedNonScriptChar++;
        }

        if (tgt && tgt === runTarget) {
            // extend the current run
        } else {
            if (runTarget) _flushRun(paraChars, base + runStart, base + (p - 1), runTarget, targets, stats);
            runStart = tgt ? p : -1;
            runTarget = tgt;
        }
    }
    if (runTarget) _flushRun(paraChars, base + runStart, base + (n - 1), runTarget, targets, stats);
}

/**
 * For each DESIGNER-CS character run in `para` (CS not [None] and not
 * `_T_*`), force the script-appropriate font as a direct override:
 *   - CJK chars → cjkFontKey
 *   - Latin chars → latinFontKey
 * when the current effective font is wrong-script. Returns stats.
 *
 * The designer-CS gate is intentional: chars under [None] or `_T_*` are
 * already handled correctly by the cluster style (psFont covers CJK,
 * nested GREP covers Latin). Forcing overrides on them would create
 * spurious "+" override flags in the styles panel for no visual gain.
 *
 * PERFORMANCE — why TextStyleRange-batched (was per-char, 6-min hang on
 * a 322-para doc; enforcer-perf branch): a TextStyleRange is a maximal run
 * of uniform character formatting, so appliedCharacterStyle AND appliedFont
 * are CONSTANT across it. The old loop read those two properties (plus
 * .contents) on EVERY character of the full document and wrote appliedFont
 * per char — both O(total chars). Now we:
 *   pass 1 (read-only): one read of CS + font per RUN; skip non-designer
 *     runs (the bulk — naked + `_T_*` text) without touching a single char;
 *   pass 2 (writes): coalesce contiguous same-script-target chars and set
 *     appliedFont once per stretch via para.characters.itemByRange.
 * Writes must NOT happen during pass 1: setting appliedFont re-buckets the
 * textStyleRanges collection, and reading a shifted index mid-iteration
 * hangs InDesign (gate#5). So pass 1 snapshots into a plain JS array; pass 2
 * writes by para-local char index, which appliedFont changes never shift.
 */
function enforceScriptFontsInParagraph(para, enfOpts) {
    // enfOpts (optional, additive — absent = identical legacy behavior). The
    // neutral-punctuation resolver below defaults to "skip" (OFF): the OBSERVED
    // orphaned-punct bug lives in [None] / cluster-GREP-routed runs, which this
    // enforcer does NOT touch (it only fonts designer-CS runs), so that bug is
    // fixed at the cluster Latin GREP + a doc-wide repair pass — NOT here. The
    // "context" resolver (_neutralContextScript / _isNeutralPunct) is retained
    // because the repair pass reuses it, and for the (currently unobserved)
    // designer-CS neutral-punct case; callers opt in explicitly.
    //   preserve: [{ key: "Family|Style", cjk: bool }] — skip enforcement on
    //     chars whose current font matches `key` AND whose script class
    //     matches `cjk`. Used by the post-facade enforcer pass (M3/M4/M5) so
    //     byPair-swept fonts are never reverted. Same-script swaps are
    //     already protected by the script-match skip below; this covers the
    //     residual edge where a CJK→CJK swap lands on a family OUTSIDE the
    //     CJK_FAMILIES exact-match list (curIsCJK misreads as wrong-script
    //     → would re-assert psFont and revert the swap). Scoping by script
    //     class keeps the tofu-fix intact: a CJK char organically carrying
    //     a Latin byPair dstFont still gets enforced (cjk flag mismatch).
    //   neutralPolicy: "skip" (default) | "context" | "width" — how to font
    //     neutral "smart punctuation" (curly quotes / dashes / ellipsis) that is
    //     neither CJK nor Latin (see _isNeutralPunct). Default "skip" = exact
    //     pre-fix legacy behavior (enforcer never touches neutral punct). The
    //     observed orphaned-punct bug is NOT in this enforcer's scope (it's in
    //     [None] / cluster-GREP-routed runs) → fixed via the cluster Latin GREP
    //     + a doc-wide repair pass. "context" (opt-in) follows the nearest
    //     script-bearing neighbor — French apostrophe between Latin → Latin;
    //     SC full-width quote between Han → stays CJK (no narrow-quote
    //     regression); it is the engine the repair pass reuses, and covers the
    //     unobserved designer-CS neutral-punct case. "width" (opt-in) sends all
    //     neutral punct to Latin (narrows SC quotes — avoid; kept for parity).
    enfOpts = enfOpts || {};
    var preserve = Array.isArray(enfOpts.preserve) ? enfOpts.preserve : null;
    var neutralPolicy = (enfOpts.neutralPolicy === "context" || enfOpts.neutralPolicy === "width")
        ? enfOpts.neutralPolicy : "skip";
    var stats = {
        examined: 0,
        cjkEnforced: 0,
        latinEnforced: 0,
        skippedNoTargets: 0,
        skippedNoDesignerCS: 0,
        skippedScriptMatch: 0,
        skippedNonScriptChar: 0,
        skippedPreservedFont: 0,
        errors: 0
    };
    if (!para) return stats;

    var targets = _paraTargetFonts(para);
    // Nothing to enforce when we can't resolve at least one side.
    if (!targets.cjkFontKey && !targets.latinFontKey) {
        stats.skippedNoTargets = 1;
        return stats;
    }
    var hasCjk = !!(targets.cjkFontKey && targets.cjkFontRef);
    var hasLatin = !!(targets.latinFontKey && targets.latinFontRef);

    // ── Pass 1: read-only snapshot of textStyleRanges ──
    var tsrCol;
    try { tsrCol = para.textStyleRanges; } catch (e) { return stats; }
    var m = 0;
    try { m = tsrCol.length; } catch (e) { m = 0; }
    if (!m) return stats;

    var snap = [];
    for (var k = 0; k < m; k++) {
        var t;
        try { t = tsrCol.item(k); } catch (eT) {
            // Can't read this run → its true length is unknown. Pass-2 derives
            // every write base from the running sum of snap[].len, so recording
            // a wrong (0) length here would shift EVERY later run's writes left
            // onto the wrong characters (silent wrong-font). Stop snapshotting:
            // runs [0..k-1] keep correct offsets and still get enforced; the
            // unreadable run + everything after it is left untouched. Under-
            // enforce, never mis-write. codex-audit P2.
            stats.errors++;
            break;
        }
        // -1 sentinel distinguishes a length READ FAILURE (offset desync risk →
        // stop) from a legitimately empty run (len===0 → safe to skip & go on).
        var len = -1;
        try { len = t.characters.length; } catch (eL) { len = -1; }
        if (len < 0) { stats.errors++; break; }
        if (!len) { snap.push({ len: 0 }); continue; }

        // CS name is uniform across the run.
        var csName = _readCharCSName(t);
        if (!_isDesignerCS(csName)) { snap.push({ len: len, designer: false }); continue; }

        // Current effective font is uniform across the run.
        var curRef = _readCharFontRef(t);
        var curFam = _fontFamily(curRef);
        var curKey = _fontKey(curRef);
        var curIsCJK = _isCJKFamily(curFam);

        // Per-script outcome for THIS run — same decision the legacy per-char
        // loop made, hoisted to run scope since every input is run-uniform:
        //   - notarget   : that side has no resolvable font
        //   - preserved  : current font is a protected byPair-swept font
        //   - scriptmatch : current font already in the correct script class
        //   - enforce    : wrong-script → write the target font
        var cjkOutcome = !hasCjk ? "notarget"
            : _isPreserved(preserve, curKey, true) ? "preserved"
            : curIsCJK ? "scriptmatch"
            : "enforce";
        var latinOutcome = !hasLatin ? "notarget"
            : _isPreserved(preserve, curKey, false) ? "preserved"
            : (!curIsCJK && curFam) ? "scriptmatch"
            : "enforce";

        // Read the run's text (raw aggregate contents) for the script scan.
        var text = null;
        try { text = _safe(t.contents); } catch (eC) { stats.errors++; }

        snap.push({
            len: len, designer: true,
            cjkOutcome: cjkOutcome, latinOutcome: latinOutcome, text: text
        });
    }

    // Full-paragraph neighbor context for neutral-punct resolution. Only read
    // para.contents when (a) the policy is "context" (it alone consults neighbor
    // text — "width" returns "latin" without it, "skip" does nothing) AND (b) the
    // paragraph actually has ≥1 designer-CS run — neutral punct is only ever
    // enforced inside designer runs, so the bulk of paragraphs (naked + `_T_*`
    // only) skip this extra DOM read entirely (keeps the hot v2_pipeline path
    // cheap). Raw aggregate (gate#1: para.contents is NOT tag-ized) so it maps 1:1
    // to para.characters in the common case; `aligned` gates use so a marker /
    // inline-object desync can't shift neighbor lookups.
    var paraCtx = null;
    if (neutralPolicy === "context") {
        var hasDesigner = false;
        for (var di = 0; di < snap.length; di++) {
            if (snap[di].designer) { hasDesigner = true; break; }
        }
        if (hasDesigner) {
            var paraText = null;
            try { paraText = _safe(para.contents); } catch (ePT) { paraText = null; }
            var totalChars = 0;
            for (var tci = 0; tci < snap.length; tci++) totalChars += (snap[tci].len || 0);
            paraCtx = { text: paraText, aligned: (typeof paraText === "string" && paraText.length === totalChars) };
        }
    }

    // ── Pass 2: writes against para.characters (stable indices) ──
    var paraChars;
    try { paraChars = para.characters; } catch (e) { return stats; }

    var offset = 0;
    for (var s = 0; s < snap.length; s++) {
        var d = snap[s];
        var base = offset;
        offset += d.len;
        if (!d.len) continue;
        stats.examined += d.len;
        if (!d.designer) { stats.skippedNoDesignerCS += d.len; continue; }
        _enforceRun(paraChars, base, d, targets, stats, paraCtx, neutralPolicy);
    }
    return stats;
}

// ---------------------------------------------------------------------------
// isCJKFamilyName — exact-match CJK family predicate
// ---------------------------------------------------------------------------
// Used by Phase 8D-ext-0 doc_scan + D4 eligibility check. Returns true iff
// `familyStr` (a Font family without style suffix; result of
// readTsrFontFamilyStyle().family) exactly matches a known CJK family name.
//
// Exact match (no partial / substring) prevents false-positive on families
// containing CJK terms as substrings (e.g. "Whitney" doesn't match).
//
// List covers ~20 most common CJK families across Adobe, Google, Apple,
// Microsoft, system + open-source fonts. Extend on a per-doc basis if needed.
var CJK_FAMILIES = [
    // Adobe Source Han
    "Source Han Sans CN", "Source Han Sans TC", "Source Han Sans HW",
    "Source Han Sans JP", "Source Han Sans KR",
    "Source Han Serif CN", "Source Han Serif TC", "Source Han Serif JP",
    "Source Han Serif KR",
    // Google Noto
    "Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK JP", "Noto Sans CJK KR",
    "Noto Sans SC", "Noto Sans TC", "Noto Sans JP", "Noto Sans KR",
    "Noto Serif CJK SC", "Noto Serif CJK TC", "Noto Serif CJK JP", "Noto Serif CJK KR",
    "Noto Serif SC", "Noto Serif TC", "Noto Serif JP", "Noto Serif KR",
    // Apple
    "PingFang SC", "PingFang TC", "PingFang HK",
    "Hiragino Sans", "Hiragino Sans GB", "Hiragino Mincho ProN",
    "Heiti SC", "Heiti TC",
    "Apple SD Gothic Neo",
    "STSong", "STHeiti", "STKaiti", "STFangsong",
    // Microsoft
    "SimSun", "SimHei", "SimSun-ExtB", "NSimSun", "SimKai",
    "Microsoft YaHei", "Microsoft JhengHei", "Microsoft YaHei UI",
    "Yu Gothic", "Yu Gothic UI", "Yu Mincho",
    "Meiryo", "Meiryo UI",
    "MS Gothic", "MS Mincho", "MS PGothic", "MS PMincho",
    "Malgun Gothic", "Gulim", "Batang", "Dotum", "Gungsuh", "Nanum",
    // FZ / DynaFont / Monotype / commercial CJK
    "FZSongTi", "FZHeiTi", "FZKaiTi",
    "DFKai-SB", "DFKai",
    // MHei / MSung / MKai (Monotype CJK; codex r1 P1-6: MHei PRC was missing)
    "MHei PRC", "MHei TC", "MHei", "MHei Std",
    "MSung PRC", "MSung TC", "MSung", "MSung Std",
    "MKai PRC", "MKai TC", "MKai", "MKai Std",
    // Other commercial CJK seen in real docs
    "LiSong", "LiHei", "BiauKai",
    "MingLiU", "PMingLiU",
    "FangSong", "YouYuan",
    "HGS", "UD Digi", "Osaka"
];

var CJK_FAMILY_SET = {};
(function () {
    for (var i = 0; i < CJK_FAMILIES.length; i++) {
        CJK_FAMILY_SET[CJK_FAMILIES[i]] = true;
    }
})();

function isCJKFamilyName(familyStr) {
    if (!familyStr || typeof familyStr !== "string") return false;
    return CJK_FAMILY_SET.hasOwnProperty(familyStr);
}

// (Removed isCJKFontFamily / CJK_FAMILY_EXTRA_RE: the GREP-repair metric no longer
// enumerates CJK families — it compares a neutral mark's font to its Latin letter
// neighbor's font instead, which is font-name-agnostic and ended the family-regex
// over/under-match ping-pong. See repair_cluster_grep.idjs countOrphans.)

// Robust ParagraphStyle.appliedFont → family-string extraction (codex r1 P1-6).
// Mirrors lib_font_doc_scan.readTsrFontFamilyStyle:
//   - String form "Family\tStyle" → split
//   - Font object → try .name (preferred; reliable across UXP), tab-split
//   - Last-ditch → try .fontFamily property directly
function _readPsFontFamily(ps) {
    try {
        var f = ps.appliedFont;
        if (typeof f === "string") {
            return f.split("\t")[0] || "";
        }
        if (!f) return "";
        var n = "";
        try { n = String(f.name); } catch (eN) { n = ""; }
        if (n) return n.split("\t")[0] || "";
        try { return String(f.fontFamily); } catch (eFF) { return ""; }
    } catch (e) { return ""; }
}

// ---------------------------------------------------------------------------
// detectEnforcerEligibility — D4 same-style co-requirement check
// ---------------------------------------------------------------------------
// Per task_plan 8D-ext-0 D4 + codex r4/r5 fix:
//   - enumerate doc.allParagraphStyles (含 grouped styles)
//   - find ≥1 style satisfying BOTH:
//       (a) nestedGrepStyles[] has rule with appliedCharacterStyle.name
//           starting with "_T_Latin_"
//       (b) appliedFont (Font.name tab-split → family[0]) matches CJK predicate
//
// Returns { eligible, reasons: [...] } — reasons list specific failures
// when not eligible (panel can show in tooltip).
function detectEnforcerEligibility(doc) {
    var result = { eligible: false, reasons: [] };
    if (!doc) {
        result.reasons.push("no doc");
        return result;
    }
    var styles;
    try { styles = doc.allParagraphStyles; }
    catch (e) {
        result.reasons.push("cannot access allParagraphStyles: " + (e.message || e));
        return result;
    }
    var n;
    try { n = styles.length; } catch (e) { n = 0; }
    if (!n) {
        result.reasons.push("no paragraph styles");
        return result;
    }

    // UXP gotcha: doc.allParagraphStyles returns a JS Array (43-item native
    // Array), NOT an InDesign collection. Use [i] indexing instead of .item(i).
    // Verified 2026-06-09 against pipeline-output translated.indd.
    var sawLatinGREP = false;
    var sawCJKpsFont = false;
    for (var i = 0; i < n; i++) {
        var ps;
        try { ps = styles[i]; } catch (e) { continue; }
        if (!ps) continue;

        // Check psFont = CJK family.
        // Codex r1 P1-6 fix: ParagraphStyle.appliedFont can return either a
        // Font object or a "Family\tStyle" string (same convention as TSR
        // appliedFont — see lib_font_doc_scan.readTsrFontFamilyStyle). Use
        // the same robust extraction.
        var psFontFamily = _readPsFontFamily(ps);
        var thisStyleCJK = isCJKFamilyName(psFontFamily);

        // Check nestedGrepStyles[].appliedCharacterStyle.name starts "_T_Latin_"
        var thisStyleHasLatinGREP = false;
        try {
            var greps = ps.nestedGrepStyles;
            var gn = 0;
            try { gn = greps.length; } catch (eGl) {}
            for (var j = 0; j < gn; j++) {
                var g = greps.item(j);
                var targetCs = null;
                try { targetCs = g.appliedCharacterStyle; } catch (eCS) {}
                if (!targetCs) continue;
                var csName = "";
                try { csName = String(targetCs.name); } catch (eN) {}
                if (csName.indexOf("_T_Latin_") === 0) {
                    thisStyleHasLatinGREP = true;
                    break;
                }
            }
        } catch (eG) {}

        if (thisStyleCJK) sawCJKpsFont = true;
        if (thisStyleHasLatinGREP) sawLatinGREP = true;

        // Single-style co-requirement: BOTH within ONE style
        if (thisStyleCJK && thisStyleHasLatinGREP) {
            result.eligible = true;
            return result;
        }
    }

    if (!sawLatinGREP) result.reasons.push("no paragraph style has _T_Latin_* nested CS");
    if (!sawCJKpsFont) result.reasons.push("no paragraph style has CJK psFont");
    if (sawLatinGREP && sawCJKpsFont) {
        result.reasons.push("_T_Latin_* and CJK psFont appear in DIFFERENT styles — enforcer needs same style");
    }
    return result;
}

module.exports = {
    enforceScriptFontsInParagraph: enforceScriptFontsInParagraph,
    isCJKFamilyName: isCJKFamilyName,
    detectEnforcerEligibility: detectEnforcerEligibility,
    // exposed for tests
    _isCJKChar: _isCJKChar,
    _isLatinChar: _isLatinChar,
    _isNeutralPunct: _isNeutralPunct,
    _isLatinLetter: _isLatinLetter,
    _neutralContextScript: _neutralContextScript,
    _neutralTarget: _neutralTarget,
    _charScriptSide: _charScriptSide,
    _isDesignerCS: _isDesignerCS,
    _paraTargetFonts: _paraTargetFonts,
    _CJK_FAMILIES: CJK_FAMILIES
};
