#!/usr/bin/env bash
# install.sh — bootstrap the home-machine yt-archive cron.
#
# Run this on the Mac you want to host the archiver. Re-run safely after
# changes — every step is idempotent.
#
# Usage:
#   cd ~/code/hubandspoke/home-machine/yt-archive
#   ./install.sh
#
# What it does:
#   1. Preflights: macOS, on-PATH tools, repo location, heroku auth.
#   2. Writes ~/.config/hubandspoke/yt-archive.env (chmod 600), prompting
#      for any value that isn't already set. Re-run to update.
#   3. Pins the current hostname to ~/.config/hubandspoke/yt-archive.enabled.
#   4. Copies wrapper.sh to ~/Library/Application Support/hubandspoke-yt-archive/.
#   5. Renders plist with absolute paths, writes to ~/Library/LaunchAgents/.
#   6. Unloads any prior version, then `launchctl bootstrap`s the new one.
#   7. Tails the log for a smoke run kick-started via `launchctl kickstart`.

set -euo pipefail

# --- paths ---------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_DIR="$HOME/.config/hubandspoke"
ENV_FILE="$CONFIG_DIR/yt-archive.env"
MARKER_FILE="$CONFIG_DIR/yt-archive.enabled"

APP_SUPPORT_DIR="$HOME/Library/Application Support/hubandspoke-yt-archive"
WRAPPER_DST="$APP_SUPPORT_DIR/wrapper.sh"

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

for cmd in node npx git heroku scutil; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found on PATH"
done

ok "node $(node -v), git $(git --version | awk '{print $3}'), heroku $(heroku --version | awk '{print $1}')"

[[ -d "/Applications/Google Chrome.app" ]] || warn "Google Chrome not found in /Applications. yt-dlp --cookies-from-browser=chrome will fail."

[[ -d "$REPO_DIR/.git" ]] || die "expected a git repo at $REPO_DIR (parent of install.sh) — clone hubandspoke there"

if [[ "$REPO_DIR" != "$HOME/code/hubandspoke" ]]; then
    warn "repo is at $REPO_DIR, not ~/code/hubandspoke."
    warn "the wrapper defaults REPO_DIR=~/code/hubandspoke — it will use the path you have."
    warn "if you move the checkout later, re-run install.sh."
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

# Verify the production yt-dlp binary is installed locally — same one the
# worker dyno uses, lives under node_modules/.yt-dlp-bin.
if [[ ! -x "$REPO_DIR/node_modules/.yt-dlp-bin/yt-dlp" ]]; then
    say "yt-dlp binary not found; running install-yt-dlp"
    ( cd "$REPO_DIR" && node scripts/install-yt-dlp.mjs ) \
        || die "failed to install yt-dlp — run: cd $REPO_DIR && node scripts/install-yt-dlp.mjs"
fi
ok "yt-dlp binary present at node_modules/.yt-dlp-bin/yt-dlp"

# --- step 2: env file ----------------------------------------------------

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
    for key in HUBANDSPOKE_S3_PREFIX RUN_LIMIT RUN_SINCE_DAYS RUN_SLEEP_MIN RUN_SLEEP_MAX; do
        existing="$(awk -F= -v k="$key" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE" 2>/dev/null || true)"
        if [[ -n "$existing" ]]; then
            echo "$key=$existing"
        fi
    done
} > "$TMP_ENV"
mv -f "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "wrote $ENV_FILE (chmod 600)"

# --- step 3: identity marker --------------------------------------------

CURRENT_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
echo "$CURRENT_HOST" > "$MARKER_FILE"
chmod 600 "$MARKER_FILE"
ok "pinned identity to $CURRENT_HOST ($MARKER_FILE)"

# --- step 4: wrapper script ---------------------------------------------

say "install wrapper script"
mkdir -p "$APP_SUPPORT_DIR"
install -m 755 "$SCRIPT_DIR/wrapper.sh" "$WRAPPER_DST"

# Bake REPO_DIR override into the wrapper if the user cloned somewhere
# other than ~/code/hubandspoke — saves them having to also customize the
# env file.
if [[ "$REPO_DIR" != "$HOME/code/hubandspoke" ]]; then
    # Insert "REPO_DIR=..." just below the shebang.
    TMP_WRAPPER="$(mktemp)"
    {
        head -n1 "$WRAPPER_DST"
        echo "export REPO_DIR=\"$REPO_DIR\""
        tail -n +2 "$WRAPPER_DST"
    } > "$TMP_WRAPPER"
    install -m 755 "$TMP_WRAPPER" "$WRAPPER_DST"
    rm -f "$TMP_WRAPPER"
    ok "wrapper installed with REPO_DIR=$REPO_DIR baked in"
else
    ok "wrapper installed at $WRAPPER_DST"
fi

# --- step 5: launchd plist -----------------------------------------------

say "install launchd plist"
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

TMP_PLIST="$(mktemp)"
sed -e "s|__HOME__|$HOME|g" -e "s|__USER__|$USER|g" \
    "$SCRIPT_DIR/com.hubandspoke.yt-archive.plist.template" > "$TMP_PLIST"
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
