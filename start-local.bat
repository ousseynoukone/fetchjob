@echo off
setlocal
cd /d "%~dp0"

echo Checking Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running -- starting it...
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  echo Waiting for Docker Desktop to become ready ^(can take a minute^)...
  powershell -NoProfile -Command ^
    "$ok = $false; for ($i = 0; $i -lt 60; $i++) { docker info *> $null; if ($LASTEXITCODE -eq 0) { $ok = $true; break }; Start-Sleep -Seconds 3 }; if (-not $ok) { exit 1 }"
  if errorlevel 1 (
    echo Docker Desktop did not become ready in time.
    goto :end
  )
)

echo Stopping the Docker api/web containers if running (freeing ports 4000/3001)...
docker compose stop api web >nul 2>&1

echo Starting Docker services (Postgres and Redis only)...
docker compose up -d postgres redis

echo Starting the local host Chrome (headless, used over CDP)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-host-chrome.ps1"

echo Starting the backend API...
start "Backend API" cmd /c "cd apps\api && set AUTO_APPLY_HEADLESS=false && npm run dev"

echo Starting the frontend Web app...
start "Frontend Web" cmd /c "cd apps\web && npm run dev"

echo All services started!
echo Frontend is available at http://localhost:3001
echo API is available at http://localhost:4000/api

:end
