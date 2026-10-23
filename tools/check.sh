#!/usr/bin/env bash
# tools/check.sh —— 这个仓的非宿主检查入口。无依赖(只要 bash + node)。
#
#   bash tools/check.sh              跑全部
#   bash tools/check.sh --selftest   跑全部的【反向控制】: 每条都必须红
#
# 🔴 为什么有 --selftest: 一条永远绿的检查 = 没有检查。
#    今天(2026-09-11)在姊妹仓踩过两次同一个坑 ——
#    ① 变异写错了, 套件却因【别的原因】红了, 差点被记成"反向控制成立";
#    ② 变异根本没落地, 输出是绿的, 而"什么都没测"与"检查失效"长得一模一样。
#    ⇒ 所以两条检查的 selftest 都断言【哪一条红、为什么红】, 且锚点丢失 = 失败(exit 4), ⛔ 不是跳过。
set -u
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "🔴 需要 node(消息一致性检查是 node 写的)。⛔ 这算缺席, 不算通过。"; exit 4
fi

fails=0
run() { # run <名字> <期望 pass|red> <命令...>
  local name="$1" want="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$want" = pass ] && [ "$rc" -eq 0 ]; then printf '✅ %s\n' "$name"
  elif [ "$want" = red ] && [ "$rc" -ne 0 ]; then printf '✅ %s (如期红了, exit=%s)\n' "$name" "$rc"
  else
    printf '🔴 %s —— exit=%s, 期望 %s\n' "$name" "$rc" "$want"
    printf '%s\n' "$out" | sed 's/^/     /'
    fails=$((fails+1)); return
  fi
  [ "$want" = pass ] && printf '%s\n' "$out" | sed 's/^/     /'
  return 0
}

if [ "${1:-}" = "--selftest" ]; then
  echo "── 反向控制: 下面每一条【都必须红】 ─────────────────────────────"
  # 消息一致性: 改掉一条的 severity ⇒ 必须红【且点名它】
  run "parity/篡改一条 severity" red \
      env MSG_PARITY_SELFTEST='Already up to date (v{}).' node tools/check-message-parity.js
  # 消息一致性: 动一条【被钉住的故意分岔】⇒ 也必须红(豁免不等于失明)
  run "parity/动一条被钉住的分岔" red \
      env MSG_PARITY_SELFTEST='That folder is recognised by the scripts already in it; if it is empty,' \
      node tools/check-message-parity.js
  # 消息一致性: 锚点丢失 ⇒ exit 4(失败), ⛔ 不是跳过
  run "parity/锚点丢失=失败" red \
      env MSG_PARITY_SELFTEST='no such message anywhere' node tools/check-message-parity.js
  # 颜色出口: 四个已知坏改动, 每个都必须被抓住
  for m in A B C D; do
    run "color/selftest $m" red bash tools/check-color-output.sh --selftest "$m"
  done
  echo
  [ "$fails" -eq 0 ] && { echo "✅ 反向控制全部成立 —— 这两条检查确实钉得住东西"; exit 0; }
  echo "🔴 有 $fails 条反向控制没红 ⇒ 那部分检查是装饰, 不是闸"; exit 1
fi

echo "── 检查 ────────────────────────────────────────────────────────"
run "bash -n install-update.sh" pass bash -n install-update.sh
run "消息 severity 两边一致"     pass node tools/check-message-parity.js
run "颜色出口真渲染"             pass bash tools/check-color-output.sh
echo
[ "$fails" -eq 0 ] && { echo "✅ 全部通过。⚠ 别忘了 \`bash tools/check.sh --selftest\` —— 绿色只在它会红的时候才有意义。"; exit 0; }
echo "🔴 $fails 条未通过"; exit 1
