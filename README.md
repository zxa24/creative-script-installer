# Creative Script Installer

The installer for **[Creative Script Kit](https://zxa24.github.io/creative-script-installer/)**:
scripts for Adobe InDesign and Illustrator. One line installs them where the
applications read them, and the same line updates them later.

**No GitHub account, no git.** No password for InDesign. Illustrator keeps its
scripts inside the application itself, so its first install asks for your
computer's password, once.

## Install

**Windows**: paste into PowerShell:

```powershell
irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

**macOS**: paste into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
```

Running the same line again updates an existing installation, and does nothing
if you are already current.

<details>
<summary>Prefer to download it instead?</summary>

Download this repository as a ZIP, unpack it, and then:

- **Windows**: double-click `install-update.bat`.
- **macOS**: right-click `install-update.command` and choose **Open** (not
  double-click) the first time, so Gatekeeper lets it through.

</details>

Then restart InDesign and Illustrator. The scripts appear under
**Window → Utilities → Scripts → User → indesign-toolkit-stable** in InDesign
and **File → Scripts → illustrator-toolkit-stable** in Illustrator.

The first run of a downloaded file may be stopped by SmartScreen or Gatekeeper,
because these scripts are not code-signed. That is expected, and letting it
through once is enough:
[the documentation shows which button to press](https://zxa24.github.io/creative-script-installer/guide/install).

## Documentation

**https://zxa24.github.io/creative-script-installer/** (English and Chinese)

- **Folio**: translate a finished InDesign layout without rebuilding it. The
  designer exports the text, a translator works in a web page, and the
  translation goes back into the same layout.
- **More tools**: general scripts for InDesign and Illustrator, outside the
  translation work.
- **All scripts**: every script by its name in the Scripts panel or the File
  menu, with what it does.

The site also publishes
[`llms.txt`](https://zxa24.github.io/creative-script-installer/llms.txt) and
[`llms-full.txt`](https://zxa24.github.io/creative-script-installer/llms-full.txt),
so you can give an AI assistant the site's address and ask it questions
directly.

## What gets installed, and where

Only scripts: no plugin, and no application setting is touched. InDesign gets a
folder in your own Scripts panel; Illustrator gets one folder inside its own
Scripts folder, made yours to write to with one administrator step.

| | |
|---|---|
| Windows | `%APPDATA%\Adobe\InDesign\Version <N>\<language>\Scripts\Scripts Panel\` |
| macOS | `~/Library/Preferences/Adobe InDesign/Version <N>/<language>/Scripts/Scripts Panel/` |

Every installed InDesign version is detected and updated. Everything is
downloaded and verified before anything is written. For InDesign the folder is
then swapped in whole, so a failure leaves the existing installation exactly as
it was; for Illustrator the files are replaced in place. Running the installer
when you are already up to date installs nothing.

**A successful update does not leave the previous version behind.** To go back,
reinstall an older distribution; see
[Advanced install options](https://zxa24.github.io/creative-script-installer/reference/advanced).

## License

See [LICENSE](LICENSE).
