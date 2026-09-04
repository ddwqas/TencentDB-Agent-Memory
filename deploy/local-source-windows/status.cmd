@echo off
pwsh.exe -NoProfile -File "%~dp0status.ps1" %*
exit /b %ERRORLEVEL%
