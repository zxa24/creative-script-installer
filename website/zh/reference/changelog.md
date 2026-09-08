---
title: 更新日志
description: 每个已发布版本的工具与安装器包含什么，最新的在前。版本号就是安装器报告的、也是写进每个已装文件夹的那个。
---

# 更新日志

版本号是载荷版本 —— 安装器打印的那个数字，也是它写进每个已装文件夹的那个。一个数字同时覆盖 InDesign 和 Illustrator 两套；它们一起发布。

## 1.0.0 — 2026-09-08

首个公开版本。

**安装器**

- 粘贴一条命令即可安装与更新，Windows（`irm … | iex`）与 macOS（`curl … | bash`）；同一条命令再跑一次就是更新。写入任何东西之前先下载并做校验和验证。
- 在终端里运行时有交互菜单 —— Install、Update、Repair、Uninstall —— 只提供适用的选项。
- 支持 Illustrator，含它需要的那一次管理员步骤，在会话内完成：macOS 上输密码，Windows 上批准提示，只在确实需要时才问，Illustrator 从没启动过时则带说明跳过。
- 除非要求，否则不写日志文件（`--log` / `CSI_LOG=1`）；要求时每次运行在桌面写一个文件。
- `install-update.bat` / `.command` 给没有终端的机器；它们安装自己所在的那份副本。

**InDesign — 四组 15 个脚本**

- `1.x` 工作流：Export Translation Package、Import Translation Package。
- `2.x` 字体与样式：Apply Font Pairing、Apply CJK Styles、Set Selection Weight、Reorganize Styles、Repair Cluster GREP、Convert Underline to Rule。
- `3.x` 检查与修复：Snapshot Before Apply、Repair After Apply、Relink Missing Links、Highlight Translation Changes、Save and Reveal。
- `4.x` 品牌预设：Export Brand Preset、Apply Brand Preset。

**Illustrator — 5 个工具**

- Unembed All Images、Export Artboard PDFs、Export Small PDF、Replace Fonts、CJK Composer and Mojikumi。

**文档**

- 本站，英文与简体中文，附一份机器可读副本（`llms.txt`、`llms-full.txt`），把地址交给 AI 助手即可提问。
