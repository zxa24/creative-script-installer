---
title: Files and folders
description: What the scripts put next to your InDesign document, and why. packages holds the zips that 1.1 exports; script_outputs holds the logs, the import reports, the 3.4 baselines and the backup an import makes of the previous translated document before it updates or replaces it.
---

# Files and folders

Use this page when you want to know what the scripts have put next to your
document, or where to find the previous translated version.

The top of your folder stays yours. The scripts keep their own files in one
folder, **script_outputs**, which you rarely need to open.

## Next to your document {#the-layout}

```text
<your folder>/
  <doc>.indd                your original
  <doc>.translated.indd     the translated copy
  packages/                 the translation zips
  script_outputs/           the scripts' own files
    log/                    one log per run
    backup/                 copies taken before an import overwrites
    baseline_snapshots/     starting points saved by 3.4
    writeback_v2_report_<time>.json
    post_import_check_<time>.md
```

- **`<doc>.translated.indd`** is the copy that
  [1.2 Import Translation Package](/folio/export-import#what-to-do) makes next
  to the original the first time, and updates in
  [later rounds](/folio/rounds#next-round). It keeps this one name, so your PDF
  export and your review always point at the same file. Your original is not
  changed.
- **packages** holds the zip that **1.1 Export Translation Package** saves each
  time. Each zip is numbered (`V01D_…`, `V03D_…`), so sorting by name sorts by
  round. The number goes up only when the package changes hands between
  designer and translator; exporting again from the same side keeps it. Keep
  the zips translators send back (`V02T_…`) here too.
- **script_outputs** is where the scripts write for themselves:
  - **log**: what happened during each run, one file per run. This is the file
    to send if you report a problem.
  - **The two report files** directly inside script_outputs: what the import
    did (`.json`), and a list of what to check (`.md`). Each import adds a new
    pair.
  - **backup**: the previous translated copy, saved before an import
    updated or replaced it (see [below](#where-to-find-the-previous-version)).
  - **baseline_snapshots**: the starting points that
    [3.4 Highlight Translation Changes](/folio/rounds#highlight-translation-changes)
    compares against.

## Where is the previous translated version? {#where-to-find-the-previous-version}

<a id="what-import-does-to-the-previous-output"></a>In a later round you
import into the `.translated.indd` (the [normal way](/folio/rounds#next-round)).
Before saving, the import puts a copy of the previous version in
**script_outputs → backup**, with the date and time in its name. To go back,
open that copy, or copy it out of the folder. If the copy cannot be made, the
import does not save at all
([what to do](/folio/export-import#backup-failed)).

If you import into the original again while a `.translated.indd` exists, the
import [asks first](/folio/export-import#replace-translated-copy). If you
choose to replace it, the old copy goes into **script_outputs → backup** the
same way.

::: warning Importing into the original again starts over
Your hand adjustments are then only in the backup. Do not do this once you
have adjusted the translated copy.
[Later rounds](/folio/rounds#next-round-warning) shows what to do instead.
:::

## Common problems

::: details My adjustments to the translated copy are gone
A later round was most likely imported into the original, which starts over
and replaces the `.translated.indd`. Since version 1.2 the import asks first
and saves the old copy in **script_outputs → backup**: open the newest copy
there. Versions before 1.2 kept no copy in this case, so the folder may only
have an older version. Next time,
[import into the .translated.indd](/folio/rounds#next-round).
:::

::: details I only see a .zip in packages, not a folder
That is normal. 1.1 builds a package folder, packs it into the zip and then
deletes the folder, so the zip is the one file to send. A package folder with
no zip next to it means the packing failed; the export's file in
**script_outputs → log** says why. Run 1.1 again.
:::

::: details My older packages are in script_outputs → package
Before version 1.1.0, 1.1 saved its packages there. It now saves them in
**packages** next to the document, and still reads the old folder when it
picks the next number, so the numbering carries on.
:::

::: details A folder whose name ends in `_unzipped_` and a time is next to a zip
1.2 unpacks the zip into that folder while it works. It deletes the folder
after a successful import and keeps it when the import
[stopped part way](/folio/export-import#import-stopped), was cancelled or did
not save, so the problem can be looked at. Once you have fixed the problem and
imported again, you can delete it.
:::

::: details There is a file whose name ends in `.translated_` and a long number
A version before 1.2 made it: the previous `.translated.indd` was open in
InDesign and could not be closed, so the import saved its result under this
name instead. Close both documents, keep the one you want, and name it
`<doc>.translated.indd`. Since 1.2 the import stops in that case and asks you
to close the copy.
:::

::: details Technical details
<a id="folders-details"></a>**Names and places**

| What | Where and how it is named |
| --- | --- |
| Translated copy | `<doc>.translated.indd`, next to the original. If an earlier one is open and does not close after four tries, the import stops (before 1.2: `<doc>.translated_<milliseconds>.indd` instead). |
| Package (1.1) | `packages/V<nn>D_<doc>_translation_package_<YYYYMMDD_HHMMSS>.zip`. The dialog's **Output directory** can point elsewhere. |
| Package (web app) | `V<nn>T_<…>_translated_<YYYYMMDD_HHMMSS>.zip`, saved wherever the translator puts it. |
| Log | `script_outputs/log/<script>_<YYYYMMDD_HHMMSS>.log`. For a document that has never been saved, the system temp folder. |
| Import report | `script_outputs/writeback_v2_report_<YYYYMMDD_HHMMSS>.json` and `post_import_check_<YYYYMMDD_HHMMSS>.md`. |
| Backup | `script_outputs/backup/<doc>.translated.<YYYYMMDD_HHMMSS>.bak.indd`. |
| 3.4 baseline | `script_outputs/baseline_snapshots/<doc>__<timestamp>.json`. |
| Unpacked zip (1.2) | `<zip name>_unzipped_<YYYYMMDD_HHMMSS>/`, next to the zip. |

**Package numbers.** D marks a designer export (InDesign), T a translator
export (web app). The number goes up only when the package changes hands: an
export from the other side than the latest package adds one, an export from the
same side keeps the number. A normal round trip reads V01D, V02T, V03D, V04T;
exporting twice before sending gives two V01D zips (their times differ). The
sequence belongs to this document and its target language only. A new document
starts at V01 whatever the other documents in the folder are at, and each
target language counts on its own: zh-HK, zh-TW and zh-MO share one sequence
(Traditional Chinese), zh-CN and zh-SG another (Simplified Chinese).

1.1 looks for the latest package among this document's zips in the folders
next to it whose names start with `packages`, in the old
`script_outputs/package/`, and in the automation output folder when one is set;
`<doc>.translated` counts as the same document. Each zip's `_package_seq.json`
(written by both exporters) gives its number, side and language; without it,
the name is read. An older zip with no number gets one from its name, one more
each time the side changes. A package whose language cannot be read counts for
every language. The package the last import recorded in the document also
counts (a record from before 1.2, with no side, only sets a lowest number). Packages saved in any other folder are not seen. Packages already sent
are never renamed. The package folder is deleted
once the zip is written (kept if zipping fails, or with `EXPORT_KEEP_FOLDER=1`).

**Report location.** The report is kept out of `log/` on purpose, so that a
cleanup of old logs (by age and size) never removes it. If `script_outputs/` cannot be written, the report goes
into the unpacked folder, and that folder is then kept.

**Backup.** An import makes one before it overwrites a `.translated.indd` that
exists on disk: in a later round (in-place update), and when an import from the
original replaces an existing translated copy (before 1.2, only the later
round did). The copy is written, read back and compared
by size and SHA-256 before the file is overwritten; any failure stops the save
(fail closed). The backup is a safety copy for you only; the scripts never read
it back.

<a id="a-change-is-planned-here"></a>**A planned change: archive instead of
backup.** The backup exists because an import overwrites the
`.translated.indd`, and an overwrite has to be protected: if the copy fails, the
write must be blocked. The intended design moves the previous version into
`script_outputs/versions/` first, so the name is free and the import creates a
new file instead of overwriting one. With no overwrite there is no gate that can
fail. This is decided but not built, and has no date yet; until it is, the
backup described on this page is what happens.

<a id="retired-convention"></a>**Retired convention.** An older, manual
convention used stage-numbered folders: `01_input/`, `02_source/`,
`03_working/`, `04_review/`, `05_delivery/`, `logs/`. It is retired. It predates
the export and import packages, and the scripts do not write it. The delivery
side (what `04_review/` and `05_delivery/` were for) is not automated; if you
need it, set it up separately rather than reviving the numbered folders.
:::
