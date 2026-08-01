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
#   8  — host memory exhausted; skipped the run on purpose (see preflight below)
#   anything else — wrapper bailed before invoking the script
#
# Any exit other than 0/2 also fires a best-effort Sentry event (see the
# EXIT trap below) so a silently-broken hourly cron shows up as a grouped
# Sentry issue instead of only in ~/Library/Logs. The server-side
# `yt-archive-watch` task is the authoritative catcher (it watches the DB
# outcome and fires even if this machine is off); this trap just makes the
# failure mode visible faster and with the local context attached.

set -uo pipefail

# --- Sentry failure reporting --------------------------------------------

# Same public DSN as src/jobs/instrument.ts (DSNs are public identifiers).
SENTRY_KEY="cc94e45339b831a683f41991a90e811f"
SENTRY_STORE_URL="https://o174111.ingest.us.sentry.io/api/4511350981328896/store/"
LOG_FILE="$HOME/Library/Logs/hubandspoke-yt-archive.log"

report_failure_to_sentry() {
    local exit_code="$1"
    command -v python3 >/dev/null 2>&1 || return 0
    command -v curl >/dev/null 2>&1 || return 0
    # Build the JSON in python (safe escaping of the log tail), post with curl.
    python3 - "$exit_code" "$LOG_FILE" <<'PYEOF' | curl -sS --max-time 10 \
        -H "Content-Type: application/json" \
        -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_client=yt-archive-wrapper/1.0, sentry_key=$SENTRY_KEY" \
        -d @- "$SENTRY_STORE_URL" >/dev/null 2>&1 || true
import json, socket, sys, uuid
exit_code, log_file = sys.argv[1], sys.argv[2]
try:
    with open(log_file, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 4000))
        log_tail = f.read().decode("utf-8", "replace")
except OSError:
    log_tail = "(log file unreadable)"
print(json.dumps({
    "event_id": uuid.uuid4().hex,
    "message": f"yt-archive home cron failed (exit={exit_code})",
    "level": "error",
    "platform": "other",
    "logger": "yt-archive-wrapper",
    "server_name": socket.gethostname(),
    "tags": {"source": "yt-archive-home-cron", "exit_code": exit_code},
    "fingerprint": ["yt-archive-home-cron"],
    "extra": {"log_tail": log_tail},
}))
PYEOF
}

on_exit() {
    local code=$?
    if [[ "$code" -ne 0 && "$code" -ne 2 ]]; then
        report_failure_to_sentry "$code"
    fi
}
trap on_exit EXIT

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

# --- host health preflight -----------------------------------------------

# 2026-07-30 incident: an ollama model (qwen3:30b-a3b, ~19 GB) sat resident
# for 3.5 days on this 32 GB host and drove swap to 97% full. Everything then
# stalled in uninterruptible I/O — including our yt-dlp children, which burned
# the script's full 300s timeout on all three player-client strategies and
# reported "timeout after 300s" for every video. The archiver looked broken;
# the host was simply thrashing. `LowPriorityIO` in the plist made us the
# first process to starve.
#
# 2026-08-01 follow-up: "skip when starved" was not enough. Slope's judge keeps
# qwen3:30b-a3b (~18.8 GB) resident 24/7 on this 32 GB box, so the preflight
# skipped 24 hourly ticks in a row and nothing was archived for a full day.
# Measured over 5 min: the model never actually unloads — it enters "Stopping..."
# and Slope re-requests it before the memory is released, so free memory never
# leaves 8-9%. There is no idle window to wait for, and a bare `ollama stop` is
# undone within seconds.
#
# So: take the memory, use it, give it back. We evict the loaded model, run, and
# let Slope's next judge call reload it automatically. That costs one model load
# (~20s — well inside pulse's 120s AbortSignal timeout in src/index.ts) plus a
# few contended minutes once an hour, instead of never archiving at all.
#
# Set YT_ARCHIVE_EVICT_OLLAMA=0 in the env file to disable and go back to
# skipping (exit 8).
read_mem() {
    SWAP_FREE_MB=$(sysctl -n vm.swapusage 2>/dev/null | sed -nE 's/.*free = ([0-9]+)\.[0-9]+M.*/\1/p')
    MEM_FREE_PCT=$(memory_pressure 2>/dev/null | sed -nE 's/.*free percentage: ([0-9]+)%.*/\1/p')
    : "${SWAP_FREE_MB:=99999}"
    : "${MEM_FREE_PCT:=100}"
}
mem_is_starved() { [[ "$SWAP_FREE_MB" -lt 2048 && "$MEM_FREE_PCT" -lt 15 ]]; }
top_consumer() {
    ps -axo rss,comm | sort -rn | head -1 |
        awk '{rss=$1; $1=""; sub(/^ +/,""); printf "%.1fGB %s", rss/1048576, $0}'
}

read_mem
if mem_is_starved; then
    log "host memory low (swap_free=${SWAP_FREE_MB}MB free_mem=${MEM_FREE_PCT}%) — top: $(top_consumer)"

    # Only evict an actual ollama model, and only if ollama is the thing eating
    # the box. Never kill processes we don't understand.
    if [[ "${YT_ARCHIVE_EVICT_OLLAMA:-1}" == "1" ]] \
        && command -v ollama >/dev/null 2>&1 \
        && [[ "$(top_consumer)" == *"llama-server"* ]]; then
        LOADED_MODEL=$(ollama ps 2>/dev/null | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | awk 'NR==2 {print $1}')
        if [[ -n "${LOADED_MODEL:-}" ]]; then
            log "evicting ollama model '$LOADED_MODEL' for this run (it reloads on the next judge call)"
            timeout 60 ollama stop "$LOADED_MODEL" >/dev/null 2>&1 || true
            # Reclamation isn't instant, and `ollama stop` returns before the
            # memory is actually released. Poll rather than guess.
            for _ in $(seq 1 20); do
                sleep 3
                read_mem
                mem_is_starved || break
            done
            log "after eviction: swap_free=${SWAP_FREE_MB}MB free_mem=${MEM_FREE_PCT}%"
        fi
    fi

    read_mem
    if mem_is_starved; then
        log "host memory still exhausted (swap_free=${SWAP_FREE_MB}MB free_mem=${MEM_FREE_PCT}%) — skipping run"
        log "top memory consumer: $(top_consumer)"
        exit 8
    fi
fi

# --- DATABASE_URL --------------------------------------------------------

if ! command -v heroku >/dev/null 2>&1; then
    log "heroku CLI not on PATH — re-run install.sh"
    exit 5
fi

# `timeout` is mandatory here, not defensive polish. On 2026-07-30 this exact
# call wedged in uninterruptible I/O for 60+ minutes. Because launchd will not
# start a second instance of a StartInterval job while the first is alive, that
# single hang silently blocked *every* subsequent hourly tick — the failure
# mode that turned a slow host into a dead pipeline.
if ! PROD_DB_URL="$(timeout 120 heroku config:get DATABASE_URL --app hubandspoke 2>/tmp/yt-archive-heroku.err)"; then
    HEROKU_RC=$?
    if [[ $HEROKU_RC -eq 124 ]]; then
        log "heroku config:get timed out after 120s — host starved or heroku CLI wedged"
    else
        log "heroku config:get failed (rc=$HEROKU_RC) — possibly expired token. run: heroku login"
    fi
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
# Auth via a pre-exported cookies.txt at $CONFIG_DIR/cookies.txt — this defeats
# YouTube's "Sign in to confirm you're not a bot" gate, which now blocks ALL
# cookieless downloads from this IP. launchd is headless (no GUI/keychain, and
# Chrome locks its live cookie DB), so `--cookies-from-browser` hangs here; a
# static file avoids both, and yt-dlp rewrites it after each run to stay fresh.
# Falls back to cookieless if the file is missing (re-export with:
#   yt-dlp --cookies-from-browser chrome --cookies "$CONFIG_DIR/cookies.txt" \
#          --skip-download --simulate https://www.youtube.com/watch?v=<id> ).
if [ -f "$CONFIG_DIR/cookies.txt" ]; then
  COOKIE_ARG="--cookies=$CONFIG_DIR/cookies.txt"
else
  COOKIE_ARG="--cookies-from-browser=none"
fi
# Hard ceiling below the hourly cadence. The script has its own per-download
# timeout, but that only covers yt-dlp children — a starved host can stall the
# node process itself, and an overrunning instance blocks every later tick
# (launchd won't overlap a StartInterval job). 50 min leaves the next tick clean.
timeout 3000 npx --no-install tsx scripts/archive-yt-local.ts \
    --brands="$BRANDS" \
    --since-days="$RUN_SINCE_DAYS" \
    --limit="$RUN_LIMIT" \
    --sleep-min="$RUN_SLEEP_MIN" \
    --sleep-max="$RUN_SLEEP_MAX" \
    "$COOKIE_ARG"
SCRIPT_EXIT=$?
set -e

if [[ $SCRIPT_EXIT -eq 124 ]]; then
    log "archive exceeded the 50min ceiling and was killed — next tick starts clean"
else
    log "archive exit=$SCRIPT_EXIT"
fi

# --- log rotation (cheap) ------------------------------------------------

if [[ -f "$LOG_FILE" ]]; then
    LOG_SIZE_BYTES=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if (( LOG_SIZE_BYTES > 10 * 1024 * 1024 )); then
        mv -f "$LOG_FILE" "$LOG_FILE.1"
        log "rotated log (was ${LOG_SIZE_BYTES} bytes)"
    fi
fi

exit "$SCRIPT_EXIT"
