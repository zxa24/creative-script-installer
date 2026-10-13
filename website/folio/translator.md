---
title: "Translate in the web app: for translators"
description: Step by step for the translator. Open the zip the designer sent in the Folio web app, type the translation next to each source paragraph, mark bold or italic where needed, save the package zip and send it back. Nothing to install.
---

# Translate in the web app: for translators

Follow these steps when a designer sends you a Folio `.zip` file. You work in
your web browser; there is nothing to install.

The zip is opened inside your browser and is not uploaded anywhere. The only
exception is **Auto Translate**, which sends the text to Google.

## What to do

1. **Open the web app:** [zxa24.github.io/app-folio](https://zxa24.github.io/app-folio/).
2. **Click Open Package ZIP** and choose the zip the designer sent. A window
   called *Review project metadata* opens. **Project name** must not be empty,
   and **Source language** and **Target language** should match the job. Type
   your name in **Translator** if it is not there yet. Then click **Next**.
   If a required field is left empty, your saved zip will not include these
   project details, and a warning tells you so when you save
   ([what to do](#project-details-missing)).
   <!-- screenshot: Open Package ZIP and the project details window -->
3. **Translate.** On the right, each paragraph is a card with the **Source** and
   a **Target** box. Type your translation in **Target**. Press
   <kbd>Enter</kbd> to go to the next one. On the left is the page as it will
   look, with your text in place. Use **Prev** and **Next** under it to change
   page.
   <!-- screenshot: a card with Source and Target, the page preview on the left -->

   ::: warning Sensitive text
   There is an **Auto Translate** button at the top that fills in a machine
   draft. It sends the text to Google Translate. If the document contains
   sensitive or confidential information, do not use it.
   :::
4. **Mark bold and italic yourself.** Formatting is not copied from the
   source by itself. Where the **Source** has bold or italic (yellow markers),
   select the matching words in **Target** and mark them
   (<kbd>Ctrl</kbd>+<kbd>B</kbd> bold, <kbd>Ctrl</kbd>+<kbd>I</kbd> italic), or
   click the yellow marker and use **Apply to target selection**. Anything you
   do not mark comes out plain. The Target box stays plain text; the real look
   shows on the page on the left.
5. **Click Save Package ZIP,** then **Download**. Send the downloaded zip (its
   name starts with `V` and ends in `_translated_<date>.zip`) back to the
   designer.

That is all you need. The rest of this site is for the designer. If the
designer sends you another zip later, open it the same way.

## Common problems

::: details Will I lose my work if I close the browser?
Your edits are saved in this browser as you type. Open the same zip again in
the same browser and they come back. They are not saved anywhere else, so the
only thing you can send is the zip from **Save Package ZIP**. Save it before you
switch computers or browsers.
:::

::: details Can it translate for me?
**Auto Translate** at the top fills every empty paragraph with a Google
Translate draft. It sends the source text to Google: **if the document contains
sensitive or confidential information, do not use it.** Check every paragraph
afterwards. It does not
overwrite text you already typed unless you choose that in its settings.
:::

::: details Some text in the Target box is grey or locked
When the designer sends a document that was already translated, each card
starts with the current wording in grey. Edit that text where it needs
changing; do not retype whole paragraphs. Cards you leave grey stay exactly as
they are in the layout. **Reset** brings a card back to the grey text. A locked
card belongs to the paragraph before it (edit that one), or is not meant to be
translated.
:::

::: details A card warns about control tokens
Some paragraphs contain markers (for example a page number) that must stay in
the translation. If you deleted one, click **Restore Deleted** on that card.
:::

::: details Saving warns that the project details were not included
<a id="project-details-missing"></a>

A required project field is empty: **Project name**, **Source language** or
**Target language**. Fill it in on the **Project** tab, or in the window that
opens when you click **Save Package ZIP**, then save again and send the new zip.
:::

::: details The source has bold or italic words
<a id="source-has-bold"></a>

They are marked in yellow in the Source column. Click a marker and use
**Apply to target selection** to copy the same formatting to the words you
selected in Target. Formatting you do not mark is not added to the translation.
:::

::: details The translation looks too small on the page preview
The preview shrinks long text so it fits its box. Shrunken text on the left is
a sign the translation may be too long for the layout; the designer will see
it when importing ([what the designer does](/folio/export-import#text-too-long)).
:::

::: details A message says the package is open in another tab
Use one tab per package. Click **Take over editing here** in the tab you want
to keep working in.
:::

::: details Technical details
- The zip is unpacked in the browser. Only `segments.json` is required;
  `preview.pdf` and `translations.json` are optional. Any other file type is
  refused.
- Segment status: `todo`, `translated` (set automatically when you type),
  `reviewed` (only when control tokens are intact) and `skip`. Click the status
  chip on a card to change it. Card colours: grey todo, green translated, blue
  reviewed, purple-grey skip.
- Toolbar: bold, italic, underline, superscript, colour (6 presets or a hex
  value), hyperlink (<kbd>Ctrl</kbd>+<kbd>K</kbd>), comment, remove. Pressing a
  shortcut again on the same selection removes that format.
- Auto Translate: default provider `google_web`, which calls
  `translate.googleapis.com` (no key); `google_cloud` needs an API key. Whole
  document only; by default it skips segments that already have text, reviewed
  segments and number or punctuation only text. Formatting it carries over from
  the source is flagged as automatic (amber dashed underline) and is dropped if
  you then edit that sentence by hand.
- Autosave: the browser's IndexedDB (`webapp_working_state`), about 1.5 seconds
  after typing stops and when the tab is hidden. Opening an updated package
  while unsaved edits exist asks: keep local edits, use the package
  translations (discards local edits), or cancel.
- Save Package ZIP writes the original package files plus `translations.json`,
  `translation_qc_report.txt`, `ai_manual_handoff.txt` and `_meta.json`, named
  `V<NN>T_<name>_translated_<YYYYMMDD_HHMMSS>.zip` (NN counts up from the
  incoming package; T marks a translator save). If required project fields are
  empty, `_meta.json` is left out and a warning says so
  ([what to do](#project-details-missing)).
- Other tools: **Draw Hotspot** adds a manual card for text not in the package;
  **Advanced → Export PDF** saves the preview with translations drawn in;
  **Advanced → Open Package Folder (legacy)** and **Save Outputs** are the older
  folder route.
- The interface is English only.
:::
