# Hub & Spoke - Content Command Center

## Documentation — read first, update in the same commit

Three docs in `docs/` are the source of truth for what this project does and how it runs:
- `docs/automation.md` — every cron, worker task, and on-demand job (entity lifecycles, dependency graph, operational rules)
- `docs/features.md` — feature & surface inventory; also the cleanup backlog (Active / Legacy / Deprecated / Planned-removal)
- `docs/conventions.md` — rules for adding tasks/cron/schemas, idempotency expectations, payload conventions, every-place-to-update checklists

**Read the relevant doc before starting the work**, not after — the goal is to notice existing patterns and avoid drift, not to patch the doc at the end.

**Before you `git commit`, check the staged paths:**
- Anything under `src/jobs/**` or `src/lib/services/**` → `docs/automation.md` MUST be staged in the same commit.
- A new/removed/renamed user-facing route, API endpoint, or major column (`src/app/(dashboard)/**`, `src/app/api/**`, `src/lib/db/schema.ts`) → `docs/features.md` MUST be staged in the same commit.
- A new task / cron / schema pattern that future contributors will copy → `docs/conventions.md` may need updating; check.

If a change genuinely doesn't warrant a doc update (pure rename, internal refactor, typo fix, dependency bump), say so in the commit message — otherwise update the doc in the same commit.

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

## Testing & visual verification

- `npm run test` — Vitest (unit + integration). `:unit` and `:integration` projects defined in `vitest.config.ts`.
- `npm run test:e2e` — Playwright e2e specs in `tests/e2e/`. Boots a dev server on :3000 if one isn't already running. Auth state is set up once by `tests/e2e/auth.setup.ts` and reused across specs. Deeper setup notes (seeding the user, fresh-DB bootstrap) live in `docs/conventions.md` → End-to-end testing.

### Verifying UI changes — always use Playwright MCP

**Whenever you change anything user-facing under `src/app/(dashboard)/**` or `src/app/(auth)/**`, open it in a real browser before reporting the task complete.** `curl` is not enough — auth-gated pages 302 to `/login` for unauthed requests, and JS-rendered components (charts, the workflow board, modals, polling dashboards) don't show up in raw HTML.

**Hard rule:** do NOT report a UI task as done without an actual visual check — either an MCP snapshot/screenshot, or output from a Playwright spec run (`npx playwright test …`) that exercises the changed surface. If every avenue genuinely failed, say so explicitly ("I could not visually verify because X — here is exactly what I tried") instead of letting the user discover it. "I ran the integration tests" is not a substitute for seeing the page.

The reliable loop:

1. **Make sure `npm run dev` is up on :3000.** If not, start it in the background (it hot-reloads on file changes).
2. **Navigate** with `mcp__playwright__browser_navigate` to `http://localhost:3000/<path>`. There is no `*.test` hostname here — only `localhost:3000`.
3. **If you land on `/login`, log in:**
   - email: `e2e@local.test`
   - password: `change-me-locally`
   (These live in `.env.local` as `E2E_TEST_USER_EMAIL` / `E2E_TEST_USER_PASSWORD`. On a fresh DB or after `/pulldb` blew the user away, re-seed with `node --env-file=.env.local scripts/seed-user.mjs e2e@local.test change-me-locally 'E2E Test'`.) The MCP profile is persistent (`~/Library/Caches/ms-playwright/mcp-chrome-profile/`), so subsequent navigations in the same session stay logged in.
4. **See the page** with `mcp__playwright__browser_snapshot` (accessibility tree — usually enough) or `mcp__playwright__browser_take_screenshot` (pixels — for visual layout bugs). Verify the thing you changed actually looks right.
5. **Save screenshots to `.playwright-mcp/screenshots/`** — always pass `filename: ".playwright-mcp/screenshots/<descriptive-name>.png"` to `mcp__playwright__browser_take_screenshot`. That directory is already gitignored (matches the snapshot/console scratch the MCP server writes there). Without the explicit path, screenshots land in the project root as untracked noise.
6. **Close the browser when done** with `mcp__playwright__browser_close`. The MCP server spawns a fresh browser per task instead of reusing one, so leaving sessions open piles up Chromium processes on Pat's machine. Always shut it down at the end of a smoke-test loop — even if the test passed. This is also what keeps parallel Claude sessions (across this repo and others on the same machine) from colliding — see the lock case below.

#### When the MCP session is dead or contested

Two distinct failure modes — diagnose by the error message and recover differently.

**A. "Target page, context or browser has been closed"** (or any "browser not running" error) — the session itself is dead, usually because a previous run or another worktree closed the shared browser. **Do not stop at the first error and ask Pat to restart the server.** Work through this recovery ladder in order:

1. **Retry `mcp__playwright__browser_navigate` once.** The MCP server frequently spins a fresh browser on the next navigate call after one died.
2. **Force a clean context:** call `mcp__playwright__browser_close`, then `mcp__playwright__browser_navigate` again. This drops whatever stale context the server was hanging onto.
3. **If MCP still won't come up, fall back to the Playwright CLI — that path has zero dependency on the MCP server.** Write a throwaway spec at `tests/e2e/_scratch.spec.ts` (gitignored prefix — clean it up when done) that navigates to the route, asserts on the thing you changed, and on failure saves a screenshot to `.playwright-mcp/screenshots/`. Run it with `npx playwright test tests/e2e/_scratch.spec.ts --reporter=line`. The existing `tests/e2e/auth.setup.ts` handles login, so you get an authed session for free.
4. **Only after 1–3 all fail**, surface it to Pat — and surface it loudly, with the exact commands you ran and their errors. Then ask him to restart the playwright MCP server. Never silently downgrade to "integration tests passed, shipping it."

**B. "Browser is already in use for ... use --isolated to run multiple instances of the same browser"** — a parallel Claude session (in this repo, another worktree, or another project on the same machine) has the Chromium instance locked. The `--isolated` CLI flag is a Playwright MCP server argument we can't pass through.

This is **not** the session-dead case. Don't try to recover by closing/reopening or by asking Pat to restart — it's normal parallel-session contention with another running session, and recovery steps will just keep failing the same way.

- If you've already verified the change at the data layer (e.g., the DB row reflects what the UI should show, the query feeding the component returns the expected rows, there are no transformations between DB and pixel that could plausibly go wrong), that is usually sufficient. Don't block waiting for the browser.
- The Playwright CLI fallback from path A above also works here — `npx playwright test` spawns its own Chromium and doesn't go through the MCP server, so the lock doesn't apply.
- Ask Pat once if a screenshot is critical and the CLI fallback isn't workable. If he says "fine, we'll live with it," accept the data-layer evidence and close out.

The goal: a dead-or-locked MCP session is an obstacle to route around, not a license to skip the visual check.

**When NOT to use Playwright MCP.** Public/unauthed routes or API JSON → `curl` is fine. Pure data verification (row counts, job state, queue contents) → `heroku pg:psql` or a local Drizzle query, not a browser.

**When to also write/extend an e2e spec.** If the UI you just changed has a clear golden path that future regressions would break silently (e.g. a new dashboard tab, a new form submission, a new auth-gated flow), add or extend a `tests/e2e/*.spec.ts` so `npm run test:e2e` catches it next time. MCP verifies *now*; a spec verifies *every push*.

### Writing tests — default-on for new logic

**Write a test when you add or change anything in these buckets:**
- A pure function with branches (formatters, classifiers, prompt builders, validators) → **unit test** at `<module>.test.ts` next to it.
- A DB-touching service or helper that's called from multiple sites (resolvers, lookup helpers, lineage walks) → **integration test** at `<module>.integration.test.ts` next to it.
- A new column with conditional behavior on its value (like the `labels_as_original` / `is_clip_descript_format` flags we just shipped) → integration test that proves the flag actually flips behavior.
- A bug fix → a test that reproduces the bug, then proves the fix.

**Skip the test when:**
- It's a one-shot backfill script — those are validated by `--dry-run` output.
- It's a pure rename / file move / dead-code removal.
- The logic is "fetch and render" with no branching (the e2e spec covers it).

Don't write a test "for coverage." A test that asserts what the code already says (`expect(x).toBe(x)`) is noise. Aim for one of: a behavior contract a future contributor could violate, a bug regression, or a boundary case the implementation handles non-obviously.

#### Test fixture factories

Integration tests use the shared factories at `src/test/factories.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTestFormat, createTestProductionItem } from "@/test/factories";

describe("my feature", () => {
  it("respects the format flag", async () => {
    const fmt = await createTestFormat({ labelsAsOriginal: true });
    const item = await createTestProductionItem({ format: fmt.name });
    expect(item.format).toBe(fmt.name);
    // No teardown — importing factories registers an afterEach hook that
    // bulk-deletes everything this file created.
  });
});
```

The factories cover the common shapes (`createTestFormat`, `createTestProductionItem`, `createTestClipIdea`) and look up a default test user / account dynamically so tests aren't coupled to hardcoded UUIDs. Override `accountId` / `producerUserId` / `editorUserId` when the test cares.

**Don't reach for `db.insert` directly in a new test.** If a fixture shape isn't covered by a factory, extend the factory — the next test will need it too.

#### Running tests

- `npm run test` — all of them (unit + integration). Should finish in <3s.
- `npm run test:unit` — unit only. Pure, fast. Run this in tight feedback loops while iterating on a pure function.
- `npm run test:integration` — integration only. Needs `DATABASE_URL` in `.env.local`.
- `npm run test:watch` — vitest watch mode.
- `npx vitest run path/to/file.test.ts` — single file.
- `npx vitest run -t "exact test name"` — single test.

The full suite is fast enough to run on every commit — don't let it grow into something you skip. If it starts to slow down, fix the slow test, don't add a `.skip()`.

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
- `src/jobs/` - Graphile Worker: task registry + enqueue helper + worker entrypoint + crontab

## Cron / Scheduled Jobs
Scheduled work runs via **graphile-worker's crontab** on the worker dyno.
No Heroku Scheduler addon — schedules live in `src/jobs/crontab.ts` (standard
cron syntax, UTC). Each schedule references a task registered in
`src/jobs/tasks/index.ts`; see `src/jobs/tasks/scheduled.ts` for the current
wrappers.

- **Add a scheduled job** = add a task in `src/jobs/tasks/scheduled.ts` + a
  line in `src/jobs/crontab.ts` + a `TaskPayloads` entry. Push. The worker
  picks it up on its next boot (release phase restarts the dyno).
- **Manual ad-hoc trigger:** `GET /api/cron/tick?name=<task>` with
  `Authorization: Bearer $CRON_SECRET` enqueues the task for immediate pickup.
  Bare `GET /api/cron/tick` is a noop.
- **Catch-up:** graphile-worker persists last-fired timestamps in
  `graphile_worker.known_crontabs`, so a task scheduled while the worker was
  down fires as soon as the worker boots (within the backfill window).
- **Long tasks + deploys:** any task that runs longer than ~20s can get
  interrupted by a dyno restart (deploy, daily cycle). Graphile Worker
  retries automatically with exponential backoff.

## Notion Integration
- Database ID: `8cb6cee4163d4282a5c87991ea689bde`
- Syncs content production items with metrics
- Format relation requires separate page fetch (cached)

## Text analysis — use LLMs, not regex

Do not write regex (or other brittle pattern-matching) to classify or transform free-form user-generated content — post bodies, captions, transcripts, hooks, anything an editor wrote. Use an LLM. The cheapest model that handles the task — typically `claude-haiku-4-5-20251001` — is fine for one-shot text→text or text→classification calls. Template to mirror: `src/lib/services/draft-algorithm/derivative-hook.ts` (Haiku + single pinned tool + fail-soft `{ ok: false, failure }` return shape).

Regex is fine for **structural** string handling — URLs, slugs, identifiers, placeholders like `{{hook}}`, file extensions, host parsing. The rule is about **content meaning**, not string shape.

## Critical Rules
- NEVER commit or push without explicit user permission
- NEVER expose API keys or secrets
