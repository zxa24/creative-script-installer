/**
 * font_identity_groups.js — TODO#58 ①: deterministic identity grouping.
 *
 * owner 2026-08-20: 「不应该是确定的方法用于判断它们是绝对一致的再合并吗，而不是
 * 靠表面的名称」. Two spellings are merged ONLY when the font engine reports the
 * same face for both. No alias table, no normalized-name key, no spelling
 * heuristics anywhere in this module.
 *
 * 🪦 REPLACES two name-heuristic mergers (see TODO#58):
 *   - doc_scan's A4 auto batch      (canonicalKey = lowercase+despace)
 *   - A.1 recombination candidates  (normalize() + STYLE_ALIAS_TABLE)
 * Both could pair genuinely different faces (`Bold` ≡ `Semibold` sat in one alias
 * class) while missing the case owner actually cares about (`Semibold` vs
 * `Semibold Regular` matched no table entry at all). The alias table survives for
 * diagnostics; it is no longer a merge criterion.
 *
 * IDENTITY = `Font.postscriptName`, measured (panelfix 2026-08-20, DEV_LOG):
 *   Source Han Sans CN Regular/Normal → both "SourceHanSansCN-Normal"  (same face)
 *   Gotham Book/Regular               → both "Gotham-Book"             (same face)
 *   Segoe UI Bold/Semibold            → "SegoeUI-Bold" / "-Semibold"   (CONTROL: different)
 *
 * 🔴 THE GUARD THAT MAKES IT SAFE — measured, not assumed: two unrelated
 * NOT_AVAILABLE faces BOTH report `postscriptName: ""` and do NOT throw, and both
 * report `isValid: true`. A bare equality test therefore merges two fonts that
 * have nothing to do with each other. So identity requires ALL THREE:
 *     status === "INSTALLED"  ∧  postscriptName non-empty  ∧  equal
 * Anything else FAILS CLOSED: the entry stays independent and is counted in
 * `skipped` so "not merged because not installed" is reportable, never silent
 * (owner: 不接受悄悄少合了).
 *
 * ⚠ `location` is deliberately NOT part of identity. Measured: Adobe Fonts
 * activated faces return the constant string "Added from Adobe Fonts" rather than
 * a path, so it cannot discriminate (Gotham-Book and SourceHanSansCN-Normal share
 * it), and it throws outright for NOT_AVAILABLE.
 *
 * 🔴 WHAT THIS DELIBERATELY CANNOT DO (TODO#58 ⑥ — owner-ruled, not a gap to fix)
 *
 * "Two genuinely DIFFERENT faces that the design wants treated as one." A
 * deterministic identity criterion can never prove that — the fonts really are
 * different, and no amount of probing will say otherwise. So this module will
 * never produce such a group.
 *
 * 🔴 AND TODAY THERE IS NO OTHER WAY TO PRODUCE ONE EITHER. (audit R3,
 * corrected 2026-08-20 — an earlier revision of this note claimed the operator
 * could do it by hand via drag + `applyMerge`, and that "it renders as a real
 * group row with `unmergeAll` behind it, visible and reversible by construction".
 * All three claims are FALSE for `equivalence_groups`. Verified in code, twice,
 * independently:
 *   - `app.jsx applyMerge(fontId, dragId, targetId)` works inside ONE font card
 *     (`findFont(d, fontId)`) and writes `font.merges` — a weight grouping within
 *     that one family. It never writes an equivalence_group.
 *   - the drop gate only offers 'merge' when `sameFont` (app.jsx:718-719), so a
 *     CROSS-FAMILY drag cannot even be started.
 *   - `panelDataToConfig` builds `config.equivalence_groups` from
 *     `panelData.equivalence_groups` alone (adapter:130); `font.merges` is read
 *     only to resolve a pair member to its representative (adapter:455).
 *   - `configToPanelData` rebuilds every font with `merges: []` (adapter:602), so
 *     even in-panel merges do not survive a round trip.
 * `unmergeAll(fontId, mergeId)` likewise unmerges a `font.merges` group, not an eg.)
 *
 * ⇒ THE HONEST STATEMENT: cross-family equivalence — "these two different faces
 * are one thing" — has NO route in the panel at all right now. Not automatic, not
 * manual. Configs that contain such a group (hand-written, or produced by the
 * retired A.1 name heuristic) are still READ and honoured everywhere downstream;
 * what is missing is a way to CREATE one.
 *
 * ⚠ Do not add that capability here because this note used to promise it.
 *
 * 🔴 AND IT IS NOT OPEN ANY MORE — owner ruled 2026-08-20 (姿态甲, "the machine
 * decides"): no manual override path is to be built. That makes "no route to
 * declare two different faces equivalent" a DECIDED TRADE-OFF, not an omission.
 * The reasoning owner gave was about the other direction —
 * 「目前确定合并的都肯定是应该被合并的吗，有没有误合并的可能性」— i.e. an override
 * only earns its place once the criterion is shown to be wrong, and it has not been.
 * ⇒ If you are here because a config needs such a group: that is a NEW owner
 * decision, not a gap to quietly fill. (Same failure mode as #54ⓒ's two
 * consequence sentences: a later reader "restored" what an owner had removed.)
 *
 * ⚠ Do NOT "improve" this module by adding a similarity fallback for that case.
 * That is how the alias table got here in the first place, and owner retired it:
 * 「不应该是确定的方法用于判断它们是绝对一致的再合并吗，而不是靠表面的名称」.
 * Automatic merging covers "same face, two spellings" and nothing else, ON PURPOSE.
 *
 * This module is PURE: the caller injects `identityOf`, so it is testable in Node
 * with no InDesign. The host binding must resolve identity from the (family,
 * style) STRINGS via app.fonts.itemByName — never from a TSR's Font object, which
 * is the accessor font_mapping_doc_scan's "MVP detail #1" documents as throwing.
 */

var SEP = "␟"; // same separator convention as the rest of the panel libs

// ---------------------------------------------------------------------------
// 🔴 THE CANONICAL IS A MEMBER OF ITS OWN GROUP.  (audit R1, 2026-08-20)
// ---------------------------------------------------------------------------
// Everything below that asks "does this group contain (font, weight)?" goes
// through `egHolds`, and every list of "what this group claims" comes from
// `egMembers`. There is deliberately no second way to ask.
//
// MEASURED, before the fix (three audit voices converged; reproduced here):
//   existing (operator) {canonical: Operator Canon, merged_in: [Gotham/Book]}
//   proposed            {canonical: Gotham/Book,    merged_in: [Gotham/Regular]}
//   -> the rival group was ADDED, `blockedByOperator` was [], `findOverlaps` was []
//   -> and `findEquivalenceGroup(Gotham/Book)` answered "Operator Canon" while the
//      SAME array reversed answered "Gotham/Book"
// i.e. the function produced exactly the order-dependent state its own header
// says it exists to prevent, and BOTH counters reported zero while doing it.
//
// Root cause was a split concept: `findEquivalenceGroup` (font_mapping_pairs.js)
// matches `eg.canonical` FIRST and then `merged_in` — so downstream, the canonical
// IS a member — while this module only ever iterated `merged_in`. The guards
// therefore protected the members and left the canonical bare.
//
// ⚠ Do not "optimise" egHolds back into an inline `merged_in.some(...)`. That is
// the shape the defect had.
function _sameMember(a, b) {
    return !!a && !!b && a.font === b.font && a.weight === b.weight;
}

// Every (font, weight) a group claims — CANONICAL FIRST, then merged_in.
function egMembers(eg) {
    var out = [];
    if (!eg) return out;
    if (eg.canonical) out.push({ font: eg.canonical.font, weight: eg.canonical.weight });
    var mi = eg.merged_in || [];
    for (var i = 0; i < mi.length; i++) {
        if (mi[i]) out.push({ font: mi[i].font, weight: mi[i].weight });
    }
    return out;
}

// SWEEP RESULT (audit R1 asked for the whole concept, not the two named spots).
// Every production site that answers "is (font, weight) a member of this group",
// checked 2026-08-20:
//   ✅ ALREADY CORRECT — no change needed
//      font_mapping_pairs.findEquivalenceGroup   canonical matched FIRST, then
//                                                merged_in (this is the reference)
//      font_mapping_pairs.getCanonical           iterates merged_in and falls
//                                                through to (font,weight) itself,
//                                                so a canonical resolves to itself
//      font_mapping_pairs.buildCjkWeightMap      expands canonical AND merged_in
//      app.jsx _applyIdentityGroupsTo            _ensureFontInLang for both
//      app.jsx autoMerged (review strip)         [canonical].concat(merged_in)
//      app.jsx MM commit + auto-unmerge effects  test canonical separately
//   🔴 FIXED HERE — applyIdentityGroups' gates and findOverlaps
//   ⚠ EXCLUDES THE CANONICAL ON PURPOSE — do NOT "fix" these:
//      font_mapping_pairs validateBrandConfig II-d (`mergedInIndex`, :65-73)
//        indexes merged_in only. A weight that is BOTH an MM member and an eg
//        merged_in is contradictory ("absorbed into the canonical" vs "a member in
//        its own right"). A weight that is the eg's CANONICAL is not: it stays
//        addressable and visible. Flagging it would reject valid configs.
//      data.jsx egFoldedWeightSet
//        never folds the canonical, and says so — otherwise the whole font card
//        could disappear from the tree.
// (font_mapping_ops.js also iterates merged_in, and is PRODUCTION-DEAD — only
// tests require it. Left alone; see the note on applyIdentityGroups.)
function egHolds(eg, m) {
    var all = egMembers(eg);
    for (var i = 0; i < all.length; i++) if (_sameMember(all[i], m)) return true;
    return false;
}

// 🔴 Lang is compared NORMALIZED (audit R4). `getCanonical` and
// `findEquivalenceGroup` both run `normalizeBcp47Identity` on BOTH sides, so
// downstream `zh-Hans-CN` and `zh-CN` are one language — while every gate in this
// module compared the raw strings. MEASURED: an existing `zh-Hans-CN` group and a
// proposed `zh-CN` group for the same face produced a rival group with both
// counters at 0. (font_mapping_panel_adapter.js:517-525 already carries lang
// spelling collision as a known deferred item; this change is what made it start
// deciding merges, so it is fixed here rather than deferred with it.)
//
// The normalizer is a pure leaf (no host, no other requires), so this module stays
// Node-testable. If it ever cannot be loaded we fall back to a raw compare — that
// is strictly the old behaviour, never something looser.
var _langNorm = null;
try { _langNorm = require("./lang_script_table.js").normalizeBcp47Identity; }
catch (eLang) { _langNorm = null; }
function langKey(l) { return _langNorm ? _langNorm(l) : String(l == null ? "" : l); }
function sameLang(a, b) { return langKey(a) === langKey(b); }

// ---------------------------------------------------------------------------
// TODO#58 — does this look like an ANSWER, or like the engine failing to give one?
// ---------------------------------------------------------------------------
// 🔴 NOT a defensive heuristic — and the difference matters, because a heuristic
// is something a later reader feels free to relax.
//
// **owner 2026-08-20** (findings.md:3001), on why the whole merge criterion was
// replaced: 「不应该是确定的方法用于判断它们是绝对一致的再合并吗，而不是靠表面的名称」
// ⇒ `postscriptName` is not one signal among several: it IS the determinate proof
//   the criterion rests on.
// 🔴 So a face reporting `"_-"` is **the load-bearing evidence failing in that slot**.
//   It cannot prove 「绝对一致」 ⇒ by owner's own principle it must not merge.
//   Empty postscriptName was always treated that way; this closes the case where the
//   engine hands back a placeholder instead of nothing — the same failure wearing a
//   non-empty disguise.
//
// MEASURED (panelfix 2026-08-22, probes/20260822_08_psname_degenerate.idjs):
//     PingFang SC / Regular  status=INSTALLED
//         fontFamily "PingFang SC"  fontStyleName "Regular"   ← catalogue identity intact
//         🔴 postscriptName "_-"   fullName "_-"            ← BOTH name fields degenerate
// The read is not at fault: the probe read the raw host attribute with no repo code
// in the path, and TWO independent attributes agree. So the value comes from the host.
//
// 🔴 Why it matters: `"_-"` is NON-EMPTY, so it passed the old gate — and two faces
// that both report it would be judged THE SAME FACE. That is exactly the disaster #58
// exists to prevent, entering through the back door of "non-empty".
//
// ⚠ On this machine only ONE such face is installed, so a collision CANNOT occur
// here — "no collision observed" is a weak negative (the conditions are absent, the
// code is not proven safe). But the cause looks like a CLASS, not a one-off: a font
// registered in the catalogue whose name tables cannot be read. A machine with several
// such stubs would have them all report `"_-"`.
// ⇒ Because it cannot be produced here, tests/font_identity_groups_tests.js carries a
//   SYNTHETIC fixture for it. An untriggerable gate is an unverified gate (CLAUDE #28).
//
// Failure direction is deliberately conservative: unsure ⇒ DO NOT merge.
function looksLikeAnAnswer(ps) {
    return typeof ps === "string" && /[A-Za-z]/.test(ps);
}

// ---------------------------------------------------------------------------
// canonical selection (TODO#58 ④)
// ---------------------------------------------------------------------------
// Two tiers, in order:
//   1. the font's OWN reported identity (fontFamily + fontStyleName) — the name
//      the face calls itself, rather than one of the document's spellings picked
//      by us — but ONLY if the document actually uses that spelling;
//   2. otherwise the observed spelling with the highest usage count, ties broken
//      alphabetically so the output is deterministic.
//
// 🔴 Tier 1 is gated on "is observed" for a hard reason, not tidiness:
// validateBrandConfig rejects an eg whose canonical (or any merged_in) is absent
// from fonts_by_language ("canonical references font not in fonts_by_language").
// Emitting the face's self-name when the document never used it would produce a
// config that fails its own validator. The retired confirmMerge hit exactly this
// class of bug by never calling _ensureFontInLang.
function pickCanonical(members, identity) {
    var self = null;
    if (identity && identity.selfFamily && identity.selfStyle) {
        for (var i = 0; i < members.length; i++) {
            if (members[i].family === identity.selfFamily &&
                members[i].style === identity.selfStyle) {
                self = members[i];
                break;
            }
        }
    }
    if (self) return self;

    var best = null;
    for (var j = 0; j < members.length; j++) {
        var m = members[j];
        if (!best) { best = m; continue; }
        var mc = m.count || 0, bc = best.count || 0;
        if (mc > bc) { best = m; continue; }
        if (mc < bc) continue;
        // deterministic tiebreak — never leave output dependent on input order
        if (m.family < best.family) { best = m; continue; }
        if (m.family > best.family) continue;
        if (m.style < best.style) best = m;
    }
    return best;
}

// ---------------------------------------------------------------------------
// buildIdentityGroups
// ---------------------------------------------------------------------------
// entries    : [{ family, style, lang, count }]  — spellings actually in play
// identityOf : (family, style) → { status, postscriptName, selfFamily?, selfStyle? }
//              May throw or return null; both are treated as "unknown" ⇒ skipped.
// returns    : { groups: [eg], skipped: [{ family, style, lang, reason }],
//                skippedCounts: { notInstalled, noPostscriptName, lookupFailed } }
//
// An eg is emitted only for a bucket holding ≥2 DISTINCT spellings. Buckets are
// keyed by (lang, postscriptName): eg carries a single `lang`, and two entries
// whose home languages differ are not one group even if the face is identical.
function buildIdentityGroups(entries, identityOf, opts) {
    opts = opts || {};
    var groups = [];
    var skipped = [];
    var counts = { notInstalled: 0, noPostscriptName: 0, lookupFailed: 0 };
    var buckets = {};
    var order = [];   // preserve first-seen bucket order for stable output

    for (var i = 0; i < (entries || []).length; i++) {
        var e = entries[i];
        if (!e || !e.family) continue;
        var id = null;
        try {
            id = identityOf(e.family, e.style);
        } catch (eLookup) {
            id = null;
        }
        if (!id) {
            counts.lookupFailed++;
            skipped.push({ family: e.family, style: e.style, lang: e.lang, reason: "lookup-failed" });
            continue;
        }
        if (String(id.status) !== "INSTALLED") {
            counts.notInstalled++;
            skipped.push({ family: e.family, style: e.style, lang: e.lang, reason: "not-installed" });
            continue;
        }
        var ps = id.postscriptName ? String(id.postscriptName) : "";
        if (!looksLikeAnAnswer(ps)) {
            // measured: NOT_AVAILABLE faces return "" without throwing, so an
            // empty name must never be allowed to match another empty name
            // — and the same applies to a placeholder like "_-".
            //
            // 🔴 The two are NOT the same event and the record says which:
            //   ""    the engine returned nothing
            //   "_-"  the engine returned SOMETHING THAT IS NOT AN ANSWER
            // Collapsing them would hide the second behind a reason that reads
            // "there was no name" — and there was one, it just meant nothing.
            // The observed value is carried so it is never silently swallowed.
            //
            // ⚠ Both still increment the SAME counter: `#58` ⑤ settled five
            // counters with no rollup, and adding a sixth would change a contract
            // owner signed off. The distinction lives in `skipped[]`, which is the
            // detail list — where a reader who cares can see it.
            counts.noPostscriptName++;
            skipped.push({
                family: e.family, style: e.style, lang: e.lang,
                reason: ps ? "postscript-name-not-an-answer" : "no-postscript-name",
                observed: ps
            });
            continue;
        }
        var lang = e.lang || "en";
        var key = lang + SEP + ps;
        if (!buckets[key]) {
            buckets[key] = { lang: lang, ps: ps, identity: id, members: [] };
            order.push(key);
        }
        var b = buckets[key];
        var dup = false;
        for (var d = 0; d < b.members.length; d++) {
            if (b.members[d].family === e.family && b.members[d].style === e.style) { dup = true; break; }
        }
        if (!dup) {
            b.members.push({ family: e.family, style: e.style, count: e.count || 0 });
        }
    }

    for (var k = 0; k < order.length; k++) {
        var bucket = buckets[order[k]];
        if (bucket.members.length < 2) continue;   // one spelling = nothing to merge
        var canon = pickCanonical(bucket.members, bucket.identity);
        var mergedIn = [];
        for (var mi = 0; mi < bucket.members.length; mi++) {
            var mem = bucket.members[mi];
            if (mem.family === canon.family && mem.style === canon.style) continue;
            mergedIn.push({ font: mem.family, weight: mem.style });
        }
        groups.push({
            lang: bucket.lang,
            canonical: { font: canon.family, weight: canon.style },
            merged_in: mergedIn,
            // TODO#58 ②: created by the machine without asking ⇒ the machine may
            // retract it. Session-only; stripped at export.
            _origin: "machine-auto"
        });
    }

    return { groups: groups, skipped: skipped, skippedCounts: counts };
}

// ---------------------------------------------------------------------------
// applyIdentityGroups (TODO#58 ③) — the single write entry point
// ---------------------------------------------------------------------------
// 🔴 THE INVARIANT: a given (lang, font, weight) belongs to AT MOST ONE eg.
// Measured why (panelfix 2026-08-20): getCanonical / findEquivalenceGroup return
// the FIRST matching eg in array order — reversing the array changed the answer
// from A|Book to Z|Regular for the same member. Overlapping groups therefore do
// not merely look untidy, they make resolution ARBITRARY, and validateBrandConfig
// did NOT reject them at the time (measured: ok:true, zero errors, on exactly that
// state). ⚠ NO LONGER TRUE (audit round 5, 2026-08-20): validateBrandConfig NOW REJECTS an overlapping equivalence-group set outright. The reading below was correct when it was written and is kept because it is WHY the invariant exists — but do not use it to argue that nothing downstream catches an overlap, because something does.
// Nothing downstream will catch it, so it has to be prevented here.
//
// ⚠ The rule below is COPIED from font_mapping_ops.mergeWeights ("如果某 mergedIn
// 项已在另一 group 里，先从那 group 移除"), NOT delegated to it. That module is
// PRODUCTION-DEAD: verified by grep — only tests require() it; its three mentions
// in production files are comments ("twin of", "orthogonal to"). arch mis-cited it
// as live code once already (TODO#44 carries the correction). Do not "simplify"
// this by calling into it.
//
// 🔴 ASYMMETRY, same one as _isMachineAuto: we re-parent members out of OUR OWN
// groups only. A member claimed by an eg the operator authored or a config file
// supplied is LEFT ALONE and reported in `blockedByOperator` — silently rewriting
// it would violate config authority (design-intent §8), and stealing it would be
// the machine overruling a human decision it cannot even see the reason for.
function applyIdentityGroups(existingEgs, groups) {
    var egs = (existingEgs || []).slice();
    var added = [], extended = [], reparented = [], blockedByOperator = [];
    var isOurs = function (eg) { return !!(eg && eg._origin === "machine-auto"); };

    for (var g = 0; g < (groups || []).length; g++) {
        var grp = groups[g];
        if (!grp || !grp.canonical) continue;
        var lang = grp.lang;
        var canonMem = { font: grp.canonical.font, weight: grp.canonical.weight };

        // Everything this proposal claims. 🔴 The canonical is in here, which
        // is the whole point of audit R1 — it is a member like any other.
        var wanted = [canonMem];
        var proposed = grp.merged_in || [];
        for (var w = 0; w < proposed.length; w++) {
            var pm = proposed[w];
            if (!pm) continue;
            var dup = false;
            for (var w2 = 0; w2 < wanted.length; w2++) if (_sameMember(wanted[w2], pm)) { dup = true; break; }
            if (!dup) wanted.push({ font: pm.font, weight: pm.weight });
        }

        // -- A. an eg WE DID NOT MAKE outranks us, whatever it holds -----------
        // 🔴 "Holds" now means canonical OR merged_in. Previously a group whose
        // canonical the operator had already filed somewhere else sailed straight
        // through and became a second claimant.
        // The one exception is the round trip: `_origin` is stripped at export
        // (#33d), so after reopen our OWN groups look operator-authored. When such
        // a group has the SAME canonical we are proposing, the members it already
        // covers are "already done" — reporting those would fill the ⑤ readout
        // with an alarm for every group that merely survived a save/reopen.
        var blockingEg = null, sameCanonEg = null;
        for (var e = 0; e < egs.length; e++) {
            var other = egs[e];
            if (isOurs(other) || !sameLang(other.lang, lang)) continue;
            var touches = false;
            for (var t = 0; t < wanted.length; t++) if (egHolds(other, wanted[t])) { touches = true; break; }
            if (!touches) continue;
            if (other.canonical && _sameMember(other.canonical, canonMem)) { sameCanonEg = other; continue; }
            blockingEg = other;
            break;
        }
        if (blockingEg) {
            for (var b1 = 0; b1 < proposed.length; b1++) {
                if (proposed[b1]) blockedByOperator.push({ lang: lang, font: proposed[b1].font, weight: proposed[b1].weight });
            }
            continue;
        }
        if (sameCanonEg) {
            // Never modify an eg that is not ours (design-intent §8). Whatever it
            // does not already cover is declined, and said out loud.
            for (var b2 = 0; b2 < proposed.length; b2++) {
                if (proposed[b2] && !egHolds(sameCanonEg, proposed[b2])) {
                    blockedByOperator.push({ lang: lang, font: proposed[b2].font, weight: proposed[b2].weight });
                }
            }
            continue;
        }

        // -- B. absorb OUR OWN overlapping groups ------------------------------
        // If one of our groups already holds any of these spellings, it is the
        // SAME FACE by construction (both sides came from postscriptName), so the
        // answer is one group, not two. Absorbing is what keeps the invariant:
        // re-parenting only ever moved `merged_in` entries and could not express
        // "the member we want is that group's canonical".
        var absorbedIdx = [], keep = [];
        for (var e2 = 0; e2 < egs.length; e2++) {
            var mine = egs[e2];
            var overlaps = false;
            if (isOurs(mine) && sameLang(mine.lang, lang)) {
                for (var t2 = 0; t2 < wanted.length; t2++) if (egHolds(mine, wanted[t2])) { overlaps = true; break; }
            }
            if (overlaps) absorbedIdx.push(e2); else keep.push(mine);
        }

        var members = [];
        function claim(m, fromEg) {
            if (!m || _sameMember(m, canonMem)) return;
            for (var q = 0; q < members.length; q++) if (_sameMember(members[q], m)) return;
            // A member an operator eg holds is never ours to take, even when it
            // arrives via a group of ours that overlapped one (a pre-existing bad
            // state we must not propagate).
            for (var o = 0; o < egs.length; o++) {
                if (isOurs(egs[o]) || !sameLang(egs[o].lang, lang)) continue;
                if (egHolds(egs[o], m)) { blockedByOperator.push({ lang: lang, font: m.font, weight: m.weight }); return; }
            }
            members.push({ font: m.font, weight: m.weight });
            if (fromEg && fromEg.canonical && !_sameMember(fromEg.canonical, canonMem)) {
                reparented.push({ lang: fromEg.lang, font: m.font, weight: m.weight });
            }
        }
        for (var c1 = 0; c1 < proposed.length; c1++) claim(proposed[c1], null);
        for (var a1 = 0; a1 < absorbedIdx.length; a1++) {
            var absEg = egs[absorbedIdx[a1]];
            var absMembers = egMembers(absEg);
            for (var a2 = 0; a2 < absMembers.length; a2++) claim(absMembers[a2], absEg);
        }
        if (!members.length && !absorbedIdx.length) continue;

        var next = { lang: lang, canonical: { font: canonMem.font, weight: canonMem.weight },
                     merged_in: members, _origin: "machine-auto" };

        // Idempotency: when the single group we absorbed is already exactly this,
        // change NOTHING — not even its position. 🔴 Position matters:
        // getCanonical returns the FIRST matching group, so silently moving one to
        // the end of the array can change resolution without changing content.
        if (absorbedIdx.length === 1) {
            var before = egs[absorbedIdx[0]];
            var same = before.canonical && _sameMember(before.canonical, next.canonical) &&
                sameLang(before.lang, lang) && (before.merged_in || []).length === members.length;
            if (same) {
                for (var s1 = 0; s1 < members.length; s1++) if (!egHolds(before, members[s1])) { same = false; break; }
            }
            if (same) continue;   // nothing added, nothing extended, nothing moved
        }

        if (absorbedIdx.length) {
            // Put the merged group where the first absorbed one sat, so ordering —
            // and therefore resolution — is as stable as the content allows.
            var at = absorbedIdx[0], out = [], placed = false;
            for (var k2 = 0; k2 < egs.length; k2++) {
                if (absorbedIdx.indexOf(k2) >= 0) {
                    if (k2 === at) { out.push(next); placed = true; }
                    continue;
                }
                out.push(egs[k2]);
            }
            if (!placed) out.push(next);
            egs = out;
            extended.push({ lang: lang, canonical: next.canonical, added: members.length });
        } else {
            egs = keep.concat([next]);
            added.push({ lang: lang, canonical: next.canonical, members: members.length });
        }
    }
    return { egs: egs, added: added, extended: extended, reparented: reparented, blockedByOperator: blockedByOperator };
}

// findOverlaps — an imported config may ALREADY violate the invariant. We do not
// silently repair it (§8: the config is authoritative) and we do not let it pass
// unmentioned (measured: the validator says ok, and resolution is order-dependent).
// It is surfaced as a readout; whether the OPERATOR should see it, and where, is a
// product decision, not this module's call.
//
// 🔴 Keys CANONICAL AND merged_in (audit R1). It used to key merged_in only,
// so the commonest real overlap — one group's canonical sitting inside another
// group's members — was invisible, and this function reported 0 on exactly the
// state it exists to detect. Lang is compared normalized for the same reason as
// the write gates (audit R4).
function findOverlaps(egs) {
    var seen = {}, out = [];
    (egs || []).forEach(function (eg, idx) {
        if (!eg || !eg.lang) return;
        egMembers(eg).forEach(function (m) {
            if (!m || !m.font) return;
            var k = langKey(eg.lang) + SEP + m.font + SEP + m.weight;
            if (seen[k] !== undefined && seen[k] !== idx) {
                out.push({ lang: eg.lang, font: m.font, weight: m.weight, egIndexes: [seen[k], idx] });
            } else if (seen[k] === undefined) {
                seen[k] = idx;
            }
        });
    });
    return out;
}


// ---------------------------------------------------------------------------
// buildPanelEntries — WHICH SPELLINGS ARE IN PLAY (the panel's universe)
// ---------------------------------------------------------------------------
// documentFonts    : [{ font, weight, used }]      — what the document uses
// homeLangByFamily : { family: langCode }          — the scanner's home-lang guess
// fontsByLanguage  : { lang: [{ font, weight }] }  — the config's own source fonts
//
// The union of the two is deliberate and predates this change: a canonical may
// live ONLY in the config (never typed into the document), and it still has to
// join its group or the merge has nothing to merge INTO.
//
// 🔴 The two sources supply `lang` from different places, and that is not an
// inconsistency to iron out. A config font carries the language it is FILED under
// — an operator's decision. A document font only has the scanner's home-lang
// GUESS. Since an eg holds exactly one lang, entries whose langs disagree do not
// group even when the face is identical. That is fail-closed on purpose: guessing
// that the two langs "meant the same thing" is the class of inference this whole
// change exists to remove.
//
// Deduped on (lang, family, style) with FIRST WINS, so the document's usage count
// survives a config entry for the same spelling (config entries carry no count).
// This lives here rather than inline in the panel effect so the rule is gated by
// tests instead of only by opening the dialog.
function buildPanelEntries(documentFonts, homeLangByFamily, fontsByLanguage) {
    var entries = [];
    var seen = {};
    homeLangByFamily = homeLangByFamily || {};
    function push(family, style, lang, count) {
        if (!family) return;
        var k = lang + SEP + family + SEP + style;
        if (seen[k]) return;
        seen[k] = true;
        entries.push({ family: family, style: style, lang: lang, count: count || 0 });
    }
    var df = documentFonts || [];
    for (var i = 0; i < df.length; i++) {
        if (!df[i]) continue;
        push(df[i].font, df[i].weight, homeLangByFamily[df[i].font] || "en", df[i].used);
    }
    var fbl = fontsByLanguage || {};
    for (var lang in fbl) {
        if (!Object.prototype.hasOwnProperty.call(fbl, lang)) continue;
        var arr = fbl[lang] || [];
        for (var j = 0; j < arr.length; j++) {
            if (arr[j]) push(arr[j].font, arr[j].weight, lang, 0);
        }
    }
    return entries;
}

// 🪦 identityMergeRowsForFont / identityMergeRowId / identityRowHolding REMOVED
// (audit round 2, 2026-08-20). They planned the "render a same-family identity eg
// as one group row" option — option (1b) — which was built, audited, and REVERTED.
//
// 🔴 WHY, because it looked right and the reason it failed is not obvious:
// a group row is addressed by the row's id, so a pairing member had to be
// re-pointed onto it. Re-pointing alone made the member EXPORT as the row's
// representative (measured: an operator's `Gotham / Regular` line came out as
// `Gotham / Book`), so the member also had to carry `w` — the weight it really
// meant. That `w` became a SECOND SOURCE OF TRUTH for "which weight is this
// member", and the second audit round returned SIX A-class findings that were all
// the same shape: a reader that does not read `w`, a writer that does not clear
// `w`, a comparison that does not include `w`. Adding a seventh reader would have
// produced an eighth. (CLAUDE.md #27.)
//
// The contradiction (1b) existed to prevent — two pairings pulling the two halves
// of one identity group toward different targets — is now caught by the
// CROSS-PAIRING check in font_mapping_pairs.validateBrandConfig, which refuses it
// loudly at Done/Export instead of letting apply drop one line silently.
// ⚠ Do not rebuild (1b) from this note.

// ---------------------------------------------------------------------------
// findFalsifiableGroups (TODO#58 ③ / 6C) — groups the font engine DISPROVES
// ---------------------------------------------------------------------------
// A group says "these spellings are one physical face". That claim is FALSIFIABLE:
// if both sides are installed here and report DIFFERENT PostScript names, the
// claim is wrong — not uncertain, wrong. owner asked for those to be surfaced at
// load with a one-click removal.
//
// 🔴 SURFACE ONLY — this function reports; it never edits. owner was explicit
// that the config must not be silently changed (design-intent §8: the config is
// authoritative). The caller renders the list and the OPERATOR decides.
//
// 🔴 SILENCE IS THE DEFAULT WHENEVER THE ENGINE CANNOT ANSWER. A member is
// flagged only when BOTH sides are `status === "INSTALLED"` AND both PostScript
// names are non-empty AND they differ. Not installed, empty name, or a lookup that
// throws ⇒ NOT flagged: accusing a group of being wrong on the strength of "this
// machine could not check" is the same class of error as merging two faces because
// both reported "" (the measured disaster the INSTALLED gate exists to stop).
// The counts for those cases already exist in the ⑤ readout; this is a different
// question and must not borrow their evidence.
//
// egs        : config.equivalence_groups
// identityOf : (family, style) → { status, postscriptName, ... } | null  (may throw)
// returns [{ lang, canonical, member, canonicalPs, memberPs }]
function findFalsifiableGroups(egs, identityOf) {
    var out = [];
    if (typeof identityOf !== "function") return out;
    function idOf(font, weight) {
        var r = null;
        try { r = identityOf(font, weight); } catch (e) { r = null; }
        if (!r || String(r.status) !== "INSTALLED") return null;
        var ps = r.postscriptName ? String(r.postscriptName) : "";
        // same predicate as the merge side: a placeholder is not an answer, so 6C
        // must stay silent about it rather than call a group disproved on its basis.
        return looksLikeAnAnswer(ps) ? ps : null;
    }
    (egs || []).forEach(function (eg) {
        if (!eg || !eg.canonical) return;
        var canonPs = idOf(eg.canonical.font, eg.canonical.weight);
        if (!canonPs) return;                       // cannot judge ⇒ say nothing
        (eg.merged_in || []).forEach(function (m) {
            if (!m || !m.font) return;
            var mPs = idOf(m.font, m.weight);
            if (!mPs) return;                       // cannot judge ⇒ say nothing
            if (mPs === canonPs) return;            // the claim holds
            out.push({
                lang: eg.lang,
                canonical: { font: eg.canonical.font, weight: eg.canonical.weight },
                member: { font: m.font, weight: m.weight },
                canonicalPs: canonPs,
                memberPs: mPs
            });
        });
    });
    return out;
}

// ---------------------------------------------------------------------------
// reportFalsifiableGroups (A11, owner 2026-08-28) — where the answer goes now
// ---------------------------------------------------------------------------
// The strip that used to show this list is gone; the judgement is not. This is the
// whole of what replaced it: publish the list for a probe/bridge to read, and write
// ONE trace line when it changes.
//
// 🔴 IT LIVES HERE, NOT IN THE PANEL, FOR ONE REASON: a Node test can execute it.
// While this body sat inside an app.jsx effect, mutations that disabled it
// (`if (false) …`, an inserted early `return`) SURVIVED the whole suite — app.jsx is
// JSX evaluated inside the host and no offline test can run a line of it. Moving the
// body here does not make the panel's CALL to it testable (see quiet_surfaces.py),
// but it shrinks the untestable part to a single call site.
//
// ⚠ The de-dup by signature is not a nicety. The effect that drives this re-runs on
// EVERY data edit, and fapTrace keeps a 200-line ring buffer — a line per keystroke
// would push the rest of the session out of the record, which is a way of losing
// evidence that looks exactly like never having collected it.
//
// groups  : findFalsifiableGroups output
// prevSig : the signature returned by the previous call ("" on the first)
// sinks   : { publish(list), trace(what, detail) } — both optional
// returns the new signature; the caller keeps it and hands it back next time.
function reportFalsifiableGroups(groups, prevSig, sinks) {
    var list = groups || [];
    var sk = sinks || {};
    // 🔴 Published UNCONDITIONALLY, including the empty list. A reader that found a
    // stale non-empty list because the empty case skipped the write would conclude
    // the opposite of the truth — and "it went away" is exactly the state worth
    // reading. Empty is an answer.
    if (typeof sk.publish === "function") sk.publish(list);
    if (!list.length) return "";
    var sig = list.map(function (g) {
        return g.lang + "|" + g.canonical.font + "|" + g.canonical.weight + "|" +
               g.member.font + "|" + g.member.weight;
    }).join(";");
    if (sig === prevSig) return sig;
    if (typeof sk.trace === "function") {
        sk.trace("identity:falsifiable-groups", {
            n: list.length,
            rows: list.slice(0, 10).map(function (g) {
                return {
                    lang: g.lang,
                    canonical: g.canonical.font + " " + g.canonical.weight,
                    member: g.member.font + " " + g.member.weight,
                    ps: g.canonicalPs + " vs " + g.memberPs
                };
            })
        });
    }
    return sig;
}

// Remove ONE member from ONE group — the operator's one click. Returns a NEW array;
// a group left with no members disappears (an eg with an empty merged_in is not a
// group, it is a claim about nothing).
// 🔴 Matches on (lang, canonical, member) exactly, and touches nothing else:
// the operator asked to drop this one member, not to have the panel tidy up.
function removeGroupMember(egs, lang, canonical, member) {
    var out = [];
    (egs || []).forEach(function (eg) {
        if (!eg || !eg.canonical || !sameLang(eg.lang, lang) ||
            eg.canonical.font !== canonical.font || eg.canonical.weight !== canonical.weight) {
            out.push(eg);
            return;
        }
        var kept = (eg.merged_in || []).filter(function (m) {
            return !(m && m.font === member.font && m.weight === member.weight);
        });
        if (!kept.length) return;                   // nothing left to group
        var next = { lang: eg.lang, canonical: eg.canonical, merged_in: kept };
        if (eg._origin) next._origin = eg._origin;
        out.push(next);
    });
    return out;
}

// ---------------------------------------------------------------------------
// summarizeIdentityReadout (TODO#58 ⑤) — the five numbers, KEPT APART
// ---------------------------------------------------------------------------
// 🔴 THE FIVE STAY SEPARATE. There is deliberately NO total and no "issues"
// rollup; adding one is a regression, not a convenience. owner's question is
// 「因为没装而没合」 — that is `notInstalled` ALONE. Summing it with the other
// four answers a question nobody asked, and the four are not even the same KIND
// of event:
//   notInstalled       — the face is not on this machine ⇒ identity unknowable
//                        ⇒ not merged. The one owner actually asked about.
//   noPostscriptName   — resolves but reports "" (measured: NOT_AVAILABLE faces do
//                        this WITHOUT throwing, and two unrelated ones match)
//                        ⇒ fail-closed.
//   lookupFailed       — itemByName threw or returned nothing ⇒ could not ask.
//   blockedByOperator  — identity says "same face" but an operator/config eg owns
//                        that member or that canonical ⇒ §8: leave it alone.
//   overlaps           — an eg set (typically IMPORTED) already puts one member in
//                        two groups. 🔴 Unlike the other four this one AFFECTS THE
//                        PRODUCT: getCanonical returns the FIRST match in array
//                        order (measured: reversing the array changed the answer)
//                        and validateBrandConfig did not reject it when this was
//                        written (measured: ok:true, zero errors). ⚠ IT DOES NOW
//                        (audit round 5) — an overlapping set is refused outright,
//                        so this counter is a READOUT of something that also fails
//                        validation, not the only thing standing between an overlap
//                        and the pipeline. The other four still only mean
//                        "merged less".
//
// `details` carries the per-item lists so a caller can name names; the five counts
// are the headline. Whether and where the OPERATOR sees any of this is a product
// decision (arch → owner), not this module's call.
function summarizeIdentityReadout(buildResult, applyResult, egsForOverlap) {
    var c = (buildResult && buildResult.skippedCounts) || {};
    var blocked = (applyResult && applyResult.blockedByOperator) || [];
    var egs = egsForOverlap || (applyResult && applyResult.egs) || [];
    var overlaps = findOverlaps(egs);
    return {
        notInstalled: c.notInstalled || 0,
        noPostscriptName: c.noPostscriptName || 0,
        lookupFailed: c.lookupFailed || 0,
        blockedByOperator: blocked.length,
        overlaps: overlaps.length,
        details: {
            skipped: (buildResult && buildResult.skipped) || [],
            blockedByOperator: blocked,
            overlaps: overlaps
        }
    };
}

// One-line log form. Same rule: five labelled numbers, never a sum.
function formatIdentityReadout(r) {
    r = r || {};
    return "not-installed=" + (r.notInstalled || 0) +
        " no-postscript-name=" + (r.noPostscriptName || 0) +
        " lookup-failed=" + (r.lookupFailed || 0) +
        " blocked-by-operator=" + (r.blockedByOperator || 0) +
        " overlaps=" + (r.overlaps || 0);
}

module.exports = {
    buildIdentityGroups: buildIdentityGroups,
    buildPanelEntries: buildPanelEntries,
    applyIdentityGroups: applyIdentityGroups,
    findOverlaps: findOverlaps,
    findFalsifiableGroups: findFalsifiableGroups,
    reportFalsifiableGroups: reportFalsifiableGroups,
    removeGroupMember: removeGroupMember,
    egMembers: egMembers,
    egHolds: egHolds,
    // TODO#58 ② — exported so the PANEL compares languages with the exact same
    // function this module does. 🔴 It is exported to prevent a bug SHAPE, not
    // because the panel needs a utility: "one side normalized, the other raw" has
    // been the root cause four separate times in this subsystem (audit R4 here,
    // mergedInIndex keyed on raw lang, and twice in font_mapping_pairs). ② matches
    // an upstream `_meta.target_language` against a panel column's `code`, which is
    // precisely that shape again — upstream may say `zh-Hans-CN` where the column
    // says `zh-CN`. Sharing the comparator makes the two sides equal by
    // construction rather than by remembering.
    sameLang: sameLang,
    _looksLikeAnAnswer: looksLikeAnAnswer,
    summarizeIdentityReadout: summarizeIdentityReadout,
    formatIdentityReadout: formatIdentityReadout,
    _pickCanonical: pickCanonical
};
