---
title: 正常流程
description: 从排好版的文档导出翻译包，交去翻译，再导回该文档的一个副本。两个脚本，按顺序。
---

# 正常流程

日常工作里你跑**两个**脚本，按这个顺序：

1. [`1.1 Export Translation Package`](/zh/scripts/workflow#export-translation-package)
2. …翻译在别处进行…
3. [`1.2 Import Translation Package`](/zh/scripts/workflow#import-translation-package)

第 `2.x`、`3.x`、`4.x` 组里的一切都是出问题时才拿出来的工具。它们不是步骤。

## 第 1 步 — 导出翻译包

在 InDesign 里打开源 `.indd` 文档，然后从脚本面板运行 **`1.1 Export Translation Package`**。

它在你的工作目录下写出一个包文件夹：

```text
script_outputs/package/<doc>_translation_package_<timestamp>/
```

里面除其他文件外还有：

| 文件 | 是什么 |
| --- | --- |
| `preview.pdf` | 文档当前状态的视觉参考。 |
| `segments.json` | 每一个可翻译的文本段，带身份与上下文。 |
| `translations_template.json` | 译者要填的文件 —— 空着的目标语一侧。 |
| `tid_map.json` | 从段 id 回到文档中位置的映射。 |
| `<doc>.idml` | 文档的一份 IDML 副本，随包携带。 |
| `manifest.json` | 包里有什么，用于往返完整性。 |

把包交给负责翻译的人。

## 第 2 步 — 翻译

译者填好目标语一侧，返回一个 **`translations.json`**，可以单独给，也可以放在包的 `.zip` 里。

::: tip 格式是显式选择的
译者没有手动标注的格式不会自动带到目标语上。译者没标，流程就不套。
:::

## 第 3 步 — 把包导回来

再次打开**原始**的源 `.indd` —— 不是之前的输出 —— 运行 **`1.2 Import Translation Package`**。

它会向你要 `translations.json`（或者包的 `.zip`，它会替你解压）。然后它：

1. 把源文档复制为 `<doc>.translated.indd` 并打开。**源文档永远不会被写入。**
2. 在这里暂停，让你一次性处理缺失的字体或链接。
3. 分析文档、建立样式计划、定位每一个段。
4. 闸门：如果预检发现阻断性问题，它会在碰任何东西之前停下。
5. 写入译文并应用样式计划。
6. 跑后检（溢流文本、样式应用失败、混合文本串）和一轮修复。
7. 保存 `<doc>.translated.indd` 并留在屏幕上。

如果导入失败，它会关闭工作文档并删掉写了一半的 `.translated.indd`。它不会给你留一个半成品。

::: warning 从原件导入，不要从输出导入
如果当前文档已经是 `.translated` / `.aborted` / `.BLOCKED` 输出，导入会拒绝运行。往输出里导入会把流程套两遍，产生 `<doc>.translated.translated.indd`。请打开原始 `.indd`。
:::

## 第 4 步 — 看结果

打开 `<doc>.translated.indd` 检查结果。发生了什么的报告在 `script_outputs/report/`，运行日志在 `script_outputs/log/`。

到这里你要么完成了，要么遇到了一个具体问题 —— 而具体问题正是各工具组的用武之地：

| 症状 | 用 |
| --- | --- |
| 新语言的字体不对 | [`2.1 Apply Font Pairing`](/zh/scripts/type-and-styles#apply-font-pairing) |
| 中文排得很难看 | [`2.2 Apply CJK Styles`](/zh/scripts/type-and-styles#apply-cjk-styles) |
| 某段文字字重不对 | [`2.3 Set Selection Weight`](/zh/scripts/type-and-styles#set-selection-weight) |
| 几百个几乎相同的段落样式 | [`2.4 Reorganize Styles`](/zh/scripts/type-and-styles#reorganize-styles) |
| 标点用了错误的字体渲染 | [`2.5 Repair Cluster GREP`](/zh/scripts/type-and-styles#repair-cluster-grep) |
| CJK 字形下的下划线看着断了 | [`2.6 Convert Underline to Rule`](/zh/scripts/type-and-styles#convert-underline-to-rule) |
| 图片链接断了 | [`3.3 Relink Missing Links`](/zh/scripts/check-and-repair#relink-missing-links) |
| 「上一轮到底改了什么？」 | [`3.4 Highlight Translation Changes`](/zh/scripts/check-and-repair#highlight-translation-changes) |
| 批量应用后版式受损 | [`3.1`](/zh/scripts/check-and-repair#snapshot-before-apply) + [`3.2`](/zh/scripts/check-and-repair#repair-after-apply) |
| 姊妹文档要跟上这份的字体设定 | [`4.1`](/zh/scripts/brand-presets#export-brand-preset) + [`4.2`](/zh/scripts/brand-presets#apply-brand-preset) |

## 文件在哪

见[文件与目录](/zh/guide/folders)。简单说：工作目录里放 `<doc>.indd` 和 `<doc>.translated.indd`，其他一切都在 `script_outputs/` 下。
