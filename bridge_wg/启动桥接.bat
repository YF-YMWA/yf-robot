@echo off
setlocal
cd /d "%~dp0"

REM 设置鲸鲸接口（环境变量优先级高于配置文件）
set "WHALE_BOT_URL=http://127.0.0.1:8899/api/wechat"

echo ============================================
echo   鲸鲸 · 微信桥接（独立版）
echo ============================================
echo.
echo 目标: %WHALE_BOT_URL%
echo.

REM 需要管理员权限才能激活微信控件树
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 需要管理员权限，正在提权...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo [管理员模式]
echo.

set "PY=%~dp0..\runtime\python\python.exe"
if not exist "%PY%" (
    echo [错误] 找不到 Python: %PY%
    pause
    exit /b 1
)

"%PY%" wechatauto_bridge.py
pause
endlocal