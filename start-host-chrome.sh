#!/bin/bash
# Linux port of start-host-chrome.ps1 — starts the real desktop Chrome that
# the API drives over CDP (see apps/api/src/common/cdp-endpoint.ts and
# BROWSER_CDP_URL). Meant to run as a systemd service on a headless Linux
# server (see findurjob-chrome.service) so the app no longer depends on a
# PC being left on — same technique, just running on a server instead.
#
# HEADLESS BY DEFAULT, via Chrome's own --headless=new — NOT Playwright's
# launcher. That distinction is the whole point: a Chrome started this way
# reports navigator.webdriver=false and real Client Hints brands, which a
# Playwright-launched one cannot (confirmed live on Windows/Mac — see
# start-host-chrome.ps1 and start-mac.command). --headless=new needs no X
# display, so no Xvfb here for the default path.
#
# UNPROVEN ON THIS HOST: the Windows/Mac confirmation relied on a real GPU
# for WebGL (ANGLE/hardware, not SwiftShader). A typical no-GPU VPS has no
# /dev/dri device at all, so WebGL still falls back to software rendering
# here regardless of how Chrome is launched — the one signal this script
# can't fix. If Indeed still gets Cloudflare-walled after switching to
# this, that's the likely reason; a GPU-enabled instance or a residential
# proxy (SCRAPER_PROXIES) are the next levers, not this script.
#
# Deliberately NOT passed (same reasoning as start-host-chrome.ps1):
#  - --enable-automation
#  - --remote-allow-origins=*
#
#   ./start-host-chrome.sh              # headless (default), backgrounded
#   ./start-host-chrome.sh --visible    # headed, under Xvfb (needs xvfb-run installed)
#   ./start-host-chrome.sh --stop
#   ./start-host-chrome.sh --foreground # for findurjob-chrome.service — see there
#                                        # for why this can't just background+exit
#                                        # like the default mode does.

set -euo pipefail

VISIBLE=0
STOP=0
FOREGROUND=0
for arg in "${@:-}"; do
  case "$arg" in
    --visible) VISIBLE=1 ;;
    --stop) STOP=1 ;;
    --foreground) FOREGROUND=1 ;;
  esac
done

PROFILE_DIR="$HOME/.findurjob/host-chrome-profile"
PORT=9222

find_chrome() {
  for bin in google-chrome-stable google-chrome chromium-browser chromium; do
    if command -v "$bin" &>/dev/null; then
      command -v "$bin"
      return 0
    fi
  done
  return 1
}

find_chrome_pid() {
  pgrep -f "remote-debugging-port=$PORT" | head -1 || true
}

if [ "$STOP" = "1" ]; then
  PID="$(find_chrome_pid)"
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    echo "Host Chrome stopped."
  else
    echo "Host Chrome was not running."
  fi
  exit 0
fi

CHROME="$(find_chrome)" || { echo "Google Chrome not found. Install it: https://www.google.com/chrome/ (or apt install chromium)"; exit 1; }
mkdir -p "$PROFILE_DIR"

# Already running? Check it matches the requested visibility before
# reusing it — same recovery as start-host-chrome.ps1.
if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" &>/dev/null; then
  EXISTING_PID="$(find_chrome_pid)"
  IS_HEADLESS=0
  if [ -n "$EXISTING_PID" ] && ps -p "$EXISTING_PID" -o args= | grep -q -- '--headless'; then
    IS_HEADLESS=1
  fi
  if { [ "$VISIBLE" = "1" ] && [ "$IS_HEADLESS" = "0" ]; } || { [ "$VISIBLE" = "0" ] && [ "$IS_HEADLESS" = "1" ]; }; then
    echo "Host Chrome already running on :$PORT ($([ "$IS_HEADLESS" = "1" ] && echo headless || echo visible))."
    exit 0
  fi
  echo "Host Chrome on :$PORT does not match requested mode — restarting..."
  [ -n "$EXISTING_PID" ] && kill "$EXISTING_PID" 2>/dev/null || true
  sleep 1
fi

# Client Hints expose the true version regardless, so this only has to
# agree with them, not hide anything.
CHROME_MAJOR="$("$CHROME" --version | grep -oE '[0-9]+' | head -1)"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36"

ARGS=(
  "--remote-debugging-port=$PORT"
  "--user-data-dir=$PROFILE_DIR"
  --no-first-run
  --no-default-browser-check
  --window-size=1920,1080
  --lang=fr-FR
)

# Root-only VPS accounts (the common default) have no unprivileged user
# namespace for Chrome's sandbox to use — it refuses to start at all
# without this when run as root. Skipped entirely for a non-root user,
# since --no-sandbox is a real reduction in isolation.
if [ "$(id -u)" = "0" ]; then
  ARGS+=(--no-sandbox)
fi

if [ "$VISIBLE" = "0" ]; then
  ARGS+=(--headless=new "--user-agent=$UA")
fi

# A process that died without releasing this profile (kill -9, OOM, a
# server power-cycle) leaves Chrome's own SingletonLock/-Socket/-Cookie
# files behind, and the next launch on the same profile dir fails outright
# until they're cleared — same recovery stealth-browser.ts does for its
# own profiles.
rm -f "$PROFILE_DIR"/Singleton{Lock,Socket,Cookie} 2>/dev/null || true

if [ "$FOREGROUND" = "1" ]; then
  # For findurjob-chrome.service: `exec` replaces this script's own
  # process with Chrome's, so systemd is supervising Chrome directly and
  # Restart=on-failure actually restarts Chrome (not a script that already
  # exited 0 after backgrounding it, which is what every other mode below
  # does and is fine for interactive/manual use, but not for systemd).
  if [ "$VISIBLE" = "1" ]; then
    command -v xvfb-run &>/dev/null || { echo "xvfb-run not found (needed for --visible). Install it: apt install xvfb"; exit 1; }
    exec xvfb-run -a "$CHROME" "${ARGS[@]}" about:blank
  else
    exec "$CHROME" "${ARGS[@]}" about:blank
  fi
fi

if [ "$VISIBLE" = "1" ]; then
  if ! command -v xvfb-run &>/dev/null; then
    echo "xvfb-run not found (needed for --visible). Install it: apt install xvfb"
    exit 1
  fi
  nohup xvfb-run -a "$CHROME" "${ARGS[@]}" about:blank >"$HOME/.findurjob/host-chrome.log" 2>&1 &
  disown
else
  nohup "$CHROME" "${ARGS[@]}" about:blank >"$HOME/.findurjob/host-chrome.log" 2>&1 &
  disown
fi

for _ in $(seq 1 20); do
  sleep 0.5
  if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" &>/dev/null; then
    echo "Host Chrome ready on :$PORT ($([ "$VISIBLE" = "1" ] && echo visible || echo headless))."
    exit 0
  fi
done
echo "Chrome started but the debug port never answered — check ~/.findurjob/host-chrome.log"
exit 1
