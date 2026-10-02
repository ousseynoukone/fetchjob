#!/bin/bash
# FindUrJob — watch the current campaign run and shut the Mac down once it
# genuinely finishes. Start a campaign first, then double-click this.
# Always watches whichever run is currently most recent (GET /campagne/logs),
# so there's no run id to pass or track.
#
# NOT executed/tested on a real Mac (built on Windows this session, like the
# rest of the native Mac scripts) -- only `bash -n` syntax-checked. Review
# before trusting it unattended.
cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"
API="http://localhost:4000/api"
LOG="$PROJECT_ROOT/.run/campaign-watch.log"
MAX_ITERATIONS=360   # 360 * 60s = 6 hours safety cap
INTERVAL_SECONDS=60
mkdir -p "$PROJECT_ROOT/.run"

echo "Watching the current campaign run in the background -- log: $LOG"

(
  echo "$(date '+%Y-%m-%d %H:%M:%S') Watcher started (PID $$)." >> "$LOG"

  for ((i = 0; i < MAX_ITERATIONS; i++)); do
    sleep "$INTERVAL_SECONDS"
    RESULT=$(curl -s "$API/campagne/logs" --max-time 15 | node -e "
      let d='';process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try {
          const run = JSON.parse(d);
          if (!run || !run.id) { console.log('MISSING'); return; }
          if (run.finishedAt == null) { console.log('RUNNING'); return; }
          console.log((run.error ? 'ERROR' : 'DONE') + '|' + JSON.stringify(run));
        } catch (e) { console.log('POLL_ERROR'); }
      })")

    STATUS="${RESULT%%|*}"

    if [ "$STATUS" = "RUNNING" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [$i] still running." >> "$LOG"
      continue
    fi

    if [ "$STATUS" = "MISSING" ] || [ "$STATUS" = "POLL_ERROR" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [$i] poll issue: $RESULT" >> "$LOG"
      continue
    fi

    if [ "$STATUS" = "ERROR" ]; then
      # Confirmed live on the Windows side this session: a restart mid-run
      # (there, Docker Desktop; here, an npm dev process dying/restarting)
      # interrupts the campaign and sets finishedAt with an error, well
      # before any real work was done -- that's not the completion the user
      # is waiting for, so don't shut down on it. Needs a fresh run.
      echo "$(date '+%Y-%m-%d %H:%M:%S') Run ended with an error (not a genuine completion) -- NOT shutting down. ${RESULT#ERROR|}" >> "$LOG"
      exit 1
    fi

    # STATUS = "DONE"
    echo "$(date '+%Y-%m-%d %H:%M:%S') Run finished cleanly. ${RESULT#DONE|}" >> "$LOG"
    echo "$(date '+%Y-%m-%d %H:%M:%S') Stopping API/Web processes..." >> "$LOG"
    for pidfile in "$PROJECT_ROOT/.run/api.pid" "$PROJECT_ROOT/.run/web.pid"; do
      if [ -f "$pidfile" ]; then
        PID=$(cat "$pidfile" 2>/dev/null)
        [ -n "$PID" ] && kill "$PID" 2>/dev/null
        rm -f "$pidfile"
      fi
    done
    pkill -9 -f "$PROJECT_ROOT/apps/api/dist/main" 2>/dev/null
    pkill -9 -f "$PROJECT_ROOT/node_modules/.bin/nest start" 2>/dev/null
    pkill -9 -f "$PROJECT_ROOT/apps/web" 2>/dev/null
    for PORT in 4000 3001; do
      PIDS=$(lsof -ti tcp:$PORT 2>/dev/null)
      [ -n "$PIDS" ] && kill $PIDS 2>/dev/null
    done
    echo "$(date '+%Y-%m-%d %H:%M:%S') Stopping host Chrome (CDP :9222)..." >> "$LOG"
    CPID=$(lsof -ti tcp:9222 2>/dev/null)
    [ -n "$CPID" ] && kill "$CPID" 2>/dev/null
    echo "$(date '+%Y-%m-%d %H:%M:%S') Shutting down the Mac now..." >> "$LOG"
    # Graceful, no special sudo setup needed -- will prompt to save work in
    # any open apps. For a guaranteed unattended shutdown instead (no
    # dialog), switch to `sudo shutdown -h now` with passwordless sudo
    # configured for this user.
    osascript -e 'tell application "System Events" to shut down'
    exit 0
  done

  echo "$(date '+%Y-%m-%d %H:%M:%S') Gave up after $MAX_ITERATIONS checks (~$((MAX_ITERATIONS * INTERVAL_SECONDS / 3600)) hours) without the campaign finishing -- NOT shutting down, something may be stuck." >> "$LOG"
) >> "$LOG" 2>&1 &
disown

echo "Started (PID $!). You can close this window -- it keeps running in the background."
