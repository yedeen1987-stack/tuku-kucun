<#
  R18 PRE-GATE — 只读接管快照收集器  (Claude 主执行 / 步骤四)
  目的：在不触碰任何文件内容的前提下，把 Codex 中断处的 DEV 真实状态完整取证，
        产出一个 ZIP + SHA256 清单，供 Claude 继续执行步骤五。

  本脚本是 **纯只读** 的。它不包含、也不会执行：
    git reset / checkout / restore / clean / stash / add / commit / tag / push
    任何对 DEV / PROD / 8097 文件的写入、删除、移动或覆盖
    任何 migration、服务启停、计划任务或数据库写入
    任何测试执行（测试属于步骤五B，须在接管核验之后）
  唯一的写入目标是 DEV 目录 **之外** 的一个新建输出目录，
  以免在 DEV 工作区产生 untracked 文件而污染 git status 证据本身。

  环境：Windows PowerShell 5.1 兼容（不依赖 PS7）。
  用法：在任意 PowerShell 窗口中执行
            powershell -ExecutionPolicy Bypass -File .\R18-TAKEOVER-SNAPSHOT.ps1
        完成后把输出的 ZIP 路径与 SHA256 回报给 Claude。
#>

[CmdletBinding()]
param(
  [string]$DevRoot   = 'E:\8099-worker-location-dev',
  [string]$ProdRoot  = 'E:\库存图记-workbench-v2-dev',
  [string]$SalesRoot = 'E:\销售软件',
  [string]$OutBase   = 'E:\'
)

# 不使用 $ErrorActionPreference='Stop'：本项目历史上因此让显式 exit 码不可达。
$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$outDir = Join-Path $OutBase ("R18-TAKEOVER-SNAPSHOT-" + $stamp)
$null = New-Item -ItemType Directory -Path $outDir -Force
$filesDir = Join-Path $outDir 'dev-modified-files'
$null = New-Item -ItemType Directory -Path $filesDir -Force

# UTF-8 无 BOM 写入（Out-File 在 5.1 下会加 BOM，破坏后续哈希比对）
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, [string]$Text, $utf8NoBom)
}
function Sha256File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant() }
  catch { return $null }
}
# git 只读包装：固定 -C，禁止分页，捕获 stdout+stderr+exit code
function GitRO([string]$Root, [string[]]$GitArgs) {
  $all = @('-C', $Root, '--no-pager') + $GitArgs
  $so = New-Object System.Text.StringBuilder
  try   { $out = & git @all 2>&1 ; $code = $LASTEXITCODE }
  catch { $out = $_.Exception.Message ; $code = -1 }
  [void]$so.AppendLine("$ git " + ($all -join ' '))
  [void]$so.AppendLine("# exit=$code")
  if ($null -ne $out) { foreach ($l in @($out)) { [void]$so.AppendLine([string]$l) } }
  return $so.ToString()
}

$log = New-Object System.Text.StringBuilder
function Say([string]$m) { Write-Host $m ; [void]$log.AppendLine($m) }

Say "R18 PRE-GATE 只读接管快照"
Say "时间      : $(Get-Date -Format 'o')"
Say "输出目录  : $outDir"
Say "DEV       : $DevRoot"
Say ""

# ---------- 0. 前置存在性与身份（只读） ----------
$envReport = New-Object System.Text.StringBuilder
foreach ($pair in @(@{n='DEV';p=$DevRoot}, @{n='PROD';p=$ProdRoot}, @{n='8097';p=$SalesRoot})) {
  $exists = Test-Path -LiteralPath $pair.p
  [void]$envReport.AppendLine("$($pair.n) path=$($pair.p) exists=$exists")
  Say "$($pair.n) exists = $exists"
}
[void]$envReport.AppendLine("")
[void]$envReport.AppendLine("PSVersion = $($PSVersionTable.PSVersion)")
try { [void]$envReport.AppendLine("node = " + (& node --version 2>&1)) } catch { [void]$envReport.AppendLine("node = UNAVAILABLE") }
try { [void]$envReport.AppendLine("git  = " + (& git --version 2>&1)) }  catch { [void]$envReport.AppendLine("git  = UNAVAILABLE") }
Write-Text (Join-Path $outDir 'ENV.txt') $envReport.ToString()

if (-not (Test-Path -LiteralPath $DevRoot)) {
  Say ""
  Say "致命：DEV 目录不存在，无法接管。未做任何更改。"
  Write-Text (Join-Path $outDir 'RUN-LOG.txt') $log.ToString()
  exit 10
}

# ---------- 1. DEV Git 状态（只读） ----------
Say "[1/7] 采集 DEV Git 只读状态 ..."
$gitOut = New-Object System.Text.StringBuilder
foreach ($g in @(
    @('rev-parse','--is-inside-work-tree'),
    @('rev-parse','HEAD'),
    @('rev-parse','--abbrev-ref','HEAD'),
    @('log','-5','--format=%H %ad %an %s','--date=iso'),
    @('status','--porcelain=v1','--untracked-files=all'),
    @('status','--branch','--short'),
    @('stash','list'),
    @('diff','--stat'),
    @('diff','--cached','--stat'),
    @('diff','--check'),
    @('submodule','status'),
    @('remote','-v')
  )) { [void]$gitOut.AppendLine((GitRO $DevRoot $g)) }
Write-Text (Join-Path $outDir 'DEV-GIT-STATE.txt') $gitOut.ToString()

# 完整 diff（工作树与暂存区分开保存）
Write-Text (Join-Path $outDir 'DEV-DIFF-worktree.patch') (GitRO $DevRoot @('diff'))
Write-Text (Join-Path $outDir 'DEV-DIFF-staged.patch')   (GitRO $DevRoot @('diff','--cached'))

# ---------- 2. 变更路径清单 ----------
Say "[2/7] 解析变更路径 ..."
$porcelain = @()
try { $porcelain = @(& git -C $DevRoot --no-pager status --porcelain=v1 --untracked-files=all 2>$null) } catch { }
$changed = New-Object System.Collections.ArrayList
foreach ($line in $porcelain) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $code = $line.Substring(0, [Math]::Min(2, $line.Length))
  $rest = if ($line.Length -gt 3) { $line.Substring(3) } else { '' }
  # 重命名形如 "old -> new"，取目标侧
  if ($rest -match '^(.*?)\s->\s(.*)$') { $rest = $Matches[2] }
  $rest = $rest.Trim('"')
  if ($rest) { [void]$changed.Add([pscustomobject]@{ code = $code; path = $rest }) }
}
Say "      变更路径总数 = $($changed.Count)"
$changedTxt = New-Object System.Text.StringBuilder
[void]$changedTxt.AppendLine("total=$($changed.Count)")
foreach ($c in $changed) { [void]$changedTxt.AppendLine("$($c.code)`t$($c.path)") }
Write-Text (Join-Path $outDir 'DEV-CHANGED-PATHS.txt') $changedTxt.ToString()

# ---------- 3. 复制变更文件的真实字节（只读源） ----------
Say "[3/7] 复制变更文件内容（源只读）..."
$copied = New-Object System.Collections.ArrayList
$skipped = New-Object System.Collections.ArrayList
foreach ($c in $changed) {
  $src = Join-Path $DevRoot $c.path
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { [void]$skipped.Add("$($c.path) (非普通文件或已删除)"); continue }
  $len = (Get-Item -LiteralPath $src).Length
  if ($len -gt 4MB) { [void]$skipped.Add("$($c.path) (过大 $len 字节)"); continue }
  # 排除不该外带的目录
  if ($c.path -cmatch '^(node_modules/|\.git/|backups/|local-data/)') { [void]$skipped.Add("$($c.path) (排除目录)"); continue }
  $dst = Join-Path $filesDir ($c.path -replace '/', '\')
  $null = New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force
  Copy-Item -LiteralPath $src -Destination $dst -Force
  [void]$copied.Add([pscustomobject]@{
    path = $c.path; code = $c.code; bytes = $len
    sha256 = (Sha256File $src)
    head_blob = ((GitRO $DevRoot @('rev-parse', "HEAD:$($c.path)")) -split "`n" | Where-Object { $_ -cmatch '^[0-9a-f]{40}$' } | Select-Object -First 1)
  })
}
Say "      已复制 $($copied.Count) 个，跳过 $($skipped.Count) 个"
Write-Text (Join-Path $outDir 'DEV-COPIED-FILES.json')  (($copied  | ConvertTo-Json -Depth 5))
Write-Text (Join-Path $outDir 'DEV-SKIPPED-FILES.txt')  (($skipped -join "`r`n"))

# ---------- 4. 测试文件与证据/日志/备份清单（只列不搬） ----------
Say "[4/7] 清点测试文件、日志、备份与既有证据 ..."
function InventoryDir([string]$Root, [string]$Sub, [string]$Filter) {
  $p = if ($Sub) { Join-Path $Root $Sub } else { $Root }
  if (-not (Test-Path -LiteralPath $p)) { return @() }
  try {
    Get-ChildItem -LiteralPath $p -Recurse -File -Filter $Filter -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' } |
      ForEach-Object {
        [pscustomobject]@{
          path   = $_.FullName.Substring($Root.Length).TrimStart('\')
          bytes  = $_.Length
          mtime  = $_.LastWriteTime.ToString('o')
          sha256 = (Sha256File $_.FullName)
        }
      }
  } catch { @() }
}
$inv = [ordered]@{
  tests        = @(InventoryDir $DevRoot 'tests' '*.mjs')
  tools        = @(InventoryDir $DevRoot 'tools' '*.mjs')
  root_mjs     = @(Get-ChildItem -LiteralPath $DevRoot -File -Filter '*.mjs' -ErrorAction SilentlyContinue |
                    ForEach-Object { [pscustomobject]@{ path=$_.Name; bytes=$_.Length; mtime=$_.LastWriteTime.ToString('o'); sha256=(Sha256File $_.FullName) } })
  logs         = @(InventoryDir $DevRoot '' '*.log')
  tap          = @(InventoryDir $DevRoot '' '*.tap')
  backups_dir  = @(if (Test-Path (Join-Path $DevRoot 'backups')) {
                     Get-ChildItem -LiteralPath (Join-Path $DevRoot 'backups') -Recurse -File -ErrorAction SilentlyContinue |
                       ForEach-Object { [pscustomobject]@{ path=$_.FullName.Substring($DevRoot.Length).TrimStart('\'); bytes=$_.Length; mtime=$_.LastWriteTime.ToString('o') } }
                   } else { @() })
  evidence_zip = @(Get-ChildItem -LiteralPath $DevRoot -File -Filter '*.zip' -ErrorAction SilentlyContinue |
                    ForEach-Object { [pscustomobject]@{ path=$_.Name; bytes=$_.Length; mtime=$_.LastWriteTime.ToString('o'); sha256=(Sha256File $_.FullName) } })
  do_not_run   = @(if (Test-Path (Join-Path $DevRoot 'tests\DO_NOT_RUN.json')) { Get-Content -LiteralPath (Join-Path $DevRoot 'tests\DO_NOT_RUN.json') -Raw } else { $null })
}
Write-Text (Join-Path $outDir 'DEV-INVENTORY.json') (($inv | ConvertTo-Json -Depth 6))
Say "      tests=$($inv.tests.Count) tools=$($inv.tools.Count) root_mjs=$($inv.root_mjs.Count) zips=$($inv.evidence_zip.Count)"

# 若存在 DO_NOT_RUN 清单，单独落一份
if ($inv.do_not_run) { Write-Text (Join-Path $outDir 'DEV-DO_NOT_RUN.json') $inv.do_not_run }

# ---------- 5. 未完成的测试/服务进程（只读查询） ----------
Say "[5/7] 查询运行中的 node/测试进程与端口占用 ..."
$proc = New-Object System.Text.StringBuilder
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { [void]$proc.AppendLine("PID=$($_.ProcessId) CREATED=$($_.CreationDate) CMD=$($_.CommandLine)") }
} catch { [void]$proc.AppendLine("Win32_Process 查询失败: $($_.Exception.Message)") }
[void]$proc.AppendLine("")
foreach ($port in @(8099, 8097)) {
  [void]$proc.AppendLine("--- port $port ---")
  try {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { [void]$proc.AppendLine("LocalPort=$($_.LocalPort) PID=$($_.OwningProcess) State=$($_.State)") }
  } catch { [void]$proc.AppendLine("Get-NetTCPConnection 不可用") }
}
Write-Text (Join-Path $outDir 'RUNTIME-PROCESSES.txt') $proc.ToString()

# ---------- 6. 生产与 8097 只读未变更证据 ----------
Say "[6/7] 采集 PROD / 8097 只读证据（不做任何写入）..."
$prodOut = New-Object System.Text.StringBuilder
if (Test-Path -LiteralPath $ProdRoot) {
  [void]$prodOut.AppendLine((GitRO $ProdRoot @('rev-parse','HEAD')))
  [void]$prodOut.AppendLine((GitRO $ProdRoot @('status','--porcelain=v1')))
  foreach ($rel in @('local-migrate.mjs','local-server.mjs','migrations\local\approved.json')) {
    $p = Join-Path $ProdRoot $rel
    $h = Sha256File $p
    [void]$prodOut.AppendLine("PROD $rel sha256=$h bytes=$(if(Test-Path -LiteralPath $p){(Get-Item -LiteralPath $p).Length}else{'ABSENT'})")
  }
} else { [void]$prodOut.AppendLine("PROD 目录不存在：$ProdRoot") }
[void]$prodOut.AppendLine("")
if (Test-Path -LiteralPath $SalesRoot) {
  [void]$prodOut.AppendLine("8097 根目录文件数（顶层）= " + @(Get-ChildItem -LiteralPath $SalesRoot -File -ErrorAction SilentlyContinue).Count)
  [void]$prodOut.AppendLine("8097 最近修改时间 = " + ((Get-ChildItem -LiteralPath $SalesRoot -Recurse -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime))
} else { [void]$prodOut.AppendLine("8097 目录不存在：$SalesRoot") }
Write-Text (Join-Path $outDir 'PROD-8097-READONLY.txt') $prodOut.ToString()

# ---------- 7. SHA256 清单 + ZIP ----------
Say "[7/7] 生成 SHA256 清单并打包 ..."
$manifest = New-Object System.Collections.ArrayList
Get-ChildItem -LiteralPath $outDir -Recurse -File | ForEach-Object {
  [void]$manifest.Add([pscustomobject]@{
    path   = $_.FullName.Substring($outDir.Length).TrimStart('\').Replace('\','/')
    bytes  = $_.Length
    sha256 = (Sha256File $_.FullName)
  })
}
Write-Text (Join-Path $outDir 'SHA256-MANIFEST.json') (($manifest | ConvertTo-Json -Depth 4))

$zipPath = Join-Path $OutBase ("R18-TAKEOVER-SNAPSHOT-" + $stamp + ".zip")
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
  [System.IO.Compression.ZipFile]::CreateFromDirectory($outDir, $zipPath)
} catch {
  Compress-Archive -Path (Join-Path $outDir '*') -DestinationPath $zipPath -Force
}
$zipSha = Sha256File $zipPath
$zipLen = if (Test-Path -LiteralPath $zipPath) { (Get-Item -LiteralPath $zipPath).Length } else { 0 }

Say ""
Say "================ 接管快照完成（未修改任何源文件）================"
Say "ZIP 路径   : $zipPath"
Say "ZIP 字节   : $zipLen"
Say "ZIP SHA256 : $zipSha"
Say "清单 SHA256: $(Sha256File (Join-Path $outDir 'SHA256-MANIFEST.json'))"
Say "变更路径数 : $($changed.Count)   已复制: $($copied.Count)"
Say "请把以上三行（路径/字节/SHA256）与 ZIP 一起回报给 Claude。"

Write-Text (Join-Path $outDir 'RUN-LOG.txt') $log.ToString()
exit 0
