#!/usr/bin/env bash
# Hub & Spoke ops-loop recovery — the DURABLE backstop (system crontab, every 15 min).
# Adapted from slope's deploy/loop-recovery.sh (same stamp/lock/pause contract).
#
# A system crontab survives reboots, dead tmux sessions, and Claude credit windows — the
# failure modes that kill every session-tied mechanism. Liveness = the lap stamp
# (~/.claude/hubandspoke-lap-stamp), written deterministically by loop-runner.sh at every
# lap start + end.
#
# Decision table (in order):
#   LOOPS_PAUSED exists          -> do nothing (pause > recovery)
#   stamp fresh (< STALE_MIN)    -> do nothing (log DEGRADED if last 3 laps all rc!=0)
#   runner alive + stamp stale   -> kill the wedged runner tree, relaunch
#   nothing alive + stamp stale  -> relaunch the runner, detached
#
# Install (idempotent):  bash home-machine/ops-loop-recovery.sh --install
# Log: ~/.claude/hubandspoke-recovery.log
set -uo pipefail

REPO_DIR="$HOME/code/hubandspoke"
STAMP="$HOME/.claude/hubandspoke-lap-stamp"
RUNNER="$HOME/.claude/loop-runner.sh"
LOCK="$REPO_DIR/.loop.pid"
LOG="$HOME/.claude/hubandspoke-recovery.log"
STALE_MIN=150          # cadence is 60m + laps are short; >2.5h without a stamp = dead/hung
INTERVAL="1h"          # relaunch cadence (matches /go's default)

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

if [ "${1:-}" = "--install" ]; then
  ME="$REPO_DIR/home-machine/ops-loop-recovery.sh"
  TAG="# hubandspoke-ops-loop-recovery"
  ( crontab -l 2>/dev/null | grep -v "$TAG"; \
    echo "*/15 * * * * /bin/bash $ME >/dev/null 2>&1 $TAG" ) | crontab -
  echo "installed: $(crontab -l | grep "$TAG")"
  exit 0
fi

# Pause wins over recovery, always.
[ -f "$HOME/.claude/LOOPS_PAUSED" ] && exit 0

now=$(date +%s)
stamp=$(cat "$STAMP" 2>/dev/null || echo 0)
age_min=$(( (now - stamp) / 60 ))

if [ "$age_min" -lt "$STALE_MIN" ]; then
  # Healthy — but a stamp-fresh runner can still be failing every lap (slope lap 1868:
  # 72 straight rc=1 laps looked "healthy" for a day). Flag a non-zero streak.
  FAIL_STREAK=0
  if [ -f "$REPO_DIR/.loop.log" ]; then
    rcs=($(grep -o 'rc=[0-9-]*' "$REPO_DIR/.loop.log" 2>/dev/null | sed 's/rc=//' | tail -20))
    for ((i=${#rcs[@]}-1; i>=0; i--)); do
      [ "${rcs[$i]}" = "0" ] && break
      FAIL_STREAK=$((FAIL_STREAK+1))
    done
  fi
  if [ "$FAIL_STREAK" -ge 3 ]; then
    log "DEGRADED — stamp fresh but last ${FAIL_STREAK} laps all rc!=0: $(tail -1 "$REPO_DIR/.loop.log" 2>/dev/null)"
  fi
  exit 0
fi

# Stamp stale. If a runner is still around, it's wedged — kill its tree first.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  PID="$(cat "$LOCK")"
  log "stamp ${age_min}m stale but runner PID $PID alive — killing wedged runner tree"
  pkill -TERM -P "$PID" 2>/dev/null; kill -TERM "$PID" 2>/dev/null; sleep 3
  pkill -KILL -P "$PID" 2>/dev/null; kill -KILL "$PID" 2>/dev/null
  rm -f "$LOCK"
fi

log "stamp ${age_min}m stale — relaunching ops loop (${INTERVAL})"
cd "$REPO_DIR" || { log "✗ repo dir missing"; exit 1; }
nohup "$RUNNER" "$INTERVAL" >> "$REPO_DIR/.loop.log" 2>&1 &
disown
log "relaunched (PID $!)"
