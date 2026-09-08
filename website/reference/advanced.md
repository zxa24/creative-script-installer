---
title: Advanced install and distribution
description: Installer flags, the TOOLKIT_SOURCE / TOOLKIT_ZIP_URL / TOOLKIT_MANIFEST_URL / TOOLKIT_AUTH_TOKEN environment overrides, offline installs, and how the distribution bundle is produced.
---

# Advanced install and distribution

For people packaging, redistributing, or testing the toolkit. Designers
installing it normally want [Install and update](/guide/install) instead.

## Where the installer fetches from

The download source is configurable. The public distribution repository's
coordinates live at the top of the install scripts — `$Owner` / `$Repo` /
`$Ref` in the Windows PowerShell script, `OWNER` / `REPO` / `REF` in the macOS
shell script.

## Environment overrides

You can redirect the installer without editing it, by setting environment
variables. They apply when you run `install-update.sh` / `install-update.ps1`
**directly**. The one-line commands download from GitHub before any of these are
read and then hand over with an explicit local source, so on that route the
three `TOOLKIT_*` overrides have no effect.

| Variable | Effect |
| --- | --- |
| `TOOLKIT_SOURCE` | Install from a local `.zip` or an already-extracted directory. Use this for offline installs and for self-testing. |
| `TOOLKIT_ZIP_URL` | Override the payload URL outright. |
| `TOOLKIT_MANIFEST_URL` | Override the manifest URL outright. |
| `TOOLKIT_AUTH_TOKEN` | Fallback for a private source: sends an `Authorization: token …` header with the request. |
| `CSI_LOG` | Set to `1` to save a diagnostic log to the Desktop. See [Collecting a log](#collecting-a-log-when-something-goes-wrong). |

## Command-line flags

| Windows | macOS | Effect |
| --- | --- | --- |
| `-Force` | `--force` | Reinstall even when the installed version already matches. |
| `-DryRun` | `--dry-run` | Detect and verify only — write no files. |
| `-Source <path>` | `--source=<path>` | Install from a local source. |
| `-Log` | `--log` | Save a diagnostic log to the Desktop. |
| `-Install` | `--install` | Skip the menu; install or update. |
| `-Repair` | `--repair` | Skip the menu; rewrite the files even if the version matches. |
| `-Uninstall` | `--uninstall` | Skip the menu; remove the installed scripts. |

On macOS a flag can ride on the one-line command: `curl … | bash -s -- --uninstall`.
On Windows it cannot — `irm … | iex` hands the script over as text — so use the
menu, or run `install-update.ps1` directly with the flag.

## Requirements and exit codes

Windows needs **PowerShell 5 or newer** (Windows 10 and 11 have it; the
one-line command says so and stops if it is missing). From `cmd.exe`, either
double-click `install-update.bat` or run
`powershell -NoProfile -Command "irm … | iex"`.

| Exit code | Meaning |
| --- | --- |
| 0 | Done, or nothing to do. A refusal that leaves something for you to do first (Illustrator never launched, the one-time step declined) is also 0. |
| 1 | Something failed, or nothing could be installed. |
| 2 | Not one of the menu choices. |
| 3 | No InDesign or Illustrator installation was found. |
| 4 | The download failed verification. |

## Collecting a log when something goes wrong

The installer **writes no log file** on an ordinary run. Nothing accumulates on
the machine, and there is no file to find later — which is the point: a log that
is always written is one nobody reads and nobody cleans up.

When something does go wrong, run it again asking for a log. The one-line
installers cannot take a flag on Windows — `iex` receives the script as text,
not as a command — so an environment variable is the switch there:

::: code-group

```powershell [Windows]
$env:CSI_LOG='1'; irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

```bash [macOS]
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash -s -- --log
```

:::

The log lands on your **Desktop** as
`creative-script-installer-log-<date>-<time>.txt`, and the installer prints the
full path when it finishes. Each run writes its own file, so nothing is
appended to and nothing grows. Send that file on; delete it when you are done.

A failed run tells you this command itself, so nobody has to remember it.

## Building the distribution bundle

From the development repository:

```bash
node toolkit_installer/make_dist.mjs
```

It takes `translation_mvp_uxp/` and produces the distributable payload by
walking the whole tree minus an exclusion list, then self-checking the `require`
closure so nothing that is reachable at runtime is left out of the bundle. It
emits:

- `dist/toolkit/` — the InDesign payload that gets installed into the Scripts panel
- `toolkit.manifest.json` — the version plus a SHA-256 for every file
- `toolkit.manifest.sha256` — a `shasum -c` sidecar, used for verification on
  macOS
- `dist/illustrator/`, `illustrator.manifest.json`, `illustrator.manifest.sha256`
  — the same three for the Illustrator payload
- `install.sh`, `install.ps1` — the one-line bootstraps

The build refuses to emit a manifest and a sidecar that disagree with each other.

The version number is read from `toolkit_installer/VERSION`.

## Shape of the distribution repository

The distribution bundle — that is, what the public distribution repository
contains — looks like this:

```text
<repo root>/
  toolkit/                  ← the InDesign content that gets installed into the Scripts panel
  toolkit.manifest.json     ← version + per-file sha256
  toolkit.manifest.sha256   ← shasum -c sidecar (macOS verification)
  illustrator/              ← the Illustrator scripts
  illustrator.manifest.json
  illustrator.manifest.sha256
  install.sh                ← one-line bootstraps
  install.ps1
  install-update.bat
  install-update.command
  install-update.ps1
  install-update.sh
  README.md
```

## Update semantics, restated

- **InDesign:** the whole folder is replaced **atomically**: download and verify
  first, swap second. A `.bak` folder exists only *during* the swap, as the
  transaction's undo, and is removed once the new folder is in place. It is
  **not** a rollback copy you can use afterwards — a leftover copy would appear
  in the Scripts panel as a duplicate set of scripts, because InDesign scans it
  recursively.
- **Illustrator:** files are replaced **in place**, each one atomically; there is
  no `.bak` and no whole-folder swap, because that would need write access to
  the Adobe folder around it, which the installer does not have. See
  [How updating behaves](/guide/install#how-updating-behaves).
- To roll back, reinstall the older distribution: `--source=/path/to/old-dist`
  (macOS) or `-Source C:\path\to\old-dist` (Windows). Keeping the distribution
  you are currently on is the only rollback path there is.
- For InDesign, any failure at any step leaves the existing installation
  untouched. For Illustrator a failure part-way through the in-place replace is
  reported as a failure and heals on the next run.
- Re-running when already current installs nothing.

## The machine-readable copy of this site

Two files are generated from the same Markdown that builds these pages:

| File | Contents |
| --- | --- |
| `llms.txt` | An index of the site with absolute links and one-line summaries, following the [llms.txt](https://llmstxt.org) convention. |
| `llms-full.txt` | The full text of every page on this site, concatenated. |

They are regenerated by the build, not maintained by hand:

```bash
cd website
npm run llms     # regenerate only
npm run build    # regenerate, then build the site
```

The generator reads the page list out of `.vitepress/site.mjs` — the same list
that produces the navigation — and fails the build if it finds a Markdown page
that is not on it. That is what keeps the two surfaces from drifting apart.
