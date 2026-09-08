---
title: Illustrator scripts
description: The five Illustrator tools the installer carries — Unembed All Images, Export Artboard PDFs, Export Small PDF, Replace Fonts, CJK Composer and Mojikumi — what each asks, what each writes, and where.
---

# Illustrator scripts

Five tools, installed only when Illustrator is on the machine, under
**File → Scripts → illustrator-toolkit-stable**. They are not numbered: each
stands alone, and none of them is part of the InDesign translation path.

All five refuse to run with no document open. Three of them also need the
document to have been **saved** first, because they write next to it.

::: tip Undo
Illustrator's own undo applies. Scripts that write files (the three export
tools) cannot un-write them — the files stay where they were put.
:::

## Unembed All Images

Turns embedded images back into linked files.

- **Asks:** a dialog headed *Asset Management* showing how many embedded images
  and how many broken links it found, with two checkboxes — export the embedded
  images and relink them as external files; remove all broken links — and the
  output folder, which you can change.
- **Writes:** one file per embedded image into that folder, as Photoshop
  (`.psd`), then relinks the artwork to those files. The default folder sits
  next to the document; if it already exists, a numbered sibling is used rather
  than writing into it.
- **Needs:** a saved document.
- If there is nothing embedded and nothing broken, it says so and stops.

## Export Artboard PDFs

One PDF per artboard, each made by duplicating that artboard into a new
document so nothing from the other artboards bleeds in.

- **Checks first:** broken links. If any, a dialog offers to relink them from a
  folder you choose, skip them during export, delete them from the document, or
  cancel.
- **Asks:** a dialog headed *Export Artboards as PDF* that names how many
  artboards it will export, with the export options.
- **Writes:** into a new folder next to the document, named with a timestamp
  and `_export`. Depending on the options, each artboard is saved as a PDF, a
  print-ready PDF, or an `.ai` file.
- **Needs:** a saved document with at least one artboard.

## Export Small PDF

The quick end-of-job actions in one dialog.

- **Asks:** a dialog headed *Quick Actions* with four checkboxes — export the
  smallest PDF, export the largest PDF, save the document, package it.
- **Writes:** the PDFs next to the document; the package into a folder next to
  it.
- **Needs:** a saved document.

## Replace Fonts

Batch font replacement across the document, from a list of pairs.

- **Asks:** a resizable dialog headed *Replace Fonts*. A filter box and
  **Search** narrow the font list; **+ Add** adds a *from → to* row; rules can
  be **saved** and **loaded** again later. Three options: list every font in the
  *From* menu (not only the ones in use), grow text frames that overset after
  the replacement, and touch **halfwidth characters only** — Latin letters,
  digits and punctuation — leaving CJK text on its current font. A *Scope*
  panel chooses what to run over.
- **Writes:** nothing to disk; it edits the document. Saved rules go where you
  put them.

## CJK Composer and Mojikumi

Puts CJK text on the right composer, and optionally the right spacing and
line-breaking sets.

- **Asks:** if something is selected, whether to process only the selected text
  frames (OK) or every text frame (Cancel); then a confirmation of what it is
  about to change, with a preview of the effect.
- **Does:** switches the text to the CJK every-line composer (or the
  single-line one, if the script is configured that way) and, if enabled,
  applies a Mojikumi set and a Kinsoku set. Which sets: the ones named at the
  top of the script, or — if left blank — one that looks Chinese or Japanese
  among those the document has; if none does, that part is skipped.
- **Writes:** nothing to disk.
- **Configuring it:** the choices (selection or whole document, composer mode,
  whether to set Mojikumi and Kinsoku, which sets by name) are variables at the
  top of the script, in a block marked as the place to change them. The
  defaults are: whole document, every-line composer, both sets on, names
  guessed.
