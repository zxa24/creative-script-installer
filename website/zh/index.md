---
layout: home
title: Creative Script Installer
titleTemplate: 一条命令装好 InDesign 与 Illustrator 脚本
description: 一条命令安装并更新 Adobe InDesign 与 Illustrator 的脚本。InDesign 那套把排好版的文档送去翻译、再把译文放回同一个版式；Illustrator 那套是五个独立工具。

hero:
  name: Creative Script Installer
  text: 译文，回到原版式。
  tagline: 粘贴一条命令，装好一组 InDesign 脚本：把排好版的文档交给译者，再把译文放回同一个版式 —— 然后帮你修好新语言弄坏的地方。另附五个 Illustrator 工具。
  actions:
    - theme: brand
      text: 安装
      link: /zh/guide/install
    - theme: alt
      text: 正常流程
      link: /zh/guide/workflow
    - theme: alt
      text: 全部脚本
      link: /zh/scripts/

features:
  - title: 日常只用两个脚本
    details: 先 1.1 Export Translation Package，再 1.2 Import Translation Package。这就是全部流程。其余都是出问题时才拿出来的工具。
    link: /zh/scripts/workflow
    linkText: 第 1 组 — 工作流
  - title: 需要时才用的工具
    details: 字体配对、CJK 样式、样式合并、缺失链接修复、改动高亮、品牌预设。不属于正常流程 —— 有目的地去用。
    link: /zh/scripts/
    linkText: 完整索引
  - title: 自己安装、自己更新
    details: Windows 或 macOS 上一条命令。不需要 GitHub 账号、git，不需要密码 —— 只有 Illustrator 例外，它会问一次。写入任何东西之前先做完校验。
    link: /zh/guide/install
    linkText: 安装与更新
---

## 这是什么

**Creative Script Installer** 用一条命令把两组脚本放到应用读取它们的位置，之后用同一条命令更新。较大的那组 `indesign-toolkit` 住在 InDesign 的**脚本面板**里；一小组 Illustrator 工具住在 Illustrator 的 File → Scripts 下 —— 没装 Illustrator 的话它一个字都不会提。

这些脚本只做一件事：一份已经用某种语言排好版的 InDesign 文档，把文字送到别处翻译，再把译文放回**同一个版式**，而不是重新排一遍。

## 给谁用

给做多语言排版的设计师，以及帮他们跑流程的人。它不要求会写代码：正常流程就是在脚本面板里双击两个脚本。

## 给自动化的人

每个脚本都写日志和报告，落在文档旁边的 `script_outputs/` 里。安装器有退出码、有开关、有环境变量覆盖，见[高级安装与分发](/zh/reference/advanced)。

## 给 AI

本站另有一份机器可读的全文：[`llms.txt`](/llms.txt) 与 [`llms-full.txt`](/llms-full.txt)。把本站地址交给一个 AI 助手，就可以直接向它提问。
