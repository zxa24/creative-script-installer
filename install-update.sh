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
set -euo pipefail

# ===== 可配置源 (发布时设定) =====
OWNER="zxa24"
REPO="indesign-toolkit-dist"      # 占位: E-source 发布时定名
REF="main"

INSTALL_FOLDER="indesign-toolkit"
MANIFEST_NAME="toolkit.manifest.json"
SHA_SIDECAR="toolkit.manifest.sha256"
PAYLOAD_SUBDIR="toolkit"
VERSION_MARKER=".installed_version.json"

SOURCE="${TOOLKIT_SOURCE:-}"
FORCE=0
DRYRUN=0
for a in "$@"; do
  case "$a" in
    --force)   FORCE=1 ;;
    --dry-run) DRYRUN=1 ;;
    --source=*) SOURCE="${a#--source=}" ;;
  esac
done

WORK=""
cleanup() { [ -n "$WORK" ] && [ -d "$WORK" ] && rm -rf "$WORK" || true; }
trap cleanup EXIT

say()  { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; }

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
      fail "指定的源不存在: $SOURCE"; return 1
    fi
  fi
  # (b) 远端
  local zipUrl="${TOOLKIT_ZIP_URL:-https://codeload.github.com/$OWNER/$REPO/zip/refs/heads/$REF}"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/indesign-toolkit-update.XXXXXX")"
  local auth=(); [ -n "${TOOLKIT_AUTH_TOKEN:-}" ] && auth=(-H "Authorization: token $TOOLKIT_AUTH_TOKEN")
  if ! curl -fL "${auth[@]}" -o "$WORK/dist.zip" "$zipUrl"; then return 1; fi
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
say "正在检查更新…"

PANELS="$(find_panels)"
if [ -z "$PANELS" ]; then
  say "未找到已安装的 InDesign。请先安装 / 启动一次 InDesign 后重试。"
  exit 3
fi

# 远端预检 (设计 §2.2): 只取小 manifest, 若所有面板已是该版本则直接收工, 不下整包。
# 仅远端 + 非 dry-run 生效; 本地源跳过。预检失败(离线/无 manifest)回落到完整 acquire。
if [ -z "$SOURCE" ] && [ "$DRYRUN" != "1" ]; then
  MURL="${TOOLKIT_MANIFEST_URL:-https://raw.githubusercontent.com/$OWNER/$REPO/$REF/$MANIFEST_NAME}"
  pauth=(); [ -n "${TOOLKIT_AUTH_TOKEN:-}" ] && pauth=(-H "Authorization: token $TOOLKIT_AUTH_TOKEN")
  RMANI="$(curl -fsSL "${pauth[@]}" "$MURL" 2>/dev/null || true)"
  if [ -n "$RMANI" ]; then
    RVER="$(printf '%s' "$RMANI" | { grep -m1 '"version"' || true; } | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
    if [ -n "$RVER" ] && ! panels_need_update "$RVER"; then
      say ""
      say "已是最新版本 (v${RVER})。"
      exit 0
    fi
  fi
fi

acquire_distribution || true
ROOT="$DIST_ROOT"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/$MANIFEST_NAME" ]; then
  fail "网络或来源出错, 未做任何改动。请重试或联系 IT。"
  exit 1
fi
# 绝对化 ROOT: 相对的 --source 目录会让下面 (cd "$PAYLOAD" && shasum -c "$ROOT/侧车")
# 里的相对 $ROOT 在 cd 后解析错 → 误报校验失败、拒装一个好包。
ROOT="$(cd "$ROOT" && pwd)"

VERSION="$(read_version "$ROOT/$MANIFEST_NAME")"
PAYLOAD="$ROOT/$PAYLOAD_SUBDIR"
[ -d "$PAYLOAD" ] || { fail "分发包缺 payload 目录 '$PAYLOAD_SUBDIR'"; exit 4; }

# 完整性校验 (fail-closed, 与 Windows 无条件校验对齐): 侧车必须存在且通过。
# 缺侧车 = 分发包异常/被剥离 → 拒装, 不静默跳过 (缺校验时校验正是唯一防线)。
# shasum -c CWD=payload → 侧车里的路径为 payload 相对。
if [ ! -f "$ROOT/$SHA_SIDECAR" ]; then
  fail "下载的包缺校验清单, 未做任何改动。请重试或联系 IT。"
  exit 4
fi
if ! ( cd "$PAYLOAD" && shasum -a 256 -c "$ROOT/$SHA_SIDECAR" >/dev/null 2>&1 ); then
  fail "下载的文件校验失败, 未做任何改动。请重试或联系 IT。"
  exit 4
fi

INSTALLED=0; SKIPPED=0; WOULD=0; FAILED=0
while IFS= read -r panel; do
  [ -z "$panel" ] && continue
  # 用 if 测 install_into 返回码: 单面板换入失败 (InDesign 占用文件) 不因 set -e
  # 中止整个脚本、也不误报"全部未改"。失败面板已在 install_into 里回滚到旧版。
  if r="$(install_into "$panel" "$PAYLOAD" "$VERSION")"; then
    case "$r" in
      installed)     INSTALLED=$((INSTALLED+1)) ;;
      skip)          SKIPPED=$((SKIPPED+1)) ;;
      would-install) WOULD=$((WOULD+1)) ;;
    esac
  else
    FAILED=$((FAILED+1))
  fi
done <<< "$PANELS"

say ""
if [ "$DRYRUN" = "1" ]; then
  say "[试运行] 将安装到 ${WOULD} 个位置 (v${VERSION})。未写入任何文件。"
elif [ "$FAILED" -gt 0 ] && [ "$INSTALLED" -gt 0 ]; then
  say "部分位置已更新到 v${VERSION}, 但有 ${FAILED} 处失败 (可能 InDesign 正占用文件)。请关闭 InDesign 后重试。"
  exit 1
elif [ "$FAILED" -gt 0 ]; then
  say "更新失败 (${FAILED} 处), 未成功更新任何位置。已有的脚本未被改动。请关闭 InDesign 后重试或联系 IT。"
  exit 1
elif [ "$INSTALLED" -gt 0 ]; then
  say "已更新到 v${VERSION} — 重启 InDesign 后在「脚本」面板可见。"
  [ "$SKIPPED" -gt 0 ] && say "(其中 ${SKIPPED} 个位置本已是最新)"
else
  say "已是最新版本 (v${VERSION})。"
fi

# 显式成功退出: 否则 set -e 下末条命令 (上面 && 短路的 [ -gt 0 ]) 会让脚本
# 以 1 退出, 即便安装成功 —— 运行时自测 SH1/SH3 捕获。
exit 0
