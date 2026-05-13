# home-machine/yt-archive — automated YouTube archiver

Runs `scripts/archive-yt-local.ts` every hour on a designated home Mac via
`launchd`. Built because YouTube bot-checks Heroku's datacenter IPs, so we
need a residential IP to do bulk video archival — your always-on home Mac
is exactly that.

> **This installer ONLY runs the cron on the machine where you executed
> `install.sh`.** It pins the current `LocalHostName` into an identity
> marker file and the wrapper bails on every other machine. So you can
> safely `git pull` this branch on your laptop or any other Mac — nothing
> happens until you opt in with `./install.sh`.

## What gets installed where

| path | purpose |
|---|---|
| `~/.config/hubandspoke/yt-archive.env` (chmod 600) | secrets: BRANDS, S3 bucket, AWS creds, optional tunables |
| `~/.config/hubandspoke/yt-archive.enabled` | identity marker — pins `LocalHostName` at install time |
| `~/Library/Application Support/hubandspoke-yt-archive/wrapper.sh` | the script `launchd` runs every hour |
| `~/Library/LaunchAgents/com.hubandspoke.yt-archive.plist` | the launchd job (hourly) |
| `~/Library/Logs/hubandspoke-yt-archive.log` | stdout + stderr, rotated at 10 MB |

The wrapper is **copied** out of the repo into `~/Library/Application Support/`
at install time. `git pull` can't accidentally rewrite the running job —
only re-running `install.sh` does.

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
- **BRANDS** — comma-separated brand slugs (e.g. `starter-story,matg`)
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
2. **`git pull --ff-only`.** Stays current with `main` but refuses anything
   that requires a merge — won't drift the home machine onto a weird state.
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
