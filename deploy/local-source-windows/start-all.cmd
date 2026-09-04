@echo off
pwsh.exe -NoProfile -File "%~dp0start-all.ps1" %*
exit /b %ERRORLEVEL%
