#!/bin/bash
# FindUrJob — native macOS start, no Docker. Safe to double-click every time:
# already-done steps (DB role/database, data restore, dependency install)
# are detected and skipped; only what's missing gets done.
set -e
cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"
mkdir -p .run

echo "== FindUrJob — demarrage natif (macOS, sans Docker) =="

# ---------------------------------------------------------------------------
# 1. Postgres.app — this is a SHARED server (other local projects use it
#    too), so we only start it if it's not already running; we never stop
#    or restart it here.
# ---------------------------------------------------------------------------
PG_BIN="/Applications/Postgres.app/Contents/Versions/latest/bin"
PGDATA=$(ls -d "$HOME/Library/Application Support/Postgres/var-"* 2>/dev/null | head -1)

if [ ! -x "$PG_BIN/pg_ctl" ] || [ -z "$PGDATA" ]; then
  echo "Postgres.app introuvable (attendu dans /Applications/Postgres.app)."
  echo "Installe-le depuis https://postgresapp.com puis relance ce script."
  open "https://postgresapp.com" 2>/dev/null || true
  read -p "Appuie sur Entree pour fermer..."
  exit 1
fi

if ! "$PG_BIN/pg_isready" -q 2>/dev/null; then
  # A stale postmaster.pid (left over from a crash, or the PID it names got
  # reused by an unrelated process) blocks startup with a "lock file already
  # exists" error -- safe to clear only when that PID isn't actually postgres.
  if [ -f "$PGDATA/postmaster.pid" ]; then
    LOCK_PID=$(head -1 "$PGDATA/postmaster.pid")
    if ! ps -p "$LOCK_PID" -o comm= 2>/dev/null | grep -qi postgres; then
      echo "Suppression du postmaster.pid perime (PID $LOCK_PID n'est plus Postgres)..."
      rm -f "$PGDATA/postmaster.pid"
    fi
  fi
  echo "Demarrage de Postgres.app..."
  "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/postgresql.log" start -w
else
  echo "Postgres.app : deja actif."
fi

PSQL="$PG_BIN/psql"

# ---------------------------------------------------------------------------
# 2. Role + database for this project (idempotent).
# ---------------------------------------------------------------------------
if ! "$PSQL" -tAc "SELECT 1 FROM pg_roles WHERE rolname='findurjob'" postgres | grep -q 1; then
  echo "Creation du role findurjob..."
  "$PSQL" -c "CREATE ROLE findurjob LOGIN PASSWORD 'password' CREATEDB;" postgres
fi
if ! "$PSQL" -tAc "SELECT 1 FROM pg_database WHERE datname='findurjob'" postgres | grep -q 1; then
  echo "Creation de la base findurjob..."
  "$PSQL" -c "CREATE DATABASE findurjob OWNER findurjob;" postgres
fi

# ---------------------------------------------------------------------------
# 3. Restore the production data dump — ONLY the first time (guarded by a
#    marker file, since re-running pg_restore on a live database would wipe
#    out everything done locally since). Needs pg_restore from
#    postgresql@18 (brew) specifically: the dump was made with pg_dump v18
#    (custom format v1.16), newer than Postgres.app's bundled v16 tools,
#    which refuse to read it.
# ---------------------------------------------------------------------------
RESTORE_MARKER="$PROJECT_ROOT/.postgres-restored"
DUMP="$PROJECT_ROOT/migration-to-mac/findurjob_export.dump"
PG18_PREFIX=$(brew --prefix postgresql@18 2>/dev/null || true)

if [ -f "$DUMP" ] && [ ! -f "$RESTORE_MARKER" ]; then
  if [ -n "$PG18_PREFIX" ] && [ -x "$PG18_PREFIX/bin/pg_restore" ]; then
    echo "Restauration des donnees de production (premiere fois seulement)..."
    PGPASSWORD=password "$PG18_PREFIX/bin/pg_restore" \
      -h localhost -p 5432 -U findurjob -d findurjob \
      --clean --if-exists --no-owner --no-privileges \
      "$DUMP" || echo "(des avertissements pg_restore sont normaux ici -- verifie que les tables sont bien remplies)"
    touch "$RESTORE_MARKER"
    echo "Donnees restaurees."
  else
    echo "postgresql@18 non installe (brew install postgresql@18) -- restauration ignoree."
    echo "L'app demarrera quand meme avec une base vide (schema via les migrations Prisma)."
  fi
else
  echo "Donnees : deja restaurees (ou pas de dump a restaurer)."
fi

# ---------------------------------------------------------------------------
# 4. Prisma: generate the client + apply any migration not yet in the
#    restored database. Always safe to run -- idempotent.
# ---------------------------------------------------------------------------
echo "Prisma generate + migrate deploy..."
(
  cd "$PROJECT_ROOT/apps/api"
  set -a
  source .env.local
  set +a
  npx prisma generate
  npx prisma migrate deploy
)

# ---------------------------------------------------------------------------
# 5. Native Chrome over CDP — real desktop Chrome fingerprint for sources
#    like Indeed that flag headless/containerized browsers. Everything else
#    works fine without it.
# ---------------------------------------------------------------------------
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -f "$CHROME" ]; then
  if ! curl -s http://127.0.0.1:9222/json/version &>/dev/null; then
    echo "Demarrage de Chrome local (headless, pour CDP)..."
    PROFILE_DIR="$HOME/.findurjob/host-chrome-profile"
    mkdir -p "$PROFILE_DIR"
    nohup "$CHROME" \
      --remote-debugging-port=9222 \
      --user-data-dir="$PROFILE_DIR" \
      --no-first-run \
      --no-default-browser-check \
      --headless=new \
      --window-size=1920,1080 \
      --lang=fr-FR \
      about:blank &> "$PROJECT_ROOT/.run/chrome.log" &
    disown
    sleep 2
    echo "Chrome local pret sur :9222."
  else
    echo "Chrome local : deja actif sur :9222."
  fi
else
  echo "Google Chrome non trouve -- l'app fonctionnera quand meme (repli sur Chromium interne)."
fi

# ---------------------------------------------------------------------------
# 6. API + Web, as plain local npm processes (not containers).
# ---------------------------------------------------------------------------
start_bg() {
  local name="$1" dir="$2" logfile="$3" pidfile="$4"
  if [ -f "$pidfile" ] && ps -p "$(cat "$pidfile" 2>/dev/null)" &>/dev/null; then
    echo "$name : deja en cours (PID $(cat "$pidfile"))."
    return
  fi
  (
    cd "$dir"
    nohup npm run dev > "$logfile" 2>&1 &
    echo $! > "$pidfile"
  )
  echo "$name demarre (PID $(cat "$pidfile"))."
}

echo "Demarrage de l'API..."
start_bg "API" "$PROJECT_ROOT/apps/api" "$PROJECT_ROOT/.run/api.log" "$PROJECT_ROOT/.run/api.pid"

echo "Demarrage du Web..."
start_bg "Web" "$PROJECT_ROOT/apps/web" "$PROJECT_ROOT/.run/web.log" "$PROJECT_ROOT/.run/web.pid"

echo "Attente que l'API soit prete..."
ready=0
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/api/version 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 3
done

echo ""
if [ "$ready" = "1" ]; then
  echo "================================================"
  echo " FindUrJob est pret."
  echo " Frontend : http://localhost:3001"
  echo " API      : http://localhost:4000/api"
  echo " Logs     : .run/api.log , .run/web.log"
  echo "================================================"
  open "http://localhost:3001"
else
  echo "L'API n'a pas repondu a temps -- verifie .run/api.log"
fi

read -p "Appuie sur Entree pour fermer cette fenetre (l'app continue de tourner)..."
