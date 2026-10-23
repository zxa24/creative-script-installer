---
title: "Translate a layout: for designers"
description: The designer's part of Folio in the order of the work. Get the document ready, export the text and import the translation, make the new language look right, handle later rounds, and copy settings to sister documents.
# The sections of this page moved to the stage pages (2026-10-12). An old link
# to one of these ids is forwarded to the page that holds it now (site.mjs
# ANCHOR_MOVES; the browser reads this map).
anchorMoves:
  what-to-do: /folio/export-import
  common-problems: /folio/export-import
  import-stopped: /folio/export-import
  missing-fonts: /folio/export-import
  missing-links: /folio/export-import
  font-has-no-pair: /folio/export-import
  backup-failed: /folio/export-import
  bold-italic-missing: /folio/export-import
  text-too-long: /folio/export-import
  report-and-log: /folio/export-import
  export-translation-package: /folio/export-import
  import-translation-package: /folio/export-import
  next-round: /folio/rounds
---

# Translate a layout: for designers

Follow these five stages, in this order, when a finished InDesign document
needs a version in another language.

**Before you start:** the layout is final, and the scripts are
[installed](/guide/install).

1. **[Before you export](/folio/before-export).** Check that InDesign shows no
   missing fonts or missing links, and save the document. Relink missing images
   or tidy tangled paragraph styles here if you need to.
2. **[Export and import](/folio/export-import).** Export the text as a zip with
   **1.1 Export Translation Package** and send it to the translator, who
   translates it in the web app and sends it back. Then import it into a copy
   of the original with **1.2 Import Translation Package** and check the result.
3. **[Make the new language look right](/folio/fonts).** For Chinese, Japanese
   or Korean, run **2.2 Apply CJK Styles** once. Other tools fix specific
   problems where the new language meets the layout.
4. **[Later rounds](/folio/rounds).** When the translation changes after you
   adjusted the layout, update the `.translated.indd` you adjusted and mark
   what changed.
5. **[Sister documents](/folio/sister-documents).** Copy tuned paragraph-style
   settings to a sister document, without redoing them by hand.

::: warning Do not import a later round into the original
That starts over and replaces the `.translated.indd` you adjusted. The import
asks before it does this and saves a backup first, but your layout work is no
longer in the translated copy.
[Later rounds](/folio/rounds#next-round-warning) shows what to do instead.
:::
