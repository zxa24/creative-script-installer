---
title: 安装与更新
description: 在 Mac 或 Windows 电脑上，把一行命令粘贴到终端里，就能装好 InDesign 与 Illustrator 脚本，然后在 InDesign 和 Illustrator 里找到它们。更新和卸载用的也是同一行。
---

# 安装与更新

第一次在一台电脑上装这些脚本时，或者想要最新版本时，看这一页。

你只需要把一行命令粘贴到终端里。不用手动下载任何东西，也不需要账号。唯一的例外是 Illustrator，它会请你授权一次（见[下文](#it-asks-for-my-password)）。

开始之前，先打开一次 InDesign（用 Illustrator 的话也打开一次），然后退出。安装器靠它们第一次打开时创建的文件夹来找到它们。

## 在 Mac 上

1. **打开 Terminal（终端）。** 按 <kbd>Cmd</kbd> + <kbd>Space</kbd>，输入 `Terminal`，按 <kbd>Return</kbd>。
   <!-- screenshot: Spotlight with "Terminal" typed -->
2. **复制下面这一行，粘贴到 Terminal 里，按 <kbd>Return</kbd>。** 复制的方法：把鼠标移到框上，点右侧出现的复制按钮；或者选中整行，按 <kbd>Cmd</kbd>+<kbd>C</kbd>。在 Terminal 窗口里点一下，按 <kbd>Cmd</kbd>+<kbd>V</kbd> 粘贴。

   ```bash
   curl -fsSL https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.sh | bash
   ```

3. **再按一次 <kbd>Return</kbd>**，选择 **Install**（安装）。安装器会列出它在你的 Mac 上找到了什么，以及接下来要做什么。
   <!-- screenshot: the installer menu with Install highlighted -->
4. **只有 Illustrator 需要，而且只有第一次：** 它会问 *Continue? [y/n]*。按 <kbd>Return</kbd>。如果接着要你输入密码，就输入你登录这台 Mac 用的密码（不是 Adobe 密码）。输入时屏幕上什么都不显示，输完按 <kbd>Return</kbd>。
5. **等最后一行出现。** 安装成功时，最后一行以 **Installed v** 加版本号开头，并告诉你要重启哪些应用。之后可以关掉 Terminal 窗口。如果结尾是别的内容，请看[出错了](#something-went-wrong)。
6. **重启 InDesign 和 Illustrator。** 它们只在启动时查找新脚本。

## 在 Windows 上

1. **打开 PowerShell。** 按 <kbd>Windows</kbd> 键，输入 `PowerShell`，按 <kbd>Enter</kbd>。
   <!-- screenshot: Start menu with "PowerShell" typed -->
2. **复制下面这一行，粘贴到 PowerShell 里，按 <kbd>Enter</kbd>。** 复制的方法：把鼠标移到框上，点右侧出现的复制按钮；或者选中整行，按 <kbd>Ctrl</kbd>+<kbd>C</kbd>。在 PowerShell 窗口里点一下，按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 或点右键粘贴。

   ```powershell
   irm https://raw.githubusercontent.com/zxa24/creative-script-installer/main/install.ps1 | iex
   ```

3. **再按一次 <kbd>Enter</kbd>**，选择 **Install**（安装）。
   <!-- screenshot: the installer menu with Install highlighted -->
4. **只有 Illustrator 需要，而且只有第一次：** 它会问 *Continue? [y/n]*。按 <kbd>Enter</kbd>。Windows 随后弹出一个授权提示，点 **Yes**（是）。整个过程不涉及 Adobe 密码。
5. **等最后一行出现。** 安装成功时，最后一行以 **Installed v** 加版本号开头，并告诉你要重启哪些应用。之后可以关掉 PowerShell 窗口。如果结尾是别的内容，请看[出错了](#something-went-wrong)。
6. **重启 InDesign 和 Illustrator。**

如果脚本本来就是最新的，最后一行会是 **Already up to date**（已是最新），什么都没有改动。

## 在哪里找到脚本 {#where-to-find-the-scripts}

- **InDesign：** 选择 **Window → Utilities → Scripts**（窗口 → 实用程序 → 脚本）。在 Scripts 面板里打开 **User**，再打开 **indesign-toolkit-stable**。Creative Script Kit 的 InDesign 脚本就在这个文件夹里。双击一个脚本即可运行。
  <!-- screenshot: Scripts panel with the folder open -->
- **Illustrator：** 选择 **File → Scripts → illustrator-toolkit-stable**（文件 → 脚本），再选一个脚本。
  <!-- screenshot: File > Scripts menu -->

要**更新**，再粘贴同一行，选 **Update**。要**卸载**，粘贴同一行，选 **Uninstall**。

## 接下来 {#next}

[Folio：翻译一份版面](/zh/folio/) · [更多工具](/zh/tools/) · [全部脚本](/zh/scripts/)

## 常见问题

::: details 它要我输入密码
<a id="it-asks-for-my-password"></a>

这是 Illustrator 的需要，只有一次。Illustrator 只从应用程序内部的一个文件夹读取脚本，而你的账户没有那里的写入权限。安装器请求一次授权，在那里建一个属于你的文件夹。在 Mac 上，它要的是你登录这台 Mac 的密码；在 Windows 上，Windows 弹出授权提示，你点 **Yes**。它从来不是 Adobe 密码。之后的安装和更新都不会再问。

如果你拒绝，其余部分照样会装好，安装器会打印出一行命令，等你准备好了再运行。

升级 Illustrator 到新版本时，这个文件夹会随旧版本一起被删掉。升级后再粘贴一次安装命令即可。
:::

::: details 脚本没有出现
- 重启 InDesign 或 Illustrator。它们只在启动时查找脚本。
- 如果安装器说找不到 InDesign 或 Illustrator，请看[它说找不到 InDesign 或 Illustrator](#not-found)。
:::

::: details 它说找不到 InDesign 或 Illustrator
<a id="not-found"></a>

安装器靠应用第一次打开时创建的文件夹来找到它们。把那个应用打开一次，退出，再粘贴一次命令。如果提示说 Illustrator *还没有记录它使用的语言*，做法相同。如果它说*找到了 Illustrator，但无法确定它的 Scripts 文件夹*，请看 [Illustrator 的 Scripts 目录是怎么找到的](/zh/reference/advanced#how-illustrator-s-scripts-folder-is-found)。
:::

::: details 公司电脑不让运行
<a id="work-computer-blocks"></a>

有些公司电脑被设置成拒绝这类命令。安装器无法绕开，也不应该绕开。请联系你们的 IT 部门，把这一页给他们看。
:::

::: details 我不能用终端
从 [GitHub](https://github.com/zxa24/creative-script-installer) 把项目下载为 ZIP（**Code → Download ZIP**），解压，在 Windows 上双击 **install-update.bat**，在 Mac 上双击 **install-update.command**。

电脑会发出警告，因为这些文件没有签名：

- **Windows** 显示 *"Windows protected your PC"*（Windows 已保护你的电脑）。点 **More info → Run anyway**（更多信息 → 仍要运行）。
- **Mac** 提示文件 *"cannot be opened because it is from an unidentified developer"*（无法打开，因为它来自身份不明的开发者）。右键点文件，选 **Open**（打开），再点一次 **Open**。

这种方式安装的是你下载的那份副本。要更新，就重新下载。
:::

::: details 出错了
<a id="something-went-wrong"></a>

安装失败时，安装器会打印一行命令，用它可以再运行一次，并把日志文件存到桌面。运行那一行，把它提到的文件通过 [GitHub](https://github.com/zxa24/creative-script-installer/issues) 发给我们。想自己要日志，请看[收集日志](/zh/reference/advanced#collecting-a-log-when-something-goes-wrong)。
:::

::: details 技术说明
<a id="how-updating-behaves"></a><a id="what-it-changes"></a>技术说明只有英文版：[查看](/guide/install#what-it-changes)
:::
