---
description: Pull the production Heroku Postgres into the local hubandspoke_development DB
---

# /pulldb — refresh local DB from production

Pull the latest production data into the local dev database so local work matches prod.

**Prod runs Postgres 17.** That one fact drives everything below: the `pg_dump` you use
**must be version ≥ 17** (an older `pg_dump` aborts with `server version mismatch` or, worse,
produces a partial dump). Where a PG 17 dumper comes from varies by machine, so this command
**detects** it rather than assuming a fixed path — see the two run paths.

- **Heroku app:** `hubandspoke` (stable — don't ask)
- **Local DB:** `hubandspoke_development` (stable — don't ask)

## Preflight

Check and report before doing anything destructive:

1. **Dev server attached to the local DB?** Run in parallel and note what's holding the DB:
   ```bash
   lsof -i :3000 -i :3001 -i :3002 -sTCP:LISTEN
   ps aux | grep -E "(next dev|npm.*dev)" | grep -v grep
   psql -d hubandspoke_development -c "SELECT pid, application_name, state FROM pg_stat_activity WHERE datname = 'hubandspoke_development';" 2>/dev/null
   ```
2. **Heroku reachable + authed:** `heroku apps:info --app hubandspoke` (and `heroku auth:whoami`).
3. **Find a PG 17 `pg_dump`.** Probe these in order and use the first that exists; this resolves
   the right tooling on Apple-Silicon brew, Intel brew, Postgres.app, a stock PATH, or Docker:
   ```bash
   for p in \
     /opt/homebrew/opt/postgresql@17/bin \
     /usr/local/opt/postgresql@17/bin \
     /Applications/Postgres.app/Contents/Versions/17/bin \
     /Applications/Postgres.app/Contents/Versions/latest/bin; do
     [ -x "$p/pg_dump" ] && "$p/pg_dump" --version | grep -q ' 17\.' && { echo "PG17 client: $p"; break; }
   done
   command -v pg_dump >/dev/null && pg_dump --version | grep -q ' 17\.' && echo "PG17 client: (on PATH)"
   docker info >/dev/null 2>&1 && echo "Docker available (PG17 fallback OK)"
   ```
   - If a **native PG 17 `pg_dump`** is found → use **Run · Path A**.
   - If none is found but **Docker is available** → use **Run · Path B** (no install needed).
   - If neither: install PG 17 client tools (`brew install postgresql@17`, or add PG 17 in
     Postgres.app), or install Docker. On a machine where Homebrew's prefix isn't writable by
     your user, `brew install` will fail — use the Docker path instead.
4. **Know your local Postgres server version** — it matters for which path works:
   ```bash
   psql -d postgres -tAc "show server_version;"
   ```
   - **Local server is also PG 17** → Path A (`heroku pg:pull`) works directly.
   - **Local server is older than 17** (e.g. Postgres.app 15) → a PG 17 *dump* can't be restored
     into it via `pg:pull`'s custom-format restore. Use **Path B**, which dumps **plain SQL** —
     plain SQL restores into an older server fine (a couple of statements about PG 17-only GUCs
     just no-op; see benign errors).

## Run

These steps are pre-authorized — don't re-ask (see Standing decisions).

Kill any dev server holding the local DB:
```bash
pkill -f "next dev" 2>/dev/null || true
pkill -f "npm run dev" 2>/dev/null || true
```

### Path A — native PG 17 client + PG 17 local server

Heroku's `pg:pull` requires the target DB not to exist, so drop first, then pull with the PG 17
tools on PATH (substitute the directory you found in preflight #3):

```bash
PG17BIN=/opt/homebrew/opt/postgresql@17/bin   # <- whatever preflight #3 resolved
"$PG17BIN/dropdb" hubandspoke_development 2>/dev/null || true
PATH="$PG17BIN:$PATH" heroku pg:pull DATABASE_URL hubandspoke_development --app hubandspoke
```

**Expected benign errors:** ~5 messages about `schema "_heroku" does not exist` when the restore
tries to recreate Heroku-internal event triggers (`extension_before_drop`, `log_create_ext`,
`log_drop_ext`, `validate_extension`). Heroku-only infra, not needed locally — ignore. Data and
app schema restore fine.

### Path B — Docker PG 17 dump → restore into any local server (no install)

Use when there's no native PG 17 client, or the local Postgres server is older than 17. A
throwaway `postgres:17` container is the dump client; the dump is **plain SQL** so any local
`psql` can ingest it regardless of local server version. Pick a `LOCALPSQL`/`LOCALCREATEDB`
that points at your local server (stock `psql`, or e.g.
`/Applications/Postgres.app/Contents/Versions/15/bin/psql`).

```bash
# 1. Prod connection string (kept in a var; do not echo it)
HURL=$(heroku config:get DATABASE_URL --app hubandspoke)
case "$HURL" in *sslmode=*) ;; *) HURL="${HURL}?sslmode=require";; esac

# 2. Recreate the local DB on your local server
LOCALCREATEDB=createdb; LOCALDROPDB=dropdb; LOCALPSQL=psql   # adjust to your local PG bin if needed
"$LOCALDROPDB" hubandspoke_development 2>/dev/null || true
"$LOCALCREATEDB" hubandspoke_development

# 3. Dump prod as plain SQL via a PG17 container
docker run --rm postgres:17 pg_dump "$HURL" \
  --no-owner --no-acl --no-comments --schema=public --quote-all-identifiers \
  > /tmp/hs_prod.sql

# 4. Restore with the LOCAL psql (errors are non-fatal; we want to see them, not stop)
"$LOCALPSQL" -d hubandspoke_development -v ON_ERROR_STOP=0 -f /tmp/hs_prod.sql
rm -f /tmp/hs_prod.sql
```

**Expected benign errors (Path B):** exactly two —
`unrecognized configuration parameter "transaction_timeout"` (a PG 17-only GUC the dump SETs;
harmless on an older server) and `schema "public" already exists`. Everything else should be
silent. If you see table/COPY errors, the dump is bad — recheck the container actually ran
PG 17 and that the prod URL connected.

> Why not just `heroku pg:pull` everywhere? `pg:pull` shells out to your **local** `pg_dump`
> (must be ≥ 17) and restores a **custom-format** archive into the local server (which then
> also wants to be ≥ the dump version). Path B sidesteps both: the dumper is a pinned PG 17
> container, and plain SQL downgrades cleanly into an older local server.

## Verify

```bash
psql -d hubandspoke_development -c "SELECT 'production_items' AS t, COUNT(*) FROM production_items UNION ALL SELECT 'content_events', COUNT(*) FROM content_events UNION ALL SELECT 'users', COUNT(*) FROM users;"
```
Report the row counts so the user can sanity-check the pull landed (production_items should be
tens of thousands, not zero). Zeroes usually mean a PG version mismatch on the dumper.

## After the pull

- **Reset your interactive login password.** The pull replaces the local `users` table with
  prod's bcrypt hashes, so you can't log in with a known password until you reset one. The seed
  script upserts (resets if the email exists, creates it if not), against the **local** DB only:
  ```bash
  # Pat's login (default):
  node --env-file=.env.local scripts/seed-user.mjs patrickswalls@gmail.com 'jackson1234'
  # Other contributors: substitute your own email so you reset YOUR user.
  ```
  (`jackson1234` matches the starter-story pulldb convention — local-only, ≥8 chars to satisfy
  the password rule.) Then log in at http://localhost:3000/login.
- **Re-seed the Playwright E2E user** (only needed if you run e2e tests):
  ```bash
  node --env-file=.env.local scripts/seed-user.mjs e2e@local.test change-me-locally 'E2E Test'
  ```
  (Match `E2E_TEST_USER_EMAIL` / `E2E_TEST_USER_PASSWORD` in your `.env.local`.) If there's no
  `.env.local` yet, copy `.env.local.example`, set `DATABASE_URL` to your local DB,
  `DATABASE_SSL=off` (required by `src/lib/db/index.ts` for a non-SSL local server), and a
  generated `NEXTAUTH_SECRET`. Third-party API keys can stay blank to just view the dashboard.
- **Restart the dev server** in the background:
  ```bash
  PORT=3000 npm run dev   # run_in_background: true
  ```

## Standing decisions (don't re-ask)

- **Always drop and recreate.** Never ask about preserving the local `hubandspoke_development` DB.
- **Don't ask whether to kill the dev server** — kill it before, restart it after.
- **Heroku app** is `hubandspoke`; **local DB** is `hubandspoke_development`. Stable — don't ask.
- **Pick the path by tooling, not by preference:** native PG 17 client + PG 17 local server →
  Path A; otherwise → Path B (Docker). Both land the same data.
- **Reset Pat's login after every pull** — `patrickswalls@gmail.com` → `jackson1234` (local DB
  only) so he can sign in immediately. Don't ask; just run it. Other contributors reset their
  own email instead.
- **Pat's machine (2026-06):** Homebrew prefix isn't writable (PG 17 brew install fails) and the
  local server is Postgres.app **PG 15**, so Pat's machine uses **Path B**. See the
  `reference_hubandspoke_pulldb_pg17` memory.
