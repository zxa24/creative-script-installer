---
title: Install and update
description: One-click install and update of the InDesign toolkit on Windows and macOS, including the SmartScreen and Gatekeeper prompts, the install locations, and how updates roll back if anything fails.
---

# Install and update

One double-click installs the toolkit into your machine's InDesign **Scripts
panel**. From then on, the *same* button updates it.

You do **not** need a GitHub account, git, or any password.

## Windows

1. Double-click **`install-update.bat`**.
2. A black console window opens and checks for, then installs or updates, the
   toolkit. You are done when you see the green **"updated to vX"** or
   **"already up to date"** line.
3. **Restart InDesign.** Open `Window → Utilities → Scripts`, expand the
   `indesign-toolkit` folder, and double-click any script to run it.

::: warning First run may show SmartScreen
Windows may show a blue **"Windows protected your PC"** dialog. Click
**More info → Run anyway**. See [Security prompts](#security-prompts) below.
:::

## macOS

1. **The first time**, grant permission to run it: right-click
   `install-update.command` and choose **Open** — do not double-click it.
2. After that, double-click **`install-update.command`**. A Terminal window
   opens and checks for, then installs or updates, the toolkit.
3. **Restart InDesign.** Open `Window → Utilities → Scripts`, expand
   `indesign-toolkit`, and run a script from there.

::: warning First run may show Gatekeeper
macOS may say the file **"cannot be opened because it is from an unidentified
developer"**. Right-click the file → **Open** → **Open** again in the dialog.
See [Security prompts](#security-prompts) below.
:::

## Security prompts

These scripts are not signed with a (costly) code-signing certificate, so the
operating system flags them as coming from an unknown source the first time.
This is **normal**. Allow it once and you will not be asked again.

### Windows — SmartScreen

- **What you see:** a blue box, *"Windows protected your PC"*, when you
  double-click the `.bat`.
- **To allow it:** click **More info** → **Run anyway**.
- **If the files came from email or cloud storage,** Windows marks them as
  "from the internet" (the `Zone.Identifier` mark). Right-click the file →
  **Properties** → tick **Unblock** → **OK**, then run it again.
- The `.bat` already invokes PowerShell with `-ExecutionPolicy Bypass`, so you
  do **not** need to change your machine's script execution policy
  (`Set-ExecutionPolicy`).
- If your company's Group Policy disables PowerShell scripts entirely, contact
  IT. That is a policy-level block; the toolkit cannot work around it, and it
  should not try to.

### macOS — Gatekeeper

- **What you see:** *"cannot be opened because it is from an unidentified
  developer"* when you double-click the `.command`.
- **To allow it:** **right-click (or Control-click) the file → Open → Open**
  in the dialog. Once is enough.
- **If it says the `.command` is not executable,** run this once in Terminal:

  ```bash
  chmod +x "/path/to/install-update.command" "/path/to/install-update.sh"
  ```

- **Files downloaded from cloud storage or email** carry a quarantine
  attribute. You can also clear it in Terminal:

  ```bash
  xattr -d com.apple.quarantine "/path/to/install-update.command"
  ```

## What gets installed, and where

The installer detects every installed InDesign version on the machine and
installs one copy per version:

| Platform | Install path |
| --- | --- |
| Windows | `%APPDATA%\Adobe\InDesign\Version <N>\<language>\Scripts\Scripts Panel\indesign-toolkit-stable\` |
| macOS | `~/Library/Preferences/Adobe InDesign/Version <N>/<language>/Scripts/Scripts Panel/indesign-toolkit-stable/` |

In the Scripts panel that folder is what you open — **indesign-toolkit-stable** —
with the numbered scripts inside it.

::: tip If you also develop these scripts
The `-stable` suffix keeps an installation from colliding with a link to a
working copy, so both can sit in the panel at once. The suffix is on the
installer's side on purpose: a name chosen there applies itself everywhere,
whereas one that had to change on each development machine would leave the
collision live on every machine nobody got to.

If a plain `indesign-toolkit` folder is present, the installer removes it only
when it is one of its own earlier installations — recognised by the version
marker it writes. A link, or a folder someone else put there, is left alone.
:::

What it installs:

- **Scripts only** — the `.idjs` files plus their `lib/` folder.
- It is **not** a UXP plugin, and it changes no other InDesign setting.

## How updating behaves

- An update is an **atomic replacement of the whole folder**. The new version is
  downloaded and verified *first*; only then is the folder swapped in.
- **If any step fails, nothing changes.** There is no half-installed state — if
  the swap itself goes wrong, the old folder is put back.
- **A successful update does not leave the old version behind.** The installer
  does keep a temporary copy while it swaps, but it removes that copy once the
  new folder is in place: InDesign scans the Scripts panel recursively, so a
  leftover copy would show up as a duplicate set of scripts.

::: warning Rolling back means reinstalling
There is no `.bak` folder to fall back on after a successful update. If you need
to go back, install the older version again — keep the distribution you were on,
and point the installer at it with `--source` (macOS) or `-Source` (Windows).
See [Advanced](/reference/advanced).
:::
- **Running it again is safe.** If you are already on the latest version it does
  nothing.

## If something goes wrong

The installer keeps no log file. If a run fails, it prints the one command that
runs it again *and* saves a log to your Desktop — run that, and send the file
it names. The command is in
[Collecting a log](/reference/advanced#collecting-a-log-when-something-goes-wrong).

## Next

- [The normal path](/guide/workflow) — what to run on an ordinary job.
- [All scripts](/scripts/) — the numbered index.
- [Advanced install and distribution](/reference/advanced) — installer flags,
  alternate sources, offline installs.
