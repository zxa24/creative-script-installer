#!/bin/sh
# Creative Script Installer - one-line bootstrap for macOS.
#
# NOT Linux, despite the shell being portable: install-update.sh looks in
# ~/Library/Preferences/Adobe InDesign and /Applications, so on Linux it can
# only ever reach "no installation found". Saying "and Linux" here promised
# something the thing it hands off to cannot do.
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
# No progress meter, and the reason is specific: GitHub builds this zip on the
# fly and sends no Content-Length, so curl cannot compute a percentage. What
# --progress-bar shows instead is its unknown-size animation - `-=#=- #  #  #`
# bouncing in place - which on a fast download is the ONLY thing that ever
# appears. It was read as mojibake, which is a fair reading: it carries no
# information and does not look like output.
#
# So: say what is happening in words, before and after. -sS keeps HTTP errors
# visible; -f keeps an error page from being saved as if it were the payload.
# Transient: shown while the download runs, erased when it is done. It answers
# a question that stops existing the moment the step finishes, so leaving it in
# the scrollback only puts noise between the person and the result.
# Only on a terminal - in a redirected log, \r and erase codes are garbage.
if [ -t 1 ]; then printf '\r\033[KLoading...'; else printf '%s\n' "Loading..."; fi
curl -fL -sS -o "$TMP/csi.zip" "$ZIP_URL"
[ -t 1 ] && printf '\r\033[K' || true
unzip -q "$TMP/csi.zip" -d "$TMP/x"

DIR="$(find "$TMP/x" -maxdepth 1 -mindepth 1 -type d | head -n1)"
[ -n "$DIR" ] || { printf '%s\n' "The downloaded archive had no folder inside it." >&2; exit 1; }
[ -f "$DIR/install-update.sh" ] || {
  printf '%s\n' "install-update.sh is missing from the download." >&2; exit 1
}

# --source points at what was just downloaded, so the payload is not fetched
# twice.
#
# </dev/null is deliberate and is NOT what silences the menu. Under `curl | bash`
# this script's stdin is the remainder of the script itself, and handing that to
# the installer would let a `read` swallow it. Closing it instead makes the
# installer see "stdin is not a terminal", which is exactly the condition that
# sends its questions to /dev/tty - so the menu still works, and still reads
# from the person rather than from the file.
bash "$DIR/install-update.sh" --source="$DIR" "$@" </dev/null
