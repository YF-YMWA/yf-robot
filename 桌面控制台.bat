@echo off
setlocal
chcp 936 >nul 2>nul
cd /d "%~dp0"
title YF-Robot 控制台

REM ============================================
REM  把控制台当成一个独立软件打开。
REM
REM  原理：用 Edge / Chrome 的 --app 模式打开本地控制台，
REM  窗口没有地址栏、没有标签页，任务栏里是独立的一项，
REM  用起来和桌面软件没区别，但零额外依赖、不占额外体积。
REM ============================================

set "URL=http://127.0.0.1:8899/console"
set "PROFILE=%~dp0data\app-profile"

REM ===== 1. 服务没起来就先拉起来 =====
call :check_port
if "%RUNNING%"=="1" goto open

echo.
echo   服务没在跑，正在启动…
echo.

if not exist "%~dp0runtime\node.exe" (
    echo   [错误] 找不到 runtime\node.exe
    echo          如果你是开发环境，先跑一次打包，或者直接 node app.mjs
    pause
    exit /b 1
)

start "" /min "%~dp0runtime\node.exe" "%~dp0app.mjs"

REM 最多等 20 秒
set /a N=0
:wait
timeout /t 1 /nobreak >nul
set /a N+=1
call :check_port
if "%RUNNING%"=="1" goto open
if %N% GEQ 20 (
    echo   [错误] 服务启动超时，看看 data\app.out.log
    pause
    exit /b 1
)
goto wait

:open
echo   控制台: %URL%
echo.
echo   关闭这个黑窗口不会停服务（服务在后台跑）。
echo   要停服务请看「工具菜单.bat」里的「停止服务」。
echo.

REM ===== 2. 找个能 --app 的浏览器 =====
set "BR="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BR=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BR if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BR=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BR if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BR=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BR if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BR=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if not defined BR (
    echo   没找到 Edge/Chrome，用默认浏览器打开
    start "" "%URL%"
    goto done
)

if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>nul

echo   用独立窗口打开（无地址栏）
start "" "%BR%" --app=%URL% --user-data-dir="%PROFILE%" --window-size=1280,860 --no-first-run --no-default-browser-check

:done
exit /b 0

REM ===== 检查端口在不在听 =====
:check_port
set "RUNNING=0"
for /f "tokens=*" %%L in ('netstat -ano ^| findstr /c:":8899" ^| findstr /c:"LISTENING"') do set "RUNNING=1"
exit /b 0
