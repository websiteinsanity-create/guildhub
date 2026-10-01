@echo off
title Guild Hall
cd /d "%~dp0"

rem ---- Change these before you let anyone else in ----
set MEMBER_PASSCODE=guild
set OFFICER_PASSCODE=officer
set PORT=3000

rem Look for new code on GitHub every 5 minutes (only does anything if this folder came from GitHub).
set AUTO_UPDATE_MINUTES=5

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Guild Hall needs it to run.
  echo  Opening the download page. Install the LTS version, then run this file again.
  echo.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)

echo.
echo  Guild Hall is starting on http://localhost:%PORT%
echo  Member passcode:  %MEMBER_PASSCODE%
echo  Officer passcode: %OFFICER_PASSCODE%
echo  Close this window to stop it.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"

:run
node server.js
if %errorlevel% EQU 75 (
  echo.
  echo  New version found on GitHub. Updating...
  git pull --ff-only
  echo.
  goto run
)
pause
