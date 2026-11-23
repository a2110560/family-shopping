@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo This project requires Node.js 22.13 or newer.
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning server.mjs %*
if errorlevel 1 pause
