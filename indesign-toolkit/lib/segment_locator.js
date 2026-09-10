"use strict";

/**
 * lib/segment_locator.js
 *
 * Phase 3 Pass A.5 — 段落定位一等模块
 *
 * Plan reference:
 *   task_plan.md "段落定位独立为 Pass A.5 + lib/segment_locator.js（一等模块）"
 *
 * Question this module answers:
 *   For each segment in segments.json, which Paragraph in the workDoc
 *   is the segment's content (and where translations should be written)?
 *
 * Multi-strategy chain (high → low confidence):
 *   1. sidecar XML markers (if seg.xml_id and doc has matching xmlElement)
 *   2. tid_map by_story_para  (story_index + paragraph_index, exact)
 *   3. tid_map by_story_para_uid (story_index + paragraph_uid, if available)
 *   4. by_source_hash (paragraphs whose contents hash matches seg.source_hash)
 *   5. textual fallback (find paragraph containing seg.source_text)
 *
 * Each LocateResult includes:
 *   {
 *     seg,                     // the input segment object
 *     para,                    // workDoc Paragraph object (or null on miss)
 *     confidence: "high"|"medium"|"low",
 *     strategy: "<which one hit>",
 *     reason: <on miss only>,
 *     translatable: bool,      // true if seg has target_text + status not skip/control_only
 *     address: {storyIndex, paragraphIndex, sourceHash}  // forward-compat seed
 *   }
 *
 * MVP: Commit consumes para (DOM ref) directly. address is recorded but
 * not consumed (future E5b cross-doc / E10 heuristic / dryrun report).
 *
 * UXP / ExtendScript compatibility:
 *   - Pure module + deps injection
 *   - deps:
 *       hashFn(text)              — string → hex hash (caller passes djb2 or similar)
 *       findXmlElementById(id)    — optional, for sidecar XML strategy
 *       getCollectionItem(coll, i) — handles item() vs [i] indexing
 *   - var only, no ES6+
 */

// ─── Defaults ─────────────────────────────────────────────────────

function _defaultGetCollectionItem(coll, idx) {
    if (!coll) return null;
    if (typeof coll.item === "function") return coll.item(idx);
    return coll[idx];
}

// #BRIDGE-33: must mirror translation_common.normalizeText, which is what
// export_translation_package applies to source_text BEFORE hashing into
// segments.json source_hash. Without the same normalization, locator's
// `hashFn(_safeContents(para)) === seg.source_hash` returns false for any
// paragraph whose contents differ from source_text only in trailing /
// internal whitespace (most commonly a trailing space — Client-A
// Whole Life "S&P 500 \r" → segments stored hash of "S&P 500" — locator
// computes hash of "S&P 500 " (trailing space kept) → mismatch).
//
// Hash mismatch sends locate down the strategy chain to tryTextualFallback,
// which startsWith()-matches and grabs the WRONG paragraph (the first
// paragraph whose contents starts with source_text — "S&P 500 Total Return"
// starts with "S&P 500 ", so the legend-area S&P 500 segment locates onto
// the source-row "S&P 500 Total Return" paragraph and overwrites it,
// cascading every downstream paragraph one row off and (via subsequent
// merge bugs in adjacent text) eats the paragraph mark.
//
// Normalization steps (exact mirror of translation_common.normalizeText):
//   1.  → \n
//   2. collapse \n with surrounding ASCII whitespace → single space
//   3. strip [﻿​‌‍]
//   4. collapse all whitespace runs to single space
//   5. trim leading + trailing whitespace
function _normalizeForHash(t) {
    var s = String(t == null ? "" : t);
    s = s.replace(//g, "\n");
    s = s.replace(/[ \t]*\n+[ \t]*/g, " ");
    s = s.replace(/[﻿​‌‍]/g, "");
    s = s.replace(/\s+/g, " ");
    s = s.replace(/^\s+|\s+$/g, "");
    return s;
}

function _safeContents(para) {
    try {
        var t = String(para.contents || "");
        // Strip trailing paragraph mark first, then normalize the same way
        // export does. Order matters: \r appears in the raw, and the strip
        // is harmless even after normalize, but doing it first keeps the
        // intermediate value debugger-friendly.
        return _normalizeForHash(t.replace(/\r+$/, ""));
    } catch (e) { return ""; }
}

function _isTranslatable(seg) {
    // A segment is "translatable" in the sense the EXPORT decided —
    // export_translation_package writes seg.translatable = true when
    // segment_kind is text / table_cell (excluding control_anchor /
    // table_anchor / hidden). target_text is NOT in segments.json (it
    // lives in translations.json keyed by tid); pairing happens in
    // v2_pipeline.applyOnePara which looks up translations.byTid[seg.tid].
    if (!seg) return false;
    if (seg.control_only) return false;
    var status = seg.status;
    if (status === "skip" || status === "control_only") return false;
    // Honor segments.json translatable flag (set by export). Default true
    // when the field is missing — preserves backward compat for older
    // segments.json without the field.
    if (seg.translatable === false) return false;
    return true;
}

function _buildAddress(seg, hashFn, computedHash) {
    return {
        storyIndex: (typeof seg.story_index === "number") ? seg.story_index : null,
        paragraphIndex: (typeof seg.paragraph_index === "number") ? seg.paragraph_index : null,
        sourceHash: computedHash || seg.source_hash || (seg.source_text && hashFn ? hashFn(String(seg.source_text)) : null)
    };
}

// ─── Strategies (each returns {para, strategy, confidence} or null) ──

// Strategy 1: sidecar XML marker
// Requires seg.xml_id (or seg.xml_element_id) and deps.findXmlElementById
function tryXmlMarker(seg, deps) {
    if (!deps || typeof deps.findXmlElementById !== "function") return null;
    var xmlId = seg.xml_id || seg.xml_element_id;
    if (!xmlId) return null;
    try {
        var el = deps.findXmlElementById(xmlId);
        if (!el || !el.isValid) return null;
        // Resolve element to its paragraph(s) — typical pattern: el.texts[0].paragraphs[0]
        var para = null;
        try {
            var texts = el.texts;
            if (texts && texts.length > 0) {
                var firstText = (typeof texts.item === "function") ? texts.item(0) : texts[0];
                if (firstText && firstText.paragraphs && firstText.paragraphs.length > 0) {
                    para = (typeof firstText.paragraphs.item === "function")
                        ? firstText.paragraphs.item(0)
                        : firstText.paragraphs[0];
                }
            }
        } catch (eP) {}
        if (para && para.isValid) {
            return { para: para, strategy: "xml_marker", confidence: "high" };
        }
    } catch (e) {}
    return null;
}

// Resolve a segment's story reference to a Story object. Accepts either:
//   - seg.story_index (0-based index into doc.stories) — preferred
//   - seg.story_id    (InDesign DOM Story.id, persistent across opens of
//                      the SAME .indd but assigned fresh when an .idml
//                      is opened, so import_translations on a re-opened
//                      idml needs a content-based scan to map story_id
//                      onto the current session's index)
// Returns the Story DOM object or null.
function _resolveStory(seg, doc, deps) {
    var get = (deps && deps.getCollectionItem) ? deps.getCollectionItem : _defaultGetCollectionItem;
    var stories = doc.stories;
    if (!stories) return null;
    if (typeof seg.story_index === "number" && seg.story_index >= 0 && seg.story_index < stories.length) {
        var st = get(stories, seg.story_index);
        if (st && st.isValid) return st;
    }
    if (typeof seg.story_id === "number" && seg.story_id >= 0) {
        for (var i = 0; i < stories.length; i++) {
            try {
                var st2 = get(stories, i);
                if (st2 && st2.isValid && st2.id === seg.story_id) return st2;
            } catch (e) {}
        }
    }
    return null;
}

// Strategy 1.5: table cell paragraph (story.tables[].cells[].paragraphs[])
//
// Table cell paragraphs are NOT in story.paragraphs[] — they live in a
// separate hierarchy. The other strategies walk story.paragraphs and miss
// table cells entirely. This strategy uses seg.table_id +
// seg.cell_row/cell_col + seg.cell_para_index to descend into the cell's
// own paragraphs collection.
//
// Triggered only when seg has table address fields (table_id ≥ 0 AND
// cell_row/cell_col present). Falls through gracefully on regular text
// segments.
function tryStoryTableCell(seg, doc, deps) {
    if (typeof seg.table_id !== "number" || seg.table_id < 0) return null;
    if (typeof seg.cell_row !== "number" || seg.cell_row < 0) return null;
    if (typeof seg.cell_col !== "number" || seg.cell_col < 0) return null;
    var story = _resolveStory(seg, doc, deps);
    if (!story) return null;
    var get = (deps && deps.getCollectionItem) ? deps.getCollectionItem : _defaultGetCollectionItem;
    try {
        var tables = story.tables;
        if (!tables || typeof tables.length !== "number") return null;
        var table = null;
        for (var t = 0; t < tables.length; t++) {
            try {
                var tbl = get(tables, t);
                if (tbl && tbl.isValid && Number(tbl.id) === Number(seg.table_id)) {
                    table = tbl;
                    break;
                }
            } catch (eT) {}
        }
        if (!table) {
            // Fallback: match by table_uid if present (export writes both)
            if (seg.table_uid) {
                for (var t2 = 0; t2 < tables.length; t2++) {
                    try {
                        var tbl2 = get(tables, t2);
                        // InDesign Table doesn't expose .uid directly; some
                        // exporters stash it in label or scriptLabel
                        if (tbl2 && tbl2.isValid &&
                            (String(tbl2.label || "") === String(seg.table_uid) ||
                             String(tbl2.id || "") === String(seg.table_uid))) {
                            table = tbl2;
                            break;
                        }
                    } catch (eT2) {}
                }
            }
            if (!table) return null;
        }
        // Locate the cell at (row, col). #E2E-19: when a row has merged
        // cells (colspan>1 anywhere on the doc), the table.cells flat
        // collection is NOT row-major × columnCount — a merged cell
        // consumes only ONE slot regardless of its span, so the formula
        // row*columnCount+col shifts every segment after the first merged
        // row by the merge delta. Symptom: Client-A table page-2 header has
        // cs=2; row 1 c=0 ("专责…") got written at the body's cell index 2
        // (= source r=1 c=1), cascading a +1 shift through every body
        // cell.
        //
        // Robust resolution: drill into the row's cells collection by
        // matching cell.parentColumn.index. This handles arbitrary merge
        // topology without depending on the row-major flat layout.
        var cell = null;
        try {
            var rowObj = get(table.rows, seg.cell_row);
            if (rowObj && rowObj.isValid && rowObj.cells) {
                var rowCells = rowObj.cells;
                for (var __rci = 0; __rci < rowCells.length; __rci++) {
                    var __rc = get(rowCells, __rci);
                    if (!__rc || !__rc.isValid) continue;
                    var __cStart = -1;
                    try { __cStart = Number(__rc.parentColumn.index); } catch (eCp) {}
                    var __cSpan = 1;
                    try { __cSpan = Number(__rc.columnSpan) || 1; } catch (eCsp) {}
                    // Match either exact column start, or column inside
                    // a merge range (caller may pass the leftmost col of
                    // a merge — most exporters do — but accept any col
                    // within the span for resilience).
                    if (seg.cell_col >= __cStart && seg.cell_col < __cStart + __cSpan) {
                        cell = __rc;
                        break;
                    }
                }
            }
        } catch (eRow) {}
        if (!cell || !cell.isValid) {
            // Legacy fallback for tables without merges: flat index.
            try {
                var cellIdx = seg.cell_row * table.columnCount + seg.cell_col;
                if (cellIdx >= 0 && cellIdx < table.cells.length) {
                    cell = get(table.cells, cellIdx);
                }
            } catch (eFlat) {}
        }
        if (!cell || !cell.isValid) return null;
        // Pick the paragraph inside the cell (default index 0)
        var paraIdx = (typeof seg.cell_para_index === "number" && seg.cell_para_index >= 0)
            ? seg.cell_para_index
            : 0;
        if (paraIdx >= cell.paragraphs.length) return null;
        var para = get(cell.paragraphs, paraIdx);
        if (!para || !para.isValid) return null;
        return { para: para, strategy: "by_table_cell", confidence: "high" };
    } catch (e) {
        return null;
    }
}

// Strategy 2: by story + paragraph_index (exact)
//
// #BRIDGE-18: index match alone isn't a "high confidence" hit — if the
// designer added or removed paragraphs in the source since segments.json
// was exported, paragraph_index now points at a totally different
// paragraph. Validate by comparing source_hash (or normalized prefix
// fallback) and downgrade / fall through to uid+hash strategies on
// mismatch. Without this gate the locator silently writes a target
// paragraph's translation onto whatever happens to sit at that index,
// scrambling the doc.
function tryStoryParagraphIndex(seg, doc, deps) {
    if (typeof seg.paragraph_index !== "number" || seg.paragraph_index < 0) return null;
    var story = _resolveStory(seg, doc, deps);
    if (!story) return null;
    var get = (deps && deps.getCollectionItem) ? deps.getCollectionItem : _defaultGetCollectionItem;
    try {
        var paras = story.paragraphs;
        if (!paras || seg.paragraph_index >= paras.length) return null;
        var para = get(paras, seg.paragraph_index);
        if (!para || !para.isValid) return null;

        var hashFn = (deps && deps.hashFn) ? deps.hashFn : null;
        var expected = seg.source_hash || (seg.source_text && hashFn ? hashFn(String(seg.source_text)) : null);
        if (expected && hashFn) {
            var text = _safeContents(para);
            if (hashFn(text) === expected) {
                return { para: para, strategy: "by_story_para", confidence: "high" };
            }
            // #BRIDGE-37: soft-break sub-segments share their parent's
            // paragraph_index but seg.source_text is only the sub-piece
            // (e.g. "Illustrated Death"), so seg.source_hash will never
            // match the full paragraph hash ("Illustrated Death\nBenefit
            // at current -1%"). Without special-casing, this strategy
            // returns null and the chain falls through to textual
            // fallback, which prefix-matches the first paragraph in the
            // story that starts with source_text — often the WRONG one
            // (e.g. p60 "Illustrated Death Benefit at current (5.50%)"
            // also starts with "Illustrated Death"). The sub-segment
            // then writes to the wrong paragraph, and the correct
            // paragraph's translation is silently lost. Trust the
            // exporter-stamped paragraph_index for sub-segments and
            // skip the hash gate — the per-sub-segment text may differ
            // from the paragraph total but the parent paragraph is
            // what we want to write to (the merge pass in v2_pipeline
            // joins all sub-segments' translations into one target
            // for the head segment, which we write to this parent).
            if (seg.soft_break_group || (typeof seg.soft_break_index === "number" && seg.soft_break_index >= 0)) {
                return { para: para, strategy: "by_story_para_sb", confidence: "medium" };
            }
            // #62 B②: PRIOR-APPLIED BYPASS — an ADDITIONAL way to hit, never a
            // relaxation of the check above.
            //
            // On a SECOND import into an already-translated document, the gate
            // above can never pass: `seg.source_hash` hashes the package's
            // source language, while this paragraph now holds the PREVIOUS
            // round's translation. Every remaining strategy is keyed on the same
            // source text, so the row locates nowhere and the operator's edit is
            // silently dropped. Measured 2026-08-22 on a real document: 49 of
            // 110 rows — precisely the ones round 1 had translated SUCCESSFULLY.
            //
            // So we ask a second identity question, equally strong: "is this
            // paragraph the text we ourselves wrote here last time?" The import
            // state sidecar records, per tid, the hash of what was applied. If
            // this paragraph's contents reproduce that hash, this IS the
            // paragraph that tid owns.
            //
            // 🔴 This does NOT weaken #BRIDGE-18. That gate exists so a stale
            // paragraph_index cannot write a translation onto an unrelated
            // paragraph after a designer adds or removes paragraphs. The bypass
            // demands a full content match against a per-tid recorded hash — an
            // unrelated paragraph fails it exactly as it fails the source_hash
            // check. Both doors need a key; we added a second lock the same key
            // fits, not a way around the first.
            //
            // The predicate is injected (deps.appliedHashMatchesText) rather than
            // implemented here: `applied_hash` is a composite built with
            // import_diff_classify's normaliser, which is NOT the same as this
            // module's `_normalizeForHash`. See that function's comment.
            var prior = (deps && deps.priorAppliedByTid && seg.tid)
                ? deps.priorAppliedByTid[seg.tid] : null;
            if (prior && deps && typeof deps.appliedHashMatchesText === "function") {
                try {
                    if (deps.appliedHashMatchesText(prior, text)) {
                        return { para: para, strategy: "by_story_para_prior_applied", confidence: "high" };
                    }
                } catch (ePA) { /* fall through — never treat a throw as a match */ }
            }
            // Hash mismatch — index is stale. Return null so the
            // strategy chain falls through to uid / hash / textual
            // fallback, which can find the real target by content.
            return null;
        }
        // No expected hash to verify against — keep legacy behavior
        // but downgrade confidence so downstream code (e.g. preflight
        // hardErrors.runPreflight) can treat the hit with caution.
        // Doing a normalized-prefix match against source_text would be
        // possible here but provides little extra safety vs. just
        // surfacing low confidence.
        return { para: para, strategy: "by_story_para", confidence: "low" };
    } catch (e) {}
    return null;
}

// Strategy 3: by story + paragraph_uid (if available)
function tryStoryParagraphUid(seg, doc, deps) {
    if (typeof seg.paragraph_uid !== "number" || seg.paragraph_uid < 0) return null;
    var story = _resolveStory(seg, doc, deps);
    if (!story) return null;
    var get = (deps && deps.getCollectionItem) ? deps.getCollectionItem : _defaultGetCollectionItem;
    try {
        var paras = story.paragraphs;
        if (!paras || typeof paras.length !== "number") return null;

        // Iterate paragraphs; match by .id (paragraph_uid is supposed to be the InDesign id)
        for (var i = 0; i < paras.length; i++) {
            var p = get(paras, i);
            if (!p || !p.isValid) continue;
            try {
                if (p.id === seg.paragraph_uid) {
                    return { para: p, strategy: "by_story_para_uid", confidence: "high" };
                }
            } catch (eId) {}
        }
    } catch (e) {}
    return null;
}

// Strategy 4: by source_hash (paragraphs in the story whose contents hash matches)
function tryStorySourceHash(seg, doc, deps) {
    var hashFn = (deps && deps.hashFn) ? deps.hashFn : null;
    if (!hashFn) return null;
    var expected = seg.source_hash || (seg.source_text ? hashFn(String(seg.source_text)) : null);
    if (!expected) return null;

    var get = (deps && deps.getCollectionItem) ? deps.getCollectionItem : _defaultGetCollectionItem;

    // Restrict scope to the segment's story if known; else all stories
    var stories;
    try { stories = doc.stories; } catch (e) { return null; }
    if (!stories) return null;

    // Resolve story scope: prefer story_index, fall back to story_id scan,
    // then to global. Without this, segments exported only with story_id
    // (the common export-side path) always fell into "all stories" scope
    // and lost the per-story locality benefit.
    var storyIndices;
    if (typeof seg.story_index === "number" && seg.story_index >= 0 && seg.story_index < stories.length) {
        storyIndices = [seg.story_index];
    } else if (typeof seg.story_id === "number" && seg.story_id >= 0) {
        storyIndices = [];
        for (var s2 = 0; s2 < stories.length; s2++) {
            try {
                var st = get(stories, s2);
                if (st && st.isValid && st.id === seg.story_id) { storyIndices.push(s2); break; }
            } catch (eRS) {}
        }
        if (!storyIndices.length) {
            for (var s3 = 0; s3 < stories.length; s3++) storyIndices.push(s3);
        }
    } else {
        storyIndices = [];
        for (var s = 0; s < stories.length; s++) storyIndices.push(s);
    }

    for (var si = 0; si < storyIndices.length; si++) {
        try {
            var story = get(stories, storyIndices[si]);
            if (!story || !story.isValid) continue;
            var paras = story.paragraphs;
            if (!paras || typeof paras.length !== "number") continue;
            for (var pi = 0; pi < paras.length; pi++) {
                var p = get(paras, pi);
                if (!p || !p.isValid) continue;
                var text = _safeContents(p);
                if (!text) continue;
                if (hashFn(text) === expected) {
                    // Confidence: high if story scope matched (only 1 story), medium if global
                    return {
                        para: p,
                        strategy: "by_source_hash",
                        confidence: (storyIndices.length === 1) ? "high" : "medium"
                    };
                }
            }
        } catch (eS) {}
    }
    return null;
}

// Strategy 5: textual fallback (find paragraph by exact-match first, then prefix)
// Low confidence; brittle. Last resort.
//
// #BRIDGE-33: prefer EXACT normalized match over prefix match. When
// segments contains "S&P 500 " (short) and the story has both "S&P 500 "
// (the actual source paragraph) AND "S&P 500 Total Return" (a longer
// paragraph elsewhere in the story), the original prefix-only fallback
// picked the FIRST paragraph whose contents startsWith() the source — that
// can be the long one if it's positioned earlier in the story, locating the
// segment onto the wrong paragraph and corrupting both paragraphs (the
// targeted one gets the unrelated translation written in, the longer one
// stays English). Exact match disambiguates safely.
function tryTextualFallback(seg, doc, deps) {
    var sourceText = seg.source_text;
    if (!sourceText) return null;
    var get = (deps && deps.getCollectionItem) ? deps.getCollectionItem : _defaultGetCollectionItem;
    var sourceNorm = _normalizeForHash(String(sourceText));
    if (!sourceNorm) return null;
    var needle = String(sourceText).substring(0, Math.min(60, sourceText.length));
    if (!needle) return null;
    try {
        var stories = doc.stories;
        if (!stories) return null;
        // Pass 1: prefer exact-normalized match anywhere in any story.
        for (var si1 = 0; si1 < stories.length; si1++) {
            var story1 = get(stories, si1);
            if (!story1 || !story1.isValid) continue;
            var paras1 = story1.paragraphs;
            if (!paras1 || typeof paras1.length !== "number") continue;
            for (var pi1 = 0; pi1 < paras1.length; pi1++) {
                var p1 = get(paras1, pi1);
                if (!p1 || !p1.isValid) continue;
                var t1 = _safeContents(p1);
                if (t1 === sourceNorm) {
                    return { para: p1, strategy: "by_source_text_exact", confidence: "medium" };
                }
            }
        }
        // Pass 2: legacy prefix fallback (only when no exact match exists).
        for (var si = 0; si < stories.length; si++) {
            var story = get(stories, si);
            if (!story || !story.isValid) continue;
            var paras = story.paragraphs;
            if (!paras || typeof paras.length !== "number") continue;
            for (var pi = 0; pi < paras.length; pi++) {
                var p = get(paras, pi);
                if (!p || !p.isValid) continue;
                var text = _safeContents(p);
                if (text.indexOf(needle) === 0) {
                    return { para: p, strategy: "by_source_text_prefix", confidence: "low" };
                }
            }
        }
    } catch (e) {}
    return null;
}

// ─── Main entry: locateAllSegments ────────────────────────────────

/**
 * Run all locate strategies for each segment, return LocateResult[].
 *
 * @param {Document} workDoc — InDesign workDoc (saveACopy of source)
 * @param {Array} segments — segments.json segment objects
 * @param {Object} deps — { hashFn, [findXmlElementById, getCollectionItem] }
 * @returns {Array} [{seg, para, confidence, strategy, reason?, translatable, address}, ...]
 */
function locateAllSegments(workDoc, segments, deps) {
    if (!workDoc) throw new Error("locateAllSegments: workDoc required");
    if (!segments || typeof segments.length !== "number") {
        throw new Error("locateAllSegments: segments must be an array");
    }
    if (!deps || typeof deps.hashFn !== "function") {
        throw new Error("locateAllSegments: deps.hashFn required (e.g., djb2 hex)");
    }

    var results = [];
    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        var translatable = _isTranslatable(seg);

        var hit = null;
        if (!hit) hit = tryXmlMarker(seg, deps);
        // Table cell strategy runs early — its synthetic `paragraph_index`
        // (e.g. 16626001020 = table_id*1e6 + row*1e3 + col*10) would always
        // be out-of-bounds for tryStoryParagraphIndex, so do the table
        // descent first when seg has table_id + cell coords.
        if (!hit) hit = tryStoryTableCell(seg, workDoc, deps);
        if (!hit) hit = tryStoryParagraphIndex(seg, workDoc, deps);
        if (!hit) hit = tryStoryParagraphUid(seg, workDoc, deps);
        if (!hit) hit = tryStorySourceHash(seg, workDoc, deps);
        if (!hit) hit = tryTextualFallback(seg, workDoc, deps);

        var address = _buildAddress(seg, deps.hashFn, null);
        if (hit) {
            results.push({
                seg: seg,
                para: hit.para,
                confidence: hit.confidence,
                strategy: hit.strategy,
                translatable: translatable,
                address: address
            });
        } else {
            results.push({
                seg: seg,
                para: null,
                confidence: null,
                strategy: null,
                reason: "not_located",
                translatable: translatable,
                address: address
            });
        }
    }
    return results;
}

// ─── Module exports ────────────────────────────────────────────────

module.exports = {
    locateAllSegments: locateAllSegments,
    _internal: {
        tryXmlMarker: tryXmlMarker,
        tryStoryTableCell: tryStoryTableCell,
        tryStoryParagraphIndex: tryStoryParagraphIndex,
        tryStoryParagraphUid: tryStoryParagraphUid,
        tryStorySourceHash: tryStorySourceHash,
        tryTextualFallback: tryTextualFallback,
        _isTranslatable: _isTranslatable,
        _buildAddress: _buildAddress,
        _safeContents: _safeContents,
        _defaultGetCollectionItem: _defaultGetCollectionItem
    }
};
