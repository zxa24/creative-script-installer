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
  ------------------------------------------------------------------
#>
[CmdletBinding()]
param(
  [string]$Source        = $env:TOOLKIT_SOURCE,   # 本地 zip 或目录 (最高优先)
  [switch]$Force,                                 # 版本相同也重装
  [switch]$DryRun,                                # 只探测+校验, 不写任何文件
  [switch]$Install,                               # 跳过菜单, 直接装/更新
  [switch]$Repair,                                # 重装当前版本 (= Force)
  [switch]$Uninstall                              # 移除已安装的脚本
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

# 任一探测到的面板未装 / 版本不符 → 需要更新 (Force 恒为真)。
function Test-PanelsNeedUpdate($panels, [string]$version) {
  if ($Force) { return $true }
  foreach ($p in $panels) {
    $marker = Join-Path (Join-Path $p $INSTALL_FOLDER) $VERSION_MARKER
    if (-not (Test-Path $marker)) { return $true }
    try { $cur = (Get-Content $marker -Raw | ConvertFrom-Json).version } catch { return $true }
    if ($cur -ne $version) { return $true }
  }
  return $false
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
  if ($item.LinkType) { Log "keep $LEGACY_FOLDER (it is a $($item.LinkType), not ours)"; return }
  if (-not (Test-Path -LiteralPath (Join-Path $old $VERSION_MARKER))) {
    Log "keep $LEGACY_FOLDER (no version marker; not installed by us)"; return
  }
  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
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
  if ($panels.Count -eq 0) {
    Warn 'No InDesign installation found. Install and launch InDesign once, then run this again.'
    exit 3
  }
  Log ("panels=" + ($panels -join ' | '))

  # --- 状态 + 菜单 ------------------------------------------------------------
  $action = ''
  if ($Uninstall) { $action = 'uninstall' }
  elseif ($Repair) { $action = 'repair'; $Force = $true }
  elseif ($Install) { $action = 'install' }

  if (-not $action -and -not (Test-CanAsk)) { $action = 'install' }

  if (-not $action) {
    $rver = $null
    if (-not $Source) {
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
    Say ''
    if ($anyInstalled -and $allCurrent) { Say '  1) Reinstall (repair)' }
    elseif ($anyInstalled)              { Say '  1) Update' }
    else                                { Say '  1) Install' }
    Say '  2) Repair    - reinstall, replacing whatever is there'
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
    Say ''
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
      if (-not (Test-PanelsNeedUpdate $panels $rm.version)) {
        Say ''
        Ok ("Already up to date (v{0})." -f $rm.version)
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
    Warn ("Updated to v{0} in some locations, but {1} failed - InDesign may have the files open. Close InDesign and run again." -f $version, $failed)
    $exitCode = 1
  } elseif ($failed -gt 0) {
    Err ("Update failed in {0} location(s); nothing was updated. Your existing scripts are unchanged. Close InDesign and run again, or ask IT." -f $failed)
    $exitCode = 1
  } elseif ($installed -gt 0) {
    Ok ("Updated to v{0}. Restart InDesign to see the scripts in the Scripts panel." -f $version)
    if ($skipped -gt 0) { Say ("({0} location(s) were already up to date)" -f $skipped) }
    if ($blocked.Count -gt 0) { Say ("({0} location(s) were skipped, see above)" -f $blocked.Count) }
  } elseif ($blocked.Count -gt 0) {
    # 说发生了什么, 不说打算发生什么。这里原先落进下面的 else, 于是在一个字都没
    # 写入的情况下打印"已是最新版本" —— 用户会据此认为脚本已经装好了。
    Warn ("Nothing was installed: all {0} location(s) were skipped, see above." -f $blocked.Count)
    $exitCode = 1
  } else {
    Ok ("Already up to date (v{0})." -f $version)
  }
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
  # 落一份诊断日志到 temp (仅排障用)
  try {
    $logPath = Join-Path $env:TEMP 'indesign-toolkit-update.log'
    ("=== " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " ===") | Out-File $logPath -Append -Encoding UTF8
    $Script:LogLines | Out-File $logPath -Append -Encoding UTF8
  } catch {}
}

exit $exitCode
