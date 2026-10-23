---
title: "在网页里翻译：给译者"
description: 给译者的分步说明。在 Folio 网页应用里打开设计师发来的 zip，在每段原文旁边输入译文，需要的地方标注粗体或斜体，保存翻译包 zip 并发回。什么都不用装。
---

# 在网页里翻译：给译者

设计师发给你一个 Folio `.zip` 文件时，按这些步骤做。你在浏览器里工作，什么都不用装。

zip 在你的浏览器里打开，不会上传到任何地方。唯一的例外是 **Auto Translate**（自动翻译），它会把文字发给 Google。

网页应用的界面只有英文，下文的按钮名照屏幕上的写法保留英文。

## 要做什么

1. **打开网页应用：** [zxa24.github.io/app-folio](https://zxa24.github.io/app-folio/)。
2. **点 Open Package ZIP**（打开翻译包 zip），选择设计师发来的 zip。会打开一个名为 *Review project metadata*（检查项目信息）的窗口。**Project name**（项目名称）不能为空，**Source language**（原文语言）和 **Target language**（译文语言）要和这份工作一致。如果 **Translator**（译者）一栏还没有你的名字，填上。然后点 **Next**。必填项留空的话，你保存的 zip 里不会包含这些项目信息，保存时会有警告提示你（[怎么办](#project-details-missing)）。
   <!-- screenshot: Open Package ZIP and the project details window -->
3. **翻译。** 右边每个段落是一张卡片，有 **Source**（原文）和 **Target**（译文）两个框。在 **Target** 里输入译文。按 <kbd>Enter</kbd> 跳到下一段。左边是页面排出来的样子，你的译文已经放在里面。用下方的 **Prev** 和 **Next** 翻页。
   <!-- screenshot: a card with Source and Target, the page preview on the left -->

   ::: warning 敏感内容
   顶部有一个 **Auto Translate** 按钮，可以填入机器翻译的初稿。它会把文字发给 Google 翻译。如果文档含有敏感或保密信息，不要使用它。
   :::
4. **粗体和斜体要你自己标。** 格式不会自动从原文复制过来。**Source** 里有粗体或斜体的地方（黄色标记），在 **Target** 里选中对应的词并标注（<kbd>Ctrl</kbd>+<kbd>B</kbd> 粗体，<kbd>Ctrl</kbd>+<kbd>I</kbd> 斜体），或者点黄色标记，用 **Apply to target selection**（应用到译文选区）。你没标的地方都会是普通文字。**Target** 框里始终是纯文本；真正的样子显示在左边的页面上。
5. **点 Save Package ZIP**（保存翻译包 zip），再点 **Download**（下载）。把下载的 zip（文件名以 `V` 开头，以 `_translated_<日期>.zip` 结尾）发回给设计师。

你要做的就是这些。本站其余部分是给设计师看的。如果设计师之后又发来一个 zip，用同样的方法打开。

## 常见问题

::: details 关掉浏览器会丢失我的工作吗？
你的修改在输入时就存在这个浏览器里。在同一个浏览器里再次打开同一个 zip，修改就会回来。它们不会存到别的地方，所以你能发出去的只有 **Save Package ZIP** 保存的 zip。换电脑或换浏览器之前，先保存它。
:::

::: details 它能帮我翻译吗？
顶部的 **Auto Translate** 会用 Google 翻译的初稿填满每一个空段落。它会把原文发给 Google：**如果文档含有敏感或保密信息，不要使用它。** 用完之后每一段都要检查。除非你在它的设置里选择覆盖，否则它不会覆盖你已经输入的文字。
:::

::: details Target 框里有些文字是灰色的，或者被锁住了
设计师发来一份已经翻译过的文档时，每张卡片一开始会用灰色显示当前的译文。只改需要改的地方，不要整段重新输入。你保持灰色的卡片，在版面里会原样不动。你在卡片上加上、改动或去掉粗体、斜体，版面也会跟着改。**Reset**（重置）可以把一张卡片恢复成灰色文字。被锁住的卡片属于它前面那一段（去改那一段），或者本来就不需要翻译。
:::

::: details 卡片提示控制标记（control tokens）有问题
有些段落里有必须保留在译文里的标记（比如页码）。如果你删掉了一个，点那张卡片上的 **Restore Deleted**（恢复已删除）。
:::

::: details 保存时警告项目信息没有包含进去
<a id="project-details-missing"></a>

有一个必填的项目信息是空的：**Project name**、**Source language** 或 **Target language**。在 **Project** 标签页里填上，或者在点 **Save Package ZIP** 时打开的窗口里填上，然后再保存一次，把新的 zip 发出去。
:::

::: details 原文里有粗体或斜体的词
<a id="source-has-bold"></a>

它们在 **Source** 一栏里用黄色标出。点一个标记，用 **Apply to target selection**，就能把同样的格式套到你在 **Target** 里选中的词上。你没标的格式不会加到译文里。
:::

::: details 页面预览里的译文看起来太小
预览会把长文字缩小，让它放进自己的框里。左边的文字被缩小，说明译文对这个版面可能太长了；设计师导入时会看到（[设计师怎么处理](/zh/folio/export-import#text-too-long)）。
:::

::: details 提示说这个包已经在另一个标签页里打开
一个包只用一个标签页。在你想继续工作的那个标签页里点 **Take over editing here**（在这里接手编辑）。
:::

::: details 技术说明
技术说明只有英文版：[查看](/folio/translator)
:::
