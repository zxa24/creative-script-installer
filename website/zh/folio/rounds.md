---
title: 后续轮次
description: 设计师的第 4 阶段。你调整过版面之后，客户或审校又改了译文时，更新你调整过的那份翻译文档，而不是从头开始；再用 3.4 Highlight Translation Changes 标出每一个改过的字符，不动文字本身。
---

# 后续轮次

[翻译一份版面：给设计师](/zh/folio/designer)的第 4 阶段。你调整过版面之后，客户或审校又改了译文时，看这一页；想自己看清、或者给审校看清上一轮之后到底改了什么时，也看这一页。

这些是 Creative Script Kit 的免费 InDesign 脚本。用一行命令装一次（[安装](/zh/guide/install)），然后在 Scripts 面板的 **User → indesign-toolkit-stable** 下找到它们（[在哪里找到脚本](/zh/guide/install#where-to-find-the-scripts)）。

## 下一轮修改 {#next-round}

**不要**从原文档重新开始。改为更新翻译后的那份文档：

1. **打开你的 `.translated.indd`**（你调整过的那份），在改动任何东西之前存下基线。双击 **3.4 Highlight Translation Changes**（高亮译文改动），选 **Capture baseline**（存下基线），点 **OK**。页面上看不到任何变化。然后对它运行 **1.1 Export Translation Package**，把新的 zip 发给译者。
2. **译者在网页应用里修改现有译文。** 他们没动的段落会保持原样。
3. **打开同一份 `.translated.indd`**，用新的 zip 运行 **1.2 Import Translation Package**。它直接更新这份文档，不会另建副本。更新前，它会先把上一版存一份到 **script_outputs → backup**（如果这份副本没存成，请看[导入说无法建立安全备份](/zh/folio/export-import#backup-failed)）。
4. **标出并检查改过的段落。** 再运行一次 **3.4 Highlight Translation Changes**，选 **Highlight changes**（高亮改动），从列表里选你存下的那个起点，点 **OK**。如果你只关心措辞，勾选 **Ignore whitespace differences**（忽略空白差异）。你其他的调整都会保留，但在改过的段落里，不换行、字距、手动换行这类手工调整会被清掉，需要在那里重做。
5. **导出最终 PDF 之前删除高亮图层。** 在 Layers 面板（图层面板）里删除名为 **_T_translation_highlights** 的图层。这些标记是普通的页面对象，不删的话会被打印到 PDF 里。

::: warning 后续轮次不要导入原文档
<a id="next-round-warning"></a>那样会从头开始，替换掉你调整过的 `.translated.indd`，没有备份，也没有提醒。你在里面做的所有排版工作都会丢失。
:::

## 3.4 Highlight Translation Changes {#highlight-translation-changes}

需要把改过的文字标出来时用它，比如要把一份 PDF 发回给审校。它有两个选项：**Capture baseline** 存下文字的当前状态，**Highlight changes** 标出与你存下的某个基线相比改了什么。

- 在改动任何东西之前存下基线：第一次导入之后马上存一次，之后每一轮开始时再存一次（见上面第 1 步）。在存下基线之前做的修改，之后无法标出。
- 改过的文字会加一个黄框，删掉文字的地方会有一个红色标记。标记放在单独的图层上，位于文字后面；文字本身完全不会改变。
- 每次运行 **Highlight changes** 都会先清掉旧标记，所以标记不会越积越多。
- 不再需要标记时，在 Layers 面板里删除名为 **_T_translation_highlights** 的图层。这些标记是普通的页面对象，所以会出现在你导出的 PDF 里。

## 下一步

[5 姊妹文档](/zh/folio/sister-documents)：把调好的段落样式设置复制到姊妹文档。

## 常见问题

::: details Highlight changes 不能选
还没有起点。先用 **Capture baseline** 运行一次。
:::

::: details 增加或删除段落会让整份文档都亮起来吗？
不会。段落位置变了时，它按内容而不是按位置去匹配每一段，所以只会标出真正的改动。
:::

::: details 空格和换行也被标出来了
这是默认行为。再运行一次 **Highlight changes**，勾选 **Ignore whitespace differences**。
:::

::: details 技术说明
<a id="highlight-translation-changes-details"></a>技术说明只有英文版：[查看](/folio/rounds#highlight-translation-changes-details)
:::
