# 鲸鲸 · 启动器
# 照搬 whale-girl 的做法：清代理、设编码、找运行时、启动服务
param(
  [switch]$NoBrowser,
  [switch]$Check,
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$env:TZ = 'Asia/Shanghai'

# 清代理（残留的 HTTPS_PROXY 会让模型请求全失败）
foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
  if (Test-Path "env:$name") { Remove-Item "env:$name" -ErrorAction SilentlyContinue }
}
$env:NO_PROXY = '127.0.0.1,localhost,::1'
$env:no_proxy = $env:NO_PROXY

# UTF-8
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
  chcp 65001 > $null 2>&1
} catch { }

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root

# ===== 找 Node =====
$nodePath = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path $nodePath)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodePath = $cmd.Source }
}

Write-Host ''
Write-Host '  🐳  鲸鲸 · 微信 AI 助手' -ForegroundColor Cyan
Write-Host '  ────────────────────────────────────────────'

if (-not (Test-Path $nodePath)) {
  Write-Host '  ❌ 找不到 Node.js 运行时。' -ForegroundColor Red
  Write-Host '  包里应该自带 runtime\node.exe。重新解压或安装 Node.js LTS。'
  exit 1
}

# ===== 接管旧实例 =====
# 双击启动时如果已经有一个在跑，直接再起一个会被单实例保护拦下，
# 窗口一闪就关，表现出来就是「重启打不开」。
# 这里先看锁文件：旧进程还活着就把它停掉，然后照常启动（= 重启）。
$lockFile = Join-Path $root 'data\app.lock'
if (Test-Path $lockFile) {
  $oldPid = 0
  try { $oldPid = [int]((Get-Content $lockFile -Raw -ErrorAction SilentlyContinue).Trim()) } catch { }
  if ($oldPid -gt 0) {
    $alive = $false
    try { Get-Process -Id $oldPid -ErrorAction Stop | Out-Null; $alive = $true } catch { $alive = $false }

    if ($alive) {
      Write-Host "  检测到已在运行（PID $oldPid），正在重启…" -ForegroundColor Yellow
      try {
        Stop-Process -Id $oldPid -Force -ErrorAction Stop
      } catch {
        Write-Host "  ⚠ 停不掉旧进程：$($_.Exception.Message)" -ForegroundColor Yellow
      }
      # 等端口释放
      for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 300
        try { Get-Process -Id $oldPid -ErrorAction Stop | Out-Null } catch { break }
      }
      Write-Host '  ✓ 旧实例已停止' -ForegroundColor Green
    }
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ('  运行时：     ' + $nodePath)

if ($Check) {
  if (Test-Path (Join-Path $root 'app.mjs')) {
    Write-Host '  启动文件：   app.mjs ✅'
  } else {
    Write-Host '  启动文件：   app.mjs ❌' -ForegroundColor Red
    exit 1
  }
  Write-Host ''
  Write-Host '  自检通过。'
  exit 0
}

Write-Host '  ────────────────────────────────────────────'
Write-Host '  正在启动…（按 Ctrl+C 停止）'
Write-Host ''

# ===== 浏览器打开：由本 PowerShell 进程负责 =====
# 不在 node 子进程里开（受限会话下 GUI 可能起不来），
# 这里和用户手动双击同一个桌面会话，成功率最高。
#
# 地址不写死：端口被占用时服务会自动往后找，
# 这里从配置读起始端口，再逐个探测真正在监听的。
$cfgPath = Join-Path $root 'config.json'
$basePort = 8899
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.server -and $cfg.server.port) { $basePort = [int]$cfg.server.port }
  } catch { }
}
if ($Port -gt 0) { $basePort = $Port }

$openJob = {
  param($startPort, $stateFile, $portFile)

  # 优先读服务自己写出来的真实端口。
  #
  # 为什么不探端口：以前是「从配置端口往上试，第一个能连上的就开浏览器」。
  # 如果电脑上已经跑着另一份（或者旧实例没关），它连上的是**旧实例**，
  # 浏览器打开的是旧控制台，而新实例实际已经换到 8900 了 ——
  # 用户看到的就是「解压出来的这份用不了」。
  $realPort = 0
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      if (Test-Path $portFile) {
        $raw = (Get-Content $portFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($raw -match '^\d+$') {
          $realPort = [int]$raw
          break
        }
      }
    } catch { }
  }

  # 拿不到端口文件才退回探测（老版本兼容）
  if ($realPort -eq 0) {
    for ($i = 0; $i -lt 20; $i++) {
      $p = $startPort + $i
      for ($retry = 0; $retry -lt 6; $retry++) {
        Start-Sleep -Milliseconds 400
        try {
          $tcp = New-Object System.Net.Sockets.TcpClient
          $tcp.Connect('127.0.0.1', $p)
          $tcp.Close()
          $realPort = $p
          break
        } catch { }
      }
      if ($realPort -gt 0) { break }
    }
  }

  if ($realPort -eq 0) { return }

  $url = "http://127.0.0.1:$realPort/console"

  # 等页面真能访问
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($r.StatusCode -eq 200) { break }
    } catch { Start-Sleep -Milliseconds 400 }
  }

  Start-Sleep -Milliseconds 400

  # 只打开一次
  try {
    cmd /c start "" "$url"
    try { Set-Content -Path $stateFile -Value $realPort -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
  } catch { }
}

$job = $null
if (-not $NoBrowser) {
  $stateFile = Join-Path $root 'data\.browser-opened'
  $portFile = Join-Path $root 'data\actual-port.txt'
  Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
  Remove-Item $portFile -Force -ErrorAction SilentlyContinue
  $job = Start-Job -ScriptBlock $openJob -ArgumentList $basePort, $stateFile, $portFile
}

# ===== 启动服务 =====
$serverArgs = @((Join-Path $root 'app.mjs'))
if ($Port -gt 0) { $serverArgs += "--port=$Port" }

try {
  & $nodePath @serverArgs
} catch {
  Write-Host ''
  Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
  if ($job) { Remove-Job $job -Force -ErrorAction SilentlyContinue }
  exit 1
}

$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }

if ($job) { Remove-Job $job -Force -ErrorAction SilentlyContinue }

if ($code -ne 0) {
  Write-Host ''
  Write-Host ("服务异常退出（代码 " + $code + "）。") -ForegroundColor Yellow
  $errLog = Join-Path $root 'data\app.err.log'
  if (Test-Path $errLog) {
    Get-Content $errLog -Encoding UTF8 -ErrorAction SilentlyContinue |
      Select-Object -Last 10 | ForEach-Object { Write-Host ('  ' + $_) }
  }
}
exit $code
