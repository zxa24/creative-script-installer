---
title: 高级安装与分发
description: 安装器开关、TOOLKIT_SOURCE / TOOLKIT_ZIP_URL / TOOLKIT_MANIFEST_URL / TOOLKIT_AUTH_TOKEN 环境变量覆盖、离线安装、退出码，以及分发包是怎么产出的。
---

# 高级安装与分发

给打包、再分发或测试这套工具的人。正常安装的设计师请看[安装与更新](/zh/guide/install)。

## 安装器从哪下载

下载源可配置。公开分发仓库是 [github.com/zxa24/creative-script-installer](https://github.com/zxa24/creative-script-installer)；它的坐标在安装脚本顶部 —— Windows PowerShell 脚本里的 `$Owner` / `$Repo` / `$Ref`，macOS shell 脚本里的 `OWNER` / `REPO` / `REF`。

## 环境变量覆盖

不改脚本也能重定向安装器：设环境变量。它们在你**直接**运行 `install-update.sh` / `install-update.ps1` 时生效。一行命令会在读到任何这些变量之前先从 GitHub 下载，然后带着一个明确的本地源交接，所以在那条路线上三个 `TOOLKIT_*` 覆盖不起作用。

| 变量 | 作用 |
| --- | --- |
| `TOOLKIT_SOURCE` | 从本地 `.zip` 或已解压的目录安装。用于离线安装和自测。 |
| `TOOLKIT_ZIP_URL` | 直接覆盖载荷 URL。 |
| `TOOLKIT_MANIFEST_URL` | 直接覆盖 manifest URL。 |
| `TOOLKIT_AUTH_TOKEN` | 私有源的退路：请求带上 `Authorization: token …` 头。 |
| `CSI_LOG` | 设为 `1` 把诊断日志存到桌面。见[收集日志](#出了问题时收集日志)。 |

## 命令行开关

| Windows | macOS | 作用 |
| --- | --- | --- |
| `-Force` | `--force` | 已装版本相同也重装。 |
| `-DryRun` | `--dry-run` | 只探测和校验 —— 不写任何文件。 |
| `-Source <path>` | `--source=<path>` | 从本地源安装。 |
| `-Log` | `--log` | 把诊断日志存到桌面。 |
| `-Install` | `--install` | 跳过菜单；安装或更新。 |
| `-Repair` | `--repair` | 跳过菜单；版本相同也重写文件。 |
| `-Uninstall` | `--uninstall` | 跳过菜单；移除已装的脚本。 |

macOS 上开关可以搭在一行命令上：`curl … | bash -s -- --uninstall`。Windows 上不行 —— `irm … | iex` 把脚本当文本交出去 —— 所以用菜单，或者直接带开关运行 `install-update.ps1`。

## 要求与退出码

Windows 需要 **PowerShell 5 或更新**（Windows 10 和 11 自带；缺失时一行命令会说明并停止）。在 `cmd.exe` 里，双击 `install-update.bat`，或运行 `powershell -NoProfile -Command "irm … | iex"`。

| 退出码 | 含义 |
| --- | --- |
| 0 | 完成，或无事可做。留下一件事要你先做的拒绝（Illustrator 从没启动过、一次性步骤被拒绝）也是 0。 |
| 1 | 有东西失败了，或者什么都装不上。 |
| 2 | 不是菜单里的选项。 |
| 3 | 没找到 InDesign 或 Illustrator 安装。 |
| 4 | 下载未通过校验。 |

## 出了问题时收集日志

安装器在普通运行中**不写日志文件**。机器上什么都不累积，事后也没有文件可找 —— 这正是用意：一份总是被写的日志，是没人读也没人清理的日志。

真出了问题，再跑一次并要求日志。Windows 上一行命令传不了开关 —— `iex` 收到的是文本，不是命令 —— 所以那边用环境变量做开关：

::: code-group

```powershell [Windows]
$env:CSI_LOG='1'; irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

```bash [macOS]
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash -s -- --log
```

:::

日志落在你的**桌面**，名为 `creative-script-installer-log-<日期>-<时间>.txt`，安装器结束时打印完整路径。每次运行各写一个文件，所以没有追加、没有增长。把那个文件发过来；用完删掉。

失败的运行会自己告诉你这条命令，没人需要记住它。

## 构建分发包

在开发仓库里：

```bash
node toolkit_installer/make_dist.mjs
```

它拿 `translation_mvp_uxp/`，遍历整棵树减去一份排除列表，产出可分发的载荷，然后自检 `require` 闭包，确保运行时能到达的东西没有被漏在包外。它产出：

- `dist/toolkit/` —— 装进脚本面板的 InDesign 载荷
- `toolkit.manifest.json` —— 版本加每个文件的 SHA-256
- `toolkit.manifest.sha256` —— `shasum -c` 侧车，macOS 上用来校验
- `dist/illustrator/`、`illustrator.manifest.json`、`illustrator.manifest.sha256` —— Illustrator 载荷的同样三样
- `install.sh`、`install.ps1` —— 一行命令的引导脚本

构建拒绝产出彼此不一致的 manifest 与侧车。

版本号从 `toolkit_installer/VERSION` 读取。

## 分发仓库的形状

分发包 —— 也就是公开分发仓库的内容 —— 长这样：

```text
<仓库根>/
  toolkit/                  ← 装进脚本面板的 InDesign 内容
  toolkit.manifest.json     ← 版本 + 每文件 sha256
  toolkit.manifest.sha256   ← shasum -c 侧车（macOS 校验）
  illustrator/              ← Illustrator 脚本
  illustrator.manifest.json
  illustrator.manifest.sha256
  install.sh                ← 一行命令引导脚本
  install.ps1
  install-update.bat
  install-update.command
  install-update.ps1
  install-update.sh
  README.md
```

## 更新语义，重述

- **InDesign：**整个文件夹**原子**替换：先下载并校验，再换入。`.bak` 文件夹只在换入*期间*存在，作为事务的撤销，新文件夹就位后即删除。它**不是**事后可用的回退副本 —— 残留的副本会在脚本面板里显示成重复的一套脚本，因为 InDesign 递归扫描它。
- **Illustrator：**文件**就地**替换，每个各自原子；没有 `.bak`，也没有整个文件夹换入，因为那需要它外面那个 Adobe 目录的写权限，而安装器没有。见[更新是怎么进行的](/zh/guide/install#更新是怎么进行的)。
- 回退就是重装旧分发包：`--source=/path/to/old-dist`（macOS）或 `-Source C:\path\to\old-dist`（Windows）。留着你当前用的分发包，是唯一的回退路径。
- 对 InDesign，任何一步失败都让现有安装原样不动。对 Illustrator，就地替换中途失败会被报告为失败，下次运行自愈。
- 已是最新时再跑，不写入任何东西。

## Illustrator 的 Scripts 目录是怎么找到的

Illustrator 在应用程序内部每种语言各放一个 Scripts 目录，而目录的**名字是本地化的** —— `Scripts`、`脚本`、`スクリプト`、`Komut Dosyaları` 等等。安装器不匹配名字。在 Illustrator 记录为自己所用的那个语言目录里（见安装页），它找**包含 `.jsx` 文件的那个子目录** —— 通常是 Adobe 的三个示例脚本，或我们早先的一次安装。

这就是唯一已知的失败形态的来源：如果示例脚本被删了、而我们的东西也还没在那里，就没有目录能表明自己的身份，运行会说 *Found Illustrator, but could not identify its Scripts folder* 并以退出码 3 停止。把任何一个 `.jsx` 放回正确的目录 —— 或者修复 Illustrator 安装，那会恢复示例脚本 —— 即可解决。

## 本站的机器可读副本

两个文件由构建这些页面的同一份 Markdown 生成：

| 文件 | 内容 |
| --- | --- |
| `llms.txt` | 本站索引，带绝对链接和一行摘要，遵循 [llms.txt](https://llmstxt.org) 约定。 |
| `llms-full.txt` | 本站每一页的全文，拼接成一份。 |

它们由构建重新生成，不是手工维护的：

```bash
cd website
npm run llms     # 只重新生成
npm run build    # 重新生成，然后构建站点
```

只包含英文页面。
