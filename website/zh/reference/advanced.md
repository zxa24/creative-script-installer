---
title: 高级安装选项
description: 给 IT、脚本化安装和离线安装。安装器的命令行开关与退出码，用 -Source、--source 或 TOOLKIT_SOURCE 从本地副本安装，TOOLKIT_ZIP_URL、TOOLKIT_MANIFEST_URL 和 TOOLKIT_AUTH_TOKEN 覆盖，用 CSI_LOG 或 --log 收集日志，以及分发包是怎么构建的。
---

# 高级安装选项

如果你要替别人安装这些脚本（IT），要从脚本里运行安装器，或者要在没有网络的电脑上安装，看这一页。只是给自己的电脑装，[安装与更新](/zh/guide/install)就够了。

## 不经过菜单运行 {#command-line-flags}

从[分发包](https://github.com/zxa24/creative-script-installer)的副本里运行 `install-update.ps1`（Windows）或 `install-update.sh`（macOS），带上下面一个开关：

| Windows | macOS | 作用 |
| --- | --- | --- |
| `-Install` | `--install` | 跳过菜单，安装或更新。 |
| `-Repair` | `--repair` | 跳过菜单，版本相同也重写文件。 |
| `-Uninstall` | `--uninstall` | 跳过菜单，移除已安装的脚本。 |
| `-Force` | `--force` | 已装版本相同也重装。 |
| `-DryRun` | `--dry-run` | 只探测和校验，不写任何文件。 |
| `-Source <path>` | `--source=<path>` | 从本地副本安装（见[下文](#environment-overrides)）。 |
| `-Log` | `--log` | 把诊断日志存到桌面。 |

macOS 上，开关也可以跟在一行命令后面：`curl … | bash -s -- --uninstall`。Windows 上不行，因为 `irm … | iex` 把脚本当作文本交过去，所以请直接带开关运行 `install-update.ps1`。

<a id="requirements-and-exit-codes"></a>**退出码**，给运行安装器的脚本用：

| 退出码 | 含义 |
| --- | --- |
| 0 | 完成，或无事可做。停下来、留一件事要你先做的（Illustrator 从没启动过、一次性步骤被拒绝），也是 0。 |
| 1 | 有东西失败了，或者什么都装不上。见[出了问题](/zh/guide/install#something-went-wrong)。 |
| 2 | 输入的不是菜单里的选项。见[提示 "Not one of the choices"](#not-one-of-the-choices)。 |
| 3 | 没找到 InDesign 或 Illustrator，或者只找到了 Illustrator、却认不出它的 Scripts 文件夹。见[提示找不到 InDesign 或 Illustrator](/zh/guide/install#not-found) 和[找到了 Illustrator，却找不到它的 Scripts 文件夹](#how-illustrator-s-scripts-folder-is-found)。 |
| 4 | 下载的内容没有通过校验。见[出了问题](/zh/guide/install#something-went-wrong)。 |

## 离线安装，或从自己的副本安装 {#environment-overrides}

1. 在一台能上网的电脑上，从 [GitHub](https://github.com/zxa24/creative-script-installer) 下载分发包（**Code → Download ZIP**）。
2. 把这个 zip 复制到要安装的电脑上，解不解压都可以。
3. 用这份副本作为来源运行安装器：Windows 上 `install-update.ps1 -Source <zip 或文件夹>`，macOS 上 `install-update.sh --source=<zip 或文件夹>`。

也可以不用开关，改设环境变量。直接运行 `install-update.ps1` 或 `install-update.sh` 时，安装器会读这些变量：

| 变量 | 作用 |
| --- | --- |
| `TOOLKIT_SOURCE` | 从本地 `.zip` 或文件夹安装，与 `-Source` / `--source` 相同。 |
| `TOOLKIT_ZIP_URL` | 改从这个地址下载脚本。 |
| `TOOLKIT_MANIFEST_URL` | 改从这个地址读取版本和校验和。 |
| `TOOLKIT_AUTH_TOKEN` | 用于私有源：每次下载都带上 `Authorization: token …` 请求头。 |
| `CSI_LOG` | 设为 `1`，把诊断日志存到桌面（见[下文](#collecting-a-log-when-something-goes-wrong)）。 |

一行命令会忽略这四个 `TOOLKIT_*` 变量（[原因](#toolkit-variable-ignored)）。`CSI_LOG` 在两条路线上都有效。

## 出了问题时收集日志 {#collecting-a-log-when-something-goes-wrong}

普通运行不写日志文件，所以电脑上不会越积越多。出了问题时，再运行一次并要求日志。Windows 上一行命令传不了开关，所以那边用环境变量打开它：

::: code-group

```powershell [Windows]
$env:CSI_LOG='1'; irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

```bash [macOS]
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash -s -- --log
```

:::

日志存在你的**桌面**上，名为 `creative-script-installer-log-<日期>-<时间>.txt`，安装器结束时会打印它的完整路径。每次运行各写一个文件。把这个文件发过来，用完就删掉。失败的运行会自己打印这条命令，没人需要记住它。

## 常见问题

::: details 找到了 Illustrator，却找不到它的 Scripts 文件夹
<a id="how-illustrator-s-scripts-folder-is-found"></a>

提示是 *Found Illustrator, but could not identify its Scripts folder*。Illustrator 在应用程序内部放着一个 Scripts 文件夹，它的名字跟着 Illustrator 的语言走（`Scripts`、`脚本`、`スクリプト`、`Komut Dosyaları` 等等），所以安装器不按名字找。在 Illustrator 使用的语言文件夹里，它找已经装着我们早先安装的 `illustrator-toolkit-stable` 文件夹的那个子文件夹，找不到就找装着 `.jsx` 文件的那个（通常是 Adobe 的三个示例脚本）。如果示例脚本被删了，而我们的东西也还不在那里，就没有一个文件夹符合条件。

解决办法：把任意一个 `.jsx` 文件放回正确的文件夹，或者修复 Illustrator 的安装（这会恢复示例脚本），然后再运行一次安装器。如果电脑上也装了 InDesign，这次运行会装好 InDesign 的脚本、跳过 Illustrator；如果没有，它会以退出码 3 停下。
:::

::: details 某个 `TOOLKIT_` 变量好像没起作用
<a id="toolkit-variable-ignored"></a>

你用的是一行命令。它先从 GitHub 下载分发包，再用这份下载作为来源运行安装器，所以 `TOOLKIT_SOURCE`、`TOOLKIT_ZIP_URL`、`TOOLKIT_MANIFEST_URL` 和 `TOOLKIT_AUTH_TOKEN` 都不会被用到。请改为直接运行 `install-update.ps1` 或 `install-update.sh`。
:::

::: details Windows 上开关不起作用
`irm … | iex` 把脚本当作文本传过去，所以带不了开关。请直接带开关运行 `install-update.ps1`；要日志的话，设 `CSI_LOG`（[做法](#collecting-a-log-when-something-goes-wrong)）。
:::

::: details 提示需要 PowerShell 5 或更新的版本
<a id="needs-powershell-5"></a>

Windows 10 和 11 已经自带。较老的 Windows 上，从微软安装 Windows Management Framework 5.1，然后再运行一次那行命令。
:::

::: details 提示 "Not one of the choices"
<a id="not-one-of-the-choices"></a>

在菜单里输入的不是显示出来的数字，也不是 `q`。什么都没有改动。再运行一次，输入其中一个选项；或者带上 `-Install` / `--install` 这类开关，跳过菜单。
:::

::: details 技术说明
<a id="where-the-installer-fetches-from"></a><a id="update-semantics-restated"></a><a id="building-the-distribution-bundle"></a><a id="shape-of-the-distribution-repository"></a><a id="the-machine-readable-copy-of-this-site"></a>技术说明只有英文版：[查看](/reference/advanced#where-the-installer-fetches-from)
:::
