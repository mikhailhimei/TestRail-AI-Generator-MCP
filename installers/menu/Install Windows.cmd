@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node "%~dp0setup.mjs"
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
