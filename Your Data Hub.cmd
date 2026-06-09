@echo off
title Your Data Hub
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Node.js was not found on this computer.
  echo  Install it from https://nodejs.org  then double-click this again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run - installing dependencies, one moment...
  call npm install
)

REM If a previous hub is still running on port 8787, stop it so this one can start.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "127.0.0.1:8787" ^| findstr LISTENING') do (
  echo Stopping a previous hub still running (PID %%P)...
  taskkill /F /PID %%P >nul 2>&1
)

set SDH_OPEN=1
echo Starting Your Data Hub... a browser window will open.
echo Keep this window open while you use the hub. Close it to stop.
echo.
call npm start

echo.
echo ============================================================
echo  The hub has stopped. If there is an error above, that is
echo  the reason. This window stays open so you can read it.
echo ============================================================
pause
