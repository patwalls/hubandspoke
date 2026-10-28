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

**Protected names.** Five status names are seeded with `isProtected = true`
on every brand and locked from rename/delete in the UI. The canonical list
is `PROTECTED_STATUS_NAMES` in `src/lib/db/brand-statuses.ts`:

- `Idea` — auto-created status of every new item from repost / cross-post /
  duplicate / clip-out / threshold-monitor; filtered by name in queue-view,
  cross-post-feed, evergreen-scan
- `Assigned` — target of triage "accept", clip promotion, and the queue
  outcome flow; my-work role logic keys off it
- `Scheduled` — write-only via the publish route's schedule mode; the
  `schedule-reconcile-sweep` matcher filters Scheduled items by this literal,
  and content-detail filters it out of the editable status dropdown
- `Published` — publish-date filters in `src/lib/db/queries.ts`
- `Killed` — kill-confirmation modal in `src/components/dashboard/content-detail.tsx`

Renaming any of these would silently break the flow that hard-codes the
string. New brands get the seed via `POST /api/brands`; existing brands are
re-flagged by re-running `scripts/backfill-brand-statuses.mjs` (idempotent —
seed pass + re-flag pass). `Scheduled` was added to the protected set
2026-06-24; `scripts/backfill-scheduled-status.mjs` inserts the row (positioned
just before `Published`) into brands that already have a palette.

## Filter state lives in the URL

Every filtered list view in the dashboard (Content, Production, Queue,
Formats, Dashboard, format-detail "All content" sort) routes its filter
and sort state through the URL, not `useState`. This gets us three
things for free:

1. Shareable links — paste a filtered URL and the recipient sees the
   same view.
2. Browser back/forward restores the previous filter set.
3. The detail-page `← Content` / `← Formats` back link lands the user
   on the exact filtered list they came from (via the
   `useRememberListUrl` + `<BackLink>` pair).

**Adding a new list view? Use these three primitives:**

- `useUrlState({...})` (`src/lib/hooks/use-url-state.ts`) — round-trips
  named keys through `useSearchParams` ↔ `router.replace`, prunes
  default values from the URL, debounces text inputs. Replaces every
  per-filter `useState`. Pass `{ default: "all" }` for picker filters
  and `{ default: "", debounceMs: 250 }` for search boxes.
- `useRememberListUrl({ brand, listKey })`
  (`src/lib/hooks/use-remember-list-url.ts`) — call once on a list
  page. Writes the current `pathname + search` to sessionStorage so
  the corresponding `<BackLink>` on detail pages can restore it.
- `<BackLink brand={...} listKey="..." fallbackHref="...">`
  (`src/components/dashboard/back-link.tsx`) — reads the
  sessionStorage entry; falls back to `fallbackHref` on deep-link /
  new-tab / cleared session. Already wired into the section-tabs row
  (`nav.tsx`) for `content` and `formats` detail pages — extend that
  switch when adding a new detail type.

**Key naming convention.** The URL key is the canonical name; internal
state can alias it differently if it improves readability. Examples in
use: `?platform=...`, `?accountId=...`, `?postType=...`, `?format=...`,
`?source=...`, `?startDate=...`, `?endDate=...`, `?viewType=...`,
`?q=...` (search), `?sort=...`, `?dir=...` (or a single `?sort=key:dir`
encoding when a list has more than one sortable axis).

**Don't seed state with `useSearchParams.get(...)` + `useState`.** That
was the pre-2026-05-22 pattern; it gave you initial-load filters from
URLs but never wrote back, so back-navigation and reload silently
discarded everything. The new hook is the only sanctioned way to read
filter state.

The reference migration is `src/components/dashboard/content-view.tsx`
— copy that shape for a new list view.

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

## Newsletters — one editor, driven by template settings

Every newsletter (Starter Story's HubSpot formats, Futurepedia's beehiiv one, the next one we add) uses the **same** editor (`newsletter-editor-dialog.tsx`: the visual canvas + side panel) and the same preview pieces (`EditableSection`, `preview-screenshots.tsx`, used by both `EmailPreview` and `BeehiivPreview`).

- **A new editing or drafting capability is a template setting, not a branch on the newsletter.** Put it on the template section (`sectionSchema` in `src/lib/newsletter-template.ts`, with a control in `newsletter-template-section.tsx`) and read the setting everywhere: the drafter prompt (`describeTemplate`), the editor, both previews and both pushes. Example: `screenshots` (any section, any newsletter).
- **Never gate UI or prompt text on a format name or on `kind`** (`single_video` vs `roundup`) for something that isn't inherently about the kind. `kind` decides *where stories come from* (one picked video vs a lookback window) — that's it. Format-name lookups belong only in `format-config.ts` (schedules, sources, voices, promo).
- **Changing one newsletter's look or sections** = edit its template (or its default in `DEFAULT_TEMPLATES`), not the editor.
- **Fixed parts are locked; drafts edit only drafted text.** Anything the template or the email tool owns (masthead, footer, poll, headings, card labels) renders through `FixedPart` in both previews. The template editor and the draft editor are the same canvas (`EditableSection` in mode `"template"` vs `"draft"`), so a canvas change lands in both.
- **What the email tool's template owns is locked in Edit template too, with a 🔒 and why/how to change it on hover.** A section linked to a HubSpot block keeps its name, colors, order and existence (they live in the HubSpot template email; `hubspotOwnedSection`), and the editor links to that email. Template admins can unlock to match a change made in HubSpot. Enforced by `templateChangeProblem` in the template API.
- **Images in drafts are blocks, not URLs.** Any image in a section's text renders as a clickable block (swap / frame / thumbnail / remove) on both previews, and shows as a `[🖼 …]` token while typing. A new kind of image slot is a template setting (like `thumbnail`) read by the drafter prompt and the template preview, never a hard-coded prompt line.
- **No template is locked any more** (2026-10-23): every push sends the designed email itself (HubSpot: one "Hub & Spoke email" custom module — never rich text, the HubSpot editor strips it; beehiiv: one `html` block + the native poll, 2026-10-26), so no push depends on a template's structure. `locked` is kept in the schema only so older saved templates parse.
- New preview behavior goes in the shared pieces so both previews get it. **One renderer feeds the canvas, the preview, the thumbnail and BOTH pushes** (`renderEmailBody` in `newsletter-email-html.ts`): a design change needs no push-side work; `beehiiv-draft.ts` and `hubspot-newsletter-create-draft.ts` only wrap the HTML in each tool's create call.
- **Template fields** (`{name}` tokens typed into the design, `template.variables` for each one's hint + sample; 2026-10-26): the drafter fills them per issue (`variables` on `submit_newsletter`, stored on `newsletter_drafts.variables`) and `fillVariables` / `applyVars` put the values wherever the token sits. Use a field for anything in the fixed design that changes with the issue (a card label naming the tool, a heading whose name depends on the content). Never parse a value out of the drafted text (the old `{tool}` regex on the Why heading is only the fallback for drafts made before fields). When matching past issues or naming a section for the drafter, resolve headings with `sectionHeadings(template)` so `{steps_heading}` reads as its sample.

## Feature flags — shipping unfinished work to production

When a feature should be live in production for a few named people only, use
`src/lib/feature-flags.ts`. A flag is a hardcoded allowlist of emails; there is
no percentage rollout, table, or admin UI on purpose.

1. Add the flag to `FLAGS` with its allowlist and a `FEATURE_<NAME>_EMAILS`
   env var name. The env var can only **extend** the allowlist (e.g. to let
   `e2e@local.test` through on a dev server) — never replace it.
2. **Gate the server first.** Every route behind the flag calls
   `requireFeature("<flag>")` from `src/lib/auth-guards.ts`, which 404s for
   everyone else. Hiding UI is not a gate.
3. In client code, read `useFeatureFlags()` and treat `null` (loading or
   failed) as "off" — a slow or broken flags request must only ever show the
   existing UI. Lazy-load the flagged component with `next/dynamic` so other
   users never download it.
4. **Keep the unflagged path byte-for-byte what it was.** The pattern used by
   the clip editor: rename the existing component (`ClassicClipTriageDialog`),
   leave it untouched, and export a thin wrapper under the old name that picks
   between the two. Callers don't change.
5. Migrations still ship to everyone — keep them additive (new tables/nullable
   columns) so the flag is the only thing standing between users and the
   feature.
6. Cover both sides in e2e (`tests/e2e/clip-editor.spec.ts` is the template:
   one test per side, each skipping when the signed-in user is on the other).
7. When the feature graduates, delete the flag and every branch that reads it
   — don't leave it on at 100%. As an interim step, `everyone: true` on the
   flag turns it on for every signed-in user (including future signups)
   without touching call sites; `clipEditor` and `designEditor` are in that
   state as of 2026-10-07, pending cleanup.

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
- **If the work genuinely can't be chunked (an ffmpeg encode), it must be
  bounded and abortable instead:** every download and child process goes
  through `src/lib/services/ffmpeg-process.ts` (`downloadToFile`, `runFfmpeg`
  / `runWatchedProcess` — timeout, stall watchdog, hard cap) and receives
  `helpers.abortSignal`, so a deploy's SIGTERM ends the task with a thrown
  error inside graphile's 20s grace and the job + its named-queue lock are
  released. A task that can hang past that window turns into an orphaned
  lock that blocks its whole serial queue (2026-10-15). The worker's lock
  reconciler is the safety net, not the plan — see `docs/automation.md` →
  Queue health and lock reconciliation.
- **An SDK call allowed more than 5 minutes passes `longRequestOptions(ms)`**
  (`src/lib/long-request.ts`) instead of a bare `timeout`. Node's built-in
  fetch has its own 300 s clock for response headers and body gaps that the
  OpenAI and Anthropic SDKs' `timeout` does not lift (2026-10-26, diarize).
- **Serial queues (`queueName: "media-heavy"`, `"diarize"`) are a shared
  resource.** One hung job stops every job behind it. Put a task on one only
  when two of them running at once would actually hurt (memory), and keep
  its per-invocation ceiling short.

## Log volume — the drain has a daily cap

Logs drain to SolarWinds/Papertrail on the free plan; past the daily cap every
new line is dropped until midnight UTC (hit 2026-10-16). Every line counts, and
the Heroku router writes one per HTTP request. So:

- **Client polling goes through `startVisibleInterval`** (`src/lib/visible-interval.ts`),
  not raw `setInterval`. Hidden tabs skip ticks and catch up on return. Poll
  only while there is something to wait for (a render in flight, a run going);
  idle pollers slow to ≥30s. A forgotten 5s poller on a detail page was ~17k
  router lines/day per tab.
- **Worker logs: one info line per job, about the result.** The worker's logger
  (`src/jobs/worker-logger.ts`) already drops a task's `"<task-id> start…"`
  line and graphile's success line for fast first-attempt jobs, so write the
  result line with numbers and skip per-item / per-iteration `info` inside
  loops (use `debug`). Errors and warnings always pass.
- **Layout-level pollers (on every dashboard page) run at ≥60s**, and state
  that changes a few times a day (credit banners, attention banners) at ≥5 min.
  They multiply by every open tab of every user — at 30–60s they were ~45% of
  all router lines (2026-10-19).
- **Anything on a per-minute timer logs only on change**, or on a sparse
  heartbeat (lock-reconcile: a `clean` line every 15th pass).

## Connection budget

Heroku Postgres Essential-0 = 20 connections. Splits roughly:
- web dyno: postgres.js pool `max: 8` + `WorkerUtils` pool `2` = 10
- worker dyno: pg pool `max: 6` + drizzle `3` + LISTEN `1` = 10

Scaling web past 1 dyno without lowering worker concurrency or upgrading
Postgres will start to hit the cap. Update `docs/automation.md` if you
change pool sizes.

## CI & Dependabot

`.github/workflows/ci.yml` runs one job, **`build`**: `npm ci` → `tsc --noEmit`
→ `npm run test:unit` → `npm run build`, on every PR and every push to `main`.
It needs no secrets (Sentry source-map upload skips itself without
`SENTRY_AUTH_TOKEN`), so Dependabot and fork PRs run it too.

- **Required on `main`** via the repository ruleset *"main: require build"*
  (Settings → Rules). PRs can't merge until `build` is green. Repo admins and
  write collaborators are bypass actors, so direct pushes to `main` still land
  (and deploy) unchecked — the push run is a signal, not a gate. Renaming the
  job renames the check: update the ruleset in the same change.
- **Direct pushes to `main` are typechecked locally first** (`.githooks/pre-push`,
  2026-10-28). `next build` typechecks every `.ts` file, tests included, so a
  bad cast in a test failed two Heroku deploys (builds e2ac24f1 2026-10-21,
  9506006f 2026-10-26). The hook exports the exact commit being pushed to a
  temp dir and runs CI's `tsc --noEmit` on it (~20s), so other sessions'
  uncommitted edits in the shared checkout can't fail or rescue it. Pushes to
  other branches are untouched. `npm install` installs it (`prepare` →
  `scripts/install-git-hooks.mjs` sets `core.hooksPath=.githooks`);
  `git push --no-verify` skips it. Test: `src/app/pre-push-hook.test.ts`.
- **A network blip in the buildpack is not a code bug.** Build 68ffa031
  (2026-10-28) died downloading Node from nodejs.org. Main is linear, so the
  next push redeploys it all; the ops lap CRITs a failed *latest* build, which
  is the case where nothing else will.
- **Unit tests must not touch the DB.** CI has no Postgres. A test that
  imports `@/test/factories` or `db` belongs in `*.integration.test.ts`; a
  DB-backed test in the unit project fails CI with a connection error.
- **The build must not need the internet beyond npm.** No `next/font/google`:
  it downloads every font file from Google mid-build, and one failed fetch
  failed a Heroku deploy (build d9e2de84, 2026-10-23). Fonts come from
  `@fontsource` / `@fontsource-variable` packages imported as CSS (see
  `src/app/layout.tsx`, `beehiiv-preview.tsx`); `src/app/build-offline.test.ts`
  fails on a `next/font/google` import.
- **Lint is not gated** — `main` carries pre-existing eslint errors. Gate it
  once they're cleared.
- **Dependabot** (`.github/dependabot.yml`) opens one grouped weekly PR per
  ecosystem (npm minor+patch, github-actions minor+patch), with a 7-day
  release cooldown on npm version updates. Security updates are grouped too
  and skip the cooldown. Majors come as individual PRs.
- **Auto-merge** (`dependabot-auto-merge.yml`) arms `gh pr merge --auto
  --squash` on grouped, non-major Dependabot PRs. GitHub only merges once
  `build` passes; the merge to `main` then deploys through Heroku's GitHub
  integration like any other push. A red build leaves the PR open for a human.
- **Loop PRs auto-merge** (`loop-auto-merge.yml`, 2026-10-14). Two ways code
  reaches `main`:
  - *Interactive session, Pat asking for a fix* → push straight to `main`.
  - *Autonomous loop* → never pushes `main`. It commits on an `app-loop/<slug>`
    branch and runs `ship web hubandspoke` (the ship broker pushes the branch
    and opens the PR). The workflow arms `gh pr merge --auto --squash` pinned to
    the head SHA; GitHub merges once `build` is green, and the merge deploys.
    Red = the PR stays open. Veto: close it or label it `hold` (disarms).
  It runs on `pull_request_target`, i.e. from `main`'s copy of the file, so a
  PR can't loosen its own gate; it never checks out PR code. Any PR touching
  `.github/` is left for a human, since it could rewrite what `build` checks.
  So is one over 600 changed lines — counted without `drizzle/meta/*.json`
  (drizzle's generated snapshot + journal, ~7k lines per schema change), so a
  loop PR with a migration still merges itself; the `drizzle/*.sql` counts.
- Third-party actions are pinned by commit SHA; Dependabot bumps the pins.

## Shipping a user-facing feature: What's new + usage

- **Tell people.** Add a card at the TOP of `src/lib/whats-new/entries.ts` (newest first, unique
  `<YYYY-MM-DD>-<slug>` id, `shippedAt` = now in ISO). Plain words for editors, not engineers.
  A feature behind a flag or admin-only names it in `audience`, or people who can't use it get the pop-up.
- **Make it measurable.** Routes are tracked automatically (`UsageTracker`). Something that isn't a
  route — a modal, a panel, a button that matters — calls `trackUsage("<area>:<thing>")` from
  `src/lib/usage/track.ts` when it opens, and the card's `screen` names that mark or route pattern,
  so the next look at `usage_events` can say whether it landed.
- `screenFor()` (src/lib/usage/screen.ts) decides what a URL is stored as. A new route param that
  identifies a record must collapse to `[id]` there — never store raw ids or free text.

## End-to-end testing (Playwright)

E2e tests live in `tests/e2e/`. They drive a real Chromium against
`http://localhost:3000` and depend on `npm run dev` being able to come up
cleanly (the runner boots one for you when nothing is on :3000, otherwise
reuses what's there).

**Run:**

- `npm run test:e2e` — headless, normal output
- `npm run test:e2e:ui` — Playwright's interactive UI mode
- `npm run test:e2e:debug` — pauses at every action for inspector debugging

**One-time setup (per dev machine / per fresh DB):**

1. Seed a known test user once:
   ```bash
   node --env-file=.env.local scripts/seed-user.mjs e2e@local.test 'change-me-locally' 'E2E Test'
   ```
2. Add the credentials to `.env.local`:
   ```
   E2E_TEST_USER_EMAIL=e2e@local.test
   E2E_TEST_USER_PASSWORD=change-me-locally
   ```

**How auth works.** `tests/e2e/auth.setup.ts` runs once per `playwright
test` invocation, logs in via the real `/login` form, and writes the
session cookie to `tests/e2e/.auth/user.json`. Every other spec opens a
browser with that storage state attached, so individual tests start
already-authenticated. The `.auth/` directory is gitignored — the cookie
is real.

**Adding a new spec.** Drop a `*.spec.ts` in `tests/e2e/`. Default
`storageState` from the `chromium` project applies. If a spec needs a
fresh-no-auth browser, add
`test.use({ storageState: { cookies: [], origins: [] } })` to the file.

**Local-only for now.** The e2e suite is not wired into CI (see
CI & Dependabot below — CI gates on typecheck, unit tests and build only).
Adding e2e is a follow-up (browser caching, secrets, flake budget).

**Visual verification from Claude Code.** `@playwright/mcp` is registered
in `.mcp.json` as the `playwright` server. From inside Claude Code,
`mcp__playwright__browser_navigate` + `mcp__playwright__browser_snapshot`
let the AI see the page in your dev browser session — useful when
diagnosing UI bugs that need eyeballs (the "black video player" symptom
that motivated this scaffold). The MCP keeps a persistent profile in
`~/Library/Caches/ms-playwright/mcp-chrome-profile/` so logging in once
sticks across sessions.

## LLM eval tests (gated) — `*.eval.test.ts`

When the thing that can break is a **model's judgment** (an eligibility
call, a classification, "did the prompt make the right decision"), a mocked
unit test can't catch the regression — it only asserts the wiring around a
hardcoded answer. For those cases, write a **gated live eval**: a
`*.eval.test.ts` that calls the real model against a small fixture table and
asserts the decision.

**Pattern** (template: `src/lib/clip-hook-agent.eval.test.ts`, which guards
the Splice hook writer against accepting an app-feature demo for the Tech
Stack format):

- Gate the whole suite: `describe.skipIf(!process.env.RUN_LLM_EVALS)(…)`.
- Drive a fixture array of `(input, expectedDecision)` pairs; one `it` per
  fixture. On failure, surface the model's own reason in the assertion
  message (`expect(x, \`model reason: \${reason}\`).toBe(…)`) so prompt
  iteration is fast.
- Inline the relevant prompt inputs (skill text, etc.) so the eval is
  hermetic — it validates the prompt+skill *design*, not whatever is in the
  dev DB.
- Make the agent accept an injectable `client?: Anthropic` (see
  `services/draft-algorithm/derivative-hook.ts`) so the *deterministic*
  wiring tests in the sibling `*.test.ts` can mock responses, while the eval
  calls the real client.

**Running.** `npm run test:eval` (sets `RUN_LLM_EVALS=1`, needs
`ANTHROPIC_API_KEY` in `.env.local`). Evals are **excluded** from
`npm run test` / CI — they cost money and are non-deterministic. The `eval`
vitest project (`vitest.config.ts`) carries a longer `testTimeout`. Run
them by hand whenever you touch the prompt they guard, and re-run a couple
of times to confirm the decision is stable, not a coin-flip.

## Format templates (design editor / clip editor)

- A format's design is data, not code: `formats.design_template` (a `DesignDoc` with `slot`/`stack` on elements — `src/lib/design-editor/doc.ts`). To change how a format's posts look, edit the template on the format page; do not add format-specific layout code.
- Presets in `src/lib/design-editor/templates.ts` are starting points and the fallback for a format with no stored template. A preset is a function returning a slotted `DesignDoc` with REAL sample content (the sample is the AI's style example). Keep every element the editor can produce (no hidden template-only fields).
- New slot kinds go in `SLOT_KINDS` (doc.ts) + `fillElement` (template-fill.ts) + the inspector's `SLOT_OPTIONS`. Prefer a system slot filled from the item over asking the AI for something we already know. Picture slots: `photo` = the filmstrip's cover pick (every photo slot shows the same founder shot); `frame` = a different still per slot, in library order (`storyFrames`: runner-up shots first, then the filmstrip by time, the cover pick left out) — for story slides that each want their own picture; `cutout` = the founder cut out of the cover pick (background removed in the browser — `cutout-client.ts`; the box is reshaped to the cutout's aspect and bottom-aligned, `fitCutoutBox`); `screen` = the best dashboard / revenue screenshot the `design-screens` scan found (dropped when there is none). Photo, frame and cutout slots fall back to the placeholder until their picture lands, and `applyPhotoPick` fills them then.
- **Stat cards:** a `statCard` element (`statCard()` in shared.ts) is the "Revenue · $160,324 · Last 28 days" tile with a chart. With an `ai` slot it is THREE text slots to the model (`statCardSlotKey(id, "label"|"value"|"sub")`); the value is required (no number → no card), the chart is `defaultSeries(value)` — a shape, not data; never present it as real. Any element except video/captions may have `rotation` (degrees) — the hero cover tilts the card -6°.
- **Arrows:** an `arrow` element is a box + rotation like everything else (shaft along the box's centre line, tail left, head right; `bend` = fraction of the length, + bulges left of travel). Build one from its ends with `arrow(tail, head, …)` (shared.ts) / `arrowFromEnds` — never hand-compute the box; the editor's handles, the importer and the exporter all go through arrow.ts, and both renderers draw `arrowSvg`.
- **Groups:** `group` on an element (any string, page-scoped) makes members select and move together; the export ignores it. Selection carries `groupId` when the whole group is selected. A duplicate leaves its group; new group ids come from `newElementId("grp")`.
- **The hero cover** (`hero-cover-template.ts`) is the reference composition: backdrop photo slot (zoomed, dimmed by a rect) → tilted stat card → cutout slot → shade → headline / footer / wordmark, in that z-order so the founder overlaps the card. Reuse it (`buildHeroCover(canvas)`) rather than hand-building another; the `playbook-hero` preset and the editor's "Hero cover" action both come from it.
- **Optional pages:** a template page with at least one AI text slot whose AI text ALL comes back empty is dropped from the post (`fillTemplate`). That is how a carousel gets a variable length — build the template with the MAXIMUM number of pages (9 story beats, 5 apps) and say in the later slots' hints "Leave EMPTY if…". A page with no AI text (a static closer, a CTA) is always kept.
- **Canvas sizes:** square (`IG_SQUARE`, 1080×1080) is the default and what almost every format uses; TMZ is the vertical one (`IG_PORTRAIT`, 4:5). The canvas is per document and nothing downstream assumes a square (`reflowStacks` and the renderers read `doc.canvas`); the ⋯ menu's **Canvas size** switches a document or template between square / 4:5 / 9:16 / 16:9 via `resizeCanvas` (every box stretched by the canvas's growth, text sizes untouched). Add new sizes to `CANVAS_SIZES` in doc.ts.
- **Model a preset on real posts, and check it against them:** pull the format's top published posts' slides (`production_item_media`), build the preset with a real post's content as the sample, then `npx tsx --env-file=.env.local scripts/design-preview.ts <preset> <outDir> [founder.jpg]` rasterizes every page to PNG without the worker or S3 — put the result next to the real slides before shipping. Then draft a real candidate (`POST /api/design/from-candidate` locally with `scripts/design-run-frames.ts` run first for the pillar) and look at the filled pages too: the AI's text is where a template fails in practice (room, tone, optional pages).
- **Cover styles are templates too:** `design_cover_styles.doc` is a one-page slotted DesignDoc read from a PUBLISHED cover by Opus vision (`src/lib/services/design-editor/cover-styles.ts`, through the PDF importer's `build_template` tool + `normalizeImportedTemplate`). Anything the importer can describe (statCard, arrow, cutout / screen / wordmark slots, rotation) a style can carry — extend the tool + normalizer in `src/lib/design-editor/pdf-import.ts`, never a second describer. Check a prompt change with `scripts/design-style-preview.ts <publishedItemId> <outDir> photo.jpg cutout.png --force` against the format's top covers before shipping it, and bump `COVER_STYLE_READER_VERSION` when the change should reach styles already read (they re-read once on their next click).
- Video formats: the format's look is `formats.clip_template` (`clipLookSchema`); it never contains cuts. Apply with `applyLook`, capture with `lookFromDoc`.

## Cached reports (`unstable_cache`)

Expensive read-only payloads that the UI fetches on every mount (the production
and content reports, the three queue candidate lists) are wrapped in
`unstable_cache` with a short `revalidate` (60–120s) and a tag, in a
`*-cached.ts` module next to the service (`src/lib/services/production-report.ts`,
`src/lib/db/queries-cached.ts`, `src/lib/services/queue-candidates-cached.ts`).
Rules:

- **One cache entry per payload**, in one module — the API route, SSR and
  `/api/warm` must all call the SAME wrapper or they populate different keys.
- **Every write that changes the answer invalidates the tag** through
  `src/lib/invalidate-report-caches.ts` (`invalidateReportCaches()` covers the
  reports AND the queue lists; `invalidateQueueCaches()` just the lists). Grep
  for the existing call sites when adding a route that promotes, dismisses or
  kills an item.
- **Post-action refetches ask for `?fresh=1`.** The route then calls the
  uncached function AND invalidates the tag, so the user who acted sees the
  result immediately and the next plain load recomputes. Mount fetches stay on
  the cached path.
- Keep an entry under Next's 2 MB `unstable_cache` ceiling (the production
  report is ~1 MB).

