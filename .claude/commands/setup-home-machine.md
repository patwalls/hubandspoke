---
description: Bring up + verify the local always-on pieces (caffeinate + hourly YouTube archiver) after a restart or OS update
---

# Setup home machine (Hub & Spoke)

This **home** Mac runs the hourly YouTube archiver (`com.hubandspoke.yt-archive`)
— a residential-IP cron that pulls new brand videos and uploads them to prod S3
+ DB, getting past the datacenter-IP bot-check the Heroku dynos can't. For that
to keep firing the machine must never sleep, and the launchd job + its deps must
be in place. Run this after any restart or OS update to confirm everything's up,
then triage anything that isn't.

This covers the **Hub & Spoke** home-machine pieces:

1. **Never sleep** — the machine-wide `com.pwalls.nosleep` daemon (`caffeinate
   -dimsu`) + persistent `pmset sleep 0`. (Shared across repos; if it's down the
   fix needs sudo.)
2. **YouTube archiver** — `com.hubandspoke.yt-archive` LaunchAgent runs
   `~/Library/Application Support/hubandspoke-yt-archive/wrapper.sh` hourly, which
   `git pull`s the repo, fetches a fresh `DATABASE_URL` from Heroku, and runs
   `scripts/archive-yt-local.ts`. Gated by an identity marker (only the
   designated Mac runs it) + an env file with AWS creds.

## Do this

1. Run the idempotent bring-up script and read its report:

   ```
   home-machine/up.sh
   ```

   It verifies each piece and **loads the archiver agent if it's down**
   (re-bootstraps into `gui/$UID`). Safe to run repeatedly. `--force` boots out
   and reloads the agent even if healthy (use only if it's wedged).

2. **If the summary is all green**, report that and stop — done. (To smoke-test a
   live run: `launchctl kickstart -k gui/$UID/com.hubandspoke.yt-archive` then
   `tail ~/Library/Logs/hubandspoke-yt-archive.log` — expect `identity ok` →
   `git pull ok` → `archive exit=0`.)

3. **If anything is ✗**, triage it. The script prints the exact fix for the
   common cases:
   - **No `caffeinate -dimsu`** → the machine-wide nosleep daemon isn't loaded.
     Needs sudo, so it can't run unattended — tell Pat to paste (the `!` prefix
     runs it in-session so the password prompt works):
     `! sudo launchctl bootstrap system /Library/LaunchDaemons/com.pwalls.nosleep.plist`
     If `pmset` idle sleep isn't 0: `! sudo pmset -a sleep 0 disksleep 0`.
   - **plist / wrapper / env / identity-marker MISSING**, or **identity mismatch**,
     or **wrapper REPO_DIR isn't a git checkout** → the one-time install is gone or
     stale (e.g. the repo was moved). Re-run the installer, which re-lays the
     wrapper + plist + marker and bakes the current repo path:
     `home-machine/yt-archive/install.sh` (see `home-machine/yt-archive/README.md`).
   - **A dependency is missing** (node/npx/heroku/git/ffmpeg/yt-dlp/Chrome) →
     restore just that one. yt-dlp: `node scripts/install-yt-dlp.mjs`. The cron's
     launchd PATH is the Homebrew one, so these must resolve under `/opt/homebrew/bin`
     (a node that only exists via nvm won't be seen by launchd).
   - **Heroku auth warning** → `heroku login` (the wrapper reads `DATABASE_URL`
     fresh every run; a dead token aborts the run).

4. Re-run `home-machine/up.sh` after any fix until the summary is green, then give
   Pat a one-line status.

This command only **verifies and loads** what `home-machine/yt-archive/install.sh`
already set up — it never installs from scratch and never changes the archiver's
behavior. For a brand-new machine, run `install.sh` first, then this.
