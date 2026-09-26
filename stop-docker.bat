@echo off
setlocal
cd /d "%~dp0"

echo Stopping Docker (Postgres, Redis, API, Web)...
docker compose stop

echo Stopping the local host Chrome...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-host-chrome.ps1" -Stop

echo.
echo ================================================
echo  FindUrJob (Docker) is stopped.
echo ================================================
