---
title: "翻译一份版面：给设计师"
description: 设计师在 Folio 里的工作，按做事的顺序排列。让文档做好准备，导出文字再导入译文，让新语言看起来对，处理后续轮次，把设置复制到姊妹文档。
# 本页的各节已移到各阶段的页面（2026-10-12）。指向这些 id 的旧链接会转到它们现在所在的页面
# （site.mjs ANCHOR_MOVES；浏览器读的是这张表）。
anchorMoves:
  what-to-do: /zh/folio/export-import
  常见问题: /zh/folio/export-import
  import-stopped: /zh/folio/export-import
  missing-fonts: /zh/folio/export-import
  missing-links: /zh/folio/export-import
  font-has-no-pair: /zh/folio/export-import
  backup-failed: /zh/folio/export-import
  bold-italic-missing: /zh/folio/export-import
  text-too-long: /zh/folio/export-import
  report-and-log: /zh/folio/export-import
  export-translation-package: /zh/folio/export-import
  import-translation-package: /zh/folio/export-import
  next-round: /zh/folio/rounds
---

# 翻译一份版面：给设计师

一份排好版的 InDesign 文档需要另一种语言的版本时，按顺序走完这五个阶段。

**开始之前：** 版面已经定稿，脚本已经[装好](/zh/guide/install)。

1. **[导出之前](/zh/folio/before-export)。** 确认 InDesign 没有报告缺失字体或缺失链接，并保存文档。需要的话，在这里重新链接缺失的图片，或者整理乱成一团的段落样式。
2. **[导出与导入](/zh/folio/export-import)。** 用 **1.1 Export Translation Package** 把文字导出成 zip 发给译者，译者在网页应用里翻译后发回来。然后用 **1.2 Import Translation Package** 把它导入原文档的一份副本，再检查结果。
3. **[让新语言看起来对](/zh/folio/fonts)。** 中文、日文或韩文，运行一次 **2.2 Apply CJK Styles**。其他工具处理新语言和版面相遇时的具体问题。
4. **[后续轮次](/zh/folio/rounds)。** 如果你调整过版面之后译文又改了，就更新你调整过的那份 `.translated.indd`，并标出改了什么。
5. **[姊妹文档](/zh/folio/sister-documents)。** 把调好的段落样式设置复制到姊妹文档，不用手动重做。

::: warning 后续轮次不要导入原文档
那样会从头开始，替换掉你调整过的 `.translated.indd`。导入会先问你，并先存一份备份，但你做过的排版工作就不在译文副本里了。[后续轮次](/zh/folio/rounds#next-round-warning)里写了应该怎么做。
:::
