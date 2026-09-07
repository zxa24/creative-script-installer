#!/bin/sh
# Creative Script Installer - one-line bootstrap for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
#
# Downloads the distribution and runs the real installer from disk.
#
# THIS SCRIPT MUST NEVER READ STDIN.
# Piped into a shell, the script itself arrives ON stdin - so a `read` here
# would consume the script's own next line as its answer. It does not fail; it
# quietly eats itself and stops early. Measured against a control: the same
# script run from a file reads correctly, run through a pipe it does not.
#
# Anything that needs to ask a question therefore cannot live in this file.
#
# /bin/sh, not bash: this only has to fetch and hand off, and the fewer
# assumptions it makes about the shell the fewer ways it has to fail before it
# reaches the installer that does the real work.

set -eu

ZIP_URL="https://codeload.github.com/zxa24/creative-script-installer/zip/refs/heads/main"

TMP=""
cleanup() { [ -n "$TMP" ] && [ -d "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

for cmd in curl unzip; do
  command -v "$cmd" >/dev/null 2>&1 || {
    printf '%s\n' "This needs $cmd, which is not installed." >&2
    exit 1
  }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/csi.XXXXXX")"
printf '%s\n' "Downloading..."
curl -fsSL -o "$TMP/csi.zip" "$ZIP_URL"
unzip -q "$TMP/csi.zip" -d "$TMP/x"

DIR="$(find "$TMP/x" -maxdepth 1 -mindepth 1 -type d | head -n1)"
[ -n "$DIR" ] || { printf '%s\n' "The downloaded archive had no folder inside it." >&2; exit 1; }
[ -f "$DIR/install-update.sh" ] || {
  printf '%s\n' "install-update.sh is missing from the download." >&2; exit 1
}

# --source points at what was just downloaded, so the payload is not fetched
# twice. </dev/null keeps the installer from inheriting this script's stdin,
# which under `curl | bash` is the remainder of this file.
bash "$DIR/install-update.sh" --source="$DIR" </dev/null
