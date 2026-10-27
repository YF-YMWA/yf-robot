@echo off
chcp 65001 >nul 2>nul
title 鲸鲸 · AI 助手
cd /d "%~dp0"

if not exist "runtime\node.exe" (
    echo.
    echo   [错误] 找不到 runtime\node.exe
    echo   请确认解压完整
    echo.
    pause
    exit /b 1
)

runtime\node.exe app.mjs %*

if %errorlevel% neq 0 (
    echo.
    echo   程序异常退出，错误码 %errorlevel%
    pause
)