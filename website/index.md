---
layout: home
title: Creative Script Kit
titleTemplate: Scripts for InDesign and Illustrator
description: Free scripts for Adobe InDesign and Illustrator. Folio takes a finished InDesign layout to a translator and brings the translation back into the same layout. A set of InDesign tools fixes what a new language changes, and five Illustrator tools handle everyday chores. Install them all with one line.

hero:
  name: Creative Script Kit
  text: Scripts for InDesign and Illustrator.
  tagline: Install with one line. Update with the same line. Free and open source.
  actions:
    - theme: brand
      text: Install
      link: /guide/install
    - theme: alt
      text: Folio
      link: /folio/
    - theme: alt
      text: More tools
      link: /tools/
    - theme: alt
      text: All scripts
      link: /scripts/

features:
  - title: Folio
    details: Translate a finished InDesign layout without rebuilding it. You send the text to a translator, who works in a web page, and the translation comes back into the same frames, styles and pages.
    link: /folio/
    linkText: How Folio works
  - title: More tools
    details: Scripts outside the translation workflow. In InDesign, save and open the document's folder in one step. In Illustrator, five small helpers. Unembed every image, save each artboard as its own PDF, finish a job in one click with Export Small PDF (smallest PDF, largest PDF, save, package), replace fonts across a file, and set Chinese and Japanese line breaking and spacing.
    link: /tools/
    linkText: See the tools
  - title: All scripts
    details: Saw a script name in the Scripts panel or the File menu? Find what it does and where it is explained.
    link: /scripts/
    linkText: Look it up
---

**Translating a Folio zip?** You need nothing installed. Go to
[For translators](/folio/translator).

## Install in one line

Open InDesign (and Illustrator) once before installing, then quit. Open a
terminal, paste the line for your computer, and press Enter.
[Install](/guide/install) shows each step.

**Mac**: open the Terminal app and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
```

**Windows**: open PowerShell and paste:

```powershell
irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

Then restart InDesign and Illustrator. To update later, paste the same line again.

## Who it is for

- **Designers** who lay out documents in more than one language, or who want a
  few chores in InDesign and Illustrator done for them.
- **Translators** who receive a Folio package. You work in a web page and need
  nothing installed. See [For translators](/folio/translator).

You do not need to write code. In InDesign you double-click a script in the
Scripts panel; in Illustrator you pick it from the File menu.

## Free and open source

The scripts and this site are on
[GitHub](https://github.com/zxa24/creative-script-installer). Questions and bug
reports are welcome there.

::: details For AI assistants
This whole site is also published as plain text, so you can give an AI
assistant the address and ask it questions:
[`llms.txt`](/llms.txt) is an index and [`llms-full.txt`](/llms-full.txt) is
every page in one file.
:::
