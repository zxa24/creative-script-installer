---
title: 导出与导入
description: 设计师的第 2 阶段。用 1.1 Export Translation Package 把排好版的 InDesign 文档的文字导出成 zip，发给译者，拿回来，用 1.2 Import Translation Package 导入原文档的一份副本，再检查结果。
---

# 导出与导入

[翻译一份版面：给设计师](/zh/folio/designer)的第 2 阶段。文档[可以导出](/zh/folio/before-export)之后做这一步。

## 要做什么 {#what-to-do}

1. **导出文字。** 打开文档。在 **Scripts** 面板（脚本面板）里双击 **1.1 Export Translation Package**（导出翻译包）。对话框会问 **Source language**（这份文档的语言）和 **Target language**（要翻译成的语言）。两项都设好，点 **OK**。文档旁边的 **packages** 文件夹里会出现一个 `.zip` 文件。
   <!-- screenshot: export dialog -->
2. **把 zip 发给译者**，附上这个链接：[在网页里翻译](/zh/folio/translator)。告诉译者目标语言，以及能不能使用网页应用里的 **Auto Translate**（自动翻译，它会把文字发给 Google）。
3. **从译者那里拿回翻译好的 zip。**
4. **导入译文。** 第一次导入时，打开**原**文档（不是文件名以 `.translated` 结尾的那份）。双击 **1.2 Import Translation Package**（导入翻译包），选择翻译好的 zip。如果 InDesign 问到[缺失字体](#missing-fonts)或[缺失链接](#missing-links)，就在这时处理；之后它会自己跑完。
   <!-- screenshot: choosing the zip -->
5. **检查结果。** 一份名为 `<你的文档>.translated.indd` 的新文档会打开。原文档没有改动。如果有要处理的地方，会弹出一个窗口，逐处列出它们和所在的页：**Show**（显示）带你过去，**How to fix**（怎么改）给出步骤（[详见](#end-window)）。即便如此，每一页也都看一遍，尤其注意[文字太长、文本框放不下](#text-too-long)的地方。粗体和斜体只出现在[译者标注过的地方](#bold-italic-missing)。

## 下一步

[3 让新语言看起来对](/zh/folio/fonts)。中文、日文或韩文，运行一次 **2.2 Apply CJK Styles**。

## 常见问题

::: details 导入拒绝运行
你打开的文档看起来是一份翻译后的副本（文件名以 `.translated`、`.aborted` 或 `.BLOCKED` 结尾），但它没有之前导入的记录，所以导入无法更新它。第一次导入请改为打开原文档。[后续轮次](/zh/folio/rounds#next-round)请打开导入生成的那份 `.translated.indd`。
:::

::: details 导入结束后弹出一个窗口，列出要处理的地方
<a id="end-window"></a>

只有在有地方需要你处理时，导入才会打开这个窗口。它按问题分组，说明每种问题意味着什么、该怎么做，并逐处列出所在的页和那段文字的开头。

- **Show**（显示）翻到那一页，选中那个文本框或段落。窗口不会关，所以你可以一处一处往下看。
- **How to fix**（怎么改）：有这个按钮的问题，点它会在窗口里展开步骤，并给出本站对应章节的网址，可以复制到浏览器里打开。
- **Open report**（打开报告）显示完整报告存在哪里，路径可以复制。
- **Done**（完成）关闭窗口。

没有「已处理」的勾选框。把这些地方改好，再导入一次：改好的地方就不会再出现。如果导入没发现要处理的地方，就不会弹出窗口。
:::

::: details 导入问要不要替换翻译副本
<a id="replace-translated-copy"></a>

你对原文档运行了导入，而 `.translated.indd` 已经存在。从原文档导入会从头开始，你在那份副本里手动做的排版调整都会丢失。

- 想更新那份副本：点 **Cancel**（取消，什么都不会改），然后[打开 `.translated.indd`，在那里导入](/zh/folio/rounds#next-round)。
- 想从头开始：点 **Replace it**（替换）。导入会先把旧副本备份到 **script_outputs → backup**。备份做不出来时，副本不会被替换。

如果翻译副本开着并且有未保存的修改，或者关不掉，导入会停下，什么都不改。保存或关闭那份副本，然后再运行一次导入。
:::

::: details 导入中途停了
<a id="import-stopped"></a>

大多数问题不会让它停下：找不到的段落保留原文，并列在报告里。会让它停下的情况有两种：中文、日文或韩文会落到一个没有配对的字体上，以及写入时出错。第一次导入时，它随后会删掉做了一半的翻译副本（如果它替换过一份更早的副本，那份在 **script_outputs → backup** 里）；在[后续轮次](/zh/folio/rounds#next-round)里，它会让 `.translated.indd` 保持打开、不保存。修好它报告的问题，用同样的方式再运行一次（第一次导入从原文档运行，后续轮次从 `.translated.indd` 运行）。完整列表在它的[报告](#report-and-log)里。它会报告的问题包括[缺失字体](#missing-fonts)、[缺失链接](#missing-links)和[字体没有配对](#font-has-no-pair)。
:::

::: details InDesign 提示字体缺失
<a id="missing-fonts"></a>

导入之前在原文档里修好，这样翻译副本打开时字体就是齐的。在 InDesign 的 **Missing Fonts**（缺失字体）对话框里，Adobe Fonts 有的字体点 **Add**（添加）。其他字体装到你的电脑上，或者选择 **Type → Find/Replace Font**（文字 → 查找/替换字体）换成你有的字体。如果对话框在 **1.2 Import Translation Package** 运行时出现，那是导入唯一一次让 InDesign 发问，你在那里的选择会用于整次运行。
:::

::: details InDesign 提示链接缺失
<a id="missing-links"></a>

导入之前在原文档里重新链接并保存；翻译副本是从保存的文件做出来的。[3.3 Relink Missing Links](/zh/folio/before-export#relink-missing-links) 会在文档所在文件夹里的任何位置查找同名文件。其余的手动重新链接：选择 **Window → Links**（窗口 → 链接），选中带红色问号的链接，点 **Relink**（重新链接）按钮。如果导入时 InDesign 问到链接，事后在翻译副本里用同样的方法重新链接；副本和原文档保存在同一个文件夹里。
:::

::: details 导入停了，因为某个字体没有配对
<a id="font-has-no-pair"></a>

中文、日文或韩文本来会用一个没有这些字符的字体排出来，显示成空白方框，所以导入停了。提示里写着是哪个字体。对同一份文档再运行一次导入，字体配对面板打开时，为那个字体选一个配对字体。
:::

::: details 导入说无法建立安全备份
<a id="backup-failed"></a>

这可能发生在[后续轮次](/zh/folio/rounds#next-round)里。磁盘上的文件没有被覆盖，但打开的文档里已经是新译文，而且没有保存。不要用原来的名字保存：那会在没有备份的情况下覆盖文件。想留下这个结果，就用 **File → Save As**（文件 → 存储为）换个新名字；不想要，就关闭文档、不保存。确认文档旁边的文件夹可以写入，然后再运行一次导入。
:::

::: details 有些粗体或斜体没有带过来
<a id="bold-italic-missing"></a>

Folio 只应用译者在网页应用里标注过的格式。请译者[标注出来](/zh/folio/translator#source-has-bold)，或者在 InDesign 里手动设置。中文和拉丁文混排的文字要加粗时，[2.3 Set Selection Weight](/zh/folio/fonts#set-selection-weight) 会为每一部分挑对字体。
:::

::: details 文字太长，文本框放不下
<a id="text-too-long"></a>

文字放不下的文本框右下角会显示一个红色加号，**Window → Output → Preflight**（窗口 → 输出 → 印前检查）会把它们全部列出来。导入也会检查这一点，并在[结束时的窗口](#end-window)里逐个列出这些文本框，点 **Show** 就会选中它。把文本框拉大，稍微收紧字距，或者请译者换个短一点的说法。
:::

::: details 新语言看起来不对
请看[3 让新语言看起来对](/zh/folio/fonts)：那里有跨语言配字体、中文排版、大改动时保护版面的工具。每个脚本都列在[全部脚本](/zh/scripts/)里。
:::

::: details 上一版翻译文档在哪里？
在[后续轮次](/zh/folio/rounds#next-round)里更新 `.translated.indd` 时，上一版会先存到 **script_outputs → backup**。如果你再次导入原文档，并选择[替换翻译副本](#replace-translated-copy)，旧副本也会存到那里。1.2 版之前，这种替换不留副本。
:::

::: details 报告和日志在哪里？
<a id="report-and-log"></a>

在文档旁边的 **script_outputs** 文件夹里。发生了什么的报告直接放在这个文件夹里（文件名以 `post_import_check_` 开头，后面是日期）；整次运行的完整记录在它的 **log** 文件夹里。
:::

::: details 技术说明
<a id="export-translation-package"></a><a id="import-translation-package"></a>技术说明只有英文版：[查看](/folio/export-import#export-translation-package)
:::
