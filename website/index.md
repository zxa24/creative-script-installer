---
layout: home
title: indesign-toolkit
titleTemplate: InDesign scripts for translation work
description: Adobe InDesign scripts for a translation and localization workflow — export a translation package, import the translated text back into the layout, and repair typography afterwards.

hero:
  name: indesign-toolkit
  text: Translation, back into the layout.
  tagline: A set of Adobe InDesign scripts that take a laid-out document out to a translator and bring the translated text back into the same layout — then help you repair what the new language broke.
  actions:
    - theme: brand
      text: Install it
      link: /guide/install
    - theme: alt
      text: The normal path
      link: /guide/workflow
    - theme: alt
      text: All scripts
      link: /scripts/

features:
  - title: Two scripts for the normal day
    details: 1.1 Export Translation Package, then 1.2 Import Translation Package. That is the whole path. Everything else is a tool you reach for when something needs fixing.
    link: /scripts/workflow
    linkText: Group 1 — Workflow
  - title: Tools when you need them
    details: Font pairing, CJK styles, style consolidation, missing-link repair, change highlighting, brand presets. Not part of the normal path — reached for deliberately.
    link: /scripts/
    linkText: The full index
  - title: Installs and updates itself
    details: One double-click on Windows or macOS. No GitHub account, no git, no password. Updates replace the whole folder atomically and keep the previous version for rollback.
    link: /guide/install
    linkText: Install and update
---

## What this is

`indesign-toolkit` is a folder of Adobe InDesign scripts that live in the
**Scripts panel**. You install it once, and from then on the same double-click
updates it.

The scripts serve one job: taking an InDesign document that is already laid out
in one language, getting its text translated somewhere else, and putting the
translated text back into that same layout without rebuilding the design.

## Who this is for

- **Designers** who receive a translated document and have to make it fit.
  Start with [Install and update](/guide/install), then
  [The normal path](/guide/workflow). Two scripts cover most days.
- **Anyone automating the pipeline.** The
  [Advanced reference](/reference/advanced) covers installer flags, source
  overrides, and how the distribution bundle is built.

## Machine-readable copy of this site

Every page on this site is also published as plain text so a language model can
read the whole thing at once:

- `llms.txt` — an index of the site, following the
  [llms.txt](https://llmstxt.org) convention.
- `llms-full.txt` — the full text of every page, concatenated.

Both are generated from the same Markdown that builds this site, so they cannot
drift out of date.
