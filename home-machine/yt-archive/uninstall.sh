#!/usr/bin/env bash
# uninstall.sh — tear down the home-machine yt-archive cron.
#
# Removes the launchd job, wrapper, plist, and identity marker.
# By default it KEEPS the env file (secrets) — pass --purge to wipe that too.
#
# Usage:
#   ./uninstall.sh            # remove cron, keep secrets file
#   ./uninstall.sh --purge    # also delete the env file

set -euo pipefail

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

CONFIG_DIR="$HOME/.config/hubandspoke"
ENV_FILE="$CONFIG_DIR/yt-archive.env"
MARKER_FILE="$CONFIG_DIR/yt-archive.enabled"

APP_SUPPORT_DIR="$HOME/Library/Application Support/hubandspoke-yt-archive"
PLIST_LABEL="com.hubandspoke.yt-archive"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

say "stopping launchd job"
launchctl bootout "gui/$UID/$PLIST_LABEL" 2>/dev/null && ok "job booted out" || ok "job was not loaded"

[[ -f "$PLIST_DST" ]] && rm -f "$PLIST_DST" && ok "removed $PLIST_DST"
[[ -d "$APP_SUPPORT_DIR" ]] && rm -rf "$APP_SUPPORT_DIR" && ok "removed $APP_SUPPORT_DIR"
[[ -f "$MARKER_FILE" ]] && rm -f "$MARKER_FILE" && ok "removed identity marker"

if (( PURGE )); then
    [[ -f "$ENV_FILE" ]] && rm -f "$ENV_FILE" && ok "removed env file (--purge)"
fi

ok "uninstall complete"
if (( ! PURGE )); then
    echo
    echo "  env file kept at $ENV_FILE — pass --purge to remove."
fi
