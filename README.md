# Creative Script Installer

Installs and updates a set of Adobe scripts — InDesign to begin with — into the
places the applications actually read them from, and keeps them up to date from
the same button afterwards.

**No GitHub account, no git, no password.**

## Install

**Windows** — paste into PowerShell:

```powershell
irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

**macOS** — paste into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
```

Running the same line again updates an existing installation, and does nothing
if you are already current.

<details>
<summary>Prefer to download it instead?</summary>

Download this repository as a ZIP, unpack it, and then:

- **Windows** — double-click `install-update.bat`.
- **macOS** — right-click `install-update.command` and choose **Open** (not
  double-click) the first time, so Gatekeeper lets it through.

</details>

Then restart the application. The scripts appear under
**Window → Utilities → Scripts** (InDesign) as a numbered list: `1.x` is the
normal path, `2.x`–`4.x` are tools for when something specific needs fixing.

The first run may be stopped by SmartScreen or Gatekeeper because these scripts
are not code-signed. That is expected, and letting it through once is enough —
[the documentation explains exactly which button to press](https://zxa24.github.io/creative-script-installer/guide/install).

## Documentation

**https://zxa24.github.io/creative-script-installer/**

Every script, what it does, when to reach for it, and how the folders are laid
out. The site also publishes
[`llms.txt`](https://zxa24.github.io/creative-script-installer/llms.txt) and
[`llms-full.txt`](https://zxa24.github.io/creative-script-installer/llms-full.txt),
so you can give an AI assistant the site's address and ask it questions about
the toolkit directly.

## What gets installed, and where

Only scripts — no plugin, and no other InDesign setting is touched.

| | |
|---|---|
| Windows | `%APPDATA%\Adobe\InDesign\Version <N>\<language>\Scripts\Scripts Panel\` |
| macOS | `~/Library/Preferences/Adobe InDesign/Version <N>/<language>/Scripts/Scripts Panel/` |

Every installed InDesign version is detected and updated. Updating replaces the
whole folder at once: the new version is downloaded and verified first, and if
any step fails the existing installation is left exactly as it was. Running the
installer when you are already up to date does nothing.

**A successful update does not leave the previous version behind.** To go back,
reinstall an older distribution — see
[Advanced](https://zxa24.github.io/creative-script-installer/reference/advanced).

## License

See [LICENSE](LICENSE).
