---
title: Files and folders
description: The directory convention — the working folder stays simple, and everything the scripts produce goes into script_outputs/. A later-round import backs up the previous translated document into script_outputs/backup/ before saving, and stops if that copy fails; importing into the original again replaces it without a backup.
---

# Files and folders

**The principle: the working folder is yours; the structured folders are for
the scripts.**

You should not need to open the script-owned folders often. That is the point
of them. The top of your working folder stays as simple as possible.

## The layout

```text
<working folder>/                 ← yours, kept simple
  <doc>.indd                      the source document
  <doc>.translated.indd           the current live output — one stable name

  packages/                       exported translation packages (V01D_…) and their .zip

  script_outputs/                 ← the scripts' folder; you rarely open it
    log/                          run logs
    report/                       import reports
    backup/                       the copy import takes before overwriting
```

Two files sit at the top level, and they always have the same names:

- `<doc>.indd` — the document you started from. Scripts open it read-only.
- `<doc>.translated.indd` — the current output. Always this one name, never a
  timestamped variant. Point your PDF export, your review loop and your muscle
  memory at it.

## What import does to the previous output

**It depends on which document you import into.**

- **A later round, into the `.translated.indd`** (the [normal way](/folio/rounds#next-round)):
  the import updates that document in place, and before saving it copies the
  previous version into `script_outputs/backup/`. Only if the copy is confirmed
  on disk does it save.
- **Into the original again, when a `.translated.indd` already exists:** the
  import starts over and replaces the `.translated.indd` **without a backup**.
  Do not do this after you have adjusted the translated document.

If the backup cannot be made, **the import aborts and your document on disk is
left untouched** ([what to do](/folio/export-import#backup-failed)). That is deliberate: the alternative is overwriting the one
copy of a file you may not be able to reproduce. An aborted import is a
recoverable annoyance; a lost output is not.

### Where to find the previous version

In `script_outputs/backup/`. The working folder itself only ever holds the
current `<doc>.translated.indd`, so rolling back means going into that folder
and copying the file back out.

### A change is planned here

The backup gate exists because the write is an **overwrite**, and an overwrite
has to be protected. A different design removes the need for the gate entirely:
move the previous output aside first, so the name is free and the write becomes
a **create**.

| | |
| --- | --- |
| **Backup** — what the scripts do today | "Save a copy before overwriting." Needs a mechanism that must work correctly every time; if the copy fails, the write has to be blocked. |
| **Archive** — the intended design | "Move the previous one aside, then write." There is no overwrite, so there is no gate that can fail. |

That change is decided but **not built yet**, so this page describes the backup
behaviour — that is what will actually happen when you run an import today. The
folder will be `script_outputs/versions/` when it lands.

## Retired convention

An older, manual-era convention used stage-numbered folders — `01_input/`,
`02_source/`, `03_working/`, `04_review/`, `05_delivery/`, `logs/`. **That
convention is retired.** It predates the export/import package chain and is not
what the scripts write.

Delivery-side handling (what the old `04_review/` and `05_delivery/` were for)
is currently **not** covered by automation. If you need it, set it up
separately — do not revive the old numbered folders as if they were part of
this convention.
