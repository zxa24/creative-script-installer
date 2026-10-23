---
title: 文件与目录
description: 脚本在你的 InDesign 文档旁边放了什么、为什么。packages 里是 1.1 导出的 zip；script_outputs 里是日志、导入报告、3.4 的基准，以及导入在更新或替换上一版译文文档之前为它做的备份。
---

# 文件与目录

想知道脚本在你的文档旁边放了什么，或者想找上一版译文时，看这一页。

文件夹的顶层是你的。脚本把自己的文件都放在一个文件夹 **script_outputs** 里，你很少需要打开它。

## 文档旁边有什么 {#the-layout}

```text
<你的文件夹>/
  <doc>.indd                你的原文档
  <doc>.translated.indd     译文副本
  packages/                 翻译包 zip
  script_outputs/           脚本自己的文件
    log/                    每次运行一份日志
    backup/                 导入覆盖之前留的副本
    baseline_snapshots/     3.4 存的起点
    writeback_v2_report_<时间>.json
    post_import_check_<时间>.md
```

- **`<doc>.translated.indd`** 是 [1.2 Import Translation Package](/zh/folio/export-import#what-to-do) 第一次导入时在原文档旁边建的副本，[后续轮次](/zh/folio/rounds#next-round)会更新它。它一直用这一个名字，所以 PDF 导出和审阅总是指向同一个文件。原文档不会被改动。
- **packages** 里是 **1.1 Export Translation Package** 每次存下的 zip。每个 zip 都有编号（`V01D_…`、`V03D_…`），按名字排序就是按轮次排序。只有包在设计师和译者之间换手时编号才加一；同一方再导出一次，编号不变。译者发回的 zip（`V02T_…`）也放在这里。
- **script_outputs** 是脚本写给自己的地方：
  - **log**：每次运行发生了什么，一次一个文件。报告问题时发的就是这个文件。
  - **两份报告文件**，直接放在 script_outputs 里：导入做了什么（`.json`），以及要检查哪些地方（`.md`）。每次导入新增一对。
  - **backup**：导入更新或替换之前保存的上一版译文副本（见[下文](#where-to-find-the-previous-version)）。
  - **baseline_snapshots**：[3.4 Highlight Translation Changes](/zh/folio/rounds#highlight-translation-changes) 用来对比的起点。

## 上一版译文在哪里？ {#where-to-find-the-previous-version}

<a id="what-import-does-to-the-previous-output"></a>后续轮次要导入到 `.translated.indd`（[正常做法](/zh/folio/rounds#next-round)）。保存之前，导入会把上一版复制一份放进 **script_outputs → backup**，文件名里带日期和时间。想回到上一版，打开这份副本，或者把它从文件夹里复制出来。如果副本做不出来，导入就完全不保存（[怎么办](/zh/folio/export-import#backup-failed)）。

如果 `.translated.indd` 已经存在，你又对原文档运行了导入，导入会[先问你](/zh/folio/export-import#replace-translated-copy)。如果你选择替换，旧副本也会照样存进 **script_outputs → backup**。

::: warning 再次导入原文档会从头开始
那样你手动做的调整就只留在备份里了。调整过译文副本之后，不要这样做。[后续轮次](/zh/folio/rounds#next-round-warning)说明了应该怎么做。
:::

## 常见问题

::: details 我对译文副本做的调整不见了
多半是把后续轮次导入到了原文档，这会从头开始，替换掉 `.translated.indd`。从 1.2 版起，导入会先问你，并把旧副本存到 **script_outputs → backup**：打开那里最新的一份。1.2 版之前这种情况不留副本，所以那里可能只有更早的版本。下次请[导入到 .translated.indd](/zh/folio/rounds#next-round)。
:::

::: details packages 里只有 .zip，没有文件夹
这是正常的。1.1 先建一个包文件夹，打成 zip，然后删掉文件夹，所以 zip 就是要发出去的那一个文件。如果某个包文件夹旁边没有 zip，说明打包失败了，**script_outputs → log** 里这次导出的日志会说明原因。再运行一次 1.1。
:::

::: details 我以前的翻译包在 script_outputs → package 里
1.1.0 版之前，1.1 把包存在那里。现在它存到文档旁边的 **packages**，取下一个编号时仍会读旧文件夹，所以编号会接着往下排。
:::

::: details zip 旁边有一个名字以 `_unzipped_` 加时间结尾的文件夹
1.2 工作时把 zip 解压到这个文件夹。导入成功后它会删掉这个文件夹；导入[中途停下](/zh/folio/export-import#import-stopped)、被取消或没有保存时，会留下它，方便查看问题。问题解决、重新导入之后，可以把它删掉。
:::

::: details 有一个文件名以 `.translated_` 加一串长数字结尾的文件
这是 1.2 版之前的版本留下的：上一份 `.translated.indd` 当时在 InDesign 里打开着、关不掉，所以导入把结果存成了这个名字。把两份文档都关掉，留下你要的那份，并把它命名为 `<doc>.translated.indd`。从 1.2 版起，遇到这种情况导入会停下，请你先关掉那份副本。
:::

::: details 技术说明
<a id="folders-details"></a><a id="a-change-is-planned-here"></a><a id="retired-convention"></a>技术说明只有英文版：[查看](/guide/folders#folders-details)
:::
