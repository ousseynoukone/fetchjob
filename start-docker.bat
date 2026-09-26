@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo Stopping any locally-running api/web dev processes (freeing ports 4000/3001)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4000,3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>&1
taskkill /FI "WINDOWTITLE eq Backend API*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Frontend Web*" /T /F >nul 2>&1

echo Starting the local host Chrome (headless, used over CDP)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-host-chrome.ps1"

echo Starting Docker (Postgres, Redis, API, Web)...
docker compose up -d

echo Waiting for the API to become ready...
powershell -NoProfile -Command ^
  "$ok = $false; for ($i = 0; $i -lt 40; $i++) { try { $r = Invoke-WebRequest -Uri 'http://localhost:4000/api/parametres/identifiants' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}; Start-Sleep -Seconds 3 }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
  echo API did not become ready in time -- check "docker compose logs api".
  goto :end
)

:ready
echo.
echo ================================================
echo  FindUrJob (Docker) is up.
echo  Frontend : http://localhost:3001
echo  API      : http://localhost:4000/api
echo ================================================
start "" http://localhost:3001

:end
