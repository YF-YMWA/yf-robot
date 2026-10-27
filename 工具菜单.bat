@echo off
chcp 65001 >nul 2>nul
title YF-Robot · 工具菜单
cd /d "%~dp0"

if not exist "runtime\node.exe" (
    echo   [错误] 找不到 runtime\node.exe
    pause
    exit /b 1
)

runtime\node.exe menu.mjs