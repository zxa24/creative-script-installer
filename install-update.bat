@echo off
rem  install-update.bat  —  双击运行: InDesign 工具箱 一键安装/更新 (Windows)
rem  以 -ExecutionPolicy Bypass 调用同目录的 install-update.ps1，
rem  这样设计师无需改系统脚本执行策略。窗口末尾 pause 便于阅读结果。
chcp 65001 >nul
rem  Sitting next to a distribution (the manifest is here) = this IS the source.
rem  The docs call this the route for a machine with no terminal or a copy on a
rem  USB stick; without this line it still downloaded from GitHub and an offline
rem  machine got "network error" with the files right beside it.
if exist "%~dp0toolkit.manifest.json" set "TOOLKIT_SOURCE=%~dp0."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-update.ps1" %*
echo.
pause
