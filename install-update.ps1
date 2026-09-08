<#
  install-update.ps1  —  InDesign 工具箱 一键安装/更新 (Windows)

  设计师双击 "install-update.bat"（它以 -ExecutionPolicy Bypass 调本脚本）即可。
  流程: 探测 Scripts Panel → 取远端版本 → 已最新则跳过 → 否则下载 zip →
        校验 sha256 → 备份旧版 → 原子换入 → 失败自动回滚。绝不半装。

  兼容 Windows PowerShell 5.1（设计师机器自带；不依赖 pwsh 7）。

  ------------------------------------------------------------------
  源地址可配置 (E-source 发布是独立步骤, 待用户批准):
    - 默认: GitHub 公开仓 $Owner/$Repo@$Ref (纯 HTTPS, 零认证)
    - 覆盖: 环境变量 / 参数, 优先级从高到低:
        -Source <path>        本地 .zip 或已解压目录 (离线 / 宿主自测)
        $env:TOOLKIT_SOURCE   同 -Source
        $env:TOOLKIT_ZIP_URL + $env:TOOLKIT_MANIFEST_URL   完整 URL 覆盖
    - 私有源: 设 $env:TOOLKIT_AUTH_TOKEN → 加 Authorization header (选项 B 退路)

  排障日志 (默认关闭, 开了才落盘, 落在桌面):
    -Log 参数  |  $env:CSI_LOG='1' 环境变量
    一行命令下: $env:CSI_LOG='1'; irm <install.ps1> | iex
  ------------------------------------------------------------------
#>
[CmdletBinding()]
param(
  [string]$Source        = $env:TOOLKIT_SOURCE,   # 本地 zip 或目录 (最高优先)
  [switch]$Force,                                 # 版本相同也重装
  [switch]$DryRun,                                # 只探测+校验, 不写任何文件
  [switch]$Install,                               # 跳过菜单, 直接装/更新
  [switch]$Repair,                                # 重装当前版本 (= Force)
  [switch]$Uninstall,                             # 移除已安装的脚本
  [switch]$Log                                    # 排障: 把诊断日志存到桌面 (默认不存)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'      # 避开 IWR 进度条 5.1 大幅拖慢的坑
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}  # 中文消息不乱码

# ===== 可配置源 (发布时设定) =====
$Owner = 'zxa24'
$Repo  = 'creative-script-installer'   # the public distribution repo
$Ref   = 'main'

# 认得出是这个仓, 后缀说明是哪个构建 (owner 2026-09-07 拍)。
# 后缀放在【本侧】是有意的: 这里定的名字由安装器在每台机器上自动生效; 若把改名
# 放在开发端, 就得有人一台一台手工改, 而没轮到的每台机器上冲突都还活着。
$INSTALL_FOLDER = 'indesign-toolkit-stable'
# 旧版本装在这个名字下, 而开发机的桥接也叫这个名字。安装成功后清理, 免得更新过的
# 设计师面板里出现两套 —— 但仅限确实是旧安装, 见 Remove-LegacyFolder。同一个名字
# 承担两种角色, 正是那个检查必须谨慎而不是图省事的原因。
$LEGACY_FOLDER  = 'indesign-toolkit'
$MANIFEST_NAME  = 'toolkit.manifest.json'
$PAYLOAD_SUBDIR = 'toolkit'
$VERSION_MARKER = '.installed_version.json'

# Illustrator: 另一套脚本、另一个位置、另一套权限规则 → 自带 manifest。
$AI_FOLDER         = 'illustrator-toolkit-stable'
$AI_PAYLOAD_SUBDIR = 'illustrator'
$AI_MANIFEST_NAME  = 'illustrator.manifest.json'

# ------------------------------------------------------------------
# 消息 (中文, 非技术, 无 ETA / 栈)
# ------------------------------------------------------------------
# 临时状态行: 步骤进行时显示, 做完就抹掉。
# "Loading..." / "Checking for updates..." 回答的问题在那一步结束的瞬间就不存在了,
# 留在滚动区里只是把人和他真正想看的那两行隔开。
#
# 用空格覆盖 + \r, 不用 ANSI 擦除码 —— Windows PowerShell 5.1 默认不开 VT 处理,
# 那里 ANSI 会原样打成乱码。输出被重定向时退化成普通行: 日志要的是历史, 屏幕不要。
$Script:StatusLen = 0
function Status([string]$m) {
  Log $m
  if ([Console]::IsOutputRedirected) { Write-Host $m; return }
  $pad = [Math]::Max(0, $Script:StatusLen - $m.Length)
  Write-Host ("`r" + $m + (' ' * $pad)) -NoNewline
  $Script:StatusLen = $m.Length
}
function Clear-Status {
  if ($Script:StatusLen -le 0) { return }
  if (-not [Console]::IsOutputRedirected) {
    Write-Host ("`r" + (' ' * $Script:StatusLen) + "`r") -NoNewline
  }
  $Script:StatusLen = 0
}
# 每一条真实输出先抹掉待清的状态行。放在这里而不是各调用点, 是为了不会在某一处
# 漏掉 —— 漏掉一处, 下一行就会打在状态文字上面。
function Say([string]$m)   { Clear-Status; Write-Host $m }
function Ok([string]$m)    { Clear-Status; Write-Host $m -ForegroundColor Green }
function Warn([string]$m)  { Clear-Status; Write-Host $m -ForegroundColor Yellow }
function Err([string]$m)   { Clear-Status; Write-Host $m -ForegroundColor Red }

$Script:LogLines = @()
function Log([string]$m) {
  $Script:LogLines += ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)
}

# 诊断日志【默认不落盘】。此前每次运行都往 %TEMP% 追加同一个文件, 从不轮转 ——
# 一台机器上它只增不减, 而绝大多数运行根本没人会去看它。
#
# 开关有两种, 因为一行命令的两个平台入口能传的东西不一样:
#   $env:CSI_LOG='1'; irm …| iex   ← iex 收到的是一段字符串, 没法传参数, 只能靠环境变量
#   install-update.ps1 -Log        ← 直接调用时用参数
# 环境变量由子进程继承, 所以 install.ps1 引导层不需要改一个字就能透传。
#
# 落点是【桌面】而不是 %TEMP%: 要用户找得到、也能拖出来发给人。GetFolderPath 认
# OneDrive 重定向后的桌面, 这在本机就是实情; 拿不到时退回用户目录。
$Script:LogEnabled = $Log.IsPresent -or (@('1','true','yes','on') -contains ("" + $env:CSI_LOG).ToLower())

# ------------------------------------------------------------------
# 1. 探测 Scripts Panel 目录 (可能多版本 / 多 locale)
#    %APPDATA%\Adobe\InDesign\Version <N>\<locale>\Scripts\Scripts Panel
# ------------------------------------------------------------------
function Find-ScriptsPanelDirs {
  $roots = @()
  $base = Join-Path $env:APPDATA 'Adobe\InDesign'
  if (-not (Test-Path $base)) { return @() }
  Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'Version *' } | ForEach-Object {
      $verDir = $_.FullName
      Get-ChildItem -Path $verDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $panel = Join-Path $_.FullName 'Scripts\Scripts Panel'
        if (Test-Path $panel) { $roots += $panel }
      }
    }
  return $roots
}

# ------------------------------------------------------------------
# 2. 取得分发包 → 返回 dist 根 (含 manifest 的目录)
# ------------------------------------------------------------------
function Get-TempWorkDir {
  $t = Join-Path $env:TEMP ('indesign-toolkit-update-' + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $t -Force | Out-Null
  return $t
}

# 在解压树里递归找含 manifest 的目录 (GitHub zip 会包一层 <repo>-<ref>/)
function Find-DistRoot([string]$dir) {
  $hit = Get-ChildItem -Path $dir -Recurse -Filter $MANIFEST_NAME -File -ErrorAction SilentlyContinue |
         Select-Object -First 1
  if ($hit) { return $hit.Directory.FullName }
  return $null
}

function Invoke-Download([string]$url, [string]$outFile) {
  Status 'Loading...'
  $headers = @{}
  if ($env:TOOLKIT_AUTH_TOKEN) { $headers['Authorization'] = "token $($env:TOOLKIT_AUTH_TOKEN)" }
  # 超时是有意给的。没有超时的话, 一个丢包(而不是拒绝)的防火墙会让运行停在
  # "Checking for updates..." 上一动不动到 IWR 自己的默认上限, 屏幕上什么都没有。
  Invoke-WebRequest -Uri $url -OutFile $outFile -Headers $headers -UseBasicParsing -TimeoutSec 120
}

# 本地 -Source 的版本号。-Source 可以是目录, 也可以是 .zip —— 与 macOS 侧同样接受,
# 首部注释也这么写。Get-ChildItem 在一个普通文件上递归找不到任何东西, 于是版本
# 留空, 每个安装看起来都是最新, 菜单永远给不出 Update; macOS 侧修过同一个坑
# (unzip -p), 这边一直没有。抽成函数, 是为了能拿文件里的真实字节单独测它。
function Get-LocalSourceVersion([string]$src) {
  try {
    if (Test-Path -LiteralPath $src -PathType Leaf) {
      Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
      $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $src).Path)
      try {
        $entry = $zip.Entries | Where-Object { $_.Name -eq $MANIFEST_NAME } | Select-Object -First 1
        if (-not $entry) { return $null }
        $sr = New-Object System.IO.StreamReader($entry.Open())
        try { return ($sr.ReadToEnd() | ConvertFrom-Json).version } finally { $sr.Dispose() }
      } finally { $zip.Dispose() }
    }
    $lm = Get-ChildItem -Path $src -Recurse -Filter $MANIFEST_NAME -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($lm) { return (Get-Content $lm.FullName -Raw | ConvertFrom-Json).version }
  } catch { }
  return $null
}

function Resolve-RemoteUrls {
  $zipUrl      = $env:TOOLKIT_ZIP_URL
  $manifestUrl = $env:TOOLKIT_MANIFEST_URL
  if (-not $zipUrl)      { $zipUrl      = "https://codeload.github.com/$Owner/$Repo/zip/refs/heads/$Ref" }
  if (-not $manifestUrl) { $manifestUrl = "https://raw.githubusercontent.com/$Owner/$Repo/$Ref/$MANIFEST_NAME" }
  return @{ Zip = $zipUrl; Manifest = $manifestUrl }
}

# 轻量版本预检: 只取小 manifest, 用于"已最新则不下载整包"(设计 §2.2)。
function Fetch-RemoteManifest([string]$manifestUrl) {
  $headers = @{ 'Cache-Control' = 'no-cache' }
  if ($env:TOOLKIT_AUTH_TOKEN) { $headers['Authorization'] = "token $($env:TOOLKIT_AUTH_TOKEN)" }
  # 这是那个"小 manifest"预检, 它跑在任何输出之前 —— 卡在这里是最难看的一种卡。
  $json = Invoke-WebRequest -Uri $manifestUrl -Headers $headers -UseBasicParsing -TimeoutSec 20
  return ($json.Content | ConvertFrom-Json)
}

# 任一探测到的目标未装 / 版本不符 → 需要更新 (Force 恒为真)。两个应用都算。
function Test-PanelsNeedUpdate($panels, [string]$version, $aiTargets) {
  if ($Force) { return $true }
  foreach ($p in $panels) {
    $marker = Join-Path (Join-Path $p $INSTALL_FOLDER) $VERSION_MARKER
    if (-not (Test-Path $marker)) { return $true }
    try { $cur = (Get-Content $marker -Raw | ConvertFrom-Json).version } catch { return $true }
    if ($cur -ne $version) { return $true }
  }
  foreach ($t in $aiTargets) {
    # 还在等一次性管理员步骤的目标跳过: 下载一份写不进去的载荷没有意义。
    # 但它没有因此被忘记 —— Show-PendingIllustratorSetup 会在本函数能把流程
    # 引向的每条路径上打印它, 包括"已是最新版本"那条退出。
    $dst = Join-Path $t.Dir $AI_FOLDER
    # 目录不存在 != 没事可做。只有在【同时写不进去】时才是没事可做(那是在等
    # 一次性管理员步骤, 由 Show-PendingIllustratorSetup 打印)。写得进去却没有
    # 目录 = 根本没装, 在这里跳过会让运行对一台什么都没装的机器回答
    # "Already up to date" 然后退出 0。
    if (-not (Test-Path -LiteralPath $dst)) {
      if (Test-IllustratorWritable $t.Dir) { return $true }
      continue
    }
    $marker = Join-Path $dst $VERSION_MARKER
    if (-not (Test-Path $marker)) { return $true }
    try { $cur = (Get-Content $marker -Raw | ConvertFrom-Json).version } catch { return $true }
    if ($cur -ne $version) { return $true }
  }
  return $false
}

function Show-PendingIllustratorSetup($aiTargets) {
  $n = 0
  foreach ($t in $aiTargets) {
    $dst = Join-Path $t.Dir $AI_FOLDER
    if ((Test-Path -LiteralPath $dst) -and (Get-Item -LiteralPath $dst -Force).LinkType) { continue }
    if (Test-IllustratorWritable $t.Dir) { continue }
    $n++
    Say ''
    Say ("{0} is not set up yet." -f $t.Label)
    Show-IllustratorSetup $t.Dir
  }
  return $n
}

# 返回 @{ Root=<distRoot>; Manifest=<obj>; Work=<tempToClean or $null> }
function Acquire-Distribution {
  # (a) 本地 override: -Source / $env:TOOLKIT_SOURCE
  if ($Source) {
    if (-not (Test-Path $Source)) { throw "Source does not exist: $Source" }
    $item = Get-Item $Source
    if ($item.PSIsContainer) {
      $root = Find-DistRoot $item.FullName
      if (-not $root) { throw "No $MANIFEST_NAME in that folder: $Source" }
      Log "source=localdir root=$root"
      return @{ Root = $root; Work = $null }
    } else {
      $work = Get-TempWorkDir
      $ex = Join-Path $work 'extract'
      New-Item -ItemType Directory -Path $ex -Force | Out-Null
      Expand-Archive -Path $item.FullName -DestinationPath $ex -Force
      $root = Find-DistRoot $ex
      if (-not $root) { throw "No $MANIFEST_NAME inside that zip: $Source" }
      Log "source=localzip root=$root"
      return @{ Root = $root; Work = $work }
    }
  }

  # (b) 远端
  $u = Resolve-RemoteUrls
  $work = Get-TempWorkDir
  $zip  = Join-Path $work 'dist.zip'
  Log "download zip=$($u.Zip)"
  Invoke-Download $u.Zip $zip
  $ex = Join-Path $work 'extract'
  New-Item -ItemType Directory -Path $ex -Force | Out-Null
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  $root = Find-DistRoot $ex
  if (-not $root) { throw "No $MANIFEST_NAME in the downloaded package - unexpected layout" }
  Log "source=remote root=$root"
  return @{ Root = $root; Work = $work }
}

# ------------------------------------------------------------------
# 3. 校验 payload 的 sha256 与 manifest 一致 (防半损下载)
# ------------------------------------------------------------------
# SHA256 via .NET (not Get-FileHash): works on every PowerShell regardless of
# module state — some 5.1 installs don't expose the Get-FileHash cmdlet.
function Get-Sha256Hex([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try { $hash = $sha.ComputeHash($fs) } finally { $fs.Dispose() }
    return ([BitConverter]::ToString($hash) -replace '-', '').ToLower()
  } finally { $sha.Dispose() }
}

function Verify-Payload([object]$manifest, [string]$payloadDir) {
  $bad = @()
  # 没有 files 不是"没有不匹配", 是"根本没校验"。此前两种情况都返回空数组, 于是
  # 一份丢了 files 的 manifest 会让整道闸静默让行 —— 而控制台输出与真的校验过
  # 126 个文件时【逐字相同】(唯一区别在默认关闭的日志里)。macOS 侧对等情况一直是
  # 硬失败退出 4; 这个 return 让 Windows 也走到 exit 4, 两边现在一致 —— 描述的是
  # 打这个补丁【之前】的状态, 别把它读成现状。
  if (-not $manifest.files -or @($manifest.files).Count -eq 0) {
    return @('the manifest carries no file list - nothing could be verified')
  }
  foreach ($f in $manifest.files) {
    $p = Join-Path $payloadDir ($f.path -replace '/', '\')
    if (-not (Test-Path $p)) { $bad += "缺文件 $($f.path)"; continue }
    $h = Get-Sha256Hex $p
    if ($h -ne $f.sha256.ToLower()) { $bad += "校验不符 $($f.path)" }
  }
  return $bad
}

# ------------------------------------------------------------------
# 4. 装入单个 Scripts Panel (原子 rename swap + 失败回滚)
# ------------------------------------------------------------------
# 仅在安装成功后调用, 失败时不会让面板两个文件夹都没有。
#
# LEGACY_FOLDER 同时也是开发机给桥接起的名字, 所以这里必须把「旧安装」和「指向
# 别人工作树的链接」分开。删错是破坏性且静默的。两个互相独立的测试:
#   1. 不能是重解析点 —— 桥接一定是, 安装出来的一定不是
#   2. 必须带本安装器的版本标记 —— 手工建的目录或 checkout 都没有
# 单看任一条纸面上都够; 两条都在是因为失效方式不同: 里面混了个杂散标记文件的链接
# 骗得过第 2 条, 手工建的普通目录骗得过第 1 条。
function Remove-LegacyFolder([string]$panelDir) {
  # dry run 不许删任何东西。它是在调用点被放宽到也走 `skip` 路径之后才可达的:
  # `skip` 在 install_into 的 dry-run 闸【之前】返回, 于是一台已是当前版本的
  # 机器直接走到这里、把文件夹删了, 然后打印 "Nothing was written."。
  # 而伤害只落在设计师身上 —— 开发机上那个旧名字是桥接, 下面的链接检查会拒绝。
  if ($DryRun) { return }
  $old = Join-Path $panelDir $LEGACY_FOLDER
  if (-not (Test-Path -LiteralPath $old)) { return }
  $item = Get-Item -LiteralPath $old -Force
  # 拒绝时保持沉默 —— 这两条本就只进日志, 不进控制台。宣布"它没有动一个用户没问起
  # 的文件夹"是噪音, 而且恰好在一切正常时才出现: 开发机上那个文件夹就是桥接。
  if ($item.LinkType) { Log "keep $LEGACY_FOLDER (it is a $($item.LinkType), not ours)"; return }
  if (-not (Test-Path -LiteralPath (Join-Path $old $VERSION_MARKER))) {
    Log "keep $LEGACY_FOLDER (no version marker; not installed by us)"; return
  }
  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  # 先看, 再宣布。原来是删完无条件宣布, 而删除是 SilentlyContinue 的 —— 于是
  # InDesign 占着文件时, 用户被告知旧副本已移除, 而面板里两套脚本都还在。
  if (Test-Path -LiteralPath $old) { Log "legacy folder could not be removed -> $old"; return }
  Say ("(removed a previous installation under the old name {0})" -f $LEGACY_FOLDER)
  Log "removed previous install $LEGACY_FOLDER"
}

# 卸载。与安装同一道护栏, 理由相同: 这里若是链接, 那是开发桥接, 删掉等于抽走
# 别人与工作树的连接 —— 而那样的卸载看起来完全成功。
function Uninstall-From([string]$panelDir) {
  $dst = Join-Path $panelDir $INSTALL_FOLDER
  $bak = "$dst.bak"
  $new = "$dst.new"
  if ((Test-Path -LiteralPath $dst) -and (Get-Item -LiteralPath $dst -Force).LinkType) { return 'blocked' }
  # 没有版本标记就不是我们的 —— 旧名清理和两条 Illustrator 路径都这么判, 唯独
  # 这一处删除不查, 于是一份复制过来的检出、一份解开的备份, 只要顶着这个保留名
  # 就会被整个删掉。
  if ((Test-Path -LiteralPath $dst) -and -not (Test-Path -LiteralPath (Join-Path $dst $VERSION_MARKER))) { return 'not-ours' }

  # .bak / .new 也是我们的。一次在换入中途被杀的运行会留下其中一个或两个而
  # 【没有】$dst —— 原来的卸载只看 $dst, 什么也没找到, 报"没有找到安装", 而
  # InDesign 递归扫描这个面板, 用户此刻看到的是两整套工具包。
  $leftovers = @(@($bak, $new) | Where-Object { Test-Path -LiteralPath $_ })
  if (-not (Test-Path -LiteralPath $dst)) {
    if ($leftovers.Count -eq 0) { return 'absent' }
    if ($DryRun) { return 'would-remove' }
    try {
      foreach ($p in $leftovers) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop }
      return 'removed'
    } catch { Log ("uninstall failed (leftovers) : " + $_.Exception.Message); return 'failed' }
  }
  if ($DryRun) { return 'would-remove' }
  try {
    Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction Stop
    foreach ($p in $leftovers) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
    return 'removed'
  }
  catch { Log ("uninstall failed -> $dst : " + $_.Exception.Message); return 'failed' }
}

function Get-InstalledVersion([string]$panelDir) {
  $mk = Join-Path (Join-Path $panelDir $INSTALL_FOLDER) $VERSION_MARKER
  if (-not (Test-Path -LiteralPath $mk)) { return $null }
  try { return (Get-Content $mk -Raw | ConvertFrom-Json).version } catch { return $null }
}

# ------------------------------------------------------------------
# 5. Illustrator
# ------------------------------------------------------------------
# 两条约束与 macOS 侧相同, 实测依据见 install-update.sh 里那段长注释:
#   (a) 脚本目录名随语言变(Scripts / 脚本 / スクリプト / Komut Dosyaları),
#       所以按【内容】找 —— 该 locale 下含 .jsx 的那个子目录。按名字找只能
#       找到英文安装, 其余静默跳过。
#   (b) 它在 Program Files 里, 设计师写不进去。一次性管理员命令只给他一个
#       属于自己的子目录, 比放开整个 Scripts 目录窄, 而且够用。
#
# ⚠ Windows 与 macOS 在此并非对称, 不可互相假设: 那边的目录符号链接
# Illustrator 不认(实测), 这边的 Junction 认。这里两边都不用 —— 装真文件。
function Get-IllustratorScriptsDirIn([string]$localeDir) {
  # 两个信号, 因为第一个是借来的。"里面有 .jsx" 成立, 全靠 Adobe 那三个样例脚本
  # —— 扛着它的是它们, 不是我们的东西: 我们自己装到 <脚本目录>/$AI_FOLDER/,
  # 深一层, 所以一次成功的安装对"下次还能不能被找到"没有任何贡献。样例一旦被删,
  # Illustrator 就永久不可见 —— 连更新和卸载明明就在那儿的脚本都做不到。
  #
  # 所以"里面有我们的文件夹"也算。这让一次已存在的安装靠自己的证据被发现。
  $subs = @(Get-ChildItem -LiteralPath $localeDir -Directory -ErrorAction SilentlyContinue)
  foreach ($d in $subs) {
    if (Test-Path -LiteralPath (Join-Path $d.FullName $AI_FOLDER)) { return $d.FullName }
  }
  foreach ($d in $subs) {
    if (@(Get-ChildItem -LiteralPath $d.FullName -Filter *.jsx -File -ErrorAction SilentlyContinue).Count -gt 0) {
      return $d.FullName
    }
  }
  return $null
}

function Get-IllustratorSettingsLocales {
  # Illustrator 首次启动时自己建这个目录, 并以它运行的语言命名。那与系统语言是
  # 两个问题, 只是在很多机器上碰巧同解。
  #
  # 取【全部】而不是第一个: 切过语言、或装了两个版本的机器上会有不止一个, 取
  # 第一个等于在它们之间掷硬币 —— 而掷错时是静默的(装进一个 Illustrator 不读
  # 的语言目录, 用户看到"装好了"然后菜单里空空如也)。
  $base = Join-Path $env:APPDATA 'Adobe'
  if (-not (Test-Path -LiteralPath $base)) { return @() }
  $names = @()
  foreach ($d in (Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -like 'Adobe Illustrator * Settings' })) {
    $names += @(Get-ChildItem -LiteralPath $d.FullName -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { $_.Name })
  }
  return @($names | Sort-Object -Unique)
}

# 为什么选了这些 locale —— 由 Find-IllustratorDirs 设置, 主流程逐行打印。
# 每个 Illustrator 安装一条, 不是整次运行一条: 原来是单个变量按应用覆盖,
# 两个版本时最后一个会用"(Nothing was written)"盖掉刚刚被写入的第一个。
$Script:AiLocaleNote = ''
function Add-AiNote([string]$m) {
  if ($Script:AiLocaleNote) { $Script:AiLocaleNote += "`n" }
  $Script:AiLocaleNote += $m
}
$Script:AiAppsSeen = 0

function Find-IllustratorDirs {
  $out = @()
  $Script:AiLocaleNote = ''
  $Script:AiAppsSeen = 0
  $root = if ($env:CSI_APP_ROOT) { $env:CSI_APP_ROOT } else { Join-Path $env:ProgramFiles 'Adobe' }
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  $want = @(Get-IllustratorSettingsLocales)
  foreach ($app in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like 'Adobe Illustrator*' })) {
    $presets = Join-Path $app.FullName 'Presets'
    if (-not (Test-Path -LiteralPath $presets)) { continue }
    $Script:AiAppsSeen++
    $ver = $app.Name -replace '^Adobe Illustrator\s*', ''

    # 这个安装确实有对应文件夹的、每一个被记录过的 locale。
    $picked = @()
    foreach ($w in $want) {
      $p = Join-Path $presets $w
      if (Test-Path -LiteralPath $p) { $picked += (Get-Item -LiteralPath $p) }
    }

    # 再加上【已经装着我们东西】的每一个语言目录, 不管记录到的 locale 怎么说。
    # 没有这一步, 下面的拒装会让既有安装变得不可达: 被早期版本(它曾撒遍所有
    # locale)写入过的机器, 卸载时报"没有找到安装", 而脚本就在那儿。"我们的" =
    # 版本标记, 与卸载自己用的是同一个判据。
    foreach ($l in (Get-ChildItem -LiteralPath $presets -Directory -ErrorAction SilentlyContinue)) {
      if ($picked.FullName -contains $l.FullName) { continue }
      $sdir = Get-IllustratorScriptsDirIn $l.FullName
      if ($sdir -and (Test-Path -LiteralPath (Join-Path (Join-Path $sdir $AI_FOLDER) $VERSION_MARKER))) { $picked += $l }
    }

    if ($picked.Count -eq 0) {
      # owner 2026-09-07 拍: 拒装, 不要撒。
      #
      # 原来的兜底是装进【每一个】语言目录 —— 测试 Mac 上是二十五个。其中二十四个
      # 是 Illustrator 根本不读的目录, 位于应用包内部, 而卸载只能清空它们:
      # 删掉那些文件夹需要 Adobe 目录的写权限, 这个安装器没有。所以猜错的代价是
      # 在别人的应用里留下永久垃圾。
      #
      # CSI_ALL_LOCALES=1 保留旧行为, 给那种 Illustrator 确实从不记录语言的机器。
      # 刻意不在本文件之外宣传: 它是逃生口, 不是选项。
      if ($env:CSI_ALL_LOCALES -eq '1') {
        $picked = @(Get-ChildItem -LiteralPath $presets -Directory -ErrorAction SilentlyContinue)
        Add-AiNote ("Illustrator {0}: could not tell which language it uses; CSI_ALL_LOCALES=1 is set, so every language folder is being used." -f $ver)
      } else {
        Add-AiNote ("Illustrator {0} has not recorded which language it runs in, so there is no way to tell which of its language folders it reads. Launch it once, then run this again. (Nothing was written to it.)" -f $ver)
      }
    } elseif ($picked.Count -gt 1) {
      # 记录了不止一个, 而且无法判断哪个属于哪个安装 —— 应用目录以年份命名、
      # 设置目录以版本号命名, 要配对就得有一张会过期的对照表。全都用, 并说出来。
      # 用【真正选中的】拼这句, 不是用记录到的。
      Add-AiNote ("Illustrator {0} is set up for more than one language; the scripts are being installed for each of these: {1}" -f $ver, (($picked | ForEach-Object { $_.Name }) -join ' '))
    }

    foreach ($l in $picked) {
      $sdir = Get-IllustratorScriptsDirIn $l.FullName
      if ($sdir) {
        $out += [pscustomobject]@{ Dir = $sdir; Label = "Illustrator $ver ($($l.Name))" }
      }
    }
  }
  return $out
}

function Test-IllustratorWritable([string]$scriptsDir) {
  # 两个分支都真写一次。这条路径上的权限位在实测里两个方向都撒过谎, 所以不看位。
  # 两个探针都会把自己创建的东西删掉。
  $dst = Join-Path $scriptsDir $AI_FOLDER
  if (Test-Path -LiteralPath $dst) {
    $probe = Join-Path $dst '.csi_probe'
    try {
      [System.IO.File]::WriteAllText($probe, 'x')
      Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
      return $true
    } catch { return $false }
  }
  # 目录还不存在: 问题是"能不能建"。用一个一次性的名字问, 而不是直接建那个真
  # 目录 —— 否则 --dry-run 会在应用里留下一个文件夹, 正是它承诺不做的事。
  # (实测: 它在 Windows 上真留了一个。)
  $tmp = Join-Path $scriptsDir ('.csi_probe_' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    New-Item -ItemType Directory -Path $tmp -ErrorAction Stop | Out-Null
    [System.IO.Directory]::Delete($tmp, $false)
    return $true
  } catch { return $false }
}

function Get-IllustratorInstalledVersion([string]$scriptsDir) {
  $mk = Join-Path (Join-Path $scriptsDir $AI_FOLDER) $VERSION_MARKER
  if (-not (Test-Path -LiteralPath $mk)) { return $null }
  try { return (Get-Content $mk -Raw | ConvertFrom-Json).version } catch { return $null }
}

function Install-IntoIllustrator([string]$scriptsDir, [string]$payloadDir, [string]$version) {
  $dst = Join-Path $scriptsDir $AI_FOLDER
  if ((Test-Path -LiteralPath $dst) -and (Get-Item -LiteralPath $dst -Force).LinkType) { return 'blocked' }
  # 在建任何东西【之前】问, 而且用会自我清理的探针回答。已经有人放开过 Scripts
  # 目录的机器上它直接说是, 于是完全不需要管理员 —— 先问清楚, 才不会对不需要
  # 提权的人提权。
  if (-not (Test-IllustratorWritable $scriptsDir)) { return 'needs-setup' }

  if (-not $Force) {
    $cur = Get-IllustratorInstalledVersion $scriptsDir
    if ($cur -and $cur -eq $version) { return 'skip' }
  }
  # 所有写入都在这行以下。dry run 必须把应用原样留下, 包括不创建那个目录。
  if ($DryRun) { return 'would-install' }
  if (-not (Test-Path -LiteralPath $dst)) {
    try { New-Item -ItemType Directory -Path $dst -ErrorAction Stop | Out-Null } catch { return 'needs-setup' }
  }

  # 全部先落成 .csi-new, 再逐个改名。暂存阶段失败不会污染在用的那一份;
  # 每次改名在同一目录内是原子的。整目录换入在这里做不到 —— 那需要父目录
  # 的写权限, 而我们刻意没有(见本节顶部)。
  $staged = @()
  try {
    foreach ($f in (Get-ChildItem -LiteralPath $payloadDir -File)) {
      $tmp = Join-Path $dst ($f.Name + '.csi-new')
      Copy-Item -LiteralPath $f.FullName -Destination $tmp -Force -ErrorAction Stop
      $staged += $tmp
    }
  } catch {
    foreach ($s in $staged) { Remove-Item -LiteralPath $s -Force -ErrorAction SilentlyContinue }
    Log ("illustrator stage failed -> $dst : " + $_.Exception.Message)
    return 'failed'
  }
  foreach ($s in $staged) {
    $final = $s -replace '\.csi-new$', ''
    try { Move-Item -LiteralPath $s -Destination $final -Force -ErrorAction Stop }
    catch { Log ("illustrator swap failed -> $final : " + $_.Exception.Message); return 'failed' }
  }

  # 清掉上一版装过、这一版不再发的脚本 —— 否则改过名的脚本会以两个名字同时
  # 出现。只动 .jsx: 这个目录是为这些脚本建的, 但别人放进来的东西是别人的。
  $shipped = @{}
  foreach ($f in (Get-ChildItem -LiteralPath $payloadDir -File)) { $shipped[$f.Name] = $true }
  foreach ($f in (Get-ChildItem -LiteralPath $dst -Filter *.jsx -File -ErrorAction SilentlyContinue)) {
    if (-not $shipped.ContainsKey($f.Name)) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
  }

  $marker = @{
    version     = $version
    installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    source      = "$Owner/$Repo@$Ref"
  } | ConvertTo-Json -Compress
  Set-Content -LiteralPath (Join-Path $dst $VERSION_MARKER) -Value $marker -Encoding UTF8
  return 'installed'
}

function Uninstall-FromIllustrator([string]$scriptsDir) {
  $dst = Join-Path $scriptsDir $AI_FOLDER
  if (-not (Test-Path -LiteralPath $dst)) { return 'absent' }
  if ((Get-Item -LiteralPath $dst -Force).LinkType) { return 'blocked' }
  if (-not (Test-Path -LiteralPath (Join-Path $dst $VERSION_MARKER))) { return 'not-ours' }
  if ($DryRun) { return 'would-remove' }

  # 顺序是有意的, 原来是无序的两步。版本标记是这个目录属于我们的【唯一】凭证:
  # 脚本还在而标记先没了, 这个目标就永远报 'not-ours' —— 脚本仍在 Illustrator
  # 菜单里, 而卸载再也删不掉它。所以先删脚本, 全删掉了才删标记。
  Get-ChildItem -LiteralPath $dst -Filter *.jsx -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  # 暂存与探针残留也是我们的; 留一个就足以让这个目录永远非空, 而那会让此后每一次
  # 卸载都为"目录还在"给出错误的理由。
  Get-ChildItem -LiteralPath $dst -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*.csi-new' -or $_.Name -eq '.csi_probe' } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  # 看一眼, 不靠假设。上面每一步都吞了错误, 唯一诚实的答案来自复查。
  if (@(Get-ChildItem -LiteralPath $dst -Filter *.jsx -File -ErrorAction SilentlyContinue).Count -gt 0) {
    return 'failed'
  }
  Remove-Item -LiteralPath (Join-Path $dst $VERSION_MARKER) -Force -ErrorAction SilentlyContinue

  # 先看空不空, 再删 —— 不拿 `Remove-Item -Force` 当 rmdir 使, 它不是。对非空目录
  # 交互时会弹 "has children … Recurse not specified": 答 Y 递归删掉别人放这儿的
  # 文件(正是上面说不动的东西), 答 N 不报错于是被当成"已删除"。非交互直接抛。
  # Windows PowerShell 5.1 实测: 抛 NullReferenceException, 目录和文件都还在。
  if (@(Get-ChildItem -LiteralPath $dst -Force -ErrorAction SilentlyContinue).Count -gt 0) {
    return 'emptied'
  }
  try {
    Remove-Item -LiteralPath $dst -Force -ErrorAction Stop
    return 'removed'
  } catch { return 'emptied' }
}

function Invoke-IllustratorGrant([string]$scriptsDir, [string]$label) {
  $dst = Join-Path $scriptsDir $AI_FOLDER
  $who = "$env:USERDOMAIN\$env:USERNAME"

  # 已存在却写不进去的文件夹是别人的 —— 同一台机器上另一个账户的授权。把它
  # 改成这个人的, 无论静默还是征得他同意, 都是把一个用户的文件夹交给另一个。
  # 拒绝; 末尾打印的命令仍允许人有意识地那样做。
  if (Test-Path -LiteralPath $dst) {
    Log "$dst exists but is not writable by $who; not re-owning it"
    return $false
  }

  # 已经以管理员身份在跑 → 不会有 UAC 弹窗, 也就没有什么要声明、要征求同意的。
  # 下面那段说明存在的理由是"向你解释为什么要弹这个框"; 框不会出现时, 它只是挡在
  # 人和结果之间的几行字, 讲一笔他并不需要付的代价。(仍会进诊断日志。)
  $elevated = $false
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
                  [Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { $elevated = $false }
  if ($elevated) {
    try {
      New-Item -ItemType Directory -Force -Path $dst -ErrorAction Stop | Out-Null
      & icacls $dst /grant "$($who):(OI)(CI)F" | Out-Null
    } catch {
      Log ("already elevated but the folder could not be created: " + $_.Exception.Message)
      return $false
    }
    if (Test-IllustratorWritable $scriptsDir) {
      Log "granted in-process (already running elevated): $dst"
      return $true
    }
    return $false
  }

  # 没人可问就别问。无人值守的运行不该停在一个没人会看到的提示上。
  if (-not (Test-CanAsk)) { return $false }

  # 说人话, 不贴命令。用户在这里要知道的是: 为什么要批准、会改什么、是不是每次都要。
  # 精确命令在【拒绝之后】打印 —— 想先看清楚再决定的人正好走到那里。
  Say ''
  Say ("  {0} keeps its scripts inside the application itself, so installing" -f $label)
  Say '  them there needs your permission - once.'
  Say ''
  Say '  It creates one folder inside Illustrator for these scripts. Nothing else'
  Say '  on your PC is changed, and you will not be asked again.'
  Say ''
  Say '  Windows will ask you to approve it.'
  $ans = ''
  try { $ans = Read-Host '  Continue? [y/n]' } catch { return $false }
  # 只有肯定答复才继续。原来是"不匹配 n 就当同意", 于是 q / ? / 随手一个键都会
  # 走到 UAC。在一个权限问题上, 认不出的回答必须当作否。
  if ($ans -match '^\s*[nN]') { Say '  Skipped - the command to do it yourself is below.'; return $false }
  if ($ans -notmatch '^\s*$' -and $ans -notmatch '^\s*[yY]') {
    Say '  Not a yes - skipping. The command to do it yourself is below.'
    return $false
  }

  $inner = Get-GrantCommand $dst $who
  try {
    # Windows 的"提权"是 UAC 弹窗, 不是终端里输密码。触发它并【等它结束】——
    # 不等的话下面那句可写性检查会在授权发生之前就跑完, 然后报一个假的失败。
    # 安装器本身仍然不是以管理员身份运行的: 被提权的只有这一条命令。
    # -EncodedCommand, 不是把脚本当字符串传。实测: 用户名里带撇号(O'Brien 这类
    # 常见姓氏)会让生成的命令解析失败 —— UAC 弹了、用户批了、提权的子进程直接
    # 死在解析错误上什么也没做, 然后我们报"命令报告成功, 但文件夹仍不可写"。
    # Base64 的 UTF-16LE 没有引号可以写错。macOS 侧一直是对的(值走 argv)。
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $proc = Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -PassThru `
      -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc -ErrorAction Stop
    # 读子进程的退出码。-Wait 不会因子进程失败而抛错, 原来这里什么都不看,
    # 于是一个死在解析错误上的提权子进程被报成"命令成功但文件夹仍不可写"。
    if ($proc -and $proc.ExitCode -ne 0) {
      Say ''
      Say ("  The administrator step failed (exit code {0}) - nothing was changed." -f $proc.ExitCode)
      return $false
    }
  } catch {
    # 取消 UAC 也走这里 —— 那不是错误, 是一个回答。
    Say ''
    Say '  That did not go through - nothing was changed.'
    return $false
  }

  # 不把退出码当答案。检查真正需要的东西: 一个写得进去的文件夹。
  if (Test-IllustratorWritable $scriptsDir) {
    # 不另行宣布。紧随其后的安装结果就是它成功的证据, 在它上面再加一行
    # "完成" 只会把那一行推得离顶部更远。
    return $true
  }
  Say '  The command reported success, but the folder still is not writable.'
  return $false
}

function Get-GrantCommand([string]$dst, [string]$who) {
  # 单引号字面量里的撇号, 按 PowerShell 自己的规则写成两个 (''). 少了这一步,
  # O'Brien 这类用户名会截断字符串: 子进程解析失败、什么都没做, 而 UAC 已经批了。
  # -EncodedCommand 只去掉了【外层参数】的引号问题, 对这一层无效 —— 实测。
  # 同一份文本供两处使用(提权执行的、打印给人手动跑的), 只在这里拼一次。
  $d = $dst.Replace("'", "''")
  $w = $who.Replace("'", "''")
  return "New-Item -ItemType Directory -Force -Path '$d' | Out-Null; icacls '$d' /grant '$($w):(OI)(CI)F' | Out-Null"
}

function Show-IllustratorSetup([string]$scriptsDir) {
  $dst = Join-Path $scriptsDir $AI_FOLDER
  $who = "$env:USERDOMAIN\$env:USERNAME"
  $inner = Get-GrantCommand $dst $who
  Say ''
  Say '  Illustrator keeps its Scripts folder inside the application itself, so it'
  Say '  needs one administrator step - once. After it, every install and update'
  Say '  runs without one.'
  Say ''
  Say '  Paste this into PowerShell and approve the prompt Windows shows:'
  Say ''
  Say ("    Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command'," + '"' + $inner + '"')
  Say ''
  Say '  It gives you one folder of your own inside the application. It does not'
  Say '  open the rest of it.'
  Say ''
  Say '  An Illustrator upgrade replaces the application and takes that folder with'
  Say '  it. Run the same command again afterwards.'
}

# 有没有人可问。在打印任何东西【之前】判断 —— 无人值守时不该吐出一个没人能回答
# 的菜单: 在日志里它读起来像"安装器停下来等人"。
# UserInteractive 单独不够: 输入被重定向时它仍为真, 那时 Read-Host 会抛
# "PowerShell is in NonInteractive mode"。两条都看, 再用 try/catch 兜底。
function Test-CanAsk {
  try {
    if (-not [Environment]::UserInteractive) { return $false }
    if ([Console]::IsInputRedirected) { return $false }
    return $true
  } catch { return $false }
}

function Install-Into([string]$panelDir, [string]$payloadDir, [string]$version) {
  $dst = Join-Path $panelDir $INSTALL_FOLDER

  # 这里若是 Junction / 符号链接, 那就是开发桥接, 绝不是本安装器造的。写任何东西
  # 之前先拒绝 —— 替掉它的安装会显得完全成功, 而开发者指向工作树的链接已经没了。
  if (Test-Path -LiteralPath $dst) {
    $existing = Get-Item -LiteralPath $dst -Force
    if ($existing.LinkType) { return 'blocked' }
  }
  $bak = "$dst.bak"
  $new = "$dst.new"

  # 清理上次崩溃残留的 .new (InDesign 会递归扫描 Scripts Panel → 残树会当成
  # 多余脚本组显示)。
  if (Test-Path $new) { Remove-Item $new -Recurse -Force }

  # 已最新? (逐目录判断)
  if ((Test-Path $dst) -and -not $Force) {
    $marker = Join-Path $dst $VERSION_MARKER
    if (Test-Path $marker) {
      try {
        $cur = (Get-Content $marker -Raw | ConvertFrom-Json).version
        if ($cur -eq $version) {
          if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }  # 清残留 .bak
          return 'skip'
        }
      } catch {}
    }
  }

  if ($DryRun) { return 'would-install' }

  # 备好新树
  Copy-Item -Path $payloadDir -Destination $new -Recurse -Force
  $vObj = @{ version = $version; installedAt = (Get-Date).ToString('o'); source = "$Owner/$Repo@$Ref" }
  $vObj | ConvertTo-Json | Set-Content -Path (Join-Path $new $VERSION_MARKER) -Encoding UTF8

  # 换入: 旧 → .bak, 新 → 正位; 失败还原
  if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
  $movedToBak = $false
  if (Test-Path $dst) { Move-Item -Path $dst -Destination $bak; $movedToBak = $true }
  try {
    Move-Item -Path $new -Destination $dst
  } catch {
    if ($movedToBak -and (Test-Path $bak) -and -not (Test-Path $dst)) {
      Move-Item -Path $bak -Destination $dst   # 回滚
    }
    throw
  }
  # 成功后删掉 .bak: 不在 Scripts Panel 里留副本树 (否则面板显示重复脚本组,
  # 设计师可能误运行旧版)。回滚保护只需覆盖 swap 的瞬间, 换入成功即可清。
  # 换入已经成功; 这一步失败(杀软/索引器暂时握着旧树里的句柄)不能把成功记成失败 ——
  # 原来这里在 EAP=Stop 下裸跑, 一抛就跳过下面的 return, 面板被计入 failed, 汇总
  # 说"什么都没改", 而新版本此刻就在 $dst 里活着。
  try { if (Test-Path $bak) { Remove-Item $bak -Recurse -Force -ErrorAction Stop } }
  catch { Log ("post-swap .bak removal failed -> $bak : " + $_.Exception.Message); Say ("  (a leftover copy at {0} could not be removed - InDesign may list the scripts twice until it is)" -f $bak) }
  return 'installed'
}

# ==================================================================
# 主流程
# ==================================================================
$exitCode = 0
$work = $null
try {
  Say ''
  Status 'Checking for updates...'

  $panels = Find-ScriptsPanelDirs
  $aiDirs = @(Find-IllustratorDirs)
  # 说出来, 因为这正是猜测可能出错的地方: 静默猜错会装进一个 Illustrator
  # 不读的语言目录, 而用户看到的是"已安装"加一个空菜单, 没有任何线索。
  # 放在下面那个退出块【之前】—— 原来在它之后, 于是一台只装了 Illustrator 的
  # 机器在看到解释之前就被 exit 3 打断了。
  foreach ($__l in ($Script:AiLocaleNote -split "`n")) { if ($__l) { Say ('  ' + $__l) } }
  # 只有两个都没有才收工。原来在"没有 InDesign"就退出, 会让一台只装了
  # Illustrator 的机器看起来像什么都没装。
  if ($panels.Count -eq 0 -and $aiDirs.Count -eq 0) {
    # 两种不同的状态, 此前共用一句话。"Illustrator 在, 但我认不出它的 Scripts
    # 目录"不是"Illustrator 没装", 而让一个人去安装他已经装了的应用, 是唯一一条
    # 哪儿也去不了的回答。
    # 上面的说明已经讲了为什么现在什么都做不了。那不是故障, 不该按故障报 ——
    # 原来"请报告 bug"和 exit 3 就跟在一条把一切都解释清楚了的说明后面。
    if ($Script:AiAppsSeen -gt 0 -and $Script:AiLocaleNote) { exit 0 }
    if ($Script:AiAppsSeen -gt 0) {
      Err 'Found Illustrator, but could not identify its Scripts folder inside it.'
      Say 'That folder is recognised by the scripts already in it; if it is empty,'
      Say 'there is nothing to go on. Report this with -Log and the Illustrator version.'
      $exitCode = 3
      exit 3
    }
    Warn 'No InDesign or Illustrator installation found. Install and launch one of them, then run this again.'
    $exitCode = 3
    exit 3
  }
  Log ("panels=" + ($panels -join ' | '))
  Log ("illustrator=" + (($aiDirs | ForEach-Object { $_.Dir }) -join ' | '))
  # 只要发生就说, 不是只在"什么都没找到"时才说。InDesign 在的时候, 原来的运行
  # 会一路走到一个欢快的汇总, 而 Illustrator 已经从所有计数里悄悄掉了出去 ——
  # 没有一行字, 没有原因, 也没有可搜的线索。下面的 exit 3 只覆盖两个都没有的情形。
  # 只在没有更具体的原因已经打印过时才说。上面的 locale 说明讲的是另一个成因,
  # 而同一个"缺席"给出两条解释, 读起来像两个问题。
  if ($Script:AiAppsSeen -gt 0 -and $aiDirs.Count -eq 0 -and $panels.Count -gt 0 -and -not $Script:AiLocaleNote) {
    Say '  Found Illustrator, but could not identify its Scripts folder - skipping it.'
  }

  # --- 状态 + 菜单 ------------------------------------------------------------
  $action = ''
  if ($Uninstall) { $action = 'uninstall' }
  elseif ($Repair) { $action = 'repair'; $Force = $true }
  elseif ($Install) { $action = 'install' }

  if (-not $action -and -not (Test-CanAsk)) { $action = 'install' }

  if (-not $action) {
    # 有本地 --source 时, 待装版本来自那个源自己的 manifest, 而不是网络。
    # 只走网络是错的, 而且错在最要紧的那条路: 两个一行命令引导脚本都已经下载完再
    # 传 --source, 于是那条路上永远读不到待装版本, 每个安装都显得是最新, 菜单永远
    # 给不出 "Update" —— 而那是几乎所有人走的路。靠人为造出版本不一致才发现;
    # 恰好本来就是最新的那种运行, 读数完全一样。
    $rver = $null
    if ($Source) {
      $rver = Get-LocalSourceVersion $Source
    } else {
      try { $rver = (Fetch-RemoteManifest (Resolve-RemoteUrls).Manifest).version } catch { }
    }
    # 进日志: 这个值决定菜单给不给 Update, 而它读空时屏幕上没有任何迹象。
    Log ("available version: " + $(if ($rver) { $rver } else { '(none read)' }) + " from " + $(if ($Source) { $Source } else { 'remote' }))
    $anyInstalled = $false; $allCurrent = $true
    Say ''
    foreach ($p in $panels) {
      $label = if ($p -match 'InDesign\\([^\\]+)\\([^\\]+)\\Scripts') { "$($Matches[1]) ($($Matches[2]))" } else { $p }
      $dst = Join-Path $p $INSTALL_FOLDER
      if ((Test-Path -LiteralPath $dst) -and (Get-Item -LiteralPath $dst -Force).LinkType) {
        Say ("  {0}: a link is in the way (development bridge) - rename or remove it and run again" -f $label)
        continue
      }
      $lv = Get-InstalledVersion $p
      if ($lv) {
        $anyInstalled = $true
        if ($rver -and $lv -ne $rver) { $allCurrent = $false; Say ("  {0}: installed v{1} - v{2} available" -f $label, $lv, $rver) }
        else { Say ("  {0}: installed v{1}" -f $label, $lv) }
      } else { $allCurrent = $false; Say ("  {0}: not installed" -f $label) }
    }
    foreach ($t in $aiDirs) {
      $dst = Join-Path $t.Dir $AI_FOLDER
      if ((Test-Path -LiteralPath $dst) -and (Get-Item -LiteralPath $dst -Force).LinkType) {
        Say ("  {0}: a link is in the way (development bridge) - rename or remove it and run again" -f $t.Label)
        continue
      }
      if (-not (Test-IllustratorWritable $t.Dir)) {
        # 既不算"已安装"也不算"要更新"。刻意【不】承诺接下来会怎样: 这次运行
        # 可能会问你要不要现在做, 也可能只打印命令 —— 写"见下方"在前一种情况下
        # 就是假话, 而状态行是在两者都还未定之前打印的。
        Say ("  {0}: not set up yet" -f $t.Label)
        continue
      }
      $lv = Get-IllustratorInstalledVersion $t.Dir
      if ($lv) {
        $anyInstalled = $true
        if ($rver -and $lv -ne $rver) { $allCurrent = $false; Say ("  {0}: installed v{1} - v{2} available" -f $t.Label, $lv, $rver) }
        else { Say ("  {0}: installed v{1}" -f $t.Label, $lv) }
      } else { $allCurrent = $false; Say ("  {0}: not installed" -f $t.Label) }
    }
    Say ''
    # 已是最新时就不提供"安装/更新"这一项 —— 它无事可做。一个什么都不做的条目仍然
    # 要被读、被排除、被理解; 而先前那个尝试 ("Reinstall (repair)") 连"什么都不做"
    # 都没做诚实: 它报成功、不改任何文件, 对一个正想修复的人来说是最坏的回答。
    # 删掉它, 好过把它的措辞写好。
    #
    # 编号跟着实际显示的条目走, 不固定, 免得留下一个空号让读者去猜。默认值也跟着走:
    # 没有可安装项时回车 = 退出, 因为 Repair 会重写文件, 那应当是被主动选择的。
    # 只提供有事可做的项。Repair / Uninstall 需要已有安装, Install 需要没有安装。
    # 一个用不上的条目仍然要被读、被理解、被排除, 而一旦被选中, 它只能报告一件没
    # 发生的事。编号与默认值都跟着实际显示的条目走, 不留空号。无需安装时回车 =
    # 退出: Repair 会重写文件, 应当被主动选择而不是回车掉进去。
    if (-not $anyInstalled) {
      Say '  1) Install'
      Say '  q) Quit'
      Say ''
      $choice = ''
      try { $choice = Read-Host '  Choose [1]' } catch { $choice = '' }
      switch -Regex ($choice.Trim()) {
        '^$|^1$' { $action = 'install' }
        '^[qQ]$' { Say ''; Ok 'Nothing was changed.'; exit 0 }
        default  { Say ''; Warn ("Not one of the choices: " + $choice); exit 2 }
      }
    } elseif (-not $allCurrent) {
      Say '  1) Update    - install the newer version'
      Say '  2) Repair    - rewrite the files even if the version already matches'
      Say '  3) Uninstall - remove the installed scripts'
      Say '  q) Quit'
      Say ''
      $choice = ''
      try { $choice = Read-Host '  Choose [1]' } catch { $choice = '' }
      switch -Regex ($choice.Trim()) {
        '^$|^1$' { $action = 'install' }
        '^2$'    { $action = 'repair'; $Force = $true }
        '^3$'    { $action = 'uninstall' }
        '^[qQ]$' { Say ''; Ok 'Nothing was changed.'; exit 0 }
        default  { Say ''; Warn ("Not one of the choices: " + $choice); exit 2 }
      }
    } else {
      Say '  1) Repair    - rewrite the files even if the version already matches'
      Say '  2) Uninstall - remove the installed scripts'
      Say '  q) Quit'
      Say ''
      $choice = ''
      # 不显示默认值。剩下的两个选项都会改动东西, 哪个都不该是回车的结果; 而提示
      # "[q]" 读起来像在建议你走开。
      try { $choice = Read-Host '  Choose' } catch { $choice = '' }
      switch -Regex ($choice.Trim()) {
        '^1$'       { $action = 'repair'; $Force = $true }
        '^2$'       { $action = 'uninstall' }
        '^$|^[qQ]$' { Say ''; Ok 'Nothing was changed.'; exit 0 }
        default     { Say ''; Warn ("Not one of the choices: " + $choice); exit 2 }
      }
    }
    Say ''
  }

  if ($action -eq 'uninstall') {
    $removed = 0; $blockedU = 0; $failedU = 0; $notOursId = 0
    $removedId = 0; $removedAi = 0   # per application, so the summary can name them
    $notOurs = 0
    foreach ($p in $panels) {
      switch (Uninstall-From $p) {
        'removed'      { $removed++; $removedId++; Log "uninstalled -> $p" }
        'would-remove' { $removed++; $removedId++; Log "would-uninstall -> $p" }
        'blocked'      { $blockedU++; Log "uninstall blocked(bridge) -> $p" }
        'failed'       { $failedU++ }
        'absent'       { }
        'not-ours'     { $notOursId++ }
        # 没有 default 的话, 任何没被列举的返回值会从每一个计数里消失, 而汇总
        # 就会描述一次它并不存在的运行。
        default        { $failedU++; Log "unhandled uninstall result '$_' -> $p" }
      }
    }
    $emptied = 0
    foreach ($t in $aiDirs) {
      switch (Uninstall-FromIllustrator $t.Dir) {
        'removed'      { $removed++; $removedAi++; Log "uninstalled -> $($t.Dir)" }
        'would-remove' { $removed++; $removedAi++ }
        'emptied'      { $removed++; $removedAi++; $emptied++ }
        # ⚠ 每个值只能有一个 arm。PowerShell 的 switch 没有 break 时会执行
        # 【所有】匹配的分支 —— 这里曾经有两个 'failed', 于是一处失败被记成两处
        # (实测 failedU=2)。default 只在无任何 arm 匹配时才跑。
        'not-ours'     { $notOurs++ }
        'blocked'      { $blockedU++ }
        'failed'       { $failedU++ }
        # 'absent' 是良性的: Illustrator 在, 我们的文件夹不在。它原来没有自己的
        # arm, 于是落进下面那个为【未知】返回值准备的 default, 被记成一次失败 ——
        # 每台装了 Illustrator 却还没装脚本的机器, 卸载都报 "failed 1"。实测。
        'absent'       { }
        default        { $failedU++; Log "unhandled uninstall result '$_' -> $($t.Dir)" }
      }
    }
    Say ''
    if ($emptied -gt 0) {
      # "emptied" 只在文件夹删不掉时返回 —— 在 Windows 上, 我们对它有 F 权限,
      # 删目录本身不需要管理员(实测: 父目录只读时照样删得掉)。删不掉的原因是
      # 里面还有别人放的东西。原句断言了"空"和"要管理员"两件事, 两件都不成立。
      Say ("The scripts were removed from {0} Illustrator location(s). The {1} folder itself was left behind - it still holds something that is not ours." -f $emptied, $AI_FOLDER)
    }
    if ($notOursId -gt 0) { Say ("Left alone: {0} {1} folder(s) with no version marker - this installer did not create them, so it will not remove them." -f $notOursId, $INSTALL_FOLDER) }
    if ($blockedU -gt 0) { Warn ("Skipped {0} location(s): {1} there is a link, not a folder." -f $blockedU, $INSTALL_FOLDER) }
    if ($DryRun) { Ok ("[dry run] Would remove {0} installation(s). Nothing was written." -f $removed) }
    elseif ($failedU -gt 0) {
      Err ("Removed {0}, failed {1} - the application may have the files open. Close it and try again." -f $removed, $failedU)
      $exitCode = 1
    }
    elseif ($removed -gt 0) {
      $uapps = @()
      if ($removedId -gt 0) { $uapps += 'InDesign' }
      if ($removedAi -gt 0) { $uapps += 'Illustrator' }
      $uname = if ($uapps.Count -gt 0) { $uapps -join ' and ' } else { 'the application' }
      Ok ("Removed {0} installation(s). Restart {1} for the menu to catch up." -f $removed, $uname)
    }
    else { Ok 'Nothing to remove - no installation was found.' }
    exit $exitCode
  }

  # 远端预检 (设计 §2.2): 只取小 manifest, 若所有面板已是该版本则直接收工,
  # 不下载整包 (否则每次"检查更新"都白拉 ~6MB)。仅远端 + 非 DryRun 时生效;
  # 本地源无此开销。预检失败(离线/无 manifest)则回落到完整 acquire, 由那里
  # 报真实网络错误 —— 预检绝不阻断正常流程。逐面板 skip 仍是最终权威闸门。
  if (-not $Source -and -not $DryRun) {
    try {
      $rm = Fetch-RemoteManifest (Resolve-RemoteUrls).Manifest
      if (-not (Test-PanelsNeedUpdate $panels $rm.version $aiDirs)) {
        Say ''
        # 这条退出发生在下载任何东西之前, 所以它也正是会把"还没做一次性设置的
        # Illustrator 目标"静默吞掉的那条。而一句光秃秃的"已是最新版本"是在替
        # 一个根本没装上的目标说话。
        $pending = @($aiDirs | Where-Object {
          $d = Join-Path $_.Dir $AI_FOLDER
          -not ((Test-Path -LiteralPath $d) -and (Get-Item -LiteralPath $d -Force).LinkType) -and
          -not (Test-IllustratorWritable $_.Dir)
        }).Count
        if ($pending -gt 0) {
          Ok ("Up to date (v{0}) everywhere it could be installed - but {1} Illustrator location(s) still need the one-time step below." -f $rm.version, $pending)
          [void](Show-PendingIllustratorSetup $aiDirs)
        } elseif ($Script:AiLocaleNote -and $aiDirs.Count -eq 0) {
          Ok ("Up to date (v{0}) for InDesign. Illustrator was skipped, see above." -f $rm.version)
        } else {
          Ok ("Already up to date (v{0})." -f $rm.version)
        }
        exit 0
      }
      Log "preflight: update needed -> v$($rm.version)"
    } catch {
      Log "preflight skipped: $($_.Exception.Message)"
    }
  }

  $dist = Acquire-Distribution
  $work = $dist.Work
  $root = $dist.Root

  $manifestPath = Join-Path $root $MANIFEST_NAME
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $version = $manifest.version
  $payloadDir = Join-Path $root $PAYLOAD_SUBDIR
  if (-not (Test-Path $payloadDir)) { throw "The distribution has no '$PAYLOAD_SUBDIR' folder" }

  # 校验完整性
  $bad = Verify-Payload $manifest $payloadDir
  if ($bad.Count -gt 0) {
    Err 'The downloaded files failed verification. Nothing was changed. Try again, or ask IT.'
    $bad | Select-Object -First 5 | ForEach-Object { Log "verify: $_" }
    # $exitCode, not just `exit`. The finally block decides whether to print
    # "how to save a diagnostic log" from $exitCode, and these exits used to
    # jump out with it still 0 - so the one failure whose diagnosis most needs
    # a log was the one that never mentioned how to produce one.
    $exitCode = 4
    exit 4
  }
  Log "verify OK: $($manifest.files.Count) files, v$version"

  # 逐面板安装。每个面板独立 try/catch: 一个面板换入失败 (常见: InDesign 正
  # 占用某文件) 会在 Install-Into 内回滚到旧版, 不应中止其它面板, 也不应让主
  # catch 打印"什么都没改"(对已成功的面板是假话)。
  $installed = 0; $skipped = 0; $wouldInstall = 0; $failed = 0
  $failedWhere = @()
  $blocked = @()
  foreach ($p in $panels) {
    try {
      $r = Install-Into $p $payloadDir $version
      switch ($r) {
        'blocked'        { $blocked += (Join-Path $p $INSTALL_FOLDER); Log "blocked(bridge) -> $p" }
        'installed'      { $installed++;    Log "installed -> $p"; try { Remove-LegacyFolder $p } catch { Log ("legacy cleanup failed -> $p : " + $_.Exception.Message) } }
        # skip 也要清。原来只挂在 installed 上, 于是一台已经是当前版本的机器
        # 永远不会执行它 —— 而一个从备份恢复回来的旧名字文件夹会永远留在面板里。
        'skip'           { $skipped++;      Log "skip(latest) -> $p"; try { Remove-LegacyFolder $p } catch { Log ("legacy cleanup failed -> $p : " + $_.Exception.Message) } }
        'would-install'  { $wouldInstall++; Log "would-install -> $p" }
      }
    } catch {
      $failed++
      # 说出是哪一处。"1 处失败"对一台装了两个 InDesign 版本的机器没有信息量,
      # 而"关掉那个应用"没有指名任何应用。
      $failedWhere += $p
      Log "install FAILED -> $p : $($_.Exception.Message)"
    }
  }

  # Illustrator: 自己的载荷、自己的 manifest、自己的校验。共用 InDesign 那次
  # 校验会让一个绿勾代表两组不同的字节, 而其中只有一组真被算过哈希。
  $aiInstalled = 0; $aiSkipped = 0; $aiWould = 0; $aiFailed = 0; $aiSetup = 0
  $aiVerifyFailed = $false
  $aiPayloadDir = Join-Path $root $AI_PAYLOAD_SUBDIR
  $aiManifestPath = Join-Path $root $AI_MANIFEST_NAME

  # 顺序是有意的: 先校验, 再提权, 最后安装。
  # 原来的顺序是先提权后校验 —— 用户会看到 UAC、批准它、然后校验失败什么也没装,
  # 而权限已经改了。macOS 侧一直是对的(它的 grant 循环闸在 AI_OK 上), 那条注释
  # 也写着"只在确实有一份校验过的载荷要装时才问", 只是 Windows 侧没照做。
  $aiOk = $false
  if ($aiDirs.Count -gt 0) {
    if (-not (Test-Path $aiPayloadDir) -or -not (Test-Path $aiManifestPath)) {
      # 旧分发包没有 Illustrator 那一半。说出来并继续做 InDesign, 而不是让一次
      # 还能完成大半工作的运行整体失败。
      Say '  (this package has no Illustrator scripts; skipping Illustrator)'
    } else {
      # 解析和校验都可能抛(坏 JSON、缺 sha256 字段)。这里在 InDesign 循环【之后】,
      # 不接住的话它会落进最外层 catch, 打印 "Your existing scripts are unchanged" ——
      # 而 InDesign 刚刚被更新过。当作校验失败处理, 和坏哈希同一条路。
      $aiBad = @()
      try {
        $aiManifest = Get-Content $aiManifestPath -Raw | ConvertFrom-Json
        $aiBad = @(Verify-Payload $aiManifest $aiPayloadDir)
      } catch {
        $aiBad = @('manifest unreadable: ' + $_.Exception.Message)
      }
      if ($aiBad.Count -gt 0) {
        Err 'The Illustrator files failed verification; nothing was written to Illustrator.'
        $aiBad | Select-Object -First 5 | ForEach-Object { Log "verify(ai): $_" }
        # 单独一个标志, 不并进 $aiFailed。并进去的话汇总会说"应用可能占着文件,
        # 关掉它再跑一次" —— 而这是一次坏下载, 关应用没有用; 而且"1 处失败"会
        # 在没有任何位置失败时报出一个位置计数。
        $aiVerifyFailed = $true
      } else {
        Log "verify OK (illustrator): $($aiManifest.files.Count) files"
        $aiOk = $true
      }
    }
  }

  # 校验过了才问那一次性管理员步骤。拒绝不算失败: 运行照常继续, 那条命令仍会在
  # 末尾打印出来。
  if ($aiOk -and -not $DryRun) {
    foreach ($t in $aiDirs) {
      $d = Join-Path $t.Dir $AI_FOLDER
      if ((Test-Path -LiteralPath $d) -and (Get-Item -LiteralPath $d -Force).LinkType) { continue }
      if (Test-IllustratorWritable $t.Dir) { continue }
      [void](Invoke-IllustratorGrant $t.Dir $t.Label)
    }
  }

  if ($aiOk) {
    foreach ($t in $aiDirs) {
      try {
        switch (Install-IntoIllustrator $t.Dir $aiPayloadDir $version) {
          'blocked'       { $blocked += (Join-Path $t.Dir $AI_FOLDER); Log "blocked(bridge) -> $($t.Dir)" }
          'installed'     { $aiInstalled++;     Log "installed -> $($t.Dir)" }
          'skip'          { $aiSkipped++ }
          'would-install' { $aiWould++ }
          'needs-setup'   { $aiSetup++ }
          'failed'        { $aiFailed++ }
          default         { $aiFailed++; Log "unhandled illustrator result '$_' -> $($t.Dir)" }
        }
      } catch {
        $aiFailed++
        Log "illustrator install FAILED -> $($t.Dir) : $($_.Exception.Message)"
      }
    }
  }

  # 两个应用的合计。只报 InDesign 的数字, 会让一次纯 Illustrator 安装在刚写完
  # 五个文件之后打印"已是最新版本"。
  $idInstalled  = $installed          # 保留分应用的数, 见下面的重启提示
  $installed    = $installed    + $aiInstalled
  $skipped      = $skipped      + $aiSkipped
  $wouldInstall = $wouldInstall + $aiWould
  $failed       = $failed       + $aiFailed

  Say ''
  if ($blocked.Count -gt 0) {
    # 文件夹名现在按条目走。原来每条都按 $INSTALL_FOLDER 打印, 于是一个被挡下的
    # Illustrator 目标被报在一个不存在的路径上 —— 而"改名或移除那个链接"是整段
    # 里唯一一条指令, 却指向了空处。
    Warn ("Skipped {0} location(s): the toolkit folder there is a link, not a folder." -f $blocked.Count)
    Say  'Nothing was written there, so a link to a working copy cannot be destroyed.'
    Say  ''
    $blocked | ForEach-Object { Say ("  " + $_) }
    Say  ''
    Say  ("Rename or remove that link and run again." -f $INSTALL_FOLDER)
    Say  ''
  }
  if ($DryRun) {
    # 两个数都报。"Would install into 0 locations" 单独出现读起来像"什么都没找到",
    # 而真实原因是每个位置都已是最新 —— 同一句话背后是两件完全不同的事。
    if ($wouldInstall -eq 0 -and $skipped -gt 0) {
      Ok ("[dry run] Nothing to do: {0} location(s) already have v{1}." -f $skipped, $version)
    } else {
      Ok ("[dry run] Would install into {0} location(s) (v{1}); {2} already current. Nothing was written." -f $wouldInstall, $version, $skipped)
    }
  } elseif ($failed -gt 0 -and $installed -gt 0) {
    Warn ("Updated to v{0} in some locations, but {1} failed - the application may have the files open. Close it and run again." -f $version, $failed)
    $failedWhere | ForEach-Object { Say ("  " + $_) }
    $exitCode = 1
  } elseif ($failed -gt 0) {
    Err ("Update failed in {0} location(s); nothing was updated. Your existing scripts are unchanged. Close the application and run again, or ask IT." -f $failed)
    $failedWhere | ForEach-Object { Say ("  " + $_) }
    $exitCode = 1
  } elseif ($installed -gt 0) {
    # 分应用点名: 对一个同时开着两个应用、只有一个被改动的人来说,
    # "重启该应用"是没有信息量的。
    # 一句话。应用仍然点名 —— 对同时开着两个、只有一个被改的人来说 "重启该应用"
    # 没有信息量 —— 但点名只占一个从句, 不必各占一行。
    $apps = @()
    if ($idInstalled -gt 0) { $apps += 'InDesign' }
    if ($aiInstalled -gt 0) { $apps += 'Illustrator' }
    Ok ("Installed v{0} - restart {1} to see the scripts." -f $version, ($apps -join ' and '))
    if ($Script:AiLocaleNote -and $aiDirs.Count -eq 0) { Say '(Illustrator was skipped, see above)' }
    if ($aiVerifyFailed) {
      Warn '(the Illustrator scripts failed verification and were not installed - that is a bad download; run this again)'
      $exitCode = 1
    }
    # 由 $Owner/$Repo 推导, 不写死: 写死等于让仓库名多一个存放处, 而那一处正是
    # 改名时永远不会被跟着改的那一处。只在真装了东西的路径上出现 —— 对一台本来
    # 就是最新的机器重跑一次, 那不是一个"接下来做什么"的时刻。
    # 怎么打开它。终端里的链接不是网页里的链接 —— 没在这里点开过的人会当它是
    # 一段文字。Windows 终端是 Ctrl+单击; macOS 那边是选中后右键"打开", 措辞
    # 各自不同, 所以两个脚本各说各的, 不共用一句。
    Say 'What to do next - Ctrl+click the link:'
    Say ("  https://{0}.github.io/{1}/guide/workflow" -f $Owner, $Repo)
    if ($skipped -gt 0) { Say ("({0} location(s) were already up to date)" -f $skipped) }
    if ($blocked.Count -gt 0) { Say ("({0} location(s) were skipped, see above)" -f $blocked.Count) }
  } elseif ($blocked.Count -gt 0) {
    # 说发生了什么, 不说打算发生什么。这里原先落进下面的 else, 于是在一个字都没
    # 写入的情况下打印"已是最新版本" —— 用户会据此认为脚本已经装好了。
    Warn ("Nothing was installed: all {0} location(s) were skipped, see above." -f $blocked.Count)
    $exitCode = 1
  } elseif ($aiVerifyFailed) {
    Err 'Nothing was installed: the Illustrator scripts failed verification.'
    Say 'That is a bad download, not a problem with this machine - run this again.'
    $exitCode = 1
  } elseif ($aiSetup -gt 0 -and $skipped -eq 0) {
    # 一个字都没写、也没有任何位置本来就是最新的 —— 那么"已是最新版本"是假话。
    # 挡在路上的那一件, 就在下面。
    Warn 'Nothing was installed yet.'
  } elseif ($aiSetup -gt 0) {
    # 光说"已是最新版本"是在替一个没被写入、也写不进去的目标背书; 三行之后又
    # 出现"is not set up yet", 读起来自相矛盾 —— 而人记住的是标题那句。
    Ok ("Up to date (v{0}) everywhere it could be installed - but {1} Illustrator location(s) still need the one-time step below." -f $version, $aiSetup)
  } elseif ($Script:AiLocaleNote -and $aiDirs.Count -eq 0) {
    # 上面那条说明讲了 Illustrator 为什么被跳过, 但光秃秃的 "Already up to date"
    # 是一句关于全部的断言 —— 而人记住的是标题那句。
    Ok ("Up to date (v{0}) for InDesign. Illustrator was skipped, see above." -f $version)
  } else {
    Ok ("Already up to date (v{0})." -f $version)
  }

  # 放在最后打印: 这次运行里它是唯一还需要人去做的事, 不该被上面的汇总顶掉。
  if ($aiSetup -gt 0) { [void](Show-PendingIllustratorSetup $aiDirs) }
}
catch {
  Err 'A network or installation error stopped the update. Your existing scripts are unchanged. Try again, or ask IT.'
  Log ("ERROR: " + $_.Exception.Message)
  $exitCode = 1
}
finally {
  # 成功即删临时下载区。(.bak 仅在换入失败回滚时短暂存在, 成功路径已清)
  if ($work -and (Test-Path $work)) {
    try { Remove-Item $work -Recurse -Force } catch {}
  }
  # 诊断日志: 只在被要求时落盘, 落到桌面, 每次一个带时间戳的新文件 (不追加, 不增长)。
  if ($Script:LogEnabled) {
    try {
      $dir = [Environment]::GetFolderPath('Desktop')
      if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { $dir = $env:USERPROFILE }
      $logPath = Join-Path $dir ('creative-script-installer-log-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
      $head = @(
        ('creative-script-installer log  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
        ('windows ' + [Environment]::OSVersion.Version + '  powershell ' + $PSVersionTable.PSVersion),
        ('source=' + $Source + '  force=' + $Force + ' dryrun=' + $DryRun +
         ' install=' + $Install + ' repair=' + $Repair + ' uninstall=' + $Uninstall),
        ''
      )
      ($head + $Script:LogLines) | Out-File -LiteralPath $logPath -Encoding UTF8
      Write-Host ''
      Say ("Diagnostic log saved to: " + $logPath)
    } catch {
      Write-Host ''
      Warn ("Could not write the diagnostic log: " + $_.Exception.Message)
    }
  }
  elseif ($exitCode -ne 0) {
    # 说清怎么拿到日志, 而不是让人事后去猜哪里有一个。这条只在真出事时出现。
    Write-Host ''
    Say 'To save a diagnostic log for troubleshooting, run:'
    # 反引号是必须的: 双引号串里 $env:CSI_LOG 会被展开成空, 打印出来的命令就没了
    # 那个变量 —— 一条看起来正常、照抄却不起作用的指令。
    Say ("  `$env:CSI_LOG='1'; irm https://raw.githubusercontent.com/$Owner/$Repo/$Ref/install.ps1 | iex")
  }
}

exit $exitCode
