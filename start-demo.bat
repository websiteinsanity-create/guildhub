@echo off
title Guild Hall (demo)
cd /d "%~dp0"

rem Demo mode: fake guild data in the demo-data folder. Your real data in "data" is not touched.
set MEMBER_PASSCODE=guild
set OFFICER_PASSCODE=officer
set PORT=3000
set DATA_DIR=%~dp0demo-data
set DEMO_MODE=1

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

node seed-demo.js
echo.
echo  Demo is starting on http://localhost:%PORT%
echo  Sign in with any name. Passcode "officer" = officer tools, "guild" = normal member.
echo  To reset the demo, delete the demo-data folder.
echo  Close this window to stop it.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
node server.js
pause
