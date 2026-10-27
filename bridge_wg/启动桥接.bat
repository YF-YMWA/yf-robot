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

set "TRIES=0"
:restart
"%PY%" wechatauto_bridge.py
set "RC=%errorlevel%"

REM 退出码 0 = 正常退出（包括「已经有一个桥接在跑了」），不重启
if "%RC%"=="0" goto bridge_done

set /a TRIES+=1
echo.
echo ============================================
echo   桥接异常退出（代码 %RC%）
echo   5 秒后自动重启（第 %TRIES%/5 次）
echo   崩溃现场：bridge_wg\data\bridge-crash.log
echo ============================================
echo.
if %TRIES% GEQ 5 goto bridge_gaveup
timeout /t 5 /nobreak >nul
goto restart

:bridge_gaveup
echo.
echo [supervisor] 连续异常退出 5 次，停止自动重启。
echo 请把 bridge_wg\data\bridge-crash.log 最后一段发出来。
echo.
pause
goto bridge_done

:bridge_done
pause

endlocal