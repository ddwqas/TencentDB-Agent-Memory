@echo off
pwsh.exe -NoProfile -File "%~dp0stop-all.ps1" %*
exit /b %ERRORLEVEL%
