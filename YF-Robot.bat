@echo off
chcp 65001 >nul 2>nul
REM 旧入口兼容：YF-Robot.bat 保留给老快捷方式和老习惯，实际转给 ENbot.bat
call "%~dp0ENbot.bat" %*
