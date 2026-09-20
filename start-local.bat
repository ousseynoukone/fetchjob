@echo off
echo Starting Docker services (Postgres and Redis)...
docker compose up -d postgres redis

echo Starting the backend API...
start "Backend API" cmd /c "cd apps\api && set AUTO_APPLY_HEADLESS=false && npm run dev"

echo Starting the frontend Web app...
start "Frontend Web" cmd /c "cd apps\web && npm run dev"

echo All services started! 
echo Frontend is available at http://localhost:3001
echo API is available at http://localhost:4000/api
