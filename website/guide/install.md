---
title: Install and update
description: Install the InDesign and Illustrator scripts on a Mac or a Windows PC by pasting one line into a terminal, then find them in InDesign and Illustrator. Updating and uninstalling use the same line.
---

# Install and update

Use this page the first time you set up the scripts on a computer, and whenever
you want the newest version.

You paste one line into a terminal. There is nothing to download by hand, and
you do not need an account. The one exception is Illustrator, which asks for
your permission once (see [below](#it-asks-for-my-password)).

Before you start, open InDesign once (and Illustrator once, if you use it), then
quit. The installer finds them by the folders they create the first time they
open.

## On a Mac

1. **Open Terminal.** Press <kbd>Cmd</kbd> + <kbd>Space</kbd>, type
   `Terminal`, and press <kbd>Return</kbd>.
   <!-- screenshot: Spotlight with "Terminal" typed -->
2. **Copy this line, paste it into Terminal and press <kbd>Return</kbd>.** To
   copy it, point at the box and click the copy button that appears at its
   right, or select the whole line and press <kbd>Cmd</kbd>+<kbd>C</kbd>. Click
   in the Terminal window and press <kbd>Cmd</kbd>+<kbd>V</kbd> to paste.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
   ```

3. **Press <kbd>Return</kbd> again** to accept **Install**. The installer lists
   what it found on your Mac and what it is about to do.
   <!-- screenshot: the installer menu with Install highlighted -->
4. **Only for Illustrator, and only the first time:** it asks
   *Continue? [y/n]*. Press <kbd>Return</kbd>. If it then asks for your
   password, type the password you use to log in to this Mac (not an Adobe
   password). Nothing appears while you type; press <kbd>Return</kbd>.
5. **Wait for the last line.** When the install worked, it starts with
   **Installed v** followed by the version number, and tells you which
   applications to restart. You can then close the Terminal window. If it ends
   any other way, see [Something went wrong](#something-went-wrong).
6. **Restart InDesign and Illustrator.** They only look for new scripts when
   they open.

## On Windows

1. **Open PowerShell.** Press the <kbd>Windows</kbd> key, type `PowerShell`, and
   press <kbd>Enter</kbd>.
   <!-- screenshot: Start menu with "PowerShell" typed -->
2. **Copy this line, paste it into PowerShell and press <kbd>Enter</kbd>.** To
   copy it, point at the box and click the copy button that appears at its
   right, or select the whole line and press <kbd>Ctrl</kbd>+<kbd>C</kbd>. Click
   in the PowerShell window and press <kbd>Ctrl</kbd>+<kbd>V</kbd>, or
   right-click, to paste.

   ```powershell
   irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
   ```

3. **Press <kbd>Enter</kbd> again** to accept **Install**.
   <!-- screenshot: the installer menu with Install highlighted -->
4. **Only for Illustrator, and only the first time:** it asks
   *Continue? [y/n]*. Press <kbd>Enter</kbd>. Windows then shows an approval
   prompt; click **Yes**. No Adobe password is involved.
5. **Wait for the last line.** When the install worked, it starts with
   **Installed v** followed by the version number, and tells you which
   applications to restart. You can then close the PowerShell window. If it
   ends any other way, see [Something went wrong](#something-went-wrong).
6. **Restart InDesign and Illustrator.**

If the scripts were already current, the last line says
**Already up to date** instead, and nothing was changed.

## Where to find the scripts {#where-to-find-the-scripts}

- **InDesign:** choose **Window → Utilities → Scripts**. In the Scripts panel,
  open **User**, then **indesign-toolkit-stable**. This folder is where
  Creative Script Kit's InDesign scripts appear. Double-click a script to run
  it.
  <!-- screenshot: Scripts panel with the folder open -->
- **Illustrator:** choose **File → Scripts → illustrator-toolkit-stable**, then
  pick a script.
  <!-- screenshot: File > Scripts menu -->

To **update**, paste the same line again and choose **Update**. To
**uninstall**, paste it and choose **Uninstall**.

## What next {#next}

[Folio: translate a layout](/folio/) · [More tools](/tools/) ·
[All scripts](/scripts/)

## Common problems

::: details It asks for my password
<a id="it-asks-for-my-password"></a>

That is Illustrator, and it happens once. Illustrator only reads scripts from a
folder inside the application itself, and your account cannot write there. The
installer asks once to create a folder of your own in that spot. On a Mac it
asks for the password you use to log in to the Mac; on Windows, Windows shows
an approval prompt and you click **Yes**. It is never an Adobe password. After
that, installs and updates never ask again.

If you say no, everything else still installs, and the installer prints the
line to run when you are ready.

When you upgrade Illustrator to a new version, that folder is removed with the
old version. Paste the install line again afterwards.
:::

::: details The scripts do not show up
- Restart InDesign or Illustrator. They only look for scripts when they open.
- If the installer said it could not find InDesign or Illustrator, see
  [It says it could not find InDesign or Illustrator](#not-found).
:::

::: details It says it could not find InDesign or Illustrator
<a id="not-found"></a>

The installer finds them by the folders they create the first time they open.
Open that application once, quit it, and paste the line again. The same goes
for a message that Illustrator *has not recorded which language it runs in*. If
it says it *found Illustrator, but could not identify its Scripts folder*, see
[How Illustrator's Scripts folder is found](/reference/advanced#how-illustrator-s-scripts-folder-is-found).
:::

::: details My work computer blocks it
<a id="work-computer-blocks"></a>

Some company computers are set up to refuse commands like this one. The
installer cannot get around that, and should not try. Ask your IT team, and
show them this page.
:::

::: details I cannot use a terminal
Download the project as a ZIP from
[GitHub](https://github.com/zxa24/creative-script-installer) (**Code →
Download ZIP**), unzip it, and double-click **install-update.bat** on Windows or
**install-update.command** on a Mac.

Your computer will warn you, because these files are not signed:

- **Windows** shows *"Windows protected your PC"*. Click **More info → Run
  anyway**.
- **Mac** says the file *"cannot be opened because it is from an unidentified
  developer"*. Right-click the file, choose **Open**, then **Open** again.

This route installs the copy you downloaded. To update, download it again.
:::

::: details Something went wrong
<a id="something-went-wrong"></a>

If an install fails, the installer prints a line that runs it again and saves a
log file to your Desktop. Run that line and send us the file it names, through
[GitHub](https://github.com/zxa24/creative-script-installer/issues). To ask for
the log yourself, see
[Collecting a log](/reference/advanced#collecting-a-log-when-something-goes-wrong).
:::

::: details Technical details

<a id="what-it-changes"></a>**What it changes on your computer**

Only these folders:

| | |
| --- | --- |
| InDesign scripts | `%APPDATA%\Adobe\InDesign\Version <N>\<language>\Scripts\Scripts Panel\indesign-toolkit-stable\` (Windows) · `~/Library/Preferences/Adobe InDesign/Version <N>/<language>/Scripts/Scripts Panel/indesign-toolkit-stable/` (macOS) |
| Illustrator scripts | a folder named `illustrator-toolkit-stable` inside Illustrator's own Scripts folder |

It installs one copy for every InDesign version on the computer. For
Illustrator, the folder it creates is made writable for you (`chown` on macOS,
one access-control entry on Windows), and only that folder.

Nothing else: no System Settings or Windows Settings entry, no login item, no
`PATH` change, no registry key, no scheduled task, no `defaults write`, no
InDesign or Illustrator preference. It installs scripts only (`.idjs` files and
their `lib/` folder); it is not a UXP plugin.

- **Windows execution policy:** `iex` evaluates text, and the policy governs
  script files, so the line runs even under `Restricted`. You do not need
  `Set-ExecutionPolicy`. A Group Policy setting can still block it (see
  [My work computer blocks it](#work-computer-blocks)).
- **macOS Gatekeeper:** nothing is downloaded and opened as an application on
  the one-line route, so there is no dialog to allow.
- **Admin rights:** the installer never runs as an administrator. Only the one
  command that creates the Illustrator folder is elevated. If no prompt is
  needed (a recent `sudo`, or an already elevated PowerShell), it passes
  silently.
- **Illustrator language:** the folder goes into the language folder
  Illustrator reads, taken from Illustrator's own settings. If Illustrator has
  never been launched, it installs nothing for Illustrator and says so (see
  [It says it could not find InDesign or Illustrator](#not-found)).

<a id="how-updating-behaves"></a>**How updating behaves**

- Everything is downloaded and checksum-verified before anything is written.
- InDesign: the whole folder is replaced in one step. If any step fails,
  nothing changes, and a failed swap puts the old folder back.
- Illustrator: each file is replaced in place, one at a time, because a
  whole-folder swap would need write access to the Adobe folder around it.
  Scripts an older version shipped and this one does not are removed; other
  files you put there are left alone.
- No old copy is kept after a successful update, because InDesign would show
  it as a second set of scripts. To go back, install the older version with
  `--source` (macOS) or `-Source` (Windows).
- Running it again is safe.

**The menu**

**Install**, **Update**, **Repair** (rewrite the files even if the version
matches) and **Uninstall** are offered only when they apply; `q` leaves without
changing anything. When everything is current there is no default. With no
terminal at all (a script or a deployment tool) it installs without asking. On
macOS, uninstall also works without the menu:

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash -s -- --uninstall
```

On Windows, uninstalling the Illustrator folder needs no administrator step. On
macOS it asks once, and a folder that still holds files the installer did not
put there is left alone.

**The `-stable` suffix**

It keeps an installed copy from colliding with a developer's link to a working
copy. A plain `indesign-toolkit` folder is removed only when it is one of the
installer's own earlier installs. If a link sits at the `-stable` name, the
installer refuses to write there.

More: [Advanced install options](/reference/advanced).
:::
