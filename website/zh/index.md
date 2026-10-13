---
layout: home
title: Creative Script Kit
titleTemplate: InDesign 与 Illustrator 脚本
description: 免费的 Adobe InDesign 与 Illustrator 脚本。Folio 把排好版的 InDesign 文档交给译者，再把译文放回同一个版面。一组 InDesign 工具修好换语言后要调整的地方，五个 Illustrator 工具处理日常杂活。一条命令全部装好。

hero:
  name: Creative Script Kit
  text: InDesign 与 Illustrator 脚本。
  tagline: 一条命令安装，同一条命令更新。免费，开源。
  actions:
    - theme: brand
      text: 安装
      link: /zh/guide/install
    - theme: alt
      text: Folio
      link: /zh/folio/
    - theme: alt
      text: 更多工具
      link: /zh/tools/
    - theme: alt
      text: 全部脚本
      link: /zh/scripts/

features:
  - title: Folio
    details: 翻译一份排好版的 InDesign 文档，不用重新排版。你把文字发给译者，译者在网页里翻译，译文回到原来的文本框、样式和页面里。
    link: /zh/folio/
    linkText: Folio 怎么用
  - title: 更多工具
    details: 翻译流程以外的脚本。InDesign 里，一步保存文档并打开它所在的文件夹。Illustrator 里，五个小帮手：取消嵌入所有图片，把每个画板存成单独的 PDF，用 Export Small PDF 一键收尾（最小 PDF、最大 PDF、保存、打包），整份文件替换字体，设置中文和日文的断行与间距。
    link: /zh/tools/
    linkText: 查看工具
  - title: 全部脚本
    details: 在脚本面板或文件菜单里看到一个脚本名？查它是做什么的、在哪里有说明。
    link: /zh/scripts/
    linkText: 查一下
---

**要翻译一个 Folio zip？** 你什么都不用装。请看[给译者](/zh/folio/translator)。

## 一条命令安装

安装前先把 InDesign（和 Illustrator）各打开一次，再退出。打开终端，粘贴适合你电脑的那一行，按回车。每一步见[安装](/zh/guide/install)。

**Mac**：打开 Terminal（终端）应用，粘贴：

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
```

**Windows**：打开 PowerShell，粘贴：

```powershell
irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

然后重启 InDesign 和 Illustrator。以后要更新，再粘贴同一行即可。

## 给谁用

- **设计师**：要把文档排成多种语言，或者想让 InDesign 和 Illustrator 里的一些杂活自动完成。
- **译者**：收到了一个 Folio 包。你在网页里工作，什么都不用装。请看[给译者](/zh/folio/translator)。

你不需要会写代码。在 InDesign 里，双击 Scripts 面板里的脚本；在 Illustrator 里，从 File 菜单选它。

## 免费，开源

脚本和本站都在 [GitHub](https://github.com/zxa24/creative-script-installer) 上。欢迎在那里提问和报告问题。

::: details 给 AI 助手
整个网站也有纯文本版本（只有英文），你可以把地址交给 AI 助手，直接向它提问：[`llms.txt`](/llms.txt) 是索引，[`llms-full.txt`](/llms-full.txt) 是全部页面合成的一个文件。
:::
