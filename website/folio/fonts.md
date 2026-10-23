---
title: "3 Make the new language look right"
description: Fix what a new language changes after 1.2 Import Translation Package. Pair fonts across languages, set Chinese line breaking and spacing, set the weight of selected text, repair punctuation that lands in the wrong font, turn a broken underline into a paragraph rule, and protect the layout during big changes.
---

# Make the new language look right

Stage 3 of [Translate a layout: for designers](/folio/designer). Use this page
after [**1.2 Import Translation Package**](/folio/export-import), when the
translated copy needs other fonts, proper Chinese typesetting, or a fix where
Chinese and Latin text meet.

These are free InDesign scripts from Creative Script Kit. You install them
once with one line ([Install](/guide/install)) and find them in the Scripts
panel under **User → indesign-toolkit-stable**
([where to find the scripts](/guide/install#where-to-find-the-scripts)).

**What the import already did:** it paired fonts across languages (the pairing
panel opens during the import when fonts need pairing). It did **not** set
Chinese, Japanese or Korean line breaking and spacing.

- **Chinese, Japanese or Korean:** run **2.2 Apply CJK Styles** once after the
  first import.
- **English or another Latin language:** you usually need nothing here.
- The other tools are for specific problems. Open the one that matches what you
  see.

## Fonts and Chinese typesetting

### 2.1 Apply Font Pairing {#apply-font-pairing}

Use it when you want to change which font goes with which across languages,
for example a different Chinese font to go with a Latin one. The import already
asked for pairings it needed; this is for changing them afterwards.

1. Open the translated document and double-click **2.1 Apply Font Pairing** in
   the Scripts panel.
2. A panel opens with the fonts the document uses. Set which font each one pairs
   with.
3. Click **Done**. A message says how many changes it made.

It changes the fonts directly on the text and creates no new paragraph or
character styles. The whole batch is one undo step. The same panel opens during
the import when fonts need pairing.

**Notifications.** What still needs your decision, and what is worth a look,
is collected under **Notifications** (the button at the top shows how many are
left to decide). **Decide all by recommendation** settles every one that has a
recommended choice. If you click **Done** while some are undecided, the panel
offers **Ignore and continue with recommendation**, or **Cancel** to go back and
choose yourself.

<a id="emphasis-lines"></a>**Bold and italic in your design's weights.** Where
the translator marked bold or italic, you can choose the weights it comes out
in. Drag from the small dot on the left of a pairing's card to the card of the
pairing it should become: for example from the Regular pairing to the Bold one,
and from Light to Medium. A line to a card of upright weights is a bold line; a
line to a card of italic weights is an italic line. The weight is chosen from
the paragraph's own text weight, and one line covers every language in the
pairing. Click a line to see what it does or to remove it; a red line has no
effect, and clicking it says why. Lines only change bold and italic that the
translator marked. Where no line is drawn, Folio chooses the bold weight
itself.

### 2.2 Apply CJK Styles {#apply-cjk-styles}

Use it when Chinese text needs Chinese line breaking and the other Chinese
typesetting settings.

1. Click into the text you want to set. With nothing selected, it works on the
   whole document.
2. Double-click **2.2 Apply CJK Styles**.
3. In the dialog, check the language and choose which cleanups to run, then
   click **OK**. The language starts at the one the document was translated
   into, and a line under the list says where that came from.

The cleanups only tidy the text the import wrote: paragraphs an import rewrote
and that nobody has edited since. Line breaks you added by hand stay, even when
you run 2.2 again. With text selected, only those paragraphs in the selected
story are cleaned. The dialog says what the cleanup will touch.

::: warning Documents imported before version 1.2
A document with no record of a 1.2 import (imported with an older version, or
never imported) is cleaned as a whole. Then **Remove soft line breaks** removes
every soft line break (Shift+Enter) in the **whole document**, even when you
selected one text frame. If you have placed line breaks by hand, untick it.
:::

It brings a ready-made Chinese paragraph style with its line-breaking and
typesetting settings into the document and applies it, and tells you clearly if
[those settings did not come through](#kinsoku-not-applied). It also protects the layout by itself:
text frames too short for a line of Chinese are made taller first, and the
layout is checked and repaired afterwards, so you do not need 3.1 and 3.2
around it. It is one undo step.

### 2.3 Set Selection Weight {#set-selection-weight}

Use it when selected text needs to be a certain weight, such as bold, in the
fonts set up for your brand, even when it mixes Chinese and Latin text.

1. Select the text.
2. Double-click **2.3 Set Selection Weight**.
3. Pick the weight in the dialog and click **OK**.

The Chinese and the Latin parts of the selection each get the right font for
that weight. If it cannot finish, it changes nothing and
[says why](#weight-stopped). It is one undo step.

### 2.5 Repair Cluster GREP {#repair-cluster-grep}

Use it when, in a document imported with an older version, punctuation between
Latin words (a curly apostrophe, for example) shows in the Chinese font.

1. Open the document.
2. Double-click **2.5 Repair Cluster GREP**. It asks nothing.

It updates the rules inside the document's generated paragraph styles that
decide which characters get the Latin font and which the Chinese font, then
refreshes the text. Running it again changes nothing. It is one undo step.
Documents imported with the current version do not need it.

### 2.6 Convert Underline to Rule {#convert-underline-to-rule}

Use it when a whole paragraph is underlined and the line breaks up: hidden
under Chinese characters, showing under Latin letters and digits.

1. Open the document.
2. Double-click **2.6 Convert Underline to Rule**. It asks nothing.
3. Read the summary it shows at the end.

For every paragraph whose visible text is fully underlined, it removes the
underline and draws a thin line under the paragraph instead, in the colour of
the underlined text. That line runs unbroken under both scripts. Paragraphs already
converted are skipped. It is one undo step.

## Protect the layout during big changes {#protect-the-layout}

**3.1** and **3.2** are a pair. Run 3.1 just before a big change you make by
hand, such as a find and replace across the document or editing a paragraph
style, and 3.2 just after it. **2.2 Apply CJK Styles** and the import already
do this themselves.

### 3.1 Snapshot Before Apply {#snapshot-before-apply}

Use it right before the big change.

1. Open the document and double-click **3.1 Snapshot Before Apply**.

It records the current state of the text so that 3.2 can restore it. It also
makes text frames taller where they are too short to hold a line of Chinese
text; left alone, those frames
[come back empty after the change](#frames-empty).

### 3.2 Repair After Apply {#repair-after-apply}

Use it right after the big change, when you ran 3.1 before it.

1. Double-click **3.2 Repair After Apply**.

It reads what 3.1 recorded, repairs what the change disturbed, and writes a
report of what it checked.

## Next

[4 Later rounds](/folio/rounds): when the translation changes after you
adjusted the layout.

## Common problems

::: details I closed the font pairing panel and nothing changed
Closing the panel without clicking **Done** makes no changes. Run
**2.1 Apply Font Pairing** again and finish with **Done**.
:::

::: details Text frames came back empty after a big change
<a id="frames-empty"></a>

Frames too short for a line of Chinese text empty out when the text is
recomposed. Undo the change, run **3.1 Snapshot Before Apply** (it makes those
frames taller first), make the change again, then run **3.2 Repair After Apply**.
2.2 Apply CJK Styles does this by itself.
:::

::: details 2.3 stopped with a message
<a id="weight-stopped"></a>

In rare or unclear cases it stops rather than guessing, and leaves the selection
as it was. Every stop is written to its log. The message says what to change.
The usual ones: select text with the Type tool, not a frame; select text that
uses one font for the Chinese and one for the Latin; install the font it names,
or pick a weight that is installed.
:::

::: details 2.2 says Kinsoku (line breaking) was not applied
<a id="kinsoku-not-applied"></a>

The ready-made Chinese style that comes with the scripts arrived without its
line-breaking rules, so lines may break in the wrong places. Paste the
[install line](/guide/install) again and choose **Repair**, which rewrites the
scripts' files, then run 2.2 again. If the message comes back, report it on
[GitHub](https://github.com/zxa24/creative-script-installer/issues).
:::

::: details Technical details
<a id="apply-font-pairing-details"></a>**2.1 Apply Font Pairing**
(source `font_apply_panel.idjs`)

1. It scans the active document and collects the fonts in use, their weights,
   and how much text each one carries.
2. It opens a panel inside InDesign where you set the pairings.
3. On **Done**, it applies the pairing-driven font swaps as direct format
   overrides. It does **not** create paragraph or character styles to do it.
4. It reports how many swaps landed.

**Undo:** the whole batch is wrapped in one undo step; a single
<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> reverts all of it.

<a id="apply-cjk-styles-details"></a>**2.2 Apply CJK Styles**
(source `cjk_style_apply.idjs`)

1. It asks which cleanup passes to run first. The dialog offers three, all on
   by default on every run (nothing is remembered): **Remove soft line breaks (Shift+Enter)**, **Collapse consecutive
   empty lines (spaces too)** and **Remove spaces between CJK and ASCII**. The
   cleanups act on the paragraphs that imports wrote and whose text has not
   changed since (each import adds them to a record in the document, and each
   cleanup rewrites the record from what it cleaned); with a selection,
   on those paragraphs in the selection's story only. With no such record (a
   document imported before 1.2, or never imported), or with
   `automationOptions.cleanupScope: "document"`, they run on the whole document
   and the selection is ignored. Soft line breaks in a header bar's product
   names, recognised the same way the import recognises them, are kept. The
   style merge follows the selection. "Remove spaces" matches Han characters
   only. The language list is zh-CN, zh-HK, zh-TW, ja and ko; it starts at the
   target language the import recorded in the document, or at zh-CN when none
   is recorded, and the dialog says which. The import (1.2) never runs these
   cleanups.
2. It works on either the story containing your selection, or on every
   repairable story in the document.
3. It opens the bundled CJK (Chinese, Japanese and Korean) donor document,
   imports its text styles into your document (this brings in the Chinese
   composition settings, including the kinsoku line-breaking set) and applies the donor paragraph style.
4. It verifies that the donor style actually arrived with its CJK settings
   intact, and says so loudly if the import came through broken.

**Undo:** the import and apply are wrapped in one undo step.

<a id="set-selection-weight-details"></a>**2.3 Set Selection Weight**
(source `set_selection_weight.idjs`)

Select text, pick a target weight, and the script resolves that weight name to
a concrete (font, weight) pair via the brand configuration and applies it.

- If the document does not already have a character style for that weight, the
  script creates one on the fly.
- A **mixed Han + Latin selection is routed per script**, so each half gets the
  right family, full-width punctuation included.
- Existing paragraph-level overrides are left alone; only character-level
  overrides in the selection are cleared.

**Failure behaviour:** it fails loudly, never silently. Rare or ambiguous cases
exit with a message, and every exit is logged. If applying fails, the whole
change is rolled back as one unit rather than leaving the selection half
changed.

<a id="repair-cluster-grep-details"></a>**2.5 Repair Cluster GREP**
(source `repair_cluster_grep.idjs`)

The problem it fixes: in a bilingual document built with the older rule set,
neutral punctuation (a curly apostrophe, U+2019, for instance) sitting between
Latin letters inside a Chinese-cluster document was left out of the Latin GREP,
so it stayed orphaned on the full-width CJK font.

This script rewrites the `grepExpression` of every managed cluster paragraph
style's nested Latin and CJK GREP rules to the current, context-aware patterns,
then recomposes so already-orphaned marks are re-routed.

- **It is a repair for documents already built with the old rules.** New imports
  get the current rules from the pipeline; they do not need this.
- **It is idempotent.** Re-running it rewrites nothing.
- **Undo:** one undo step for the whole run.

<a id="convert-underline-to-rule-details"></a>**2.6 Convert Underline to Rule**
(source `convert_underline_to_rule.idjs`)

It scans every paragraph in every story and finds the ones where **100% of the
visible characters** carry character-level `underline = true`. For each, it
removes the character-level underline and puts a paragraph-level rule below
instead: 0.5pt, text width, coloured from the majority fill colour of the
underlined characters.

**Why:** a character-level underline tracks each glyph's own baseline. CJK
glyphs hide the line under their body while Latin characters and digits expose
it, so a mixed line gets a half-drawn underline. A paragraph rule sits at the
paragraph baseline and stays continuous across both scripts.

- It lives outside the import pipeline on purpose, so the import stays
  format-neutral and **you** decide when to apply this visual change.
- **It is idempotent.** Paragraphs already converted are skipped.
- **It writes** a log to `<document folder>/convert_underline_to_rule_<timestamp>.log`.

<a id="snapshot-before-apply-details"></a>**3.1 Snapshot Before Apply**
(source `snapshot_before_apply.idjs`; pairs with 3.2)

Run it **before** any bulk text replacement or CJK style application. It:

1. Expands geometry-split frames that are too short to hold a line of CJK text.
   Left alone, those frames come back empty after recomposition.
2. Captures a "before" snapshot of every repairable story.
3. Saves that snapshot twice: once as `before_snapshot_latest.json` and once
   as `<document name>_before_snapshot.json`.

3.2 Repair After Apply reads that file and uses it as the target state to
restore.

<a id="repair-after-apply-details"></a>**3.2 Repair After Apply**
(source `repair_after_apply.idjs`; pairs with 3.1)

Reads the snapshot from 3.1, repairs what the bulk change disturbed, and writes
an acceptance report. The intended sequence is:

1. 3.1 Snapshot Before Apply: save the "before" snapshot and expand the short
   frames.
2. Do the bulk change: text replacement, CJK style import, whatever it is.
3. 3.2 Repair After Apply: read the snapshot, repair, and report.
:::
