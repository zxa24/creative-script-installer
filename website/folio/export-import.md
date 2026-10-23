---
title: Export and import
description: Stage 2 for the designer. Export the text of a finished InDesign layout as a zip with 1.1 Export Translation Package, send it to the translator, get it back, import it into a copy of the original with 1.2 Import Translation Package, and check the result.
---

# Export and import

Stage 2 of [Translate a layout: for designers](/folio/designer). Do this when
the document is [ready to export](/folio/before-export).

## What to do {#what-to-do}

1. **Export the text.** Open the document. In the Scripts panel, double-click
   **1.1 Export Translation Package**. The dialog asks for the
   **Source language** (the language of this document) and the
   **Target language** (the language it is being translated into). Set both,
   then click **OK**. A `.zip` file appears in the **packages** folder next to
   your document.
   <!-- screenshot: export dialog -->
2. **Send the zip to the translator,** with this link:
   [Translate in the web app](/folio/translator). Tell them the target
   language, and whether they may use **Auto Translate** in the web app (it
   sends the text to Google).
3. **Get the translated zip back** from the translator.
4. **Import the translation.** For the first import, open the **original**
   document (not a file whose name ends in `.translated`). Double-click
   **1.2 Import Translation Package** and choose the translated zip. If InDesign
   asks about [missing fonts](#missing-fonts) or
   [missing links](#missing-links), fix them now; after that it runs on its
   own.
   <!-- screenshot: choosing the zip -->
5. **Check the result.** A new document named `<your document>.translated.indd`
   opens. Your original is not changed. If something needs fixing, a window
   lists each place with its page: **Show** takes you to it, and
   **How to fix** gives the steps ([more](#end-window)). Look through every
   page anyway, especially for
   [text that is too long for its frame](#text-too-long). Bold and italic come
   through only [where the translator marked them](#bold-italic-missing).

## Next

[3 Make the new language look right](/folio/fonts). For Chinese, Japanese or
Korean, run **2.2 Apply CJK Styles** once.

## Common problems

::: details The import refuses to run
The document you have open looks like a translated copy (its name ends in
`.translated`, `.aborted` or `.BLOCKED`) but it carries no record of an earlier
import, so the import cannot update it. For a first import, open the original
document instead. For a [later round](/folio/rounds#next-round), open the
`.translated.indd` that the import created.
:::

::: details A window lists places to fix after the import
<a id="end-window"></a>

The import opens this window only when something needs your attention. It
groups the places by problem, says what each problem means and what to do, and
lists each place with its page and the first words of its text.

- **Show** turns to that page and selects the frame or paragraph. The window
  stays open, so you can go through the list one by one.
- **How to fix**, where a problem has it, opens the steps inside the window,
  with the address of the matching section of this site to copy into a browser.
- **Open report** shows where the full report is saved, as text you can copy.
- **Done** closes the window.

There is no tick box for "fixed". Fix the places, then import again: a place
that is fixed no longer appears. If the import finds nothing to fix, no window
opens.
:::

::: details The import asks to replace the translated copy
<a id="replace-translated-copy"></a>

You ran the import on the original while a `.translated.indd` already exists.
Importing from the original starts over, so layout changes you made by hand in
that copy are lost.

- To update the copy instead, click **Cancel** (nothing is changed), then
  [open the `.translated.indd` and import there](/folio/rounds#next-round).
- To start over, click **Replace it**. A backup of the old copy is saved in
  **script_outputs → backup** first. If that backup cannot be made, the copy is
  not replaced.

If the translated copy is open with unsaved changes, or cannot be closed, the
import stops without changing anything. Save or close the copy, then run the
import again.
:::

::: details The import stopped part way
<a id="import-stopped"></a>

Most problems do not stop it: paragraphs it cannot find keep their original
text and are listed in its report. It does stop when CJK text would end up in a
font with no pair, and when it fails while writing. On a first import it then
deletes the half-made translated copy (if it had replaced an earlier copy, that
one is in **script_outputs → backup**); in a
[later round](/folio/rounds#next-round) it leaves the `.translated.indd` open
and unsaved. Fix what it reported and run it again the same way (from the
original for a first import, from the `.translated.indd` for a later round).
The full list is in its [report](#report-and-log). Problems it reports include
[missing fonts](#missing-fonts), [missing links](#missing-links) and
[a font with no pair](#font-has-no-pair).
:::

::: details InDesign says fonts are missing
<a id="missing-fonts"></a>

Fix them in the original document before you import, so the translated copy
opens with them. In InDesign's **Missing Fonts** dialog, click **Add** for a
font that Adobe Fonts has. Install any other font on your computer, or choose
**Type → Find/Replace Font** to replace it with one you have. If the dialog
appears during **1.2 Import Translation Package**, that is the one time the
import lets InDesign ask, and what you choose there is kept for the whole run.
:::

::: details InDesign says links are missing
<a id="missing-links"></a>

Relink them in the original document and save it before you import; the
translated copy is made from the saved file.
[3.3 Relink Missing Links](/folio/before-export#relink-missing-links) finds
files with the same name anywhere inside the document's folder. Relink the
others by hand: choose **Window → Links**, select a link marked with a red
question mark and click the **Relink** button. If InDesign asks about links
during the import, relink them the same way in the translated copy afterwards;
it is saved in the same folder as the original.
:::

::: details The import stopped because a font has no pair
<a id="font-has-no-pair"></a>

Chinese, Japanese or Korean text would have been set in a font that has no
characters for it and would show as empty boxes, so the import stopped. The
message names the font. Run the import again on the same document and, when the
font pairing panel opens, give that font a pair.
:::

::: details The import says the safety backup could not be made
<a id="backup-failed"></a>

This can happen in a [later round](/folio/rounds#next-round). The file on disk
was not overwritten, but the open document already holds the new translation,
unsaved. Do not save it under the same name: that would overwrite the file with
no backup. To keep the result, use **File → Save As** with a new name; to drop
it, close the document without saving. Make sure the folder next to the
document can be written to, then run the import again.
:::

::: details Some bold or italic did not come over
<a id="bold-italic-missing"></a>

Folio only applies formatting the translator marked in the web app. Ask the
translator to [mark it](/folio/translator#source-has-bold), or set it by hand in
InDesign. For bold on mixed Chinese and Latin text,
[2.3 Set Selection Weight](/folio/fonts#set-selection-weight) picks the right
font for each part.
:::

::: details Text is too long for its frame
<a id="text-too-long"></a>

A frame whose text does not fit shows a red plus sign at its lower right, and
**Window → Output → Preflight** lists every one. The import also checks for
this and lists each frame in the [window at the end](#end-window), where
**Show** selects it. Make the frame larger,
tighten the tracking a little, or ask the translator for a shorter wording.
:::

::: details The new language looks wrong
See [3 Make the new language look right](/folio/fonts): there are tools for
fonts across languages, Chinese typesetting, and protecting the layout during
big changes. Every script is listed in [All scripts](/scripts/).
:::

::: details Where is the previous translated version?
When you update a `.translated.indd` in a
[later round](/folio/rounds#next-round), the previous version is saved in
**script_outputs → backup** first. If you import into the original again and
choose to [replace the translated copy](#replace-translated-copy), the old copy
is saved there too. Before version 1.2, that replacement kept no copy.
:::

::: details Where are the report and the log?
<a id="report-and-log"></a>

In the **script_outputs** folder next to your document. The report of what
happened sits directly in that folder (a file named `post_import_check_` and the
date); the full run is in its **log** folder.
:::

::: details Technical details
<a id="export-translation-package"></a>**1.1 Export Translation Package**
(source `export_translation_package.idjs`)

It writes a package folder and a `.zip` of it, by default to
`<document folder>/packages/V<nn>D_<doc>_translation_package_<timestamp>`
(the dialog's **Output directory** field can point elsewhere).
The package carries, among other files:

| File | What it is |
| --- | --- |
| `preview.pdf` | The document as it stands, as a visual reference for the translator. |
| `segments.json` | Every translatable segment with its identity and context. |
| `translations_template.json` | The empty target side, which the translator fills in. |
| `tid_map.json` | The segment id to document position map used to put the text back. |
| `<doc>.idml` | An IDML copy of the document. |
| `manifest.json` | What the package contains, for round-trip integrity. |
| `emphasis_report.json` | The emphasis (bold, italic, colour) found in the source. |
| `import_state.json` | Only when exporting from an already imported document: the record of that import, which the web app uses to open in edit mode. |

<a id="import-translation-package"></a>**1.2 Import Translation Package**
(source `import_integrated.idjs`)

It accepts the package `.zip` (extracted for you) or a `translations.json`.

**First import (from the original).** In
order: the source is opened read-only and copied to `<doc>.translated.indd`,
which becomes the working document; one interactive moment to resolve
[missing fonts](#missing-fonts) or [links](#missing-links); a layout snapshot;
analysis (style plan, locating every segment, pre-flight); a pre-flight gate (from the Scripts panel it is overridden by default:
blocking findings are logged and reported, located segments are still written
and the rest keep their source text; [what to do](#import-stopped)); writing the text and applying
the style plan; post-flight checks for [overset text](#text-too-long), failed style
application and mixed runs; a repair pass; save in place, left open.

If a `.translated.indd` already exists, the import asks before anything is
closed or written ([what the user sees](#replace-translated-copy)). From
automation it refuses unless `automationOptions.replaceExistingTranslated` is
`true`. Before the file is replaced it is copied to `script_outputs/backup/`,
read back and compared (the same verified backup a later round makes); if that
fails, nothing is replaced. The import stops without changing anything when the
existing copy is open with unsaved changes, when it cannot tell whether the
file exists, or when an open copy does not close after four tries (versions
before 1.2 saved under a timestamped name in that case). An open, unmodified
copy at that path is closed without saving; a document with the same name in
another folder is left alone.

On failure the working document is closed and the half-written
`.translated.indd` deleted; when it had replaced an earlier copy, the report
gives the backup's path.

**The end window.** When the self-check or the final check found something to
fix, a window lists it, grouped by problem: text that does not fit a frame or a
table cell, paragraphs not updated, translated text missing from the page,
characters that may print as empty boxes, text that appears twice, an original
paragraph left on the page, written text that differs from the translation,
other final-check problems, and import errors. A bypassed preflight block is
listed only when the window opens for another reason. Located items get
**Show**. A clean run opens nothing; automated runs write the same lines to the
log instead. The wording and the problem list come from one table,
`lib/finish_problems.js`, which also decides whether the window opens.

**Later rounds (in-place update).** When the open document carries the record a
previous import wrote, the import works on that document itself instead of a
copy. Paragraph styles are not reassigned and unchanged paragraphs are skipped.
A paragraph whose only change is the translator's bold or italic counts as
changed. In changed paragraphs only the characters that differ are rewritten:
unchanged characters keep their direct formatting, character styles and local
fonts, and the translator's bold or italic moves with its text. Where bold or
italic sat on text that changed, it is listed in the report rather than placed
by position. When this cannot be done (the character count or the number of
anchored objects does not match, or the text has surrogate pairs), the whole
paragraph is rewritten and its direct formatting cleared, as in versions before
1.2, and the report lists the paragraph. Before saving, a verified copy of the
document is written to `script_outputs/backup/`; if that copy fails, the import
stops without saving. On a failure the document is left open and unsaved. The whole run happens in one open document with
one font-resolution state: an earlier design that saved, closed and reopened
between phases let silent font substitution diverge recomposition.

Guardrails: it refuses to import into a document named `.translated`,
`.aborted` or `.BLOCKED` that carries no import record (that would
double-apply the pipeline). Post-flight results stay in `report.json` and never
rename the file; passing does not certify the result and failing does not mean
it is unusable. Font pairing is handled during the import: when fonts need
pairing, the pairing panel opens as part of the run. Chinese, Japanese and
Korean composition settings are not set by the import; that is 2.2.

Formatting the translator did not mark is not carried over to the target. Reports land in
`script_outputs/` itself (`writeback_v2_report_<ts>.json`, `post_import_check_<ts>.md`), logs in `script_outputs/log/`; see
[Files and folders](/guide/folders).
:::
