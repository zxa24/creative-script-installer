---
layout: home
title: Creative Script Installer
titleTemplate: Scripts for InDesign and Illustrator, installed with one command
description: One command installs and updates scripts for Adobe InDesign and Illustrator. The InDesign set takes a laid-out document out to a translator and brings the translated text back into the same layout; the Illustrator set is five stand-alone tools.

hero:
  name: Creative Script Installer
  text: Translation, back into the layout.
  tagline: One pasted command installs a set of InDesign scripts that take a laid-out document out to a translator and bring the translated text back into the same layout — then help you repair what the new language broke. Five Illustrator tools ride along.
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
    details: One command on Windows or macOS. No GitHub account, no git, no password - except Illustrator, which asks once. Everything is checksum-verified before anything is written.
    link: /guide/install
    linkText: Install and update
---

## What this is

**Creative Script Installer** puts two sets of scripts where the applications
read them, with one command, and updates them with the same command afterwards.
The larger set, `indesign-toolkit`, lives in InDesign's **Scripts panel**; a
small set of Illustrator tools lives under Illustrator's File → Scripts, and is
not mentioned at all if you have no Illustrator.

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
