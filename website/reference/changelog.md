---
title: Changelog
description: What each released version of the toolkit and its installer contains, newest first. The version is the one the installer reports and the one written into each installed folder.
---

# Changelog

The version is the payload version — the number the installer prints, and the
one it writes into every installed folder. One number covers both the InDesign
and the Illustrator sets; they are released together.

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
