---
title: All scripts
description: The complete numbered index of every script the indesign-toolkit installer distributes, grouped into the normal workflow path and the tools reached for when needed.
---

# All scripts

Everything the installer puts into your Scripts panel, in one list.

**Group 1 is the normal path.** Groups 2, 3 and 4 are tools — you open them
because you have a specific problem, not because it is the next step.

## Group 1 — Workflow

The normal path. → [Details](/scripts/workflow)

| # | Script | One line |
| --- | --- | --- |
| `1.1` | [Export Translation Package](/scripts/workflow#export-translation-package) | Exports an offline translation package from the open document — preview PDF, segments, an empty translation template, and the id map. |
| `1.2` | [Import Translation Package](/scripts/workflow#import-translation-package) | Reads a translated package back into a fresh copy of the source document, applies the style plan, then runs post-flight checks and repair. |

## Group 2 — Type & Styles

Tools. Not part of the normal path. → [Details](/scripts/type-and-styles)

| # | Script | One line |
| --- | --- | --- |
| `2.1` | [Apply Font Pairing](/scripts/type-and-styles#apply-font-pairing) | Scans the document's fonts, opens a panel to pick cross-language font pairings, and applies the swaps as direct formatting — no new styles. |
| `2.2` | [Apply CJK Styles](/scripts/type-and-styles#apply-cjk-styles) | Imports the Simplified Chinese donor paragraph style and its composition settings into the document, after an optional text cleanup pass. |
| `2.3` | [Set Selection Weight](/scripts/type-and-styles#set-selection-weight) | Sets the selected text to a named weight, taking the concrete font and weight from the brand config, and routing mixed Han + Latin selections per script. |
| `2.4` | [Reorganize Styles](/scripts/type-and-styles#reorganize-styles) | Clusters every paragraph by its visual fingerprint and rebuilds the document on a small set of generated paragraph styles, in place. |
| `2.5` | [Repair Cluster GREP](/scripts/type-and-styles#repair-cluster-grep) | Rewrites the nested GREP rules in already-built cluster styles so neutral punctuation stops rendering on the wrong script's font. |
| `2.6` | [Convert Underline to Rule](/scripts/type-and-styles#convert-underline-to-rule) | Replaces fully-underlined paragraphs' character-level underline with a paragraph rule, so the line stays continuous across CJK and Latin. |

## Group 3 — Check & Repair

Tools. → [Details](/scripts/check-and-repair)

| # | Script | One line |
| --- | --- | --- |
| `3.1` | [Snapshot Before Apply](/scripts/check-and-repair#snapshot-before-apply) | Captures a "before" snapshot of every repairable story and expands frames too short to hold CJK text. Pairs with `3.2`. |
| `3.2` | [Repair After Apply](/scripts/check-and-repair#repair-after-apply) | Reads the snapshot from `3.1`, restores the layout state that the bulk change disturbed, and writes an acceptance report. Pairs with `3.1`. |
| `3.3` | [Relink Missing Links](/scripts/check-and-repair#relink-missing-links) | Finds broken links by filename anywhere under the document's own folder and relinks them; reports the ones it cannot find instead of guessing. |
| `3.4` | [Highlight Translation Changes](/scripts/check-and-repair#highlight-translation-changes) | Diffs the text against a saved baseline and marks changed characters with rectangles on a dedicated layer — no text properties touched. |
| `3.5` | [Save and Reveal](/scripts/check-and-repair#save-and-reveal) | Offers to save the active document if it has unsaved changes, then opens its folder in the system file browser. |

## Group 4 — Brand Presets

Tools. → [Details](/scripts/brand-presets)

| # | Script | One line |
| --- | --- | --- |
| `4.1` | [Export Brand Preset](/scripts/brand-presets#export-brand-preset) | Captures the tuned geometry of this document's generated paragraph styles into a brand preset file. Reads the document, never writes to it. |
| `4.2` | [Apply Brand Preset](/scripts/brand-presets#apply-brand-preset) | Applies a brand preset's geometry onto a sibling document's matching paragraph styles. Never touches fonts. |

## A note on undo

Most of these scripts wrap their whole run in a single InDesign undo step, so
one <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> reverts the entire batch rather
than one edit at a time. Where that is the case, the script's page says so.
