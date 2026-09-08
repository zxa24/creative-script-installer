---
title: 安装与更新
description: 在 Windows 或 macOS 上用一条命令安装并更新 InDesign 与 Illustrator 脚本 —— 怎么打开终端、安装器改了机器上什么、刻意没改什么、Illustrator 需要的那一次管理员步骤、卸载，以及更新出错时怎么回退。
---

# 安装与更新

**一条命令**装好工具，之后再跑一次就是更新。不用手动下载，也不用解压。

不需要 GitHub 账号、git，也不需要管理员密码 —— 只有一个例外：Illustrator，下文会解释，它只问一次。

## 安装

### macOS

**打开终端。** 按 <kbd>Cmd</kbd> + <kbd>Space</kbd>，输入 `Terminal`，回车。（它也在「应用程序 → 实用工具」里。）

粘贴这一行并回车：

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
```

### Windows

**打开 PowerShell。** 按 <kbd>Windows</kbd> 键，输入 `PowerShell`，回车。（或者右键「开始」按钮，选**终端**。）

粘贴这一行并回车：

```powershell
irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
```

### 然后

安装器会打印它找到了什么、做了什么，如果装了东西，结尾会给出下一步的链接。**重启 InDesign**（用 Illustrator 的话也重启它）—— 两个应用都在启动时构建脚本菜单，不重启什么都不会出现。

两个应用都需要**至少启动过一次**：它们的脚本目录是首次启动时创建的，安装器正是靠这些目录找到它们。

- InDesign：`窗口 → 实用程序 → 脚本`，然后是 **indesign-toolkit-stable** 文件夹。
- Illustrator：`文件 → 脚本`，然后是 **illustrator-toolkit-stable**。

::: tip 更新用的是同一条命令
想要最新版本，再跑一次同一行。已经是最新的话它会说明，且不写入任何东西。
:::

## 菜单

在终端里运行时，安装器会显示找到了什么，并只提供适用的选项 —— **Install**、**Update**、**Repair**（版本相同也重写文件）或 **Uninstall**，以及 `q` 什么都不改地退出。回车取合理的默认项；当一切都已是最新时没有默认项，因为剩下的选项都会改动东西。

Uninstall 就在这个菜单里。macOS 上也可以不走菜单：

```bash
curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash -s -- --uninstall
```

Windows 的一行命令形式**传不了参数** —— `iex` 收到的是文本，不是命令 —— 所以那边请用菜单。完全没有终端时（脚本、部署工具）它不会问：直接安装。

## 它改了机器上什么

只有这些文件夹：

| | |
| --- | --- |
| InDesign 脚本 | `%APPDATA%\Adobe\InDesign\…\Scripts Panel\indesign-toolkit-stable\` · `~/Library/Preferences/Adobe InDesign/…/Scripts Panel/indesign-toolkit-stable/` |
| Illustrator 脚本 | Illustrator 自己的 Scripts 目录里一个名为 `illustrator-toolkit-stable` 的文件夹 |

外加**一个权限**，且仅当你用 Illustrator：它在那里创建的文件夹会被设为你可写 —— macOS 上是 `chown`，Windows 上是一条访问控制条目。只作用于那一个文件夹，不作用于它外面 Illustrator 的 Scripts 目录。

**别的什么都不改。** 不进「系统设置」或 Windows 设置，没有登录项，不改 `PATH`，不写注册表，不建计划任务，不 `defaults write`，不改 InDesign 或 Illustrator 的任何偏好。卸载会移除它写入的东西 —— Windows 上直接移除；macOS 上它会问一个问题，见[卸载](#卸载)。

两件做这类脚本时常被要求改、而这里**不必**改的事：

- **Windows：PowerShell 执行策略。** `iex` 求值的是文本，而策略管的是脚本*文件*，所以这条命令在 `Restricted` 下也能跑 —— 实测过，不是推断。你不需要 `Set-ExecutionPolicy`。
- **macOS：Gatekeeper。** 这条路线上没有任何东西被当作应用程序下载并打开，所以不会有「未识别的开发者」对话框要放行。

::: warning 公司管控的电脑仍可能拒绝
如果组策略设定了执行策略，它会盖过安装器自己的 `-ExecutionPolicy Bypass`，运行会失败。那是策略层面的拦截；工具不能、也不该绕过。请联系 IT。
:::

## Illustrator 会要一次你的密码

InDesign 把脚本面板目录放在你自己的用户文件夹里，装进去不需要任何权限。**Illustrator 把 Scripts 目录放在应用程序内部**，你写不进去 —— 而且没有用户级的替代位置；Illustrator 只读那一个目录。

所以 Illustrator 的首次安装需要**一次管理员步骤，仅一次**。安装器会说明它将创建什么，然后询问 —— macOS 上你在同一个窗口里输入密码，Windows 上批准 Windows 弹出的提示。它给你的是应用程序内部一个属于你的文件夹；不会打开其余部分。此后每次安装和更新都不需要密码。

如果根本不需要密码 —— macOS 还记着你几分钟前的 `sudo`，或者 Windows 上 PowerShell 本身已经以管理员身份运行 —— 它既不解释也不问。没有什么可提醒你的，这一步就静默通过。（普通 PowerShell 窗口里的管理员*账户*不算这种情况；Windows 照样会弹提示。）

说「否」是一个回答，不是失败：运行会继续做其余的事，并在末尾打印精确的命令，你想什么时候跑都行。安装器本身从不以管理员身份运行 —— 被提权的只有那条创建文件夹的命令。

::: warning Illustrator 升级会把它抹掉
升级 Illustrator 会替换整个应用程序，那个文件夹随之消失。之后再跑一次同一条命令，然后运行安装器。
:::

如果 Illustrator **从没启动过**，它就没有记录过语言，安装器无法判断它读的是众多语言目录中的哪一个。它会说明，并且不为 Illustrator 安装任何东西：启动一次 Illustrator，再跑一遍。安装器早先做过的安装，无论记录的语言是什么，总能被再次找到用于更新和卸载。如果 Illustrator 记录了不止一种语言，脚本会为每一种都装上，运行时会说明是哪几种。

## 卸载

`Uninstall` 从两个应用中移除脚本。Illustrator 那个文件夹的去向因平台而异，也只有它不同：

- **Windows：**文件夹随脚本一起消失。它被授予的权限包含删除它自身的权利，所以不需要管理员步骤，权限也随文件夹一起消失。
- **macOS：**删除文件夹需要与创建它相同的权限，所以安装器会问一次 —— *Remove both? That needs your password once.* —— 然后把文件夹和权限一起拿走。说「否」的话空文件夹留下，运行会说明。

在两个平台上，一个仍装着安装器没放进去的文件的文件夹都会被留着不动，运行也会说明。

## 没有终端时

仓库里也带着 **`install-update.bat`**（Windows）和 **`install-update.command`**（macOS），给不方便粘贴命令的机器，或者从 U 盘上的副本安装。把[仓库](https://github.com/zxa24/creative-script-installer)下载为 ZIP，解压，双击对应平台的那个。它安装的是**它所在的那份副本** —— 这正是这条路线的意义 —— 所以要更新就重新下载。

这条路线会遇到操作系统对未签名文件的警告，上面那条命令则不会。

**Windows — SmartScreen。** 双击 `.bat` 时会出现一个蓝色的「Windows 已保护你的电脑」框。点**更多信息 → 仍要运行**。如果文件是通过邮件或网盘来的，Windows 还会把它们标记为来自互联网：右键文件 → **属性** → 勾选**解除锁定**。

**macOS — Gatekeeper。** macOS 会说文件「无法打开，因为它来自身份不明的开发者」。右键（或按住 Control 点击）文件 → **打开** → 在对话框里再点**打开**。一次就够。如果它说 `.command` 不可执行，对它跑一次 `chmod +x`。

这些出现是因为文件没有用付费证书签名。这是正常的，也正是本页顶部那条命令值得优先选用的原因：那条路上没有任何东西被当作应用程序下载并打开。

## 装了什么、装在哪

安装器检测机器上每一个已装的 InDesign 版本，每个版本装一份。Illustrator 得到一个文件夹，放在 Illustrator 自己正在使用的那个语言目录里 —— 它只读其中一个，读哪个是从 Illustrator 自己的设置里读出来的，不是猜的。

| 平台 | 安装路径 |
| --- | --- |
| Windows | `%APPDATA%\Adobe\InDesign\Version <N>\<language>\Scripts\Scripts Panel\indesign-toolkit-stable\` |
| macOS | `~/Library/Preferences/Adobe InDesign/Version <N>/<language>/Scripts/Scripts Panel/indesign-toolkit-stable/` |

在脚本面板里你打开的就是那个文件夹 —— **indesign-toolkit-stable** —— 编号脚本在里面。

::: tip 如果你也在开发这些脚本
`-stable` 后缀让一份安装不会和指向工作副本的链接撞名，两者可以同时待在面板里。后缀放在安装器这一侧是有意的：在那里定的名字会自动应用到每台机器；若要在每台开发机上改名，冲突就会在没轮到的每台机器上继续存在。

如果面板里有一个普通的 `indesign-toolkit` 文件夹，安装器只在它确实是自己早先的安装时才移除 —— 靠它写下的版本标记辨认。链接，或者别人放在那里的文件夹，都会被留着不动。

如果 `-stable` 这个名字本身就是一个链接 —— 指向工作树的开发桥接 —— 安装器会拒绝写入并说明，因为一次替换掉它的安装看起来成功了，实际却删掉了你的链接。把链接改名或移除，再跑一次。
:::

它安装的内容：

- **只有脚本** —— `.idjs` 文件加上它们的 `lib/` 目录。
- 它**不是** UXP 插件，也不改 InDesign 的任何其他设置。

## 更新是怎么进行的

- 一切都**先下载并做校验和验证**。整个载荷验证完成之前，什么都不写。
- **InDesign：**更新是**整个文件夹的原子替换**。任何一步失败，什么都不改 —— 不存在装了一半的状态；换入本身出错的话，旧文件夹会被放回去。
- **Illustrator：**文件**就地**替换，每个文件各自原子。那里做不到整个文件夹换入：那需要它外面那个 Adobe 目录的写权限，而安装器刻意不拥有。每个文件先在旁边暂存，再改名，所以文件夹里新旧混杂的窗口已缩到这个权限模型允许的最小 —— 但它不是 InDesign 那条路的同等保证，也不宣称是。更新还会从那个文件夹里移除旧版本发过、新版本不再发的脚本 —— 否则改过名的脚本会出现两次 —— 并为此把文件夹里的每个 `.jsx` 都视为它自己的。你放进去的其他类型文件，更新和卸载都不会动。
- **成功的更新不会留下旧版本。** 安装器在换入时确实会保留一份临时副本，但新文件夹就位后就删掉它：InDesign 会递归扫描脚本面板，残留的副本会显示成重复的一套脚本。

::: warning 回退等于重装
成功更新后没有 `.bak` 文件夹可以回退。要退回去，就把旧版本再装一次 —— 留着你当时用的那份分发包，用 `--source`（macOS）或 `-Source`（Windows）指给安装器。见[高级](/zh/reference/advanced)。
:::
- **再跑一次是安全的。** 已经是最新版本时它不写入任何东西。

## 出了问题

安装器不保留日志文件。如果某次运行失败，它会打印出那条既能再跑一次*又*能把日志存到桌面的命令 —— 跑它，把它指出的文件发过来。那条命令在[收集日志](/zh/reference/advanced#出了问题时收集日志)。

## 下一步

- [正常流程](/zh/guide/workflow) —— 日常工作跑什么。
- [全部脚本](/zh/scripts/) —— 编号索引。
- [高级安装与分发](/zh/reference/advanced) —— 安装器开关、替代源、离线安装。
