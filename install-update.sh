#!/bin/bash
# install-update.sh  —  InDesign 工具箱 一键安装/更新 (macOS)
#
# 设计师双击 "install-update.command" (它调用本脚本) 即可。与 Windows 版对等:
#   探测 Scripts Panel → 取远端版本 → 已最新则跳过 → 否则下载 zip →
#   校验 sha256 (shasum -c) → 备份旧版 → 原子换入 → 失败自动回滚。绝不半装。
#
# 依赖均系统自带: bash / curl / unzip / shasum。无需 jq / python。
#
# 源地址可配置 (E-source 发布是独立步骤, 待用户批准):
#   TOOLKIT_SOURCE=<本地 .zip 或目录>   离线 / 自测 (最高优先)
#   TOOLKIT_ZIP_URL / TOOLKIT_MANIFEST_URL   完整 URL 覆盖
#   TOOLKIT_AUTH_TOKEN=<PAT>            私有源退路 (加 Authorization header)
#
# 排障日志 (默认关闭, 开了才落盘, 落在桌面):
#   --log   参数     |   CSI_LOG=1   环境变量
#   一行命令下:  curl -fsSL <install.sh> | bash -s -- --log
set -euo pipefail

# ===== 可配置源 (发布时设定) =====
OWNER="zxa24"
REPO="creative-script-installer"   # the public distribution repo
REF="main"

# Recognisably the repository, with a suffix saying which build it is. The
# suffix is what keeps it from colliding with a development machine's link to
# its working tree — and it is on THIS side on purpose. A name chosen here is
# applied by the installer on every machine automatically; a name that had to
# change on the development side would need a person to do it, once per machine,
# with the collision still live on every machine nobody got to.
INSTALL_FOLDER="indesign-toolkit-stable"

# What earlier versions installed under, and also what a development machine
# calls its bridge. Removed after a successful install so a designer who updates
# is not left with two sets of scripts — but ONLY when it is genuinely a leftover
# install. See migrate_legacy_folder: the same name serving both purposes is
# exactly why that check has to be careful rather than convenient.
LEGACY_FOLDER="indesign-toolkit"
MANIFEST_NAME="toolkit.manifest.json"
SHA_SIDECAR="toolkit.manifest.sha256"
PAYLOAD_SUBDIR="toolkit"
VERSION_MARKER=".installed_version.json"

SOURCE="${TOOLKIT_SOURCE:-}"
FORCE=0
DRYRUN=0
ACTION=""            # "", install, repair, uninstall  (empty = ask, if we can)

# 诊断日志【默认不落盘】—— 绝大多数运行没人会去看它, 而一个每次追加、从不轮转的
# 文件在机器上只增不减。出事时才开, 开了就落在【桌面】: 找得到, 也能直接拖出来发人。
# 两个开关是因为一行命令的两个入口能传的东西不同:
#   curl … | bash -s -- --log     ← 管道进来的 shell 可以收参数
#   CSI_LOG=1 (环境变量)          ← 与 Windows 的 irm|iex 对称, 那边只能靠它
LOGGING=0
case "${CSI_LOG:-}" in 1|true|yes|on|TRUE|YES|ON) LOGGING=1 ;; esac

for a in "$@"; do
  case "$a" in
    --force)     FORCE=1 ;;
    --dry-run)   DRYRUN=1 ;;
    --source=*)  SOURCE="${a#--source=}" ;;
    --install)   ACTION="install" ;;
    --repair)    ACTION="repair"; FORCE=1 ;;
    --uninstall) ACTION="uninstall" ;;
    --log)       LOGGING=1 ;;
  esac
done

# --- Asking a question when stdin is not available --------------------------
# Under `curl … | bash` the SCRIPT arrives on stdin, so `read` would consume the
# script's own next line as the answer - silently, eating the rest of itself.
# The terminal is still reachable as /dev/tty, so that is where questions go.
#
# `[ -r /dev/tty ]` is not a usable test for this: on a machine with no
# controlling terminal it returns true and the read then fails with "Device not
# configured". Measured. So the file is actually opened, and failing to open it
# is what means "nobody is there".
ask() {  # $1 = prompt; echoes the answer, returns 1 when there is no terminal
  if [ -t 0 ]; then
    printf '%s' "$1" >&2
    IFS= read -r __ans || return 1
    printf '%s' "$__ans"; return 0
  fi
  # The redirection must be inside the group. `exec 3</dev/tty 2>/dev/null`
  # does not work: redirections are applied left to right, so opening /dev/tty
  # fails and prints "Device not configured" BEFORE the 2>/dev/null that was
  # meant to hide it takes effect. Measured - the error reached the user on a
  # machine with no controlling terminal.
  { exec 3</dev/tty; } 2>/dev/null || return 1
  printf '%s' "$1" >&2
  if IFS= read -r __ans <&3; then exec 3<&-; printf '%s' "$__ans"; return 0; fi
  { exec 3<&-; } 2>/dev/null; return 1
}

LOGFILE=""
if [ "$LOGGING" = "1" ]; then
  __d="$HOME/Desktop"; [ -d "$__d" ] || __d="$HOME"
  LOGFILE="$__d/creative-script-installer-log-$(date '+%Y%m%d-%H%M%S').txt"
  if : > "$LOGFILE" 2>/dev/null; then
    {
      printf '%s\n' "creative-script-installer log  $(date '+%Y-%m-%d %H:%M:%S')"
      printf '%s\n' "$(uname -srm)  bash ${BASH_VERSION:-?}"
      printf '%s\n' "args: $*"
      printf '\n'
    } >> "$LOGFILE" 2>/dev/null || true
  else
    printf '%s\n' "Could not write a log to $__d - continuing without one." >&2
    LOGFILE=""
  fi
fi
log() {
  [ -n "$LOGFILE" ] || return 0
  printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOGFILE" 2>/dev/null || true
}

WORK=""
cleanup() {
  # 必须是第一行: 后面任何一条命令都会改写 $?, 而这里要的是【触发退出的那个】状态。
  __rc=$?
  [ -n "$WORK" ] && [ -d "$WORK" ] && rm -rf "$WORK" || true
  if [ -n "$LOGFILE" ]; then
    printf '\n%s\n' "Diagnostic log saved to: $LOGFILE"
  elif [ "$__rc" -ne 0 ]; then
    # 出事时才说怎么拿日志 —— 而不是让人事后去猜哪里有一个。
    printf '\n%s\n' "To save a diagnostic log for troubleshooting, run:"
    printf '%s\n'   "  curl -fsSL https://raw.githubusercontent.com/$OWNER/$REPO/$REF/install.sh | bash -s -- --log"
  fi
  return 0
}
trap cleanup EXIT

say()  { printf '%s\n' "$*"; log "$*"; }
fail() { printf '%s\n' "$*" >&2; log "! $*"; }

# --- 1. 探测 Scripts Panel 目录 (可能多版本 / 多 locale) -----------------------
#   ~/Library/Preferences/Adobe InDesign/Version <N>/<locale>/Scripts/Scripts Panel
find_panels() {
  local base="$HOME/Library/Preferences/Adobe InDesign"
  [ -d "$base" ] || return 0
  find "$base" -type d -path "*/Scripts/Scripts Panel" 2>/dev/null || true
}

# --- 2. 取得分发包 → 打印 dist 根 (含 manifest 的目录) --------------------------
find_dist_root() {
  local d="$1" hit
  hit="$(find "$d" -maxdepth 5 -name "$MANIFEST_NAME" -type f 2>/dev/null | head -n1)"
  [ -n "$hit" ] && dirname "$hit"
}

# Sets globals DIST_ROOT (+ WORK for cleanup). NOT called via $(...) — a
# command-substitution subshell would swallow the WORK assignment and leak the
# downloaded temp dir past the EXIT trap.
DIST_ROOT=""
acquire_distribution() {
  # (a) 本地 override
  if [ -n "$SOURCE" ]; then
    if [ -d "$SOURCE" ]; then
      DIST_ROOT="$(find_dist_root "$SOURCE")"; return 0
    elif [ -f "$SOURCE" ]; then
      WORK="$(mktemp -d "${TMPDIR:-/tmp}/indesign-toolkit-update.XXXXXX")"
      unzip -q "$SOURCE" -d "$WORK/extract"
      DIST_ROOT="$(find_dist_root "$WORK/extract")"; return 0
    else
      fail "Source does not exist: $SOURCE"; return 1
    fi
  fi
  # (b) 远端
  local zipUrl="${TOOLKIT_ZIP_URL:-https://codeload.github.com/$OWNER/$REPO/zip/refs/heads/$REF}"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/indesign-toolkit-update.XXXXXX")"
  local auth=(); [ -n "${TOOLKIT_AUTH_TOKEN:-}" ] && auth=(-H "Authorization: token $TOOLKIT_AUTH_TOKEN")
  # ${arr[@]+"${arr[@]}"} — not just "${arr[@]}". Under `set -u`, bash 3.2 (what
  # macOS ships) treats expanding an EMPTY array as an unbound variable and
  # aborts. auth is empty whenever no token is set, i.e. the normal case, so the
  # plain form kills the download for everyone. Newer bash does not do this,
  # which is why it survived every test on this side.
  # --progress-bar, not curl's default meter: the default is a table of twelve
  # numbers that redraws in place, and next to two lines of plain English it
  # reads like something went wrong. A bar says the one thing worth saying here,
  # which is that it is still moving. (Not -s: silence during a multi-megabyte
  # download reads as a hang.)
  if ! curl -fL --progress-bar ${auth[@]+"${auth[@]}"} -o "$WORK/dist.zip" "$zipUrl"; then return 1; fi
  unzip -q "$WORK/dist.zip" -d "$WORK/extract"
  DIST_ROOT="$(find_dist_root "$WORK/extract")"
}

read_version() {  # $1 = manifest.json path (pipefail-safe: 无匹配不触发 set -e 中止)
  { grep -m1 '"version"' "$1" 2>/dev/null || true; } \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

# --- 4. 装入单个 Scripts Panel (原子 mv swap + 回滚) ---------------------------
install_into() {  # $1 = panel dir, $2 = payload dir, $3 = version ; echo result
  local panel="$1" payload="$2" version="$3"
  local dst="$panel/$INSTALL_FOLDER" bak="$panel/$INSTALL_FOLDER.bak" new="$panel/$INSTALL_FOLDER.new"

  # A link here is a development bridge, never something this installer made.
  # Refuse before writing anything — an install that replaced it would look
  # completely successful while having deleted the developer's link to their
  # working tree.
  if [ -L "$dst" ]; then echo "blocked"; return 0; fi

  rm -rf "$new"   # 清上次崩溃残留 (InDesign 递归扫描面板 → 残树会显示为多余脚本组)

  if [ -d "$dst" ] && [ "$FORCE" != "1" ] && [ -f "$dst/$VERSION_MARKER" ]; then
    local cur; cur="$(read_version "$dst/$VERSION_MARKER" 2>/dev/null || true)"
    if [ -n "$cur" ] && [ "$cur" = "$version" ]; then rm -rf "$bak"; echo "skip"; return 0; fi
  fi
  if [ "$DRYRUN" = "1" ]; then echo "would-install"; return 0; fi

  cp -R "$payload" "$new"
  printf '{"version":"%s","installedAt":"%s","source":"%s"}\n' \
    "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OWNER/$REPO@$REF" > "$new/$VERSION_MARKER"

  rm -rf "$bak"
  local moved=0
  [ -d "$dst" ] && { mv "$dst" "$bak"; moved=1; }
  if ! mv "$new" "$dst"; then
    [ "$moved" = "1" ] && [ -d "$bak" ] && [ ! -d "$dst" ] && mv "$bak" "$dst"
    return 1
  fi
  rm -rf "$bak"   # 成功: 不在面板里留 .bak 副本树 (否则面板显示重复脚本组)
  echo "installed"
}

# --- 4c. 卸载 ----------------------------------------------------------------
# Same guard as installing, for the same reason: a link here is a development
# bridge, and removing it takes away someone's connection to their working tree.
# An uninstall that quietly did that would look like it worked.
uninstall_from() {  # $1 = panel dir ; echoes result
  local dst="$1/$INSTALL_FOLDER"
  if [ -L "$dst" ]; then echo "blocked"; return 0; fi
  [ -d "$dst" ] || { echo "absent"; return 0; }
  if [ "$DRYRUN" = "1" ]; then echo "would-remove"; return 0; fi
  rm -rf "$dst" && echo "removed" || echo "failed"
}

installed_version_at() {  # $1 = panel dir
  local mk="$1/$INSTALL_FOLDER/$VERSION_MARKER"
  [ -f "$mk" ] && read_version "$mk" 2>/dev/null || true
}

# --- 4b. 清理旧名字下的安装 (仅当确实是我们装的) -----------------------------
# Runs only AFTER a successful install, so a failure never leaves the panel with
# neither folder.
#
# LEGACY_FOLDER is also what a development machine names its bridge, so this has
# to tell an old install apart from a link to somebody's working tree. Deleting
# the wrong one is destructive and silent. Two independent tests:
#   1. not a link          — a bridge always is, an install never is
#   2. carries our marker  — a hand-made folder or a checkout has none
# Either would do on paper. Both are here because they fail differently: a link
# with a stray marker file inside passes (2), a plain directory someone made by
# hand passes (1).
# Silent when it declines, which is almost always. Announcing that it did NOT
# touch a folder the user never asked about is noise, and worse, it fires
# precisely when nothing is wrong: on any development machine that folder is a
# bridge, so a normal run ended with a line about a directory the installer has
# no business discussing. Only the removal is reported, because only the removal
# happened.
migrate_legacy_folder() {  # $1 = panel dir
  local old="$1/$LEGACY_FOLDER"
  [ -e "$old" ] || return 0
  [ -L "$old" ] && return 0                        # a bridge - not ours
  [ -f "$old/$VERSION_MARKER" ] || return 0         # someone else put it there
  rm -rf "$old" && say "(removed a previous installation under the old name ${LEGACY_FOLDER})"
}

# 任一探测到的面板未装 / 版本不符 → 需要更新 (return 0)。全部一致 → return 1。
# 用 here-string 喂 while (非 pipe) → 循环在当前 shell, return 能正确回退函数。
panels_need_update() {  # $1 = version
  [ "$FORCE" = "1" ] && return 0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    local mk="$p/$INSTALL_FOLDER/$VERSION_MARKER"
    [ -f "$mk" ] || return 0
    local cur; cur="$(read_version "$mk" 2>/dev/null || true)"
    [ "$cur" = "$1" ] || return 0
  done <<< "$PANELS"
  return 1
}

# ============================ 主流程 ==========================================
say ""
say "Checking for updates..."

PANELS="$(find_panels)"
if [ -z "$PANELS" ]; then
  say "No InDesign installation found. Install and launch InDesign once, then run this again."
  exit 3
fi

# --- 状态 + 菜单 --------------------------------------------------------------
# Only when no action was given on the command line AND a terminal is reachable.
# Everything scripted - automation, CI, the bootstraps' own --source hand-off -
# keeps the old behaviour of just installing, so adding a menu cannot silently
# turn an unattended run into one that waits forever for an answer.
# The version on offer. With a local --source it comes from that source's own
# manifest, NOT from the network.
#
# Reading it only over the network was wrong in the case that matters most: the
# one-line bootstraps always pass --source, having already downloaded. So the
# available version was never known on that path, every installation looked
# current, and the menu could never offer "Update" — on the route almost
# everyone takes. Found by constructing the mismatch on purpose; a run where
# things happen to be current looks identical.
RVER=""
if [ -n "$SOURCE" ]; then
  LM="$(find "$SOURCE" -maxdepth 5 -name "$MANIFEST_NAME" -type f 2>/dev/null | head -n1)"
  [ -n "$LM" ] && RVER="$(read_version "$LM" 2>/dev/null || true)"
else
  MURL0="${TOOLKIT_MANIFEST_URL:-https://raw.githubusercontent.com/$OWNER/$REPO/$REF/$MANIFEST_NAME}"
  pa0=(); [ -n "${TOOLKIT_AUTH_TOKEN:-}" ] && pa0=(-H "Authorization: token $TOOLKIT_AUTH_TOKEN")
  RM0="$(curl -fsSL ${pa0[@]+"${pa0[@]}"} "$MURL0" 2>/dev/null || true)"
  [ -n "$RM0" ] && RVER="$(printf '%s' "$RM0" | { grep -m1 '"version"' || true; } \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
fi

# Is there anyone to ask? Checked BEFORE printing anything, so an unattended run
# does not emit a menu nobody can answer - which is just noise in a CI log, and
# worse, reads like it stopped and waited.
has_tty() {
  [ -t 0 ] && return 0
  { exec 4</dev/tty; } 2>/dev/null || return 1
  { exec 4<&-; } 2>/dev/null; return 0
}
if [ -z "$ACTION" ] && ! has_tty; then ACTION="install"; fi

if [ -z "$ACTION" ]; then
  INSTALLED_ANY=0; ALL_CURRENT=1
  say ""
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    lv="$(installed_version_at "$p")"
    label="$(printf '%s' "$p" | sed -E 's#.*/Adobe InDesign/([^/]*)/([^/]*)/.*#\1 (\2)#')"
    if [ -L "$p/$INSTALL_FOLDER" ]; then
      say "  ${label}: a link is in the way (development bridge) - see DEV-BRIDGE.md"
    elif [ -n "$lv" ]; then
      INSTALLED_ANY=1
      if [ -n "$RVER" ] && [ "$lv" != "$RVER" ]; then
        ALL_CURRENT=0; say "  ${label}: installed v${lv} - v${RVER} available"
      else
        say "  ${label}: installed v${lv}"
      fi
    else
      ALL_CURRENT=0; say "  ${label}: not installed"
    fi
  done <<< "$PANELS"

  say ""
  # When everything is already current there is no install/update to offer, so
  # it is not offered. An entry that does nothing still has to be read, chosen
  # against, and understood — and the earlier attempt at one ("Reinstall
  # (repair)") did not even do nothing honestly: it reported success and changed
  # no files, which is the worst possible answer for someone reaching for a
  # repair. Removing it is better than wording it well.
  #
  # Numbering follows the options actually shown rather than staying fixed, so
  # there is never a gap for the reader to interpret. The default follows too:
  # with nothing to install, Enter means quit, because Repair rewrites files and
  # should be asked for rather than fallen into.
  # Only offer what there is something to do. Repair and Uninstall need an
  # existing installation; Install needs the absence of one. An option that
  # cannot apply still costs the reader something — it has to be read,
  # understood and ruled out — and if chosen it can only report a non-event.
  #
  # Numbering and the default follow the options actually shown, so there is
  # never a gap to interpret. Where nothing needs installing, Enter quits:
  # Repair rewrites files and should be asked for, not fallen into.
  if [ "$INSTALLED_ANY" = "0" ]; then
    say "  1) Install"
    say "  q) Quit"
    say ""
    CHOICE="$(ask '  Choose [1]: ')" || CHOICE="__NOTTY__"
    case "$CHOICE" in
      __NOTTY__|""|1) ACTION="install" ;;
      q|Q)            say ""; say "Nothing was changed."; exit 0 ;;
      *)              say ""; say "Not one of the choices: ${CHOICE}"; exit 2 ;;
    esac
  elif [ "$ALL_CURRENT" = "0" ]; then
    say "  1) Update    - install the newer version"
    say "  2) Repair    - rewrite the files even if the version already matches"
    say "  3) Uninstall - remove the installed scripts"
    say "  q) Quit"
    say ""
    CHOICE="$(ask '  Choose [1]: ')" || CHOICE="__NOTTY__"
    case "$CHOICE" in
      __NOTTY__|""|1) ACTION="install" ;;       # nobody to ask - behave as before
      2)              ACTION="repair"; FORCE=1 ;;
      3)              ACTION="uninstall" ;;
      q|Q)            say ""; say "Nothing was changed."; exit 0 ;;
      *)              say ""; say "Not one of the choices: ${CHOICE}"; exit 2 ;;
    esac
  else
    say "  1) Repair    - rewrite the files even if the version already matches"
    say "  2) Uninstall - remove the installed scripts"
    say "  q) Quit"
    say ""
    # No default shown. Both remaining options change something, so neither
    # should be what Enter does - and hinting "[q]" reads as advice to leave.
    CHOICE="$(ask '  Choose: ')" || CHOICE="__NOTTY__"
    case "$CHOICE" in
      __NOTTY__)  ACTION="install" ;;
      1)          ACTION="repair"; FORCE=1 ;;
      2)          ACTION="uninstall" ;;
      ""|q|Q)     say ""; say "Nothing was changed."; exit 0 ;;
      *)          say ""; say "Not one of the choices: ${CHOICE}"; exit 2 ;;
    esac
  fi
  say ""
fi

if [ "$ACTION" = "uninstall" ]; then
  REMOVED=0; BLOCKED_U=0; ABSENT=0; UFAILED=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$(uninstall_from "$p")" in
      removed)      REMOVED=$((REMOVED+1)) ;;
      would-remove) REMOVED=$((REMOVED+1)) ;;
      blocked)      BLOCKED_U=$((BLOCKED_U+1)) ;;
      absent)       ABSENT=$((ABSENT+1)) ;;
      *)            UFAILED=$((UFAILED+1)) ;;
    esac
  done <<< "$PANELS"
  say ""
  [ "$BLOCKED_U" -gt 0 ] && say "Skipped ${BLOCKED_U} location(s): ${INSTALL_FOLDER} there is a link, not a folder."
  if [ "$DRYRUN" = "1" ]; then
    say "[dry run] Would remove ${REMOVED} installation(s). Nothing was written."
  elif [ "$UFAILED" -gt 0 ]; then
    say "Removed ${REMOVED}, failed ${UFAILED} - InDesign may have the files open. Close it and try again."
    exit 1
  elif [ "$REMOVED" -gt 0 ]; then
    say "Removed ${REMOVED} installation(s). Restart InDesign for the panel to catch up."
  else
    say "Nothing to remove - no installation was found."
  fi
  exit 0
fi

# 远端预检 (设计 §2.2): 只取小 manifest, 若所有面板已是该版本则直接收工, 不下整包。
# 仅远端 + 非 dry-run 生效; 本地源跳过。预检失败(离线/无 manifest)回落到完整 acquire。
if [ -z "$SOURCE" ] && [ "$DRYRUN" != "1" ]; then
  MURL="${TOOLKIT_MANIFEST_URL:-https://raw.githubusercontent.com/$OWNER/$REPO/$REF/$MANIFEST_NAME}"
  pauth=(); [ -n "${TOOLKIT_AUTH_TOKEN:-}" ] && pauth=(-H "Authorization: token $TOOLKIT_AUTH_TOKEN")
  # Same bash 3.2 empty-array trap as in acquire_distribution — see the note there.
  RMANI="$(curl -fsSL ${pauth[@]+"${pauth[@]}"} "$MURL" 2>/dev/null || true)"
  if [ -n "$RMANI" ]; then
    RVER="$(printf '%s' "$RMANI" | { grep -m1 '"version"' || true; } | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
    if [ -n "$RVER" ] && ! panels_need_update "$RVER"; then
      say ""
      say "Already up to date (v${RVER})."
      exit 0
    fi
  fi
fi

acquire_distribution || true
ROOT="$DIST_ROOT"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/$MANIFEST_NAME" ]; then
  fail "A network or source error stopped the update. Nothing was changed. Try again, or ask IT."
  exit 1
fi
# 绝对化 ROOT: 相对的 --source 目录会让下面 (cd "$PAYLOAD" && shasum -c "$ROOT/侧车")
# 里的相对 $ROOT 在 cd 后解析错 → 误报校验失败、拒装一个好包。
ROOT="$(cd "$ROOT" && pwd)"

VERSION="$(read_version "$ROOT/$MANIFEST_NAME")"
PAYLOAD="$ROOT/$PAYLOAD_SUBDIR"
[ -d "$PAYLOAD" ] || { fail "The distribution has no '$PAYLOAD_SUBDIR' folder"; exit 4; }

# 完整性校验 (fail-closed, 与 Windows 无条件校验对齐): 侧车必须存在且通过。
# 缺侧车 = 分发包异常/被剥离 → 拒装, 不静默跳过 (缺校验时校验正是唯一防线)。
# shasum -c CWD=payload → 侧车里的路径为 payload 相对。
if [ ! -f "$ROOT/$SHA_SIDECAR" ]; then
  fail "The downloaded package has no checksum list. Nothing was changed. Try again, or ask IT."
  exit 4
fi
if ! ( cd "$PAYLOAD" && shasum -a 256 -c "$ROOT/$SHA_SIDECAR" >/dev/null 2>&1 ); then
  fail "The downloaded files failed verification. Nothing was changed. Try again, or ask IT."
  exit 4
fi

INSTALLED=0; SKIPPED=0; WOULD=0; FAILED=0; BLOCKED=0; BLOCKED_PANELS=""
while IFS= read -r panel; do
  [ -z "$panel" ] && continue
  # 用 if 测 install_into 返回码: 单面板换入失败 (InDesign 占用文件) 不因 set -e
  # 中止整个脚本、也不误报"全部未改"。失败面板已在 install_into 里回滚到旧版。
  if r="$(install_into "$panel" "$PAYLOAD" "$VERSION")"; then
    case "$r" in
      installed)     INSTALLED=$((INSTALLED+1)); migrate_legacy_folder "$panel" ;;
      skip)          SKIPPED=$((SKIPPED+1)) ;;
      would-install) WOULD=$((WOULD+1)) ;;
      blocked)       BLOCKED=$((BLOCKED+1)); BLOCKED_PANELS="${BLOCKED_PANELS}${panel}
" ;;
    esac
  else
    FAILED=$((FAILED+1))
  fi
done <<< "$PANELS"

say ""
if [ "$BLOCKED" -gt 0 ]; then
  say "Skipped ${BLOCKED} location(s): ${INSTALL_FOLDER} there is a link, not a folder."
  say "Nothing was written there, so a link to a working copy cannot be destroyed."
  say ""
  printf '%s' "$BLOCKED_PANELS" | while IFS= read -r bp; do
    [ -n "$bp" ] && say "  ${bp}/${INSTALL_FOLDER}"
  done
  say ""
  say "Rename or remove that link and run again."
  say "See DEV-BRIDGE.md in the repository."
  say ""
fi
if [ "$DRYRUN" = "1" ]; then
  # Report both numbers. "Would install into 0 locations" on its own reads as a
  # failure to find anything, when the actual reason is that every location is
  # already current - two very different things behind the same sentence.
  if [ "$WOULD" -eq 0 ] && [ "$SKIPPED" -gt 0 ]; then
    say "[dry run] Nothing to do: ${SKIPPED} location(s) already have v${VERSION}."
  else
    say "[dry run] Would install into ${WOULD} location(s) (v${VERSION}); ${SKIPPED} already current. Nothing was written."
  fi
elif [ "$FAILED" -gt 0 ] && [ "$INSTALLED" -gt 0 ]; then
  say "Updated to v${VERSION} in some locations, but ${FAILED} failed - InDesign may have the files open. Close InDesign and run again."
  exit 1
elif [ "$FAILED" -gt 0 ]; then
  say "Update failed in ${FAILED} location(s); nothing was updated. Your existing scripts are unchanged. Close InDesign and run again, or ask IT."
  exit 1
elif [ "$INSTALLED" -gt 0 ]; then
  say "Updated to v${VERSION}. Restart InDesign to see the scripts in the Scripts panel."
  [ "$SKIPPED" -gt 0 ] && say "(${SKIPPED} location(s) were already up to date)"
  [ "$BLOCKED" -gt 0 ] && say "(${BLOCKED} location(s) were skipped, see above)"
elif [ "$BLOCKED" -gt 0 ]; then
  # 说发生了什么, 不说打算发生什么。这里原先落进下面那个 else, 于是在一个字都
  # 没写入的情况下打印"已是最新版本" —— 用户会据此认为脚本已经装好了。
  say "Nothing was installed: all ${BLOCKED} location(s) were skipped, see above."
  exit 1
else
  say "Already up to date (v${VERSION})."
fi

# 显式成功退出: 否则 set -e 下末条命令 (上面 && 短路的 [ -gt 0 ]) 会让脚本
# 以 1 退出, 即便安装成功 —— 运行时自测 SH1/SH3 捕获。
exit 0
