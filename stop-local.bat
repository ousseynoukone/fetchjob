@echo off
setlocal
cd /d "%~dp0"

echo Stopping the local backend API and frontend Web (ports 4000/3001)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4000,3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>&1
taskkill /FI "WINDOWTITLE eq Backend API*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Frontend Web*" /T /F >nul 2>&1

echo Stopping Docker (Postgres, Redis)...
docker compose stop postgres redis

echo Stopping the local host Chrome...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-host-chrome.ps1" -Stop

echo.
echo ================================================
echo  FindUrJob (local) is stopped.
echo ================================================
