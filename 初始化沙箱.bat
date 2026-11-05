@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$id=[Security.Principal.WindowsIdentity]::GetCurrent(); $admin=(New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); if(-not $admin){ Start-Process -FilePath '%~f0' -Verb RunAs; exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo If no UAC window appeared, right-click this file and choose Run as administrator.
  %SystemRoot%\System32\timeout.exe /t 5 >nul
  exit /b
)
echo Preparing AppContainer sandbox...
"%~dp0runtime\python\python.exe" "%~dp0tools\sandbox_setup.py"
set RC=%errorlevel%
echo.
if "%RC%"=="0" (
  echo Sandbox ready. You can close this window.
) else (
  echo Sandbox setup failed with code %RC%. See data\sandbox-setup.log
)
pause
