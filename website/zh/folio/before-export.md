---
title: 导出之前
description: 导出文字之前，先让 InDesign 文档为 Folio 做好准备。3.3 Relink Missing Links 在文档所在文件夹里找回缺失的图片；2.4 Reorganize Styles 把几百个几乎一样的段落样式换成一小套干净的样式。
---

# 导出之前

[翻译一份版面：给设计师](/zh/folio/designer)的第 1 阶段。运行 **1.1 Export Translation Package** 之前，版面应该已经定稿，InDesign 不应报告[缺失字体](/zh/folio/export-import#missing-fonts)或缺失链接，文档应该已经保存。文档还没完全准备好时，看这一页：比如 InDesign 报告[缺失链接](#relink-missing-links)，或者段落样式已经[乱成一团](#reorganize-styles)。

这些是 Creative Script Kit 的免费 InDesign 脚本。用一行命令装一次（[安装](/zh/guide/install)），然后在 Scripts 面板的 **User → indesign-toolkit-stable** 下找到它们（[在哪里找到脚本](/zh/guide/install#where-to-find-the-scripts)）。

两个工具都是可选的。如果文档已经很干净，直接去看[2 导出与导入](/zh/folio/export-import)。

## 3.3 Relink Missing Links {#relink-missing-links}

InDesign 报告缺失链接，而文件就在文档所在文件夹里的某个地方时，用它。

1. 保存文档，这样脚本才知道要在哪个文件夹里找。
2. 在 Scripts 面板里双击 **3.3 Relink Missing Links**（重新链接缺失链接）。它什么都不问。
3. 看窗口里列出的结果：它重新链接了哪些，[哪些没找到](#still-missing)。然后点 **Close**。

对每个缺失的链接，它会在文档所在文件夹及其中任何子文件夹里找同名文件并重新链接，其余的不动。所有重新链接算一步撤销。

## 2.4 Reorganize Styles {#reorganize-styles}

文档里堆了几百个几乎一样的段落样式，或者段落全靠本地覆盖撑着时，用它。

1. 打开文档，双击 **2.4 Reorganize Styles**（整理样式）。
2. 在它唯一的对话框里选择段落的分组方式，点 **OK**。点 **Cancel** 则什么都不改，直接停止。
3. 等它跑完，中间不会再问。看一下总结和其中的警告，然后把文档浏览一遍。

它在打开的文档里把看起来一样的段落归成一组，每组用一个新的段落样式。字体保持不变。整次运行算一步撤销，所以不满意的话，在保存之前撤销。

## 下一步

[2 导出与导入](/zh/folio/export-import)：用 **1.1 Export Translation Package** 导出文字，发给译者。

## 常见问题

::: details 运行 3.3 之后还有链接缺失
<a id="still-missing"></a>

只有在文档所在文件夹或其子文件夹里找到名字完全相同的文件（不区分大小写）时，它才会重新链接。它从不猜测。把文件移到文档所在文件夹里，或者在 Links 面板里手动重新链接。
:::

::: details 3.3 选了文件的另一份副本
同一个文件名出现在好几个地方时，离文档所在文件夹最近的那份优先。这样它不会拿到深藏在某个打包文件夹里的副本。
:::

::: details 链接显示为已修改，而不是缺失
文件还在、只是改过了，需要在 Links 面板里用 **Update Link**（更新链接）。3.3 只处理文件缺失的链接。
:::

::: details 3.3 说它停止了搜索
它找到 4000 个文件夹或 12 层深时就会停下，并且会明说，而不是悄悄少找一些。把链接的文件放得离文档近一些。
:::

::: details 技术说明
<a id="relink-missing-links-details"></a><a id="reorganize-styles-details"></a>技术说明只有英文版：[查看](/folio/before-export#relink-missing-links-details)
:::
