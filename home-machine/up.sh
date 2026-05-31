#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Hub & Spoke — home-machine bring-up.
#
# Run this after ANY restart or OS update to confirm the local always-on pieces
# are loaded, the Mac is caffeinated, and the hourly YouTube archiver is healthy.
# Idempotent — safe to run as many times as you like.
#
#   Usage:  home-machine/up.sh            # verify + (re)load what's down
#           home-machine/up.sh --force    # bootout + bootstrap the agent even
#                                          # if it's already loaded
#
# What it guarantees:
#   1. The Mac never sleeps    — com.pwalls.nosleep daemon + pmset sleep 0
#                                (a machine-wide daemon; shared with other repos)
#   2. The YouTube archiver     — com.hubandspoke.yt-archive runs hourly via launchd,
#                                 driven by ~/Library/Application Support/
#                                 hubandspoke-yt-archive/wrapper.sh → scripts/archive-yt-local.ts
#
# This is a VERIFY + LOAD tool. The one-time INSTALL (laying down the wrapper,
# plist, env + identity marker) is home-machine/yt-archive/install.sh — run that
# first on a fresh machine, then this to keep it healthy. If a piece is missing,
# this script tells you to re-run install.sh.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
UID_NUM="$(id -u)"
GUI="gui/$UID_NUM"
LA="$HOME/Library/LaunchAgents"
CFG="$HOME/.config/hubandspoke"
WRAPPER="$HOME/Library/Application Support/hubandspoke-yt-archive/wrapper.sh"
LABEL="com.hubandspoke.yt-archive"
LOG="$HOME/Library/Logs/hubandspoke-yt-archive.log"
ISSUES=0

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_bad=$'\033[31m'; c_b=$'\033[1m'; c_0=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$c_ok"  "$c_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_0" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$c_bad" "$c_0" "$*"; ISSUES=$((ISSUES+1)); }
hdr()  { printf '\n%s%s%s\n' "$c_b" "$*" "$c_0"; }

need() {  # need <label> <path-or-cmd>  — path (has /) must exist; bare cmd on PATH
  local label="$1" target="$2"
  if { [ "${target#*/}" != "$target" ] && [ -e "$target" ]; } \
     || command -v "$target" >/dev/null 2>&1; then ok "$label"
  else bad "$label: not found ($target)"; fi
}

printf '%s════ Hub & Spoke · home-machine bring-up ════%s\n' "$c_b" "$c_0"
[ "$FORCE" -eq 1 ] && warn "--force: the archiver agent will be booted out and reloaded"

# ── 1. Never sleep ───────────────────────────────────────────────────────────
hdr "1. Never sleep (caffeinate)"
sleep_val="$(pmset -g custom 2>/dev/null | awk '/[^a-z]sleep[^a-z]/{print $2; exit}')"
[ "$sleep_val" = "0" ] && ok "pmset idle sleep disabled (sleep 0)" \
  || { warn "pmset idle sleep = ${sleep_val:-unknown}; disable with:"; \
       printf '       %ssudo pmset -a sleep 0 disksleep 0%s\n' "$c_b" "$c_0"; }
if pgrep -f 'caffeinate -dimsu' >/dev/null 2>&1; then
  ok "caffeinate -dimsu running (com.pwalls.nosleep daemon up)"
else
  bad "no caffeinate -dimsu running — load the machine-wide nosleep daemon:"
  printf '       %ssudo launchctl bootstrap system /Library/LaunchDaemons/com.pwalls.nosleep.plist%s\n' "$c_b" "$c_0"
fi

# ── 2. YouTube archiver cron ─────────────────────────────────────────────────
hdr "2. YouTube archiver ($LABEL, hourly)"

# (Re)load the LaunchAgent. Periodic job (StartInterval 3600, RunAtLoad off), so
# "loaded but not running" between ticks is the normal state.
plist="$LA/$LABEL.plist"
if [ ! -f "$plist" ]; then
  bad "plist MISSING at $plist — run home-machine/yt-archive/install.sh"
elif launchctl print "$GUI/$LABEL" >/dev/null 2>&1 && [ "$FORCE" -eq 0 ]; then
  ok "$LABEL: already loaded"
else
  launchctl bootout "$GUI/$LABEL" 2>/dev/null
  if launchctl bootstrap "$GUI" "$plist" 2>/dev/null; then
    launchctl enable "$GUI/$LABEL" 2>/dev/null; ok "$LABEL: loaded"
  else bad "$LABEL: bootstrap failed (try: launchctl bootstrap $GUI '$plist')"; fi
fi

# Identity gate — the wrapper refuses to run unless this host matches the marker.
marker="$CFG/yt-archive.enabled"
if [ -f "$marker" ]; then
  want="$(head -n1 "$marker" | tr -d '[:space:]')"
  have="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
  [ "$want" = "$have" ] && ok "identity marker matches this host ($have)" \
    || bad "identity mismatch: marker=$want host=$have — re-run install.sh on this Mac"
else
  bad "identity marker MISSING ($marker) — run home-machine/yt-archive/install.sh"
fi

# Env file (secrets + tunables).
[ -f "$CFG/yt-archive.env" ] && ok "env/creds present (~/.config/hubandspoke/yt-archive.env)" \
  || bad "env MISSING ($CFG/yt-archive.env) — run home-machine/yt-archive/install.sh"

# Installed wrapper + the repo path it points at (catches a moved/renamed repo).
if [ -f "$WRAPPER" ]; then
  ok "wrapper.sh installed"
  repo="$(sed -n 's/^export REPO_DIR="\(.*\)"/\1/p' "$WRAPPER" | head -1)"
  repo="${repo:-$HOME/code/hubandspoke}"
  [ -d "$repo/.git" ] && ok "wrapper REPO_DIR is a git checkout ($repo)" \
    || bad "wrapper REPO_DIR=$repo is not a git checkout — fix the export line in $WRAPPER"
else
  bad "wrapper.sh MISSING ($WRAPPER) — run home-machine/yt-archive/install.sh"
  repo="$HOME/code/hubandspoke"
fi

# Tools the wrapper + archiver invoke (all must be on the launchd homebrew PATH).
need "node"        node
need "npx (tsx)"   npx
need "heroku CLI"  heroku
need "git"         git
need "ffmpeg"      ffmpeg
need "yt-dlp binary" "$repo/node_modules/.yt-dlp-bin/yt-dlp"
[ -d "/Applications/Google Chrome.app" ] && ok "Google Chrome present (yt-dlp cookies)" \
  || warn "Google Chrome not found — bot-gated videos will fail (best-effort, OK)"

# Heroku auth — the wrapper fetches DATABASE_URL fresh each run; a dead token
# kills the run. Informational.
if heroku config:get DATABASE_URL --app hubandspoke >/dev/null 2>&1; then
  ok "heroku auth OK (can read prod DATABASE_URL)"
else
  warn "heroku can't read DATABASE_URL --app hubandspoke — run: heroku login"
fi

last="$(grep -E 'archive exit=' "$LOG" 2>/dev/null | tail -1)"
[ -n "$last" ] && printf '       last run: %s\n' "$last"

# ── Summary ──────────────────────────────────────────────────────────────────
hdr "Summary"
if [ "$ISSUES" -eq 0 ]; then
  printf '  %s✓ Hub & Spoke home-machine pieces are up and healthy.%s\n' "$c_ok" "$c_0"
else
  printf '  %s✗ %d issue(s) above need attention.%s\n' "$c_bad" "$ISSUES" "$c_0"
fi
exit 0
