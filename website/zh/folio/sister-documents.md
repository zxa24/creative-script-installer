---
title: 姊妹文档
description: 把一份 InDesign 文档里调好的段落样式设置复制到姊妹文档，不用手动重做。4.1 Export Brand Preset 保存设置；4.2 Apply Brand Preset 应用设置。从不改动字体。
---

# 姊妹文档

[翻译一份版面：给设计师](/zh/folio/designer)的第 5 阶段。你花了几轮调好一份文档的段落样式，而一份姊妹文档需要跟它一致、又不想手动重做时，看这一页。

这些是 Creative Script Kit 的免费 InDesign 脚本。用一行命令装一次（[安装](/zh/guide/install)），然后在 Scripts 面板的 **User → indesign-toolkit-stable** 下找到它们（[在哪里找到脚本](/zh/guide/install#where-to-find-the-scripts)）。

姊妹文档是和你调好的那份同属一个系列的另一份文档，比如为另一款产品做的同一种资料页（fact sheet），用同一套样式排版。

**4.1** 从你调好的文档里保存设置。**4.2** 把设置应用到姊妹文档。两者都只作用于 Folio 导入或 [**2.4 Reorganize Styles**](/zh/folio/before-export#reorganize-styles) 生成的段落样式，而且都不会改动字体。想确认文档里有没有这些样式，打开 Paragraph Styles 面板（段落样式面板）：它们的名字以 `_T_p_` 开头。

## 4.1 Export Brand Preset {#export-brand-preset}

在你已经调好段落样式的那份文档里用它。

1. 保存文档。设置文件会写在它旁边。
2. 在 Scripts 面板里双击 **4.1 Export Brand Preset**（导出品牌预设）。它什么都不问。

它把每个样式的字号、行距、缩进、段前段后间距、对齐、颜色和段落线存进一个设置文件（品牌预设），名为 `brand_style_preset.json`。如果文档旁边有一个写明品牌名的品牌配置文件，文件名前面会加上品牌名：`<brand>_brand_style_preset.json`。它只读取文档，不改动文档里的任何东西。

## 4.2 Apply Brand Preset {#apply-brand-preset}

在需要保持一致的姊妹文档里用它。

1. 保存姊妹文档，并确认 4.1 生成的预设文件在同一个文件夹里。如果两份文档本来就在同一个文件夹，那它已经在了。4.2 会在自己文档所在的文件夹里找文件名以 `_brand_style_preset.json` 结尾的文件，找不到时才用 `brand_style_preset.json`。如果有好几个，它会选与本文档品牌对应的那个，否则选最新的，并在日志里说明。那个文件夹里只留你要用的那一个。
2. 双击 **4.2 Apply Brand Preset**（应用品牌预设）。它什么都不问。
3. 在文档旁边 **script_outputs** 里的 **log** 文件夹中查看它的报告。如果有些设置没有带过来，请看[下文](#settings-not-carried)。

它用保存的设置更新相应的段落样式。字体从不改动。整次运行算一步撤销。

姊妹文档里手动改过的字号、行距、缩进、保持选项、对齐和书写器会被保留，并列在报告里。段前段后间距、颜色和段落线则总是被预设的值覆盖。

## 常见问题

::: details 4.2 说找不到预设
预设文件不在姊妹文档所在的文件夹里，或者文档从来没有保存过。从第一份文档的文件夹里把文件复制过来，再运行一次。没有任何东西被改动。
:::

::: details 有些设置没有带过来
<a id="settings-not-carried"></a>

姊妹文档里有人手动改过的字号、行距、缩进、保持选项、对齐或书写器会被保留，并标为保留本地值（kept local）。段前段后间距、颜色和段落线总会写入；没写进去的颜色或段落线会标为失败（failed）。这两种情况它都不会隐瞒。
:::

::: details 报告说样式被复用了，但并不是所有东西都变了
"复用"（reused）只说明一个样式找到了对应的样式。要和应用率（applied rate）、保留本地值的数量（kept local）、失败数量（failed）一起看。
:::

::: details 技术说明
<a id="export-brand-preset-details"></a><a id="apply-brand-preset-details"></a>技术说明只有英文版：[查看](/folio/sister-documents#export-brand-preset-details)
:::
