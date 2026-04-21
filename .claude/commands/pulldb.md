---
description: Pull the production Heroku Postgres into the local hubandspoke_development DB
---

# /pulldb — refresh local DB from production

Pull the latest production data into the local dev database so local work matches prod.

## Preflight

Check and report to the user before doing anything destructive:

1. Any dev server currently attached to `hubandspoke_development`? Run these in parallel:
   ```bash
   lsof -i :3000 -i :3001 -i :3002 -sTCP:LISTEN
   ps aux | grep -E "(next dev|npm.*dev)" | grep -v grep
   psql -U "$USER" -d postgres -c "SELECT pid, application_name, state FROM pg_stat_activity WHERE datname = 'hubandspoke_development';"
   ```
2. Confirm Heroku CLI is authenticated and the `hubandspoke` app is reachable: `heroku apps:info --app hubandspoke`.
3. Confirm PG 17 client tools are installed locally at `/opt/homebrew/opt/postgresql@17/bin` — the default `/opt/homebrew/bin/pg_dump` on this machine is PG 14 and will fail against prod's PG 17.
   ```bash
   ls /opt/homebrew/opt/postgresql@17/bin/pg_dump
   ```
   If missing, run `brew install postgresql@17` first and tell the user.

## Run

Kill any dev server connected to the local DB first (user has pre-authorized this in `/pulldb`):
```bash
# Kill next dev / npm dev processes if present
pkill -f "next dev" || true
pkill -f "npm run dev" || true
```

Drop the existing local DB (Heroku's `pg:pull` requires the target not to exist):
```bash
dropdb hubandspoke_development 2>&1 || true
```

Pull production with PG 17 tools on PATH:
```bash
PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH" heroku pg:pull DATABASE_URL hubandspoke_development --app hubandspoke
```

**Expected benign errors.** The restore will report ~5 errors about `schema "_heroku" does not exist` when it tries to recreate Heroku-internal event triggers (`extension_before_drop`, `log_create_ext`, `log_drop_ext`, `validate_extension`). These are Heroku-only infrastructure, not needed locally — ignore them. The data and app schema restore fine. Do NOT treat these as a failure.

## Verify

```bash
psql -d hubandspoke_development -c "SELECT 'production_items' AS t, COUNT(*) FROM production_items UNION ALL SELECT 'content_events', COUNT(*) FROM content_events UNION ALL SELECT 'users', COUNT(*) FROM users;"
```

Report the row counts back to the user so they can sanity-check the pull landed.

## Restart the dev server

Start the dev server in the background so the user can keep chatting:
```bash
# Run with run_in_background: true
PORT=3000 npm run dev
```

## User preferences captured here

- **Don't ask about preserving local data** — this user has said they never care about preserving the local `hubandspoke_development` DB. Always drop and recreate.
- **Don't ask whether to kill the dev server** — just kill it and restart after the pull.
- **Always prefix with `/opt/homebrew/opt/postgresql@17/bin`** — the default `pg_dump` on this machine is PG 14 and will fail the pull.
- **Heroku app name is `hubandspoke`.** Local DB is `hubandspoke_development`. Both are stable — do not ask.
