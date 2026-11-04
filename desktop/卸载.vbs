' 卸载 YF-Robot（隐藏控制台窗口）
Option Explicit
Dim fso, shell, here, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "卸载.ps1")
If Not fso.FileExists(ps1) Then
    MsgBox "找不到 卸载.ps1，位置：" & ps1, 16, "YF-Robot"
    WScript.Quit 1
End If
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
