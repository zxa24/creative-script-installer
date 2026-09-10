"use strict";

// lib/hyperlink_preserver.js — capture/restore doc-level hyperlinks
// across the reorganize / import-v2 pipeline.
//
// Why this exists: hyperlinks in InDesign are doc-level `Hyperlink`
// objects whose `source` is a HyperlinkTextSource pointing at a text
// range, and whose `destination` is a URL / page / text destination.
// During pure reorganize (no `para.contents` rewrite), char offsets
// inside each story stay stable, so the source range usually
// survives — BUT:
//   • applyClusterStyleToParagraph's normalize step calls
//     `texts.everyItem().clearOverrides()` on each paragraph. If the
//     hyperlink's source was a text range INSIDE that paragraph and
//     happened to have a char style assignment, clearOverrides may
//     reset the visual styling but should NOT delete the hyperlink
//     itself (hyperlinks are doc-level, not char-level).
//   • Importantly: the hyperlink's `source.appliedCharacterStyle`
//     (the visual treatment for the link — usually a "Hyperlink"
//     char style) can be a designer-named style that the cluster
//     pipeline doesn't touch. The hyperlink's RANGE survives, the
//     URL survives, but if the visual char style was a designer one
//     #3 fix preserves it; if it was unnamed / inline, it's gone.
//   • For import_v2's translation flow that rewrites `para.contents`,
//     the source range is invalidated when the chars get replaced.
//     This module records (storyId, startOffsetInStory, endOffsetInStory,
//     destinationURL, name, ...) BEFORE preclean and re-creates any
//     hyperlinks lost by the time apply finishes.
//
// Capture is read-only (doc-level traversal); restore re-creates lost
// hyperlinks at the same story+offset coordinates. For reorganize the
// restore should mostly be a no-op (count drift = 0); the channel
// exists primarily as a safety net + for the import-v2 future use case.

function _safe(s) { try { return String(s || ""); } catch (e) { return ""; } }

function _resolveTextOffsetInStory(textObj) {
    // textObj is a Text/Character (sourceText). storyOffset = its
    // first char's index in the parent story. UXP exposes this as
    // .characters[0].index.
    var startIdx = -1, endIdx = -1, sid = "";
    try { sid = String(textObj.parentStory.id); } catch (e) {}
    try { startIdx = textObj.characters.item(0).index; } catch (e) {}
    try {
        var n = textObj.characters.length;
        if (n > 0) endIdx = textObj.characters.item(n - 1).index;
    } catch (e) {}
    return { storyId: sid, startIdx: startIdx, endIdx: endIdx };
}

function _readDestination(dest) {
    if (!dest) return { kind: "none" };
    var out = { kind: "?" };
    try { out.kind = dest.constructor && dest.constructor.name; } catch (e) {}
    try {
        if (out.kind === "HyperlinkURLDestination") {
            out.url = _safe(dest.destinationURL);
            try { out.name = _safe(dest.name); } catch (e) {}
        } else if (out.kind === "HyperlinkTextDestination") {
            try { out.name = _safe(dest.name); } catch (e) {}
            // destinationText is a Text range; record its story+offsets
            try {
                var dt = dest.destinationText;
                if (dt) out.targetStory = _resolveTextOffsetInStory(dt);
            } catch (e) {}
        } else if (out.kind === "HyperlinkPageDestination") {
            try { out.name = _safe(dest.name); } catch (e) {}
            try { out.pageRef = _safe(dest.destinationPage && dest.destinationPage.name); } catch (e) {}
        }
    } catch (eK) { out.readError = _safe(eK.message); }
    return out;
}

/**
 * Capture every hyperlink in the document. Returns an array of records
 * each representing one hyperlink's source-range coordinates +
 * destination + visual appearance. Reorganize / apply doesn't usually
 * delete hyperlinks but can clobber their source ranges; this snapshot
 * lets the post-apply restore put them back exactly where they were.
 */
function captureDocHyperlinks(doc, plog) {
    var out = [];
    var hl;
    try { hl = doc.hyperlinks; } catch (e) { return out; }
    var n = 0;
    try { n = hl.length; } catch (e) {}
    for (var i = 0; i < n; i++) {
        var h;
        try { h = hl.item(i); } catch (e) { continue; }
        if (!h) continue;
        var rec = { name: "", visible: true, srcKind: "?" };
        try { rec.name = _safe(h.name); } catch (e) {}
        try { rec.visible = !!h.visible; } catch (e) {}
        try {
            var src = h.source;
            if (src) {
                try { rec.srcKind = src.constructor && src.constructor.name; } catch (e) {}
                try { rec.charStyleName = _safe(src.appliedCharacterStyle && src.appliedCharacterStyle.name); } catch (e) {}
                if (rec.srcKind === "HyperlinkTextSource") {
                    try {
                        var st = src.sourceText;
                        if (st) {
                            var loc = _resolveTextOffsetInStory(st);
                            rec.storyId = loc.storyId;
                            rec.startIdx = loc.startIdx;
                            rec.endIdx = loc.endIdx;
                            try { rec.sampleText = _safe(st.contents).slice(0, 60); } catch (eC) {}
                        }
                    } catch (eS) {}
                }
                // PageItem source (rare): the source is a frame/object,
                // record its id so restore can find it.
                else if (rec.srcKind === "HyperlinkPageItemSource") {
                    try { rec.sourceItemId = _safe(src.sourceItem && src.sourceItem.id); } catch (e) {}
                }
            }
        } catch (eSrc) { rec.srcError = _safe(eSrc.message); }
        rec.destination = _readDestination(h.destination);
        out.push(rec);
    }
    if (plog) plog("hyperlinks: captured " + out.length + " (text-src=" + out.filter(function(r){return r.srcKind==="HyperlinkTextSource";}).length + ")");
    return out;
}

function _findHyperlinkByName(doc, name) {
    if (!name) return null;
    try {
        var h = doc.hyperlinks.itemByName(name);
        if (h && h.isValid) return h;
    } catch (e) {}
    return null;
}

function _findStoryById(doc, sid) {
    if (!sid) return null;
    try {
        var stories = doc.stories;
        for (var i = 0; i < stories.length; i++) {
            try {
                var s = stories.item(i);
                if (s && s.isValid && _safe(s.id) === sid) return s;
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

function _ensureURLDestination(doc, url, name) {
    // Try to find an existing URL destination with the same URL; otherwise create.
    try {
        var dests = doc.hyperlinkURLDestinations;
        for (var i = 0; i < dests.length; i++) {
            try {
                var d = dests.item(i);
                if (_safe(d.destinationURL) === _safe(url)) return d;
            } catch (e) {}
        }
    } catch (e) {}
    try {
        return doc.hyperlinkURLDestinations.add({ destinationURL: url, name: name || ("URL_" + Date.now()) });
    } catch (eC) { return null; }
}

/**
 * Walk the captured records, verify each hyperlink is still present
 * in doc.hyperlinks AND its source range still points at the same
 * text. If a record was lost (hyperlink deleted by the pipeline) or
 * its source moved, recreate it at the captured coordinates.
 *
 * Returns stats { restored, recreated, missingSource, dropped }.
 */
function restoreDocHyperlinks(doc, captured, plog) {
    var stats = { checked: 0, present: 0, recreated: 0, missingSource: 0,
                  dropped: 0, droppedKeptOld: 0, droppedRemoved: 0 };
    if (!captured || !captured.length) return stats;
    for (var i = 0; i < captured.length; i++) {
        var rec = captured[i];
        if (!rec) continue;
        stats.checked++;

        var existing = _findHyperlinkByName(doc, rec.name);

        // 1) Non-text source: trust it survived as-is (recreate logic
        // doesn't yet handle Page / Text destinations or PageItem source).
        if (rec.srcKind !== "HyperlinkTextSource") {
            if (existing) { stats.present++; }
            else { stats.dropped++; stats.droppedKeptOld++; }
            continue;
        }

        // 2) Text-source health check: same story + same offsets?
        if (existing) {
            var ok = false;
            try {
                var st = existing.source && existing.source.sourceText;
                if (st) {
                    var loc = _resolveTextOffsetInStory(st);
                    if (loc.storyId === rec.storyId && loc.startIdx === rec.startIdx && loc.endIdx === rec.endIdx) {
                        ok = true;
                    }
                }
            } catch (eHe) {}
            if (ok) { stats.present++; continue; }
        }

        // 3) Either missing entirely OR existing source drifted.
        // P1.b fix: PRE-VALIDATE the replacement (range + destination +
        // hyperlinkTextSources.add) BEFORE removing the existing one.
        // The previous order was remove-first → recreate; if recreate
        // failed (unsupported destination kind, range out of bounds,
        // etc.) the original was gone with no rollback.

        // 3a) Resolve new range
        var story = _findStoryById(doc, rec.storyId);
        if (!story) {
            // Can't even find the story → keep the existing hyperlink
            // (drift is preferable to losing the link entirely).
            if (existing) { stats.dropped++; stats.droppedKeptOld++; }
            else { stats.missingSource++; }
            continue;
        }
        var newRange = null;
        try { newRange = story.characters.itemByRange(rec.startIdx, rec.endIdx); }
        catch (eIR) {}
        if (!newRange) {
            if (existing) { stats.dropped++; stats.droppedKeptOld++; }
            else { stats.missingSource++; }
            continue;
        }

        // 3b) Resolve / build destination (must be a kind we know how to recreate)
        var destObj = null;
        var destInfo = rec.destination || {};
        if (destInfo.kind === "HyperlinkURLDestination" && destInfo.url) {
            destObj = _ensureURLDestination(doc, destInfo.url, destInfo.name);
        }
        // TextDestination / PageDestination require re-targeting logic
        // we don't yet implement — keep the existing hyperlink rather
        // than destroy it.
        if (!destObj) {
            if (existing) { stats.dropped++; stats.droppedKeptOld++; }
            else { stats.dropped++; }
            continue;
        }

        // 3c) Try to create the new HyperlinkTextSource. Doing this
        // BEFORE removing the existing hyperlink gives us a chance to
        // bail out non-destructively. The new source object is created
        // immediately; if `hyperlinks.add(...)` fails below we'll need
        // to clean it up.
        var newSrc = null;
        try { newSrc = doc.hyperlinkTextSources.add(newRange, { name: (rec.name || "HL") + "_src" }); }
        catch (eSrc) {}
        if (!newSrc) {
            if (existing) { stats.dropped++; stats.droppedKeptOld++; }
            else { stats.dropped++; }
            continue;
        }

        // 3d) Try the actual hyperlink add. Use a temporary name so it
        // doesn't collide with the existing one (we'll rename after
        // removing the old). If this fails, remove the dangling source
        // and bail without touching the existing.
        var tmpName = (rec.name || "HL") + "_new_" + Date.now();
        var newH = null;
        try { newH = doc.hyperlinks.add(newSrc, destObj, { name: tmpName }); }
        catch (eAdd) {}
        if (!newH) {
            try { newSrc.remove(); } catch (eCleanup) {}
            if (existing) { stats.dropped++; stats.droppedKeptOld++; }
            else { stats.dropped++; }
            continue;
        }

        // 3e) New hyperlink confirmed live. NOW it is safe to remove
        // the old one (if any) and rename the new one to the captured
        // name. Order: remove first to free the name, then rename.
        if (existing) {
            try { existing.remove(); stats.droppedRemoved++; } catch (eRm) {}
        }
        try { newH.name = rec.name || tmpName; } catch (eRn) {}
        try { if (rec.visible !== undefined) newH.visible = !!rec.visible; } catch (eV) {}
        stats.recreated++;
    }
    if (plog) plog("hyperlinks: restored checked=" + stats.checked
        + " present=" + stats.present + " recreated=" + stats.recreated
        + " missingSource=" + stats.missingSource
        + " dropped=" + stats.dropped + " (keptOld=" + stats.droppedKeptOld
        + " removed=" + stats.droppedRemoved + ")");
    return stats;
}

module.exports = {
    captureDocHyperlinks: captureDocHyperlinks,
    restoreDocHyperlinks: restoreDocHyperlinks
};
