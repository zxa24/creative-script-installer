---
title: Changelog
description: What each released version of the toolkit and its installer contains, newest first. The version is the one the installer reports and the one written into each installed folder.
---

# Changelog

The version is the payload version — the number the installer prints, and the
one it writes into every installed folder. One number covers both the InDesign
and the Illustrator sets; they are released together.

## 1.0.2 — 2026-09-08

**Fixed: an import could take hours when a font was missing.**

If the document used a font face this machine did not have installed, the import
searched the whole font catalogue to be sure — and that search took **eight
minutes**, once for every stretch of Latin text inside a Chinese paragraph. On a
real job that added up to nearly five hours, with InDesign responsive the whole
time and nothing on screen to say why. The same import now finishes in about
seventy seconds; the search that took eight minutes takes half a second, and is
remembered for the rest of the run rather than repeated.

Nothing about the answer changed — a face that isn't installed is still reported
and skipped, never quietly substituted. Only the cost of finding that out.

**Fixed: a speed-up for manual runs that had never actually run.**

Running a script from InDesign's Scripts panel is slower than driving it
automatically, because InDesign keeps re-laying-out the page you are looking at
after every change. There has been a remedy for this in the code for some time —
park the window on a page nothing is being edited on — and it turns out it never
executed once: it asked InDesign for the window using a name InDesign does not
have, got nothing back, and skipped itself in silence. It now works. You will see
the document jump to its last page during the import and return to where you were
when it finishes.

**Fixed: the report the import points you at no longer deletes itself.**

Every run ends by printing the location of a JSON report. On a successful run that
file sat inside the temporary folder the same run then cleaned up, so the path led
nowhere. The report is now written beside the log, under `script_outputs/`, and
survives. The import also refuses to clean up a folder that happens to hold this
run's own log or report.

**Changed: one line in the log was renamed, because it was lying.**

A counter labelled `readbackFailures` was really a list of *everything the emphasis
step wanted to mention* — including cases where the text was styled correctly and
an existing annotation or hyperlink was correctly left alone. It is now called
`surfaced`, and prints a breakdown by reason instead of a single number.

## 1.0.1 — 2026-09-08

**Fixed: an import that looked frozen.**

The emphasis settle pass — the step that applies emphasis once the layout has
settled, and widens a frame whose text oversets — wrote **one log line, at the
end**. A real import spent more than eight minutes inside it at full CPU with
nothing between two log lines, and from outside that is indistinguishable from
a crash.

The cause was one missing hand-off: the logging channel reached the pipeline
but was not passed down to the code doing this work, so it had nothing to write
with. It does now, and the phase reports as it goes:

- when it starts, and how many sites it has to visit;
- every 25 sites, and **any single site that takes over a second**;
- one line per widened frame, naming the frame and how hard it tried.

That last line also answers a question the old log could not: a frame whose
text oversets *vertically* can never be fixed by making it wider, so the search
spends its whole budget and reverts. It now says so, instead of looking like a
hang.

Nothing about what the scripts *do* changed in this release.

## 1.0.0 — 2026-09-08

First public release.

**Installer**

- One pasted command installs and updates, on Windows (`irm … | iex`) and macOS
  (`curl … | bash`); the same command run again updates. Everything is
  downloaded and checksum-verified before anything is written.
- An interactive menu when run in a terminal — Install, Update, Repair,
  Uninstall — offering only the choices that apply.
- Illustrator support with the single administrator step it needs, done in the
  session: a password on macOS, the Windows prompt on Windows, asked only when
  actually needed, and skipped with an explanation when Illustrator has never
  been launched.
- No log file unless asked for (`--log` / `CSI_LOG=1`); when asked, one file on
  the Desktop per run.
- `install-update.bat` / `.command` for machines without a terminal; they
  install the copy they sit in.

**InDesign — 15 scripts in four groups**

- `1.x` Workflow: Export Translation Package, Import Translation Package.
- `2.x` Type and Styles: Apply Font Pairing, Apply CJK Styles, Set Selection
  Weight, Reorganize Styles, Repair Cluster GREP, Convert Underline to Rule.
- `3.x` Check and Repair: Snapshot Before Apply, Repair After Apply, Relink
  Missing Links, Highlight Translation Changes, Save and Reveal.
- `4.x` Brand Presets: Export Brand Preset, Apply Brand Preset.

**Illustrator — 5 tools**

- Unembed All Images, Export Artboard PDFs, Export Small PDF, Replace Fonts,
  CJK Composer and Mojikumi.

**Documentation**

- This site, in English, with a machine-readable copy (`llms.txt`,
  `llms-full.txt`) so an AI assistant can be handed the address and asked.
