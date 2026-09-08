---
title: 全部脚本
description: 安装器分发的每一个脚本：编号的 InDesign 各组，以及 Illustrator 工具。
---

# 全部脚本

InDesign 脚本是编号的。第一位数字是组，组决定它是正常流程的一部分（第 1 组）还是需要时才用的工具（第 2、3、4 组）。面板按文字排序，所以每组最多九项 —— `2.10` 会排在 `2.1` 和 `2.2` 之间。

## 第 1 组 — 工作流

**正常流程。** 按顺序跑。→ [详情](/zh/scripts/workflow)

| # | 脚本 | 一句话 |
| --- | --- | --- |
| `1.1` | [Export Translation Package](/zh/scripts/workflow#export-translation-package) | 从打开的文档导出一个离线翻译包。 |
| `1.2` | [Import Translation Package](/zh/scripts/workflow#import-translation-package) | 把翻译好的包读回源文档的一份新副本。 |

## 第 2 组 — 字体与样式

工具。→ [详情](/zh/scripts/type-and-styles)

| # | 脚本 | 一句话 |
| --- | --- | --- |
| `2.1` | [Apply Font Pairing](/zh/scripts/type-and-styles#apply-font-pairing) | 扫描文档字体，打开面板选跨语言字体配对，以直接格式应用替换。 |
| `2.2` | [Apply CJK Styles](/zh/scripts/type-and-styles#apply-cjk-styles) | 在可选的文本清理之后，把简体中文供体段落样式及其排版设置导入文档。 |
| `2.3` | [Set Selection Weight](/zh/scripts/type-and-styles#set-selection-weight) | 把所选文本设为一个命名字重，具体字体与字重取自品牌配置。 |
| `2.4` | [Reorganize Styles](/zh/scripts/type-and-styles#reorganize-styles) | 按视觉指纹聚类每个段落，就地把文档重建在一小组生成的段落样式上。 |
| `2.5` | [Repair Cluster GREP](/zh/scripts/type-and-styles#repair-cluster-grep) | 重写已建簇样式里的嵌套 GREP 规则，让中性标点不再用错误脚本的字体渲染。 |
| `2.6` | [Convert Underline to Rule](/zh/scripts/type-and-styles#convert-underline-to-rule) | 把整段下划线的字符级下划线换成段落线。 |

## 第 3 组 — 检查与修复

工具。`3.1` 和 `3.2` 是一对。→ [详情](/zh/scripts/check-and-repair)

| # | 脚本 | 一句话 |
| --- | --- | --- |
| `3.1` | [Snapshot Before Apply](/zh/scripts/check-and-repair#snapshot-before-apply) | 为每个可修复的文章拍「之前」快照，并撑大装不下 CJK 文本的框。 |
| `3.2` | [Repair After Apply](/zh/scripts/check-and-repair#repair-after-apply) | 读取 `3.1` 的快照，修复批量改动扰乱的部分，写一份验收报告。 |
| `3.3` | [Relink Missing Links](/zh/scripts/check-and-repair#relink-missing-links) | 在文档自己的目录下按文件名找到断掉的链接并重新链接。 |
| `3.4` | [Highlight Translation Changes](/zh/scripts/check-and-repair#highlight-translation-changes) | 把文本与保存的基线做差异，在专用图层上用矩形标出改动的字符。 |
| `3.5` | [Save and Reveal](/zh/scripts/check-and-repair#save-and-reveal) | 有未保存改动时提议保存，然后在系统文件浏览器里打开它所在的目录。 |

## 第 4 组 — 品牌预设

工具。→ [详情](/zh/scripts/brand-presets)

| # | 脚本 | 一句话 |
| --- | --- | --- |
| `4.1` | [Export Brand Preset](/zh/scripts/brand-presets#export-brand-preset) | 把这份文档生成的段落样式调好的几何参数捕获进一个品牌预设文件。只读文档，从不写它。 |
| `4.2` | [Apply Brand Preset](/zh/scripts/brand-presets#apply-brand-preset) | 把品牌预设的几何参数应用到姊妹文档中匹配的段落样式上。从不碰字体。 |

## Illustrator

五个 Illustrator 工具，仅当机器上装有 Illustrator 时才安装。它们出现在 **文件 → 脚本 → illustrator-toolkit-stable** 下，且不编号：它们彼此独立，也独立于 InDesign 的流程，编号会宣称一个并不存在的顺序。→ [详情](/zh/scripts/illustrator)

| 脚本 | 一句话 |
| --- | --- |
| Unembed All Images | 把每个嵌入的图像导出到一个文件夹并重新链接为外部文件；也可以移除损坏的置入项，包括锁定或隐藏的。 |
| Export Artboard PDFs | 把每个画板各自导出为一个 PDF，先把它复制到新文档里。 |
| Export Small PDF | 把当前文档导出为紧凑的 PDF，然后保存或打包。 |
| Replace Fonts | 一个 *from → to* 字体对的对话框，应用到整个文档。 |
| CJK Composer and Mojikumi | 把文本切换到 CJK 每行或单行书写器，需要的话再应用一套标点挤压与避头尾集 —— 作用于所选或整个文档。 |

::: tip 它们是 ExtendScript，不是 UXP
这些是 Illustrator 直接运行的 `.jsx` 文件。这里没有任何东西和 InDesign 脚本对话，InDesign 脚本也不和它们对话。
:::

## 关于撤销

这些脚本大多把整次运行包在一个 InDesign 撤销步骤里，所以一次 <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> 撤销整批，而不是一次一处。凡是如此的，脚本的页面会说明。
