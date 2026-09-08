---
title: 第 1 组 — 工作流
description: 1.1 Export Translation Package 与 1.2 Import Translation Package —— 组成正常翻译流程的两个脚本。
---

# 第 1 组 — 工作流

**这就是正常流程。** 日常工作里你跑 `1.1`，把包送出去，包回来时跑 `1.2`。其他都不是步骤。

含译者那一半的完整走一遍，见[正常流程](/zh/guide/workflow)。

## 1.1 Export Translation Package {#export-translation-package}

*源文件：`export_translation_package.idjs`*

**从打开的文档导出一个离线翻译包。**

打开源 `.indd` 后运行。它在这里写出一个包文件夹：

```text
<工作目录>/script_outputs/package/<doc>_translation_package_<timestamp>/
```

包里除其他文件外还有：

| 文件 | 是什么 |
| --- | --- |
| `preview.pdf` | 文档当前状态的 PDF，作为给译者的视觉参考。 |
| `segments.json` | 每一个可翻译的段，带身份与上下文。 |
| `translations_template.json` | 空着的目标语一侧 —— 要填的就是它。 |
| `tid_map.json` | 段 id ↔ 文档位置的映射，用来把文字放回去。 |
| `<doc>.idml` | 文档的一份 IDML 副本，随包携带。 |
| `manifest.json` | 包里有什么，用于往返完整性。 |
| `emphasis_report.json` | 源文里发现了哪些强调（粗体 / 斜体 / 颜色）。 |
| `import_state.json` | 对应的导入运行会读回的状态。 |

### 备注

- 导出会先打开一个对话框，让你确认导出什么、导到哪。
- 日志落在 `script_outputs/log/`。

## 1.2 Import Translation Package {#import-translation-package}

*源文件：`import_integrated.idjs`*

**把翻译好的包读回源文档的一份新副本。**

给它返回的 `translations.json` 或包的 `.zip` 都行 —— `.zip` 会替你解压，里面的 `translations.json` 会自动找到。

运行按顺序做的事：

1. **复制，不编辑。** 源文档以只读方式打开并复制为 `<doc>.translated.indd`，然后打开副本作为工作文档。源文档永远不会被写入。
2. **一个交互时刻。** 工作文档可见地打开，让你一次性、提前处理缺失的字体或链接。之后流程不再提示地运行。
3. 版式状态的**预检快照**。
4. **分析** —— 建立样式计划、定位每一个段、跑预检。
5. **闸门** —— 预检发现阻断性问题的话，运行在这里停下。
6. **提交** —— 写入译文并应用样式计划。
7. **后检** —— 检查溢流文本、样式应用失败、混合文本串。
8. **修复** —— 对后检发现的问题跑一轮修复。
9. **保存** —— 工作文档就地保存并留在屏幕上。

如果运行失败，工作文档被关闭，写了一半的 `.translated.indd` 被删除。没有半成品输出。

### 为什么是单个打开的文档

整个流程发生在一个打开的文档、一个字体解析状态里。早期的设计在各阶段之间保存、关闭、重开；那导致重排结果分歧，因为字体在流程中被静默替换，又在重开后由用户确认 —— 修复轮明明没记到任何溢流，重开后框却溢了。

### 护栏

- **它拒绝往上一份输出里导入。** 如果当前文档名带 `.translated`、`.aborted` 或 `.BLOCKED` 且没有导入状态标签，运行中止。往输出里导入会把流程套两遍，级联成 `<doc>.translated.translated.indd`。请打开原始 `.indd`。
- **后检结果不改文件名。** 后检统计留在 `report.json` 里，从不改变文件名后缀。后检通过不证明结果可接受，后检失败也不意味着结果不可用 —— 两种都需要人看一眼。
- 如果上一次运行的 `.translated.indd` 仍在 InDesign 里打开着，新输出的名字会加上时间戳，而不是去抢那个文件。

### 备注

- 报告落在 `script_outputs/report/`，日志在 `script_outputs/log/`。
- 上一份输出的去向见[文件与目录](/zh/guide/folders)。
