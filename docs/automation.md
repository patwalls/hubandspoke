# Backend Automation

Source of truth for everything that runs in the background: cron sweeps,
per-item worker tasks, on-demand jobs, and the rules they obey. When you
add or change anything in `src/jobs/` or `src/lib/services/`, update the
matching section here in the same PR.

If you're new to this codebase, read in this order:
1. [At-a-glance graph](#at-a-glance-graph) — what runs when, what triggers what
2. The [lifecycle views](#post-lifecycle) — what happens to a post / account / transcript end-to-end
3. The [operational rules](#operational-rules) — the implicit invariants every task obeys

---

## At-a-glance graph

```
CRON ENTRIES (src/jobs/crontab.ts, UTC)
  *:00  performance-decay         → SC API. Writes views/likes/comments. Decay-tier-gated.
  *:15  threshold-monitor-sweep   → in-place scan. Auto-creates repurposed Idea items when views cross format thresholds.
  *:20  enrichment-sweep          → fan-out → enrich-item (per item) → maybe transcribe-whisper
  *:30  notion-sync               → Notion API ⇄ productionItems (YouTube long-form authoritative)
  *:40  hook-extract-sweep        → fan-out → extract-hook (per item, Haiku)
  *:50  hook-fallback-sweep       → fan-out → hook-fallback (per item, no LLM)
  */20  youtube-download-sweep    → fan-out → youtube-download → transcribe-whisper
  */30  account-content-sync-sweep → fan-out → account-content-sync (per active SC account, latest mode)
  15:00 evergreen-scan            → AI classifier + Idea-queue refill
  (per-post) capture-velocity-snapshot → scheduled at publish+{15m,30m,1h,2h,4h,8h,24h,48h} per item; writes one view_snapshots row each
  (manual)     cross-post-scan    → LLM recommender, fired by the "Populate queue" button on /[brand]/queue → POST /api/cross-post-scan
  Mon 17:00  account-refresh-sweep → fan-out → account-refresh (per account)

USER / API ENTRY POINTS
  POST /api/accounts/[id]/refresh?mode=async              → account-refresh
  POST /api/accounts/[id]/sync-content?mode=latest|backfill → account-content-sync
  POST /api/accounts (new account row)                    → account-content-sync (backfill) + account-refresh
  POST /api/production-items/[id]/transcript/fetch        → transcribe-whisper
  POST /api/uploads/confirm                               → transcribe-whisper
  POST /api/descript/clip-out                             → descript-clip-resolve
  POST /api/clip-ideas/[id]/create-in-descript            → descript-clip-resolve
  POST /api/clip-ideas/[id]/create-in-descript-precise    → clip-idea-precise-cut
  POST /api/production-items (new row w/ link, no inline metrics) → refresh-item-metrics
  PUT  /api/production-items (→ Published w/ link, or link added on Published) → refresh-item-metrics
  POST /api/production-items, /comments, /clip-ideas/triage  → notification-send

AUTO-CHAINS (one task enqueues another)
  enrich-item        ── if updates.mediaS3Key set ─→ transcribe-whisper
  youtube-download   ── on success ────────────────→ transcribe-whisper
  enqueueNotification() ───────────────────────────→ notification-send
```

All cron entries are graphile-worker crontab — no Heroku Scheduler. Worker
dyno picks up new schedules on release-phase restart.

---

## Spec format

For each task below: **Trigger · Files · Inputs · Outputs · Downstream · Rules**.

---

## Cron sweeps

### `performance-decay` — refresh metrics
- **Trigger:** cron `0 * * * *` (every hour at :00)
- **Files:** `src/jobs/tasks/scheduled.ts:41`, `src/lib/services/performance-decay.ts`, `src/app/api/cron/performance-sync/route.ts`
- **Inputs:** every published `productionItems` row with a `publishedDate`
- **Outputs:** `productionItems.views`, `likes`, `comments`, `clicks`, `leads`, `salesNum`, `salesAmount`, `lastPerformanceSyncAt`. Calls Scrape Creators (~1 credit/item/platform).
- **Downstream:** none
- **Rules:**
  - Decay tier gates frequency: fresh (< 24h) every hour, archived (180d+) ~monthly
  - Skips items with no `publishedDate`
  - View estimator (`view-estimator.ts`) fills `views` from `likes` when SC returns incomplete data

### `threshold-monitor-sweep` — auto-create repurposed items
- **Trigger:** cron `15 * * * *` (every hour at :15)
- **Files:** `src/jobs/tasks/threshold-monitor-sweep.ts`
- **Inputs:** every published `productionItems` row with `views > 0` and a `format`; all `formats` rows (parent→child tree); existing `repurposeTriggers` (for dedup)
- **Outputs:** new `productionItems` rows with `sourceType='repurposed'`, `pillarContentItemId=parent.id`, `status='Idea'` (inherits brand, title, thumbnail from parent); paired `repurposeTriggers` row (sourceFormatId, targetFormatId, viewsAtTrigger)
- **Downstream:** none directly — the new `Idea` row enters the normal post lifecycle and may itself be picked up by enrichment / metrics / hook sweeps once published
- **Rules:**
  - **In-place scan**, not a fan-out — does the work directly because it's pure DB and cheap
  - Dedup key = `(productionItemId, sourceFormatId, targetFormatId)`. Once a trigger row exists for that triple, that target is never re-created for that parent (even if views drop and recover later).
  - Skips child formats with no `viewThreshold` set
  - **Account pick is deterministic**: when the target format has multiple `formatChannels` rows, picks the oldest-added one (`ORDER BY created_at, id ASC LIMIT 1`). Fan-out-to-all-channels is a deliberate non-feature — one repurposed Idea per (parent, source, target) triple regardless of how many channels the target format publishes to.
  - Resolves producer/editor for the new item via `resolveAssignees()` chain
  - This task **replaces the Asana-based `/api/trigger-repurpose` flow** — same intent, different implementation. No external systems.

### `notion-sync` — Notion ⇄ DB
- **Trigger:** cron `30 * * * *` (every hour at :30)
- **Files:** `src/jobs/tasks/scheduled.ts:44`, `src/lib/services/notion-sync.ts`, `src/app/api/cron/notion-sync/route.ts`
- **Inputs:** Notion database `8cb6cee4163d4282a5c87991ea689bde`
- **Outputs:** upserts to `productionItems`; pushes back status / pillar / utm_campaign to Notion; row in `syncLogs`
- **Downstream:** none
- **Rules:**
  - **Notion is authoritative only for YouTube long-form** — gated by `accounts.syncedFromNotion`. Other platforms are Hub & Spoke-owned.
  - Maps Notion "Channel" labels to seeded YouTube accounts; remaps legacy "Twitter" → "X"
  - Skips internal Starter Story / Pat Walls handles
  - Resolves producer/editor via Notion user ID → `users.notionUserId` → format defaults → brand defaults

### `enrichment-sweep` — fan-out parent
- **Trigger:** cron `20 * * * *` (every hour at :20)
- **Files:** `src/jobs/tasks/scheduled.ts:51-67`, `src/lib/services/enrichment/orchestrator.ts:27-50` (`selectEnrichmentCandidates`)
- **Inputs:** `productionItems` where `status='Published' AND enrichment_completed_at IS NULL AND (enrichment_attempts < 5 OR updated_at < now()-24h)`, ordered by attempts asc, updated_at asc, limit 50
- **Outputs:** enqueues one `enrich-item` job per candidate with `jobKey: enrich-{id}` (`unsafe_dedupe`)
- **Downstream:** `enrich-item`
- **Rules:**
  - Dedupe across overlapping ticks via jobKey
  - Per-item retry caps lives in [`enrich-item`](#enrich-item--enrich-one-item)

### `hook-extract-sweep` — fan-out parent (LLM)
- **Trigger:** cron `40 * * * *` (every hour at :40)
- **Files:** `src/jobs/tasks/scheduled.ts:74-88`, `src/lib/services/hook-extract/orchestrator.ts` (`selectHookCandidates`)
- **Inputs:** published short-form items (YouTube Shorts, IG Reels, TikTok, Threads short) with a transcript and no `hookExtractedAt`. Requires transcript ≥5s + ≥3 words. Ordered by views DESC.
- **Outputs:** enqueues one `extract-hook` job per candidate, `jobKey: extract-hook-{id}`
- **Downstream:** `extract-hook`
- **Rules:** kept separate from `enrichment-sweep` so LLM-gated retries don't share error columns with SC-gated retries

### `hook-fallback-sweep` — fan-out parent (no LLM)
- **Trigger:** cron `50 * * * *` (every hour at :50)
- **Files:** `src/jobs/tasks/scheduled.ts:96-110`, `src/lib/services/hook-extract/fallback.ts` (`selectHookFallbackCandidates`, `applyFallbackHookForItem`)
- **Inputs:** published items the LLM sweep doesn't cover — long-form YouTube, tweets, LinkedIn, IG posts, newsletters — plus short-form rows with no transcript
- **Outputs:** enqueues one `hook-fallback` job per candidate, `jobKey: hook-fallback-{id}`
- **Downstream:** `hook-fallback`
- **Rules:**
  - Cheap (pure DB), so the per-sweep batch can be large
  - **Will never override an LLM/manual/clip-idea hook** — gated on `hookExtractedAt IS NULL`

### `youtube-download-sweep` — fan-out parent
- **Trigger:** cron `*/20 * * * *` (every 20 min)
- **Files:** `src/jobs/tasks/youtube-download-sweep.ts`
- **Inputs:** `productionItems` where `status='Published' AND youtubeId IS NOT NULL AND mediaS3Key IS NULL AND youtubeDownloadAttempts < 5`, ordered by `publishedDate` DESC, limit 50
- **Outputs:** enqueues one `youtube-download` job per candidate, `jobKey: yt-dl-{id}`, `maxAttempts: 2` (deterministic failures don't deserve graphile's default 25)
- **Downstream:** `youtube-download` → `transcribe-whisper`
- **Rules:**
  - `MAX_ATTEMPTS = 5` defined locally (`youtube-download-sweep.ts:14`); same constant duplicated in `enrichment/orchestrator.ts:20`
  - Sweep gate paces retries; dyno-level maxAttempts only retries the same tick

### `account-content-sync-sweep` — per-account content fan-out (every 30 min)
- **Trigger:** cron `*/30 * * * *` (every 30 minutes)
- **Cost:** 22 SC credits per sweep at current volume (3 IG + 3 LinkedIn + 2 Threads + 3 TikTok + 3 X + 4 YouTube × 2 endpoints). 48 sweeps/day → ~1,056 SC calls/day. Tunable via `CRONTAB` in `src/jobs/crontab.ts`.
- **Files:** `src/jobs/tasks/scheduled.ts` (`accountContentSyncSweepTask`)
- **Inputs:** every active `accounts` row on an SC-supported platform
  (`youtube, instagram, tiktok, linkedin, x, threads`)
- **Outputs:** enqueues one `account-content-sync` per row with `mode=latest`, `jobKey: account-content-sync-{id}-latest`
- **Downstream:** `account-content-sync`
- **Rules:**
  - Replaces the old MATG-only `matg-sync` cron. MATG handles are just
    regular account rows now — no special-casing.
  - Skips platforms with no SC content-list coverage (`newsletter`, `other`)
  - `x` and `threads` are enqueued but always in `latest` mode (neither
    platform's SC endpoint paginates)
  - Sweeps use jobKey + `unsafe_dedupe` so overlapping ticks don't
    double-enqueue a pending account

### `account-content-sync` — sync one account's content
- **Trigger:** enqueued by `account-content-sync-sweep`; on-demand
  `POST /api/accounts/[id]/sync-content?mode=latest|backfill`; auto-enqueued
  (with `mode=backfill`, `maxPages=50`) by `POST /api/accounts` on account
  create
- **Files:** `src/jobs/tasks/account-content-sync.ts`,
  `src/lib/services/account-content-sync.ts`,
  `src/app/api/accounts/[id]/sync-content/route.ts`
- **Inputs:** `{ accountId, mode: "latest" | "backfill", maxPages?, sinceIso? }`
- **Outputs:** upserts to `productionItems` keyed on
  `(account_id, platform_content_id)` via the partial unique index
  `uniq_production_items_account_platform_content_id`. Stamps
  `accounts.lastContentSyncAt` on success, `lastContentSyncError` on
  failure. Writes `syncLogs` with `sync_type=account-content-sync:<platform>`.
- **Downstream:** none directly — the newly-synced items enter the normal
  enrichment / hook / transcript lifecycle on the next sweep
- **Per-platform pagination:**
  - YouTube long → `continuationToken` (full catalog)
  - YouTube Shorts → `/v1/youtube/channel/shorts` for latest,
    `/v1/youtube/channel/shorts/simple` for backfill (SC handles pagination
    internally; costs more credits). Both endpoints 404 on channels with
    no Shorts feed (common for long-form-only podcasts) — we soft-fail and
    return empty so the long-form pass still upserts.
  - Instagram → `next_max_id` until `more_available=false`
  - TikTok → `max_cursor` until `has_more=false`
  - LinkedIn → `page=1..7` (LinkedIn caps at 7 pages)
  - X → no cursor; SC returns top 100 by engagement, not chronological
  - Threads → no cursor; platform exposes only ~20–30 recent posts
- **Cost envelope:** 1 SC credit per page. `maxPages` defaults to 1 for
  `latest`, 50 for `backfill`. A new YouTube account auto-backfill costs
  ≤ ~100 credits (long + shorts).
- **Dedup priority** (inside `loadExisting`):
  1. Match by `(accountId, platform_content_id)` — primary
  2. For legacy rows missing the column, derive id on the fly from
     `publishedLink` via `extractContentId` in `src/lib/platform-url.ts`
     and match against the same map. Manual "Add from link" rows that
     skipped populating the column still merge correctly.
  3. Loose URL fallback (strip query string, fold `threads.com` →
     `threads.net`, drop trailing slash) — only for URLs we can't parse
     into an id at all (custom shortlinks, etc.)
  4. Otherwise insert
  - Manual writes (`POST/PUT /api/production-items`) call
    `extractContentId` too, so freshly created rows always carry the
    column even when the user paste contains tracking params or a
    `threads.com` domain.
- **Threads reply filter:** the user-timeline endpoint mixes top-level
  posts and replies. Sync calls `isThreadsReply` and skips any post whose
  `is_reply` / `reply_to_author` / `reply_to_id` / `parent_pk` markers are
  set, so reply-with-CTA chains never enter analytics. Reply markers are
  defensive across SC response shapes; first sync logs counts for
  verification.
- **Timestamps:** captures the platform-reported publish moment into
  `productionItems.publishedAt` (YouTube `publishedTime`, IG `taken_at`, X
  `legacy.created_at`, TikTok `create_time`) so the content view can sort
  same-day posts by true publish order. Falls back to null when the
  response lacks a timestamp.
- **Errors:** any thrown error stamps `lastContentSyncError` and re-throws
  so graphile-worker retries with backoff.

### `evergreen-scan` — daily classifier
- **Trigger:** cron `0 15 * * *` (daily 15:00 UTC)
- **Files:** `src/jobs/tasks/scheduled.ts:112`, `src/lib/services/evergreen-scan.ts`, manual: `scripts/run-evergreen-scan.ts`
- **Inputs:** published items with ≥10,000 views, per-platform age gates (Twitter 365d+, Instagram 90d+, etc.); existing `contentEvents` (past kill reasons)
- **Outputs:** `productionItems.isEvergreen`; new `contentEvents` rows for Idea-queue suggestions
- **Downstream:** none directly; downstream is the human triage flow
- **Rules:**
  - Phase A: stratified-batch classify per platform (quota)
  - Phase B: refill Idea queue, respect 30d repost spacing + hard-kill suppression
  - Cap: 10 pending suggestions in queue

### `capture-velocity-snapshot` — per-post scheduled velocity snapshots

Measures how fast each Published original is growing by taking up to **five** Scrape-Creators view-count snapshots at fixed post ages (15m, 30m, 1h, 2h, 4h). The cross-post scanner reads those snapshots to decide which posts are "taking off."

**Why this design.** Earlier iterations used a blanket `*/15` cron (`fresh-metrics-sync`) that hit SC for every item <72h old on every sweep — ~4,800 SC calls/day. That was both expensive and produced inconsistent data (a snapshot at age 14h tagged nothing meaningful). The per-post scheduled design fires exactly 5 SC calls per post, each aligned to a known age, yielding clean comparable data across items.

#### Data model

`view_snapshots` table (`src/lib/db/schema.ts`):

| Column | Notes |
|---|---|
| `id` | bigserial PK |
| `production_item_id` | FK → `production_items.id`, cascade-delete |
| `views`, `likes`, `comments` | point-in-time counters. CHECK: `views >= 0`. |
| `taken_at` | when this row was written |
| `post_age_minutes` | actual age (in minutes) when snapshot was taken. Informational; may differ from checkpoint target by a few minutes due to worker dispatch latency. CHECK: `>= 0`. |
| `checkpoint_key` | one of `'15m' \| '30m' \| '1h' \| '2h' \| '4h'`. **Authoritative** identifier for which checkpoint this snapshot represents. CHECK constraint enforced at the DB. |

**Invariants** (enforced at the DB):
- `checkpoint_key` is non-null and one of the 5 valid keys.
- `UNIQUE (production_item_id, checkpoint_key)` — no item has two snapshots for the same checkpoint.
- `post_age_minutes >= 0`, `views >= 0`.

The **checkpoint configuration** lives in `src/lib/velocity-checkpoints.ts` and is the single source of truth for timing. Each entry is `{key, offsetMinutes, windowMin, windowMax}`:

| Key | Target age | Acceptance window | Gap to next |
|---|---:|---|---:|
| `15m` | 15 min | 9–22 | 1 min |
| `30m` | 30 min | 23–45 | 1 min |
| `1h` | 60 min | 46–90 | 10 min |
| `2h` | 120 min | 100–179 | 36 min |
| `4h` | 240 min | 215–300 | 2 h |
| `8h` | 8 h | 7–12 h | 8 h |
| `24h` | 24 h | 20–36 h | 4 h |
| `48h` | 48 h | 40–72 h | — |

Windows are **non-overlapping** by design — any age maps to at most one checkpoint. Adjacent gaps are intentional and get rejected by the window check (indicates a job fired out of band).

#### Lifecycle of one snapshot

```
Item becomes Published
   │
   ▼
scheduleVelocitySnapshots(itemId, publishedAt)   // src/jobs/tasks/capture-velocity-snapshot.ts
   │  ┌── SELECT already-captured checkpoints for this item
   │  │     → skip those                         (skippedCaptured++)
   │  ├── For each remaining checkpoint:
   │  │     if now > publishedAt + windowMax:     (skippedPast++)
   │  │       skip — window closed
   │  │     else:
   │  │       runAt = max(target, now + 5s)      // fire immediately if target past but window open
   │  │       enqueue with jobKey `velocity-<id>-<cp>`   (scheduled++)
   │
   ▼  … runAt elapses, worker picks up job …
captureVelocitySnapshotTask({ productionItemId, checkpointKey })
   │  ┌── validate checkpointKey is a known key  (throw otherwise)
   │  ├── SELECT item by id
   │  │     missing / deleted       → log info, return (no SC call)
   │  │     status !== 'Published'  → log info, return
   │  │     publishedAt null        → log warn, return
   │  ├── SELECT any existing snapshot for (item, checkpoint)
   │  │     already captured        → log info, return (no SC call)
   │  ├── compute age = now - publishedAt
   │  │     age outside window      → log warn, return (no SC call)
   │  ├── refreshItemMetrics(itemId)                            → 1 SC call
   │  │     refresh failed / returned null views → log info, return
   │  ├── INSERT into view_snapshots (views, age, checkpoint_key)
   │  │     unique-key violation caught → log info, return
   │  └── success
```

#### Edge cases and guards

| Scenario | What happens |
|---|---|
| `publishedAt` is null at schedule time | `scheduleVelocitySnapshots` returns early; 0 jobs enqueued |
| `publishedAt` is a string we can't parse | Same — returns early |
| `publishedAt` is in the far past (4h+) | All 5 checkpoint windows already closed; 0 jobs enqueued; `skippedPast = 5` |
| Item re-synced 30 min after publish | 15m window closed → skipped; 30m/1h/2h/4h scheduled. If 30m already captured (prior run), `skippedCaptured` increments instead |
| Item discovered by sync at age 18m | 15m's target was 3 min ago but its window [9, 22] is still open → fire immediately at `now + 5s`; on execution, age ≈ 18, passes the window check, snapshot written |
| Item's `publishedAt` corrected by a later SC sync | `scheduleVelocitySnapshots` called again via `account-content-sync` UPDATE branch. jobKey `replace` updates `runAt` on still-pending jobs to the corrected time. Already-fired jobs are not re-run |
| Item deleted between schedule and fire | Task's `deletedAt` guard skips; no SC call |
| Item un-published between schedule and fire | Task's `status !== 'Published'` guard skips; no SC call |
| Job retries past its window (rare) | Task's age-within-window guard rejects; no SC call; no misleading row |
| `published_at` was rewritten between schedule and fire (e.g. account-content-sync briefly null'd it then a later sweep stamped a fresh value) | Task's stale-publishedAt guard rejects: if the item has been known to our app (`created_at`) for materially longer than the checkpoint's target age (+ 1h grace), it cannot plausibly be at this checkpoint right now. No SC call, no row written. The scheduler applies the same gate up-front to skip enqueueing in the first place. |
| Two jobs race to write the same (item, cp) | DB unique index rejects the second; task catches `duplicate key` and logs; no crash |
| Platform returns no view signal (LinkedIn with no likes yet) | Task logs "no-snapshot"; no row written; 1 SC credit spent |
| Invalid `checkpointKey` in payload | Task throws up-front; graphile-worker marks the job failed; no DB work done |

#### Cost

- **Per post:** up to 8 SC calls if every checkpoint lands in its window (early ones within hours of publish, late ones over 2 days). Fewer for late-discovered posts (whichever windows are still open).
- **At current volume** (~17 Published originals/day): ~136 SC calls/day for velocity data (≤8 × 17). Still ~35× cheaper than the old `fresh-metrics-sync` design (~4,800/day).
- Baseline `performance-decay` runs on the existing tiered cadence (hourly for <24h, 6h for 1–7d, etc.) independent of this.

#### Enqueue callsites

| File | Branch | `publishedAt` source |
|---|---|---|
| `src/lib/services/account-content-sync.ts` | INSERT (new post discovered) | SC-reported timestamp |
| `src/lib/services/account-content-sync.ts` | UPDATE (existing post re-synced) | SC-reported timestamp; corrects earlier wrong stamps |
| `src/app/api/production-items/route.ts` | POST (add-from-link) | body `publishedAt` (from SC preview) or `new Date()` |
| `src/app/api/production-items/route.ts` | PUT (status → Published OR link added on Published) | existing `publishedAt`, or stamped `new Date()` on fresh transition |

#### Testing

Full test suite (`src/lib/velocity-checkpoints.test.ts` + `src/jobs/tasks/capture-velocity-snapshot.integration.test.ts`) covers every edge case above. Run:
```
npm run test              # both unit + integration
npm run test:unit         # unit only
npm run test:integration  # hits DATABASE_URL from .env.local
```
Integration tests mock `refreshItemMetrics` (no SC credits spent) and the `enqueue` helper (no real worker jobs created). Disposable production_items fixtures are cleaned up per-test.

#### Troubleshooting

```sql
-- How many snapshots and of what kind exist right now?
SELECT checkpoint_key, count(*) AS rows,
       min(post_age_minutes) AS min_age, max(post_age_minutes) AS max_age
FROM view_snapshots GROUP BY 1 ORDER BY 1;

-- Pending velocity jobs (should be 0-5 × recent-Published-items)
SELECT key, run_at, attempts, last_error
FROM graphile_worker.jobs
WHERE task_identifier = 'capture-velocity-snapshot'
ORDER BY run_at LIMIT 20;

-- Any items failing repeatedly? (attempts >= 1 is a red flag; the task
-- shouldn't normally throw)
SELECT key, attempts, last_error
FROM graphile_worker.jobs
WHERE task_identifier = 'capture-velocity-snapshot' AND attempts >= 1;

-- Recent Published originals that got no velocity data at all
-- (likely null publishedAt or platform returned no views)
SELECT pi.id, pi.title, pi.published_at
FROM production_items pi
LEFT JOIN view_snapshots vs ON vs.production_item_id = pi.id
WHERE pi.status = 'Published'
  AND pi.source_type = 'original'
  AND pi.deleted_at IS NULL
  AND pi.published_at > now() - interval '6 hours'
GROUP BY pi.id, pi.title, pi.published_at
HAVING count(vs.id) = 0
ORDER BY pi.published_at DESC;
```

### `cross-post-scan` — velocity-gated cross-post recommendations
- **Trigger:** **manual only.** Operator clicks "Populate queue" on the Cross-post tab of `/[brand]/queue`, which POSTs to `/api/cross-post-scan` with `{ maxIdeas: 10, maxCandidates: 20 }`. Not on cron — the graphile-worker task is still registered for ad-hoc enqueues but nothing fires it automatically.
- **Files:** `src/app/api/cross-post-scan/route.ts` (entry), `src/jobs/tasks/scheduled.ts` (task wrapper), `src/lib/services/cross-post-scan.ts`, `src/lib/services/cross-post-recommend.ts`, `src/lib/cross-post-compat.ts`
- **Inputs:** published originals <72h old with a ~1h `view_snapshots` row; `cross_post_decisions` (48h dedup); recent `contentEvents` of type `killed`/`accepted` on cross-posts (feedback loop)
- **Outputs:** `cross_post_decisions` (one row per LLM proposal); `productionItems` (new `Idea` rows with `cross_post_confidence` for proposals admitted to the queue)
- **Downstream:** operator accepts/kills via the cross-post feed → `contentEvents` + mirrored `cross_post_decisions.outcome`
- **Rules:**
  - **Velocity gate:** `views_at_1h >= 2.0× median for this account+post_type over last 30 days`; cohort <5 items skips the rule
  - **Format compat:** hardcoded matrix in `src/lib/cross-post-compat.ts` filters candidate targets (tweet→LI/Threads/YT-community, reel→TikTok/YT-Shorts, etc.); LLM never sees incompatible pairs
  - **LLM proposes 0-N targets per candidate** with a 0-100 confidence and written reasoning. Past kill + accept reasons are injected into the system prompt.
  - **Queue discipline:** only admit Ideas with confidence ≥70; cap un-actioned cross-post Ideas at 12 per brand
  - **48h dedup:** skip candidates already proposed within the window
  - **Notion authority:** target post types owned by Notion are skipped (can't auto-create there)

### `account-refresh-sweep` — weekly metadata refresh
- **Trigger:** cron `0 17 * * 1` (Mondays 17:00 UTC)
- **Files:** `src/jobs/tasks/scheduled.ts:125-147`
- **Inputs:** active `accounts` on SC-supported platforms (`youtube, instagram, x, tiktok, linkedin, threads`)
- **Outputs:** enqueues one `account-refresh` job per account, `jobKey: account-refresh-{id}`
- **Downstream:** `account-refresh`
- **Rules:** explicitly skips `newsletter` and `other` (no SC coverage)

---

## Per-item child tasks

### `enrich-item` — enrich one item
- **Trigger:** enqueued by `enrichment-sweep`; on-demand `GET /api/cron/enrichment-sweep?itemId=<id>` (runs inline, doesn't enqueue); on-demand `POST /api/production-items/[id]/enrich`
- **Files:** `src/jobs/tasks/enrich-item.ts`, `src/lib/services/enrichment/orchestrator.ts:61-124` (`enrichSingleItem`), platform enrichers in `src/lib/services/enrichment/{instagram,youtube,youtube-community,twitter,threads,linkedin,tiktok}.ts`
- **Inputs:** `{ productionItemId, force?, withMedia? }`
- **Outputs:** writes per-platform enriched fields (caption, author, like counts, media URLs); on success stamps `enrichmentCompletedAt`, clears `enrichmentError`, increments `enrichmentAttempts`. On failure: increments `enrichmentAttempts`, writes `enrichmentError` (1000-char cap), throws.
- **Downstream:** **if `result.updates.mediaS3Key` was set**, enqueues `transcribe-whisper` via `maybeEnqueueWhisperTranscribe()` (`enrichment/orchestrator.ts`)
- **Rules:**
  - Idempotent on `enrichmentCompletedAt` (skips unless `force=true`)
  - Returns `null` if no enricher matches the platform — sweep treats that as a no-op
  - `withMedia=true` (Instagram only) also archives the raw video to S3 (10 SC credits vs ~2)

### `extract-hook` — Haiku hook extraction
- **Trigger:** enqueued by `hook-extract-sweep`
- **Files:** `src/jobs/tasks/extract-hook.ts`, `src/lib/services/hook-extract/orchestrator.ts`
- **Inputs:** `{ productionItemId }`
- **Outputs:** `productionItems.hook` (verbatim opening line), `hookExtractedAt`, `hookSource='haiku'`
- **Downstream:** none
- **Rules:**
  - Feeds only the opening 20s of the transcript to Haiku
  - **Substring-match validation** rejects hallucinated rewordings (normalize whitespace + case)
  - ~$0.0005 per item

### `hook-fallback` — fill hooks without LLM
- **Trigger:** enqueued by `hook-fallback-sweep`
- **Files:** `src/jobs/tasks/hook-fallback.ts`, `src/lib/services/hook-extract/fallback.ts` (`applyFallbackHookForItem`)
- **Inputs:** `{ productionItemId }`
- **Outputs:** `productionItems.hook`, `hookExtractedAt`, `hookSource` (whatever the fallback chose: title, body opening, etc.)
- **Downstream:** none
- **Rules:** never overrides an existing hook — checks `hookExtractedAt IS NULL` at the top

### `youtube-download` — yt-dlp → S3 archive
- **Trigger:** enqueued by `youtube-download-sweep`; manual `POST /api/cron/tick?name=youtube-download-sweep`
- **Files:** `src/jobs/tasks/youtube-download.ts`
- **Inputs:** `{ productionItemId, force? }`
- **Outputs:** `productionItems.mediaS3Bucket`, `mediaS3Key`, `mediaS3UploadedAt`, `mediaSizeBytes`, `mediaContentType='video/mp4'`, `youtubeDownloadSource='yt-dlp'`, `youtubeDownloadAttempts++`, clears `youtubeDownloadError`
- **Downstream:** on success enqueues `transcribe-whisper` via `maybeEnqueueWhisperTranscribe`
- **Rules:**
  - Tries 3 player-client strategies in order (web → embedded → mobile)
  - ffmpeg merges video + audio, prefers H.264
  - Uses `YT_DLP_COOKIES` env (Netscape format) if set — needed for age-gated content
  - 20-min timeout per download
  - Skips if `mediaS3Key` set (unless `force=true`)
  - Errors truncated to 500 chars in `youtubeDownloadError`

### `refresh-item-metrics` — on-demand per-item metrics pull
- **Trigger:** enqueued by `POST /api/production-items` when a new row has a `publishedLink` and no inline metrics; enqueued by `PUT /api/production-items` when a row flips to `status='Published'` with a link, or when `publishedLink` is freshly added/changed on an already-Published row
- **Files:** `src/jobs/tasks/refresh-item-metrics.ts`, `src/lib/services/performance-decay.ts:216` (`refreshItemMetrics`), `src/app/api/production-items/route.ts`
- **Inputs:** `{ productionItemId }`
- **Outputs:** same as `performance-decay`'s per-item path — writes `views`, `likes`, `comments`, `viewsEstimated`, `lastPerformanceSyncAt`, `lastPerformanceSyncError`, `thumbnail` (Instagram). Calls Scrape Creators (~1 credit).
- **Downstream:** none
- **Rules:**
  - Same idempotent write path as the hourly sweep — jobKey `refresh-item-metrics-<id>` with `unsafe_dedupe` coalesces back-to-back saves
  - A freshly-created row with inline metrics (YouTube auto-fetch, preview-link flow) is NOT enqueued — `lastPerformanceSyncAt` already stamped, no credit to spend
  - Same decay-tier cadence still governs subsequent refreshes via the hourly `performance-decay` sweep — this task just fills the first sync window

### `account-refresh` — refresh one account
- **Trigger:** enqueued by `account-refresh-sweep`; on-demand `POST /api/accounts/[id]/refresh?mode=async`
- **Files:** `src/jobs/tasks/account-refresh.ts`, `src/lib/services/account-refresh.ts`
- **Inputs:** `{ accountId }`
- **Outputs:** `accounts.displayName`, `avatarUrl`, `bio`, `followerCount`, `followingCount`, `postCount`, `totalViews`, `verified`, `bannerUrl`, `location`, `url`, `externalId`, `metadata` (raw SC response), `lastRefreshError` on failure
- **Downstream:** none
- **Rules:**
  - Idempotent — overwrites whatever SC returned non-null
  - Per-platform endpoints; skips platforms without SC support
  - 1 SC credit per account

### `transcribe-whisper` — Whisper transcription (ffmpeg + OpenAI)
- **Trigger:** enqueued by `enrich-item` (when it sets `mediaS3Key`), by `youtube-download` (on success), by `POST /api/uploads/confirm` (user direct upload), and by `POST /api/production-items/[id]/transcript/fetch` (manual refetch). Operational kill switch: `WHISPER_TRANSCRIBE_LIVE=false` disables enqueue-side firing.
- **Files:** `src/jobs/tasks/transcribe-whisper.ts`, `src/lib/services/whisper-transcribe.ts`, `src/lib/services/transcribe-after-upload.ts` (`maybeEnqueueWhisperTranscribe`)
- **Inputs:** `{ productionItemId, audioS3Key?, audioS3Bucket?, audioChunks? }`
- **Outputs (by phase):**
  1. No `audioS3Key` → download archived S3 video, ffmpeg segment-extract mono 16kHz opus audio into 10-min chunks (`<prefix>/audio/<itemId>/<runId>-NNN.ogg`), upload each, re-enqueue with chunk manifest carried on payload
  2. `audioS3Key` set → for each chunk: fetch from S3, call OpenAI `whisper-1` with `verbose_json` + `timestamp_granularities: ["word", "segment"]` + an **item-aware prompt** (title + author names + description snippet) so Whisper biases proper nouns correctly. Offset chunk-local timestamps by `chunk.startSec`, merge, upsert `transcripts` row (source=`whisper`, model, segments, **words**, fullText, durationSec, language, audioS3Bucket, audioS3Key, audioChunks)
- **Downstream:** none
- **Rules:**
  - **Skips at top if a `transcripts` row with non-empty `fullText` exists** for this item (don't burn another API call). Legacy `source='descript'` rows count.
  - **Short-invocation pattern**: phase 1 finishes with a re-enqueue for phase 2 (1s delay), so a SIGTERM during ffmpeg or Whisper doesn't waste the other half.
  - Uses jobKey `transcribe-whisper:<id>` so back-to-back UI refetch clicks dedupe.
  - **Chunking** handles long-form content (podcasts): each chunk is ≤10 min and stays under OpenAI's 25 MB per-request cap. For chunk N>0 the prompt appends the tail of running fullText so context carries across the cut (helps with mid-sentence splits and keeps name-bias sticky).
  - Extracted audio stays in S3 — enables future re-runs (different model, diarization, vision) without re-downloading the full video. ~5 MB per 24-min video.

### `descript-clip-resolve` — poll Descript clip-out
- **Trigger:** enqueued by `POST /api/descript/clip-out`; enqueued by `promote-clip-idea` service (clip-promotion via agent flow)
- **Files:** `src/jobs/tasks/descript-clip-resolve.ts`
- **Inputs:** `{ triggerId, jobId, derivativeItemId?, deadlineAt? }`
- **Outputs:** `repurposeTriggers.descriptCompositionId`; if `derivativeItemId`, also `productionItems.descriptCompositionId`
- **Downstream:** none
- **Rules:** polls every 5s, 10-min deadline; short-invocation re-enqueue

### `clip-idea-precise-cut` — ffmpeg trim + Descript import
- **Trigger:** enqueued by `promote-clip-idea` service (precise-cut path; user clicks "Cut precisely" in clip-ideas panel)
- **Files:** `src/jobs/tasks/clip-idea-precise-cut.ts`
- **Inputs:** `{ clipIdeaId, triggerId, derivativeItemId, uploadJobId?, deadlineAt? }`
- **Outputs:**
  - Phase 1 (no `uploadJobId`): download from S3, ffmpeg-trim to [startSec, endSec], upload to Descript, save `descriptJobId` + `descriptProjectUrl` to `repurposeTriggers`; save `descriptProjectId` + URL to `productionItems`
  - Phase 2+ (`uploadJobId` set): poll import, save composition ID to both tables
- **Downstream:** none
- **Rules:**
  - ffmpeg tries stream-copy first, falls back to H.264 re-encode on failure
  - 30-min deadline per import job
  - Short-invocation re-enqueue

### `notification-send` — email send
- **Trigger:** enqueued by `enqueueNotification()` after a `notifications` row is inserted (comments, mentions, assignments)
- **Files:** `src/jobs/tasks/notification-send.ts`, `src/lib/services/notifications.ts` (`sendEmailForNotification`)
- **Inputs:** `{ notificationId }` — payload kept tiny, task re-fetches the row
- **Outputs:** Postmark email send; `notifications.emailedAt` stamp
- **Downstream:** none
- **Rules:**
  - Skips self-notifications (actor == recipient)
  - Skips uninvited contractors (no `passwordHash`)
  - Idempotent on `emailedAt`

---

## Lifecycle views

### Post lifecycle

How a `productionItems` row evolves end-to-end. Use this section when
debugging "why didn't X happen to this post".

**Creation paths:**
| Source | sourceType | When | Status starts as |
|---|---|---|---|
| Notion sync | `original` | every :30 cron, YouTube long-form only | inherited from Notion |
| Manual API (`POST /api/production-items`) | `original` | UI form, for platforms API can't pull from | `Idea` or `Queue` |
| Repost (`POST .../repost`) | `repost` | user button | `Idea` |
| Cross-post (manual `POST .../cross-post`) | `cross_post` | user button | `Idea` |
| Cross-post (manual scanner, `cross-post-scan`) | `cross_post` | operator clicks "Populate queue" on `/[brand]/queue` Cross-post tab | `Idea` |
| Clip promotion (`POST /api/clip-ideas/[id]/triage`) | `clip` | user accepts a clip-idea | `Assigned` |
| Threshold-based auto-repurpose (`threshold-monitor-sweep` cron) | `repurposed` | hourly :15, when parent views cross a child format's `viewThreshold` | `Idea` |

**After publication (status = `Published`):**
1. **Hour :00** — `performance-decay` may fetch metrics (decay-tier-gated)
2. **Hour :15** — `threshold-monitor-sweep` may auto-create one or more repurposed `Idea` rows if `views` crossed a child format's `viewThreshold`
3. **Hour :20** — `enrichment-sweep` queues `enrich-item` if `enrichment_completed_at IS NULL`
4. **`enrich-item`** writes platform-specific fields. **If it produces `mediaS3Key`** → auto-enqueues `transcribe-whisper`
5. **YouTube only**: every 20 min, `youtube-download-sweep` queues `youtube-download` if no `mediaS3Key` yet. On success → auto-enqueues `transcribe-whisper`
6. **`transcribe-whisper`** runs 2 phases (ffmpeg audio extract → OpenAI Whisper API), ends with `transcripts` row
7. **Hour :40** — `hook-extract-sweep` queues `extract-hook` if short-form + has transcript + no hook yet
8. **Hour :50** — `hook-fallback-sweep` queues `hook-fallback` for everything not covered by the LLM sweep
9. **Daily 15:00** — `evergreen-scan` may classify isEvergreen and refill Idea queue
10. **Daily 16:00** — `cross-post-scan` may create cross-post `Idea` rows on other platforms

**Status transitions** (no centralized state machine — validation lives in the UI, the PATCH route, and the Notion push-back; this is on the cleanup list):
```
Idea → Draft → Queue → Published
                          ↓
                       (terminal — metrics + enrichment continue)
Any → Killed (logs to contentEvents with reason)
```

On the first transition into `Published`, `src/app/api/production-items/route.ts` (PUT) stamps `productionItems.publishedAt` with `now()` if it is still null. Platform-reported timestamps from MATG sync and the Add-from-link preview take precedence; the in-app stamp is only a fallback. Subsequent edits do not clobber the value.

### Account lifecycle

| Phase | Trigger | Effect |
|---|---|---|
| Create | manual `POST /api/accounts` (or seeded once during accounts rollout) | row in `accounts`, `isActive=true`; for any SC-supported platform auto-enqueues `account-refresh` + `account-content-sync` with `mode=backfill, maxPages=50` (X / Threads fall through to single-page latest inside the task) |
| Refresh (manual) | `POST /api/accounts/[id]/refresh?mode=async` (or `?mode=sync` for in-line) | enqueues `account-refresh` |
| Refresh (auto) | `account-refresh-sweep` cron, Mon 17:00 UTC | one `account-refresh` per active SC-supported account |
| Refresh execution | `account-refresh` task | overwrites `displayName, avatarUrl, bio, followerCount, ..., metadata`; writes `lastRefreshError` on failure |
| Content sync (manual) | `POST /api/accounts/[id]/sync-content?mode=latest\|backfill` (Sync button in accounts UI) | enqueues `account-content-sync` |
| Content sync (auto) | `account-content-sync-sweep` cron, every 30 min (`*/30 * * * *`) | one `account-content-sync` with `mode=latest` per active SC account. Frequent cadence is intentional — it bounds worst-case "new post detection lag" to 30 min so velocity-snapshot scheduling can catch the 1h / 2h / 4h checkpoints reliably |
| Content sync execution | `account-content-sync` task | upserts `productionItems` keyed on `(account_id, platform_content_id)`; writes `lastContentSyncAt` / `lastContentSyncError` |

**Notion authority flag:** `accounts.syncedFromNotion = true` means Notion
owns items on this account (current convention: only YouTube long-form
Starter Story account). Notion sync only upserts items on
`syncedFromNotion=true` accounts. Other accounts are Hub & Spoke-owned.

### Transcript lifecycle

A `transcripts` row is 1:1 with a `productionItems` row (cascade delete).

| Source | When | Notes |
|---|---|---|
| `whisper` | After media S3 archive — `transcribe-whisper` runs (ffmpeg audio extract → OpenAI Whisper `whisper-1`) | Default path for archived video/audio. Writes word-level timestamps to `words` jsonb alongside segment-level. |
| `scrape_creators_youtube` | During enrichment, if SC returns YouTube auto-captions | Cheaper — skips Whisper entirely when platform already has captions |
| `scrape_creators_instagram` | During enrichment, if SC returns IG auto-captions | Reels < 2 min |
| `scrape_creators_tiktok` | During enrichment, if SC returns TikTok auto-transcript | |
| `descript` | **Legacy** — pre-Whisper migration. Still readable; new rows don't use this path | |

**Re-fetch:** `POST /api/production-items/[id]/transcript/fetch` enqueues a
fresh `transcribe-whisper` (deduped via jobKey per item).

**Consumed by:** hook extraction (LLM reads opening 20s), clip-idea
generation (LLM reads segments with timestamps), search (fullText indexed),
clip preview UI.

### Notification lifecycle

```
Comment / mention / assignment / item creation
  → enqueueNotification() inserts notifications row
  → enqueues notification-send
    → re-fetches row (payload is just the id)
    → sendEmailForNotification() via Postmark
    → stamps notifications.emailedAt
```

Triggered from:
- `POST /api/production-items` — assignment notifications
- `POST /api/production-items/[id]/comments` — comment + mention
- `POST /api/clip-ideas/[id]/triage` — clip-idea decision

---

## Operational rules

The implicit invariants every task obeys. Change one and you'll need to
update both the code and this list.

### Retry caps and cooldowns
- **Enrichment**: `MAX_ATTEMPTS = 5` (`enrichment/orchestrator.ts:20`). After 5, item enters 24h cooldown (the sweep selects rows where `attempts < 5 OR updatedAt < now()-24h`).
- **YouTube download**: same `MAX_ATTEMPTS = 5` (`youtube-download-sweep.ts:14`) — **duplicated constant**, both should change together. Per-tick `maxAttempts: 2` because failures are deterministic.
- **graphile-worker default**: 25 retries with exponential backoff for any task we don't override.

### Long-job patterns
- `transcribe-whisper` and the remaining Descript-touching tasks (`descript-clip-resolve`, `clip-idea-precise-cut`) use the **short-invocation / self-re-enqueue** pattern so a SIGTERM mid-run never leaks a lock on multi-minute work. Descript clip-touching tasks carry a 30-min `deadlineAt`; `transcribe-whisper` splits into phase 1 (ffmpeg extract + S3 upload) and phase 2 (Whisper API call + persist), re-enqueued 1s apart.
- All other tasks complete in one run.

### Idempotency
Every task that has a "did this already happen?" check at the top:
- `transcribe-whisper` — exits if a `transcripts` row with non-empty `fullText` exists (covers both prior Whisper runs and legacy Descript rows)
- `enrich-item` — exits if `enrichmentCompletedAt` set (unless `force`)
- `youtube-download` — exits if `mediaS3Key` set (unless `force`)
- `hook-fallback` — only writes if `hookExtractedAt IS NULL`
- `notification-send` — only sends if `emailedAt IS NULL`

### Dedupe across overlapping sweeps
Sweep parents enqueue children with `jobKey: <name>-{id}` and `jobKeyMode: "unsafe_dedupe"` so a tick that overlaps an in-flight job won't double-fan-out. Affected: `enrichment-sweep`, `hook-extract-sweep`, `hook-fallback-sweep`, `youtube-download-sweep`, `account-refresh-sweep`.

### Hook hierarchy (don't override)
`hookExtractedAt IS NULL` is the gate for both Haiku and fallback paths. Manual hooks (set in the UI), clip-idea-derived hooks, and the LLM hook all stamp it; the fallback never overrides a populated value.

### Notion authority
Only YouTube long-form items on `accounts.syncedFromNotion = true` accounts are Notion-authoritative. Hub & Spoke can edit other items freely without conflict. Status / pillar / utm_campaign are pushed back to Notion only for authoritative items.

### Heroku Postgres connection budget (Essential-0 = 20)
- web: postgres.js `max:8` + WorkerUtils `2` = 10
- worker: pg `max:6` + drizzle `3` + LISTEN `1` = 10

Scaling web past 1 dyno without lowering worker concurrency or upgrading Postgres will trip the cap.

### Payload conventions
- Keep payloads < 4 KB. Pass IDs, re-fetch in the task. Never pass comment bodies / transcripts / blobs.
- `Date` doesn't survive JSON serialization. Send ISO strings (e.g. `TranscriptFinishPayload.startedAtIso`) and parse inside the task.

### Platform-kind resolution (`post_type` is canonical)
`production_items.post_type` is the canonical, 1:1-with-SC-endpoint platform descriptor. The `production_items.platform[]` jsonb array is legacy — rows created via the account picker now store `{kind}:@{handle}:{post_type}` (e.g. `x:@thepatwalls:x`), which the legacy `platformKindsFor()` label-matcher does not recognize.

Every sweep filter AND the per-item executor must resolve platform kinds through `resolveItemPlatformKinds({ postType, platform })` in `src/lib/services/performance-decay.ts`. It prefers `post_type` and falls back to the legacy array. Keeping both sides on the same helper prevents the silent-skip failure mode where the executor could handle a row but the filter excluded it.

- `performance-decay`'s `getItemsDueForSync()` and `refreshItemMetrics()` use the helper
- `enrichment/orchestrator.ts` (`enrichSingleItem` + `runEnrichmentSweep`) uses the helper
- `hook-extract/orchestrator.ts` gates directly on `post_type` via `inArray(productionItems.postType, SHORT_FORM_POST_TYPES)`, mirroring `hook-extract/fallback.ts`

---

## External systems

| System | Used by | Cost notes |
|---|---|---|
| Scrape Creators | `performance-decay`, `account-content-sync`, `enrich-item`, `account-refresh`, `instagram-body-fetch.ts`, `tweet-body-fetch.ts` | ~1 credit per call; enrichment with media (`withMedia=true`) is ~10; `account-content-sync` with `mode=backfill` spends up to `maxPages` credits per account |
| Descript | `descript-clip-resolve`, `clip-idea-precise-cut` | Per-project API calls — used for clip editing only (transcript path moved to OpenAI Whisper 2026-04) |
| OpenAI (Whisper) | `transcribe-whisper` | `whisper-1` at $0.006/min ⇒ ~$0.14 per 24-min video; kill-switch via `WHISPER_TRANSCRIBE_LIVE=false` |
| Anthropic (Claude Haiku 4.5) | `extract-hook`; also draft-gen, repurpose-agent, fit-classifier, evergreen-scan, summary | Hook extraction ~$0.0005/item |
| Notion | `notion-sync` (bi-directional) | Rate-limited; bulk push via service |
| Postmark | `notification-send`, password reset, invite emails | |
| AWS S3 | `youtube-download` (write), `transcribe-whisper` (read video + write extracted audio), `clip-idea-precise-cut` (read), uploads route (write) | Long-term archive |
| PostgreSQL | everything | See connection budget above |

---

## Inspecting the queue

```bash
# Live tail of worker logs
heroku logs --app hubandspoke --dyno worker --tail

# Pending / running / failed jobs
heroku pg:psql --app hubandspoke -c "SELECT task_identifier, attempts, max_attempts, run_at, last_error FROM graphile_worker.jobs ORDER BY run_at DESC LIMIT 20;"

# Manually fire a scheduled task right now (CRON_SECRET-gated)
curl -H "Authorization: Bearer $CRON_SECRET" "https://hubandspoke.herokuapp.com/api/cron/tick?name=enrichment-sweep"

# Backfill enrichment for one item without burning the full sweep
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://hubandspoke.herokuapp.com/api/cron/enrichment-sweep?itemId=<uuid>&force=true"
```

UI equivalent: `/(dashboard)/settings/jobs` for queue status,
`/(dashboard)/settings/sync-errors` for sync failures.

---

## Known seams (future cleanup)

These show up here so changes don't accidentally widen them. Each one
has a row in `docs/features.md`'s cleanup backlog.

- **`MAX_ATTEMPTS = 5` is duplicated** between `enrichment/orchestrator.ts:20` and `youtube-download-sweep.ts:14`. Extract to a shared constant once we touch retry semantics.
- **`selectEnrichmentCandidates()` and the legacy `selectEnrichmentItems()`** in `enrichment/orchestrator.ts` are nearly identical. Legacy path is the in-process loop used by `runEnrichmentSweep()` (called from `/api/cron/enrichment-sweep` with no `itemId`). Consolidate the query builder when we delete the legacy `runEnrichmentSweep` path.
- **No central status-transition state machine.** Validation logic lives in the UI, the PATCH route, and the Notion push-back independently. Adding a new status today requires touching all three.
- **`/api/cron/*` routes** still exist. `tick` is debug; the others (`notion-sync`, `performance-sync`, `enrichment-sweep`) still run their underlying sync inline and are useful for manual re-runs. The old `/api/cron/youtube-sync` + `/api/sync/youtube` routes were removed alongside `matg-sync` — use `/api/cron/tick?name=account-content-sync-sweep` for a manual full-fleet sync.
- **`assignees.ts` resolution chain** is duplicated implicitly: `source item → format → brand defaults → global` repeats in `notion-sync.ts`, `cross-post-scan.ts`, and the manual creation routes. Extract a single `resolveAssignees()` (already partially exists) and use it everywhere.
