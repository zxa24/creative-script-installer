---
title: Advanced install options
description: For IT, scripted installs and offline installs. The installer's command-line flags and exit codes, installing from a local copy with -Source, --source or TOOLKIT_SOURCE, the TOOLKIT_ZIP_URL, TOOLKIT_MANIFEST_URL and TOOLKIT_AUTH_TOKEN overrides, collecting a log with CSI_LOG or --log, and how the distribution bundle is built.
---

# Advanced install options

Use this page if you install the scripts for other people (IT), run the
installer from a script, or install on a computer without internet access. To
set up your own computer, [Install and update](/guide/install) is all you need.

## Run it without the menu {#command-line-flags}

Run `install-update.ps1` (Windows) or `install-update.sh` (macOS) from a copy
of the [distribution](https://github.com/zxa24/creative-script-installer) with
one of these flags:

| Windows | macOS | What it does |
| --- | --- | --- |
| `-Install` | `--install` | Skip the menu; install or update. |
| `-Repair` | `--repair` | Skip the menu; rewrite the files even if the version matches. |
| `-Uninstall` | `--uninstall` | Skip the menu; remove the installed scripts. |
| `-Force` | `--force` | Reinstall even when the installed version already matches. |
| `-DryRun` | `--dry-run` | Detect and verify only; write no files. |
| `-Source <path>` | `--source=<path>` | Install from a local copy (see [below](#environment-overrides)). |
| `-Log` | `--log` | Save a diagnostic log to the Desktop. |

On macOS a flag can also ride on the one-line command:
`curl … | bash -s -- --uninstall`. On Windows it cannot, because `irm … | iex`
hands the script over as text, so run `install-update.ps1` with the flag
instead.

<a id="requirements-and-exit-codes"></a>**Exit codes**, for a script that runs
the installer:

| Code | Meaning |
| --- | --- |
| 0 | Done, or nothing to do. A stop that leaves something for you to do first (Illustrator never launched, the one-time step declined) is also 0. |
| 1 | Something failed, or nothing could be installed. See [Something went wrong](/guide/install#something-went-wrong). |
| 2 | The answer was not one of the menu choices. See [It says "Not one of the choices"](#not-one-of-the-choices). |
| 3 | No InDesign or Illustrator was found, or only Illustrator was found and its Scripts folder could not be identified. See [It says it could not find InDesign or Illustrator](/guide/install#not-found) and [It found Illustrator but not its Scripts folder](#how-illustrator-s-scripts-folder-is-found). |
| 4 | The download failed verification. See [Something went wrong](/guide/install#something-went-wrong). |

## Install offline or from your own copy {#environment-overrides}

1. On a computer with internet access, download the distribution from
   [GitHub](https://github.com/zxa24/creative-script-installer) (**Code →
   Download ZIP**).
2. Copy the zip to the computer, unzipped or not.
3. Run the installer with that copy as its source:
   `install-update.ps1 -Source <zip or folder>` on Windows,
   `install-update.sh --source=<zip or folder>` on macOS.

Instead of the flag you can set an environment variable. The installer reads
these when you run `install-update.ps1` or `install-update.sh` directly:

| Variable | What it does |
| --- | --- |
| `TOOLKIT_SOURCE` | Install from a local `.zip` or folder, like `-Source` / `--source`. |
| `TOOLKIT_ZIP_URL` | Download the scripts from this address instead. |
| `TOOLKIT_MANIFEST_URL` | Read the version and checksums from this address instead. |
| `TOOLKIT_AUTH_TOKEN` | For a private source: sends an `Authorization: token …` header with each download. |
| `CSI_LOG` | Set to `1` to save a diagnostic log to the Desktop (see [below](#collecting-a-log-when-something-goes-wrong)). |

The one-line commands ignore the four `TOOLKIT_*` variables
([why](#toolkit-variable-ignored)). `CSI_LOG` works on both routes.

## Collecting a log when something goes wrong {#collecting-a-log-when-something-goes-wrong}

An ordinary run writes no log file, so nothing piles up on the computer. When
something goes wrong, run it again and ask for a log. On Windows the one-line
command cannot take a flag, so an environment variable switches it on there:

::: code-group

```powershell [Windows]
$env:CSI_LOG='1'; irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

```bash [macOS]
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash -s -- --log
```

:::

The log is saved on your **Desktop** as
`creative-script-installer-log-<date>-<time>.txt`, and the installer prints its
full path when it finishes. Each run writes its own file. Send that file on,
and delete it when you are done. A failed run prints this command itself, so
nobody has to remember it.

## Common problems

::: details It found Illustrator but not its Scripts folder
<a id="how-illustrator-s-scripts-folder-is-found"></a>

The message is *Found Illustrator, but could not identify its Scripts folder*.
Illustrator keeps a Scripts folder inside the application, and its name is in
Illustrator's language (`Scripts`, `脚本`, `スクリプト`, `Komut Dosyaları` and
so on), so the installer does not go by the name. Inside the language folder
Illustrator uses, it looks for the sub-folder that already holds our
`illustrator-toolkit-stable` folder from an earlier install, or else the one
that holds `.jsx` files (normally Adobe's three sample scripts). If the samples
were deleted and nothing of ours is there yet, no folder qualifies.

To fix it, put any `.jsx` file back into the right folder, or repair the
Illustrator installation, which restores the samples, then run the installer
again. If InDesign is also installed, the run installs the InDesign scripts and
skips Illustrator; if not, it stops with exit code 3.
:::

::: details A `TOOLKIT_` variable seems to be ignored
<a id="toolkit-variable-ignored"></a>

You used the one-line command. It downloads the distribution from GitHub first
and then runs the installer with that download as its source, so
`TOOLKIT_SOURCE`, `TOOLKIT_ZIP_URL`, `TOOLKIT_MANIFEST_URL` and
`TOOLKIT_AUTH_TOKEN` are never used. Run `install-update.ps1` or
`install-update.sh` directly instead.
:::

::: details A flag does nothing on Windows
`irm … | iex` passes the script as text, so it cannot take a flag. Run
`install-update.ps1` with the flag, or, for a log, set `CSI_LOG`
([how](#collecting-a-log-when-something-goes-wrong)).
:::

::: details It says it needs PowerShell 5 or newer
<a id="needs-powershell-5"></a>

Windows 10 and 11 have it already. On an older Windows, install Windows
Management Framework 5.1 from Microsoft, then run the line again.
:::

::: details It says "Not one of the choices"
<a id="not-one-of-the-choices"></a>

What was typed at the menu was not one of the numbers shown, or `q`. Nothing was
changed. Run it again and type one of the choices, or pass a flag such as
`-Install` / `--install` to skip the menu.
:::

::: details Technical details
<a id="where-the-installer-fetches-from"></a>**Where the installer downloads from**

The public distribution repository is
[github.com/zxa24/creative-script-installer](https://github.com/zxa24/creative-script-installer).
Its coordinates are at the top of the installers: `$Owner`, `$Repo` and `$Ref`
in `install-update.ps1`, `OWNER`, `REPO` and `REF` in `install-update.sh`. By
default the scripts come from
`https://codeload.github.com/<owner>/<repo>/zip/refs/heads/<ref>` and the
version check reads
`https://raw.githubusercontent.com/<owner>/<repo>/<ref>/indesign-toolkit.manifest.json`.
`TOOLKIT_ZIP_URL` and `TOOLKIT_MANIFEST_URL` replace these two addresses.

**Order of sources.** `-Source` / `--source` wins over `TOOLKIT_SOURCE`, and a
local source wins over any address. With a local source the installer reads the
version from the copy itself and downloads nothing. It finds the copy by the
`indesign-toolkit.manifest.json` inside it, so the zip GitHub offers works as it
is.

**From `cmd.exe`.** Double-click `install-update.bat`, or run
`powershell -NoProfile -Command "irm … | iex"`. Windows needs PowerShell 5 or
newer.

<a id="update-semantics-restated"></a>**How an update behaves**

- **InDesign:** the whole folder is replaced in one step: download and verify
  first, swap second. A `.bak` folder exists only during the swap, so it can be
  undone, and is removed once the new folder is in place. It is **not** a copy
  you can roll back to later: a leftover copy would appear in the Scripts panel
  as a second set of scripts, because InDesign scans the folder and everything
  in it.
- **Illustrator:** files are replaced in place, each one in a single step; there
  is no `.bak` and no whole-folder swap, because that would need write access to
  the Adobe folder around it, which the installer does not have. See
  [How updating behaves](/guide/install#how-updating-behaves).
- To roll back, install the older distribution:
  `--source=/path/to/old-dist` (macOS) or `-Source C:\path\to\old-dist`
  (Windows). Keeping the distribution you are on now is the only way back.
- For InDesign, a failure at any step leaves the existing installation as it
  was. For Illustrator, a failure part way through the in-place replace is
  reported as a failure and is put right by the next run.
- Running it again when everything is current installs nothing.

<a id="building-the-distribution-bundle"></a>**Building the distribution bundle**

From the development repository:

```bash
node toolkit_installer/make_dist.mjs
```

It walks `translation_mvp_uxp/` (every top-level `.idjs` and all of `lib/`,
minus an exclusion list) and checks that every `require` in the shipped files
resolves to a shipped file, so nothing needed at run time is left out. The
Illustrator scripts come from the sibling `illustrator-toolkit` repository. It
writes, under `toolkit_installer/dist/`:

- `indesign-toolkit/`: the InDesign scripts that go into the Scripts panel
- `indesign-toolkit.manifest.json`: the version plus a SHA-256 for every file
- `indesign-toolkit.manifest.sha256`: a `shasum -c` file, used for
  verification on macOS
- `illustrator-toolkit/`, `illustrator-toolkit.manifest.json`,
  `illustrator-toolkit.manifest.sha256`: the same three for Illustrator
- `install.sh`, `install.ps1`: the one-line bootstraps
- `install-update.ps1`, `install-update.sh`, `install-update.bat`,
  `install-update.command`: the installer and its double-click launchers
- `README.md`, `LICENSE` and repository metadata, from
  `toolkit_installer/repo-scaffold/`

The build refuses to write a manifest and a `.sha256` file that disagree. The
version number comes from `toolkit_installer/VERSION`.

<a id="shape-of-the-distribution-repository"></a>**Shape of the distribution repository**

```text
<repo root>/
  indesign-toolkit/                  the InDesign scripts
  indesign-toolkit.manifest.json     version and per-file sha256
  indesign-toolkit.manifest.sha256   shasum -c file (macOS verification)
  illustrator-toolkit/               the Illustrator scripts
  illustrator-toolkit.manifest.json
  illustrator-toolkit.manifest.sha256
  install.sh                         one-line bootstraps
  install.ps1
  install-update.bat
  install-update.command
  install-update.ps1
  install-update.sh
  README.md
  LICENSE
```

The repository also holds the source of this site.

<a id="the-machine-readable-copy-of-this-site"></a>**The machine-readable copy of this site**

Two files are generated from the same Markdown that builds these pages:

| File | Contents |
| --- | --- |
| `llms.txt` | An index of the site with absolute links and one-line summaries, following the [llms.txt](https://llmstxt.org) convention. |
| `llms-full.txt` | The full text of every page on this site, in one file. |

The build regenerates them; nobody edits them by hand:

```bash
cd website
npm run llms     # regenerate only
npm run build    # regenerate, then build the site
```

The generator reads the page list from `.vitepress/site.mjs`, the same list
that builds the navigation, and fails the build if it finds a Markdown page that
is not on it, so the two cannot drift apart.
:::
