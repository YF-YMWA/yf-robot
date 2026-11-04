# 卸载 YF-Robot（当前用户）
#
# 只删快捷方式和注册表项，**不删程序目录和数据**（记忆、素材都留着）。
# 想彻底删，卸载完自己把文件夹删掉即可。

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms

$silent = ($env:YF_SILENT -eq '1')
if (-not $silent) {
    $r = [System.Windows.Forms.MessageBox]::Show(
        "确定卸载 YF-Robot 吗？`n`n只删快捷方式和开机自启，程序目录和 data（记忆、素材）都会留着。",
        'YF-Robot 卸载', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($r -ne 'Yes') { exit 0 }
}

# 先停掉托盘和服务
$tray = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'YFRobotTray' }
foreach ($p in $tray) { Stop-Process -Id $p.ProcessId -Force }
# 新版启动器是 exe，名字叫 YF-Robot
Get-Process -Name 'YF-Robot' -ErrorAction SilentlyContinue | Stop-Process -Force
$node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'app\.mjs' }
foreach ($p in $node) { Stop-Process -Id $p.ProcessId -Force }

# 快捷方式
$desktop = [Environment]::GetFolderPath('Desktop')
Remove-Item (Join-Path $desktop 'YF-Robot.lnk') -Force
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'YF-Robot'
Remove-Item $startMenu -Recurse -Force

# 注册表：卸载项 + 开机自启
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\YF-Robot' -Recurse -Force
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'YF-Robot'

if (-not $silent) {
    [System.Windows.Forms.MessageBox]::Show(
        "已卸载。`n`n程序目录和 data 都还在，需要的话可以手动删。",
        'YF-Robot 卸载', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
} else {
    Write-Host "已卸载（静默）"
}
