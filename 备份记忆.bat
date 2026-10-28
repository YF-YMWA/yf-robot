@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 备份记忆 - YF-Robot

echo ============================================
echo   备份记忆
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    if exist "runtime\node.exe" (set "NODE=runtime\node.exe") else (
        echo [错误] 找不到 node。
        pause
        exit /b 1
    )
) else (
    set "NODE=node"
)

"%NODE%" tools\memory-tool.mjs export
if errorlevel 1 (
    echo.
    echo [失败] 上面有原因。
    pause
    exit /b 1
)

echo.
echo 备份放在 data\backups\ 里。
echo 这个文件里有你的 Key 和聊天记忆，别发给别人。
echo.
pause
