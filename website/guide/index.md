---
title: What this toolkit is
description: The shape of the toolkit — one normal path made of two scripts, and three groups of tools you reach for when something needs fixing.
---

# What this toolkit is

`indesign-toolkit` is a set of scripts that appear inside InDesign's **Scripts
panel**. Each one is a file you double-click. There is no plugin, no panel to
dock, and nothing that changes InDesign's own settings.

They exist for one job: a document is laid out in one language, the text has to
be translated, and the translation has to come back into **that same layout** —
same frames, same styles, same page geometry — instead of the document being
rebuilt from scratch.

## The two tracks

The scripts are numbered, and the first digit tells you which track you are on.

### Track 1 — the normal path

Group `1.x` is what you run on an ordinary job, in order:

| Script | What it does |
| --- | --- |
| `1.1 Export Translation Package` | Writes a translation package out of the open document. |
| `1.2 Import Translation Package` | Reads the translated package back into a copy of that document. |

That is the entire normal path. If nothing goes wrong, you never open the
other groups.

See [The normal path](/guide/workflow) for the step-by-step, and
[Group 1 — Workflow](/scripts/workflow) for what each script actually writes.

### Track 2 — tools you reach for

Groups `2.x`, `3.x` and `4.x` are **not** part of the normal path. Each one is
a deliberate act: you noticed a problem, or you want to move something between
documents, and you pick the tool that addresses it.

| Group | For when |
| --- | --- |
| [`2.x` Type & Styles](/scripts/type-and-styles) | The new language needs different fonts, different weights, or the style sheet has sprawled. |
| [`3.x` Check & Repair](/scripts/check-and-repair) | Something broke — overset text, missing links — or you want to see what changed. |
| [`4.x` Brand Presets](/scripts/brand-presets) | You tuned one document's paragraph styles and want a sibling document to match. |

Running a `2.x`/`3.x`/`4.x` script when nothing is wrong is not harmful, but it
is not part of the routine either. Reach for them on purpose.

## What you need

- Adobe InDesign, any recently installed version. The installer detects every
  installed version and language on the machine and installs into each one.
- Nothing else. No GitHub account, no git, no command line, no password.

## Where things end up

Scripts do not scatter files around your working folder. They write into a
single `script_outputs/` folder next to the document — packages, archived
versions, logs, reports. See [Files and folders](/guide/folders) for the
convention and why it is shaped that way.

## Next

1. [Install and update](/guide/install) — get the Scripts panel folder onto the machine.
2. [The normal path](/guide/workflow) — export, translate, import.
3. [All scripts](/scripts/) — the numbered index, with one line each.
