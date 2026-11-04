# YF-Robot 托盘启动器（PowerShell + WinForms，不依赖编译器）
#
# 为什么要它：
#   · 双击 bat 会闪黑窗口，不像软件
#   · 关掉窗口服务就没了，用户不知道还在不在跑
#   · 开控制台、看日志、开机自启都得记命令
#
# 由 YF-Robot.vbs 以隐藏窗口方式拉起，所以看不到控制台。

param([switch]$NoStart)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ===== 找程序根目录（config.json 所在）=====
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

# 单实例：已有托盘在跑就提示后退出
$mutex = New-Object System.Threading.Mutex($false, 'YF-Robot-Tray-PS')
if (-not $mutex.WaitOne(0)) {
    # 已有实例：静默退出（弹框会让这个进程卡在那儿，看起来像开了两个）
    exit 0
}

# ===== 读端口 =====
$Port = 8899
try {
    $cfg = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.server.port) { $Port = [int]$cfg.server.port }
} catch { }
$Base = "http://127.0.0.1:$Port"

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
    } catch {
        [System.Windows.Forms.MessageBox]::Show("启动服务失败：$($_.Exception.Message)", 'YF-Robot') | Out-Null
    }
}

function Stop-ServiceSafe {
    if ($script:Child -and -not $script:Child.HasExited) {
        try { $script:Child.Kill() } catch { }
    }
    # 服务可能是别的入口起的：按端口找进程杀掉
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conn) {
            if ($c.OwningProcess -and $c.OwningProcess -ne $PID) {
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { }
}

# ===== 托盘图标（现场画一个，不依赖 ico 文件）=====
function New-Icon {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(58, 122, 214))
    $g.FillEllipse($brush, 1, 1, 30, 30)
    $font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $size = $g.MeasureString('Y', $font)
    $g.DrawString('Y', $font, $white, (32 - $size.Width) / 2, (32 - $size.Height) / 2)
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-Icon
$notify.Text = 'YF-Robot'
$notify.Visible = $true

function Update-Tip {
    if (Test-Service) { $notify.Text = 'YF-Robot · 运行中' } else { $notify.Text = 'YF-Robot · 已停止' }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add('打开控制台')
$miOpen.Add_Click({
    try { Start-Process "$Base/console" } catch {
        [System.Windows.Forms.MessageBox]::Show('打不开控制台，服务可能还没起来。', 'YF-Robot') | Out-Null
    }
})

$miRestart = $menu.Items.Add('重启服务')
$miRestart.Add_Click({
    $notify.Text = 'YF-Robot · 重启中…'
    Stop-ServiceSafe
    Start-Sleep -Milliseconds 1200
    Start-ServiceSafe
    Start-Sleep -Milliseconds 1500
    Update-Tip
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

if (-not $NoStart) { Start-ServiceSafe }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-Tip })
$timer.Start()
Update-Tip

[System.Windows.Forms.Application]::Run()
$notify.Visible = $false
$mutex.ReleaseMutex()
