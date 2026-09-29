#!/bin/bash
# FindUrJob — native macOS stop. Double-click to shut everything down.
# Does NOT stop Postgres.app itself: it's a shared server other local
# projects on this Mac also use (diagnocare, skillux, ...); only this
# project's own processes are stopped.
cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"

echo "== FindUrJob — arret (macOS) =="

stop_pidfile() {
  local name="$1" pidfile="$2"
  if [ -f "$pidfile" ]; then
    PID=$(cat "$pidfile" 2>/dev/null)
    if [ -n "$PID" ] && ps -p "$PID" &>/dev/null; then
      kill "$PID" 2>/dev/null || true
      echo "$name arrete (PID $PID)."
    fi
    rm -f "$pidfile"
  fi
}

stop_pidfile "API" "$PROJECT_ROOT/.run/api.pid"
stop_pidfile "Web" "$PROJECT_ROOT/.run/web.pid"

# Confirmed live: stop_pidfile's `kill $PID` only signals the top-level
# `npm run dev` process. Its children (nest start --watch, and ITS child,
# the real dist/main process the API actually runs as; same for Web's
# `next dev` -> next-server) are never signalled at all and keep running
# as orphans -- found two such zombie API copies hours later, both still
# fully alive, both running full background cron schedules against the
# same DB and the same shared host Chrome as whatever starts next. The
# port-fallback below only catches whatever CURRENTLY holds the port,
# which an orphan that already lost that race never does again. Pattern-
# matched by this project's own path so a different project's node
# process is never touched.
pkill -9 -f "$PROJECT_ROOT/apps/api/dist/main" 2>/dev/null && echo "Instances API orphelines nettoyees."
pkill -9 -f "$PROJECT_ROOT/node_modules/.bin/nest start" 2>/dev/null
pkill -9 -f "$PROJECT_ROOT/apps/web" 2>/dev/null && echo "Instances Web orphelines nettoyees."

# Fallback in case a pidfile was stale/missing but something is still bound
# to these ports (e.g. a `next dev` child process outliving its parent).
for PORT in 4000 3001; do
  PIDS=$(lsof -ti tcp:$PORT 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    kill $PIDS 2>/dev/null || true
    echo "Port $PORT libere."
  fi
done

echo "Arret de Chrome local (CDP :9222)..."
PID=$(lsof -ti tcp:9222 2>/dev/null || true)
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null || true
  echo "Chrome local arrete."
else
  echo "Chrome local n'etait pas actif."
fi

# Public tunnel + its auth proxy, if share-mac.command left any running.
stop_pidfile "Tunnel" "$PROJECT_ROOT/.run/tunnel-web.pid"
stop_pidfile "Proxy d'authentification" "$PROJECT_ROOT/.run/tunnel-proxy.pid"

echo ""
echo "================================================"
echo " FindUrJob est arrete."
echo " (Postgres.app reste actif -- c'est un serveur partage"
echo "  avec d'autres projets sur ce Mac.)"
echo "================================================"
read -p "Appuie sur Entree pour fermer cette fenetre..."
