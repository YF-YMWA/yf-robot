# YF-Robot 托盘启动器（PowerShell + WinForms，不依赖编译器）
#
# 由 desktop\YF-Robot.vbs 以隐藏窗口拉起，所以看不到控制台。
#
# 行为：
#   · 单实例（Mutex）：重复双击静默退出
#   · 启动时服务没跑就自动拉起（不显示控制台）
#   · 托盘图标随状态变色：绿=运行中，灰=已停止，黄=重启中
#   · 服务意外退出自动拉起（最多 3 次，间隔至少 20 秒，避免死循环）
#   · 菜单：打开控制台 / 查看日志 / 重启服务 / 打开数据目录 / 开机自启 / 退出

param([switch]$NoStart)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Find-Root {
    $dir = Split-Path -Parent $PSCommandPath
    for ($i = 0; $i -lt 4 -and $dir; $i++) {
        if (Test-Path (Join-Path $dir 'config.json')) { return $dir }
        $dir = Split-Path -Parent $dir
    }
    return $null
}

$Root = Find-Root
if (-not $Root) {
    [System.Windows.Forms.MessageBox]::Show('找不到程序目录（config.json 所在文件夹）。', 'YF-Robot') | Out-Null
    exit 1
}

$mutex = New-Object System.Threading.Mutex($false, 'YF-Robot-Tray-PS')
if (-not $mutex.WaitOne(0)) {
    # 已有实例：静默退出（弹框会让这个进程卡在那儿，看起来像开了两个）
    exit 0
}

# ===== 版本与端口 =====
$Version = '0.0.0'
try { $Version = (Get-Content (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }

$Port = 8899
try {
    $cfg = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.server.port) { $Port = [int]$cfg.server.port }
} catch { }
$Base = "http://127.0.0.1:$Port"

# ===== 托盘日志（自动重启这类后台行为出问题时能查）=====
$LogFile = Join-Path $Root 'data\tray.log'
function Write-TrayLog([string]$msg) {
    try {
        $dir = Split-Path -Parent $LogFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
        # 只留最近 300 行，避免无限增长
        if ((Test-Path $LogFile) -and ((Get-Content $LogFile -ErrorAction SilentlyContinue).Count -gt 300)) {
            $keep = Get-Content $LogFile -Tail 300
            $keep | Set-Content $LogFile -Encoding UTF8
        }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch { }
}

function Test-Service {
    try {
        $r = Invoke-WebRequest "$Base/api/adapter/config" -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -lt 500)
    } catch { return $false }
}

function Get-Node {
    $local = Join-Path $Root 'runtime\node.exe'
    if (Test-Path $local) { return $local }
    return 'node'
}

$script:Child = $null
$script:AutoRestarts = 0
$script:LastRestartAt = (Get-Date).AddHours(-1)
$script:WasUp = $null

function Start-ServiceSafe {
    if (Test-Service) { return }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = Get-Node
        $psi.Arguments = 'launch_background.mjs'
        $psi.WorkingDirectory = $Root
        $psi.CreateNoWindow = $true
        $psi.UseShellExecute = $false
        $script:Child = [System.Diagnostics.Process]::Start($psi)
        Write-TrayLog ("服务已启动 pid=" + $script:Child.Id)
    } catch {
        [System.Windows.Forms.MessageBox]::Show("启动服务失败：$($_.Exception.Message)", 'YF-Robot') | Out-Null
    }
}

function Stop-ServiceSafe {
    if ($script:Child -and -not $script:Child.HasExited) {
        try { $script:Child.Kill() } catch { }
    }
    # 只杀本项目的 node（命令行里同时有本目录和 launch_background.mjs/app.mjs），
    # 不按端口杀 —— 那可能误杀别人的程序
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object {
                $_.CommandLine -match 'launch_background\.mjs|app\.mjs' -and
                $_.CommandLine -match [regex]::Escape($Root)
            } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch { }
}

# ===== 图标：随状态变色 =====
function New-Icon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 1, 1, 30, 30)
    $font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $size = $g.MeasureString('Y', $font)
    $g.DrawString('Y', $font, $white, (32 - $size.Width) / 2, (32 - $size.Height) / 2)
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$IconUp = New-Icon ([System.Drawing.Color]::FromArgb(46, 160, 67))
$IconDown = New-Icon ([System.Drawing.Color]::FromArgb(128, 128, 128))
$IconBusy = New-Icon ([System.Drawing.Color]::FromArgb(214, 158, 46))

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $IconDown
$notify.Text = "YF-Robot v$Version"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miInfo = New-Object System.Windows.Forms.ToolStripMenuItem("YF-Robot v$Version · 端口 $Port")
$miInfo.Enabled = $false
$menu.Items.Add($miInfo) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miOpen = $menu.Items.Add('打开控制台')
$miOpen.Add_Click({
    try { Start-Process "$Base/console" } catch {
        [System.Windows.Forms.MessageBox]::Show('打不开控制台，服务可能还没起来。', 'YF-Robot') | Out-Null
    }
})

$miLog = $menu.Items.Add('查看日志')
$miLog.Add_Click({
    $log = Join-Path $Root 'data\app.out.log'
    if (Test-Path $log) { Start-Process notepad.exe $log }
    else { [System.Windows.Forms.MessageBox]::Show("还没有日志文件：$log", 'YF-Robot') | Out-Null }
})

$miRestart = $menu.Items.Add('重启服务')
$miRestart.Add_Click({
    $notify.Icon = $IconBusy
    $notify.Text = 'YF-Robot · 重启中…'
    Stop-ServiceSafe
    Start-Sleep -Milliseconds 1200
    Start-ServiceSafe
    Start-Sleep -Milliseconds 1500
    Update-State -Force
})

$miData = $menu.Items.Add('打开数据目录')
$miData.Add_Click({
    $d = Join-Path $Root 'data'
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
    Start-Process explorer.exe $d
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem('开机自启')
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$miAuto.Checked = [bool](Get-ItemProperty -Path $RunKey -Name 'YF-Robot' -ErrorAction SilentlyContinue)
$miAuto.Add_Click({
    try {
        if ($miAuto.Checked) {
            Remove-ItemProperty -Path $RunKey -Name 'YF-Robot' -ErrorAction SilentlyContinue
            $miAuto.Checked = $false
        } else {
            $vbs = Join-Path $Root 'desktop\YF-Robot.vbs'
            Set-ItemProperty -Path $RunKey -Name 'YF-Robot' -Value ('wscript.exe "' + $vbs + '"')
            $miAuto.Checked = $true
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show("设置开机自启失败：$($_.Exception.Message)", 'YF-Robot') | Out-Null
    }
})
$menu.Items.Add($miAuto) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miExit = $menu.Items.Add('退出（停止服务）')
$miExit.Add_Click({
    $r = [System.Windows.Forms.MessageBox]::Show('退出会停止服务（聊天也会断）。确定？', 'YF-Robot',
        [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($r -ne 'Yes') { return }
    Stop-ServiceSafe
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ Start-Process "$Base/console" })

function Update-State([switch]$Force) {
    $up = Test-Service
    $prev = $script:WasUp
    # STATE-CHANGE-LOG：每次状态翻转记一行，排查自动重启用
    if ($prev -ne $up) { Write-TrayLog ("[state] " + $prev + " -> " + $up) }

    if ($up) {
        $notify.Icon = $IconUp
        $notify.Text = "YF-Robot v$Version · 运行中（:$Port）"
        $script:AutoRestarts = 0
    } else {
        $notify.Icon = $IconDown
        $notify.Text = "YF-Robot v$Version · 已停止"

        # 服务意外退出：自动拉起（最多 3 次，间隔至少 20 秒）
        if ($prev -eq $true -and $script:AutoRestarts -lt 3) {
            $gap = ((Get-Date) - $script:LastRestartAt).TotalSeconds
            if ($gap -ge 15) {
                $script:AutoRestarts++
                Write-TrayLog ("检测到服务退出，第 $($script:AutoRestarts) 次自动重启")
                $script:LastRestartAt = Get-Date
                $notify.ShowBalloonTip(3000, 'YF-Robot',
                    "服务好像退出了，正在自动重启（第 $($script:AutoRestarts) 次）",
                    [System.Windows.Forms.ToolTipIcon]::Warning)
                try { Start-ServiceSafe } catch { Write-TrayLog ("自动重启失败: " + $_.Exception.Message) }
            }
        }
    }

    # 状态变化时给一次气泡提示
    if ($prev -eq $false -and $up) {
        $notify.ShowBalloonTip(2500, 'YF-Robot', "服务已就绪（端口 $Port），双击图标打开控制台", [System.Windows.Forms.ToolTipIcon]::Info)
    }

    $script:WasUp = $up
}

Write-TrayLog "托盘启动（版本 $Version，端口 $Port）"
if (-not $NoStart) { Start-ServiceSafe }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-State })
$timer.Start()

Start-Sleep -Milliseconds 1500
Update-State -Force

[System.Windows.Forms.Application]::Run()
$notify.Visible = $false
$mutex.ReleaseMutex()
