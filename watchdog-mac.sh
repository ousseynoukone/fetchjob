#!/bin/bash
# External API watchdog. Runs as its OWN process, independent of the API's
# event loop, specifically because nothing inside a synchronously-frozen
# Node process (setTimeout, this app's own 150s apply watchdog, the
# BrowserConcurrencyService lock timeout) can be trusted to fire during
# exactly the kind of freeze this exists to catch — confirmed live: the
# API sat CPU-busy but fully silent for 3 hours with its own in-process
# watchdog never firing. This checks from OUTSIDE that process instead.
#
# Not started automatically by start-mac.command (a deliberate choice, so
# it doesn't fight anyone debugging a hang by hand) -- run it yourself in
# its own terminal/nohup when you want the app self-healing unattended:
#   nohup ./watchdog-mac.sh > .run/watchdog.log 2>&1 &
set -u
cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"

# Confirmed live: a non-login/non-interactive shell here can end up with a
# bare PATH that's missing npm entirely (nvm installs are only added to
# PATH by shell profile scripts an interactive login shell sources). Falls
# back to nvm's default-aliased node/npm directly if `npm` isn't already
# reachable, rather than failing silently on every restart attempt.
if ! command -v npm &>/dev/null; then
  NVM_DEFAULT="$(cat "$HOME/.nvm/alias/default" 2>/dev/null)"
  for dir in "$HOME/.nvm/versions/node/v${NVM_DEFAULT}"*"/bin" "$HOME/.nvm/versions/node/"*/bin; do
    [ -x "$dir/npm" ] && { export PATH="$dir:$PATH"; break; }
  done
fi

CHECK_INTERVAL_S=30
FAIL_THRESHOLD=4   # 4 * 30s = 2 minutes unresponsive before restarting

fails=0
echo "$(date '+%F %T') watchdog started, checking every ${CHECK_INTERVAL_S}s (restart after ${FAIL_THRESHOLD} misses)."

while true; do
  sleep "$CHECK_INTERVAL_S"
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 http://localhost:4000/api/parametres 2>/dev/null || echo "000")

  if [ "$code" = "200" ]; then
    if [ "$fails" -gt 0 ]; then
      echo "$(date '+%F %T') API responsive again after $fails miss(es)."
    fi
    fails=0
    continue
  fi

  fails=$((fails + 1))
  echo "$(date '+%F %T') API check failed (HTTP $code) — miss $fails/$FAIL_THRESHOLD."

  if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
    echo "$(date '+%F %T') API unresponsive for $((FAIL_THRESHOLD * CHECK_INTERVAL_S))s — restarting it."
    # Confirmed live: killing only the pidfile's top-level `npm run dev` PID
    # leaves its children (nest start --watch, and ITS child, the actual
    # dist/main process) alive as orphans -- they keep running full
    # background cron schedules against the same DB and the same shared
    # host Chrome as the new instance this is about to start, invisible to
    # `lsof -ti tcp:4000` the moment they stop holding that port. Found two
    # such zombies still running hours later, live, on this exact project.
    # Pattern-matched by this project's own path so a different project's
    # node process is never touched.
    pkill -9 -f "$PROJECT_ROOT/apps/api/dist/main" 2>/dev/null
    pkill -9 -f "$PROJECT_ROOT/node_modules/.bin/nest start" 2>/dev/null
    if [ -f "$PROJECT_ROOT/.run/api.pid" ]; then
      OLDPID=$(cat "$PROJECT_ROOT/.run/api.pid" 2>/dev/null)
      [ -n "$OLDPID" ] && kill -9 "$OLDPID" 2>/dev/null
    fi
    for PID in $(lsof -ti tcp:4000 2>/dev/null || true); do kill -9 "$PID" 2>/dev/null || true; done
    sleep 2
    (
      cd "$PROJECT_ROOT/apps/api"
      nohup npm run dev > "$PROJECT_ROOT/.run/api.log" 2>&1 &
      echo $! > "$PROJECT_ROOT/.run/api.pid"
    )
    echo "$(date '+%F %T') restart issued (new PID $(cat "$PROJECT_ROOT/.run/api.pid" 2>/dev/null))."
    fails=0
    sleep 30
  fi
done
