' YF-Robot 启动器（隐藏控制台窗口）
'
' 双击没有黑窗口：用 wscript 以隐藏方式跑 PowerShell 托盘脚本。
' 想调试就改成 False，会看到 PowerShell 窗口和报错。
Option Explicit

Dim fso, shell, here, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "YFRobotTray.ps1")

If Not fso.FileExists(ps1) Then
    MsgBox "找不到 YFRobotTray.ps1，位置：" & ps1, 16, "YF-Robot"
    WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
shell.Run cmd, 0, False
