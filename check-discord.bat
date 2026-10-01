@echo off
rem Checks your Discord setup step by step (see README, "Testing your bot").
rem Double-click it, or run:  check-discord.bat --channel 123456789012345678 --dm 123456789012345678
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node check-discord.js %*
echo.
pause
