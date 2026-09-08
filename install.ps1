# Creative Script Installer - one-line bootstrap for Windows.
#
#   irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
#
# Downloads the distribution and runs the real installer from disk.
#
# THIS FILE MUST STAY PURE ASCII, AND MUST NOT HAVE A BOM.
# `iex` receives this file as a STRING, and a leading BOM (U+FEFF) is not
# stripped: it lands in front of the first token and the parse fails on a later
# line, with an error that points nowhere near the real cause. Measured.
#
# install-update.ps1 does carry a BOM, deliberately - Windows PowerShell 5.1
# reads a BOM-less .ps1 as the ANSI codepage and mangles the non-ASCII comments
# in it. Both are correct: that one is executed as a FILE, this one as a string.
# Keeping this file ASCII is what makes its BOM unnecessary.

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# Expand-Archive arrived in PowerShell 5.0 (Windows Management Framework 5).
# Windows 10 and 11 ship 5.1, so this is about older machines: on Windows 8.1
# (4.0) or 7 (2.0) without WMF5 the bootstrap would otherwise die on an
# unrecognised cmdlet and be reported as a generic "Install failed". install.sh
# checks for curl and unzip up front for the same reason; this side did not.
if (-not (Get-Command Expand-Archive -ErrorAction SilentlyContinue)) {
  Write-Host 'This needs PowerShell 5 or newer (Expand-Archive is missing).' -ForegroundColor Red
  Write-Host 'Windows 10 and 11 have it already. On an older Windows, install'
  Write-Host 'Windows Management Framework 5.1 from Microsoft, then try again.'
  $global:LASTEXITCODE = 1
  if ($MyInvocation.MyCommand.Path) { exit 1 }
  return
}

$ZipUrl = 'https://codeload.github.com/zxa24/creative-script-installer/zip/refs/heads/main'
$tmp = Join-Path $env:TEMP ('csi-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

# Initialised here, not only inside try/catch. Under iex this runs in the
# caller's session, where a variable of this name may already exist - an
# uninitialised read would inherit whatever they had.
$code = 0

try {
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $zip = Join-Path $tmp 'csi.zip'
  # Transient: shown while the download runs, erased when it is done. It answers
  # a question that stops existing the moment the step finishes, so leaving it
  # in the scrollback only puts noise between the person and the result.
  # Spaces and `r rather than ANSI erase codes: Windows PowerShell 5.1 does not
  # enable VT processing by default, so ANSI would print as literal garbage.
  $onScreen = -not [Console]::IsOutputRedirected
  if ($onScreen) { Write-Host "`rLoading..." -NoNewline } else { Write-Host 'Loading...' }
  Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing
  if ($onScreen) { Write-Host ("`r" + (' ' * 10) + "`r") -NoNewline }

  $ex = Join-Path $tmp 'x'
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  $dir = (Get-ChildItem -Path $ex -Directory | Select-Object -First 1)
  if (-not $dir) { throw 'The downloaded archive had no folder inside it.' }

  $script = Join-Path $dir.FullName 'install-update.ps1'
  if (-not (Test-Path -LiteralPath $script)) { throw "install-update.ps1 is missing from the download." }

  # Run it as a FILE, not via iex: it has a BOM and non-ASCII comments, both of
  # which only decode correctly when PowerShell reads it from disk. -Source
  # points at what we already downloaded, so the payload is not fetched twice.
  & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Source $dir.FullName
  $code = $LASTEXITCODE
}
catch {
  Write-Host ("Install failed: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Nothing was changed. Try again, or download the repository manually.'
  $code = 1
}
finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# DO NOT call `exit` unconditionally here.
#
# `iex` evaluates this file as a STRING in the caller's own session, so a
# top-level `exit` terminates THAT session - it closes the user's terminal tab
# the instant the install finishes. Measured, with a control:
#     'Write-Host BEFORE; exit 3' | iex ; Write-Host AFTER   -> only BEFORE, host exits 3
#     'Write-Host BEFORE'        | iex ; Write-Host AFTER    -> BEFORE and AFTER
#
# Run as a FILE (`powershell -File install.ps1`) the opposite is true: without
# `exit` the exit code is lost and a failed install reports success to whatever
# invoked it. $MyInvocation.MyCommand.Path tells the two apart - it is the file
# path when run as a file, and empty under iex. Measured both ways.
$global:LASTEXITCODE = $code
if ($MyInvocation.MyCommand.Path) { exit $code }
