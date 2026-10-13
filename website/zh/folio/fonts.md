---
title: "3 调整新语言"
description: 运行 1.2 Import Translation Package 之后，修好换语言带来的变化。为各语言配好字体，设置中文的断行和间距，设置所选文字的字重，修复落到错误字体上的标点，把断开的下划线换成段落线，并在大改动时保护版面。
---

# 调整新语言

[翻译一份版面：给设计师](/zh/folio/designer)的第 3 阶段。运行 [**1.2 Import Translation Package**](/zh/folio/export-import) 之后，如果翻译副本需要换字体、需要正确的中文排版，或者中文和拉丁文相接的地方需要修一下，看这一页。

这些是 Creative Script Kit 的免费 InDesign 脚本。用一行命令装一次（[安装](/zh/guide/install)），然后在 Scripts 面板的 **User → indesign-toolkit-stable** 下找到它们（[在哪里找到脚本](/zh/guide/install#where-to-find-the-scripts)）。

**导入已经做了的事：** 它已经为各语言配好了字体（需要配对时，导入过程中会打开配对面板）。它**没有**设置中文、日文或韩文的断行和间距。

- **中文、日文或韩文：** 第一次导入之后，运行一次 **2.2 Apply CJK Styles**。
- **英文或其他拉丁字母语言：** 这一页的工具通常都用不上。
- 其他工具针对具体问题。看到哪种问题，就打开对应的那个。

## 字体与中文排版

### 2.1 Apply Font Pairing {#apply-font-pairing}

想改变不同语言之间哪个字体配哪个字体时用它，比如给某个拉丁字体换一个配套的中文字体。导入时已经问过它需要的配对；这个工具是用来事后修改的。

1. 打开翻译后的文档，在 Scripts 面板里双击 **2.1 Apply Font Pairing**（应用字体配对）。
2. 会打开一个面板，列出文档用到的字体。为每个字体设置它的配对字体。
3. 点 **Done**。提示会告诉你它改了多少处。

它直接修改文字上的字体，不新建段落样式或字符样式。整批改动算一步撤销。

### 2.2 Apply CJK Styles {#apply-cjk-styles}

中文需要中文的断行规则和其他中文排版设置时用它。

1. 在要设置的文字里点一下。什么都不选的话，它会作用于整份文档。
2. 双击 **2.2 Apply CJK Styles**（应用中日韩样式）。
3. 在对话框里选择你的语言（每次都从简体中文开始）和要运行的清理项，点 **OK**。

::: warning 你手动加的换行
清理项 **Remove soft line breaks**（删除软换行）每次都默认勾选，它会删除**整份文档**里的所有软换行（Shift+Enter），即使你只选中了一个文本框。如果你手动加过换行，比如在已经运行过一次 2.2 之后，就取消勾选它。
:::

它会把一个现成的中文段落样式（带断行和排版设置）导入文档并应用，如果[这些设置没有生效](#kinsoku-not-applied)，它会明确告诉你。它也会自己保护版面：先把放不下一行中文的文本框拉高，事后再检查并修复版面，所以不需要在它前后运行 3.1 和 3.2。整次运行算一步撤销。

### 2.3 Set Selection Weight {#set-selection-weight}

选中的文字需要设成某个字重（比如粗体），并且要用你品牌设定的字体时用它，中文和拉丁文混排也可以。

1. 选中文字。
2. 双击 **2.3 Set Selection Weight**（设置所选字重）。
3. 在对话框里选择字重，点 **OK**。

选区里的中文部分和拉丁文部分会各自得到这个字重对应的正确字体。如果无法完成，它什么都不改，并[说明原因](#weight-stopped)。整次运行算一步撤销。

### 2.5 Repair Cluster GREP {#repair-cluster-grep}

用旧版本导入的文档里，拉丁文单词之间的标点（比如弯撇号）显示成中文字体时，用它。

1. 打开文档。
2. 双击 **2.5 Repair Cluster GREP**（修复字体分组 GREP）。它什么都不问。

它会更新文档里那些自动生成的段落样式中的规则（这些规则决定哪些字符用拉丁字体、哪些用中文字体），然后刷新文字。再运行一次不会有任何改动。整次运行算一步撤销。用当前版本导入的文档不需要它。

### 2.6 Convert Underline to Rule {#convert-underline-to-rule}

一整段文字加了下划线，而下划线断断续续时用它：在中文字下面看不见，在拉丁字母和数字下面又露出来。

1. 打开文档。
2. 双击 **2.6 Convert Underline to Rule**（下划线转段落线）。它什么都不问。
3. 看它最后显示的总结。

对每一个可见文字全部带下划线的段落，它会去掉下划线，改在段落下方画一条细线，颜色跟带下划线的文字一致。这条线在中文和拉丁文下面都是连续的。已经转换过的段落会跳过。整次运行算一步撤销。

## 大改动时保护版面 {#protect-the-layout}

**3.1** 和 **3.2** 是一对。在你手动做一次大改动之前运行 3.1，改完之后马上运行 3.2。大改动指的是比如整份文档的查找替换，或者修改段落样式。**2.2 Apply CJK Styles** 和导入本身已经会自己做这件事。

### 3.1 Snapshot Before Apply {#snapshot-before-apply}

在大改动之前马上用它。

1. 打开文档，双击 **3.1 Snapshot Before Apply**（改动前快照）。

它会记录文字的当前状态，好让 3.2 恢复。它还会把高度不够放一行中文的文本框拉高；不处理的话，这些文本框[在改动之后会变空](#frames-empty)。

### 3.2 Repair After Apply {#repair-after-apply}

大改动之后马上用它，前提是你在改动前运行过 3.1。

1. 双击 **3.2 Repair After Apply**（改动后修复）。

它读取 3.1 记录的内容，修复被改动打乱的地方，并写一份检查报告。

## 下一步

[4 后续轮次](/zh/folio/rounds)：你调整过版面之后译文又改了时。

## 常见问题

::: details 我关掉了字体配对面板，什么都没变
不点 **Done** 就关掉面板，不会做任何修改。再运行一次 **2.1 Apply Font Pairing**，最后点 **Done**。
:::

::: details 大改动之后文本框变空了
<a id="frames-empty"></a>

高度不够放一行中文的文本框，在文字重新排版时会变空。撤销这次改动，运行 **3.1 Snapshot Before Apply**（它会先把这些文本框拉高），再做一次改动，然后运行 **3.2 Repair After Apply**。2.2 Apply CJK Styles 会自己做这件事。
:::

::: details 2.3 显示一条提示后停止了
<a id="weight-stopped"></a>

遇到少见或不明确的情况时，它会停下而不是去猜，选区保持原样。每次停止都会写进它的日志。提示会告诉你要改什么。常见的几种：用文字工具选中文字，而不是选中文本框；选中的文字里，中文只用一种字体，拉丁文也只用一种字体；安装它提到的字体，或者选一个已安装的字重。
:::

::: details 2.2 说避头尾（Kinsoku，断行规则）没有生效
<a id="kinsoku-not-applied"></a>

脚本自带的现成中文样式在导入时丢了断行规则，所以行可能会断在不该断的地方。再粘贴一次[安装命令](/zh/guide/install)，选 **Repair**（修复），它会重写脚本的文件，然后再运行一次 2.2。如果提示还会出现，请在 [GitHub](https://github.com/zxa24/creative-script-installer/issues) 上报告。
:::

::: details 技术说明
<a id="apply-font-pairing-details"></a><a id="apply-cjk-styles-details"></a><a id="set-selection-weight-details"></a><a id="repair-cluster-grep-details"></a><a id="convert-underline-to-rule-details"></a><a id="snapshot-before-apply-details"></a><a id="repair-after-apply-details"></a>技术说明只有英文版：[查看](/folio/fonts#apply-font-pairing-details)
:::
