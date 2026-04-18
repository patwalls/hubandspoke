#!/usr/bin/env bash
# Create (or re-enter) a git worktree ready for `npm run dev` on its own port.
#
# Usage:
#   scripts/worktree-up.sh <branch-name> [port]
#
# - Creates ../hubandspoke-<branch-name> branched off origin/main if it doesn't exist.
# - Symlinks .env.local from the main checkout (secrets stay in one place, never committed).
# - Runs `npm install` if node_modules is missing (Turbopack rejects symlinked node_modules,
#   so a real install per worktree is required).
# - Picks the first free port starting at 3001 unless one is provided.
# - Prints the command to start the dev server — does not start it itself, so you can
#   run it under whatever supervisor (foreground, tmux, Claude bg task) you prefer.

set -euo pipefail

MAIN_REPO="$(git rev-parse --show-toplevel)"
# If invoked from a worktree, resolve back to the primary worktree so we always
# symlink .env.local from the canonical source.
PRIMARY="$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')"
MAIN_REPO="$PRIMARY"

BRANCH="${1:-}"
REQUESTED_PORT="${2:-}"

if [[ -z "$BRANCH" ]]; then
  echo "Usage: $0 <branch-name> [port]" >&2
  exit 1
fi

WORKTREE="$(dirname "$MAIN_REPO")/$(basename "$MAIN_REPO")-$BRANCH"

if [[ ! -d "$WORKTREE" ]]; then
  echo "Creating worktree at $WORKTREE off origin/main..."
  git -C "$MAIN_REPO" fetch origin main --quiet
  git -C "$MAIN_REPO" worktree add -b "$BRANCH" "$WORKTREE" origin/main
else
  echo "Worktree already exists at $WORKTREE — reusing."
fi

if [[ -f "$MAIN_REPO/.env.local" && ! -e "$WORKTREE/.env.local" ]]; then
  ln -s "$MAIN_REPO/.env.local" "$WORKTREE/.env.local"
  echo "Linked .env.local -> $MAIN_REPO/.env.local"
fi

if [[ ! -d "$WORKTREE/node_modules" ]]; then
  echo "Installing deps (Turbopack can't use a symlinked node_modules)..."
  (cd "$WORKTREE" && npm install --no-audit --no-fund)
fi

if [[ -n "$REQUESTED_PORT" ]]; then
  PORT="$REQUESTED_PORT"
else
  PORT=3001
  while lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; do
    PORT=$((PORT + 1))
  done
fi

echo
echo "Worktree ready:"
echo "  path:   $WORKTREE"
echo "  branch: $BRANCH"
echo "  port:   $PORT"
echo
echo "Start dev server with:"
echo "  (cd $WORKTREE && PORT=$PORT npm run dev)"
