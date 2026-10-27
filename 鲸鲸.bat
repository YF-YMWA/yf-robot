@echo off
chcp 65001 >nul 2>nul
title 鲸鲸 · AI 助手
cd /d "%~dp0"

REM 优先用 pwsh（PowerShell 7），没有就用系统自带的 powershell
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*

set "CODE=%ERRORLEVEL%"
if not "%~1"=="" exit /b %CODE%
echo.
echo   鲸鲸已退出。按任意键关闭窗口。
pause >nul
exit /b %CODE%