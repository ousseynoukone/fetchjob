@echo off
setlocal
cd /d "%~dp0"

echo Stopping Docker containers (Redis, API, Web)...
docker compose stop

echo Stopping the local host Chrome...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-host-chrome.ps1" -Stop

echo Closing Docker Desktop...
powershell -NoProfile -Command "Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Get-Process 'com.docker.backend' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

echo.
echo ================================================
echo  FindUrJob (Docker) is stopped.
echo ================================================
