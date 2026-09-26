@echo off
setlocal
cd /d "%~dp0"

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
