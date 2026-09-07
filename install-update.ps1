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
function Say([string]$m)   { Write-Host $m }
function Ok([string]$m)    { Write-Host $m -ForegroundColor Green }
function Warn([string]$m)  { Write-Host $m -ForegroundColor Yellow }
function Err([string]$m)   { Write-Host $m -ForegroundColor Red }

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
  $headers = @{}
  if ($env:TOOLKIT_AUTH_TOKEN) { $headers['Authorization'] = "token $($env:TOOLKIT_AUTH_TOKEN)" }
  Invoke-WebRequest -Uri $url -OutFile $outFile -Headers $headers -UseBasicParsing
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
  $json = Invoke-WebRequest -Uri $manifestUrl -Headers $headers -UseBasicParsing
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
    if (-not (Test-Path -LiteralPath $dst)) { continue }
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
  Say ("(removed a previous installation under the old name {0})" -f $LEGACY_FOLDER)
  Log "removed previous install $LEGACY_FOLDER"
}

# 卸载。与安装同一道护栏, 理由相同: 这里若是链接, 那是开发桥接, 删掉等于抽走
# 别人与工作树的连接 —— 而那样的卸载看起来完全成功。
function Uninstall-From([string]$panelDir) {
  $dst = Join-Path $panelDir $INSTALL_FOLDER
  if (-not (Test-Path -LiteralPath $dst)) { return 'absent' }
  if ((Get-Item -LiteralPath $dst -Force).LinkType) { return 'blocked' }
  if ($DryRun) { return 'would-remove' }
  try { Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction Stop; return 'removed' }
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
  foreach ($d in (Get-ChildItem -LiteralPath $localeDir -Directory -ErrorAction SilentlyContinue)) {
    if (@(Get-ChildItem -LiteralPath $d.FullName -Filter *.jsx -File -ErrorAction SilentlyContinue).Count -gt 0) {
      return $d.FullName
    }
  }
  return $null
}

function Get-IllustratorPreferredLocale {
  # Illustrator 自己在首次启动时写下这个目录, 所以它反映的是 Illustrator 实际
  # 在用的语言 —— 而不是系统语言(那是另一个问题, 只是常常同解)。
  $base = Join-Path $env:APPDATA 'Adobe'
  if (-not (Test-Path -LiteralPath $base)) { return $null }
  foreach ($d in (Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -like 'Adobe Illustrator * Settings' })) {
    $l = @(Get-ChildItem -LiteralPath $d.FullName -Directory -ErrorAction SilentlyContinue)
    if ($l.Count -gt 0) { return $l[0].Name }
  }
  return $null
}

function Find-IllustratorDirs {
  $out = @()
  $root = if ($env:CSI_APP_ROOT) { $env:CSI_APP_ROOT } else { Join-Path $env:ProgramFiles 'Adobe' }
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  $pref = Get-IllustratorPreferredLocale
  foreach ($app in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like 'Adobe Illustrator*' })) {
    $presets = Join-Path $app.FullName 'Presets'
    if (-not (Test-Path -LiteralPath $presets)) { continue }
    $ver = $app.Name -replace '^Adobe Illustrator\s*', ''
    # 优先 Illustrator 记下的那个 locale; 认不出就全都装。装进一个它不读的
    # locale 只是无害的多余, 一个都没装才是静默的空操作。
    $locales = @()
    if ($pref -and (Test-Path -LiteralPath (Join-Path $presets $pref))) {
      $locales = @(Get-Item -LiteralPath (Join-Path $presets $pref))
    } else {
      $locales = @(Get-ChildItem -LiteralPath $presets -Directory -ErrorAction SilentlyContinue)
    }
    foreach ($l in $locales) {
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
  try {
    Get-ChildItem -LiteralPath $dst -Filter *.jsx -File -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $dst $VERSION_MARKER) -Force -ErrorAction SilentlyContinue
    # 删掉这个目录本身要父目录的写权限, 我们没有也不要。有的机器碰巧有, 那就删掉;
    # 没有就留一个空目录并【说出来】—— 被告知"已移除"却发现它还在, 任何人都会
    # 认为卸载失败了, 而真正的原因他猜不到。
    Remove-Item -LiteralPath $dst -Force -ErrorAction Stop
    return 'removed'
  } catch { return 'emptied' }
}

function Invoke-IllustratorGrant([string]$scriptsDir, [string]$label) {
  $dst = Join-Path $scriptsDir $AI_FOLDER
  $who = "$env:USERDOMAIN\$env:USERNAME"
  # 没人可问就别问。无人值守的运行不该停在一个没人会看到的提示上。
  if (-not (Test-CanAsk)) { return $false }

  Say ''
  Say ("{0} needs one administrator step, once. It will run, elevated:" -f $label)
  Say ''
  Say ("    New-Item -ItemType Directory -Force -Path '{0}'" -f $dst)
  Say ("    icacls '{0}' /grant '{1}:(OI)(CI)F'" -f $dst, $who)
  Say ''
  Say '  That creates one folder inside the application and gives you access to it.'
  Say '  It changes nothing else, and it is the only time this is needed.'
  $ans = ''
  try { $ans = Read-Host '  Do it now? [Y/n]' } catch { return $false }
  if ($ans -match '^\s*[nN]') { Say '  Skipped.'; return $false }

  $inner = "New-Item -ItemType Directory -Force -Path '$dst' | Out-Null; icacls '$dst' /grant '$($who):(OI)(CI)F' | Out-Null"
  try {
    # Windows 的"提权"是 UAC 弹窗, 不是终端里输密码。触发它并【等它结束】——
    # 不等的话下面那句可写性检查会在授权发生之前就跑完, 然后报一个假的失败。
    # 安装器本身仍然不是以管理员身份运行的: 被提权的只有这一条命令。
    Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden `
      -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner -ErrorAction Stop
  } catch {
    # 取消 UAC 也走这里 —— 那不是错误, 是一个回答。
    Say ''
    Say '  That did not go through - nothing was changed.'
    return $false
  }

  # 不把退出码当答案。检查真正需要的东西: 一个写得进去的文件夹。
  if (Test-IllustratorWritable $scriptsDir) {
    Say '  Done. This will not be needed again.'
    return $true
  }
  Say '  The command reported success, but the folder still is not writable.'
  return $false
}

function Show-IllustratorSetup([string]$scriptsDir) {
  $dst = Join-Path $scriptsDir $AI_FOLDER
  $who = "$env:USERDOMAIN\$env:USERNAME"
  $inner = "New-Item -ItemType Directory -Force -Path '$dst' | Out-Null; icacls '$dst' /grant '$($who):(OI)(CI)F' | Out-Null"
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
  if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
  return 'installed'
}

# ==================================================================
# 主流程
# ==================================================================
$exitCode = 0
$work = $null
try {
  Say ''
  Say 'Checking for updates...'

  $panels = Find-ScriptsPanelDirs
  $aiDirs = @(Find-IllustratorDirs)
  # 只有两个都没有才收工。原来在"没有 InDesign"就退出, 会让一台只装了
  # Illustrator 的机器看起来像什么都没装。
  if ($panels.Count -eq 0 -and $aiDirs.Count -eq 0) {
    Warn 'No InDesign or Illustrator installation found. Install and launch one of them, then run this again.'
    exit 3
  }
  Log ("panels=" + ($panels -join ' | '))
  Log ("illustrator=" + (($aiDirs | ForEach-Object { $_.Dir }) -join ' | '))

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
      try {
        $lm = Get-ChildItem -Path $Source -Recurse -Filter $MANIFEST_NAME -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($lm) { $rver = (Get-Content $lm.FullName -Raw | ConvertFrom-Json).version }
      } catch { }
    } else {
      try { $rver = (Fetch-RemoteManifest (Resolve-RemoteUrls).Manifest).version } catch { }
    }
    $anyInstalled = $false; $allCurrent = $true
    Say ''
    foreach ($p in $panels) {
      $label = if ($p -match 'InDesign\\([^\\]+)\\([^\\]+)\\Scripts') { "$($Matches[1]) ($($Matches[2]))" } else { $p }
      $dst = Join-Path $p $INSTALL_FOLDER
      if ((Test-Path -LiteralPath $dst) -and (Get-Item -LiteralPath $dst -Force).LinkType) {
        Say ("  {0}: a link is in the way (development bridge) - see DEV-BRIDGE.md" -f $label)
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
        Say ("  {0}: a link is in the way (development bridge) - see DEV-BRIDGE.md" -f $t.Label)
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
    $removed = 0; $blockedU = 0; $failedU = 0
    foreach ($p in $panels) {
      switch (Uninstall-From $p) {
        'removed'      { $removed++;  Log "uninstalled -> $p" }
        'would-remove' { $removed++;  Log "would-uninstall -> $p" }
        'blocked'      { $blockedU++; Log "uninstall blocked(bridge) -> $p" }
        'failed'       { $failedU++ }
      }
    }
    $emptied = 0
    foreach ($t in $aiDirs) {
      switch (Uninstall-FromIllustrator $t.Dir) {
        'removed'      { $removed++;  Log "uninstalled -> $($t.Dir)" }
        'would-remove' { $removed++ }
        'emptied'      { $removed++; $emptied++ }
        'blocked'      { $blockedU++ }
        'failed'       { $failedU++ }
      }
    }
    Say ''
    if ($emptied -gt 0) {
      Say ("The scripts were removed from {0} Illustrator location(s); the now-empty {1} folder stays, because deleting it needs an administrator." -f $emptied, $AI_FOLDER)
    }
    if ($blockedU -gt 0) { Warn ("Skipped {0} location(s): {1} there is a link, not a folder." -f $blockedU, $INSTALL_FOLDER) }
    if ($DryRun) { Ok ("[dry run] Would remove {0} installation(s). Nothing was written." -f $removed) }
    elseif ($failedU -gt 0) {
      Err ("Removed {0}, failed {1} - InDesign may have the files open. Close it and try again." -f $removed, $failedU)
      $exitCode = 1
    }
    elseif ($removed -gt 0) { Ok ("Removed {0} installation(s). Restart InDesign for the panel to catch up." -f $removed) }
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
    exit 4
  }
  Log "verify OK: $($manifest.files.Count) files, v$version"

  # 逐面板安装。每个面板独立 try/catch: 一个面板换入失败 (常见: InDesign 正
  # 占用某文件) 会在 Install-Into 内回滚到旧版, 不应中止其它面板, 也不应让主
  # catch 打印"什么都没改"(对已成功的面板是假话)。
  $installed = 0; $skipped = 0; $wouldInstall = 0; $failed = 0
  $blocked = @()
  foreach ($p in $panels) {
    try {
      $r = Install-Into $p $payloadDir $version
      switch ($r) {
        'blocked'        { $blocked += $p;  Log "blocked(bridge) -> $p" }
        'installed'      { $installed++;    Log "installed -> $p"; Remove-LegacyFolder $p }
        'skip'           { $skipped++;      Log "skip(latest) -> $p" }
        'would-install'  { $wouldInstall++; Log "would-install -> $p" }
      }
    } catch {
      $failed++
      Log "install FAILED -> $p : $($_.Exception.Message)"
    }
  }

  # Illustrator: 自己的载荷、自己的 manifest、自己的校验。共用 InDesign 那次
  # 校验会让一个绿勾代表两组不同的字节, 而其中只有一组真被算过哈希。
  $aiInstalled = 0; $aiSkipped = 0; $aiWould = 0; $aiFailed = 0; $aiSetup = 0
  $aiPayloadDir = Join-Path $root $AI_PAYLOAD_SUBDIR
  $aiManifestPath = Join-Path $root $AI_MANIFEST_NAME

  # 那一次性管理员步骤在这里问 —— 在安装循环【之前】, 只问一次, 且只在确实有
  # 一份校验过的载荷要装、又确实有人可问的时候。拒绝不算失败: 运行照常继续,
  # 那条命令仍会在末尾打印出来, 和以前一样。
  if ($aiDirs.Count -gt 0 -and -not $DryRun -and (Test-Path $aiPayloadDir)) {
    foreach ($t in $aiDirs) {
      $d = Join-Path $t.Dir $AI_FOLDER
      if ((Test-Path -LiteralPath $d) -and (Get-Item -LiteralPath $d -Force).LinkType) { continue }
      if (Test-IllustratorWritable $t.Dir) { continue }
      [void](Invoke-IllustratorGrant $t.Dir $t.Label)
    }
  }
  if ($aiDirs.Count -gt 0) {
    if (-not (Test-Path $aiPayloadDir) -or -not (Test-Path $aiManifestPath)) {
      # 旧分发包没有 Illustrator 那一半。说出来并继续做 InDesign, 而不是让一次
      # 还能完成大半工作的运行整体失败。
      Say '  (this package has no Illustrator scripts; skipping Illustrator)'
    } else {
      $aiManifest = Get-Content $aiManifestPath -Raw | ConvertFrom-Json
      $aiBad = Verify-Payload $aiManifest $aiPayloadDir
      if ($aiBad.Count -gt 0) {
        Err 'The Illustrator files failed verification; nothing was written to Illustrator.'
        $aiBad | Select-Object -First 5 | ForEach-Object { Log "verify(ai): $_" }
      } else {
        Log "verify OK (illustrator): $($aiManifest.files.Count) files"
        foreach ($t in $aiDirs) {
          try {
            switch (Install-IntoIllustrator $t.Dir $aiPayloadDir $version) {
              'blocked'       { $blocked += $t.Dir; Log "blocked(bridge) -> $($t.Dir)" }
              'installed'     { $aiInstalled++;     Log "installed -> $($t.Dir)" }
              'skip'          { $aiSkipped++ }
              'would-install' { $aiWould++ }
              'needs-setup'   { $aiSetup++ }
              'failed'        { $aiFailed++ }
            }
          } catch {
            $aiFailed++
            Log "illustrator install FAILED -> $($t.Dir) : $($_.Exception.Message)"
          }
        }
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
    Warn ("Skipped {0} location(s): {1} there is a link, not a folder." -f $blocked.Count, $INSTALL_FOLDER)
    Say  'Nothing was written there, so a link to a working copy cannot be destroyed.'
    Say  ''
    $blocked | ForEach-Object { Say ("  " + (Join-Path $_ $INSTALL_FOLDER)) }
    Say  ''
    Say  ("Rename or remove that link and run again." -f $INSTALL_FOLDER)
    Say  'See DEV-BRIDGE.md in the repository.'
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
    $exitCode = 1
  } elseif ($failed -gt 0) {
    Err ("Update failed in {0} location(s); nothing was updated. Your existing scripts are unchanged. Close the application and run again, or ask IT." -f $failed)
    $exitCode = 1
  } elseif ($installed -gt 0) {
    # 分应用点名: 对一个同时开着两个应用、只有一个被改动的人来说,
    # "重启该应用"是没有信息量的。
    if ($idInstalled -gt 0) { Ok ("Updated InDesign to v{0}. Restart InDesign to see the scripts in the Scripts panel." -f $version) }
    if ($aiInstalled -gt 0) { Ok ("Updated Illustrator to v{0}. Restart Illustrator to see them under File > Scripts." -f $version) }
    if ($skipped -gt 0) { Say ("({0} location(s) were already up to date)" -f $skipped) }
    if ($blocked.Count -gt 0) { Say ("({0} location(s) were skipped, see above)" -f $blocked.Count) }
  } elseif ($blocked.Count -gt 0) {
    # 说发生了什么, 不说打算发生什么。这里原先落进下面的 else, 于是在一个字都没
    # 写入的情况下打印"已是最新版本" —— 用户会据此认为脚本已经装好了。
    Warn ("Nothing was installed: all {0} location(s) were skipped, see above." -f $blocked.Count)
    $exitCode = 1
  } elseif ($aiSetup -gt 0 -and $skipped -eq 0) {
    # 一个字都没写、也没有任何位置本来就是最新的 —— 那么"已是最新版本"是假话。
    # 挡在路上的那一件, 就在下面。
    Warn 'Nothing was installed yet.'
  } elseif ($aiSetup -gt 0) {
    # 光说"已是最新版本"是在替一个没被写入、也写不进去的目标背书; 三行之后又
    # 出现"is not set up yet", 读起来自相矛盾 —— 而人记住的是标题那句。
    Ok ("Up to date (v{0}) everywhere it could be installed - but {1} Illustrator location(s) still need the one-time step below." -f $version, $aiSetup)
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
