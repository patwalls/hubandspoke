#!/usr/bin/env bash
# Install (or re-install after editing probe.sh) the 5-minute production
# health probe on this Mac. Idempotent. Copies probe.sh to a pinned location
# (launchd must not run out of a git checkout that may be mid-rebase),
# writes the plist, bootstraps the agent, and runs one probe so you see it
# work. Same shape as yt-archive/install.sh.
#
#   home-machine/health-probe/install.sh
#   home-machine/health-probe/install.sh --uninstall
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.hubandspoke.health-probe"
DEST_DIR="$HOME/Library/Application Support/hubandspoke-health-probe"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; rm -rf "$DEST_DIR"
  echo "removed $LABEL"; exit 0
fi

mkdir -p "$DEST_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 0755 "$HERE/probe.sh" "$DEST_DIR/probe.sh"
sed "s|__HOME__|$HOME|g" "$HERE/$LABEL.plist.template" > "$PLIST"
launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
launchctl bootstrap "$GUI" "$PLIST"
echo "installed $LABEL (every 300s) → $DEST_DIR/probe.sh"
echo "log: $HOME/Library/Logs/hubandspoke-health-probe.log"
echo "--- one probe now:"
bash "$DEST_DIR/probe.sh"
