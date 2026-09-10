#!/bin/bash
# install-update.command  —  Finder 双击运行: Creative Script Installer 一键安装/更新 (macOS)
# 装 InDesign 与 Illustrator 两套脚本; 没装的那个只字不提。
# 首次运行需 chmod +x 且可能遇 Gatekeeper「未识别开发者」→ 右键→打开 一次即可。
cd "$(dirname "$0")"
# Sitting next to a distribution (the manifest is here) = this IS the source.
# This is the documented route for a machine with no terminal or a copy on a
# USB stick; without this line it still downloaded from GitHub.
[ -f ./indesign-toolkit.manifest.json ] && export TOOLKIT_SOURCE="$PWD"
bash ./install-update.sh "$@"
echo ""
echo "Press Enter to close this window."
read -r _
