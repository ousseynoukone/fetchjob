#!/bin/bash
# FindUrJob — expose the locally-running app to the internet through an
# ngrok tunnel on a fixed static domain, behind an HTTP Basic Auth wall
# (see tunnel-auth-proxy.js). Run start-mac.command first if the app isn't
# already up. Safe to double-click every time: reuses the same
# username/password (stored in .run/.tunnel-auth) AND the same public URL
# (NGROK_DOMAIN below is a free static domain claimed on the ngrok account
# — see dashboard.ngrok.com/domains).
set -e
cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"
mkdir -p .run

NGROK_DOMAIN="dodge-remark-broom.ngrok-free.dev"

echo "== FindUrJob — partage public (ngrok Tunnel + mot de passe) =="

if ! command -v ngrok &>/dev/null; then
  echo "ngrok n'est pas installe. Lance : brew install ngrok"
  read -p "Appuie sur Entree pour fermer..."
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Make sure the app is actually running locally first.
# ---------------------------------------------------------------------------
if ! curl -s -o /dev/null http://localhost:4000/api/version; then
  echo "L'API locale ne repond pas -- demarrage via start-mac.command..."
  bash "$PROJECT_ROOT/start-mac.command" < /dev/null > "$PROJECT_ROOT/.run/start-from-share.log" 2>&1 &
  for i in $(seq 1 60); do
    curl -s -o /dev/null http://localhost:4000/api/version && break
    sleep 3
  done
fi

# ---------------------------------------------------------------------------
# 2. Basic Auth credentials — generated once, reused after that.
# ---------------------------------------------------------------------------
CREDS_FILE="$PROJECT_ROOT/.run/.tunnel-auth"
if [ ! -f "$CREDS_FILE" ]; then
  TUNNEL_USER="findurjob"
  TUNNEL_PASS=$(openssl rand -base64 18 | tr -dc 'a-zA-Z0-9' | head -c 20)
  echo "TUNNEL_USER=$TUNNEL_USER" > "$CREDS_FILE"
  echo "TUNNEL_PASS=$TUNNEL_PASS" >> "$CREDS_FILE"
  chmod 600 "$CREDS_FILE"
fi
source "$CREDS_FILE"

# ---------------------------------------------------------------------------
# 3. Restart Web with a same-origin (relative) API URL, so every request —
#    from anywhere on the internet — goes through this ONE tunneled
#    hostname and its login wall, instead of a second, unprotected
#    cross-origin API hostname.
# ---------------------------------------------------------------------------
echo "Redemarrage du Web en mode 'partage' (API relative, via proxy)..."
if [ -f "$PROJECT_ROOT/.run/web.pid" ]; then
  WEBPID=$(cat "$PROJECT_ROOT/.run/web.pid" 2>/dev/null)
  [ -n "$WEBPID" ] && kill "$WEBPID" 2>/dev/null || true
  rm -f "$PROJECT_ROOT/.run/web.pid"
fi
for PID in $(lsof -ti tcp:3001 2>/dev/null || true); do kill "$PID" 2>/dev/null || true; done
sleep 1
(
  cd "$PROJECT_ROOT/apps/web"
  NEXT_PUBLIC_API_URL="" nohup npm run dev > "$PROJECT_ROOT/.run/web.log" 2>&1 &
  echo $! > "$PROJECT_ROOT/.run/web.pid"
)
for i in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:3001 && break
  sleep 2
done

# ---------------------------------------------------------------------------
# 4. Basic Auth reverse proxy in front of Web (which itself proxies /api/*
#    to the API — see next.config.js rewrites).
# ---------------------------------------------------------------------------
AUTH_PROXY_PORT=3101
if [ -f "$PROJECT_ROOT/.run/tunnel-proxy.pid" ] && ps -p "$(cat "$PROJECT_ROOT/.run/tunnel-proxy.pid" 2>/dev/null)" &>/dev/null; then
  echo "Proxy d'authentification : deja actif."
else
  PROXY_PORT=$AUTH_PROXY_PORT TARGET_PORT=3001 TUNNEL_USER="$TUNNEL_USER" TUNNEL_PASS="$TUNNEL_PASS" \
    nohup node "$PROJECT_ROOT/tunnel-auth-proxy.js" > "$PROJECT_ROOT/.run/tunnel-proxy.log" 2>&1 &
  echo $! > "$PROJECT_ROOT/.run/tunnel-proxy.pid"
  sleep 1
  echo "Proxy d'authentification demarre sur :$AUTH_PROXY_PORT."
fi

# ---------------------------------------------------------------------------
# 5. ngrok tunnel -> the auth proxy (not directly to the app). Uses a fixed
#    static domain, so the public URL is the same on every run.
# ---------------------------------------------------------------------------
echo "Ouverture du tunnel ngrok..."
nohup ngrok http "$AUTH_PROXY_PORT" --url "https://$NGROK_DOMAIN" > "$PROJECT_ROOT/.run/tunnel-web.log" 2>&1 &
echo $! > "$PROJECT_ROOT/.run/tunnel-web.pid"

PUBLIC_URL=""
for i in $(seq 1 30); do
  curl -s -o /dev/null "https://$NGROK_DOMAIN" && PUBLIC_URL="https://$NGROK_DOMAIN" && break
  sleep 1
done

echo ""
if [ -n "$PUBLIC_URL" ]; then
  echo "================================================"
  echo " FindUrJob est accessible publiquement :"
  echo " $PUBLIC_URL"
  echo ""
  echo " Identifiant : $TUNNEL_USER"
  echo " Mot de passe : $TUNNEL_PASS"
  echo " (reutilises a chaque partage -- voir .run/.tunnel-auth)"
  echo ""
  echo " Cette URL est fixe -- elle ne change pas d'un lancement a l'autre."
  echo " Pour arreter le partage (et l'app) : Stop FindUrJob.command"
  echo "================================================"
else
  echo "Le tunnel n'a pas repondu a temps -- verifie .run/tunnel-web.log"
fi

read -p "Appuie sur Entree pour fermer cette fenetre (le partage continue de tourner)..."
