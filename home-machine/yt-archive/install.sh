#!/usr/bin/env bash
# install.sh — bootstrap the home-machine yt-archive cron.
#
# Run this on the Mac you want to host the archiver. Re-run safely after
# changes — every step is idempotent.
#
# Usage:
#   cd ~/code/hubandspoke/home-machine/yt-archive
#   ./install.sh                     # pin HEAD of this checkout, prompt for env
#   ./install.sh --ref <commit>      # pin a specific commit
#   ./install.sh --no-prompt         # keep the existing env file as-is (re-pin only)
#
# THIS IS THE ONLY WAY NEW CODE REACHES THE HOURLY JOB. The wrapper never
# pulls; it runs the tree pinned here, inside sandbox.sb. Re-run this after a
# change to scripts/archive-yt-local.ts, wrapper.sh or sandbox.sb has merged —
# and read what it says it is pinning before you confirm.
#
# What it does:
#   1. Preflights: macOS, on-PATH tools, repo location, heroku auth.
#   2. Writes ~/.config/hubandspoke/yt-archive.env (chmod 600), prompting
#      for any value that isn't already set. Re-run to update.
#   3. Pins the current hostname to ~/.config/hubandspoke/yt-archive.enabled.
#   4. Builds the pinned tree (`git archive <commit>` of the two scripts + a
#      minimal node_modules at the commit's lockfile versions) and copies
#      wrapper.sh + sandbox.sb, all into
#      ~/Library/Application Support/hubandspoke-yt-archive/.
#   5. Renders plist with absolute paths, writes to ~/Library/LaunchAgents/.
#   6. Unloads any prior version, then `launchctl bootstrap`s the new one.
#   7. Tails the log for a smoke run kick-started via `launchctl kickstart`.

set -euo pipefail

PIN_REF="HEAD"
NO_PROMPT=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref) PIN_REF="${2:?--ref needs a commit}"; shift 2 ;;
        --no-prompt) NO_PROMPT=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

# --- paths ---------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_DIR="$HOME/.config/hubandspoke"
ENV_FILE="$CONFIG_DIR/yt-archive.env"
MARKER_FILE="$CONFIG_DIR/yt-archive.enabled"

APP_SUPPORT_DIR="$HOME/Library/Application Support/hubandspoke-yt-archive"
WRAPPER_DST="$APP_SUPPORT_DIR/wrapper.sh"
TREE_DST="$APP_SUPPORT_DIR/tree"

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_LABEL="com.hubandspoke.yt-archive"
PLIST_DST="$LAUNCH_AGENTS_DIR/$PLIST_LABEL.plist"

LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/hubandspoke-yt-archive.log"

# --- helpers -------------------------------------------------------------

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Prompt for a value; honor an existing one in the env file by re-using it
# as default. Pass `--secret` to disable echo.
prompt_value() {
    local var="$1"
    local desc="$2"
    local secret=0
    shift 2
    [[ "${1:-}" == "--secret" ]] && secret=1

    local current=""
    if [[ -f "$ENV_FILE" ]]; then
        current="$(awk -F= -v k="$var" '$1==k { sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit }' "$ENV_FILE")"
    fi

    local default_display="$current"
    if (( secret )) && [[ -n "$current" ]]; then
        default_display="(unchanged)"
    fi

    local answer
    if (( secret )); then
        if [[ -n "$default_display" ]]; then
            read -r -s -p "  $desc [$default_display]: " answer; echo
        else
            read -r -s -p "  $desc: " answer; echo
        fi
    else
        if [[ -n "$default_display" ]]; then
            read -r -p "  $desc [$default_display]: " answer
        else
            read -r -p "  $desc: " answer
        fi
    fi

    if [[ -z "$answer" && -n "$current" ]]; then
        answer="$current"
    fi

    printf '%s' "$answer"
}

# --- step 1: preflights --------------------------------------------------

say "preflight checks"

[[ "$(uname -s)" == "Darwin" ]] || die "this installer is macOS-only (launchd)"

for cmd in node npm git heroku scutil sandbox-exec; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found on PATH"
done

ok "node $(node -v), git $(git --version | awk '{print $3}'), heroku $(heroku --version | awk '{print $1}')"

[[ -d "/Applications/Google Chrome.app" ]] || warn "Google Chrome not found in /Applications. yt-dlp --cookies-from-browser=chrome will fail."

[[ -d "$REPO_DIR/.git" ]] || die "expected a git repo at $REPO_DIR (parent of install.sh) — clone hubandspoke there"

if [[ "$REPO_DIR" != "$HOME/code/hubandspoke" ]]; then
    warn "repo is at $REPO_DIR, not ~/code/hubandspoke."
    warn "fine — the pinned tree is built from whatever checkout install.sh lives in."
fi

[[ -f "$REPO_DIR/scripts/archive-yt-local.ts" ]] || die "scripts/archive-yt-local.ts missing from $REPO_DIR — wrong branch?"

if ! heroku auth:whoami >/dev/null 2>&1; then
    die "heroku CLI is not authenticated. run: heroku login"
fi
ok "heroku auth ok ($(heroku auth:whoami))"

if ! heroku apps:info --app hubandspoke >/dev/null 2>&1; then
    die "heroku account does not have access to the 'hubandspoke' app"
fi
ok "heroku app 'hubandspoke' reachable"

# --- step 2: env file ----------------------------------------------------

if (( NO_PROMPT )); then
    [[ -f "$ENV_FILE" ]] || die "--no-prompt needs an existing $ENV_FILE — run without it once"
    ok "--no-prompt: keeping existing $ENV_FILE untouched"
else
say "configure secrets (~/.config/hubandspoke/yt-archive.env)"

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [[ -f "$ENV_FILE" ]]; then
    ok "existing env file found — press Enter to keep each value, type a new one to override"
else
    cp "$SCRIPT_DIR/yt-archive.env.template" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
fi

BRANDS_VAL="$(prompt_value BRANDS 'BRANDS ("auto" = every brand with an active YouTube account, or comma-separated slugs e.g. starter-story,matg)')"
[[ -n "$BRANDS_VAL" ]] || die "BRANDS is required"

S3_BUCKET_VAL="$(prompt_value HUBANDSPOKE_S3_BUCKET 'HUBANDSPOKE_S3_BUCKET')"
[[ -n "$S3_BUCKET_VAL" ]] || die "HUBANDSPOKE_S3_BUCKET is required"

AWS_KEY_VAL="$(prompt_value AWS_ACCESS_KEY_ID 'AWS_ACCESS_KEY_ID')"
[[ -n "$AWS_KEY_VAL" ]] || die "AWS_ACCESS_KEY_ID is required"

AWS_SECRET_VAL="$(prompt_value AWS_SECRET_ACCESS_KEY 'AWS_SECRET_ACCESS_KEY' --secret)"
[[ -n "$AWS_SECRET_VAL" ]] || die "AWS_SECRET_ACCESS_KEY is required"

AWS_REGION_VAL="$(prompt_value AWS_REGION 'AWS_REGION')"
[[ -n "$AWS_REGION_VAL" ]] || AWS_REGION_VAL="us-east-1"

# Write atomically — render to a temp file then mv.
TMP_ENV="$(mktemp)"
{
    echo "# Written by home-machine/yt-archive/install.sh on $(date)"
    echo "BRANDS=\"$BRANDS_VAL\""
    echo "HUBANDSPOKE_S3_BUCKET=\"$S3_BUCKET_VAL\""
    echo "AWS_ACCESS_KEY_ID=\"$AWS_KEY_VAL\""
    echo "AWS_SECRET_ACCESS_KEY=\"$AWS_SECRET_VAL\""
    echo "AWS_REGION=\"$AWS_REGION_VAL\""
    # Preserve any optional tunables the user may have set previously.
    # HEROKU_API_KEY matters most: dropping it brings back the chronic
    # exit-6 "wants an interactive login" failure under launchd.
    for key in HUBANDSPOKE_S3_PREFIX RUN_LIMIT RUN_SINCE_DAYS RUN_SLEEP_MIN RUN_SLEEP_MAX \
               HEROKU_API_KEY YT_ARCHIVE_EVICT_OLLAMA WHISPER_TRANSCRIBE_LIVE; do
        existing="$(awk -F= -v k="$key" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE" 2>/dev/null || true)"
        if [[ -n "$existing" ]]; then
            echo "$key=$existing"
        fi
    done
} > "$TMP_ENV"
mv -f "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "wrote $ENV_FILE (chmod 600)"
fi

# --- step 3: identity marker --------------------------------------------

CURRENT_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
echo "$CURRENT_HOST" > "$MARKER_FILE"
chmod 600 "$MARKER_FILE"
ok "pinned identity to $CURRENT_HOST ($MARKER_FILE)"

# --- step 4: pinned tree + wrapper + sandbox profile --------------------

say "build pinned tree"

PIN_SHA="$(git -C "$REPO_DIR" rev-parse --verify "${PIN_REF}^{commit}")" \
    || die "can't resolve --ref $PIN_REF"
PIN_SUBJECT="$(git -C "$REPO_DIR" log -1 --format='%h %an: %s' "$PIN_SHA")"
echo "  pinning: $PIN_SUBJECT"
echo "  author/committer: $(git -C "$REPO_DIR" log -1 --format='%an <%ae> / %cn <%ce>' "$PIN_SHA")"

git -C "$REPO_DIR" fetch --quiet origin main 2>/dev/null || warn "couldn't fetch origin/main"
if ! git -C "$REPO_DIR" merge-base --is-ancestor "$PIN_SHA" origin/main 2>/dev/null; then
    warn "$PIN_SHA is NOT on origin/main (unmerged branch or local commit)."
    if (( NO_PROMPT )); then
        die "refusing to pin an off-main commit with --no-prompt"
    fi
    read -r -p "  pin it anyway? [y/N] " yn
    [[ "$yn" == "y" || "$yn" == "Y" ]] || die "aborted"
fi
if [[ "$PIN_SHA" != "$(git -C "$REPO_DIR" rev-parse origin/main 2>/dev/null)" ]]; then
    # Show what is on main but would NOT be pinned, so a stale pin is a choice.
    BEHIND="$(git -C "$REPO_DIR" rev-list --count "$PIN_SHA..origin/main" -- \
        scripts/archive-yt-local.ts home-machine/yt-archive 2>/dev/null || echo '?')"
    [[ "$BEHIND" == "0" ]] || warn "origin/main has $BEHIND newer commit(s) touching the archiver that this pin leaves out"
fi

if [[ -n "$(git -C "$REPO_DIR" status --porcelain -- home-machine/yt-archive scripts/archive-yt-local.ts)" ]]; then
    warn "uncommitted changes in home-machine/yt-archive or the archive script are NOT installed — only $PIN_SHA is"
fi

mkdir -p "$APP_SUPPORT_DIR"
TREE_NEW="$(mktemp -d "$APP_SUPPORT_DIR/tree.new.XXXXXX")"
trap 'rm -rf "$TREE_NEW"' EXIT

# Only the files the job runs — no app code, no .env, no repo history. The
# wrapper, sandbox profile and plist come from the pinned commit too, never
# from this working tree, so uncommitted edits can't ride along.
git -C "$REPO_DIR" archive "$PIN_SHA" \
    scripts/archive-yt-local.ts scripts/install-yt-dlp.mjs \
    home-machine/yt-archive/wrapper.sh home-machine/yt-archive/sandbox.sb \
    home-machine/yt-archive/com.hubandspoke.yt-archive.plist.template \
    | tar -x -C "$TREE_NEW" \
    || die "git archive failed — does $PIN_SHA predate the sandbox (sandbox.sb)?"

# Minimal package.json at the EXACT versions the pinned commit's lockfile
# resolved (archive-yt-local.ts imports nothing from src/). ~100 MB, ~3s,
# vs 1.1 GB for the whole app's node_modules.
git -C "$REPO_DIR" show "$PIN_SHA:package-lock.json" > "$TREE_NEW/.lock.json"
node - "$TREE_NEW/.lock.json" "$TREE_NEW/package.json" <<'NODE'
const [lockPath, outPath] = process.argv.slice(2);
const lock = require(lockPath);
const deps = {};
for (const p of ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@ffmpeg-installer/ffmpeg", "pg", "tsx"]) {
  const e = lock.packages?.[`node_modules/${p}`];
  if (!e?.version) throw new Error(`pinned lockfile has no ${p}`);
  deps[p] = e.version;
}
require("fs").writeFileSync(outPath, JSON.stringify(
  { name: "hubandspoke-yt-archive-tree", private: true, dependencies: deps }, null, 2) + "\n");
NODE
rm -f "$TREE_NEW/.lock.json"

# --ignore-scripts: no dependency lifecycle scripts run as Pat. The one we
# need (the yt-dlp binary) is fetched explicitly from the pinned script.
( cd "$TREE_NEW" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null \
    && node scripts/install-yt-dlp.mjs >/dev/null ) || die "building the pinned tree failed"
[[ -x "$TREE_NEW/node_modules/.bin/tsx" && -x "$TREE_NEW/node_modules/.yt-dlp-bin/yt-dlp" ]] \
    || die "pinned tree is missing tsx or yt-dlp"

echo "$PIN_SHA" > "$TREE_NEW/.pinned-sha"
echo "$PIN_SUBJECT" > "$TREE_NEW/.pinned-subject"

# Swap in atomically-ish; the job is only ever started by launchd, and
# launchd doesn't overlap runs, but a run in progress keeps its open files.
rm -rf "$TREE_DST.old"
[[ -d "$TREE_DST" ]] && mv "$TREE_DST" "$TREE_DST.old"
mv "$TREE_NEW" "$TREE_DST"
trap - EXIT
rm -rf "$TREE_DST.old"
ok "pinned tree at $TREE_DST ($PIN_SUBJECT)"

say "install wrapper + sandbox profile"
PINNED_SRC="$TREE_DST/home-machine/yt-archive"
install -m 755 "$PINNED_SRC/wrapper.sh" "$WRAPPER_DST"
install -m 644 "$PINNED_SRC/sandbox.sb" "$APP_SUPPORT_DIR/sandbox.sb"
mkdir -p "$APP_SUPPORT_DIR/sandbox-home"
chmod 700 "$APP_SUPPORT_DIR/sandbox-home"
ok "wrapper + sandbox.sb installed in $APP_SUPPORT_DIR"

# --- step 5: launchd plist -----------------------------------------------

say "install launchd plist"
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

TMP_PLIST="$(mktemp)"
sed -e "s|__HOME__|$HOME|g" -e "s|__USER__|$USER|g" \
    "$PINNED_SRC/com.hubandspoke.yt-archive.plist.template" > "$TMP_PLIST"
install -m 644 "$TMP_PLIST" "$PLIST_DST"
rm -f "$TMP_PLIST"
ok "plist installed at $PLIST_DST"

# --- step 6: launchctl bootstrap ----------------------------------------

say "load into launchd"

# `bootout` is the modern equivalent of `unload`. Tolerate "not loaded".
launchctl bootout "gui/$UID/$PLIST_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_DST"
ok "bootstrapped"

# --- step 7: smoke run --------------------------------------------------

say "kicking off smoke run (tailing log for 60s)"
launchctl kickstart -k "gui/$UID/$PLIST_LABEL" || warn "kickstart returned non-zero (job may still be running)"

touch "$LOG_FILE"
( tail -F "$LOG_FILE" & TAIL_PID=$!; sleep 60; kill "$TAIL_PID" 2>/dev/null || true ) || true

cat <<EOF

────────────────────────────────────────────────────────────────────────
install complete.

  status:   launchctl print gui/$UID/$PLIST_LABEL
  logs:     tail -F $LOG_FILE
  uninstall: $SCRIPT_DIR/uninstall.sh
  re-run:   re-execute this script (it's idempotent)

next scheduled run: $(date -v+1H "+%Y-%m-%d %H:%M" 2>/dev/null || date -d '+1 hour' "+%Y-%m-%d %H:%M" 2>/dev/null || echo 'in ~1 hour')
────────────────────────────────────────────────────────────────────────
EOF
