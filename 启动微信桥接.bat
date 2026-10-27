@echo off
setlocal
cd /d "%~dp0"

REM 鲸鲸 · 微信桥接
REM 转发到 bridge_wg，由那边负责提权

net session >nul 2>&1
if %errorlevel% equ 0 goto :run

echo.
echo  ============================================
echo   微信桥接需要管理员权限
echo  ============================================
echo.
echo  正在请求提权，请在弹窗点"是"
echo.

powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:run
echo.
echo  ============================================
echo   鲸鲸 · 微信桥接
echo  ============================================
echo.
echo  提示：微信窗口请保持可见，不要最小化到托盘
echo        否则发送会失败
echo.

set "BRIDGE=%~dp0bridge_wg"
if not exist "%BRIDGE%\wechatauto_bridge.py" (
    echo [错误] 找不到 bridge_wg\wechatauto_bridge.py
    pause
    exit /b 1
)

set "PY=%~dp0runtime\python\python.exe"
if not exist "%PY%" (
    echo [错误] 找不到 Python 运行时
    pause
    exit /b 1
)

set "WHALE_BOT_URL=http://127.0.0.1:8899/api/wechat"
cd /d "%BRIDGE%"
"%PY%" wechatauto_bridge.py

pause
endlocal