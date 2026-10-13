---
title: 更多工具
description: Creative Script Kit 里不属于翻译流程的工具。InDesign 里，3.5 Save and Reveal 保存文档并打开它所在的文件夹。Illustrator 里，五个处理日常杂活的工具：Unembed All Images、Export Artboard PDFs、Export Small PDF、Replace Fonts，以及 CJK Composer and Mojikumi，各在什么时候用、对话框里怎么选。
---

# 更多工具

这些工具不属于翻译流程：每一个单独完成一件日常的事。它们和其他脚本一起用一行命令装好（[安装](/zh/guide/install)）。

## InDesign {#indesign}

在 Scripts 面板的 **User → indesign-toolkit-stable** 下找到它（[在哪里找到脚本](/zh/guide/install#where-to-find-the-scripts)）。

### 3.5 Save and Reveal {#save-and-reveal}

想保存文档并打开它所在的文件夹时用它。

1. 在 Scripts 面板里双击 **3.5 Save and Reveal**（保存并显示）。
2. 如果文档有未保存的修改，它会问要不要保存。对于从没保存过的文档，选是会打开 Save As（存储为）对话框。

只有你选是，它才会保存，然后在 Explorer（资源管理器）或 Finder（访达）里打开文档所在的文件夹。

## Illustrator {#illustrator}

五个处理 Illustrator 日常杂活的小工具，在 **File → Scripts → illustrator-toolkit-stable**（文件 → 脚本）下找到。

### Unembed All Images {#unembed-all-images}

文件里嵌入了图片，而你想把它们变成单独的链接文件时用它；也可以用来清理损坏的链接。

1. 保存文档，然后选择 **File → Scripts → illustrator-toolkit-stable → Unembed All Images**（取消嵌入所有图片）。
2. *Asset Management*（素材管理）窗口会显示它找到了多少嵌入的图片和损坏的链接。勾选你要做的事：导出嵌入的图片并重新链接，删除损坏的链接，或者两者都做。**Change...** 可以换一个输出文件夹。
3. 点 **Run**，看一下总结。

它把每张嵌入的图片写成一个文件，放在文档旁边新建的 **Linked_assets** 文件夹里（如果这个名字已被占用，就用 **Linked_assets_1** 等），并把图稿链接到这些文件。

### Export Artboard PDFs {#export-artboard-pdfs}

每个画板都需要单独存成一个 PDF 时用它。

1. 保存文档，然后选择 **File → Scripts → illustrator-toolkit-stable → Export Artboard PDFs**（按画板导出 PDF）。
2. 如果文档里有损坏的链接，选择怎么处理：从某个文件夹重新链接，导出时跳过，从文档里删除，或者取消。
3. 在 *Export Artboards as PDF* 窗口里勾选 **PDF**、**Print PDF**（带出血）或 **.ai File**，选一个 PDF 预设，点 **Export**。

它为每个画板写一个文件，以画板名命名，放进文档旁边一个新建的、名字以 `_export` 结尾的文件夹，然后打开这个文件夹。想改文件名，先在 Artboards 面板（画板面板）里给画板改名。

### Export Small PDF {#export-small-pdf}

想一键收尾时用它：导出最小的 PDF、最大的 PDF、保存文档、打包，可以任意组合。

1. 保存文档，然后选择 **File → Scripts → illustrator-toolkit-stable → Export Small PDF**（导出小 PDF）。
2. 在 *Quick Actions*（快捷操作）里勾选你要做的事：**Export smallest PDF**（导出最小 PDF，默认勾选）、**Export largest PDF**（导出最大 PDF）、**Save document**（保存文档）、**Package**（打包）。
3. 点 **OK**。

PDF 存在文档旁边，名为 `<name>_smallest.pdf` 和 `<name>_highquality.pdf`（文件已存在时会加一个编号），然后打开所在文件夹。**Package** 会在最后打开 Illustrator 自己的 Package（打包）对话框。

::: warning 先保存
为了导出，它会关闭你的文档，再从磁盘重新打开。没有保存的修改不会留在 `.ai` 文件里，所以请先保存，或者勾选 **Save document**。
:::

### Replace Fonts {#replace-fonts}

整份文件或选中的部分里，需要把一个字体换成另一个字体时用它。

1. 选择 **File → Scripts → illustrator-toolkit-stable → Replace Fonts**（替换字体）。
2. 点 **+ Add**，在每一行里选一个 *From*（原字体）和一个 *To*（新字体）。在 **Filter** 里输入文字再点 **Search**，可以缩小字体列表。
3. 在 **Scope**（范围）下选择 **Whole document**（整份文档）或 **Selection only**（仅选区），然后点 **Replace**。

它会修改文档里的字体，并报告替换了多少个字符。**Save rules** 和 **Load rules** 可以把一组配对存起来下次再用。要还原，用 **Edit → Undo**（编辑 → 还原）。

### CJK Composer and Mojikumi {#cjk-composer-and-mojikumi}

中文或日文需要中日韩（CJK）排版时用它：中日韩书写器、标点挤压集（Mojikumi，字符之间的间距规则）和避头尾集（Kinsoku，哪些字符不能放在行首或行尾的规则）。

1. 选中要处理的文本框，或者什么都不选，处理所有文本框。
2. 选择 **File → Scripts → illustrator-toolkit-stable → CJK Composer and Mojikumi**（中日韩书写器与标点挤压）。
3. 如果有选中的对象，它会问一个问题：点 **OK** 只处理选中的文本框。如果它在中日韩文字和拉丁文字之间找到空格，会把它们列出来：点 **OK** 删除，点 **Cancel** 保留。

::: warning Cancel 不会停止脚本
在第一个问题里，**Cancel 不会停止脚本**，它的意思是"处理文档里的所有文本框"。在这个问题上没有办法停下。只想处理你的选区，就点 **OK**；想撤回一次运行，用 **Edit → Undo**。
:::

它会为每个段落设置书写器、标点挤压和避头尾，在中日韩文字与拉丁字母或数字相接的地方加一点间距，并在文字溢流的文本框里收紧全角标点。锁定和隐藏的文本框会跳过。最后有一份总结，列出它设置了什么。

## 常见问题

::: details Illustrator 工具提示 "No document open"（没有打开的文档）
每个 Illustrator 工具都需要一份打开的文档。打开文件，再运行一次。
:::

::: details Illustrator 工具要我先保存
Unembed All Images、Export Artboard PDFs 和 Export Small PDF 会把文件写到文档旁边，所以文档必须至少保存过一次。保存后再运行一次。
:::

::: details 运行 Export Small PDF 之后丢了修改
为了导出，它会关闭文档，再从磁盘重新打开。在那之前没保存的内容不在 `.ai` 文件里。下次请先保存，或者勾选 **Save document**。
:::

::: details Replace Fonts 说什么都没选中
**Scope** 设成了 **Selection only**。用选择工具选中一个文本框或编组，或者用文字工具选中文字，再运行一次。也可以改选 **Whole document**。
:::

::: details Replace Fonts 说同一个 From 字体出现在不止一行里
每个 *From* 字体只能出现在一行里。删掉或合并重复的行，再点一次 **Replace**。
:::

::: details 我在 Export Artboard PDFs 里填的出血值下次不见了
出血值存在文档里。导出之后保存文档，才能留住它们。
:::

::: details 总结里写着 Mojikumi 或 Kinsoku "(not set / not found)"
文档里没有可用的标点挤压集或避头尾集，所以这一部分跳过了。其他设置照样已经应用。
:::

::: details 技术说明
<a id="save-and-reveal-details"></a><a id="illustrator-details"></a>技术说明只有英文版：[查看](/tools/#save-and-reveal-details)
:::
