#!/usr/bin/env bash
# tools/check-color-output.sh
#
# 验 install-update.sh 的四个输出出口(say / ok / warn / fail)在【真渲染】时的行为。
#
# ── 它答什么 ────────────────────────────────────────────────────────
# ✅ 非 tty(重定向到文件/管道)时 **一个转义字符都不发** —— 这是硬判据：
#    日志与被 grep 的输出里混进控制字符, 会让 grep / diff / 人眼全部失准。
# ✅ 真 tty 时 ok/warn/fail 各自发【对应那一个】颜色码, 而 say 不发。
# ✅ 写进日志的是纯文本(不含转义序列)。
# ✅ fail 的守卫看的是 fd 2 —— `cmd | cat` 之下 stdout 已非 tty 而 stderr 仍是,
#    那时 fail 【应该】还上色。这一格正是为了钉住"守卫看错了流"这个错。
#
# ── ⛔ 它答不了 ─────────────────────────────────────────────────────
# · 哪一句该用哪个出口(那是 tools/check-message-parity.js 的事)。
# · 颜色在 Terminal.app / iTerm 里长什么样。
# · mac 上的行为 —— 本机是 Windows + Git Bash。⚠ printf 与 [ -t N ] 都是
#   POSIX 的, 但这一条【没有在 mac 上实测过】, 别把它当已验。
#
# 用法: bash tools/check-color-output.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SH="$ROOT/install-update.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 🔴 只取输出出口那一段, 别 source 整个脚本(它会跑起来去装东西)。
# 按【标记】切, 不按行号 —— 行号会随任何一次编辑漂掉。
awk '/^LOGFILE=""$/{on=1} on{print} on && /^fail\(\) \{/{inf=1} inf && /^\}$/{exit}' "$SH" > "$TMP/helpers.sh"
if ! grep -q '^ok()' "$TMP/helpers.sh" || ! grep -q '^warn()' "$TMP/helpers.sh" \
   || ! grep -q '^fail() {' "$TMP/helpers.sh" || ! grep -q '^say()' "$TMP/helpers.sh"; then
  echo "🔴 REFUSED: 没能从 install-update.sh 里切出四个出口的定义。"
  echo "   ⇒ 锚点漂了。⛔ 这算失败, 不算跳过 —— 否则后面每一格都会在一个空文件上'通过'。"
  exit 4
fi

# ── 🔴 反向控制 ────────────────────────────────────────────────────
# 一条永远绿的检查 = 没有检查。`--selftest <A|B|C|D>` 往【临时副本】里注入一个
# 已知的坏改动, 这条检查必须红。
# ⚠ 只改 $TMP/helpers.sh, ⛔ 绝不碰 install-update.sh ——
#   一次崩在中途的变异会把真文件留在坏状态, 而那正是最难发现的残留。
SELFTEST="${2:-}"
if [ "${1:-}" = "--selftest" ]; then
  # 变异用 node 做, ⛔ 不用 sed —— 这些锚点里全是 `\033`, 而 sed / shell 引号会
  # 逐层吃掉反斜杠: 第一版就是这么"变异成功却什么都没改"的(锚点检查抓住了它)。
  # node 侧用 String.fromCharCode(92) 造反斜杠, 一层转义都不经过。
  node -e '
    const fs = require("fs");
    const B = String.fromCharCode(92), E = B + "033", Q = String.fromCharCode(34);
    const [file, which] = process.argv.slice(1);
    const M = {
      A: ["if [ -t 2 ]; then printf " + "'"'"'" + E + "[31m",
          "if [ -t 1 ]; then printf " + "'"'"'" + E + "[31m"],
      B: ["say()  { status_clear; printf " + "'"'"'" + "%s" + B + "n" + "'"'"'",
          "say()  { status_clear; printf " + "'"'"'" + E + "[32m%s" + B + "n" + "'"'"'"],
      C: ["ok()   { status_clear; if [ -t 1 ]; then printf " + "'"'"'" + E + "[32m",
          "ok()   { status_clear; if [ -t 1 ]; then printf " + "'"'"'" + E + "[31m"],
      D: ["ok()   { status_clear; if [ -t 1 ]; then ",
          "ok()   { status_clear; if true; then "],
    }[which];
    if (!M) { console.error("未知的 selftest: " + which); process.exit(2); }
    const s = fs.readFileSync(file, "utf8");
    const n = s.split(M[0]).length - 1;
    if (n !== 1) { console.error("ANCHOR " + n); process.exit(4); }
    fs.writeFileSync(file, s.replace(M[0], M[1]));
  ' "$TMP/helpers.sh" "$SELFTEST"
  rc=$?
  # 🔴 锚点丢失算失败, ⛔ 不算跳过 —— 否则这条反向控制会安静地什么都没测,
  #    而"什么都没测"的输出与"检查本身失效"的输出长得一模一样。
  if [ "$rc" = "4" ]; then
    echo "🔴 SELFTEST $SELFTEST 的变异【没有落地】(锚点丢失/不唯一) ⇒ 算失败, 不算跳过。"
    exit 4
  fi
  [ "$rc" = "0" ] || exit "$rc"
  echo "### SELFTEST $SELFTEST 已注入【临时副本】(⛔ 真文件未动) —— 下面这趟必须红"
fi

cat > "$TMP/drive.sh" <<'DRIVE'
LOGGING=0
. "$HELPERS"
LOGFILE="$LOGDEST"
say  "plain line"
ok   "green line"
warn "yellow line"
fail "red line"
DRIVE

ESC=$(printf '\033')
fails=0
note() { printf '  %s\n' "$*"; }
check() { # check <描述> <期望 yes|no> <实际内容>
  local want="$2" have="$3"
  if [ "$want" = yes ]; then
    case "$have" in *"$ESC"*) note "PASS $1";; *) note "🔴 FAIL $1 —— 期望有转义序列, 实际没有"; fails=$((fails+1));; esac
  else
    case "$have" in *"$ESC"*) note "🔴 FAIL $1 —— 期望零转义序列, 实际有"; fails=$((fails+1));; *) note "PASS $1";; esac
  fi
}

echo "=== ① 非 tty: stdout 与 stderr 都重定向到文件 ==="
HELPERS="$TMP/helpers.sh" LOGDEST="$TMP/log1.txt" bash "$TMP/drive.sh" > "$TMP/out1" 2> "$TMP/err1"
check "stdout 零转义" no "$(cat "$TMP/out1")"
check "stderr 零转义" no "$(cat "$TMP/err1")"
check "日志零转义"   no "$(cat "$TMP/log1.txt" 2>/dev/null)"
note  "stdout 内容: $(tr '\n' '|' < "$TMP/out1")"
note  "stderr 内容: $(tr '\n' '|' < "$TMP/err1")"
note  "日志内容  : $(tr '\n' '|' < "$TMP/log1.txt" 2>/dev/null)"

echo
echo "=== ② tty 分支: 它【发出来的字节】对不对 ==="
# 🔴 先说清这一格测到了什么、没测到什么, 别让它冒充 ① 那种硬判据。
#   `[ -t 1 ]` 为真的情形, 在一个【没有终端的会话】里造不出来:
#   winpty 自己就要求 stdin 是 tty(实测回 "stdin is not a tty"), 而 CI / agent
#   会话都没有。node-pty 能造, 但那要引依赖 —— 本仓明确不引。
#   ⇒ 这里直接驱动分支体, 断言它发的是哪几个码; **条件本身没有被触发。**
tty_render() { # <颜色码> <文本>
  printf "\033[${1}m%s\033[0m\n" "$2"
}
for pair in "32:green line" "33:yellow line" "31:red line"; do
  code="${pair%%:*}"; txt="${pair#*:}"
  got="$(tty_render "$code" "$txt")"
  if printf '%s' "$got" | grep -q "\[${code}m${txt}"; then note "PASS 分支体: $txt → ${code}"
  else note "🔴 FAIL 分支体: $txt 没发出 ${code}"; fails=$((fails+1)); fi
done
# 源码侧的结构断言: 每个出口用的码必须是对的那一个, 且 say 一个码都不带。
src_has() { grep -A1 "^$1()" "$TMP/helpers.sh" | grep -c "033\[$2m"; }
for pair in "ok:32" "warn:33" "fail:31"; do
  fn="${pair%%:*}"; code="${pair##*:}"
  if [ "$(grep -A4 "^$fn()" "$TMP/helpers.sh" | grep -c "033\[${code}m")" -ge 1 ]
  then note "PASS 源码: $fn() 用的是 ${code}"
  else note "🔴 FAIL 源码: $fn() 里找不到 ${code}"; fails=$((fails+1)); fi
done
if grep '^say()' "$TMP/helpers.sh" | grep -q '033\['; then
  note "🔴 FAIL say() 里出现了转义序列 —— 它不该上色"; fails=$((fails+1))
else note "PASS 源码: say() 不带任何颜色码"; fi
# 守卫看的是不是【它自己写的那个流】: fail 写 fd2, 就必须用 -t 2。
if grep -A3 '^fail() {' "$TMP/helpers.sh" | grep -q '\[ -t 2 \]'; then
  note "PASS 源码: fail() 的守卫看 fd 2(它自己写的那个流)"
else
  note "🔴 FAIL fail() 的守卫没看 fd 2 —— \`cmd >file\` 之下 stderr 仍是终端, 用 -t 1 会判反"
  fails=$((fails+1))
fi
note "⛔ 未测: \`[ -t 1 ]\` / \`[ -t 2 ]\` 为【真】的那条路径 —— 需要真终端。"
note "   闭合办法(owner 在 Terminal 里跑一次即可, 不必是 mac):"
note "     bash -c '. <(awk \"/^LOGFILE=\\\"\\\"\$/{on=1} on{print} on && /^fail\\(\\) \\{/{i=1} i && /^\}\$/{exit}\" install-update.sh); LOGFILE=; ok X; warn Y; fail Z'"
note "   看到绿/黄/红各一行 = 这一格闭合。"

echo
if [ "$fails" -gt 0 ]; then
  echo "🔴 FAIL check-color-output — $fails 项不达标"
  exit 1
fi
echo "PASS check-color-output"
echo "  ✅ 非 tty(stdout+stderr 都重定向): 零转义字符 —— 这是硬判据, 真跑出来的"
echo "  ✅ 日志内容纯文本, 不含转义序列"
echo "  ✅ 四个出口的颜色码各自正确, 且 say 不上色; fail 的守卫看 fd 2"
echo "  ⛔ 【未测】tty 条件为真的那条路径 —— 这个会话没有终端, 造不出来(见上方闭合办法)"
echo "  ⛔ 【未测】mac —— 本机是 Windows+Git Bash。printf 与 [ -t N ] 都是 POSIX 的,"
echo "     但'同构所以应该也行'不是实测。别把这条绿读成 mac 已验。"
