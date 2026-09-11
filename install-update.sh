#!/bin/bash
# install-update.sh  —  Creative Script Installer 一键安装/更新 (macOS)
#
# 装两套脚本: InDesign 的(Scripts Panel, 用户目录, 无需权限)与 Illustrator 的
# (应用包内部, 需要一次性管理员步骤)。没装某个应用时对它只字不提。
#
# 设计师双击 "install-update.command" (它调用本脚本) 即可; 主路径是一行命令
# (install.sh)。与 Windows 版对等:
#   探测两个应用 → 取版本 → 已最新则跳过 → 否则下载 zip → 校验 sha256
#   (shasum -c) → InDesign 整目录原子换入(失败回滚) / Illustrator 目录内逐文件
#   原子替换。绝不半装。
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
MANIFEST_NAME="indesign-toolkit.manifest.json"
SHA_SIDECAR="indesign-toolkit.manifest.sha256"
PAYLOAD_SUBDIR="indesign-toolkit"
VERSION_MARKER=".installed_version.json"

# Illustrator: a separate payload with its own manifest, because it is a
# different set of scripts going to a different place under different rules.
AI_FOLDER="illustrator-toolkit-stable"
AI_PAYLOAD_SUBDIR="illustrator-toolkit"
AI_MANIFEST_NAME="illustrator-toolkit.manifest.json"
AI_SHA_SIDECAR="illustrator-toolkit.manifest.sha256"

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
  status_clear
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
  status_clear
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

# A transient status line: shown while a step runs, gone once it is done.
#
# These lines ("Loading...", "Checking for updates...") answer a question that
# stops existing the moment the step finishes. Left in the scrollback they are
# just noise between the person and the two lines they actually wanted.
#
# Only on a terminal. Redirected to a file or a CI log, \r and erase codes are
# garbage, so there it stays an ordinary line - a log wants the history a screen
# does not.
STATUS_ON=0
status() {
  log "$*"
  if [ -t 1 ]; then printf '\r\033[K%s' "$*"; STATUS_ON=1
  else printf '%s\n' "$*"; fi
}
status_clear() {
  # ${:-0} is harmless belt-and-braces. ⚠ The justification that used to be
  # here was wrong: it claimed an exit between the trap being armed and
  # STATUS_ON being set would hit an unbound variable, but in that window this
  # function is not defined yet, so the trap's call is a command-not-found and
  # the guarded body never runs at all.
  [ "${STATUS_ON:-0}" = "1" ] || return 0
  printf '\r\033[K'; STATUS_ON=0
}
# Every real output wipes a pending status line first. Done here rather than at
# each call site so it cannot be forgotten at one of them - and a forgotten one
# leaves the next line printed on top of the status text.
say()  { status_clear; printf '%s\n' "$*"; log "$*"; }
# ok / warn / fail —— 与 install-update.ps1 的 Ok / Warn / Err 一一对应。
# 🔴 哪一句该是哪一档【不是在这里决定的】: 参照系是 install-update.ps1,
#    severity 逐条从它那边抄。凭语气判断是 91 次判断, 错一次就是颜色在说谎 ——
#    而一行绿色的"成功"其实是警告, 比没有颜色更糟(没颜色时人还会去读那行字)。
#    两边是否还对得上, 由 tools/check-message-parity.js 断言, 不靠记性。
# 颜色码与 ps1 的 ForegroundColor 对应: ok=32 绿 / warn=33 黄 / err=31 红。
# 非 tty(管道/重定向)时不发转义序列 —— 否则日志与被 grep 的输出里会混进控制字符。
# ⚠ log 记的是 "$*" 原文, 永远不含转义序列: 日志要的是可读的历史, 不是屏幕的副本。
ok()   { status_clear; if [ -t 1 ]; then printf '\033[32m%s\033[0m\n' "$*"; else printf '%s\n' "$*"; fi; log "$*"; }
warn() { status_clear; if [ -t 1 ]; then printf '\033[33m%s\033[0m\n' "$*"; else printf '%s\n' "$*"; fi; log "$*"; }
# fail 一直写 stderr, 保持不动 —— 只加颜色。
# ⚠ 守卫看的是 fd 2(它自己写的那个流), ⛔ 不是 fd 1: `cmd >file` 之下 stderr 仍是
#   终端, 那时该上色; `cmd 2>file` 之下不该。用 -t 1 守卫一个写 fd 2 的输出, 两种
#   情形都会判反 —— 而判反的方向恰好是"把转义序列写进文件", 即这条守卫要防的事。
fail() {
  status_clear
  if [ -t 2 ]; then printf '\033[31m%s\033[0m\n' "$*" >&2; else printf '%s\n' "$*" >&2; fi
  log "! $*"
}

# 状态行的标记列(owner 2026-09-11:「有更新的字样放到前面使其更显著」)。
# 原先写在句尾 —— "InDesign: installed v1.0.0 - v1.0.3 available" —— 要扫到行末才知道
# 这行要不要紧。放到行首对齐成一列, 有几项待更新一眼数得出。
# 🔴 MARK_NONE 由 MARK_UPDATE 派生, 不是另写八个空格: 两个写死的值"恰好等长"是巧合,
#    而巧合会在下一个改宽度的人手里安静地断开 —— 断开时没有任何东西会报错, 只是列歪了。
# ⚠ 这一段与 install-update.ps1 是【同一个界面的两份实现】。改一边不改另一边 = 制造
#    第二个真相来源; 两边的措辞与列宽必须一起动。
MARK_UPDATE='UPDATE  '
MARK_NONE="$(printf '%*s' "${#MARK_UPDATE}" '')"
# 只有"待更新"这一种状态上色: 它是唯一一条【读者要据此动手】的。把"已是最新"也上色
# 等于把颜色变成装饰, 那之后颜色就不再意味着任何事。
# 绿色(32)是 owner 2026-09-11 定的(初版用黄 33)。⚠ 这里【不是】"一切正常"的绿,
# 是"有新东西可拿"的绿; 黄色在这套输出里读起来像出了问题, 而有更新并不是问题。
# 非 tty(管道/重定向)时不发转义序列 —— 否则日志与被 grep 的输出里会混进控制字符。
say_update() {
  status_clear
  if [ -t 1 ]; then printf '\033[32m%s\033[0m\n' "$*"; else printf '%s\n' "$*"; fi
  log "$*"
}

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
  # Neither the default meter nor --progress-bar. The default is a table of
  # twelve numbers redrawing in place; --progress-bar, against a source that
  # sends no Content-Length (GitHub builds this zip on the fly), degrades to a
  # bouncing `-=#=- #  #  #` that carries no information. Both read as a fault
  # rather than as progress. Words, before and after, instead.
  status "Loading..."
  # Timeouts, deliberately. Without them a firewall that DROPS packets rather
  # than refusing leaves the run sitting on "Checking for updates..." with
  # nothing on screen until curl's own default gives up.
  if ! curl -fL -sS --connect-timeout 20 --max-time 600 ${auth[@]+"${auth[@]}"} -o "$WORK/dist.zip" "$zipUrl"; then return 1; fi
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

  # Checked. If a leftover .new survives, `cp -R "$payload" "$new"` copies
  # INTO it rather than creating it, the swap then succeeds, and the scripts
  # land one directory deeper than the panel expects - reported as a clean
  # install, and repeated on every run after. Same shape as the moved=1 bug
  # described below; reproduced by the reviewer.
  rm -rf "$new" || return 1   # 清上次崩溃残留 (InDesign 递归扫描面板 → 残树会显示为多余脚本组)

  if [ -d "$dst" ] && [ "$FORCE" != "1" ] && [ -f "$dst/$VERSION_MARKER" ]; then
    local cur; cur="$(read_version "$dst/$VERSION_MARKER" 2>/dev/null || true)"
    if [ -n "$cur" ] && [ "$cur" = "$version" ]; then rm -rf "$bak"; echo "skip"; return 0; fi
  fi
  if [ "$DRYRUN" = "1" ]; then echo "would-install"; return 0; fi

  # Every write below is checked by hand. `set -e` does NOT reach inside this
  # function: it is called as "$(install_into …)", and a failing command in a
  # command substitution does not abort it - measured on this machine WITH a
  # control (a plain call to the same function does abort; `r="$(f)"` does not,
  # in or out of a test context). So an unchecked failure here would run on to
  # `echo "installed"` and report success.
  cp -R "$payload" "$new" || { rm -rf "$new"; return 1; }
  printf '{"version":"%s","installedAt":"%s","source":"%s"}\n' \
    "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OWNER/$REPO@$REF" > "$new/$VERSION_MARKER" \
    || { rm -rf "$new"; return 1; }

  # Checked, the way `.new` above is: if this rm fails, the `mv "$dst" "$bak"`
  # below moves the old tree INSIDE the surviving .bak and returns 0, the new
  # tree swaps in, and "installed" is reported with the old install one level
  # down in the panel - the same shape as the .new bug already fixed here.
  rm -rf "$bak" || { rm -rf "$new"; return 1; }
  local moved=0
  # moved=1 ONLY if the move succeeded. It used to be set unconditionally in a
  # ;-separated group, and the consequence was measured: a failed `mv` still
  # armed the rollback guard, $dst was therefore still present, and the next
  # `mv "$new" "$dst"` moved the new tree INSIDE the old one and returned 0.
  # The marker then sat one level down, so every later run read "not installed"
  # and did it again - a false success that repeated forever.
  if [ -d "$dst" ]; then
    mv "$dst" "$bak" || { rm -rf "$new"; return 1; }
    moved=1
  fi
  if ! mv "$new" "$dst"; then
    [ "$moved" = "1" ] && [ -d "$bak" ] && [ ! -d "$dst" ] && mv "$bak" "$dst"
    rm -rf "$new"
    return 1
  fi
  # 成功: 不在面板里留 .bak 副本树 (否则面板显示重复脚本组)。Unchecked before -
  # a .bak that survived was never mentioned, and InDesign showed two sets.
  rm -rf "$bak" || say "  (a leftover copy at ${bak} could not be removed - InDesign may list the scripts twice until it is)"
  echo "installed"
}

# --- 4c. 卸载 ----------------------------------------------------------------
# Same guard as installing, for the same reason: a link here is a development
# bridge, and removing it takes away someone's connection to their working tree.
# An uninstall that quietly did that would look like it worked.
uninstall_from() {  # $1 = panel dir ; echoes result
  local dst="$1/$INSTALL_FOLDER" bak="$1/$INSTALL_FOLDER.bak" new="$1/$INSTALL_FOLDER.new"
  if [ -L "$dst" ]; then echo "blocked"; return 0; fi
  # No marker, not ours - the same test the legacy cleanup and both Illustrator
  # paths already apply. This was the one removal that did not check, so a
  # copied checkout or an unpacked backup under the reserved name was rm -rf'd.
  if [ -d "$dst" ] && [ ! -f "$dst/$VERSION_MARKER" ]; then echo "not-ours"; return 0; fi

  # .bak and .new are ours, and a run killed mid-swap leaves one or both with
  # NO $dst at all. Uninstall used to look only at $dst, find nothing, and
  # report "no installation was found" - while InDesign, which scans this
  # panel recursively, showed the user two complete copies of the toolkit.
  if [ ! -d "$dst" ]; then
    if [ -d "$bak" ] || [ -d "$new" ]; then
      if [ "$DRYRUN" = "1" ]; then echo "would-remove"; return 0; fi
      rm -rf "$bak" "$new" && echo "removed" || echo "failed"
      return 0
    fi
    echo "absent"; return 0
  fi
  if [ "$DRYRUN" = "1" ]; then echo "would-remove"; return 0; fi
  rm -rf "$dst" "$bak" "$new" && echo "removed" || echo "failed"
}

installed_version_at() {  # $1 = panel dir
  local mk="$1/$INSTALL_FOLDER/$VERSION_MARKER"
  [ -f "$mk" ] && read_version "$mk" 2>/dev/null || true
}

# --- 5. Illustrator ----------------------------------------------------------
# Illustrator reads scripts ONLY from inside its own application bundle. There
# is no user-level equivalent (official scripting guide, executingScripts.md).
# Two measured facts shape everything below.
#
# (a) The scripts folder has a DIFFERENT NAME in each language - Scripts /
#     脚本 / スクリプト / Komut Dosyaları. Matching on the name finds only the
#     English installs and silently skips every other one; an earlier draft of
#     this did exactly that, and the same bug is why an earlier note in
#     TARGETS.md recorded "ten locales" for a folder that has twenty-five.
#     It is found by CONTENT instead: inside a locale folder, the one
#     sub-folder that contains .jsx files. Measured across all 25 locales on
#     the test Mac - exactly one hit each, no exceptions - and 1/1 on Windows.
#
# (b) That folder belongs to root. What a designer can be given, with ONE
#     administrator command, is a single sub-folder of their own inside it -
#     narrower than opening the whole Scripts folder, and all this needs.
#     But it also rules out the folder-swap used for InDesign: staging a
#     sibling and renaming both need write access to the PARENT. Measured on a
#     folder granted this way: writing, overwriting and deleting files INSIDE
#     it all succeed; every operation touching the parent is refused. So
#     Illustrator is installed by replacing files in place, each atomically,
#     rather than by swapping a folder.

ai_scripts_dir_in() {  # $1 = locale dir; echoes the scripts dir, or nothing
  # Two signals, because the first one is borrowed. Holding .jsx files works
  # only as long as Adobe's three sample scripts are there - they are what
  # carries it, not anything of ours: our own install goes one level deeper,
  # into <scripts dir>/$AI_FOLDER/, so a successful install contributes
  # nothing to being found again. Remove the samples and Illustrator becomes
  # permanently invisible, including for updating and uninstalling scripts
  # that are sitting right there.
  #
  # So a folder that holds OUR folder counts as the scripts folder too. That
  # makes an existing installation detectable on its own evidence.
  local d
  for d in "$1"/*/; do
    [ -d "$d" ] || continue
    if [ -d "$d$AI_FOLDER" ]; then printf '%s' "${d%/}"; return 0; fi
  done
  for d in "$1"/*/; do
    [ -d "$d" ] || continue
    if ls "$d"*.jsx >/dev/null 2>&1; then printf '%s' "${d%/}"; return 0; fi
  done
  return 1
}

ai_settings_locales() {  # every locale Illustrator itself recorded, de-duplicated
  # Illustrator creates this folder at first launch and names it for the
  # language it runs in. That is a different question from the macOS system
  # language, which merely happens to have the same answer on many Macs.
  #
  # ALL of them, not the first one. An installation the user has switched
  # languages on, or two Illustrator versions, leaves more than one - and
  # taking the first was a silent coin-toss between them.
  local s
  for s in "$HOME/Library/Preferences/Adobe Illustrator "*" Settings"/*/; do
    [ -d "$s" ] && basename "${s%/}"
  done | sort -u
}

# Sets AI_DIRS (lines of "<scripts dir>|<label>") and AI_LOCALE_NOTE.
#
# NOT called via $(...): it has to report WHY it chose what it chose, and a
# command substitution would capture that as part of its result. Same reason
# acquire_distribution sets a global - see the note there.
AI_DIRS=""
AI_LOCALE_NOTE=""
AI_APPS_SEEN=0
# One note per Illustrator installation, not one for the run. The single
# variable used to be overwritten per application, so with two versions the
# last one wrote "(Nothing was written to Illustrator.)" over a first that had
# just been written to.
ai_note() { AI_LOCALE_NOTE="${AI_LOCALE_NOTE}${AI_LOCALE_NOTE:+$'\n'}$*"; }
find_illustrator_dirs() {
  local app root ver presets p l w sdir want picked __names
  root="${CSI_APP_ROOT:-/Applications}"
  want="$(ai_settings_locales)"
  AI_DIRS=""; AI_LOCALE_NOTE=""; AI_APPS_SEEN=0

  for app in "$root"/Adobe\ Illustrator*; do
    [ -d "$app" ] || continue
    ver="$(basename "$app" | sed 's/^Adobe Illustrator *//')"
    presets=""
    for p in "$app/Presets.localized" "$app/Presets"; do
      [ -d "$p" ] && { presets="$p"; break; }
    done
    [ -n "$presets" ] || continue
    AI_APPS_SEEN=$((AI_APPS_SEEN + 1))

    # Every recorded locale that this installation actually has a folder for.
    picked=""
    if [ -n "$want" ]; then
      while IFS= read -r w; do
        [ -n "$w" ] && [ -d "$presets/$w" ] && picked="${picked}${presets}/${w}
"
      done <<< "$want"
    fi

    # Plus every language folder that ALREADY carries one of our installs,
    # whatever the recorded locale says. Without this, the refusal below made
    # an existing install unreachable: a machine that an earlier version had
    # written into (it used to spray every locale) reported "no installation
    # was found" on uninstall while the scripts sat right there. "Ours" is the
    # version marker, the same test uninstall itself uses.
    existing=""
    for l in "$presets"/*/; do
      [ -d "$l" ] || continue
      sdir="$(ai_scripts_dir_in "${l%/}" 2>/dev/null || true)"
      [ -n "$sdir" ] && [ -f "$sdir/$AI_FOLDER/$VERSION_MARKER" ] || continue
      printf '%s\n' "$picked" | grep -qxF "${l%/}" && continue
      existing="${existing}${l%/}
"
    done
    picked="${picked}${existing}"

    if [ -z "$picked" ]; then
      # Owner decision (2026-09-07): refuse, do not spray.
      #
      # The fallback used to install into EVERY language folder - twenty-five
      # of them on the test Mac. Twenty-four of those are folders Illustrator
      # never reads, inside the application bundle, and uninstall can only
      # empty them: removing the folders needs write access to the Adobe
      # directory around them, which this installer does not have. So the
      # cost of guessing wrong is permanent litter in someone's application.
      #
      # CSI_ALL_LOCALES=1 keeps the old behaviour, for a machine where
      # Illustrator genuinely never records a locale. It is deliberately not
      # advertised outside this file: it is an escape hatch, not an option.
      if [ "${CSI_ALL_LOCALES:-}" = "1" ]; then
        for l in "$presets"/*/; do [ -d "$l" ] && picked="${picked}${l%/}
"; done
        ai_note "Illustrator ${ver}: could not tell which language it uses; CSI_ALL_LOCALES=1 is set, so every language folder is being used."
      else
        ai_note "Illustrator ${ver} has not recorded which language it runs in, so there is no way to tell which of its language folders it reads. Launch it once, then run this again. (Nothing was written to it.)"
      fi
    elif [ "$(printf '%s' "$picked" | grep -c . || true)" -gt 1 ]; then
      # More than one and no way to tell which belongs to which installation -
      # the application folder is named for a year and the settings folder for
      # a version number, so they cannot be paired without a lookup table that
      # would go stale. Use all of them and say so - built from what was
      # actually PICKED, not from what was recorded.
      __names="$(while IFS= read -r l; do [ -n "$l" ] && basename "$l"; done <<< "$picked")"
      ai_note "Illustrator ${ver} is set up for more than one language; the scripts are being installed for each of these: ${__names//$'\n'/ }"
    fi

    # Here-string, not a pipe: a pipe runs the loop in a subshell and the
    # AI_DIRS it builds would be discarded at the end of it.
    while IFS= read -r l; do
      [ -z "$l" ] && continue
      sdir="$(ai_scripts_dir_in "$l" 2>/dev/null || true)"
      [ -n "$sdir" ] && AI_DIRS="${AI_DIRS}${sdir}|Illustrator ${ver} ($(basename "$l"))
"
    done <<< "$picked"
  done
}

ai_installed_version_at() {  # $1 = scripts dir
  local mk="$1/$AI_FOLDER/$VERSION_MARKER"
  [ -f "$mk" ] && read_version "$mk" 2>/dev/null || true
}

ai_writable() {  # $1 = scripts dir -> 0 when our folder there is ours to write
  local dst="$1/$AI_FOLDER"
  # An actual write, in both branches. Permission bits on this path have been
  # wrong in both directions on the machines measured, so they are not
  # consulted. Both probes remove what they create.
  if [ -d "$dst" ]; then
    if : > "$dst/.csi_probe" 2>/dev/null; then rm -f "$dst/.csi_probe"; return 0; fi
    return 1
  fi
  # The folder is not there yet: the question is whether we could create it.
  # Asked with a throwaway name rather than by creating the real folder -
  # otherwise a --dry-run leaves a folder behind inside the application, which
  # is exactly what it promises not to do. (Measured: it did, on Windows.)
  if mkdir "$1/.csi_probe_$$" 2>/dev/null; then rmdir "$1/.csi_probe_$$"; return 0; fi
  return 1
}

ai_install_into() {  # $1 = scripts dir, $2 = payload dir, $3 = version; echoes result
  local sdir="$1" payload="$2" version="$3"
  local dst="$sdir/$AI_FOLDER" f base ok=1 cur

  if [ -L "$dst" ]; then echo "blocked"; return 0; fi
  # Asked before anything is created, and answered by a probe that cleans up
  # after itself. On a machine where somebody has already opened the Scripts
  # folder this says yes and no administrator step is needed at all - which is
  # the point of finding out before asking for one.
  ai_writable "$sdir" || { echo "needs-setup"; return 0; }

  if [ "$FORCE" != "1" ] && [ -f "$dst/$VERSION_MARKER" ]; then
    cur="$(read_version "$dst/$VERSION_MARKER" 2>/dev/null || true)"
    if [ -n "$cur" ] && [ "$cur" = "$version" ]; then echo "skip"; return 0; fi
  fi
  # Every write is below this line. A dry run must leave the application
  # exactly as it found it, including not creating the folder.
  if [ "$DRYRUN" = "1" ]; then echo "would-install"; return 0; fi
  [ -d "$dst" ] || mkdir "$dst" 2>/dev/null || { echo "needs-setup"; return 0; }

  # Stage everything, then rename everything. Staging cannot half-succeed into
  # the live set, and each rename is atomic within the folder. That is as close
  # to all-or-nothing as this permission model allows; the whole-folder swap
  # InDesign gets is not available here.
  for f in "$payload"/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    cp "$f" "$dst/$base.csi-new" 2>/dev/null || { ok=0; break; }
  done
  if [ "$ok" != "1" ]; then rm -f "$dst"/*.csi-new 2>/dev/null || true; return 1; fi
  for f in "$dst"/*.csi-new; do
    [ -f "$f" ] || continue
    mv "$f" "${f%.csi-new}" 2>/dev/null || ok=0
  done
  [ "$ok" = "1" ] || return 1

  # Drop scripts an earlier version installed and this one no longer ships -
  # otherwise a renamed script appears twice, under both names. Only .jsx is
  # touched; this folder exists for these scripts, but anything else someone
  # put here is theirs.
  for f in "$dst"/*.jsx; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    # NOT `|| return 1`. This is a cosmetic sweep of scripts an older version
    # installed under names this one no longer ships; failing it does not make
    # the install wrong, and aborting here would skip the marker write that
    # makes the install durable. The DESIGN matches Windows (do not abort);
    # the logging does not - Windows uses -ErrorAction SilentlyContinue and
    # records nothing.
    [ -f "$payload/$base" ] || rm -f "$f" || log "could not remove stale script: $f"
  done

  # Checked, for the same reason as install_into: a failed marker write would
  # otherwise reach `echo "installed"`, and the next run would find no marker,
  # report "not installed", and reinstall - every time, forever.
  printf '{"version":"%s","installedAt":"%s","source":"%s"}\n' \
    "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OWNER/$REPO@$REF" > "$dst/$VERSION_MARKER" \
    || return 1
  echo "installed"
}

ai_uninstall_from() {  # $1 = scripts dir; echoes result
  local dst="$1/$AI_FOLDER"
  if [ -L "$dst" ]; then echo "blocked"; return 0; fi
  [ -d "$dst" ] || { echo "absent"; return 0; }
  # No marker means this folder was not put here by this installer. Leave it.
  [ -f "$dst/$VERSION_MARKER" ] || { echo "not-ours"; return 0; }
  if [ "$DRYRUN" = "1" ]; then echo "would-remove"; return 0; fi

  # Order matters, and it used to be one unordered `rm -f` over both. The
  # marker is the ONLY proof this folder is ours: losing it while a script
  # survives leaves a target that reports "not-ours" for ever, with the
  # scripts still in Illustrator's menu and no way to remove them. So the
  # scripts go first, and the marker only if they all went.
  rm -f "$dst"/*.jsx 2>/dev/null || true
  # Staging and probe leftovers are ours too, and one survivor is enough to
  # keep the folder permanently non-empty - which makes every future uninstall
  # report the wrong reason for the folder still being there.
  rm -f "$dst"/*.csi-new "$dst"/.csi_probe 2>/dev/null || true

  # Checked, not assumed. Every deletion above is error-suppressed, so the
  # only honest answer comes from looking.
  if ls "$dst"/*.jsx >/dev/null 2>&1; then
    echo "failed"; return 0
  fi
  rm -f "$dst/$VERSION_MARKER" 2>/dev/null || true

  # Removing the folder itself needs write access to the Adobe folder around
  # it, which this installer does not have and does not ask for. On a machine
  # where it happens to have it, the folder goes; otherwise an empty folder
  # stays and is reported as such rather than left to be discovered.
  if rmdir "$dst" 2>/dev/null; then echo "removed"; else echo "emptied"; fi
}

ai_try_grant() {  # $1 = scripts dir ; 0 when the folder ends up ours to write
  local sdir="$1" dst="$1/$AI_FOLDER" me ans
  me="$(id -un)"

  # If sudo will not ask for anything - credentials already cached in this
  # terminal, or a NOPASSWD rule - then do it and say nothing.
  #
  # The explanation below exists to justify a password prompt. With no prompt
  # coming, it is five lines standing between the person and their result, about
  # a cost they are not being asked to pay. (It still reaches the diagnostic log,
  # so "what did it do" remains answerable.)
  # A folder that exists but that we cannot write into is somebody else's -
  # another account's grant on a shared Mac. Taking it over, silently or with
  # this person's password, would hand one user's folder to another and put the
  # first one back at "not set up yet". Refuse here; the command printed at the
  # end still lets a person do it deliberately.
  if [ -d "$dst" ]; then
    log "$dst exists but is not writable by $me; not re-owning it"
    return 1
  fi

  if sudo -n true 2>/dev/null; then
    if sudo -n sh -c 'mkdir -p "$1" && chown "$2" "$1"' _ "$dst" "$me" 2>/dev/null \
       && ai_writable "$sdir"; then
      log "granted without prompting (sudo already authorised): $dst"
      return 0
    fi
    # Deliberately does NOT fall through to asking: sudo worked, so a password
    # is not what was missing, and a prompt would only be a second way to fail.
    log "sudo was authorised but the folder could not be created: $dst"
    return 1
  fi

  # Nobody to ask -> do not try. An unattended run must not stop at a password
  # prompt nobody will ever see.
  has_tty || return 1

  # 说人话, 不贴命令。用户在这里需要知道的是三件事: 为什么要密码、它会改什么、
  # 是不是每次都要 —— 两行 sudo 命令回答不了其中任何一个, 只会让人把它当噪音跳过。
  #
  # 精确命令没有消失, 它在【拒绝之后】打印 —— 那正是想先看清楚再决定的人会走到
  # 的地方。这样两种人都被照顾到, 而不必让所有人先读一遍 shell。
  say ""
  say "  ${2:-Illustrator} keeps its scripts inside the application itself, so"
  say "  installing them there needs your permission - once."
  say ""
  say "  It creates one folder inside Illustrator for these scripts. Nothing"
  say "  else on your Mac is changed, and you will not be asked again."
  say ""
  ans="$(ask '  Continue? [y/n]: ')" || return 1
  # Only an affirmative proceeds. There was no `*)` arm, so `q`, `?`, a stray
  # keystroke - anything that was not one of the decline words - fell through
  # to the password prompt. At a permission question the unrecognised answer
  # has to mean no.
  case "$ans" in
    ""|y|Y|yes|YES|Yes) ;;
    n|N|no|NO|No) say "  Skipped - the command to do it yourself is below."; return 1 ;;
    *) say "  Not a yes - skipping. The command to do it yourself is below."; return 1 ;;
  esac

  # sudo reads its password from the TERMINAL, not from stdin - which is the
  # whole reason this can work under `curl | bash`, where stdin is the script
  # itself. </dev/tty is belt and braces for the same reason `ask` needs it.
  #
  # One sudo, one command, spelled out above before it runs. The installer is
  # still not run as an administrator: only this mkdir+chown is.
  if ! sudo -p "  Enter your Mac password to install (it is not saved): " sh -c \
       'mkdir -p "$1" && chown "$2" "$1"' _ "$dst" "$me" </dev/tty; then
    say ""
    say "  That did not go through - nothing was changed."
    return 1
  fi

  # Do not take the exit code as the answer. Check the thing actually needed:
  # a folder we can write into. (A command can succeed and still not leave the
  # state its caller assumed.)
  if ai_writable "$sdir"; then
    # Nothing to announce. The install line that follows is the proof it worked,
    # and a separate "done" above it only pushes that line further from the top.
    return 0
  fi
  say "  The command reported success, but the folder still is not writable."
  return 1
}

ai_try_revoke() {  # $1 = scripts dir ; removes the folder AND the grant with it
  # Owner decision (2026-09-07): uninstall gives the permission back.
  #
  # There is no separate "revoke" to run: the grant WAS ownership of this one
  # folder, so removing the folder removes it. That needs the parent's write
  # permission, which is exactly what we do not have - hence one elevation, at
  # the moment the person asked for the thing to be gone.
  local sdir="$1" dst="$1/$AI_FOLDER"
  [ -d "$dst" ] || return 0
  [ -L "$dst" ] && return 1
  # "emptied" is also returned when the folder is NOT empty - it still holds
  # files somebody else put there, which uninstall deliberately leaves alone.
  # rm -rf here would delete exactly those. So: only an empty folder is offered.
  if [ -n "$(ls -A "$dst" 2>/dev/null)" ]; then
    say ""
    say "  The ${AI_FOLDER} folder inside Illustrator still holds files this installer"
    say "  did not put there, so it is left in place - and so is its permission."
    return 1
  fi
  say ""
  say "  The ${AI_FOLDER} folder inside Illustrator is still there, and so is the"
  say "  permission that was granted to create it."
  say ""
  ans="$(ask '  Remove both? That needs your password once. [y/n]: ')" || return 1
  case "$ans" in
    ""|y|Y|yes|YES|Yes) ;;
    *) say "  Left in place."; return 1 ;;
  esac
  if sudo -p "  Enter your Mac password to finish removing it: " rm -rf "$dst" </dev/tty; then
    [ -d "$dst" ] && { say "  It is still there - nothing else was changed."; return 1; }
    say "  Removed."
    return 0
  fi
  say "  That did not go through - the folder is still there."
  return 1
}

print_illustrator_setup() {  # $1 = scripts dir
  say ""
  say "  Illustrator keeps its Scripts folder inside the application itself, so it"
  say "  needs one administrator command - once. After it, every install and"
  say "  update runs without a password."
  say ""
  say "  Paste this into Terminal, then run this installer again:"
  say ""
  say "    sudo mkdir -p \"$1/$AI_FOLDER\" && sudo chown \"\$(whoami)\" \"$1/$AI_FOLDER\""
  say ""
  say "  It gives you one folder of your own inside the application. It does not"
  say "  open the rest of it."
  say ""
  say "  An Illustrator upgrade replaces the application and takes that folder"
  say "  with it. Run the same command again afterwards."
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
  # A dry run must not delete anything. This became reachable under --dry-run
  # when the caller was widened to also clean up on the `skip` path: `skip`
  # returns BEFORE install_into's dry-run gate, so on an already-current
  # machine the run came straight here and removed the folder, then printed
  # "Nothing was written." The damage lands only on designers - on a
  # development machine the legacy name is the bridge, which the link check
  # below correctly refuses.
  [ "$DRYRUN" = "1" ] && return 0
  local old="$1/$LEGACY_FOLDER"
  [ -e "$old" ] || return 0
  [ -L "$old" ] && return 0                        # a bridge - not ours
  [ -f "$old/$VERSION_MARKER" ] || return 0         # someone else put it there
  rm -rf "$old" && say "(removed a previous installation under the old name ${LEGACY_FOLDER})"
}

# 任一探测到的面板未装 / 版本不符 → 需要更新 (return 0)。全部一致 → return 1。
# 用 here-string 喂 while (非 pipe) → 循环在当前 shell, return 能正确回退函数。
panels_need_update() {  # $1 = version ; covers BOTH applications
  [ "$FORCE" = "1" ] && return 0
  local p mk cur
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    mk="$p/$INSTALL_FOLDER/$VERSION_MARKER"
    [ -f "$mk" ] || return 0
    cur="$(read_version "$mk" 2>/dev/null || true)"
    [ "$cur" = "$1" ] || return 0
  done <<< "$PANELS"
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    p="${p%%|*}"
    # A target still waiting for its one-time administrator step is skipped
    # here: downloading a payload that cannot be written would be pointless.
    # It is NOT thereby forgotten - report_pending_ai_setup below prints it on
    # the same paths this function can send the run down, including the
    # "already up to date" exit.
    # An absent folder is not "nothing to do". It means that only when the
    # target ALSO cannot be written to - i.e. it is waiting for the one-time
    # administrator step, which report_pending_ai_setup prints. A target that
    # is writable and has no folder is simply NOT INSTALLED, and skipping it
    # here made the run answer "Already up to date (v…)" and exit 0 on a
    # machine with nothing installed on it at all. Live on the double-click
    # path, where no --source is passed and this preflight decides the run.
    if [ ! -d "$p/$AI_FOLDER" ]; then
      ai_writable "$p" && return 0
      continue
    fi
    mk="$p/$AI_FOLDER/$VERSION_MARKER"
    [ -f "$mk" ] || return 0
    cur="$(read_version "$mk" 2>/dev/null || true)"
    [ "$cur" = "$1" ] || return 0
  done <<< "$AI_DIRS"
  return 1
}

ai_pending_count() {  # echoes how many Illustrator targets still need the one-time step
  local t d n=0
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    d="${t%%|*}"
    [ -L "$d/$AI_FOLDER" ] && continue
    ai_writable "$d" || n=$((n + 1))
  done <<< "$AI_DIRS"
  printf '%s' "$n"
}

report_pending_ai_setup() {  # prints the one-time command for each blocked target
  local t d
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    d="${t%%|*}"
    [ -L "$d/$AI_FOLDER" ] && continue
    ai_writable "$d" && continue
    say ""
    say "${t#*|} is not set up yet."
    print_illustrator_setup "$d"
  done <<< "$AI_DIRS"
  return 0
}

# ============================ 主流程 ==========================================
say ""
status "Checking for updates..."

PANELS="$(find_panels)"
# Sets AI_DIRS and AI_LOCALE_NOTE. Not "$(...)" - see the note on the function.
find_illustrator_dirs 2>/dev/null || true
# Only give up when NEITHER application is here. Exiting on "no InDesign" would
# have made an Illustrator-only machine look like a machine with nothing on it.
# Said out loud, because this is the case where the guess can be wrong: a
# silent wrong guess installs into a language folder Illustrator does not read,
# and the person sees "installed" followed by an empty menu with nothing to
# explain it.
while IFS= read -r __l; do [ -n "$__l" ] && say "  $__l"; done <<< "$AI_LOCALE_NOTE"

# Said whenever it happens, not only when NOTHING was found. With InDesign
# present the run used to carry on to a cheerful summary while Illustrator had
# silently dropped out of every counter - no line, no reason, nothing to search
# for. The exit-3 branch below only covers the case where both are missing.
# Only when there is no more specific reason already printed. The locale note
# above explains a different cause, and two explanations for one absence read
# as two problems.
if [ "$AI_APPS_SEEN" -gt 0 ] && [ -z "$AI_DIRS" ] && [ -n "$PANELS" ] && [ -z "$AI_LOCALE_NOTE" ]; then
  say "  Found Illustrator, but could not identify its Scripts folder - skipping it."
fi

if [ -z "$PANELS" ] && [ -z "$AI_DIRS" ]; then
  # The note above already said why nothing can be done yet. That is not a
  # malfunction and must not be reported as one - the "report this" text and
  # exit 3 below used to run right after a note that had explained everything.
  if [ "$AI_APPS_SEEN" -gt 0 ] && [ -n "$AI_LOCALE_NOTE" ]; then exit 0; fi
  # Two different states, and they used to share one sentence. "Illustrator is
  # here but I could not identify its Scripts folder" is not "Illustrator is
  # not installed", and telling someone to install an application they already
  # have is the one answer that cannot lead anywhere.
  if [ "$AI_APPS_SEEN" -gt 0 ]; then
    fail "Found Illustrator, but could not identify its Scripts folder inside it."
    fail "That folder is recognised by the scripts already in it; if it is empty,"
    fail "there is nothing to go on. Report this with --log and the Illustrator version."
    exit 3
  fi
  warn "No InDesign or Illustrator installation found. Install and launch one of them, then run this again."
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
  # A --source can be a DIRECTORY or a .zip - acquire_distribution accepts both
  # and the header advertises both. `find <regular file> -name …` matches
  # nothing, so the zip case used to leave RVER empty: every installation then
  # looked current and the menu could never offer Update. Reading the manifest
  # out of the zip is the fix; falling back to the REMOTE version would be
  # worse than nothing, because the run installs the zip and would be comparing
  # against something else entirely.
  if [ -d "$SOURCE" ]; then
    LM="$(find "$SOURCE" -maxdepth 5 -name "$MANIFEST_NAME" -type f 2>/dev/null | head -n1)"
    [ -n "$LM" ] && RVER="$(read_version "$LM" 2>/dev/null || true)"
  else
    RVER="$({ unzip -p "$SOURCE" "*$MANIFEST_NAME" 2>/dev/null | grep -m1 '"version"' || true; } | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  fi
else
  MURL0="${TOOLKIT_MANIFEST_URL:-https://raw.githubusercontent.com/$OWNER/$REPO/$REF/$MANIFEST_NAME}"
  pa0=(); [ -n "${TOOLKIT_AUTH_TOKEN:-}" ] && pa0=(-H "Authorization: token $TOOLKIT_AUTH_TOKEN")
  RM0="$(curl -fsSL --connect-timeout 10 --max-time 20 ${pa0[@]+"${pa0[@]}"} "$MURL0" 2>/dev/null || true)"
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
      say "  ${MARK_NONE}${label}: a link is in the way (development bridge) - rename or remove it and run again"
    elif [ -n "$lv" ]; then
      INSTALLED_ANY=1
      if [ -n "$RVER" ] && [ "$lv" != "$RVER" ]; then
        ALL_CURRENT=0; say_update "  ${MARK_UPDATE}${label}: installed v${lv} -> v${RVER}"
      else
        say "  ${MARK_NONE}${label}: installed v${lv}"
      fi
    else
      ALL_CURRENT=0; say "  ${MARK_NONE}${label}: not installed"
    fi
  done <<< "$PANELS"
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    label="${p#*|}"; p="${p%%|*}"
    lv="$(ai_installed_version_at "$p")"
    if [ -L "$p/$AI_FOLDER" ]; then
      say "  ${MARK_NONE}${label}: a link is in the way (development bridge) - rename or remove it and run again"
    elif ! ai_writable "$p"; then
      # Not an error, and not counted as "installed" or as "needs updating".
      # Deliberately does NOT promise what happens next: the run may offer to
      # do it, or print the command - saying "shown below" would be false in
      # the first case, and the status line is written before either is known.
      say "  ${MARK_NONE}${label}: not set up yet"
    elif [ -n "$lv" ]; then
      INSTALLED_ANY=1
      if [ -n "$RVER" ] && [ "$lv" != "$RVER" ]; then
        ALL_CURRENT=0; say_update "  ${MARK_UPDATE}${label}: installed v${lv} -> v${RVER}"
      else
        say "  ${MARK_NONE}${label}: installed v${lv}"
      fi
    else
      ALL_CURRENT=0; say "  ${MARK_NONE}${label}: not installed"
    fi
  done <<< "$AI_DIRS"

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
      # __NOTTY__ here means `read` hit EOF - has_tty already passed, so this is
      # Ctrl-D, the standard way to leave a prompt. It used to mean install.
      __NOTTY__)      say ""; say "Nothing was changed."; exit 0 ;;
      ""|1)           ACTION="install" ;;
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
      __NOTTY__)      say ""; say "Nothing was changed."; exit 0 ;;   # Ctrl-D
      ""|1)           ACTION="install" ;;
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
      __NOTTY__)  say ""; say "Nothing was changed."; exit 0 ;;   # Ctrl-D: the other two menus already do this
      1)          ACTION="repair"; FORCE=1 ;;
      2)          ACTION="uninstall" ;;
      ""|q|Q)     say ""; say "Nothing was changed."; exit 0 ;;
      *)          say ""; say "Not one of the choices: ${CHOICE}"; exit 2 ;;
    esac
  fi
  say ""
fi

if [ "$ACTION" = "uninstall" ]; then
  REMOVED=0; BLOCKED_U=0; ABSENT=0; UFAILED=0; NOT_OURS_ID=0
  REMOVED_ID=0; REMOVED_AI=0   # per application, so the summary can name them
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$(uninstall_from "$p")" in
      removed)      REMOVED=$((REMOVED+1)); REMOVED_ID=$((REMOVED_ID+1)) ;;
      would-remove) REMOVED=$((REMOVED+1)); REMOVED_ID=$((REMOVED_ID+1)) ;;
      blocked)      BLOCKED_U=$((BLOCKED_U+1)) ;;
      absent)       ABSENT=$((ABSENT+1)) ;;
      not-ours)     NOT_OURS_ID=$((NOT_OURS_ID+1)) ;;
      *)            UFAILED=$((UFAILED+1)) ;;
    esac
  done <<< "$PANELS"
  EMPTIED=0; EMPTIED_DIRS=""
  NOT_OURS=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$(ai_uninstall_from "${p%%|*}")" in
      removed)      REMOVED=$((REMOVED+1)); REMOVED_AI=$((REMOVED_AI+1)) ;;
      would-remove) REMOVED=$((REMOVED+1)); REMOVED_AI=$((REMOVED_AI+1)) ;;
      emptied)      REMOVED=$((REMOVED+1)); REMOVED_AI=$((REMOVED_AI+1)); EMPTIED=$((EMPTIED+1)); EMPTIED_DIRS="${EMPTIED_DIRS}${p%%|*}
" ;;
      blocked)      BLOCKED_U=$((BLOCKED_U+1)) ;;
      absent)       ABSENT=$((ABSENT+1)) ;;
      not-ours)     NOT_OURS=$((NOT_OURS+1)) ;;
      *)            UFAILED=$((UFAILED+1)) ;;
    esac
  done <<< "$AI_DIRS"
  say ""
  # Say that the folder is still there. It is empty and inert, but a person who
  # is told "removed" and then finds it will reasonably think the uninstall
  # failed - and the reason it stays is not something they can guess.
  # Two different states used to share one sentence, and it asserted both an
  # emptiness and a cause that the code never established: `emptied` is also
  # returned when the folder is NOT empty (somebody else's files are in it, the
  # ones the uninstall deliberately leaves alone). Say what is actually known.
  if [ "$EMPTIED" -gt 0 ]; then
    say "The scripts were removed from ${EMPTIED} Illustrator location(s)."
    # Offered here, in the main flow: ai_uninstall_from is called as "$(...)",
    # so anything it printed would be captured as its return value instead of
    # reaching the person.
    # Only the targets THIS run emptied - not every Illustrator target. The loop
    # used to walk all of them, so a folder the uninstall had just refused as
    # "not ours" (no marker) or "blocked" (a link) was offered to sudo rm -rf one
    # line after the refusal was printed.
    REVOKED=0
    while IFS= read -r d; do
      [ -z "$d" ] && continue
      ai_try_revoke "$d" && REVOKED=$((REVOKED+1)) || true
    done <<< "$EMPTIED_DIRS"
    [ "$REVOKED" -eq 0 ] && say "The ${AI_FOLDER} folder itself was left behind - either it still holds something that is not ours, or removing it needs an administrator."
  fi
  # The one state the tool refused to act in was the one it never mentioned.
  [ "$NOT_OURS" -gt 0 ] && say "Left alone: ${NOT_OURS} ${AI_FOLDER} folder(s) with no version marker - this installer did not create them, so it will not remove them."
  [ "$NOT_OURS_ID" -gt 0 ] && say "Left alone: ${NOT_OURS_ID} ${INSTALL_FOLDER} folder(s) with no version marker - this installer did not create them, so it will not remove them."
  [ "$BLOCKED_U" -gt 0 ] && say "Skipped ${BLOCKED_U} location(s): ${INSTALL_FOLDER} there is a link, not a folder."
  if [ "$DRYRUN" = "1" ]; then
    say "[dry run] Would remove ${REMOVED} installation(s). Nothing was written."
  elif [ "$UFAILED" -gt 0 ]; then
    fail "Removed ${REMOVED}, failed ${UFAILED} - the application may have the files open. Close it and try again."
    exit 1
  elif [ "$REMOVED" -gt 0 ]; then
    UAPPS=""
    [ "$REMOVED_ID" -gt 0 ] && UAPPS="InDesign"
    [ "$REMOVED_AI" -gt 0 ] && UAPPS="${UAPPS:+$UAPPS and }Illustrator"
    ok "Removed ${REMOVED} installation(s). Restart ${UAPPS:-the application} for the menu to catch up."
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
  RMANI="$(curl -fsSL --connect-timeout 10 --max-time 20 ${pauth[@]+"${pauth[@]}"} "$MURL" 2>/dev/null || true)"
  if [ -n "$RMANI" ]; then
    RVER="$(printf '%s' "$RMANI" | { grep -m1 '"version"' || true; } | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
    if [ -n "$RVER" ] && ! panels_need_update "$RVER"; then
      say ""
      # This exit happens before anything is downloaded, so it is also the exit
      # that would silently swallow an Illustrator target still waiting for its
      # one-time setup - and a bare "up to date" would be a claim covering a
      # target that is not installed at all.
      AI_PENDING="$(ai_pending_count)"
      if [ "$AI_PENDING" -gt 0 ]; then
        ok "Up to date (v${RVER}) everywhere it could be installed - but ${AI_PENDING} Illustrator location(s) still need the one-time step below."
        report_pending_ai_setup
      elif [ -n "$AI_LOCALE_NOTE" ] && [ -z "$AI_DIRS" ]; then
        ok "Up to date (v${RVER}) for InDesign. Illustrator was skipped, see above."
      else
        ok "Already up to date (v${RVER})."
      fi
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

# The Illustrator payload is verified with its own sidecar against its own
# folder. Sharing the InDesign check would have meant one green tick standing
# for two different sets of bytes, only one of which was actually hashed.
AI_PAYLOAD="$ROOT/$AI_PAYLOAD_SUBDIR"
AI_OK=0
# Carried into AI_FAILED once the counters exist, a few lines below. Without
# it, a payload that failed its checksum incremented nothing, the summary fell
# through to the green "Already up to date" branch, and the run exited 0 - with
# the error line scrolled above a headline that contradicted it.
AI_VERIFY_BAD=0
if [ -n "$AI_DIRS" ]; then
  if [ ! -d "$AI_PAYLOAD" ] || [ ! -f "$ROOT/$AI_SHA_SIDECAR" ]; then
    # An older distribution has no Illustrator half. Say so and carry on with
    # InDesign rather than failing a run that can still do most of its job.
    say "  (this package has no Illustrator scripts; skipping Illustrator)"
  elif ( cd "$AI_PAYLOAD" && shasum -a 256 -c "$ROOT/$AI_SHA_SIDECAR" >/dev/null 2>&1 ); then
    AI_OK=1
  else
    fail "The Illustrator files failed verification; nothing was written to Illustrator."
    AI_VERIFY_BAD=1
  fi
fi

# Offer the one administrator step here, in the main flow, BEFORE the install
# loop. It cannot live inside ai_install_into: that is called as "$(...)", so
# everything it prints is captured as its return value - a prompt in there would
# be invisible and an answer would be read into the wrong place.
#
# Asked once, up front, only when there is a verified payload to install, and
# only when there is a terminal to ask at. Declining is not a failure: the run
# continues and the command is printed at the end as before.
if [ "$AI_OK" = "1" ] && [ "$DRYRUN" != "1" ] && [ "$ACTION" != "uninstall" ]; then
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    d="${t%%|*}"
    [ -L "$d/$AI_FOLDER" ] && continue
    ai_writable "$d" && continue
    ai_try_grant "$d" "${t#*|}" || true
  done <<< "$AI_DIRS"
fi

INSTALLED=0; SKIPPED=0; WOULD=0; FAILED=0; BLOCKED=0; BLOCKED_PANELS=""
FAILED_WHERE=""
# AI_VERIFY_BAD is deliberately NOT folded into AI_FAILED. It used to be, and
# the summary then told the user "the application may have the files open,
# close it and run again" for what is actually a bad download - a remedy that
# cannot work, attached to a count of locations when no location failed.
AI_INSTALLED=0; AI_SKIPPED=0; AI_WOULD=0; AI_FAILED=0; AI_SETUP=0
FINAL_RC=0
while IFS= read -r panel; do
  [ -z "$panel" ] && continue
  # 用 if 测 install_into 返回码: 单面板换入失败 (InDesign 占用文件) 不因 set -e
  # 中止整个脚本、也不误报"全部未改"。失败面板已在 install_into 里回滚到旧版。
  if r="$(install_into "$panel" "$PAYLOAD" "$VERSION")"; then
    case "$r" in
      installed)     INSTALLED=$((INSTALLED+1)); migrate_legacy_folder "$panel" || true ;;
      # Also on skip. The cleanup used to hang off "installed" only, so a
      # machine already on the current version never ran it - and a legacy
      # folder restored from a backup, or from the Syncthing shares that
      # TARGETS.md records pointing straight into the Adobe directories, would
      # sit in the panel for ever. Nothing else on the machine removes it.
      skip)          SKIPPED=$((SKIPPED+1)); migrate_legacy_folder "$panel" || true ;;
      would-install) WOULD=$((WOULD+1)) ;;
      blocked)       BLOCKED=$((BLOCKED+1)); BLOCKED_PANELS="${BLOCKED_PANELS}${panel}/${INSTALL_FOLDER}
" ;;
    esac
  else
    FAILED=$((FAILED+1))
    # Name it. "Update failed in 1 location(s)" told a designer with two
    # InDesign versions nothing about which one, and "close the application"
    # named no application.
    FAILED_WHERE="${FAILED_WHERE}  ${panel}
"
  fi
done <<< "$PANELS"

if [ "$AI_OK" = "1" ]; then
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    if r="$(ai_install_into "${t%%|*}" "$AI_PAYLOAD" "$VERSION")"; then
      case "$r" in
        installed)     AI_INSTALLED=$((AI_INSTALLED+1)) ;;
        skip)          AI_SKIPPED=$((AI_SKIPPED+1)) ;;
        would-install) AI_WOULD=$((AI_WOULD+1)) ;;
        needs-setup)   AI_SETUP=$((AI_SETUP+1)) ;;
        blocked)       BLOCKED=$((BLOCKED+1)); BLOCKED_PANELS="${BLOCKED_PANELS}${t%%|*}/${AI_FOLDER}
" ;;
      esac
    else
      AI_FAILED=$((AI_FAILED+1))
    fi
  done <<< "$AI_DIRS"
fi

say ""
if [ "$BLOCKED" -gt 0 ]; then
  # The folder name is per entry now. It used to be printed as $INSTALL_FOLDER
  # for every entry, so a blocked Illustrator target was reported at a path
  # that does not exist - and "rename or remove that link" was the only
  # instruction in the whole block, pointed at nothing.
  warn "Skipped ${BLOCKED} location(s): the toolkit folder there is a link, not a folder."
  say "Nothing was written there, so a link to a working copy cannot be destroyed."
  say ""
  printf '%s' "$BLOCKED_PANELS" | while IFS= read -r bp; do
    [ -n "$bp" ] && say "  ${bp}"
  done
  say ""
  say "Rename or remove that link and run again."
  say ""
fi
# Totals across both applications. Reporting only the InDesign numbers here
# would have made an Illustrator-only install print "already up to date"
# immediately after writing five files.
TOT_INSTALLED=$((INSTALLED + AI_INSTALLED))
TOT_FAILED=$((FAILED + AI_FAILED))
TOT_SKIPPED=$((SKIPPED + AI_SKIPPED))
TOT_WOULD=$((WOULD + AI_WOULD))

if [ "$DRYRUN" = "1" ]; then
  # Report both numbers. "Would install into 0 locations" on its own reads as a
  # failure to find anything, when the actual reason is that every location is
  # already current - two very different things behind the same sentence.
  if [ "$TOT_WOULD" -eq 0 ] && [ "$TOT_SKIPPED" -gt 0 ]; then
    ok "[dry run] Nothing to do: ${TOT_SKIPPED} location(s) already have v${VERSION}."
  else
    ok "[dry run] Would install into ${TOT_WOULD} location(s) (v${VERSION}); ${TOT_SKIPPED} already current. Nothing was written."
  fi
elif [ "$TOT_FAILED" -gt 0 ] && [ "$TOT_INSTALLED" -gt 0 ]; then
  # FINAL_RC, not `exit 1`. The pending-Illustrator-setup report is the last
  # statement of the file, and these branches used to jump over it - so the
  # runs where the user most needs to know what is still outstanding were
  # exactly the runs that did not tell them. The comment on panels_need_update
  # claims the report fires "on the same paths this function can send the run
  # down"; on macOS that was only true of the paths that did not fail.
  warn "Updated to v${VERSION} in some locations, but ${TOT_FAILED} failed - the application may have the files open. Close it and run again."
  [ -n "$FAILED_WHERE" ] && printf '%s' "$FAILED_WHERE"
  FINAL_RC=1
elif [ "$TOT_FAILED" -gt 0 ]; then
  fail "Update failed in ${TOT_FAILED} location(s); nothing was updated. Your existing scripts are unchanged. Close the application and run again, or ask IT."
  [ -n "$FAILED_WHERE" ] && printf '%s' "$FAILED_WHERE"
  FINAL_RC=1
elif [ "$TOT_INSTALLED" -gt 0 ]; then
  # One sentence. The applications are still named - "restart the application"
  # is no use to someone with both open when only one changed - but naming them
  # takes a clause, not a line each. Where each script appears is in the docs;
  # at this point the person needs to know it worked and what to do next.
  APPS=""
  [ "$INSTALLED" -gt 0 ] && APPS="InDesign"
  [ "$AI_INSTALLED" -gt 0 ] && APPS="${APPS:+$APPS and }Illustrator"
  ok "Installed v${VERSION} - restart ${APPS} to see the scripts."
  [ -n "$AI_LOCALE_NOTE" ] && [ -z "$AI_DIRS" ] && say "(Illustrator was skipped, see above)"
  if [ "$AI_VERIFY_BAD" = "1" ]; then
    warn "(the Illustrator scripts failed verification and were not installed - that is a bad download; run this again)"
    FINAL_RC=1
  fi
  # Derived from OWNER/REPO rather than written out: a hard-coded URL here would
  # be a second place the repository name lives, and the one that never gets
  # updated when it changes. Only on the path where something was installed -
  # someone re-running an up-to-date machine is not at a "what next" moment.
  # 说明怎么打开它。终端里的链接不是网页里的链接: 一个在这里从没点开过的人
  # 会以为它只是一段文字。开法各平台不同, 所以各说各的 —— 这一句只在 macOS
  # 版里, Windows 版说 Ctrl+click。
  say "What to do next - select the link, then right-click and choose Open:"
  say "  https://${OWNER}.github.io/${REPO}/guide/workflow"
  [ "$TOT_SKIPPED" -gt 0 ] && say "(${TOT_SKIPPED} location(s) were already up to date)"
  [ "$BLOCKED" -gt 0 ] && say "(${BLOCKED} location(s) were skipped, see above)"
elif [ "$BLOCKED" -gt 0 ]; then
  # 说发生了什么, 不说打算发生什么。这里原先落进下面那个 else, 于是在一个字都
  # 没写入的情况下打印"已是最新版本" —— 用户会据此认为脚本已经装好了。
  warn "Nothing was installed: all ${BLOCKED} location(s) were skipped, see above."
  FINAL_RC=1
elif [ "$AI_VERIFY_BAD" = "1" ]; then
  fail "Nothing was installed: the Illustrator scripts failed verification."
  say "That is a bad download, not a problem with this machine - run this again."
  FINAL_RC=1
elif [ "$AI_SETUP" -gt 0 ] && [ "$TOT_SKIPPED" -eq 0 ]; then
  # Nothing was written and nothing was already current - so "up to date" would
  # be false. The one thing standing in the way is printed just below.
  warn "Nothing was installed yet."
elif [ "$AI_SETUP" -gt 0 ]; then
  # A bare "Already up to date" here would be a claim about every target, while
  # one of them was not written to and could not be. Saying it and then
  # printing "is not set up yet" three lines later reads as a contradiction -
  # and the headline is the part people keep.
  ok "Up to date (v${VERSION}) everywhere it could be installed - but ${AI_SETUP} Illustrator location(s) still need the one-time step below."
elif [ -n "$AI_LOCALE_NOTE" ] && [ -z "$AI_DIRS" ]; then
  # The note above explains why Illustrator was skipped, but a bare "Already up
  # to date" is a claim about everything - and the headline is the part people
  # keep. Same shape as the AI_SETUP branch further up.
  ok "Up to date (v${VERSION}) for InDesign. Illustrator was skipped, see above."
else
  ok "Already up to date (v${VERSION})."
fi

# Last, whatever else happened: on this run it is the only thing left for a
# person to act on, so it should not be scrolled off by a summary above it.
[ "$AI_SETUP" -gt 0 ] && report_pending_ai_setup

# 显式退出: 否则 set -e 下末条命令 (上面 && 短路的 [ -gt 0 ]) 会让脚本以 1
# 退出, 即便安装成功 —— 运行时自测 SH1/SH3 捕获。FINAL_RC 让"装了 InDesign 但
# Illustrator 校验失败"这种半成功也能被包装脚本看见。
exit "$FINAL_RC"
