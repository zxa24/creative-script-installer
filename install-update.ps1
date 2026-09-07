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
  [switch]$DryRun                                 # 只探测+校验, 不写任何文件
)

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'      # 避开 IWR 进度条 5.1 大幅拖慢的坑
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}  # 中文消息不乱码

# ===== 可配置源 (发布时设定) =====
$Owner = 'zxa24'
$Repo  = 'indesign-toolkit-dist'   # 占位: E-source 发布时定名
$Ref   = 'main'

$INSTALL_FOLDER = 'indesign-toolkit'   # 装进 Scripts Panel 的子文件夹名
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
    if (-not (Test-Path $Source)) { throw "指定的源不存在: $Source" }
    $item = Get-Item $Source
    if ($item.PSIsContainer) {
      $root = Find-DistRoot $item.FullName
      if (-not $root) { throw "源目录里找不到 $MANIFEST_NAME : $Source" }
      Log "source=localdir root=$root"
      return @{ Root = $root; Work = $null }
    } else {
      $work = Get-TempWorkDir
      $ex = Join-Path $work 'extract'
      New-Item -ItemType Directory -Path $ex -Force | Out-Null
      Expand-Archive -Path $item.FullName -DestinationPath $ex -Force
      $root = Find-DistRoot $ex
      if (-not $root) { throw "源 zip 里找不到 $MANIFEST_NAME : $Source" }
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
  if (-not $root) { throw "下载的包里找不到 $MANIFEST_NAME (源结构异常)" }
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
function Install-Into([string]$panelDir, [string]$payloadDir, [string]$version) {
  $dst = Join-Path $panelDir $INSTALL_FOLDER
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
  Say '正在检查更新…'

  $panels = Find-ScriptsPanelDirs
  if ($panels.Count -eq 0) {
    Warn '未找到已安装的 InDesign。请先安装 / 启动一次 InDesign 后重试。'
    exit 3
  }
  Log ("panels=" + ($panels -join ' | '))

  # 远端预检 (设计 §2.2): 只取小 manifest, 若所有面板已是该版本则直接收工,
  # 不下载整包 (否则每次"检查更新"都白拉 ~6MB)。仅远端 + 非 DryRun 时生效;
  # 本地源无此开销。预检失败(离线/无 manifest)则回落到完整 acquire, 由那里
  # 报真实网络错误 —— 预检绝不阻断正常流程。逐面板 skip 仍是最终权威闸门。
  if (-not $Source -and -not $DryRun) {
    try {
      $rm = Fetch-RemoteManifest (Resolve-RemoteUrls).Manifest
      if (-not (Test-PanelsNeedUpdate $panels $rm.version)) {
        Say ''
        Ok ("已是最新版本 (v{0})。" -f $rm.version)
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
  if (-not (Test-Path $payloadDir)) { throw "分发包缺 payload 目录 '$PAYLOAD_SUBDIR'" }

  # 校验完整性
  $bad = Verify-Payload $manifest $payloadDir
  if ($bad.Count -gt 0) {
    Err '下载的文件校验失败, 未做任何改动。请重试或联系 IT。'
    $bad | Select-Object -First 5 | ForEach-Object { Log "verify: $_" }
    exit 4
  }
  Log "verify OK: $($manifest.files.Count) files, v$version"

  # 逐面板安装。每个面板独立 try/catch: 一个面板换入失败 (常见: InDesign 正
  # 占用某文件) 会在 Install-Into 内回滚到旧版, 不应中止其它面板, 也不应让主
  # catch 打印"什么都没改"(对已成功的面板是假话)。
  $installed = 0; $skipped = 0; $wouldInstall = 0; $failed = 0
  foreach ($p in $panels) {
    try {
      $r = Install-Into $p $payloadDir $version
      switch ($r) {
        'installed'      { $installed++;    Log "installed -> $p" }
        'skip'           { $skipped++;      Log "skip(latest) -> $p" }
        'would-install'  { $wouldInstall++; Log "would-install -> $p" }
      }
    } catch {
      $failed++
      Log "install FAILED -> $p : $($_.Exception.Message)"
    }
  }

  Say ''
  if ($DryRun) {
    Ok ("[试运行] 将安装到 {0} 个位置 (v{1})。未写入任何文件。" -f $wouldInstall, $version)
  } elseif ($failed -gt 0 -and $installed -gt 0) {
    Warn ("部分位置已更新到 v{0}, 但有 {1} 处失败 (可能 InDesign 正占用文件)。请关闭 InDesign 后重试。" -f $version, $failed)
    $exitCode = 1
  } elseif ($failed -gt 0) {
    Err ("更新失败 ({0} 处), 未成功更新任何位置。已有的脚本未被改动。请关闭 InDesign 后重试或联系 IT。" -f $failed)
    $exitCode = 1
  } elseif ($installed -gt 0) {
    Ok ("已更新到 v{0} — 重启 InDesign 后在「脚本」面板可见。" -f $version)
    if ($skipped -gt 0) { Say ("(其中 {0} 个位置本已是最新)" -f $skipped) }
  } else {
    Ok ("已是最新版本 (v{0})。" -f $version)
  }
}
catch {
  Err '网络或安装出错, 未完成更新。已有的脚本未被改动。请重试或联系 IT。'
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
