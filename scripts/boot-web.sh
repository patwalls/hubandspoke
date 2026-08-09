#!/usr/bin/env bash
# Web dyno boot wrapper: start Next, then fire the warmer once the server
# answers. Kills the first-user-after-deploy cold hit — measured 2.28s of
# lazy route/module initialization + a cold report cache on every restart.
#
# Signal contract (Heroku sends SIGTERM at shutdown): forward it to the Next
# process and wait, so graceful shutdown behaves exactly like `npm start`.
set -u

npm start &
NEXT_PID=$!
trap 'kill -TERM "$NEXT_PID" 2>/dev/null' TERM INT

(
  # Warm in the background; never block or kill the dyno on failure.
  for _ in $(seq 1 30); do
    sleep 2
    if curl -s -o /dev/null --max-time 2 "http://localhost:${PORT:-3000}/login"; then
      curl -s --max-time 120 -H "Authorization: Bearer ${CRON_SECRET:-}" \
        "http://localhost:${PORT:-3000}/api/warm" >/dev/null 2>&1 || true
      echo "[boot-web] warmup fired"
      break
    fi
  done
) &

wait "$NEXT_PID"
