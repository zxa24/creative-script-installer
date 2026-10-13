---
title: "Folio: translate a layout"
description: Folio translates a finished InDesign layout without rebuilding it. The designer exports the text, a translator translates it in a web page, and the designer imports the translation into a copy of the same layout.
# The stage list that was here is now the designer's page (site.mjs ANCHOR_MOVES).
anchorMoves:
  tools-for-each-stage: /folio/designer
---

# Folio: translate a layout

Folio gets a finished InDesign document into another language without
rebuilding the layout. The translation goes back into the same frames, styles
and pages.

<!-- diagram: designer exports a zip -> translator works in the web app and saves a zip -> designer imports it -->

1. **The designer exports** the text from InDesign as a `.zip` file.
2. **The translator translates** it in a web page. Nothing to install.
3. **The designer imports** the translation. InDesign makes a translated copy;
   the original stays as it is.

Then the designer checks the result and
[adjusts fonts for the new language](/folio/fonts) if needed.

## Pick your part

- **I lay out the document:** [Translate a layout: for designers](/folio/designer),
  the five stages of the work in order.
- **I translate the text:** [Translate in the web app: for translators](/folio/translator)

::: details What Folio does not do
- It does not translate by itself. A person translates; the web app can suggest
  a first draft with Google Translate if the translator asks for it.
- It does not add bold, italic or other formatting the translator did not mark.
- It does not change the original document.
:::
