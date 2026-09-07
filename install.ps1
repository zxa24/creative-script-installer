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

$ZipUrl = 'https://codeload.github.com/zxa24/creative-script-installer/zip/refs/heads/main'
$tmp = Join-Path $env:TEMP ('csi-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

try {
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $zip = Join-Path $tmp 'csi.zip'
  Write-Host 'Downloading...'
  Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing

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
  exit $LASTEXITCODE
}
catch {
  Write-Host ("Install failed: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Nothing was changed. Try again, or download the repository manually.'
  exit 1
}
finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
