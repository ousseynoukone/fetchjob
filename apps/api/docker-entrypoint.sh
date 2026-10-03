#!/bin/sh
set -e

# Only relevant when the container has to run its OWN browser instead of
# connecting to a host Chrome over CDP (BROWSER_CDP_URL unset/empty) AND
# that browser is launched non-headless (AUTO_APPLY_HEADLESS=false): a
# headed Chromium needs an X display to open a window on, and this
# container has none by default. Xvfb provides a virtual one so
# `headless: false` doesn't crash with "Missing X server or $DISPLAY".
if [ -z "$BROWSER_CDP_URL" ] && [ "$AUTO_APPLY_HEADLESS" = "false" ]; then
  echo "[entrypoint] No host Chrome configured and AUTO_APPLY_HEADLESS=false -- starting Xvfb on :99"
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
  XVFB_PID=$!
  export DISPLAY=:99

  # Wait for the X socket rather than a fixed sleep -- Xvfb's own startup
  # time varies with host load, and Chromium launching before the socket
  # exists fails exactly the same way as having no Xvfb at all.
  for i in $(seq 1 20); do
    if [ -e /tmp/.X11-unix/X99 ]; then break; fi
    sleep 0.25
  done

  trap "kill $XVFB_PID 2>/dev/null" EXIT

  # Confirmed live: without this, Chromium's ANGLE backend fails to create
  # ANY WebGL context at all under Xvfb+Mesa (getContext('webgl') === null)
  # -- a much stronger bot signal than a software-renderer string, since
  # every real browser can create SOME WebGL context. Forces Mesa's llvmpipe
  # software rasterizer so ANGLE gets a real (if software) one instead.
  export LIBGL_ALWAYS_SOFTWARE=1
fi

exec "$@"
