@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 开机自启 - YF-Robot

echo ============================================
echo   开机自启
echo ============================================
echo.
echo  为什么要这个：
echo    电脑重启或关机再开机之后，YF-Robot 不会自己启动。
echo    表现就是「微信里她不回话」「桌面控制台连不上」。
echo    装了自启之后，登录 Windows 就会在后台自动跑起来（无窗口）。
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

"%NODE%" tools\autostart.mjs status
echo.
set /p GO=要开启自启吗？（y = 开启，n = 关闭，直接回车 = 只看一眼）: 

if /i "%GO%"=="y" (
    "%NODE%" tools\autostart.mjs install
    echo.
    echo 已开启。下次开机自动启动。
    echo 注意：它是「登录后启动」，开机但没登录不会跑。
)
if /i "%GO%"=="n" (
    "%NODE%" tools\autostart.mjs uninstall
)

echo.
pause
