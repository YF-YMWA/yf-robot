@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 恢复记忆 - YF-Robot

echo ============================================
echo   恢复记忆
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

echo 最近的备份：
echo.
"%NODE%" tools\memory-tool.mjs list
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)

echo.
set /p WHICH=要恢复哪一个？（直接回车 = 最新的一份，输入 q 取消）: 
if /i "%WHICH%"=="q" goto end
if "%WHICH%"=="" (
    "%NODE%" tools\memory-tool.mjs restore --latest
) else (
    "%NODE%" tools\memory-tool.mjs restore "%WHICH%"
)

if errorlevel 1 (
    echo.
    echo [失败] 上面有原因。
    pause
    exit /b 1
)

echo.
echo 恢复完成。恢复前的状态也自动存了一份（before-restore）。
echo 服务正在跑的话，重启一次服务就能看到恢复后的记忆。
echo.

:end
pause
