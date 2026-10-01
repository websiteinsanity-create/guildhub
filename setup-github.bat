@echo off
title Put Guild Hall on GitHub
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed. Get it from https://git-scm.com/download/win , then run this file again.
  start https://git-scm.com/download/win
  pause
  exit /b 1
)
where gh >nul 2>nul
if errorlevel 1 (
  echo The GitHub command line tool is not installed. Get it from https://cli.github.com/ , then run this file again.
  echo Or follow the manual steps in README.md, section "Put it on GitHub".
  start https://cli.github.com/
  pause
  exit /b 1
)
git config user.email >nul 2>nul
if errorlevel 1 (
  echo Git needs to know who you are first. Run these two lines, then start this file again:
  echo   git config --global user.name "Your Name"
  echo   git config --global user.email "you@example.com"
  pause
  exit /b 1
)

gh auth status >nul 2>nul
if errorlevel 1 gh auth login

if not exist .git git init -b main
git add -A
git commit -m "Guild Hall"
echo.
set /p REPO=Name for the new private repository [guild-hall]: 
if "%REPO%"=="" set REPO=guild-hall
gh repo create %REPO% --private --source=. --remote=origin --push
echo.
echo Done. Open the repository on GitHub, then look at the Actions tab: tests and the Docker image run there on every push.
pause
