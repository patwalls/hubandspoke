#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Hub & Spoke — production health probe (home Mac, every 5 min via launchd).
#
# Polls the two public health endpoints and pages Pat through the loops
# cockpit (`loops alert`, ntfy → phone) when either is red. `loops alert fire`
# is idempotent per --key and `resolve` is a no-op unless firing, so calling
# both every tick is the intended pattern: one page when it breaks, one
# "resolved" when it clears, silence in between.
#
#   GET /api/health/worker  — heartbeat row older than 180s → 503
#   GET /api/health/queue   — due job waiting > 15 min, lock held by a dead
#                             pool > 5 min, or a stalled clip render → 503
#
# A single blip (deploy restart, a slow query) must not page: the probe
# requires two consecutive red ticks (10 min) before firing, tracked in
# $STATE_DIR. Network failure on this Mac is treated as "unknown", not red.
#
# Companion: .github/workflows/health-monitor.yml runs the same checks from
# GitHub so an outage of this Mac doesn't blind us. Install/verify with
# home-machine/health-probe/install.sh; home-machine/up.sh reports on it.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE_URL="${HS_HEALTH_BASE_URL:-https://hubandspoke.starterstory.com}"
STATE_DIR="${HS_HEALTH_STATE_DIR:-$HOME/.config/hubandspoke/health-probe}"
LOOPS_BIN="${LOOPS_BIN:-$HOME/.local/bin/loops}"
mkdir -p "$STATE_DIR"

ts() { date -u +%FT%TZ; }
log() { printf '%s %s\n' "$(ts)" "$*"; }

probe() {  # probe <name> → sets CODE and BODY
  local out
  out="$(curl -sS --max-time 20 -w $'\n%{http_code}' "$BASE_URL/api/health/$1" 2>/dev/null)" || out=$'\n000'
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}

reasons_of() {  # best-effort extraction of "reasons" from the JSON body
  printf '%s' "$1" | /usr/bin/python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    r=d.get("reasons") or ([d.get("reason")] if d.get("reason") else [])
    print("; ".join(x for x in r if x) or ("ok" if d.get("ok") else "unhealthy"))
except Exception:
    print("no JSON body")' 2>/dev/null
}

overall_red=0; unknown=0; summary=""
for ep in worker queue; do
  probe "$ep"
  if [ "$CODE" = "200" ]; then
    log "$ep 200"
  elif [ "$CODE" = "000" ]; then
    unknown=1; log "$ep unreachable from this Mac"
  elif [ "$CODE" = "404" ]; then
    # The route isn't deployed (a rollback, or a branch that predates it).
    # Not a queue problem — say so, don't page.
    unknown=1; log "$ep 404 (route missing — not deployed?)"
  else
    overall_red=1
    why="$(reasons_of "$BODY")"
    summary+="/api/health/$ep → $CODE: $why"$'\n'
    log "$ep $CODE $why"
  fi
done

STREAK_FILE="$STATE_DIR/red-streak"
streak=0; [ -f "$STREAK_FILE" ] && streak="$(cat "$STREAK_FILE" 2>/dev/null || echo 0)"

if [ "$overall_red" -eq 1 ]; then
  streak=$((streak + 1)); echo "$streak" > "$STREAK_FILE"
  if [ "$streak" -ge 2 ] && [ -x "$LOOPS_BIN" ]; then
    "$LOOPS_BIN" alert fire \
      --key hubandspoke/health \
      --loop hubandspoke \
      --priority urgent \
      --title "Hub & Spoke background jobs are stuck — check the worker" \
      --body "$(printf '%s\nRed for %d consecutive probes (5 min apart).\nRunbook: docs/automation.md → Queue health and lock reconciliation.\nQuick look: heroku logs --app hubandspoke --dyno worker -n 300 | grep -E "lock-reconcile|clip-render"' "$summary" "$streak")" \
      >/dev/null 2>&1 && log "paged (streak=$streak)" || log "page attempt failed (loops alert)"
  else
    log "red streak=$streak (page at 2)"
  fi
elif [ "$unknown" -eq 1 ]; then
  log "inconclusive — leaving state alone (streak=$streak)"
else
  if [ "$streak" -gt 0 ]; then
    echo 0 > "$STREAK_FILE"
    [ -x "$LOOPS_BIN" ] && "$LOOPS_BIN" alert resolve --key hubandspoke/health >/dev/null 2>&1 && log "resolved page"
  fi
fi
exit 0
