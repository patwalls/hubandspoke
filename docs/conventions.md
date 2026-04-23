# Conventions

Rules of the road for adding or changing things in Hub & Spoke. Short and
opinionated on purpose — when in doubt, follow these and update the docs in
the same PR.

## Documentation is part of the change

- **Touching a background job, cron schedule, or service that runs on its
  own** → update `docs/automation.md` in the same PR. The doc is the index;
  if it goes stale the next session can't find anything.
- **Adding or removing a user-facing feature, route, table, or major column**
  → update `docs/features.md`. This is the cleanup backlog too — flag the
  thing as `Legacy` or `Planned-removal` instead of silently letting it rot.
- **Renaming a status string, platform string, or post-type string** → grep
  the codebase first. These strings appear in:
  - `src/lib/db/schema.ts` (the canonical list)
  - Notion sync push-back (`src/lib/services/notion-sync.ts`)
  - UI filters and pickers (`src/components/`)
  - Enrichment dispatch (`src/lib/services/enrichment/orchestrator.ts`)
  - Performance decay platform map (`src/lib/services/performance-decay.ts`)
  - Crontab account-refresh sweep (only refreshes SC-supported platforms)
  - The cron tick allowlist (`src/app/api/cron/tick/route.ts`)
  Don't ship a rename until you've handled all of them.

## Adding a new background task

1. Create `src/jobs/tasks/<task-name>.ts` exporting a `Task` and a typed
   `Payload` interface. Keep payloads small (IDs, not blobs).
2. Register in `src/jobs/tasks/index.ts`: import, add to `TaskPayloads`, add
   to `taskList`.
3. Enqueue with `enqueue("<name>", { … })` from `@/jobs/enqueue`. The name
   and payload shape are type-checked.
4. Document in `docs/automation.md` under the relevant entity lifecycle.

## Adding a new cron schedule

1. Add a row to `src/jobs/crontab.ts`. UTC, standard cron syntax.
2. The task it points to must already be in the registry (above).
3. Document in `docs/automation.md` (At-a-glance graph + the right lifecycle
   section).
4. Worker dyno restarts on release pick it up automatically. No Heroku
   Scheduler involvement.

## Schema changes

Use drizzle-kit (already in `CLAUDE.md`):
- Edit `src/lib/db/schema.ts`
- `npm run db:generate` → review the SQL → commit `drizzle/`
- Push. Heroku release phase applies it.

**Never** hand-write `scripts/add-*.mjs` for ALTER TABLE — that's the legacy
pattern. Backfills (data, not schema) still go in `scripts/backfill-*.mjs`.

If the schema change adds/removes/renames a feature's backing table or major
column, also update `docs/features.md`.

## Removing a feature

1. Mark the feature `Planned-removal` in `docs/features.md` with a short note
   on what depends on it.
2. Remove callers first (UI components, then API routes, then service
   functions). Each step is its own commit so history stays bisectable.
3. Drop the table/column last with a drizzle migration.
4. Mark the row as removed in `docs/features.md` (or delete the row if there
   are no remaining historical references).

Don't leave dead code with `// removed` comments — delete it. The PR diff and
git history are the audit trail.

## Idempotency expectations

Every task in `src/jobs/tasks/` is retried on exception by graphile-worker.
Design accordingly:

- Check for the side-effect being already done at the top of the task and
  return early (e.g. `descript-transcribe` skips if a transcript row exists;
  `enrich-item` skips if `enrichment_completed_at` is set).
- Use `unsafe_dedupe` jobKeys for sweep parents so overlapping ticks don't
  double-fan-out (see `enrichmentSweepTask`).
- `Date` doesn't survive JSON serialization in payloads — pass ISO strings,
  parse inside the task. See `TranscriptFinishPayload.startedAtIso`.

## Long-running jobs

Heroku's router timeout is 30s and dyno restarts SIGTERM at any time. For any
task that takes longer than ~20s:

- Use the **short-invocation / self-re-enqueue** pattern: each invocation
  does one HTTP poll (or one chunk of work) and re-enqueues a successor with
  a 5s `runAt` delay. See `descriptTranscribeTask` and
  `descriptClipResolveTask` for reference.
- Carry a `deadlineAt` (epoch ms) in the payload so the chain doesn't loop
  forever; throw on expiry so graphile-worker stops retrying.

## Connection budget

Heroku Postgres Essential-0 = 20 connections. Splits roughly:
- web dyno: postgres.js pool `max: 8` + `WorkerUtils` pool `2` = 10
- worker dyno: pg pool `max: 6` + drizzle `3` + LISTEN `1` = 10

Scaling web past 1 dyno without lowering worker concurrency or upgrading
Postgres will start to hit the cap. Update `docs/automation.md` if you
change pool sizes.
