@echo off
setlocal
chcp 936 >nul 2>nul
cd /d "%~dp0"
title YF-Robot 聊天

REM ============================================
REM  把网页聊天页当成独立窗口打开。
REM
REM  和控制台的区别：
REM    · 桌面控制台.bat → 管理后台（设置、素材、日志）
REM    · 桌面聊天.bat   → 聊天窗口（能传图、能看流式回复）
REM
REM  两者都是同一个本地服务，只是入口页面不同。
REM ============================================

set "URL=http://127.0.0.1:8899/"
set "PROFILE=%~dp0data\app-profile-chat"

REM ===== 1. 服务没起来就先拉起来 =====
call :check_port
if "%RUNNING%"=="1" goto open

echo.
echo   服务没在跑，正在启动…
echo.

if not exist "%~dp0runtime\node.exe" (
    echo   [错误] 找不到 runtime\node.exe
    pause
    exit /b 1
)

start "" /min "%~dp0runtime\node.exe" "%~dp0app.mjs"

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
echo   聊天窗口: %URL%
echo.
echo   关闭这个黑窗口不会停服务。
echo.

set "BR="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BR=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BR if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BR=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BR if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BR=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BR if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BR=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if not defined BR (
    start "" "%URL%"
    goto done
)

if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>nul

start "" "%BR%" --app=%URL% --user-data-dir="%PROFILE%" --window-size=900,760 --no-first-run --no-default-browser-check

:done
exit /b 0

:check_port
set "RUNNING=0"
for /f "tokens=*" %%L in ('netstat -ano ^| findstr /c:":8899" ^| findstr /c:"LISTENING"') do set "RUNNING=1"
exit /b 0
