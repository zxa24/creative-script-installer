---
title: Group 2 — Type & Styles
description: Tools for typography and style sheets — font pairing, CJK styles, selection weight, style reorganization, cluster GREP repair, and underline-to-rule conversion.
---

# Group 2 — Type & Styles

**These are tools, not steps.** Nothing here is part of the
[normal path](/guide/workflow). Open one because the document has a specific
typographic problem.

## 2.1 Apply Font Pairing {#apply-font-pairing}

*Source: `font_apply_panel.idjs`*

**Scans the document's fonts, opens a panel to pick cross-language font
pairings, and applies the swaps as direct formatting.**

1. It scans the active document and collects the fonts in use, their weights,
   and how much text each one carries.
2. It opens a panel inside InDesign where you set the pairings.
3. On **Done**, it applies the pairing-driven font swaps as direct format
   overrides. It does **not** create paragraph or character styles to do it.
4. It reports how many swaps landed.

**Undo:** the whole batch is wrapped in one undo step — a single
<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> reverts all of it.

## 2.2 Apply CJK Styles {#apply-cjk-styles}

*Source: `cjk_style_apply.idjs`*

**Imports the Simplified Chinese donor paragraph style and its composition
settings into the document, after an optional text cleanup pass.**

1. It asks which cleanup passes to run first — soft line breaks, stray spaces,
   symbol/full-width punctuation, collapsing.
2. It works on either the story containing your selection, or on every
   repairable story in the document.
3. It opens the bundled CJK donor document, imports its text styles into your
   document — this brings in the Chinese composition settings, including the
   kinsoku line-breaking set — and applies the donor paragraph style.
4. It verifies that the donor style actually arrived with its CJK settings
   intact, and says so loudly if the import came through broken.

**Undo:** the import and apply are wrapped in one undo step.

::: tip Source note
This script carries no header comment; the description above is read off its
implementation rather than off a stated summary.
:::

## 2.3 Set Selection Weight {#set-selection-weight}

*Source: `set_selection_weight.idjs`*

**Sets the selected text to a named weight, taking the concrete font and weight
from the brand config.**

Select text, pick a target weight, and the script resolves that weight name to
a concrete (font, weight) pair via the brand configuration and applies it.

- If the document does not already have a character style for that weight, the
  script creates one on the fly.
- A **mixed Han + Latin selection is routed per script**, so each half gets the
  right family — full-width punctuation included.
- Existing paragraph-level overrides are left alone; only character-level
  overrides in the selection are cleared.

**Failure behaviour:** it fails loudly, never silently. Rare or ambiguous cases
exit with a message, and every exit is logged. If applying fails, the whole
change is rolled back as one unit rather than leaving the selection half
changed.

## 2.4 Reorganize Styles {#reorganize-styles}

*Source: `reorganize_styles_inplace.idjs`*

**Clusters every paragraph by its visual fingerprint and rebuilds the document
on a small set of generated paragraph styles, in place.**

Use it when a document has sprawled into hundreds of near-identical paragraph
styles, or into paragraphs held together by local overrides.

What it does:

- Walks every paragraph in every story and captures its *effective* visual
  properties — font, size, colour, leading, indents, spacing, keep options,
  bullets, and so on.
- Clusters paragraphs by that visual fingerprint.
- Creates one `_T_p_<hash>` paragraph style per cluster with those properties
  baked in. N paragraphs typically collapse to a much smaller number of styles.
- Reassigns each paragraph to its cluster's canonical style.

What it does **not** do:

- No source file picker — it reads the active document.
- No output file — it modifies the active document in place.
- **No CJK font policy.** It preserves the original Latin font family. This is
  pure style consolidation, not translation preparation.

How a run goes:

1. Open the document you want to consolidate.
2. Double-click the script.
3. Choose grouping options in the one dialog it opens — dimensions, colour
   tolerance, auto-merge preset, safety, soft-break handling, edit mode.
   **Cancel aborts cleanly with no changes.**
4. Wait. There are no further prompts.
5. An alert summarises the result. Read the warnings.
6. Inspect the document, then either save it or undo.

**Undo:** the whole reorganization — pre-flight, apply and repair — is one undo
step.

**It also writes:** a progress log next to the document
(`<doc>_reorganize_progress_<timestamp>.log`) for post-mortem triage, and, when
safety is on, a before-snapshot used by the post-flight repair.

## 2.5 Repair Cluster GREP {#repair-cluster-grep}

*Source: `repair_cluster_grep.idjs`*

**Rewrites the nested GREP rules in already-built cluster styles so neutral
punctuation stops rendering on the wrong script's font.**

The problem it fixes: in a bilingual document built with the older rule set,
neutral punctuation — a curly apostrophe (U+2019), for instance — sitting
between Latin letters inside a Chinese-cluster document was left out of the
Latin GREP, so it stayed orphaned on the full-width CJK font.

This script rewrites the `grepExpression` of every managed cluster paragraph
style's nested Latin and CJK GREP rules to the current, context-aware patterns,
then recomposes so already-orphaned marks are re-routed.

- **It is a repair for documents already built with the old rules.** New imports
  get the current rules from the pipeline; they do not need this.
- **It is idempotent.** Re-running it rewrites nothing.
- **Undo:** one undo step for the whole run.

## 2.6 Convert Underline to Rule {#convert-underline-to-rule}

*Source: `convert_underline_to_rule.idjs`*

**Replaces fully-underlined paragraphs' character-level underline with a
paragraph rule.**

It scans every paragraph in every story and finds the ones where **100% of the
visible characters** carry character-level `underline = true`. For each, it
removes the character-level underline and puts a paragraph-level rule below
instead — 0.5pt, text width, coloured from the majority fill colour of the
underlined characters.

**Why:** a character-level underline tracks each glyph's own baseline. CJK
glyphs hide the line under their body while Latin characters and digits expose
it, so a mixed line gets a half-drawn underline. A paragraph rule sits at the
paragraph baseline and stays continuous across both scripts.

- It lives outside the import pipeline on purpose, so the import stays
  format-neutral and **you** decide when to apply this visual change.
- **It is idempotent.** Paragraphs already converted are skipped.
- **It writes** a log to `<document folder>/convert_underline_to_rule_<timestamp>.log`.
