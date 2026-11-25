@echo off
setlocal
chcp 65001 >nul
title Agent Relay

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or is not in PATH.
  echo Install Node.js 18 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist package.json (
  echo [ERROR] package.json was not found.
  pause
  exit /b 1
)

if not exist node_modules\ws (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting Agent Relay...
echo Keep this window open while the relay is running.
echo.
node server.js

echo.
echo Agent Relay has stopped.
pause
