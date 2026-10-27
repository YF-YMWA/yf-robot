@echo off
chcp 65001 >nul 2>nul
title YF-Robot · 状态面板
cd /d "%~dp0"

if not exist "runtime\node.exe" (
    echo   [错误] 找不到 runtime\node.exe
    pause
    exit /b 1
)

REM 先检查服务是否在跑，没跑就先起
powershell -NoProfile -Command "if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 8899 -InformationLevel Quiet -WarningAction SilentlyContinue)) { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   服务未启动，正在后台启动...
    start "" /b runtime\node.exe launch_background.mjs
    timeout /t 8 /nobreak >nul
)

runtime\node.exe tools\tui.mjs
pause