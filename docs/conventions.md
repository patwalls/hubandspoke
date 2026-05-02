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

## Statuses — per-brand, not in code

Production-item statuses live in `brand_statuses` (one row per brand × name),
edited at `/[brand]/accounts/statuses`. Don't hard-code a status list in a
new component or query — fetch the brand's palette via:

- Server: `getBrandStatuses(brand)` / `getStatusPalette(brand)` /
  `getAllStatusPalettes()` from `src/lib/db/brand-statuses.ts`.
- Client: `/api/brand-statuses?brand=<slug>` (or `&pipelineOnly=1`).

Render chips with `statusClassWithPalette(status, palette)` (server) or
`statusClassFromToken(token)` (client, when the token is already on hand).
The legacy `statusClass(status)` lookup against `STATUS_COLORS` is kept as
a fallback only; new code shouldn't use it directly.

**Protected names.** Four status names are seeded with `isProtected = true`
on every brand and locked from rename/delete in the UI. The canonical list
is `PROTECTED_STATUS_NAMES` in `src/lib/db/brand-statuses.ts`:

- `Idea` — auto-created status of every new item from repost / cross-post /
  duplicate / clip-out / threshold-monitor; filtered by name in queue-view,
  cross-post-feed, evergreen-scan
- `Assigned` — target of triage "accept", clip promotion, and the queue
  outcome flow; my-work role logic keys off it
- `Published` — publish-date filters in `src/lib/db/queries.ts`
- `Killed` — kill-confirmation modal in `src/components/dashboard/content-detail.tsx`

Renaming any of these would silently break the flow that hard-codes the
string. New brands get the seed via `POST /api/brands`; existing brands are
re-flagged by re-running `scripts/backfill-brand-statuses.mjs` (idempotent —
seed pass + re-flag pass).

## Brand routing — the "All content" sentinel

The brand sidebar contains one synthetic entry, `"All content"` (slug
`"all"`), that lives outside the `brands` table. It's prepended to the
brand list in `src/app/(dashboard)/layout.tsx`. Don't insert an `"all"`
row into the `brands` table — every brand-keyed query (accounts FK
joins, format lookups, brand-priority sort, the cross-post recommender)
would treat it as a real brand and corrupt cross-brand state.

`brand === "all"` is a recognized cross-brand sentinel in:

- `getProductionPipeline`, `getContentReport`, `getWeeklyGoal`,
  `getBrandSettings` (`src/lib/db/queries.ts`) — drop the
  `eq(productionItems.brand, brand)` predicate.
- `buildViewPredictorContext` (`src/lib/services/view-predictor.ts`)
  — drop the same predicate so the predictor pulls historical context
  from every brand at once.

The route tree lives at `src/app/(dashboard)/all/`, mirroring
`src/app/(dashboard)/coverage/` (the existing precedent for a
non-brand sibling route). Only data-view pages (Dashboard, Content,
Production, Queue) are mirrored — Formats, Accounts,
cross-post-rules, settings are intentionally absent because they're
brand-scoped configuration.

When you add a new dashboard page, decide whether it has cross-brand
meaning. If yes, mirror it under `/all/`; if no, leave the sidebar tab
hidden when `currentBrand === "all"` (see
`src/components/dashboard/nav.tsx` `SectionTabs`).

## Channel display strings

The legacy display format `"PLATFORM (NAME)"` (e.g. `"X (Pat Walls)"`,
`"YouTube (SS)"`) is **banned** outside the Notion import boundary. Account
identity lives on `accounts` (one row per platform+handle), and the post
shape lives on `production_items.post_type`. UI renders both via
`AccountBadge` (`src/components/ui/account-badge.tsx`).

The only legitimate reader/producer of the legacy format is
`src/lib/services/notion-sync.ts` — Notion's "Channel" multi-select still
emits these strings and we can't change that. There, `resolveNotionChannel`
parses them and resolves to an `accountId` immediately; an unresolvable
channel skips the page rather than persisting a half-record.

Don't introduce new template literals like `${platform} (${name})` in app
code, don't add legacy-string constants, and don't render raw
`item.platform[0]` — use the joined `item.account` + `item.postType`.

## Soft-delete columns

Two tables support soft delete today: `accounts.deleted_at` and
`production_items.deleted_at` (both nullable timestamp). The `DELETE
/api/accounts/[id]` endpoint stamps both in one transaction — deleting an
account also cascades the flag to every production item linked to it.

- **When adding a new user-visible list query** that reads `accounts` or
  `production_items`, filter `isNull(…deletedAt)`. The account-read helpers
  in `src/lib/db/accounts.ts` already do this; if you query the tables
  directly in a new route, replicate the filter.
- **When adding a by-id internal fetch** (enrichment, transcription,
  background jobs): don't filter. In-flight work on a soft-deleted row is
  harmless and filtering would break idempotency checks.
- **Restore** is engineer-only via SQL: `UPDATE … SET deleted_at = NULL
  WHERE id = '…';`. If a restore UI is ever needed it's a small addition to
  the Accounts page.

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
  return early (e.g. `transcribe-whisper` skips if a transcript row exists;
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
  a 5s `runAt` delay. See `transcribeWhisperTask` (phase 1 → phase 2) and
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
