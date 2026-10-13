#!/bin/bash
# The pinned wrapper the ship broker runs for the ops lap: `ship run hubandspoke escalate -- <args>`.
# The lap's sandbox has no GitHub credential (security S-042); ops-escalate.ts (pinned with this
# file) is the only path from a lap to GitHub issues, and it runs outside the sandbox here.
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)/.."
exec env -u NODE_OPTIONS node_modules/.bin/tsx scripts/ops-escalate.ts "$@"
