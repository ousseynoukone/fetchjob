#!/bin/bash
# FindUrJob — native macOS start, no Docker. Safe to double-click every time.
# The database is the shared live Neon instance (same one every machine uses)
# -- nothing local to set up for it; Prisma migrate deploy just keeps the
# schema current.
set -e
cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"
mkdir -p .run

echo "== FindUrJob — demarrage natif (macOS, sans Docker) =="

echo "Verification des mises a jour (git pull)..."
git pull --ff-only || echo "Pull impossible (modifications locales, ou hors ligne) -- poursuite avec le code actuel."

echo "Installation/mise a jour des dependances (npm install)..."
npm install

# ---------------------------------------------------------------------------
# 1. Prisma: generate the client + apply any pending migration. The database
#    is the shared live Neon instance (DATABASE_URL/DIRECT_DATABASE_URL in
#    apps/api/.env.local) -- every machine points at the same data now, so
#    there's no local role/database to create and nothing to restore here.
#    Always safe to run -- idempotent.
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
# 2. Native Chrome over CDP — real desktop Chrome fingerprint for sources
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
# 3. API + Web, as plain local npm processes (not containers).
# ---------------------------------------------------------------------------
start_bg() {
  local name="$1" dir="$2" logfile="$3" pidfile="$4"
  if [ -f "$pidfile" ] && ps -p "$(cat "$pidfile" 2>/dev/null)" &>/dev/null; then
    echo "$name : deja en cours (PID $(cat "$pidfile"))."
    return
  fi
  # Confirmed live: a PAST stop/restart that killed only the pidfile's
  # top-level `npm run dev` PID (this script's own old behaviour, and
  # watchdog-mac.sh's, before this fix) can leave the real work -- nest
  # start --watch's dist/main child, or next dev's next-server child --
  # running as an orphan, invisible to the check above since its OWN pid
  # was never the one recorded in the pidfile. Found two such zombie API
  # copies still alive hours later, both running full background cron
  # schedules against the same DB and the same shared host Chrome this
  # fresh instance is about to also start driving. Cleaned here so every
  # start begins from a genuinely clean slate, not just when the pidfile
  # happens to still point at something alive.
  pkill -9 -f "$dir/dist/main" 2>/dev/null
  pkill -9 -f "$PROJECT_ROOT/node_modules/.bin/nest start" 2>/dev/null
  pkill -9 -f "$PROJECT_ROOT/node_modules/.bin/next dev" 2>/dev/null
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
