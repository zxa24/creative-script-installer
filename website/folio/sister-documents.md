---
title: Sister documents
description: Copy tuned paragraph-style settings from one InDesign document to a sister document without redoing them by hand. 4.1 Export Brand Preset saves the settings; 4.2 Apply Brand Preset applies them. Fonts are never changed.
---

# Sister documents

Stage 5 of [Translate a layout: for designers](/folio/designer). Use this page
when you tuned the paragraph styles of one document over several rounds and a
sister document needs to match, without redoing the work by hand.

These are free InDesign scripts from Creative Script Kit. You install them
once with one line ([Install](/guide/install)) and find them in the Scripts
panel under **User → indesign-toolkit-stable**
([where to find the scripts](/guide/install#where-to-find-the-scripts)).

A sister document is another document in the same family as the one you
tuned, for example the same fact sheet for a different product, laid out with
the same styles.

**4.1** saves the settings from the document you tuned. **4.2** applies them to
the sister document. Both work on the paragraph styles that Folio's import or
[**2.4 Reorganize Styles**](/folio/before-export#reorganize-styles) created, and
neither ever changes fonts. To check
that a document has them, open the Paragraph Styles panel: their names start
with `_T_p_`.

## 4.1 Export Brand Preset {#export-brand-preset}

Use it in the document whose paragraph styles you have tuned.

1. Save the document. The settings file is written next to it.
2. Double-click **4.1 Export Brand Preset** in the Scripts panel. It asks
   nothing.

It saves each style's size, line spacing, indents, space before and after,
alignment, colour and rules into a settings file (a brand preset) named
`brand_style_preset.json`. If a brand configuration file next to the document
names the brand, the brand name goes in front:
`<brand>_brand_style_preset.json`. It only reads the document and changes
nothing in it.

## 4.2 Apply Brand Preset {#apply-brand-preset}

Use it in the sister document that should match.

1. Save the sister document, and make sure the preset file from 4.1 is in the
   same folder. If the two documents share a folder, it already is. 4.2 looks
   in its own document's folder for a file whose name ends in
   `_brand_style_preset.json`, and uses `brand_style_preset.json` only if there
   is none. If there are several, it takes the one for this document's brand,
   or else the newest, and says so in its log. Keep only the one you want in
   that folder.
2. Double-click **4.2 Apply Brand Preset**. It asks nothing.
3. Check its report in the **log** folder inside **script_outputs**, next to
   the document. If some settings did not carry over, see
   [below](#settings-not-carried).

It updates the matching paragraph styles with the saved settings. Fonts are
never touched. It is one undo step.

Hand changes in the sister document are kept for size, line spacing, indents,
keep options, alignment and composer, and listed in the report. Space before
and after, colour and rules are always overwritten with the preset's values.

## Common problems

::: details 4.2 says no preset was found
The preset file is not in the sister document's folder, or the document has
never been saved. Copy the file from the first document's folder and run it
again. Nothing was changed.
:::

::: details Some settings did not carry over
<a id="settings-not-carried"></a>

A size, line spacing, indent, keep option, alignment or composer that someone
changed by hand in the sister document is kept and listed as kept local. Space
before and after, colour and rules are always written; a colour or rule that
did not take is listed as failed. It never hides either case.
:::

::: details The report says the styles were reused, but not everything changed
"Reused" only means a style found its match. Read it together with the applied
rate, the kept local count and the failed count.
:::

::: details Technical details
<a id="export-brand-preset-details"></a>**4.1 Export Brand Preset**
(source `export_brand_style_preset.idjs`)

It reads the active document's `_T_p_*` paragraph-style definitions and writes
their geometry into a preset file:

- point size and leading
- indents and space before / space after
- justification and composer
- fill colour
- rules above and below

**It is read-only on the document.** It builds a preset *from* the styles; it
does not modify them. The one undo-block it opens exists only to hold a
consistent points-based measurement context while reading numbers, and to give
a clean single-undo boundary; nothing is written to the document.

**Output:** next to the saved `.indd`, plus a summary log. The file is
`<brand>_brand_style_preset.json` when a `<document name>_brand_config.json` or
`brand_config.json` beside the document gives a brand name, otherwise
`brand_style_preset.json`.

<a id="apply-brand-preset-details"></a>**4.2 Apply Brand Preset**
(source `apply_brand_style_preset.idjs`)

It loads a `brand_style_preset.json` captured by 4.1 and writes its tuned
geometry onto the active document's matching `_T_p_*` paragraph-style
**definitions**.

**It never touches fonts.** `appliedFont` and `fontStyle` are out of scope, by
design.

**How it finds the preset**

1. An explicitly given path, used verbatim.
2. Otherwise, `<saved document folder>/*_brand_style_preset.json`. With
   several matches it prefers the one named for this document's brand, then
   the newest by modification date, and logs the choice as ambiguous.
3. Otherwise, `<saved document folder>/brand_style_preset.json`.
4. If none of these turns one up, it reports "no preset found" and exits
   cleanly; that is not treated as an error.

**What happens when the target document disagrees**

Conflicts are resolved per dimension, not per style.

**Protected dimensions** (point size, leading, indents, keep options,
justification, composer) are reconciled three ways against what was last
applied and what the style was created with:

| The live value is… | Result |
| --- | --- |
| the same as what was last applied | safe to update: take the preset's value |
| the same as the creation baseline (never touched locally) | take the preset's value |
| different from both (someone tuned it locally) | **keep the local value** and report it |

**Always-apply dimensions** (space before / space after, fill colour, rules
above and below) have no reconstructable creation baseline, so the preset's
value is always written. The colour and rule writes are then **read back and
verified**, and reported as applied-OK or applied-FAILED. A write that silently
did not land is reported, not swallowed.

All of it is applied in one undo step. The coverage report is written to the
log folder (`script_outputs/log/`).

**Reading the report**

The headline number is **reuse rate**: matched styles divided by total. A style
counts as matched even if one of its dimensions was kept local or failed to
apply.

Three separate counts sit next to it so "reuse" is never misread as "everything
transferred":

- **applied rate**
- **kept-local count**
- **applied-failed count**

Read all four together.
:::
