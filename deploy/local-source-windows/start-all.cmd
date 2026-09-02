@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" %*
exit /b %ERRORLEVEL%

