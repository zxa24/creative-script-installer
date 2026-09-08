---
title: 更新日志
description: 每个已发布版本的工具与安装器包含什么，最新的在前。版本号就是安装器报告的、也是写进每个已装文件夹的那个。
---

# 更新日志

版本号是载荷版本 —— 安装器打印的那个数字，也是它写进每个已装文件夹的那个。一个数字同时覆盖 InDesign 和 Illustrator 两套；它们一起发布。

## 1.0.1 — 2026-09-08

**修复：一次看起来像死机的导入。**

强调补齐阶段 —— 也就是在版式稳定后补上强调、并撑开文字溢出的框的那一步 ——
**只在结束时打一行日志**。一次真实的导入在这一步里跑了八分多钟、CPU 满载，
两行日志之间什么都没有；从外面看，这和崩溃没有区别。

成因是一处漏掉的传递：日志通道到了流程这一层，却没有再往下传给真正做这件事的
代码，于是它无处可写。现在传下去了，这一阶段会边跑边报：

- 开始时报一次，说明要处理多少处；
- 每 25 处报一次，以及**任何单独一处超过一秒的**；
- 每撑开一个框报一行，指名是哪个框、尝试了多少次。

最后那一行还回答了旧日志答不了的问题：一个**纵向**溢出的框，无论把它加宽多少
都清不掉，于是搜索会把预算跑满再回滚。现在它会说出来，而不是看起来像卡死。

本次发布没有改变脚本做什么。

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
