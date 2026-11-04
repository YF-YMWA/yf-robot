# 安装 YF-Robot（当前用户，不需要管理员）
#
# 做三件事：
#   1. 在桌面和开始菜单建快捷方式（指向 desktop\YF-Robot.vbs，双击无黑窗口）
#   2. 在「控制面板 → 程序和功能」里登记卸载项
#   3. 可选：开机自启
#
# 不复制文件、不改系统目录 —— 在哪解压就在哪运行，卸载也只删快捷方式和注册表项。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Find-Root {
    $dir = Split-Path -Parent $PSCommandPath
    for ($i = 0; $i -lt 4 -and $dir; $i++) {
        if (Test-Path (Join-Path $dir 'package.json')) { return $dir }
        $dir = Split-Path -Parent $dir
    }
    return $null
}

$Root = Find-Root
if (-not $Root) {
    [System.Windows.Forms.MessageBox]::Show('找不到程序目录（package.json 所在文件夹）。', 'YF-Robot 安装') | Out-Null
    exit 1
}

$vbs = Join-Path $Root 'desktop\YF-Robot.vbs'
$exe = Join-Path $Root 'desktop\YF-Robot.exe'

# 优先用 exe（托盘程序）；没有 exe 就回退到 vbs（PowerShell 版托盘）
$useExe = Test-Path $exe
$launchTarget = if ($useExe) { $exe } else { 'wscript.exe' }
$launchArgs = if ($useExe) { '' } else { '"' + $vbs + '"' }

# 解压来的文件带 Mark-of-the-Web，exe 会被 SmartScreen 拦（发布者未知）。
# 主动解除锁定，避免用户双击后只看到「Windows 已保护你的电脑」。
foreach ($f in @($exe, $vbs, (Join-Path $Root 'desktop\YFRobotTray.ps1'))) {
    try { if (Test-Path $f) { Unblock-File -Path $f -ErrorAction SilentlyContinue } } catch { }
}

if (-not $useExe -and -not (Test-Path $vbs)) {
    [System.Windows.Forms.MessageBox]::Show("找不到启动器：$exe / $vbs", 'YF-Robot 安装') | Out-Null
    exit 1
}

$ver = '0.0.0'
try { $ver = (Get-Content (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }

$shell = New-Object -ComObject WScript.Shell
$icon = Join-Path $Root 'desktop\YF-Robot.ico'
$iconTarget = if (Test-Path $icon) { $icon } elseif (Test-Path (Join-Path $Root 'desktop\YF-Robot.exe')) { Join-Path $Root 'desktop\YF-Robot.exe' } else { 'wscript.exe' }

function New-Shortcut($path, $target, $arguments, $desc) {
    $sc = $shell.CreateShortcut($path)
    $sc.TargetPath = $target
    # 注意：参数名不能叫 $args —— 那是 PowerShell 的自动变量，写了也不生效，
    # 结果快捷方式参数为空，wscript 会在没有脚本时打开「脚本宿主设置」窗口。
    # 必须无条件赋值：CreateShortcut 会读入已有的 .lnk，不清空的话旧参数会残留
    $sc.Arguments = if ($arguments) { $arguments } else { '' }
    $sc.WorkingDirectory = $Root
    $sc.Description = $desc
    if ($iconTarget -ne 'wscript.exe') { $sc.IconLocation = $iconTarget }
    $sc.Save()
}

# ===== 1. 快捷方式 =====
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'YF-Robot'

New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
New-Shortcut (Join-Path $desktop 'YF-Robot.lnk') $launchTarget $launchArgs 'YF-Robot 启动器'
New-Shortcut (Join-Path $startMenu 'YF-Robot.lnk') $launchTarget $launchArgs 'YF-Robot 启动器'
New-Shortcut (Join-Path $startMenu '打开数据目录.lnk') 'explorer.exe' ('"' + (Join-Path $Root 'data') + '"') 'YF-Robot 数据目录'
New-Shortcut (Join-Path $startMenu '卸载 YF-Robot.lnk') 'wscript.exe' ('"' + (Join-Path $Root 'desktop\卸载.vbs') + '"') '卸载 YF-Robot'

# ===== 2. 卸载登记（当前用户）=====
$uninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\YF-Robot'
New-Item -Path $uninstKey -Force | Out-Null
Set-ItemProperty -Path $uninstKey -Name 'DisplayName' -Value 'YF-Robot'
Set-ItemProperty -Path $uninstKey -Name 'DisplayVersion' -Value $ver
Set-ItemProperty -Path $uninstKey -Name 'Publisher' -Value 'YF-YMWA'
Set-ItemProperty -Path $uninstKey -Name 'InstallLocation' -Value $Root
Set-ItemProperty -Path $uninstKey -Name 'UninstallString' -Value ('wscript.exe "' + (Join-Path $Root 'desktop\卸载.vbs') + '"')
Set-ItemProperty -Path $uninstKey -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $uninstKey -Name 'NoRepair' -Value 1 -Type DWord

# ===== 3. 开机自启（问一句）=====
$silent = ($env:YF_SILENT -eq '1')
$r = if ($silent) { 'No' } else {
    [System.Windows.Forms.MessageBox]::Show('要开机自动启动吗？（可以以后在托盘菜单里改）', 'YF-Robot 安装',
        [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($r -eq 'Yes') {
    # 开机自启：优先 exe 的 --silent（只驻留托盘，不弹窗口）
    if (Test-Path $exe) {
        Set-ItemProperty -Path $runKey -Name 'YF-Robot' -Value ('"' + $exe + '" --silent')
    } else {
        Set-ItemProperty -Path $runKey -Name 'YF-Robot' -Value ('wscript.exe "' + $vbs + '"')
    }
} else {
    Remove-ItemProperty -Path $runKey -Name 'YF-Robot' -ErrorAction SilentlyContinue
}

if (-not $silent) {
    [System.Windows.Forms.MessageBox]::Show(
        "安装完成（版本 $ver）`n`n桌面和开始菜单都有图标了。`n右键托盘图标可以：打开控制台 / 重启服务 / 开机自启 / 退出。",
        'YF-Robot 安装', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
} else {
    Write-Host ("安装完成（静默）：$Root  启动器=" + $launchTarget)
}
