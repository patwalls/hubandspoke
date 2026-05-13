#!/usr/bin/env bash
# wrapper.sh — what launchd actually runs every hour.
#
# Lives at: ~/Library/Application Support/hubandspoke-yt-archive/wrapper.sh
#           (copied there by install.sh — NOT executed directly from the
#            repo checkout, so a `git pull` mid-run can't rewrite it.)
#
# Flow:
#   1. Identity gate — bail if marker missing or hostname mismatched.
#   2. Source env file with secrets + run-tunable knobs.
#   3. Best-effort `git pull --ff-only` so script tweaks land automatically.
#   4. Fetch DATABASE_URL via heroku CLI (always-current; tokens are long-lived).
#   5. Run archive-yt-local.ts with polite-mode flags and a small batch limit.
#
# Exit codes:
#   0  — ran cleanly, all candidates archived
#   2  — ran but one or more videos failed (normal — dead videos, etc.)
#   anything else — wrapper bailed before invoking the script

set -uo pipefail

# --- config (overridable via env file) -----------------------------------

REPO_DIR="${REPO_DIR:-$HOME/code/hubandspoke}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/hubandspoke}"
ENV_FILE="$CONFIG_DIR/yt-archive.env"
MARKER_FILE="$CONFIG_DIR/yt-archive.enabled"

ts() { date "+%Y-%m-%d %H:%M:%S%z"; }
log() { printf '[%s] %s\n' "$(ts)" "$*"; }

log "wrapper start (pid=$$)"

# --- identity gate -------------------------------------------------------

if [[ ! -f "$MARKER_FILE" ]]; then
    log "no marker file at $MARKER_FILE — this machine is not designated for yt-archive. exiting."
    exit 0
fi

EXPECTED_HOST="$(head -n1 "$MARKER_FILE" | tr -d '[:space:]')"
ACTUAL_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"

if [[ -z "$EXPECTED_HOST" ]]; then
    log "marker file is empty — refusing to run. re-run install.sh to repair."
    exit 0
fi

if [[ "$EXPECTED_HOST" != "$ACTUAL_HOST" ]]; then
    log "hostname mismatch: marker=$EXPECTED_HOST current=$ACTUAL_HOST — refusing to run."
    log "if you intentionally moved the cron to this machine, re-run install.sh."
    exit 0
fi

log "identity ok ($ACTUAL_HOST)"

# --- env -----------------------------------------------------------------

if [[ ! -f "$ENV_FILE" ]]; then
    log "missing env file at $ENV_FILE — re-run install.sh"
    exit 3
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

: "${BRANDS:?BRANDS missing from $ENV_FILE}"
: "${HUBANDSPOKE_S3_BUCKET:?HUBANDSPOKE_S3_BUCKET missing from $ENV_FILE}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID missing from $ENV_FILE}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY missing from $ENV_FILE}"

RUN_LIMIT="${RUN_LIMIT:-30}"
RUN_SINCE_DAYS="${RUN_SINCE_DAYS:-2}"
RUN_SLEEP_MIN="${RUN_SLEEP_MIN:-2}"
RUN_SLEEP_MAX="${RUN_SLEEP_MAX:-6}"

# --- repo --------------------------------------------------------------

if [[ ! -d "$REPO_DIR/.git" ]]; then
    log "REPO_DIR=$REPO_DIR is not a git checkout — exiting"
    exit 4
fi

cd "$REPO_DIR"

# --ff-only means a divergent branch or unrelated history aborts cleanly
# instead of creating a merge commit. We log and continue — stale code is
# fine for one run; we'll surface the failure for human inspection next time.
if git pull --ff-only --quiet 2>>/tmp/yt-archive-pull.err; then
    log "git pull ok — head=$(git rev-parse --short HEAD)"
else
    log "git pull failed (continuing with current HEAD=$(git rev-parse --short HEAD))"
    if [[ -s /tmp/yt-archive-pull.err ]]; then
        log "git pull stderr: $(tail -c 400 /tmp/yt-archive-pull.err)"
    fi
fi

# --- DATABASE_URL --------------------------------------------------------

if ! command -v heroku >/dev/null 2>&1; then
    log "heroku CLI not on PATH — re-run install.sh"
    exit 5
fi

if ! PROD_DB_URL="$(heroku config:get DATABASE_URL --app hubandspoke 2>/tmp/yt-archive-heroku.err)"; then
    log "heroku config:get failed — likely token expired. run: heroku login"
    log "stderr: $(tail -c 400 /tmp/yt-archive-heroku.err)"
    exit 6
fi

if [[ -z "$PROD_DB_URL" ]]; then
    log "heroku returned empty DATABASE_URL — refusing to run"
    exit 7
fi

export PROD_DB_URL
export HUBANDSPOKE_S3_BUCKET HUBANDSPOKE_S3_PREFIX
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION

# --- run -----------------------------------------------------------------

log "invoking archive: brands=$BRANDS limit=$RUN_LIMIT since-days=$RUN_SINCE_DAYS sleep=${RUN_SLEEP_MIN}-${RUN_SLEEP_MAX}s"

set +e
npx --no-install tsx scripts/archive-yt-local.ts \
    --brands="$BRANDS" \
    --since-days="$RUN_SINCE_DAYS" \
    --limit="$RUN_LIMIT" \
    --sleep-min="$RUN_SLEEP_MIN" \
    --sleep-max="$RUN_SLEEP_MAX"
SCRIPT_EXIT=$?
set -e

log "archive exit=$SCRIPT_EXIT"

# --- log rotation (cheap) ------------------------------------------------

LOG_FILE="$HOME/Library/Logs/hubandspoke-yt-archive.log"
if [[ -f "$LOG_FILE" ]]; then
    LOG_SIZE_BYTES=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if (( LOG_SIZE_BYTES > 10 * 1024 * 1024 )); then
        mv -f "$LOG_FILE" "$LOG_FILE.1"
        log "rotated log (was ${LOG_SIZE_BYTES} bytes)"
    fi
fi

exit "$SCRIPT_EXIT"
