@echo off
title Your Data Hub
cd /d "%~dp0"
if not exist node_modules (
  echo First run - installing dependencies, one moment...
  call npm install
)
set SDH_OPEN=1
echo Starting Your Data Hub... a browser window will open.
echo Keep this window open while you use the hub. Close it to stop.
npm start
