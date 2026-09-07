#!/bin/bash
# install-update.command  —  Finder 双击运行: InDesign 工具箱 一键安装/更新 (macOS)
# 首次运行需 chmod +x 且可能遇 Gatekeeper「未识别开发者」→ 右键→打开 一次即可。
cd "$(dirname "$0")"
bash ./install-update.sh "$@"
echo ""
echo "按回车键关闭此窗口。"
read -r _
