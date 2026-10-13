---
title: More tools
description: Tools in Creative Script Kit that are not part of the translation workflow. In InDesign, 3.5 Save and Reveal saves the document and opens its folder. In Illustrator, five tools for everyday chores, Unembed All Images, Export Artboard PDFs, Export Small PDF, Replace Fonts, and CJK Composer and Mojikumi, with when to use each and what to answer.
---

# More tools

These tools are not part of the translation workflow: each one does an
everyday job on its own. You install them with the other scripts, with one line
([Install](/guide/install)).

## InDesign {#indesign}

Find it in the Scripts panel under **User → indesign-toolkit-stable**
([where to find the scripts](/guide/install#where-to-find-the-scripts)).

### 3.5 Save and Reveal {#save-and-reveal}

Use it when you want to save the document and open the folder it is in.

1. Double-click **3.5 Save and Reveal** in the Scripts panel.
2. If the document has unsaved changes, it asks whether to save it. For a
   document that has never been saved, saying yes opens the Save As dialog.

It saves only when you say yes, then opens the document's folder in Explorer or
Finder.

## Illustrator {#illustrator}

Five small tools for everyday chores in Illustrator, found under
**File → Scripts → illustrator-toolkit-stable**.

### Unembed All Images {#unembed-all-images}

Use it when a file has images embedded in it and you want them as separate,
linked files, or when you want to clear out broken links.

1. Save the document, then choose
   **File → Scripts → illustrator-toolkit-stable → Unembed All Images**.
2. The *Asset Management* window shows how many embedded images and broken
   links it found. Tick what you want: export the embedded images and relink
   them, remove the broken links, or both. **Change...** picks another output
   folder.
3. Click **Run** and read the summary.

It writes one file per embedded image into a new **Linked_assets** folder next
to the document (or **Linked_assets_1**, and so on, if that name is taken), and
links the artwork to those files.

### Export Artboard PDFs {#export-artboard-pdfs}

Use it when each artboard needs to be its own PDF.

1. Save the document, then choose
   **File → Scripts → illustrator-toolkit-stable → Export Artboard PDFs**.
2. If the document has broken links, choose what to do with them: relink them
   from a folder, skip them during export, delete them from the document, or
   cancel.
3. In *Export Artboards as PDF*, tick **PDF**, **Print PDF** (with bleed) or
   **.ai File**, pick a PDF preset, and click **Export**.

It writes one file per artboard, named after the artboard, into a new folder
next to the document whose name ends in `_export`, then opens that folder. To
change the file names, rename the artboards in the Artboards panel first.

### Export Small PDF {#export-small-pdf}

Use it to finish a job in one click: export the smallest PDF, the largest PDF,
save the document and package it, in any combination.

1. Save the document, then choose
   **File → Scripts → illustrator-toolkit-stable → Export Small PDF**.
2. In *Quick Actions*, tick what you want: **Export smallest PDF** (ticked by
   default), **Export largest PDF**, **Save document**, **Package**.
3. Click **OK**.

The PDFs go next to the document as `<name>_smallest.pdf` and
`<name>_highquality.pdf` (a number is added if the file exists), and the
folder opens. **Package** opens Illustrator's own Package dialog at the end.

::: warning Save first
To export, it closes your document and opens it again from disk. Changes you
have not saved are not kept in the `.ai` file, so save first or tick
**Save document**.
:::

### Replace Fonts {#replace-fonts}

Use it when one font has to be replaced by another across a whole file or a
selection.

1. Choose **File → Scripts → illustrator-toolkit-stable → Replace Fonts**.
2. Click **+ Add** and pick a *From* font and a *To* font for each row. Type
   in **Filter** and click **Search** to narrow the font lists.
3. Under **Scope**, choose **Whole document** or **Selection only**, then
   click **Replace**.

It changes the fonts in the document and reports how many characters it
replaced. **Save rules** and **Load rules** keep a list of pairs for next time.
To reverse it, use **Edit → Undo**.

### CJK Composer and Mojikumi {#cjk-composer-and-mojikumi}

Use it when Chinese or Japanese text needs CJK (Chinese, Japanese and Korean)
typesetting: the CJK composer, a Mojikumi set (spacing rules between
characters) and a Kinsoku set (rules for which characters may not start or end
a line).

1. Select the text frames to work on, or select nothing to work on every text
   frame.
2. Choose
   **File → Scripts → illustrator-toolkit-stable → CJK Composer and Mojikumi**.
3. If something is selected, it asks a question: **OK** works on the selected
   text frames only. If it finds spaces between CJK and Latin text, it lists
   them: **OK** removes them, **Cancel** keeps them.

::: warning Cancel does not stop the script
In the first question, **Cancel does not stop the script**. It means "work on
every text frame in the document". There is no way to stop it at that
question. To work on your selection only, click **OK**; to reverse a run, use
**Edit → Undo**.
:::

It sets the composer, Mojikumi and Kinsoku on each paragraph, adds a little
space where CJK text meets Latin letters or digits, and tightens full-width
punctuation in text frames that overflow. Locked and hidden text frames are
skipped. A summary lists what it set.

## Common problems

::: details An Illustrator tool says "No document open"
Every Illustrator tool needs an open document. Open the file and run it again.
:::

::: details An Illustrator tool asks me to save first
Unembed All Images, Export Artboard PDFs and Export Small PDF write files next
to the document, so it must have been saved once. Save it and run the tool
again.
:::

::: details I lost changes after Export Small PDF
It closes the document and opens it again from disk to export. Anything not
saved before that is not in the `.ai` file. Next time, save first or tick
**Save document**.
:::

::: details Replace Fonts says nothing is selected
**Scope** is set to **Selection only**. Select a text frame or group with the
Selection tool, or select text with the Type tool, and run it again. Or choose
**Whole document**.
:::

::: details Replace Fonts says the same From font appears in more than one row
Each *From* font can appear in one row only. Remove or merge the duplicate
rows and click **Replace** again.
:::

::: details The bleed I typed in Export Artboard PDFs is gone next time
The bleed values are stored in the document. Save the document after the
export to keep them.
:::

::: details The summary says Mojikumi or Kinsoku "(not set / not found)"
The document has no Mojikumi or Kinsoku set to use, so that part was skipped.
The other settings were still applied.
:::

::: details Technical details
Most people never need to change these.

<a id="save-and-reveal-details"></a>**3.5 Save and Reveal**
(source `save_and_reveal.idjs`)

Offers to save the active document if it has unsaved changes, then opens its
folder in the system file browser. A small convenience: run it, answer the save
prompt if one appears, and the document's folder opens in Explorer or Finder.

<a id="illustrator-details"></a>**Illustrator tools: undo and files.** Changes
to the document go through Illustrator's own undo. Files a tool writes (PDFs,
images, `.ai` copies) stay on disk; Undo does not remove them. All five tools
stop with a message when no document is open.

**Unembed All Images**

The default output folder is `<document folder>/Linked_assets`, or
`Linked_assets_<n>` if that folder exists. If there is nothing embedded and no
broken link, it says so and stops.

**Export Artboard PDFs**

- Each artboard is exported by duplicating it into a new document, so nothing
  from the other artboards gets in.
- PDF presets offered: `[Smallest File Size]`, `[High Quality Print]`,
  `[Press Quality]`, `[PDF/X-1a:2001]`, `[PDF/X-4:2008]`.
- Output folder: `<document folder>/<YYYYMMDD>_<HHMM>_export`. Files:
  `<artboard>.pdf`, `<artboard>_print.pdf` (with marks and bleeds) and
  `<artboard>.ai`. A log is saved in the same folder.
- Bleed units: mm, pt, in or px (default 0.125 in). The values are stored in a
  hidden page item named `__ExportArtboardPDFs__`.

**Export Small PDF**

The smallest PDF uses the `[Smallest File Size]` preset and the largest uses
`[High Quality Print]`. **Save document** runs first, then the PDFs, then
**Package** (`File → Package`).

**Replace Fonts**

Options in the window: **List all fonts in the From menu** (off by default;
otherwise only the fonts in use), **Grow frames that overset after replacing**
(on by default; it reports how many it fixed and how many still overflow) and
**Halfwidth characters only (Latin, digits, punctuation)** (off by default),
which leaves CJK text on its current font.

**CJK Composer and Mojikumi: settings at the top of the script**

The `.jsx` file in the **illustrator-toolkit-stable** folder starts with a
block of settings. An update replaces the file, so edits there do not survive
an update.

| Setting | Default | What it does |
| --- | --- | --- |
| `COMPOSER_MODE` | `"paragraph"` | Every-line composer; `"single"` for the single-line composer. |
| `SET_MOJIKUMI`, `SET_KINSOKU` | `true` | Whether to set a Mojikumi and a Kinsoku set. |
| `MOJIKUMI_NAME`, `KINSOKU_NAME` | `""` | The set to use, by name. Empty: the first set whose name contains 简体, 繁体, 中文, Chinese, JIS, 日本 or Japanese, or else the first set the document has. |
| `ENABLE_BURASAGARI`, `BURASAGARI_MODE` | `true`, Standard | Hanging punctuation at the line end. |
| `ENABLE_BUNRIKINSHI` | `true` | Keeps certain character pairs from being split. |
| `TSUME_PERCENT` | `null` | Tightens every character by this percentage; `null` leaves it alone. |
| `ENABLE_PUNCTUATION_SQUEEZE`, `PUNCTUATION_TSUME` | `true`, `50` | Tightens full-width punctuation, only in area text frames that overflow. |
| `ENABLE_CJK_LATIN_SPACING`, `CJK_LATIN_AKI` | `true`, `25` | Space where CJK text meets Latin letters or digits, as a percentage of a full-width character. |
| `ENABLE_REMOVE_CJK_LATIN_SPACES` | `true` | Offers to remove typed spaces between CJK and Latin text. |

Whether it works on the selection or the whole document is not a setting: it
comes from the first question, and with nothing selected it always works on
every text frame.
:::
