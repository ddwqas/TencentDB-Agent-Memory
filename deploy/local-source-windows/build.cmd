@echo off
pwsh.exe -NoProfile -File "%~dp0build.ps1" %*
exit /b %ERRORLEVEL%
