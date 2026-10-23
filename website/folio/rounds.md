---
title: Later rounds
description: Stage 4 for the designer. When the client or reviewer changes the translation after you adjusted the layout, update the translated document you adjusted instead of starting again, and use 3.4 Highlight Translation Changes to mark every changed character without touching the text.
---

# Later rounds

Stage 4 of [Translate a layout: for designers](/folio/designer). Use this page
when the client or reviewer changes the translation after you have adjusted the
layout, and to see, or show a reviewer, exactly what changed since the last
round.

These are free InDesign scripts from Creative Script Kit. You install them
once with one line ([Install](/guide/install)) and find them in the Scripts
panel under **User → indesign-toolkit-stable**
([where to find the scripts](/guide/install#where-to-find-the-scripts)).

## The next round of changes {#next-round}

Do **not** start again from the original. Update the translated document
instead:

1. **Open your `.translated.indd`** (the one you adjusted) and capture a
   baseline before you change anything. Double-click
   **3.4 Highlight Translation Changes**, choose **Capture baseline** and click
   **OK**. Nothing visible changes. Then run
   **1.1 Export Translation Package** on it and send the new zip to the
   translator.
2. **The translator edits the existing text** in the web app. Paragraphs they do
   not touch stay exactly as they are.
3. **Open the same `.translated.indd`** and run
   **1.2 Import Translation Package** with the new zip. It updates this document
   itself; no new copy is made. A copy of the previous version is saved first in
   **script_outputs → backup** (if that copy fails, see
   [The import says the safety backup could not be made](/folio/export-import#backup-failed)).
4. **Mark and check the paragraphs that changed.** Run
   **3.4 Highlight Translation Changes** again, choose **Highlight changes**,
   pick the starting point you saved from the list, and click **OK**. Tick
   **Ignore whitespace differences** if only the wording matters to you. Your
   other adjustments stay. Inside a changed paragraph, only the words the
   translator changed are rewritten, so formatting you set by hand on the rest
   (tracking or no-break, for example) stays. Check the changed words
   themselves.
5. **Delete the highlight layer before you export the final PDF.** In the
   Layers panel, delete the layer named **_T_translation_highlights**. The
   marks are ordinary page items, so otherwise they print in it.

::: warning Do not import a later round into the original
<a id="next-round-warning"></a>That starts over and replaces the
`.translated.indd` you adjusted, and all your layout work in it is lost. The
import [asks before it does this](/folio/export-import#replace-translated-copy):
click **Cancel** and open the `.translated.indd` instead. If you do replace it,
the old copy is saved in **script_outputs → backup** first.
:::

## 3.4 Highlight Translation Changes {#highlight-translation-changes}

Use it when you need the edited text marked, for example in a PDF that goes back
to the reviewer. It has two choices: **Capture baseline** saves the text as it
stands, and **Highlight changes** marks what changed since a baseline you saved.

- Capture a baseline before you change anything: right after the first
  import, and again at the start of each later round (step 1 above). Edits
  made before you capture it cannot be marked later.
- Changed text gets a yellow box, and a place where text was deleted gets a red
  mark. The marks sit on their own layer, behind the text; the text itself is
  not changed in any way.
- Each new **Highlight changes** run clears the old marks first, so they never
  pile up.
- To remove the marks when you no longer need them, delete the layer named
  **_T_translation_highlights** in the Layers panel. The marks are ordinary
  page items, so they show in a PDF you export.

## Next

[5 Sister documents](/folio/sister-documents): copy tuned paragraph-style
settings to a sister document.

## Common problems

::: details Highlight changes is not available
There is no starting point yet. Run it once with **Capture baseline** first.
:::

::: details Will adding or removing paragraphs make everything light up?
No. When paragraphs have moved, it matches each one by its content instead of
its position, so only the real changes are marked.
:::

::: details Spaces and line breaks are marked too
That is the default. Run **Highlight changes** again with
**Ignore whitespace differences** ticked.
:::

::: details Technical details
<a id="highlight-translation-changes-details"></a>**3.4 Highlight Translation Changes**
(source `track_translation_changes.idjs`)

The highlight is a **separate layer of yellow rectangles drawn behind the
text**. It has zero effect on the text's own properties: underlines, character
styles and everything else are untouched.

From the Scripts panel the dialog offers **Capture baseline** (the `rebaseline`
mode below) and **Highlight changes** (a diff against the chosen baseline). The
modes are how automation drives it:

| Mode | What it does |
| --- | --- |
| `auto` (default) | **First run:** captures a baseline, with no visible change to the document. **Later runs:** diffs every paragraph against the baseline character by character and marks the changed substrings. It always clears the previous overlay first, so stale marks never pile up. |
| `clear` | Deletes the highlight layer and everything on it. The baseline file is kept. |
| `rebaseline` | Clears the overlay, then re-captures the baseline as the new ground truth. |

**Options**

- **Ignore whitespace:** suppresses highlights whose inserted or deleted
  characters are pure whitespace (space, tab, newline, non-breaking space,
  ideographic space). **Off by default**; turn it on when you only care about
  content edits and want post-translation whitespace shuffling ignored.
- **Baseline file:** pick which baseline JSON to diff against, either from the
  dropdown of files in the baselines folder or by giving an arbitrary path.
  Capture mode ignores this and always writes a fresh timestamped file.

Baselines are saved in `<document folder>/script_outputs/baseline_snapshots/`.

**Surviving structural edits**

The baseline is keyed positionally first, by story and paragraph index, which
is the fast path when the structure has not changed. When a paragraph's text
turns out to be wildly different from the baseline entry at that position (a
sign that paragraphs were added or removed and indices have shifted), it falls
back to matching on a content fingerprint. That is what keeps a document from
lighting up with false positives after "N paragraphs added between capture and
diff".

For what the import does in a later round (in-place update, the backup, what
is rewritten in changed paragraphs), see the technical details of
[1.2 Import Translation Package](/folio/export-import#import-translation-package).
:::
