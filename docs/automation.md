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
  *:40  hook-extract-sweep        → fan-out → extract-hook (per item, gpt-4.1-mini)
  *:50  hook-fallback-sweep       → fan-out → hook-fallback (per item, no LLM)
  */20  youtube-download-sweep    → fan-out → youtube-download → transcribe-whisper
  */30  account-content-sync-sweep → fan-out → account-content-sync (per active SC account, latest mode)
  15:00 evergreen-scan            → AI classifier + Idea-queue refill
  (per-post) capture-velocity-snapshot → scheduled at publish+{15m,30m,1h,2h,4h,8h,24h,48h} per item; writes one view_snapshots row each
  (live)     cross-post candidate queue → GET /api/cross-post-queue, no scheduled job — runs on every page load of /[brand]/queue Cross-post tab
  Mon 17:00  account-refresh-sweep → fan-out → account-refresh (per account)
  13:00      daily-scorecard-email → Postmark (per opted-in user). 9am EDT / 8am EST in winter.
  */15 min   sc-credits-watch → email opted-in users when SC returns HTTP 402 (deduped 4h)

USER / API ENTRY POINTS
  POST /api/accounts/[id]/refresh?mode=async              → account-refresh
  POST /api/accounts/[id]/sync-content?mode=latest|backfill → account-content-sync
  POST /api/accounts (new account row)                    → account-content-sync (backfill) + account-refresh
  POST /api/production-items/[id]/transcript/fetch        → transcribe-whisper
  POST /api/uploads/confirm                               → transcribe-whisper
  POST /api/production-items/[id]/repurpose               → draft-algorithm-run (auto-fire after insert)
  POST /api/production-items/[id]/repurpose               → canva-create-copy   (auto-fire when target.is_canva_format AND Skill has brand-template URL)
  POST /api/production-items/[id]/cross-post              → draft-algorithm-run (auto-fire after seed, any seeded target)
  POST /api/descript/clip-out                             → descript-clip-resolve  (format-detail quick-clip only as of 2026-05-02)
  POST /api/clip-ideas/[id]/triage (action=assign)        → draft-algorithm-run (auto-fire after promote)
  POST /api/clip-ideas/[id]/create-in-descript            → descript-clip-resolve + draft-algorithm-run (auto-fire)
  POST /api/clip-ideas/[id]/create-in-descript-precise    → clip-idea-precise-cut + draft-algorithm-run (auto-fire)
  POST /api/clip-ideas/[id]/create-in-descript-full       → descript-clip-resolve (importMode=true on cold path) + draft-algorithm-run (auto-fire)
  POST /api/production-items (new row w/ link, no inline metrics) → refresh-item-metrics
  PUT  /api/production-items (→ Published w/ link, or link added on Published) → refresh-item-metrics
  POST /api/production-items, /comments, /clip-ideas/triage  → notification-send
  POST /api/queue/refill-reposts (admin-only)             → evergreen-scan (manual trigger from /queue/repost)
  POST /api/production-items/[id]/repost                  → (no job — verbatim seed kept; algorithm doesn't run on repost)
  POST /api/production-items/[id]/draft                   → (synchronous; no job — manual Draft Algorithm trigger)

AUTO-CHAINS (one task enqueues another)
  enrich-item        ── if updates.mediaS3Key set ─→ transcribe-whisper
  youtube-download   ── on success ────────────────→ transcribe-whisper
  archive-yt-local.ts (script)         ── on S3 upload ─→ transcribe-whisper
  backfill-instagram-bodies.mjs (script) ── on S3 upload ─→ transcribe-whisper
  enqueueNotification() ───────────────────────────→ notification-send

CONTENT VERSIONING (2026-05-13)
  Every state-changing write to tracked content (production_items field,
  content_drafts.content, production_item_media row) calls
  `recordContentChanges()` in `src/lib/services/content-revisions.ts`
  inside the same transaction as the mutating write. Emits one
  `content_changed` row to `content_events` per moved field/media. The
  payload's `source` discriminator (user / algorithm / tool / sync /
  import / api) drives the activity-feed renderer's badge + filter. No
  separate versions table — content_events IS the audit trail. The
  draft-edit path additionally clones content_drafts on every commit so
  the full prior text is recoverable from the version chain.

  Instrumented write sites:
    PUT /api/production-items                       → user
    PUT /api/production-items/[id]/drafts/[draftId] → user (clone-on-write)
    POST /api/production-items/[id]/draft (regen)   → algorithm:draft-algorithm
    POST/DELETE /api/production-items/[id]/media    → user
    canva-create-copy / canva-export-design /
      canva-export-page-video tasks                 → tool:canva
    descript-publish-and-archive task               → algorithm:slice-algorithm
    enrichment orchestrator                         → algorithm:enrichment
    hook-extract orchestrator                       → algorithm:hook-extractor
    vision-extract                                  → algorithm:vision-extractor
    repost-seed (also used by cross-post route)     → import
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
- **Downstream:** `draft-algorithm-run` enqueued for each created row so the editor lands on a populated form (skipped internally for unsupported post types or when the pillar has no transcript yet). Otherwise the new `Idea` row enters the normal post lifecycle and may itself be picked up by enrichment / metrics / hook sweeps once published.
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
  - **Pillar resolution is scoped to `source_type='original'` rows.** A post-loop UPDATE resolves `pillar_content_item_id` from `pillar_content_notion_id`, and a follow-up cleanup NULLs out stale links — both restricted to `original` items. App-code-set pillars on `repost` / `cross_post` / `repurposed` rows (which never carry a `pillar_content_notion_id`) are left untouched.

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

### `account-content-sync-sweep` — per-account content fan-out (hourly)
- **Trigger:** cron `5 * * * *` (hourly at :05). Was `*/30` before 2026-04-27 — halved frequency to cut SC spend; the PUT-time auto-fetch on operator-pasted publish links handles the common discovery case.
- **Cost:** ~22 SC credits per sweep at current volume (3 IG + 3 LinkedIn + 2 Threads + 3 TikTok + 3 X + 4 YouTube × 2 endpoints). 24 sweeps/day → ~528 SC calls/day. Tunable via `CRONTAB` in `src/jobs/crontab.ts`.
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
- **Cross-account uniqueness:** `uniq_production_items_platform_content_id_global`
  (added 2026-04-29) makes `platform_content_id` globally unique across
  all accounts, not just per-account. The same X tweet / IG reel / YT video
  can only live as one row in the whole table — the natural keys are
  globally unique by construction (X rest_id, YT videoId, IG shortcode), so
  two rows sharing one is always a duplicate that double-counts metrics.
  Sync skips + logs cross-account collisions (`skippedDuplicates` counter
  surfaced via `lastContentSyncError`); manual writes through
  `POST /api/production-items` return `409 { error: "DUPLICATE_URL",
  existingItemId, existingAccountHandle }` so the UI can deep-link the
  operator to the existing item. The DB index is the safety net for races.
  URL-based uniqueness is intentionally *not* enforced — placeholder URLs
  (homepage, "Twitter Post", reused Klaviyo links) appear thousands of
  times in legitimate rows; `scripts/backfill-find-duplicates.mjs` surfaces
  URL-level collisions for manual audit instead.
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
  response lacks a timestamp **on first INSERT only** — see the per-column
  policy below; subsequent syncs do not overwrite a stamped publishedAt.
- **Per-column write policy** (`upsertItems` in
  `src/lib/services/account-content-sync.ts`): the upsert keeps two
  payload shapes —
  - `insertPayload` (used only on INSERT): writes every column derived
    from the SC response — title, thumbnail, publishedAt, publishedDate,
    contentBody, identity columns, plus engagement counters.
  - `updatePayload` (used only on UPDATE): writes ONLY the engagement
    refresh — `views`, `likes`, `comments`, `lastPerformanceSyncAt`,
    `updatedAt`. Every other column is insert-only.

  This exists because SC occasionally returns stale or missing values on
  later sweeps (a null `publishedTime` it had populated last time; a
  caption from a different post showing up under the same item id). The
  pre-2026-04-25 writer trusted SC for everything on UPDATE, which
  caused observed `publishedAt` thrash (firing bogus "first 15 minutes"
  velocity snapshots) and `title` clobbering. **Adding a new field to
  the upsert means deciding which payload it belongs in — when in
  doubt, insert-only.**
- **Errors:** any thrown error stamps `lastContentSyncError` and re-throws
  so graphile-worker retries with backoff.

### `evergreen-scan` — daily classifier (Phase A only as of 2026-05-06)
- **Trigger:** cron `0 15 * * *` (daily 15:00 UTC)
- **Files:** `src/jobs/tasks/scheduled.ts:112`, `src/lib/services/evergreen-scan.ts`
- **Inputs:** published items with ≥10,000 views, per-post-type age gates (x 365d+, instagram_reel/post 90d+, linkedin/threads 180d+, youtube_community/shorts 180d+); existing `contentEvents` (past kill reasons fed to the classifier prompt as negative exemplars).
- **Outputs:** `productionItems.isEvergreen` + `evergreenReasoning`. The reasoning text is what the repost queue v2 modal surfaces in the yellow callout; `is_evergreen` is no longer a queue-admission gate but stays as a corroborating signal.
- **Downstream:** repost queue v2 (`/api/repost-queue`) reads `evergreen_reasoning` for flavor text. No queue rows are written by this task anymore.
- **Rules:**
  - Stratified-batch classify per post-type (per-run quotas: x 12, instagram 10, linkedin/threads/youtube 4 each). Last 10 kill reasons injected into the classifier prompt as negative exemplars; classifier draws from a 50-reason history window.
  - Phase A' re-runs classification when an item's body becomes available after a previous `not_evergreen` verdict (caption sync arrives late on IG/X). Bounded to 5 items per cron tick.
  - **Phase B retired 2026-05-06** — the queue-refill loop (LLM fit judge, per-platform diversity caps, cooldown gating) was replaced by the live-query repost candidate queue v2 (`src/lib/services/repost-candidates.ts`) which uses cohort-relative percentile evidence instead of binary classification. The `accept_exemplars` history feed and `judgeRepostFit` LLM call are no longer invoked.

### Repost candidate queue (v2) — live percentile-within-format×account view
- **Trigger:** none. `selectRepostCandidates({ brand })` runs synchronously on every `GET /api/repost-queue?brand=…` (the Repost tab fetches it on page load). No graphile-worker task, no cron, no Idea-row pre-population.
- **Files:** `src/lib/services/repost-candidates.ts` (algorithm), `src/app/api/repost-queue/route.ts` (entry), `src/components/dashboard/repost-queue-table.tsx` + `repost-triage-dialog.tsx` (UI), `src/lib/services/format-view-bars.ts` (cohort-bar fetchers — extended with `fetchAccountFormatViewBars` and `fetchBrandFormatViewBars` for the per-account/per-brand cohort tiers).
- **Inputs:** `productionItems.views` (kept fresh by `performance-decay`); existing reposts on each candidate (status check for kill/cooldown/in-flight); `contentEvents` rows of type `repost_dismissed` (30-day TTL hide-list); optionally `view_snapshots` for bonus velocity signals.
- **Outputs:** read-only response. Accepting in the modal calls `POST /api/production-items/[id]/repost` with `{ editorUserId, status: "Ready To Publish" }`, which lands a new `sourceType='repost'` row directly in `Ready To Publish` (skipping the Idea/Assigned review cycle) and writes a `repost_created` content_event for the activity feed.
- **Rules:**
  - **Eligibility:** `sourceType ∈ {original, cross_post, repurposed}` (no recursion on `repost`), `status='Published'`, age ≥ per-platform floor (x 365d / instagram 90d / others 180d), `accountId` + `format` + `postType` populated, `views > 0`.
  - **Permanent suppression:** any prior `Killed` repost on the same source → never resurface. (Operator already decided.)
  - **In-flight block:** any `Idea` / `Assigned` / `Ready To Publish` repost on the same source → skip.
  - **Cooldown:** any `Published` repost on the same source within the platform's cooldown window → skip. instagram 30d, youtube/linkedin/threads 60d, x 120d, default 60d.
  - **Cohort ladder (P75 in all three tiers):** (1) `(account, format, postType)` all-time, min cohort 5; (2) `(brand, format, postType)` all-time, min cohort 5; (3) `(format, postType)` cross-brand over 365d, min cohort 5. The strongest tier with a bar wins.
  - **Admission:** lifetime ratio (`candidate.views / cohort_P75`) ≥ 1.5×. Sort items by max ratio desc. Unlike cross-post v3, candidates with **no cohort at all are NOT auto-admitted** — reposts require evidence; "this beat its peers" needs peers.
  - **Velocity bonus:** when `view_snapshots` rows exist for a candidate (typically only items younger than ~2 weeks at capture time), each checkpoint contributes a supplementary `hotnessSignal` against the format's same-checkpoint P75 cohort. Lifetime is the admission gate; velocity is informational only.
  - **Dismissal:** "Not interested" / "Kill this idea" → `POST /api/production-items/[id]/repost-dismiss` writes a `contentEvents` row with `type='repost_dismissed'`. The candidate is hidden for 30 days; after that it can resurface if it still clears the bar.

### Repost content seeding (X + Instagram, 2026-05-06 / 2026-05-07)
- **Trigger:** synchronous step inside `POST /api/production-items/[id]/repost`, in the same transaction as the new `production_items` insert. Runs for both repost-creation paths (manual button on `/content/[id]` and the queue v2 triage dialog).
- **Files:** `src/lib/services/repost-seed.ts` (the helper), `src/app/api/production-items/[id]/repost/route.ts` (call site, gated to `SEEDED_POST_TYPES = { x, instagram_post, instagram_reel, instagram_story, linkedin, tiktok }`).
- **Outputs:**
  1. Mirrored `production_item_media` rows on the new repost — same `s3_key`s as the source (no re-upload, no duplicated bytes). Drives the photo grid in the X simulator card on the redirect target. **Legacy fallback (2026-05-08):** when the source has zero `production_item_media` rows but its parent row carries a `mediaS3Key` (older single-media enrichments wrote MP4s onto `production_items.mediaS3Key` instead of into the carousel table), the seed synthesizes one `production_item_media` row with `index=0`, `kind` derived from `mediaContentType`, and the same `s3_key` / `posterS3Key`. Lets the IG Reel simulator play the source's archived video without a fresh Descript render.
  2. A v1 `content_drafts` row with `is_current=true`, `content = { <captionFieldKey>: <source.contentBody> }`, `field_schema_snapshot = PLATFORM_FIELD_SCHEMAS[postType]`, `generated_by = 'copy:source'`. The `EditableField` editor binds via `draftId`, so the row has to exist before the first keystroke can PATCH against it. The caption field key is resolved via `PLATFORM_FIELD_MAP[postType].caption` (X → `tweet`, IG → `caption`, etc.) — **not** the schema's first required field, because for IG Reel that would target `hook` (on-screen overlay text) instead of the actual caption.
- **`generated_by` sentinels:** `copy:source` (this seed), `ai:<model>:v<n>` (drafts generation route), `user` (manual edits via the editor UI). The split lets us later filter "did the editor rewrite this, or ship it verbatim?" analytics without ambiguity.
- **Why synchronous:** the seed is sub-50ms (≤4 small INSERTs) — invisible next to the redirect. A background job would race the redirect and the user would see exactly the blank simulator card the seed exists to fix.

### On-demand source enrichment for repost / cross-post (2026-05-07, force-when-missing-media added 2026-05-08)

When the user clicks **Repost** or **Cross-post**, the route calls `enrichSingleItem(source.id)` synchronously before building the new row — best-effort, with the source re-fetched after to pick up the new `contentBody` / `productionItemMedia` rows / author fields. Two firing conditions:

1. **Source has never been enriched** (`enrichmentCompletedAt` IS NULL). Standard fetch — `withMedia` defaults to false (matches the auto-sweep cost model: 1 SC credit).
2. **Source IS enriched but has no archived video** for a video-bearing post type (Reel / TikTok / IG Story / etc.). Detected by `isVideoBearingPostType(source.postType) && !source.mediaS3Key && !(await hasAnyCarouselRow(source.id))`. The auto-sweep's `withMedia: false` default never archives MP4s, so a Reel that the cron successfully enriched can still be missing its video bytes. In this branch the route forces `enrichSingleItem(source.id, { withMedia: true, force: true })` — bumps the call to 10 SC credits but is the only way to backfill the MP4 in time for the seed step.

- **Files:** `src/app/api/production-items/[id]/repost/route.ts`, `src/app/api/production-items/[id]/cross-post/route.ts`. The `withMedia` / `force` flags are passed through to `src/lib/services/enrichment/orchestrator.ts:enrichSingleItem`.
- **Helpers:** `isVideoBearingPostType` in `src/lib/platform-media-rules.ts` (single source of truth for "this post type's primary asset is a video"); `hasAnyCarouselRow` in `src/lib/services/draft-media.ts` (cheap LIMIT 1 row probe).
- **Idempotent:** branch (1) short-circuits when the source is already enriched and has its media. Branch (2) re-runs with per-slide idempotency (`archiveCarouselMedia` skips slides whose `(itemId, index, sourceUrl)` is already archived). Re-running on a source that already has its MP4 is a 10-credit no-op INSERT, so the cost only kicks in for genuinely cold sources.
- **Failure-tolerant:** wrapped in try/catch. If upstream is broken or the source has no published link, the error is logged and the create proceeds. Never blocks the user's action.
- **Latency:** adds one Scrape Creators round-trip + S3 archive (typically 2–5 s for X tweets, 5–10 s for IG videos). The user explicitly opted into the wait — they prefer correct data over instant redirect.

### Descript publish + archive (2026-05-07)

Closes the loop on the clip-creation flow: when Descript finishes assembling a composition, render it to MP4, archive to our S3 bucket, and surface in the simulator on the clip's detail page. Auto-fires after every clip-creation path; can be re-triggered manually via the Actions dropdown to pull fresh edits.

- **Files:**
  - `src/jobs/tasks/descript-publish-and-archive.ts` — self-polling task. Phase 1 calls `POST /jobs/publish` and stamps `descript_publish_job_id`. Phase 2 polls `GET /jobs/{id}` every 10s; on `job_state="stopped"` + `result.status="success"`, downloads the MP4 via `archiveRemoteToS3`, deletes prior Descript-published media rows (matched by `source_url LIKE 'https://production-273614-media-export.storage.googleapis.com/%'`, so manual uploads are preserved), **inserts the new `production_item_media` row at `index = 0`** (shifts every remaining row up by 1 first, via a two-pass negative-scratch UPDATE so the `(production_item_id, index)` unique constraint doesn't collide mid-renumber), mirrors the cover columns, and stamps `descript_published_at`. **Index-0 is the canonical slot for the rendered clip** — simulator `slides[0]` and the legacy `mediaS3Key` mirror (which picks the lowest-index row) both resolve to it. Inherited source media from `repost-seed` (which copies the parent's media preserving the parent's original index) gets pushed to index 1+ instead of squatting on index 0 and hiding the render. 15-minute deadline.
  - `src/jobs/tasks/descript-clip-resolve.ts` — auto-chains: after stamping `descript_composition_id` on the derivative item, enqueues `descript-publish-and-archive`. Idempotent (no-op if already rendered).
  - `src/lib/descript.ts` — `publishDescriptComposition({projectId, compositionId, resolution, accessLevel})` returns `{jobId}`. `DESCRIPT_EXPORT_URL_PREFIX` constant identifies Descript's GCS export bucket for source-URL matching.
  - `src/app/api/production-items/[id]/sync-descript-publish/route.ts` — manual re-trigger. Race guard: returns 409 if a render is already in flight, unless `{force: true}` is passed (used by the Retry button on a failed pill).
  - `src/app/api/production-items/[id]/descript-status/route.ts` — extended to return a `publish: { state, jobId, publishedAt, error }` block. Pill polls every 10s while `state === "rendering"`.
- **Schema:** three new columns on `production_items`:
  - `descript_publish_job_id` — current/last publish job id (null = idle).
  - `descript_published_at` — when the MP4 archive completed.
  - `descript_publish_error` — last error if failed (truncated to 1000 chars).
  - Derivable states: `idle` (both null), `rendering` (job id set, not published, no error), `rendered` (published_at set), `failed` (error set).
- **Race condition:** every polling tick re-reads `descript_publish_job_id` from the row; if it doesn't match the payload's job id (the user clicked Sync mid-poll and a fresh job kicked off), the stale poller bails.
- **Failure tolerance:** task throws on Descript errors / timeout; graphile-worker retries with backoff. Final error is stamped on `descript_publish_error` and surfaced via the pill with a Retry button.
- **UI:** Actions dropdown gains a "Download from Descript" item when `hasDescriptProject && descriptCompositionId`. The `DescriptStatusPill` shows a Render section inside its popover with rendering/rendered/failed sub-state and a Retry/Re-sync button. Once `descript_published_at` flips, the next page-data refresh returns the new media row and the simulator re-renders with the actual MP4.

### `canva-create-copy` — autofill a Canva Brand Template for IG Post derivatives (2026-05-12)

Click "Create" on an IG-Post format whose `is_canva_format=true` and whose Skill contains a `canva.com/brand/brand-templates/<id>` URL → the new derivative gets an autofilled copy of that template in the team Canva account, with hook / stack_list / cta text extracted from the pillar's transcript by Claude. Editor lands on the derivative's detail page and sees an "Open in Canva" pill linking to the editable design.

- **Files:**
  - `src/jobs/tasks/canva-create-copy.ts` — self-polling task. Phase 1: extract text fields via `extractCanvaSlideText` (Claude Opus tool-use, grounded in pillar transcript), call `createCanvaAutofill`, stamp `canva_autofill_job_id` on the productionItem, re-enqueue with `jobId` set + 5s delay. Phase 2: `fetchCanvaAutofillJob` once per invocation; on success write `canva_design_id` + `canva_edit_url`, clear the in-flight job-id, emit a `recordToolAction("canva", "design_created")` event. 5-minute deadline. Each invocation < 1s so SIGTERM never catches mid-step.
  - `src/lib/canva.ts` — Connect API client. `getCanvaAccessToken` (DB-backed RT rotation, serialized via `pg_advisory_xact_lock` so concurrent workers don't race-invalidate the token), `createCanvaAutofill({brandTemplateId, title, textFields})` → `{jobId}`, `fetchCanvaAutofillJob(jobId)` → `{status, designId, editUrl, pageCount}`. Canva quirks documented inline: empty `data:{}` is rejected when the template has any tagged fields; RT rotates on every exchange.
  - `src/lib/canva-text-extractor.ts` — Claude Opus tool-use call. Grounded in pillar transcript; falls back to `{hook: title, stack_list: "coming soon", cta: stock pattern}` when no transcript is available so the editor still gets a usable copy.
  - **hero_image autofill (2026-05-12):** `canva-create-copy` also uploads the pillar's `poster_s3_key` to Canva via `POST /v1/asset-uploads` (filename must be short — long UUID names trip Canva's `Asset-Upload-Metadata` header parser with `Invalid upload metadata header`) and passes the returned `asset_id` as the `hero_image` field in the autofill payload. Page-1 background of the slideshow then renders the pillar's founder photo. Best-effort — a missing poster or a failed upload just falls back to the template's default placeholder. Video fields aren't supported by the autofill API at the schema level (per Canva's own docs: image/text/chart only), so page-3's embedded video stays static. Recommended path for page-3 dynamism: tag the video element's poster as a `video_thumbnail` image field and pass a frame grab.
  - `src/lib/canva-skill.ts` — `extractCanvaTemplateId(skill)` regex on Skill text. Matches `canva.com/brand/brand-templates/<id>` (preferred) and falls back to `canva.com/design/DA<id>` for legacy formats.
  - `src/app/api/production-items/[id]/repurpose/route.ts` — gates the enqueue on `target.isCanvaFormat && target.instructions && extractCanvaTemplateId(target.instructions) != null`. Fire-and-forget — a failed enqueue must not block the create response.
  - `scripts/canva-oauth.mjs` — one-shot CLI helper to mint the initial refresh token via PKCE. Redirect URI `http://127.0.0.1:8765/callback` must be registered on the Canva Connect integration.
- **Schema:**
  - `production_items.canva_autofill_job_id` — set during in-flight autofill, NULL after success.
  - `production_items.canva_design_id` — the Canva design id once autofill succeeds.
  - `production_items.canva_edit_url` — `https://www.canva.com/design/<designId>/edit`, what the "Open in Canva" pill links to.
  - `formats.is_canva_format` — editor-toggleable flag (sibling to `is_clip_descript_format`). When false, the integration stays inert even if a Canva URL appears in the Skill.
  - `canva_oauth` — singleton row (`id='default'`) holding the rotating `refresh_token` + cached `access_token` + `access_token_expires_at`. Necessary because Canva invalidates the RT on every exchange — env vars alone would break after the first API call.
- **Env vars:** `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REFRESH_TOKEN` (seed; production source of truth is the `canva_oauth` row).
- **UI:** `CanvaStatusPill` next to `DescriptStatusPill` on content-detail. Renders "Creating in Canva…" (amber, pulsing) while `canva_autofill_job_id` is set; "Open in Canva" (green, external-link icon) once `canva_edit_url` lands. Hidden when neither is set. Self-polls `/api/production-items/[id]` every 5s during the in-flight window.
- **Brand-template setup:** the template must (a) be published as a Brand Template (Share → Brand Template; Teams plan is sufficient — Enterprise is not required despite what Canva's docs imply) and (b) have at least one autofill-tagged element. Bulk Create's "Connect data" toolbar action is the only Teams-accessible way to tag fields. See `MEMORY.md` → `project-canva-autofill` for the full setup quirks.

### `canva-export-design` — archive Canva slides into production_item_media (2026-05-12)

Closes the loop on the Canva-autofill flow: when autofill stamps `canva_design_id`, this task exports the design's pages as PNG via `POST /v1/exports`, polls until ready, downloads each URL, archives to S3, and upserts one `productionItemMedia` row per page so the IG-Post simulator on the detail page renders the autofilled slides. Auto-fires after `canva-create-copy` succeeds.

- **Files:**
  - `src/jobs/tasks/canva-export-design.ts` — self-polling task. Phase 1: `createCanvaExport({designId, type:"png"})`, stamp `canva_export_job_id` on the row, re-enqueue with `jobId` set + 5s delay. Phase 2: `fetchCanvaExportJob(jobId)` once per invocation; on success hands the returned URL array to `archiveCarouselMedia` (the same helper Instagram enrichment uses for source-of-truth carousel ingestion), which downloads each URL, uploads to S3 under `hubandspoke/uploads/<itemId>/<uuid>-canva-slide-N.png`, and upserts `productionItemMedia` rows keyed by `(productionItemId, index)`. Mirrors the index-0 cover into legacy `productionItems.mediaS3Key`/`mediaContentType`/`mediaSizeBytes` so list-view queries don't need a join. Stamps `canva_exported_at` and clears `canva_export_job_id`. 5-minute deadline. Each invocation < 1s.
  - `src/lib/canva.ts` — `createCanvaExport({designId, type, pages?})` → `{jobId}`. `fetchCanvaExportJob(jobId)` → `{status, urls, errorMessage}`. PNG exports return one URL per page; PDF/MP4/GIF return a single URL.
  - `src/jobs/tasks/canva-create-copy.ts` — auto-chains: after stamping `canva_design_id`, enqueues `canva-export-design`. Fire-and-forget.
- **Schema:** `canva_export_job_id`, `canva_exported_at`, `canva_export_error` on `production_items`. Mirrors the descript publish-and-archive shape.
- **Idempotency:** `archiveCarouselMedia` upserts by `(productionItemId, index)` — re-running the export rewrites the same rows. Safe to redrive when the editor tweaks the design in Canva.
- **Cross-derivative leak fix (2026-05-12):** the descript-status endpoint now short-circuits when the item's own descript_* columns are all NULL. Without this gate the trigger lookup walked up to the pillar and picked up Descript triggers from sibling derivatives, so a Tech Stack Slideshow item showed "Descript ready" because the pillar happened to have a clip in flight.

### Manual media upload to drafts (X + Instagram, 2026-05-07)

Browser-driven companion to `archiveCarouselMedia` (enrichment-time URL ingest) and `seedRepostContent` (repost-time row mirror). All three write into the same `production_item_media` table with identical column conventions — that's the **single shared schema** for media on a production item.

- **Files:**
  - `src/lib/services/draft-media.ts` — primitive: `addMediaRowsToDraft`, `removeMediaRowFromDraft`, `validateMediaForPostType`, `X_ALLOWED_CONTENT_TYPES`, `MAX_IMAGE_BYTES` (15 MB), `MAX_VIDEO_BYTES` (200 MB). No S3 calls — pure DB + validation. Both routes below funnel through it.
  - `src/app/api/production-items/[id]/media/presign/route.ts` — POST. Validates the batch against the post-type rules + per-file size + content-type allowlist (`image/jpeg|png|gif|webp` + `video/mp4|quicktime`). Issues 15-min presigned PUT URLs via `getPresignedPutUrl`. Refuses on `status === "Published"`.
  - `src/app/api/production-items/[id]/media/route.ts` — POST (confirm). HEAD-checks each S3 key landed, re-runs the validator (defense-in-depth), inserts rows in one `db.transaction`, and mirrors the new index 0 onto `production_items.media_s3_*` + `poster_s3_key` so cover-thumbnail consumers (queue/list views) see the latest cover. Returns presigned GET URLs for the new rows so the simulator renders without a full refetch.
  - `src/app/api/production-items/[id]/media/[mediaId]/route.ts` — DELETE. Drops the row, recomputes the legacy single-cover columns from the new index 0 (or nulls them when empty). **Does not delete the S3 object** — the same `s3_key` may be referenced by another item (reposts share keys). Orphan-cleanup is a separate concern.
- **Per-platform rules** (encoded in `validateMediaForPostType`):
  - `x`: combined ≤4 photos OR ≤1 video, no mixing.
  - `instagram_post`: combined ≤10 items, photos and videos can mix freely (Meta carousel limit).
  - `instagram_reel`: exactly 1 video, no photos.
  - `instagram_story`: exactly 1 photo OR 1 video.
  - Other post types refuse manual upload (explicit allowlist — adding LinkedIn/TikTok/YouTube means extending the validator + `dropZoneOptionsForPostType`).
- **Per-platform dropzone config** (`dropZoneOptionsForPostType` in `src/lib/services/draft-media.ts`) supplies the file-picker `accept` string + max-total + the "Add ..." button label per post type. Drives client-side UI; server-side validator is the source of truth.
- **Refuses on published items:** both routes check `item.status === "Published"` and return 400. Server-side gate is the source of truth; client also hides the dropzone via the `editable` prop.
- **No worker, no background job.** The browser does presign → PUT → confirm in three round-trips; the simulator drops in a placeholder + spinner per file and refetches on success.

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
| Item's `publishedAt` differs on a later SC sync | Sync no longer corrects the stamp on UPDATE (per insert-only policy added 2026-04-25), so no re-scheduling happens. The original schedule from INSERT stands. If `publishedAt` was wrong at INSERT time, the per-checkpoint in-window check at fire time skips out-of-window jobs |
| Item deleted between schedule and fire | Task's `deletedAt` guard skips; no SC call |
| Item un-published between schedule and fire | Task's `status !== 'Published'` guard skips; no SC call |
| Job retries past its window (rare) | Task's age-within-window guard rejects; no SC call; no misleading row |
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
| `src/lib/services/account-content-sync.ts` | UPDATE (existing post re-synced) | _no-op since 2026-04-25_ — UPDATE branch does not re-schedule; publishedAt is now insert-only |
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

### Cross-post candidate queue (v3) — live percentile-within-format view
- **Trigger:** none. `selectCrossPostCandidates({ brand })` runs synchronously on every `GET /api/cross-post-queue?brand=…` (the Cross-post tab fetches it on page load). No graphile-worker task, no cron.
- **Files:** `src/lib/services/cross-post-candidates.ts` (algorithm), `src/app/api/cross-post-queue/route.ts` (entry), `src/components/dashboard/cross-post-queue-table.tsx` + `cross-post-triage-dialog.tsx` (UI), `src/lib/cross-post-compat.ts` (still the source of truth for which target post types are eligible).
- **Inputs:** `productionItems.views` (kept fresh by `performance-decay`'s decay-tier sync — <6h stale for items <7d old); `contentEvents` rows of type `cross_post_dismissed` (30-day TTL hide-list).
- **Outputs:** read-only response. The actual cross-post production items are created on click via `POST /api/production-items/[id]/cross-post` with `assign:true`, which lands them as `Assigned` rows for an editor.
- **Rules:**
  - **Candidate window:** published items from the last 21 days. `sourceType` ∈ {`original`, `repurposed`, `repost`} — `cross_post` is excluded (no recursion). Notion-authoritative post types (long-form YT pillars) excluded.
  - **Cohort:** same `format` over the last 90 days, cross-brand. Lifetime cohort floor is 0 (a brand-new format with one prior post still gets a noisy P60 — operators dismiss what they don't want); per-checkpoint cohort floor is 5 (velocity baselines need at least a handful of points to be meaningful). Formats with no cohort at all auto-admit and are tagged `NEW` in the badge.
  - **Hotness signals:** for each candidate we compute up to two flavors of ratio and take the strongest:
    - **Lifetime** — cumulative `views` ÷ format's lifetime P60.
    - **Velocity** — for each `view_snapshots.checkpoint_key` available on the candidate (15m / 30m / 1h / 2h / 4h / 8h / 24h / 48h), `views_at_checkpoint` ÷ format's same-checkpoint P60.
  - **Admission:** max ratio ≥ 1.0× (or auto-admit when no cohort exists). Sort by max ratio desc. The top signal drives the badge label (`8.7× 1h` vs `1.8× lifetime`) and a `whyHot` explainer string is computed server-side and surfaced in the modal + tooltip.
  - **Why P60 instead of P75:** young posts haven't had time to accumulate the lifetime views that the 90-day cohort has, so the lifetime gate is biased against them. P60 partly compensates without flooding the queue. Velocity comparisons are age-fair (snapshot-vs-snapshot) and not affected.
  - **Already-done dedup:** drop a candidate if every eligible `(target account, target post type)` pair already has a `productionItems` row with `sourceType='cross_post'` and `repostedFromItemId = candidate.id`. Modal still shows partially-done state (per-target disabled cards) when some targets remain.
  - **Dismissal:** "Not interested" → `POST /api/production-items/[id]/cross-post-dismiss` writes a `contentEvents` row with `type='cross_post_dismissed'`. The candidate selector hides it for 30 days; after that it can resurface if it's still hot.
  - **Format compat:** unchanged from v2 — `compatibleTargetsFor()` matrix gates which target post types appear as cards in the modal.

### v2 cross-post scanner (`cross-post-scan`) — REMOVED 2026-05-02
v2 (LLM-recommended source × target pairs admitted to the queue at ≥70 confidence) was retired in favor of the v3 candidate queue above. `runCrossPostScan`, `cross-post-recommend.ts`, the manual `/api/cross-post-scan` route, the graphile-worker task, and `scripts/run-cross-post-scan.mjs` are all deleted. `cross_post_decisions`, `crossPostFitVerdicts`, `crossPostRules`, and `productionItems.crossPostConfidence` remain for historical reads (retrospective at `/[brand]/accounts/cross-posting`); see Planned-removal in `docs/features.md`.

### `account-refresh-sweep` — weekly metadata refresh
- **Trigger:** cron `0 17 * * 1` (Mondays 17:00 UTC)
- **Files:** `src/jobs/tasks/scheduled.ts:125-147`
- **Inputs:** active `accounts` on SC-supported platforms (`youtube, instagram, x, tiktok, linkedin, threads`)
- **Outputs:** enqueues one `account-refresh` job per account, `jobKey: account-refresh-{id}`
- **Downstream:** `account-refresh`
- **Rules:** explicitly skips `newsletter` and `other` (no SC coverage)

### `daily-scorecard-email` — daily publish-count scorecard
- **Trigger:** cron `0 13 * * *` (13:00 UTC daily). 9am EDT during DST,
  8am EST in winter — see DST note in `src/jobs/crontab.ts`.
- **Files:** `src/jobs/tasks/scheduled.ts` (`dailyScorecardEmailTask`),
  `src/lib/services/scorecard.ts` (data),
  `src/lib/email-templates/daily-scorecard.ts` (rendering),
  `src/lib/email.ts` (`sendDailyScorecardEmail`)
- **Inputs:** rolling 7-day publish counts (`publishedDate` in [today−7, today)
  vs [today−14, today−7)). Recipients = users with
  `daily_scorecard_email_enabled = true`.
- **Outputs:** one Postmark `outbound` send per recipient. No DB writes.
- **Downstream:** none.
- **Preview / dogfood:** admin-only `GET /api/admin/scorecard-email/preview`
  renders the HTML in-browser; append `?send=me` to send the rendered
  email to the logged-in admin's address (real Postmark hit).
- **Recipient gate:** the column is the source of truth — `role='admin'`
  is not re-checked at send time. If a non-admin gets the flag set, they
  get the email. Toggle from `/settings/users` (admin-only UI) or via
  direct SQL.
- **Failure mode:** each send is wrapped; one Postmark failure increments
  the `failed` counter and logs but does not starve the rest of the batch.
  The whole task is retried by graphile-worker on uncaught exceptions
  (e.g. DB unavailable), but a per-recipient failure does not retry.

### `sc-credits-watch` — Scrape Creators credit-exhaustion alert
- **Trigger:** cron `*/15 * * * *` (every 15 minutes).
- **Files:** `src/jobs/tasks/scheduled.ts` (`scCreditsWatchTask`),
  `src/lib/services/sc-credits-watch.ts` (detection + dedupe),
  `src/lib/email.ts` (`sendScCreditsExhaustedEmail`)
- **Inputs:** `sc_call_log` rows in the last hour where `ok=false` and
  notes match `%out of credits%` or `%(402)%`.
- **Outputs:**
  - Email to every `daily_scorecard_email_enabled` user (same admin
    notification list as the daily scorecard).
  - One `sync_logs` row with `sync_type='sc-credits-alert'` per send for
    dedupe — the next 4 hours of ticks read this and skip emailing.
  - Drives the dashboard banner indirectly: `/api/sc-credits-status`
    reads the same detection helper and `<ScCreditsBanner>` polls it
    every 60s on every dashboard page.
- **Downstream:** none. The banner clears itself the moment SC starts
  returning 200s again — no manual reset needed.
- **Why every 15 min and not the 60s the banner polls:** the banner is
  the user-facing surface (instant visibility); the cron's only job is
  to send one Postmark on state transition, where 15-min granularity is
  fine and avoids hammering Postmark on flapping.

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
  - **LinkedIn OG image fallback (V1.4, 2026-05-09):** when SC's `/v1/linkedin/post` returns empty `images[]` AND no `thumbnail` / `thumbnailUrl`, the LinkedIn enricher fetches the post URL itself (5s timeout, ~64 KB read cap) and parses `<meta property="og:image">` from the head as a final fallback before giving up on media. Best-effort: failures log a `console.warn` and never block enrichment. Closes the gap where SC under-reports media on some LinkedIn share variants.

### `extract-hook` — gpt-4.1-mini hook extraction
- **Trigger:** enqueued by `hook-extract-sweep`
- **Files:** `src/jobs/tasks/extract-hook.ts`, `src/lib/services/hook-extract/orchestrator.ts`
- **Inputs:** `{ productionItemId }`
- **Outputs:** `productionItems.hook` (verbatim opening line), `hookExtractedAt`, `hookSource='llm'`
- **Downstream:** none
- **Rules:**
  - Feeds only the opening 20s of the transcript to the model
  - **Substring-match validation** rejects hallucinated rewordings (normalize whitespace + case)
  - Migrated 2026-05-02 from `claude-haiku-4-5` to OpenAI `gpt-4.1-mini`. Largely deprecated in favor of the unified `dispatch-hook` path

### `hook-fallback` — fill hooks without LLM
- **Trigger:** enqueued by `hook-fallback-sweep`
- **Files:** `src/jobs/tasks/hook-fallback.ts`, `src/lib/services/hook-extract/fallback.ts` (`applyFallbackHookForItem`)
- **Inputs:** `{ productionItemId }`
- **Outputs:** `productionItems.hook`, `hookExtractedAt`, `hookSource` (whatever the fallback chose: title, body opening, etc.)
- **Downstream:** none
- **Rules:** never overrides an existing hook — checks `hookExtractedAt IS NULL` at the top

### Overlay text: vision OCR is the only source of truth
- **Where:** `src/lib/services/hook-extract/vision.ts` (`extractVisionForItem`), via `vision-extract` per-item task and the scheduled `vision-extract-sweep` (cron `55 * * * *` in `src/jobs/crontab.ts`)
- **What:** gpt-4.1-mini (vision) reads the bold burn-in text painted onto the cover image and writes it verbatim to `productionItems.overlay`, plus to `hook` (when the existing hook source is overwritable: null/title/content_body) with `hookSource='vision'`. Migrated 2026-05-02 from `claude-haiku-4-5`.
- **Why this is the only path:** an earlier attempt (2026-05-01, reverted) trusted `title` as a proxy for the on-video overlay for "Reel: Repackage Section w/ Hook" items. Spot checks against the rendered cover proved title is unreliable — often it's the caption's first sentence or a draft framing, not the overlay. The overlay text only exists in the rendered video frame; OCR is the only way to read it
- **One-shot recovery:** `scripts/revert-repackage-overlay-backfill.mjs` (clears the bad rows) + `scripts/enqueue-vision-for-repackage.mjs` (fans out vision-extract for IG Repackage items with a poster). Going forward the cron picks up new posts hourly
- **Permanent OpenAI 400s** (unsupported image format, broken image, etc.) are caught and treated as a skipped extraction so `visionExtractedAt` still gets stamped — otherwise the same bad poster would burn the full retry budget every sweep.
- **Non-image poster guard:** before calling vision, the extractor checks `posterS3Key`'s extension and short-circuits to a skip+stamp if it's not jpg/png/webp/gif/heic/avif. Legacy rows (pre-2026-05) can have a video key in `posterS3Key` because the media-confirm route used to fall back to `s3Key` for video slides — see HUBANDSPOKE-J (Sentry).

### `extract-poster-sweep` — ffmpeg poster fallback
- **Trigger:** cron `35 * * * *`
- **Files:** `src/jobs/tasks/scheduled.ts` (`extractPosterSweepTask`), `src/jobs/tasks/extract-poster.ts` (per-item task + `selectExtractPosterCandidates`), `src/jobs/tasks/poster-extract-pipeline.ts` (worker-only ffmpeg helper)
- **Inputs:** Published short-form items (`instagram_reel`, `instagram_post`, `tiktok`, `youtube_shorts`) where `mediaS3Key IS NOT NULL AND posterS3Key IS NULL`. Ordered by views DESC, batch 50.
- **Outputs:** enqueues one `extract-poster` job per candidate, `jobKey: extract-poster-{id}`, `jobKeyMode: unsafe_dedupe`
- **Why:** IG's Scrape Creators response sometimes omits `display_url`; without a poster, vision OCR can't run and the hook stays null. Frame 0 of the archived .mp4 IS the cover with overlay — same image vision needs.
- **Sequencing:** runs after `enrichment-sweep` (`:20`, archives the .mp4) and before `vision-extract-sweep` (`:55`, OCRs the poster), so a freshly-enriched reel can land all three steps in a single hour.

### `extract-poster` — frame 0 → S3 JPEG
- **Trigger:** enqueued by `extract-poster-sweep`; manual `GET /api/cron/tick?name=extract-poster-sweep`
- **Files:** `src/jobs/tasks/extract-poster.ts`, `src/jobs/tasks/poster-extract-pipeline.ts`
- **Inputs:** `{ productionItemId, force? }`
- **Outputs:** `productionItems.posterS3Key`, `mediaS3Bucket` (if not already set)
- **Rules:**
  - Streams the archived .mp4 from S3 to a tempfile, runs `ffmpeg -ss 0 -i input -frames:v 1 -q:v 2 frame.jpg`, uploads the JPEG to `{prefix}/{itemId}/{uuid}-frame0-poster.jpg`
  - Idempotent on `posterS3Key`: skips when one is already present unless `force=true`
  - 60s ffmpeg timeout, 5 MB cap on extracted frame
  - Backfill: `scripts/enqueue-poster-extract.mjs --apply`

### Clip-idea promotion stamps `hookSource='clip_idea'`
- **Where:** `src/lib/services/promote-clip-idea.ts` — `assignClipIdea`, `createClipIdeaInDescript`, `createClipIdeaInDescriptFullVideo`
- **What:** every promotion path sets `hookSource='clip_idea'`, `hookExtractor='promote-clip-idea:v1'`, `hookExtractedAt=now()` alongside `hook`. Required so the dispatcher's `clip_idea`/`manual` protection actually fires — previously these fields were left null and the dispatcher reprocessed the item, frequently overwriting the clip idea's hook with the IG caption

### Underlord agent prompt — Descript packs (per-format)
- **Tables:** `descript_packs` (id, name, prompt, created/updated_at) — first-class reusable entity. `formats.descript_pack_id` is a nullable FK; null means "no Descript creation allowed for this format" and gates all four clip-triage dropdown items.
- **Where:** `src/lib/services/promote-clip-idea.ts` (`buildDescriptPrompt` + `loadPromotedClipFormat` for the agent path); `src/jobs/tasks/clip-idea-precise-cut.ts` (loads pack via `repurpose_triggers.target_format_id → formats.descript_pack_id → descript_packs.prompt` for the precise-cut layout-apply phase); `src/lib/descript.ts` (`buildLayoutPackPrompt`, `substituteFormatPrompt`).
- **Pack prompt is path-agnostic:** describes what to do *to a composition* (apply layout pack, set hook track, ignore fillers, etc.). Code wraps with path-specific scaffolding — agent path adds "find segment X-Y, create a new comp" preamble; precise-cut adds "apply to compositionId='Y'" preamble. Same pack prompt drives both paths.
- **Placeholders** substituted before sending to Underlord: `{{hook}}`, `{{startTimestamp}}` (HH:MM:SS), `{{endTimestamp}}`, `{{startSec}}`, `{{endSec}}`, `{{durationSec}}`, `{{compositionId}}` (empty on agent path). Unknown placeholders pass through (so typos are visible).
- **Layout-pack URL** lives literally inside the pack prompt as a Descript project URL like `https://web.descript.com/<uuid>` (verified Underlord resolves URLs end-to-end on 2026-05-05). Editing that URL in the pack swaps the layout for every format using the pack on the next promotion — the dynamic-config goal.
- **Gating** (`createClipIdeaInDescript*` + clip-triage UI): all four "Create in Descript" buttons require `format.descript_pack_id` to resolve to a non-null pack. Service throws `FormatMissingDescriptPackError` (caught by all 3 routes → 400) when missing. UI dropdown shows "No Descript pack attached" with a link to the format edit page.
- **Four promotion options surfaced in the clip-triage dropdown** (`src/components/dashboard/clip-triage-dialog.tsx`):

  | Button | Service entrypoint | Underlord called? |
  |---|---|---|
  | Full video — no AI | `createClipIdeaInDescriptFullVideo` | no — pillar composition duplicated, manual trim |
  | Precise cut — no AI | `createClipIdeaInDescriptPreciseCut({ applyLayoutPack: false })` | no — ffmpeg trim + import only |
  | Full video + Underlord | `createClipIdeaInDescript` (agent path) | yes — agent cuts by transcript + applies pack in one call |
  | Precise cut + Underlord | `createClipIdeaInDescriptPreciseCut({ applyLayoutPack: true })` | yes — ffmpeg trim + import, then Underlord applies the pack to the imported composition |

- **Per-promotion opt-in:** the precise-cut layout-apply phase requires both an attached pack on the format AND a per-promotion `applyLayoutPack: true` flag. The flag is plumbed via `?ai=1` on `POST /api/clip-ideas/[id]/create-in-descript-precise` and through the task payload (`ClipIdeaPreciseCutPayload.applyLayoutPack`). The agent-path fall-through (when a clip-idea source has `mediaS3Key` but no Descript project yet) inherits `applyLayoutPack: true` since the user clicked the AI button.
- **Pack management UI:** inline on the format detail page (`/<brand>/formats/<id>`). Picker + create / edit / attach / detach modal in `src/components/dashboard/format-detail.tsx` (`DescriptPackModal`). CRUD via `/api/descript-packs` + `/api/descript-packs/[id]`. Auto-attaches a freshly-created pack to the current format (most common intent).

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
- **Downstream:** none. Clip-idea generation is manual-only — see `generate-clip-ideas` below. (The auto-enqueue here was removed 2026-05-03.)
- **Rules:**
  - **Skips at top if a `transcripts` row with non-empty `fullText` exists** for this item (don't burn another API call).
  - **Short-invocation pattern**: phase 1 finishes with a re-enqueue for phase 2 (1s delay), so a SIGTERM during ffmpeg or Whisper doesn't waste the other half.
  - Uses jobKey `transcribe-whisper:<id>` so back-to-back UI refetch clicks dedupe.
  - **Chunking** handles long-form content (podcasts): each chunk is ≤10 min and stays under OpenAI's 25 MB per-request cap. For chunk N>0 the prompt appends the tail of running fullText so context carries across the cut (helps with mid-sentence splits and keeps name-bias sticky).
  - Extracted audio stays in S3 — enables future re-runs (different model, diarization, vision) without re-downloading the full video. ~5 MB per 24-min video.

### `generate-clip-ideas` — Sonnet clip-idea generation
- **Trigger:** **Manual-only.** The unit of work the `POST /api/production-items/[id]/clip-ideas/generate` route calls inline (after returning 202) when an operator clicks **Generate** on a pillar's Clip Ideas tab; also the unit fanned out by `scripts/backfill-clip-ideas.mjs` for historic pillars. The post-`transcribe-whisper` auto-enqueue was **removed 2026-05-03** after a backfill run burned ~$50 of Sonnet credits in a single night — clip-idea generation is now a deliberate operator action.
- **Files:** `src/jobs/tasks/generate-clip-ideas.ts`, `src/lib/services/clip-idea-generate.ts` (shared by route + task), `src/lib/clip-idea-agent.ts` (Sonnet prompt; V7 since 2026-05-01)
- **Inputs:** `{ productionItemId }`. Performance context comes from `topShortFormPerformers()` in tiered shape — **BLUEPRINT** (top 10 in `Reel: Repackage Section w/ Hook` format with hook + overlay + caption + opening ~25s of the reel's own transcript + engagement) and **BENCH** (top 20 short-form across formats, single-line).
- **V6 prompt change (2026-05-01) — codename "Splice":** the algorithm has a versioned name (`ALGORITHM_NAME = "Splice"`, exposed via `algorithmLabel(promptVersion)` so older rows render as "Splice v5" etc.). The system prompt is prefixed at runtime with a **REFERENCE LIBRARY** of 6–8 sanitized blueprint hooks (URLs/format-name nesting/trailing emoji stripped via `sanitizeHook()`). The verbatim-from-transcript rule is dropped — for the dominant Repackage format the hook is a *narrator overlay* line in brand voice, not a founder quote. Each idea must declare a `blueprintAnchorHook` (verbatim line from REFERENCE LIBRARY whose pattern it mirrors); validation rejects ideas that don't match. The new `blueprint_anchor_hook` column on `clip_ideas` persists this for audit. First-person intros ("My name is", "Hi I'm") are explicit anti-patterns. Manual `POST /api/production-items/[id]/clip-ideas/generate` now passes `force: true` so the Regenerate button overwrites instead of bailing on idempotency.
- **V7 prompt change (2026-05-01) — anchor-quote grounding:** V6 mirrored brand hooks well but kept landing timestamps on host recaps of the guest's point instead of the guest making it (canonical fail: 14yo founder's "psyoped into one path" advice clip pointing at the host's "great advice, Evan" recap 24s later). V7 fixes this by requiring each idea to cite a verbatim `transcriptAnchorQuote` (≥ 8 words, copied from the transcript). The agent layer matches this quote against the word-level transcript (`transcripts.words`), and snaps `startSec`/`endSec` to encompass the matched timestamp when the LLM picked an adjacent range. Ideas whose anchor can't be located or fit into a 25–95s clip are dropped (so a batch may return < 10). Three new columns on `clip_ideas`: `transcript_anchor_quote` and `transcript_anchor_start_sec` (resolved match time). New helper `resolveAnchors()` runs between LLM extraction and final return; on first-pass anchor failures the agent re-prompts once with idea-specific feedback. Eval harness at `scripts/eval-splice-v7.ts` (run with `tsx --env-file=.env.local`) — across 5 SS pillars / 50 ideas, 100% ship rate, ~30–60% first-try-in-range (snapper does the rest). Requires word-level timestamps from `transcribe-whisper`; the prior `source='descript'` transcription path is fully retired (4 stragglers re-transcribed 2026-05-02).
- **Outputs:** N rows in `clip_ideas` (default 10 per pillar) and N paired `production_items` rows (`source_type='repurposed'` since the 2026-05-11 consolidation; was `'clip'` before that, `source_clip_idea_id` back-link, `pillar_content_item_id` → source pillar, `status='Idea'`, `post_type='instagram_reel'`, format = the brand's `formats.is_clip_descript_format=true` row resolved by `getPromotedClipFormat(brand)` in `src/lib/services/promote-clip-idea.ts`; was hardcoded in `PROMOTED_CLIP_FORMAT_BY_BRAND` until 2026-05-11). Each new `production_items` row also gets `utm_campaign` populated via `generateUtmCampaign(hook)` — was missing until 2026-05-09; ~4,500 historic clip rows backfilled via `scripts/backfill-utm-campaigns.mjs`. `clip_ideas.accepted_production_item_id` is wired to the new prod_item row (note: confusingly named — set at *generation*, not on triage acceptance).
- **Downstream:** none directly. The new `Idea`-status rows surface in the brand's `/queue` clip tab; promotion is the operator's call (clip-ideas triage panel).
- **Rules:**
  - **Backfill path gates** on `source_type='original'` AND `post_type='youtube_long'` so historic backfills only act on long-form pillars. Manual route passes `skipPostTypeGate: true` to bypass — operator already chose the pillar.
  - **Idempotent:** any existing `clip_ideas` row for the pillar short-circuits the task (skip status `ideas-already-exist`). Worker retries after a Sonnet timeout / DB blip are safe.
  - Uses jobKey `generate-clip-ideas-<id>` so concurrent manual + backfill enqueues for the same pillar dedupe.
  - Producer/editor on the new prod_item rows: manual route uses the actor; cron/backfill path falls through `resolveAssignees` (source item → format default → brand default → global fallback).
  - Cost: one Sonnet call per pillar (~$0.10). Worker concurrency keeps backfill bursts cheap; ~30 historic pillars ≈ $3 of Sonnet.

### `draft-algorithm-run` — The Draft Algorithm V1.6 (2026-05-10)
- **Trigger:** auto-enqueued from four places — (1) `POST /api/production-items/[id]/cross-post` after the seed-content tx commits, for any post type in `CROSS_POST_SEEDED_TARGETS`; (2) `POST /api/production-items/[id]/repurpose` after the new row + repurpose-trigger inserts (manual repurpose); (3) `threshold-monitor-sweep.ts` after each cron-created `sourceType='repurposed'` row — so derivatives created when a pillar crosses a child format's `viewThreshold` land with a populated draft instead of a blank form; (4) `promote-clip-idea.ts` — every clip-idea promotion path (`assignClipIdea`, `createClipIdeaInDescript`, `createClipIdeaInDescriptPreciseCut`, `createClipIdeaInDescriptFullVideo`) fire-and-forgets after flipping the production_item to `Assigned`, so the new Reel/Short lands with a populated caption instead of a blank field. Also called *synchronously* by `POST /api/production-items/[id]/draft` — the Regenerate button on every simulator caption panel skips the queue and waits for the agent inline (Opus call ~5–10s; route's `maxDuration` is 60s). **Repost does not fire** — the seeded `copy:source` body is kept verbatim because same-content same-platform doesn't benefit from a rewrite.
- **Files:** `src/jobs/tasks/draft-algorithm-run.ts`, `src/lib/services/draft-algorithm/run.ts`, `src/lib/services/draft-algorithm/exemplars.ts`, `src/lib/draft-agent.ts` (the underlying Opus agent — unchanged), `src/app/api/production-items/[id]/draft/route.ts`. **Forwarder:** `src/jobs/tasks/generate-instagram-caption.ts` is kept under the old task name so any in-flight `generate-instagram-caption` jobs in `graphile_worker.jobs` resolve to the new algorithm; safe to delete in V2 once queue has drained.
- **Inputs:** `{ productionItemId, force? }`. Service loads (a) the pillar transcript via `getTranscriptForPrompt(item.pillarContentItemId ?? item.id)`, (b) `formats.instructions` for editorial voice, (c) up to 8 **view-ranked, format-scoped-first** published `productionItems.contentBody` rows. **V1.2 exemplar policy:** the helper first pulls rows where `lower(format) = lower(item.format)` AND `(brand, post_type)` match AND `published_at > now() - 180 days`, ordered `views DESC NULLS LAST`. If fewer than 5 format-scoped winners exist, the bag is topped up to 8 with platform-scoped rows (v1.1's brand+post_type filter, excluding the format ids already pulled). The two groups are tagged via a `source: "format" | "platform"` discriminator on `PastCaptionExample` — the prompt builder renders them as separate labeled blocks (`## TOP-PERFORMING EXAMPLES IN THIS FORMAT — "<format name>"` vs `## OTHER STRONG EXAMPLES ON THIS PLATFORM`). The system prompt's STRUCTURE RULE points only at the format block: "mirror recurring structural patterns (timestamp breakdowns, listicles) when the format examples share one." Platform-scoped rows stay voice/tone reference. Whole premise: structure lives at the format level — see HUBANDSPOKE issue / Pat's screenshot of Full Video On X! tweets that all open with a hook + bulleted timestamps.
- **Outputs:** a new `contentDrafts` row via the demote-then-insert tx (current row → `is_current=false`, new row → `is_current=true`, same `production_item_id`, version+1). `generatedBy = "draft-algo:v1.6:claude-opus-4-7:v9"` — the `draft-algo:v1.4` prefix tags the algorithm version, the suffix carries the underlying agent model+prompt version (`PROMPT_VERSION` bumped to 7 for the rich-substrate directive + `itemAlreadyHasMedia` rendering — see Substrate rule below). `modelUsage` populated. **V1.1 media write still active:** if the agent's `media_action` is `attach_pillar_full_video` or `attach_pillar_poster` AND the item has zero existing `production_item_media` rows AND the action is fulfillable (pillar has the asset, platform rule accepts the kind), the algorithm inserts a media row pointing at the pillar's S3 key (byte-cost zero — same bucket reuse) inside the same tx, and mirrors `mediaS3Key/Bucket/ContentType/posterS3Key` on `productionItems` to keep legacy single-media columns consistent.
- **Downstream:** none.
- **Rules:**
  - **Source-type branch:** `repost` skips with `repost_kept_verbatim`; `original` with no `pillarContentItemId` (= a true pillar item) skips with `pillar_item_no_draft`; `cross_post`, `repurposed` (covers both threshold-monitor cron auto-spawns AND clip-idea-promoted rows — the latter set `sourceClipIdeaId`), and `original`-with-pillar (manually-created repurpose) all fall through and draft.
  - **V1.1 media-action enum:** the agent emits `media_action ∈ {attach_pillar_full_video, attach_pillar_poster, none}`. Decision is driven by the format **Skill** (the `formats.instructions` text) — directives like *"This tweet should have the full video from YouTube as the media of the tweet"* translate to `attach_pillar_full_video`. The service skips the attach silently if the item already has any media (preserves manual edits and makes Redraft idempotent), if the pillar lacks the requested asset, or if the platform rule rejects the implied kind.
  - **V1 supported post types** (everything else skips with `unsupported_post_type`): `x`, `linkedin`, `instagram_post`, `instagram_reel`, `instagram_story`, `tiktok`, `youtube_community`, `youtube_shorts`, `threads`. Newsletter + youtube_long are out of scope — editors hand-write those today.
  - **Idempotency:** skips with `reason="already_filled"` when the current draft has a non-empty primary caption AND `generatedBy !== "copy:source"` AND `force=false`. Auto-fire overwrites the seeded `copy:source` body; manual Regenerate button passes `force=true` when an existing caption is present.
  - **Substrate (V1.4):** the agent grounds its draft in either (a) the upstream's transcript when one exists (long-form pillar derivatives — unchanged path) or (b) the upstream's `contentBody`, falling back to `description` (LinkedIn long-form bodies live in this column — SC routinely returns the multi-paragraph LinkedIn body under `data.description` rather than `data.text/bodyText/postBody/headline`, and the LinkedIn enricher writes it through unchanged), then `title`. Upstream resolution chain is `pillarContentItemId ?? repostedFromItemId ?? item.id` — V1.2 was missing the `repostedFromItemId` step, so cross-posts always fell through to `item.id` (the just-created empty new row) and skipped with `no_transcript`. **Skip code is `no_substrate`** and only fires when transcript, body, description, AND title are all empty across the chain. Auto-fire silently no-ops on `no_substrate`; manual route returns 400 with a friendly message.
  - **Rich-substrate prompt directive (V1.4):** when the resolved `source_body` substrate is ≥120 characters or contains a newline, the SOURCE POST BODY block tells the agent to *pull EVERY concrete element* (every list item, every numbered example, every named person, the hook AND the closing) into the new post — not just echo the opener. Short-substrate fallbacks keep the softer "adapt this" wording.
  - **`itemAlreadyHasMedia` (V1.4):** the algorithm queries `production_item_media` rows on the target item before calling the agent and surfaces `{ count, kinds }` in `MediaContext`. Cross-posts inherit source media via `seedRepostContent` *before* the algorithm fires, so this signal tells the agent the post will publish with N images already attached and to pick `media_action="none"` (the system prompt's MEDIA ACTION RULES enforce this). Without the signal the agent had no idea the source-mirrored media existed and could try to attach pillar media on top.
  - **Agentic tool loop (V1.5, 2026-05-10):** `generateDraft` is no longer a single-shot `messages.create` with `tool_choice` forcing `propose_draft`. It's now a loop (max 5 iterations) with `tool_choice: "auto"` — the agent picks tool calls itself. Specialized tools run as separate Anthropic calls and return their results to the main agent via `tool_result` messages; the main agent calls `propose_draft` as its terminal action. Architecture supports adding more tools (e.g. `find_money_quote`, `find_image_moment`) as one-file changes inside the same loop. Loop bounds: typical drafts run 1–2 iterations (zero or one tool call + the propose_draft); the 5-iteration cap throws so runaway tool-loops are visible in Sentry. Token usage on `content_drafts.modelUsage` accumulates across iterations.
  - **First specialized tool: `find_interesting_timestamps` (V1.5).** Lives in `src/lib/services/draft-algorithm/timestamp-finder.ts`. Registered in the agent's `tools[]` only when `substrate.kind === "transcript"` (cross-posts using source-body substrate skip the tool entirely — single-shot exactly like v1.4). The tool runs a separate Opus 4.7 sub-agent with the raw `transcripts.segments` jsonb array (not just the rendered markdown) and returns `Array<{ mmss, label, reason }>` with N validated picks. Each `mmss` is post-validated against the segments — out-of-range values are dropped with a `console.warn` so the main agent never sees fabricated timestamps. Cost: ~$0.015/call, so a transcript-bearing draft that triggers the tool is ~$0.045 vs $0.03 for tool-less drafts. Pat picked Opus deliberately for editorial judgment ("what's interesting" needs nuance).
  - **On-demand exemplar enrichment (V1.6, 2026-05-10):** the format-scoped exemplars query no longer pre-filters on `contentBody IS NOT NULL`. It pulls the top N by views regardless, then on-demand calls `enrichSingleItem` on any row missing a body — in parallel, capped at 10 seconds total wall time. Pre-v1.6 the algorithm silently skipped top-performer items that hadn't been enriched yet (e.g. the 373K-view "Full Video On X!" tweet was sitting in the DB unenriched and never reaching the agent — see Pat's audit). Rows that still have no body after the enrichment pass are dropped with a `console.warn` listing their ids. Platform-scoped top-up rows keep the contentBody filter (no enrichment) to bound SC credit cost — they're voice/tone reference, not structural.
  - **Skill-count adherence (V1.6):** the system prompt's TOOLS section now spells out that when the format Skill specifies a count (e.g. "4-6 timestamp bulletpoints"), the agent must pass that count to `find_interesting_timestamps` and retry ONCE with a broader focus if the tool short-returns. The `tool_result` body now carries `{ requestedCount, validatedCount, timestamps, note? }` so the agent has structured numbers to reason about rather than counting an array by eyeballing.
  - **Diagnostic logging (V1.6):** worker logs now print, per draft, `draft-algorithm v1.6 item=<id> format="<name>" substrate=<kind> skill_chars=<n> skill_head="<first 160 chars>"` and `exemplars_format=<n> exemplars_platform=<n>`. Plus per tool call: `draft-agent v1.6 tool=find_interesting_timestamps iter=<i> focus="..." count=N` and `timestamp-finder: focus="..." requested=N validated=M (dropped K)`. Lets Pat audit Skill-reading and tool-counting end-to-end via `heroku logs --dyno worker --tail | grep draft`.
  - **Prompt caching:** `cache_control: { type: "ephemeral" }` markers on the system prompt and the format-stable preamble (target platform + field schema + `formatInstructions` + past captions). Transcript stays uncached because it's per-item. Regenerate within 5 minutes reads the cached prefix.
  - **Cost:** ~$0.03 per Opus call. Caching takes a chunk off the input tokens on Regenerate.

### `descript-clip-resolve` — poll Descript clip-out
- **Trigger:** enqueued by `POST /api/descript/clip-out`; enqueued by `promote-clip-idea` service (agent flow + full-video flow)
- **Files:** `src/jobs/tasks/descript-clip-resolve.ts`
- **Inputs:** `{ triggerId, jobId, derivativeItemId?, pillarItemId?, importMode?, deadlineAt? }`
- **Outputs:** `repurposeTriggers.descriptCompositionId`; if `derivativeItemId`, also `productionItems.descriptCompositionId` on the derivative; if `pillarItemId` + `importMode`, also stamps composition on the pillar so future full-video clips skip the upload. Inserts a `tool_action` row into `content_events` (tool=`descript`, action=`clip_created`) so the activity feed surfaces the completion with an "Open in Descript" link.
- **Downstream:** none
- **Rules:**
  - Polls every 5s, 10-min deadline; short-invocation re-enqueue
  - `importMode=true` switches the result parse from `agent_response` (regex) to `created_compositions[0].id` (used by the cold full-video upload path)

### `clip-idea-precise-cut` — ffmpeg trim + Descript import + (optional) Underlord layout-pack apply
- **Trigger:** enqueued by `promote-clip-idea` service from two button paths in the clip-triage dialog: "Precise cut — no AI" (`applyLayoutPack=false`) and "Precise cut + Underlord" (`applyLayoutPack=true`). Same task, same payload shape, different terminal behavior.
- **Files:** `src/jobs/tasks/clip-idea-precise-cut.ts`
- **Inputs:** `{ clipIdeaId, triggerId, derivativeItemId, uploadJobId?, layoutJobId?, applyLayoutPack?, deadlineAt? }`
- **Outputs:**
  - Phase 1 (no `uploadJobId`, no `layoutJobId`): download source from S3, ffmpeg-trim to [startSec, endSec], **re-upload the trimmed mp4 to a temp S3 key (`<prefix>/clip-tmp/<clipIdeaId>/<uuid>.mp4`)**, then call `createDescriptProjectFromUrl` with a presigned GET URL so Descript pulls the bytes itself. Save `descriptJobId` + `descriptProjectUrl` to `repurposeTriggers`; save `descriptProjectId` + URL to `productionItems`. (We previously used Descript's signed-PUT path — `createDescriptProjectWithUpload` + PUT bytes — but Descript's importer started rejecting those uploads with a generic "Import failed" 1–2s after PUT, even for synthetic test patterns; verified 2026-05-05. URL-fetch path is what the cold full-video flow already uses and remains stable.)
  - Phase 2 (`uploadJobId` set): poll import, save composition ID to both tables, and insert a `tool_action` row into `content_events` (tool=`descript`, action=`clip_created`, meta.importPath=`precise-cut`) so the activity feed shows the completion. When `applyLayoutPack=true` AND `DESCRIPT_LAYOUT_PACK_NAME` is enabled, invoke Underlord against the new project with `buildLayoutPackPrompt()` to apply the pack + mark fillers, save the prompt to `repurposeTriggers.descriptPrompt`, and re-enqueue with `layoutJobId`. Otherwise the task ends here.
  - Phase 3 (`layoutJobId` set): poll the layout-apply Underlord job. Composition ID is unchanged (Underlord mutates in place), so this phase is purely status-watching — exits when the job stops.
- **Downstream:** none
- **Rules:**
  - ffmpeg always re-encodes (libx264 veryfast + AAC). The previous stream-copy fast path was removed 2026-05-05; turned out the actual culprit was Descript's signed-PUT path, but always-re-encode is also the cleaner default.
  - 30-min deadline per Descript job (import OR layout-apply); each phase carries its own `deadlineAt`
  - Short-invocation re-enqueue
  - Layout-apply phase is opt-in per-promotion via `applyLayoutPack` (route reads `?ai=1`) AND requires `DESCRIPT_LAYOUT_PACK_NAME` to resolve to a non-empty value. Either gate set false → no Underlord call.

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

### `typefully-create-draft` — auto-create Typefully draft for new X/LinkedIn items
- **Trigger:** enqueued from `POST /api/production-items` after insert when `postType` is `x` or `linkedin` AND `publishedLink` is null. Also enqueueable on demand via `POST /api/production-items/[id]/typefully-redrive`.
- **Files:** `src/jobs/tasks/typefully-create-draft.ts`, `src/lib/typefully.ts`
- **Inputs:** `{ productionItemId }` — task re-fetches the item + the owning account
- **Outputs:** Typefully draft created via `POST /v2/social-sets/{id}/drafts`; populates `production_items.typefully_draft_id`, `typefully_status`, `typefully_share_url`, `typefully_private_url`. Also inserts a `tool_action` row into `content_events` (tool=`typefully`, action=`draft_created`) so the activity feed surfaces the new draft with an "Open in Typefully" link.
- **Downstream:** `/api/webhooks/typefully` keeps `typefully_status`, `typefully_scheduled_date`, `typefully_published_at` synced as the user moves the draft inside Typefully
- **Rules:**
  - Soft-skips (returns without throwing) when: item missing, draft already exists, postType isn't x/linkedin, publishedLink set, contentBody empty, account has no `typefullySocialSetId`
  - Hard-fails (throws → graphile retries) on Typefully API errors
  - Idempotent: re-running on an item with `typefully_draft_id` set is a noop

---

## Lifecycle views

### Post lifecycle

How a `productionItems` row evolves end-to-end. Use this section when
debugging "why didn't X happen to this post". For the rules that decide
which `sourceType` a row gets at creation, see
`docs/post-classification.md`.

**Creation paths:**
| Source | sourceType | When | Status starts as |
|---|---|---|---|
| Notion sync | `original` | every :30 cron, YouTube long-form only | inherited from Notion |
| Manual API (`POST /api/production-items`) | `original` | UI form, for platforms API can't pull from | `Idea` or `Queue` |
| Repost (`POST .../repost`) | `repost` | user button | `Idea` |
| Cross-post (manual `POST .../cross-post`) | `cross_post` | user button (body: `targetAccountId` + `targetPostType`; v3 modal also passes `assign:true`) | `Idea` (default) or `Assigned` when v3 modal sets `assign:true` |
| Clip generation — manual only (`POST /api/production-items/[id]/clip-ideas/generate`) | `clip` | admin clicks "Generate 10 ideas" on a pillar's Clip Ideas tab. The previous post-transcript auto-enqueue was removed 2026-05-03 | `Idea` |
| Clip promotion (`POST /api/clip-ideas/[id]/triage` or `.../create-in-descript[-precise]`) | `clip` | user accepts an existing clip-idea | flips pre-created row from `Idea` → `Assigned` (no new insert) |
| Threshold-based auto-repurpose (`threshold-monitor-sweep` cron) | `repurposed` | hourly :15, when parent views cross a child format's `viewThreshold` | `Idea` |

**After publication (status = `Published`):**
1. **Hour :00** — `performance-decay` may fetch metrics (decay-tier-gated)
2. **Hour :15** — `threshold-monitor-sweep` may auto-create one or more repurposed `Idea` rows if `views` crossed a child format's `viewThreshold`
3. **Hour :20** — `enrichment-sweep` queues `enrich-item` if `enrichment_completed_at IS NULL`
4. **`enrich-item`** writes platform-specific fields. **If it produces `mediaS3Key`** → auto-enqueues `transcribe-whisper`
5. **YouTube only**: every 20 min, `youtube-download-sweep` queues `youtube-download` if no `mediaS3Key` yet. On success → auto-enqueues `transcribe-whisper`
6. **`transcribe-whisper`** runs 2 phases (ffmpeg audio extract → OpenAI Whisper API), ends with `transcripts` row. Clip ideas are no longer auto-generated; an operator clicks **Generate** on the pillar's Clip Ideas tab when wanted (auto-enqueue removed 2026-05-03).
7. **Hour :40** — `hook-extract-sweep` queues `extract-hook` if short-form + has transcript + no hook yet
8. **Hour :50** — `hook-fallback-sweep` queues `hook-fallback` for everything not covered by the LLM sweep
9. **Daily 15:00** — `evergreen-scan` may classify isEvergreen and refill Idea queue
10. **Continuously** — once `views` crosses the format's P75 within 7 days of publish, the post appears in the v3 cross-post candidate queue (`/[brand]/queue` Cross-post tab) until an operator cross-posts every eligible target or dismisses it.

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
- `transcribe-whisper` — exits if a `transcripts` row with non-empty `fullText` exists
- `enrich-item` — exits if `enrichmentCompletedAt` set (unless `force`)
- `youtube-download` — exits if `mediaS3Key` set (unless `force`)
- `hook-fallback` — only writes if `hookExtractedAt IS NULL`
- `notification-send` — only sends if `emailedAt IS NULL`

### Dedupe across overlapping sweeps
Sweep parents enqueue children with `jobKey: <name>-{id}` and `jobKeyMode: "unsafe_dedupe"` so a tick that overlaps an in-flight job won't double-fan-out. Affected: `enrichment-sweep`, `hook-extract-sweep`, `hook-fallback-sweep`, `youtube-download-sweep`, `account-refresh-sweep`.

### Hook hierarchy (don't override)
`hookExtractedAt IS NULL` is the gate for both LLM and fallback paths. Manual hooks (set in the UI), clip-idea-derived hooks, and the LLM hook all stamp it; the fallback never overrides a populated value.

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
| Scrape Creators | `performance-decay`, `account-content-sync`, `enrich-item`, `account-refresh`, `instagram-body-fetch.ts`, `tweet-body-fetch.ts` | ~1 credit per call; enrichment with media (`withMedia=true`) is ~10; `account-content-sync` with `mode=backfill` spends up to `maxPages` credits per account. Per-task spend is logged to `sc_call_log` (since 2026-04-27) and visible at `/admin/sc-usage` |
| Descript | `descript-clip-resolve`, `clip-idea-precise-cut` | Per-project API calls — used for clip editing only (transcript path moved to OpenAI Whisper 2026-04) |
| OpenAI (Whisper) | `transcribe-whisper` | `whisper-1` at $0.006/min ⇒ ~$0.14 per 24-min video; kill-switch via `WHISPER_TRANSCRIBE_LIVE=false` |
| OpenAI (gpt-4.1-mini) | `extract-hook`, `dispatch-hook`, `vision-extract`, `repurpose-agent`, `evergreen-scan` (`classifyEvergreen` + `judgeRepostFit`), `cross-post-fit-classifier`, summary route, format/repost backfill scripts | Hook extraction ~$0.0005/item; classifier calls similar. Migrated 2026-05-02 from Anthropic Haiku |
| Anthropic (Claude Sonnet 4.6) | `generate-clip-ideas` | The Splice clip-idea algorithm; ~$0.10 per pillar |
| Anthropic (Claude Opus 4.7) | draft-gen | Per-platform draft copywriting; ~$0.03 per draft |
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

## Error tracking (Sentry)

Both dynos report unhandled errors to Sentry — org `pat-walls`, project
`hubandspoke` (https://pat-walls.sentry.io/issues/?project=hubandspoke).

- **Web dyno:** Next.js auto-instrumentation via `@sentry/nextjs` (configs in
  `sentry.{server,edge}.config.ts`, `src/instrumentation.ts`,
  `src/instrumentation-client.ts`, plus `src/app/global-error.tsx` for the
  client error boundary).
- **Worker dyno:** `src/jobs/instrument.ts` initializes `@sentry/node` at the
  top of `worker.ts`. The worker explicitly captures:
  - **Permanent task failures** (max attempts exhausted) via the
    `job:failed` event — tagged with `task` and `source: graphile-worker`.
    Transient errors that succeed on retry are intentionally **not** captured
    to keep signal high.
  - **Fatal worker crashes** (anything that escapes `main()`), with
    `Sentry.flush()` before exit so the event isn't lost on dyno restart.

DSN is hardcoded in the config files (DSNs are public identifiers by design).
Source maps are uploaded by `withSentryConfig` in `next.config.ts` for prod
builds.

**Local dev is muted:** every `Sentry.init` is gated. Server-side configs
(`sentry.{server,edge}.config.ts`, `src/jobs/instrument.ts`) only init when
`process.env.DYNO` is set (i.e. running on Heroku). The client config
(`src/instrumentation-client.ts`) gates on `process.env.NODE_ENV === "production"`,
which Next.js inlines at build time. Without these gates, a local crash with
`NODE_ENV` unset gets reported tagged `environment: production` because that
is Sentry's fallback default — see HUBANDSPOKE-M for the incident that
prompted this. Override locally by setting `DYNO=local` if you need to test
Sentry capture.

---

## Item-creation provenance (2026-05-11)

Every `production_items` insert site now sets a `created_via` string on
the row AND writes a `content_events` row with `eventType='item_created'`.
The two together answer "where did this item come from?" both at the SQL
level (fast `WHERE created_via = '...'` audits) and per-item (full
`payload` snapshot at the moment of creation, surfaced as the first row
of the Activity tab).

Helper: `recordItemCreated` in `src/lib/services/item-created.ts`. Every
insert site calls it inside the same surrounding transaction (when one
exists) or fire-and-forget against `db`. Failures are caught + logged;
they never block the row insert.

Canonical `source` strings:

| source | call site |
|---|---|
| `api:create` | `src/app/api/production-items/route.ts` (manual "Add Post") |
| `api:repost` | `src/app/api/production-items/[id]/repost/route.ts` |
| `api:cross-post` | `src/app/api/production-items/[id]/cross-post/route.ts` |
| `api:repurpose` | `src/app/api/production-items/[id]/repurpose/route.ts` |
| `api:duplicate` | `src/app/api/production-items/[id]/duplicate/route.ts` |
| `sync:account-content` | `src/lib/services/account-content-sync.ts` (cron) |
| `sync:notion` | `src/lib/services/notion-sync.ts` (cron) |
| `cron:threshold-monitor-sweep` | `src/jobs/tasks/threshold-monitor-sweep.ts` |
| `service:clip-promote` | `src/lib/services/promote-clip-idea.ts` (agent + precise-cut paths) |
| `service:clip-promote-full` | `src/lib/services/promote-clip-idea.ts` (full-video path) |
| `service:clip-idea-generate` | `src/lib/services/clip-idea-generate.ts` |
| `legacy:descript-clip-out` | `src/app/api/descript/clip-out/route.ts` (two sub-paths) |

The schema column is nullable; rows created before this commit have
`created_via = NULL`. The Activity-tab renderer falls back gracefully —
no `item_created` event means no "created via" row, no error.

---

## Known seams (future cleanup)

These show up here so changes don't accidentally widen them. Each one
has a row in `docs/features.md`'s cleanup backlog.

- **`MAX_ATTEMPTS = 5` is duplicated** between `enrichment/orchestrator.ts:20` and `youtube-download-sweep.ts:14`. Extract to a shared constant once we touch retry semantics.
- **`selectEnrichmentCandidates()` and the legacy `selectEnrichmentItems()`** in `enrichment/orchestrator.ts` are nearly identical. Legacy path is the in-process loop used by `runEnrichmentSweep()` (called from `/api/cron/enrichment-sweep` with no `itemId`). Consolidate the query builder when we delete the legacy `runEnrichmentSweep` path.
- **No central status-transition state machine.** Validation logic lives in the UI, the PATCH route, and the Notion push-back independently. Adding a new status today requires touching all three.
- **`/api/cron/*` routes** still exist. `tick` is debug; the others (`notion-sync`, `performance-sync`, `enrichment-sweep`) still run their underlying sync inline and are useful for manual re-runs. The old `/api/cron/youtube-sync` + `/api/sync/youtube` routes were removed alongside `matg-sync` — use `/api/cron/tick?name=account-content-sync-sweep` for a manual full-fleet sync.
- **`assignees.ts` resolution chain** is duplicated implicitly: `source item → format → brand defaults → global` repeats in `notion-sync.ts` and the manual creation routes. Extract a single `resolveAssignees()` (already partially exists) and use it everywhere.
