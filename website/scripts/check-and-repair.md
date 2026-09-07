---
title: Group 3 — Check & Repair
description: Tools for checking and repairing a document — before/after snapshots, relinking missing links, highlighting what changed, and saving and revealing the file.
---

# Group 3 — Check & Repair

**These are tools, not steps.** Reach for one when something is broken, or when
you want to see what changed.

`3.1` and `3.2` are a **pair** — the first captures the state, the second
restores it. Run `3.1` *before* a bulk change and `3.2` *after*.

## 3.1 Snapshot Before Apply {#snapshot-before-apply}

*Source: `snapshot_before_apply.idjs`* — **pairs with [`3.2`](#repair-after-apply)**

**Captures a "before" snapshot of every repairable story, and expands frames
too short to hold CJK text.**

Run it **before** any bulk text replacement or CJK style application. It:

1. Expands geometry-split frames that are too short to hold a line of CJK text.
   Left alone, those frames come back empty after recomposition.
2. Captures a "before" snapshot of every repairable story.
3. Saves that snapshot twice — once as `before_snapshot_latest.json` and once
   as `<document name>_before_snapshot.json`.

[`3.2 Repair After Apply`](#repair-after-apply) reads that file and uses it as
the target state to restore.

## 3.2 Repair After Apply {#repair-after-apply}

*Source: `repair_after_apply.idjs`* — **pairs with [`3.1`](#snapshot-before-apply)**

**Reads the snapshot from `3.1`, repairs what the bulk change disturbed, and
writes an acceptance report.**

The intended sequence is:

1. [`3.1 Snapshot Before Apply`](#snapshot-before-apply) — save the "before"
   snapshot and expand the short frames.
2. Do the bulk change — text replacement, CJK style import, whatever it is.
3. `3.2 Repair After Apply` — read the snapshot, repair, and report.

## 3.3 Relink Missing Links {#relink-missing-links}

*Source: `relink_missing_from_doc_folder.idjs`*

**Finds broken links by filename anywhere under the document's own folder and
relinks them.**

For every link in the document whose status is *missing*, the script searches
**the document's folder and all of its subfolders** for a file of the same name,
matched case-insensitively. When it finds one, it relinks and updates. When it
does not, it **reports the link and leaves it alone** — it never guesses.

- **Shallow wins.** If the same filename appears in several places, the one
  closest to the document folder is taken first. That keeps it from grabbing a
  deep copy out of a packaged folder.
- **Missing only.** It handles broken links. A link whose file still exists but
  has been modified is an *Update*, not a relink, and is out of scope.
- **Dry run available.** It can report what it *would* relink without touching
  anything.
- **Undo:** all relinks are wrapped in one undo step.
- **Search limits:** it stops at 4000 directories or 12 levels deep, and says so
  when it hits a limit rather than silently truncating the search.
- **It writes** its report to `<document folder>/script_outputs/log/`, falling
  back to the document folder itself if that is unavailable.

## 3.4 Highlight Translation Changes {#highlight-translation-changes}

*Source: `track_translation_changes.idjs`*

**Diffs the text against a saved baseline and marks changed characters with
rectangles on a dedicated layer.**

The highlight is a **separate layer of yellow rectangles drawn behind the
text**. It has zero effect on the text's own properties — underlines, character
styles and everything else are untouched.

### Modes

| Mode | What it does |
| --- | --- |
| `auto` (default) | **First run:** captures a baseline, with no visible change to the document. **Later runs:** diffs every paragraph against the baseline character by character and marks the changed substrings. It always clears the previous overlay first, so stale marks never pile up. |
| `clear` | Deletes the highlight layer and everything on it. The baseline file is kept. |
| `rebaseline` | Clears the overlay, then re-captures the baseline as the new ground truth. |

### Options

- **Ignore whitespace** — suppresses highlights whose inserted or deleted
  characters are pure whitespace (space, tab, newline, non-breaking space,
  ideographic space). **Off by default**; turn it on when you only care about
  content edits and want post-translation whitespace shuffling ignored.
- **Baseline file** — pick which baseline JSON to diff against, either from the
  dropdown of files in the baselines folder or by giving an arbitrary path.
  Capture mode ignores this and always writes a fresh timestamped file.

### Surviving structural edits

The baseline is keyed positionally first — by story and paragraph index — which
is the fast path when the structure has not changed. When a paragraph's text
turns out to be wildly different from the baseline entry at that position (a
sign that paragraphs were added or removed and indices have shifted), it falls
back to matching on a content fingerprint. That is what keeps a document from
lighting up with false positives after "N paragraphs added between capture and
diff".

## 3.5 Save and Reveal {#save-and-reveal}

*Source: `save_and_reveal.idjs`*

**Offers to save the active document if it has unsaved changes, then opens its
folder in the system file browser.**

A small convenience: run it, answer the save prompt if one appears, and the
document's folder opens in Explorer or Finder.
