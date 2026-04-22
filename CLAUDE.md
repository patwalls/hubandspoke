# Hub & Spoke - Content Command Center

## Project Context
Standalone content reporting dashboard carved out from the Starter Story Rails app. Syncs content production data from Notion and displays analytics across platforms.

## Tech Stack
- Next.js 16 (App Router, TypeScript)
- Tailwind CSS + shadcn/ui
- Auth.js v5 (Credentials provider, JWT sessions, bcrypt)
- Heroku Postgres (PG 17)
- Drizzle ORM
- Postmark for transactional email
- Graphile Worker (Postgres-backed background job queue)
- Deployed on Heroku (auto-deploy on push to `main` via GitHub Actions)
  - Two dynos: `web` (Basic) + `worker` (Basic) — see `Procfile`

## Development
- `npm run dev` - Start dev server (main worktree uses port 3000)
- `npm run dev:all` - Start dev server + background worker together
- `npm run worker` - Start the background-job worker (connects to `DATABASE_URL`)
- `npm run build` - Production build
- `npm run db:generate` - Generate a new migration after editing `schema.ts`
- `npm run db:migrate` - Apply pending migrations to the DB in `DATABASE_URL`
- `npm run worker:migrate` - Apply graphile-worker's own migrations (creates/updates the `graphile_worker` schema)
- `node --env-file=.env.local scripts/seed-user.mjs <email> <pass> [name]` - Seed a user

## Database Migrations
Rails-style versioned migrations via `drizzle-kit`. Versioned SQL files live in
`drizzle/` and are committed to git. Heroku's release phase runs
`npm run db:migrate` before new dynos take traffic — a failed migration fails the
deploy, so schema and code ship together.

**To change the schema:**
1. Edit `src/lib/db/schema.ts`.
2. Run `npm run db:generate` — emits `drizzle/NNNN_<name>.sql` (plus updates the
   snapshot/journal in `drizzle/meta/`). Review the SQL.
3. Commit everything under `drizzle/` alongside the schema change.
4. Push. Heroku's release phase applies it automatically.

**Never** hand-write `scripts/add-*.mjs` or `scripts/create-*-table.mjs` for
schema changes — that's the pre-2026-04 pattern that caused outages when someone
forgot to `heroku run` them. The legacy scripts in `scripts/` are historical
only; do not extend them.

**Data backfills** (distinct from schema changes) still belong in
`scripts/backfill-*.mjs` — they're one-shot, often need to be re-run selectively,
and shouldn't block deploys. Run with `heroku run --app=hubandspoke node
scripts/backfill-foo.mjs`.

**Adopting migrations on a pre-existing DB** (already done for prod 2026-04-19):
run `scripts/bootstrap-drizzle-migrations.mjs` once. It creates
`drizzle.__drizzle_migrations` and marks every migration in the journal as
already-applied so drizzle-kit doesn't try to recreate existing tables.

## Background Jobs (Graphile Worker)

Long-running work runs on a dedicated `worker` dyno, backed by a queue in the
`graphile_worker` Postgres schema. Enqueue jobs from the web dyno via the
typed helper `enqueue(name, payload)`; the worker picks them up within ~1ms
via LISTEN/NOTIFY.

**Why this exists:** Heroku's router has a hard 30s timeout. Any route that
would take longer — polling a Descript publish job, sending a Postmark email,
running an hourly sync — belongs on the queue so it survives dyno restarts,
gets retries with backoff, and doesn't block HTTP responses.

### To add a new background task

1. Create `src/jobs/tasks/<task-name>.ts`:

   ```ts
   import type { Task } from "graphile-worker";

   export interface MyTaskPayload {
     productionItemId: string;
   }

   export const myTask: Task = async (rawPayload, helpers) => {
     const { productionItemId } = rawPayload as MyTaskPayload;
     helpers.logger.info(`my-task start item=${productionItemId}`);
     // …do the work…
   };
   ```

2. Register it in `src/jobs/tasks/index.ts`:

   ```ts
   import { myTask, type MyTaskPayload } from "./my-task";

   export interface TaskPayloads {
     // …existing entries…
     "my-task": MyTaskPayload;
   }

   export const taskList = {
     // …existing entries…
     "my-task": myTask,
   };
   ```

3. Enqueue from any route/service on the web dyno:

   ```ts
   import { enqueue } from "@/jobs/enqueue";
   await enqueue("my-task", { productionItemId: id });
   ```

   `enqueue` is type-checked against `TaskPayloads` — wrong name or bad
   payload shape is a compile error.

4. Deploy. The worker dyno auto-restarts on release and picks up the new
   task. No Heroku config changes needed.

### Local dev loop

- `npm run dev:all` runs the Next dev server and the worker side-by-side with
  colored output. One terminal, both processes. Needs `.env.local` to define
  `DATABASE_URL` (local Postgres via `pulldb`, or your own).
- First time on a fresh DB: `node --env-file=.env.local scripts/graphile-migrate.mjs`
  to create the `graphile_worker` schema. After that, `worker:migrate` is
  idempotent and normally only needs to run in Heroku's release phase.

### Payload conventions

- Keep payloads small (<4 KB). Pass IDs, re-fetch inside the task. Don't pass
  comment bodies, transcript text, or other blobs — they'll sit in the queue
  until the job runs (stale data + wasted storage).
- `Date` doesn't survive JSON serialization — send ISO strings and parse
  inside the task (see `TranscriptFinishPayload.startedAtIso`).
- Tasks must be idempotent where possible. Graphile Worker retries on
  exception; design for being invoked twice.

### Heroku setup

- **Worker dyno:** provisioned once via `heroku ps:scale worker=1:Basic --app hubandspoke`
  ($7/mo). Same `Procfile` line runs locally via `npm run worker`.
- **Release phase** (`Procfile: release:`) runs `npm run db:migrate && npm run worker:migrate`
  in that order. A failed migration fails the deploy — schema and code ship
  together.
- **Connection budget (Heroku Postgres Essential-0 = 20 connections):**
  - web dyno: postgres.js pool `max: 8` + enqueue-side `WorkerUtils` pool `2` = 10
  - worker dyno: pg pool `max: 6` + drizzle `3` + LISTEN connection `1` = 10
  - If scaling web past 1 dyno, drop worker concurrency or upgrade Postgres.
- **Graceful shutdown:** worker gets 20s after SIGTERM to finish in-flight
  jobs; Heroku sends SIGKILL at 30s. See `src/jobs/worker.ts`.
- **SSL:** every graphile-worker call site (worker, enqueue, migrate) goes
  through `buildPgPool()` in `src/jobs/pg-pool.ts`, which sets
  `ssl: { rejectUnauthorized: false }` on Heroku (Heroku Postgres uses
  self-signed certs) and disables SSL when `DATABASE_SSL=off` locally.

### Inspecting the queue

```bash
# Live tail of worker logs
heroku logs --app hubandspoke --dyno worker --tail

# Pending / running / failed jobs
heroku pg:psql --app hubandspoke -c "SELECT task_identifier, attempts, max_attempts, run_at, last_error FROM graphile_worker.jobs ORDER BY run_at DESC LIMIT 20;"

# Manually enqueue a hello smoke test
heroku run --app hubandspoke node -e 'import("graphile-worker").then(async (gw) => { const pg = await import("pg"); const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); await gw.quickAddJob({ pgPool: pool }, "hello", { message: "smoke" }); await pool.end(); })'
```

## Worktree Workflow
All feature work happens in a git worktree, not the main checkout. Set one up with:

```
./scripts/worktree-up.sh <branch-name> [port]
```

This creates `../hubandspoke-<branch-name>` off `origin/main`, symlinks `.env.local`
from the main checkout (secrets never get duplicated), runs `npm install`, and picks
the first free port ≥ 3001. It prints the exact `PORT=… npm run dev` command to run.

Notes:
- Turbopack rejects a symlinked `node_modules`, so each worktree needs a real install
  (~9s). Don't try to share `node_modules` via symlink.
- Delete the worktree after merge: `git worktree remove ../hubandspoke-<branch-name>`.

## Key Files
- `src/lib/db/schema.ts` - Database schema (Drizzle)
- `src/lib/services/notion-sync.ts` - Notion sync service
- `src/lib/db/queries.ts` - Report aggregation logic
- `src/components/dashboard/` - Dashboard UI components
- `src/lib/auth.ts` - Auth.js config
- `src/lib/email.ts` - Postmark client
- `src/lib/cron/jobs.ts` - Scheduled job registry (dispatched by `/api/cron/tick`)
- `src/jobs/` - Graphile Worker: task registry + enqueue helper + worker entrypoint

## Cron / Scheduled Jobs
- One Heroku Scheduler entry hits `GET /api/cron/tick` every 10 minutes.
- The tick endpoint dispatches whichever entries in `src/lib/cron/jobs.ts` match the current 10-minute window.
- Add a job = add an entry to `CRON_JOBS` and deploy.
- **Planned migration:** these six entries will move to Graphile Worker's
  crontab in a follow-up (Phase 2 of the background-job migration). When that
  lands, Heroku Scheduler retires and `CRON_JOBS` is deleted. Until then, net
  new recurring work should still go through `CRON_JOBS`.

## Notion Integration
- Database ID: `8cb6cee4163d4282a5c87991ea689bde`
- Syncs content production items with metrics
- Format relation requires separate page fetch (cached)

## Critical Rules
- NEVER commit or push without explicit user permission
- NEVER expose API keys or secrets
