# home-machine/yt-archive — automated YouTube archiver

Runs `scripts/archive-yt-local.ts` every hour on a designated home Mac via
`launchd`. Built because YouTube bot-checks Heroku's datacenter IPs, so we
need a residential IP to do bulk video archival — your always-on home Mac
is exactly that.

> **This installer ONLY runs the cron on the machine where you executed
> `install.sh`.** It pins the current `LocalHostName` into an identity
> marker file and the wrapper bails on every other machine. So you can
> safely `git pull` on your laptop or any other Mac — nothing
> happens until you opt in with `./install.sh`.

> **The job runs a PINNED copy of the code, inside a macOS sandbox
> (since 2026-10-12).** Nothing pushed to GitHub reaches it until someone
> re-runs `./install.sh` on this Mac. It used to `git pull` main and run
> straight from `~/code/hubandspoke` every hour, so anyone who could push
> to main (an unprotected, public repo) got their code run here, as Pat,
> next to every credential on the machine (security lap S-068). Do not add
> an auto-update step back.

## Pinned + sandboxed — how it works

- **Pinned tree.** `install.sh` resolves a commit (default `HEAD` of this
  checkout, or `--ref <commit>`), prints its author and subject, warns if it
  is not on `origin/main` (asks before pinning one that isn't) or if main has
  newer archiver commits it is leaving out, then `git archive`s **only**
  `scripts/archive-yt-local.ts`, `scripts/install-yt-dlp.mjs` and this directory's
  wrapper / profile / plist into `…/hubandspoke-yt-archive/tree/`. That tree gets a
  minimal `node_modules` (the 5 packages the script imports, at the exact
  versions in the pinned commit's lockfile, `npm install --ignore-scripts`) plus
  the yt-dlp binary: ~100 MB, ~3s. The wrapper/profile/plist are installed
  from that commit, never from the working tree, so uncommitted edits can't
  ride along.
- **Sandbox.** Every node/tsx child runs as
  `env -i <5 vars> sandbox-exec -f sandbox.sb …`. It sees `PROD_DB_URL`, the
  S3 bucket/prefix, and the AWS keys. It does **not** see `HEROKU_API_KEY`
  (the wrapper uses that itself to fetch the DB URL). It can't read anything
  under `$HOME` except the pinned tree and its own `sandbox-home/`, can only
  write to `sandbox-home/` and the temp dirs, and can't reach the keychain,
  Apple Events, `launchctl`, `osascript`, `open` or `security`. It also can't
  read the clipboard, connect to anything listening on this Mac (localhost /
  unix sockets, so no loops/Cockpit/dev-server/ollama APIs), or signal Pat's
  other processes.
  **Known gap:** it can still read the argv + environment of Pat's other
  processes (sysctl `KERN_PROCARGS2` isn't gated by the macOS sandbox). Only
  running the job as a separate macOS user closes that. YouTube cookies
  are copied into `sandbox-home/` for the run, and the refreshed jar is
  copied back afterwards.
- **Least-privilege creds.** The DB URL the job gets is the restricted
  Heroku credential `yt_archive`, not the owner's `DATABASE_URL`. It has
  column-level SELECT on the 4 tables it reads, UPDATE on only the 8 archive
  columns of `production_items`, no DELETE, no other tables, and no job
  queue beyond `yt_archive_enqueue_whisper(uuid)`. Grants live in
  `db-grants.sql`: **change a query in `archive-yt-local.ts` → update that
  file and re-apply it** (`heroku pg:psql --app hubandspoke -f home-machine/yt-archive/db-grants.sql`).
  Uploads send `If-None-Match: *` (create-only) so the S3 key can be a
  create-only IAM user.
- **What it does not stop:** within those grants, bad pinned code could
  still corrupt archive columns or upload junk. Pinning is what keeps
  unreviewed code from running at all.

### Shipping a change to the archiver

1. Merge the change to `main` (archive script, `wrapper.sh`, or `sandbox.sb`).
2. On this Mac: `git -C ~/code/hubandspoke pull && ~/code/hubandspoke/home-machine/yt-archive/install.sh --no-prompt`.
   (`--no-prompt` keeps the env file untouched and refuses off-main commits.)
3. Read the `pinning: <sha> <author>: <subject>` line it prints, then check
   the next log line says `pinned tree <sha>`.

## What gets installed where

| path | purpose |
|---|---|
| `~/.config/hubandspoke/yt-archive.env` (chmod 600) | secrets: BRANDS, S3 bucket, AWS creds, optional tunables |
| `~/.config/hubandspoke/yt-archive.enabled` | identity marker — pins `LocalHostName` at install time |
| `~/Library/Application Support/hubandspoke-yt-archive/wrapper.sh` | the script `launchd` runs every hour |
| `~/Library/Application Support/hubandspoke-yt-archive/tree/` | pinned code + minimal node_modules + yt-dlp; `.pinned-sha` says which commit |
| `~/Library/Application Support/hubandspoke-yt-archive/sandbox.sb` | the macOS sandbox profile every node/tsx child runs under |
| `~/Library/Application Support/hubandspoke-yt-archive/sandbox-home/` | the sandboxed job's `$HOME` (yt-dlp cache, per-run cookies copy) |
| `~/Library/LaunchAgents/com.hubandspoke.yt-archive.plist` | the launchd job (hourly) |
| `~/Library/Logs/hubandspoke-yt-archive.log` | stdout + stderr, rotated at 10 MB |

Everything is **copied** out of the pinned commit into `~/Library/Application Support/`
at install time. Pulling or switching branches in the checkout changes
nothing that runs. Only re-running `install.sh` does.

## Prerequisites on the home Mac

1. macOS (this uses `launchd`).
2. The repo cloned to `~/code/hubandspoke` (other paths work; install.sh handles it).
3. `node`, `git`, and the Heroku CLI on `PATH`. Recommended via Homebrew:
   ```
   brew install node git
   brew install --cask chrome heroku
   ```
4. `heroku login` (one-time browser auth).
5. Google Chrome installed, signed into the YouTube account whose cookies
   are used for `--cookies-from-browser=chrome`. Keep Chrome installed —
   you don't need to keep it open, yt-dlp reads cookies from disk.
6. Repo dependencies installed: `cd ~/code/hubandspoke && npm install`.
7. Production yt-dlp binary: `node scripts/install-yt-dlp.mjs` (the
   installer runs this for you if missing).

## Install

```bash
cd ~/code/hubandspoke/home-machine/yt-archive
./install.sh
```

It will prompt for:
- **BRANDS** — `auto` (recommended: every brand with an active YouTube account, resolved from the DB each run) or comma-separated brand slugs (e.g. `starter-story,matg`)
- **HUBANDSPOKE_S3_BUCKET** — same bucket the prod worker uses
- **AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION** — copy from
  your dev `.env.local`, or create a dedicated IAM user scoped to
  `s3:PutObject` on that bucket

Re-running is safe — every existing value becomes the default for re-prompts.

After install, the script does a smoke run via `launchctl kickstart` and
tails the log for 60 seconds so you can confirm the first archive cycle
completed before you walk away.

## Tunables (edit `~/.config/hubandspoke/yt-archive.env`)

```sh
RUN_LIMIT=30         # max videos per hourly run
RUN_SINCE_DAYS=2     # look back this many days for un-archived candidates
RUN_SLEEP_MIN=2      # yt-dlp polite-mode min sleep (seconds)
RUN_SLEEP_MAX=6      # yt-dlp polite-mode max sleep (seconds)
```

Changes take effect on the next hourly tick — no `launchctl` dance needed.

## Operate

```bash
# is it loaded? when did it last run?
launchctl print gui/$UID/com.hubandspoke.yt-archive

# tail the log
tail -F ~/Library/Logs/hubandspoke-yt-archive.log

# fire one off right now (doesn't disturb the hourly schedule)
launchctl kickstart -k gui/$UID/com.hubandspoke.yt-archive

# stop the cron temporarily without uninstalling
launchctl bootout gui/$UID/com.hubandspoke.yt-archive
# ...later, resume:
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.hubandspoke.yt-archive.plist

# remove entirely (keeps env file)
./uninstall.sh
# remove entirely AND wipe secrets
./uninstall.sh --purge
```

## How the wrapper makes each run safe

1. **Identity gate.** Bails immediately on machines that haven't run `install.sh`.
2. **Pinned tree, sandboxed.** Runs the commit `install.sh` pinned, under
   `sandbox.sb` with a scrubbed env (see above). Exit 4 = tree/profile missing.
3. **`heroku config:get DATABASE_URL`** every run — no stale URL pinned in
   a file, no rotation pain.
4. **Polite-mode yt-dlp** — `--sleep-interval` jitter between videos
   reduces "you're a bot" signal.
5. **Per-video failure tolerance.** A dead YouTube URL fails one item;
   the loop moves on. The script already caps `youtube_download_attempts`
   at 3 to stop retrying graveyard videos.
6. **Log rotation.** Anything bigger than 10 MB gets moved to `.log.1`
   so the file doesn't grow unbounded.

## When to look at this directory again

- YouTube starts bot-checking the home IP and per-video failures spike:
  bump `RUN_SLEEP_MIN/MAX`, drop `RUN_LIMIT`, or add a residential proxy
  retry tier (not implemented here yet).
- Heroku CLI token expires: `heroku login` on the home Mac. Wrapper logs
  the failure with a clear message.
- AWS creds rotated: edit `~/.config/hubandspoke/yt-archive.env`.
- You move the Mac (Migration Assistant to a new machine): the new
  `LocalHostName` won't match the marker, wrapper refuses to run. Re-run
  `./install.sh` on the new machine.
