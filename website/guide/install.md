---
title: Install and update
description: Install and update the InDesign and Illustrator scripts with one command on Windows or macOS - how to open a terminal, what the installer changes on the machine and what it deliberately does not, the single administrator step Illustrator needs, and how updates roll back if anything fails.
---

# Install and update

**One command** installs the toolkit and, run again later, updates it. There is
nothing to download by hand and nothing to unzip.

You do not need a GitHub account, git, or an administrator password — with one
exception, Illustrator, which is explained below and asks once.

## Install

### macOS

**Open Terminal.** Press <kbd>Cmd</kbd> + <kbd>Space</kbd>, type `Terminal`,
press <kbd>Return</kbd>. (It also lives in Applications → Utilities.)

Paste this and press <kbd>Return</kbd>:

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
```

### Windows

**Open PowerShell.** Press the <kbd>Windows</kbd> key, type `PowerShell`, press
<kbd>Enter</kbd>. (Or right-click the Start button and choose **Terminal**.)

Paste this and press <kbd>Enter</kbd>:

```powershell
irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

### Then

The installer prints what it found and what it did and, when it installed
something, finishes with a link to the next page. **Restart InDesign** (and
Illustrator, if you use it) — both build their script menus at launch, so
nothing appears until they restart.

Both applications need to have been **launched at least once** before this:
their script folders are created on first launch, and that is how the installer
finds them.

- InDesign: `Window → Utilities → Scripts`, then the
  **indesign-toolkit-stable** folder.
- Illustrator: `File → Scripts`, then **illustrator-toolkit-stable**.

::: tip Updating is the same command
Run the same line again whenever you want the latest version. If you are already
current it says so and installs nothing.
:::

## The menu

Run in a terminal, the installer shows what it found and offers only the choices
that apply — **Install**, **Update**, **Repair** (rewrite the files even if the
version already matches) or **Uninstall**, plus `q` to leave without changing
anything. Enter takes the sensible default; when everything is already current
there is no default, because the remaining choices all change something.

Uninstall lives in that menu. On macOS it can also be run without the menu:

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash -s -- --uninstall
```

The Windows one-line form cannot take a flag — `iex` receives text, not a
command — so use the menu there. Run with no terminal at all (a script, a
deployment tool) it does not ask: it installs.

## What it changes on your machine

Only these folders:

| | |
| --- | --- |
| InDesign scripts | `%APPDATA%\Adobe\InDesign\…\Scripts Panel\indesign-toolkit-stable\` · `~/Library/Preferences/Adobe InDesign/…/Scripts Panel/indesign-toolkit-stable/` |
| Illustrator scripts | one folder named `illustrator-toolkit-stable` inside Illustrator's own Scripts folder |

Plus **one permission**, and only if you use Illustrator: the folder it creates
there is made yours to write to — `chown` on macOS, an access-control entry on
Windows. It applies to that one folder, not to Illustrator's Scripts folder
around it.

**Nothing else.** No entry in System Settings or Windows Settings, no login
item, no `PATH` change, no registry key, no scheduled task, no `defaults write`,
no preference in InDesign or Illustrator. Uninstalling removes what it wrote —
on Windows outright; on macOS see [Uninstalling](#uninstalling) for the one
question it asks.

Two things you are often told to change for scripts like this, and do **not**
have to here:

- **Windows: your PowerShell execution policy.** `iex` evaluates text, and the
  policy governs script *files*, so the command runs even under `Restricted` —
  measured, not assumed. You do not need `Set-ExecutionPolicy`.
- **macOS: Gatekeeper.** Nothing is downloaded and opened as an application on
  this route, so there is no "unidentified developer" dialog to allow.

::: warning A company-managed PC can still say no
If Group Policy sets the execution policy, that overrides the installer's own
`-ExecutionPolicy Bypass` and the run will fail. That is a policy-level block;
the toolkit cannot work around it and should not try. Contact IT.
:::

## Illustrator asks for your password, once

InDesign keeps its Scripts panel folder inside your own user folder, so
installing there needs no permission at all. **Illustrator keeps its Scripts
folder inside the application itself**, which you cannot write to — and there is
no user-level alternative; Illustrator reads only that one folder.

So the first Illustrator install needs **one administrator step, once**. The
installer explains what it will create and asks — on macOS you then type your
password in the same window, on Windows you approve the prompt Windows shows. It
gives you a single folder of your own inside the application; it does not open
the rest of it. After that, every install and update runs with no password.

If no password is needed — macOS still remembers a recent `sudo`, or on Windows
PowerShell itself is already running as administrator — it does not
explain and does not ask. There is nothing to warn you about, so the step passes
in silence. (An administrator *account* in an ordinary PowerShell window is not
that case; Windows still shows its prompt.)

Saying no is an answer, not a failure: the run carries on with everything else,
and the exact command is printed at the end for you to run whenever you like.
The installer itself never runs as an administrator — the one folder-creating
command does.

::: warning An Illustrator upgrade removes it
Upgrading Illustrator replaces the whole application, and that folder goes with
it. Run the same one command again afterwards, then run the installer.
:::

If Illustrator has **never been launched**, it has recorded no language, and the
installer cannot tell which of its many language folders it reads. It says so
and installs nothing for Illustrator: launch Illustrator once and run again. An
installation the installer made earlier is always found again for updating and
uninstalling, whatever the recorded language. If Illustrator has recorded more
than one language, the scripts are installed for each of them and the run says
which.

## Uninstalling

`Uninstall` removes the scripts from both applications. What happens to the
Illustrator folder differs by platform, and only there:

- **Windows:** the folder goes with the scripts. The permission it was given
  includes the right to delete it, so no administrator step is needed and the
  permission disappears with the folder.
- **macOS:** removing the folder needs the same permission that creating it did,
  so the installer asks once — *Remove both? That needs your password once.* —
  and takes the folder and its permission together. Say no and the empty folder
  stays, and the run says so.

On either platform, a folder that still holds files the installer did not put
there is left alone, and the run says that too.

## Without a terminal

The repository also carries **`install-update.bat`** (Windows) and
**`install-update.command`** (macOS) for machines where pasting a command is not
practical, or for installing from a copy on a USB stick. Download
[the repository](https://github.com/zxa24/creative-script-installer) as a ZIP,
then double-click the one for your platform. It installs **the copy it sits in**
— that is the point of this route — so to update, download again.

This route does meet the operating system's warnings about unsigned files, which
the command above does not.

**Windows — SmartScreen.** A blue *"Windows protected your PC"* box appears
when you double-click the `.bat`. Click **More info → Run anyway**. If the
files arrived by email or cloud storage, Windows also marks them as coming
from the internet: right-click the file → **Properties** → tick **Unblock**.

**macOS — Gatekeeper.** macOS says the file *"cannot be opened because it is
from an unidentified developer"*. Right-click (or Control-click) the file →
**Open** → **Open** again in the dialog. Once is enough. If it says the
`.command` is not executable, run `chmod +x` on it once.

These appear because the files are not signed with a paid certificate. It is
normal, and it is the reason the command at the top of this page is the route
worth preferring: nothing is downloaded and opened as an application there.

## What gets installed, and where

The installer detects every installed InDesign version on the machine and
installs one copy per version. Illustrator gets one folder inside whichever
language folder Illustrator itself is using — it reads only one of them, and
which one is read from Illustrator's own settings rather than guessed.

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

- Everything is **downloaded and checksum-verified first**. Nothing is written
  until the whole payload has been verified.
- **InDesign:** the update is an **atomic replacement of the whole folder**. If
  any step fails, nothing changes — there is no half-installed state, and if the
  swap itself goes wrong the old folder is put back.
- **Illustrator:** the files are replaced **in place**, each one atomically. A
  whole-folder swap is not possible there: it would need write access to the
  Adobe folder around it, which the installer deliberately does not have. Each
  file is staged beside itself and then renamed, so the window in which the
  folder holds a mixture is as small as that permission model allows — but it is
  not the same guarantee as the InDesign path, and it is not claimed to be.
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
- **Running it again is safe.** If you are already on the latest version it
  installs nothing.

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
