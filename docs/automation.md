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
  * * * * *  worker-heartbeat     → bumps worker_heartbeat.last_seen_at. Read by GET /api/health/worker to detect silent worker wedges.
  *:00  performance-decay         → SC API + Klaviyo Reporting API. Writes views/likes/comments (and opens/clicks/recipients for newsletters). Decay-tier-gated.
  *:15  threshold-monitor-sweep   → in-place scan. Auto-creates repurposed Idea items when views cross format thresholds.
  *:20  enrichment-sweep          → fan-out → enrich-item (per item) → maybe transcribe-whisper
  *:30  notion-sync               → Notion API ⇄ productionItems (YouTube long-form authoritative). NO LONGER writes clicks/leads/sales (sales removed; clicks/leads owned by sync-link-metrics).
  */30  sync-link-metrics         → go.starterstory.com short_links API → productionItems.clicks/leads (the go links are the source of truth for clicks + leads)
  *:40  hook-extract-sweep        → fan-out → extract-hook (per item, gpt-4.1-mini)
  *:50  hook-fallback-sweep       → fan-out → hook-fallback (per item, no LLM)
  */20  youtube-download-sweep    → fan-out → youtube-download → transcribe-whisper
  */30  account-content-sync-sweep → fan-out → account-content-sync (per active SC account, latest mode)
  */10  schedule-reconcile-sweep  → targeted account-content-sync (accounts w/ pending Scheduled items) + runScheduleReconcile() → auto-merge / suggest / needs-attention (date-known items only)
  :50   schedule-nodate-sweep     → same as above but for scheduledNoDate=true items; 60-min cadence, 14-day give-up window
  */30  klaviyo-sync-sweep        → fan-out → klaviyo-sync-account (per active newsletter account with Klaviyo list id)
  15:00 evergreen-scan            → AI classifier + Idea-queue refill
  (per-post) capture-velocity-snapshot → scheduled at publish+{15m,30m,1h,2h,4h,8h,24h,48h} per item; writes one view_snapshots row each
  (live)     cross-post candidate queue → GET /api/cross-post-queue, no scheduled job — runs on every page load of /[brand]/queue Cross-post tab
  Mon 17:00  account-refresh-sweep → fan-out → account-refresh (per account)
  13:00      daily-scorecard-email → HubSpot SMTP (per opted-in user). 9am EDT / 8am EST in winter.
  */15 min   sc-credits-watch       → email Pat + Sam when SC returns HTTP 402 (deduped 4h)
  */15 min   descript-credits-watch → email Pat + Sam when Descript jobs hit "Insufficient AI credits" (deduped 4h)
  *:45       yt-archive-watch       → Sentry issue + email Pat + Sam when YouTube items sit unarchived >12h (home-machine cron down; email deduped 6h)
  (home Mac, hourly) yt-archive launchd cron → archive-yt-local.ts: yt-dlp → prod S3 + prod DB. NOT on the worker dyno — see home-machine/yt-archive/. Runs `--brands=auto` (2026-08-20): brand list resolved from the DB each run = every brand with an active YouTube account, so onboarding a brand in the settings UI is enough
  (home Mac, hourly) H&S OPS LOOP — `/go` (usually via `cx hubandspoke --go`) runs
    `.claude/commands/lap.md` on repeat through the shared fresh-context runner
    (~/.claude/loop-runner.sh, one cold `claude -p "/lap"` per tick, default 1h, model
    pinned to opus via .claude/settings.json). Supervised by the launchd agent
    com.hubandspoke.ops-loop-recovery (every 15m, home-machine/ops-loop-recovery.sh) —
    survives reboots; pause > recovery, always.
    Each lap: web+worker liveness → Sentry (pat-walls) → Heroku dynos/releases/memory +
    router request times → ONE db sweep (queue fatness, _private_tasks tripwire, cron
    last-fired liveness, stuck Descript renders, event storms, sync_log errors,
    exhausted YT downloads, db size/connections) → this-Mac checks (yt-archive exit,
    disk, swap, recovery agent loaded). Thresholds table lives in lap.md.
    SELF-HEALS: documented runbook ops freely (dyno restart, yt-archive kickstart,
    stale-lock clears, keyed Descript re-poll, cron catch-up tick, queue-corruption
    runbook) and small evidence-backed code fixes — ≤~60 lines, tests must pass, at most
    ONE push per lap, recurrence after a push escalates instead of retrying. Everything
    else → Sentry event (fingerprint hubandspoke-health-loop) +
    ~/.claude/hubandspoke-health.log. Stop: kill $(cat .loop.pid); /pause-loops stops all.

USER / API ENTRY POINTS
  POST /api/accounts/[id]/refresh?mode=async              → account-refresh
  POST /api/accounts/[id]/sync-content?mode=latest|backfill → account-content-sync
  POST /api/accounts (new account row)                    → account-content-sync (backfill) + account-refresh
  POST /api/production-items/[id]/transcript/fetch        → transcribe-whisper
  POST /api/uploads/confirm                               → transcribe-whisper
  POST /api/production-items/[id]/repurpose               → draft-algorithm-run (auto-fire after insert)
  POST /api/production-items/[id]/repurpose               → canva-create-copy   (auto-fire when target.is_canva_format AND Skill has brand-template URL)
  POST /api/production-items/[id]/cross-post              → regenerate-cta-for-item (auto-fire after seed, CTA-capable targets only: x/linkedin/youtube_community/threads). Caption is NOT auto-rewritten — seedRepostContent seeds the source caption verbatim (generatedBy:"copy:source"); draft-algorithm-run is intentionally NOT enqueued. Source body is run through stripDateOpenerWithLLM (gpt-4.1-mini, fail-soft) before seedRepostContent — strips stale "X years ago today:" leads on aged sources.
  POST /api/production-items/[id]/cross-post  manual=true → (no job — operator opted to bypass gate + automation; row created for manual upload)
  POST /api/production-items/[id]/repost                  → (no Underlord job — see "Underlord usage tracking" below. Row inherits source media via seedRepostContent.) Source body is run through stripDateOpenerWithLLM (Haiku, fail-soft) before seedRepostContent — strips stale "X years ago today:" leads on repost-of-repost.
  # Clean-original media (2026-06-26): seedRepostContent + both repost/cross-post routes now call
  #   resolveCleanSourceMedia(sourceId) (src/lib/services/clean-media-resolver.ts) FIRST. It walks
  #   lineage (reposted_from_item_id → pillar_content_item_id, depth-bounded, cycle-safe) to the
  #   nearest ALREADY-SAVED clean media (Descript export / manual upload; skips tiktok_dirty
  #   downloads classified via production_item_media.source_url). When found: seed those rows
  #   (shared keys) and SKIP the withMedia:true watermark download (enrichSingleItem). When none:
  #   today's behavior (mirror source rows, mediaProvenance='watermark_fallback'). No Descript
  #   re-render — archived media only. Manual escape hatch: POST .../original-media (swap) +
  #   GET .../original-media (download).
  # Removed 2026-05-18: cross-post + repost used to enqueue
  # `descript-derivative-create`, which fires Underlord ($3.50/call) to
  # duplicate the source composition. Burned $35 in 30 min from a short
  # test session. Policy now: Underlord only fires on explicit clip-idea
  # promote buttons (see /api/clip-ideas/[id]/create-in-descript*).
  POST /api/descript/clip-out                             → descript-clip-resolve  (format-detail quick-clip only as of 2026-05-02)
  POST /api/clip-ideas/[id]/triage (action=assign)        → draft-algorithm-run (auto-fire after promote)
  POST /api/clip-ideas/[id]/create-in-descript            → descript-clip-resolve + draft-algorithm-run (auto-fire)  [UI: Underlord Edit — REMOVED from UI 2026-08-27; route + backend retained]
  POST /api/clip-ideas/[id]/create-in-descript-precise    → clip-idea-precise-cut + draft-algorithm-run (auto-fire)  [UI: Precise Cut + Layout Pack (?ai=1, applies pack); ?buffered=1 → Buffered Cut (No Underlord), ±60s padding, plain trim, NO layout pack. Service forces applyLayoutPack=false when buffered.]
  POST /api/clip-ideas/[id]/create-in-descript-full       → descript-clip-resolve (importMode=true on cold path) + draft-algorithm-run (auto-fire)  [UI: Full Video]
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
  transcribe-whisper ── fresh yt_long originals routed to a clippable format from THEIR account ─→ generate-clip-ideas (per matching clippable format; gates + account-aware routing in clip-ideas-auto.ts)
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
    POST /api/production-items/[id]/draft (regen)   → user (when body.userInitiated=true, e.g. Redraft button), else algorithm:draft-algorithm. User-attributed changes show in the default activity feed; algorithm-attributed go behind "Show system changes" so auto-fires from cross-post/repurpose don't clutter the timeline.
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
- **Outputs:** `productionItems.views`, `likes`, `comments`, `clicks`, `leads`, `salesNum`, `salesAmount`, `lastPerformanceSyncAt`. For `post_type='newsletter'`: `views = opens`, `clicks = clicks`, `newsletterRecipients = recipients`. Calls Scrape Creators (~1 credit/item/platform) for social platforms; Klaviyo Reporting API (free; rate-limited but not metered) for newsletters.
- **Downstream:** none
- **Rules:**
  - Decay tier gates frequency: fresh (< 24h) every hour, archived (180d+) ~monthly
  - Skips items with no `publishedDate`
  - View estimator (`view-estimator.ts`) fills `views` from `likes` when SC returns incomplete data
  - Newsletter (Klaviyo) branch: keyed on `platform_content_id` (campaign id) + account → Klaviyo API key (env-resolved per handle). Requires `KLAVIYO_CONVERSION_METRIC_ID` env var even when we don't care about conversions (Klaviyo's reporting endpoint requires it).
  - **Pulse-first (DARK as of 2026-07-13):** the seven single-URL fetchers are consumed via `src/lib/services/metrics-provider.ts`, which — when `PULSE_METRICS_ENABLED=1` — tries Pulse (`pulse.walls.sh`, Pat's residential-IP metrics API, free per call) before ScrapeCreators and falls back to SC on any failure or unusable answer. Flag unset (the default) → straight delegation to `sc-fetchers.ts`, exactly the pre-2026-07 behavior. Pulse-estimated views are dropped in mapping (the hub's own `view-estimator` governs). `RefreshItemResult.creditsUsed` is 0 for Pulse-served answers, 1 for SC-served, and `RefreshItemResult.source` says which provider answered — every provider-backed refresh is logged to `sc_call_log` (Pulse rows land as credits=0 tagged `via pulse` in notes, so the provider mix is queryable; Klaviyo keeps its no-accounting bypass). Env at cutover: `PULSE_METRICS_ENABLED=1`, optional `PULSE_API_URL` / `PULSE_API_TOKEN` / `PULSE_TIMEOUT_MS`. Files: `src/lib/services/pulse-client.ts`, `src/lib/services/metrics-provider.ts`.

### `threshold-monitor-sweep` — auto-create repurposed items
- **Trigger:** cron `15 * * * *` (every hour at :15)
- **Files:** `src/jobs/tasks/threshold-monitor-sweep.ts`
- **Inputs:** every published `productionItems` row with `views > 0` and a non-null `account_id`; `format_trigger_sources` joined with `formats` (the account→target-format routing table); existing `repurposeTriggers` (for dedup)
- **Outputs:** new `productionItems` rows with `sourceType='repurposed'`, `pillarContentItemId=parent.id`, `status='Idea'` (inherits brand, title, thumbnail from parent); paired `repurposeTriggers` row (targetFormatId, viewsAtTrigger; sourceFormatId=null under the new routing model)
- **Downstream:** `draft-algorithm-run` enqueued for each created row so the editor lands on a populated form (skipped internally for unsupported post types or when the pillar has no transcript yet). Otherwise the new `Idea` row enters the normal post lifecycle and may itself be picked up by enrichment / metrics / hook sweeps once published.
- **Two-path routing model (2026-08-18):** routing is account-based, not format-based. Two separate queries populate the same `sourceAccountId → [target formats]` map:
  1. **Root formats** (`parentFormatId IS NULL`): use `format_trigger_sources`. Any published item from a configured source account is eligible — no `post_type` constraint applied.
  2. **Derivative formats** (`parentFormatId IS NOT NULL`): use the **direct parent format's `format_channels`** exclusively. A production item is eligible only if BOTH its `accountId` and `postType` match a `format_channels` row on the parent. `format_trigger_sources` entries for derivative formats are completely ignored — they cannot broaden the eligible source accounts. This means a Short from @MATGpod cannot trigger "Full Video on X" (whose parent "Podcast Episode" maps @MATGpod → `youtube_long`), and a Howfinity video cannot trigger Futurepedia derivatives just because a trigger source row exists. The parent's channel config is the single source of truth.
- **`format_trigger_sources` table:** `(format_id, source_account_id)` pairs — used exclusively for root/pillar formats. One unique row per (format, account). `viewThreshold` always reads live from `formats.view_threshold`.
- **`format_channels` table:** `(format_id, account_id, post_type)` — used by derivative formats to determine eligible (account, post_type) pairs via the parent format's rows.
- **Rules:**
  - **In-place scan**, not a fan-out — does the work directly because it's pure DB and cheap
  - Dedup key = `(productionItemId, targetFormatId)`. Once a trigger row exists for that pair, that target is never re-created for that pillar. Covers both old-model rows (sourceFormatId set) and new-model rows (sourceFormatId null).
  - Skips target formats with no `viewThreshold` set
  - **Skips `is_clippable_format=true` target formats** (2026-05-27). Clippable formats are produced exclusively from the Clip Ideas queue (one clip-idea agent run per clippable format on the pillar's brand), so the sweep must not also auto-create a `repurposed` Idea when a pillar crosses a clippable target's `viewThreshold` — that double-created a redundant Idea alongside the clip-idea-promoted Reel/Short. Mirrored in the SPOKE/Repurposed queue (`spoke-candidates.ts` excludes clippable children as repurpose targets).
  - **Account pick is deterministic**: when the target format has multiple `formatChannels` rows, picks the oldest-added one (`ORDER BY created_at, id ASC LIMIT 1`). Fan-out-to-all-channels is a deliberate non-feature — one repurposed Idea per (pillar, target format) pair regardless of how many channels the target format publishes to.
  - Resolves the editor for the new item via `resolveEditor()` chain (source item → format `editorNotionUserId` → brand `defaultEditorUserId` → global fallback)
  - **Permanent lower bound (required):** `TRIGGER_ROUTING_MIN_PUBLISHED_AT` env var (ISO timestamp). **Must be set for any triggers to fire.** When absent, the sweep logs a warning and exits cleanly — no triggers created. Set once at first deployment to 7 days prior (e.g. `2026-08-03T00:00:00Z`) so the initial sweep catches up the last week while leaving all older items permanently ineligible. Leave it set forever — removing it reactivates the lockout (safe failure mode). Pillars with `published_at IS NULL` are always excluded (treated as historic). To backfill older items, change this value explicitly — that is the required "explicit separate command."
  - This task **replaces the Asana-based `/api/trigger-repurpose` flow** — same intent, different implementation. No external systems.

### `sync-link-metrics` — go links → clicks/leads
- **Trigger:** cron `*/30 * * * *` (every 30 min); also fired best-effort per item after a CTA regenerate (`/api/production-items/[id]/regenerate-cta` → `syncLinkMetricsForItem`).
- **Files:** `src/jobs/tasks/scheduled.ts` (`syncLinkMetricsTask`), `src/lib/services/link-metrics-sync.ts`.
- **Inputs:** StarterStory short-links API (`GET /api/v1/short_links?include_archived=true`) — every hubandspoke-minted link (`content_source='hubandspoke'`), keyed by `content_external_id` (= `productionItems.id`).
- **Outputs:** writes `productionItems.clicks` (sum of the post's link click counts) + `productionItems.leads` (max of `leads_count`, which the Rails side computes by matching `lead_conversions.content` to the link's `utm_campaign`) + `productionItems.hubspotLeads` (max of `hubspot_leads_count`, the HubSpot-form subset of `leads_count`). Only rows whose values changed are updated. Persisting `hubspotLeads` lets the Content performance table split LEADS into sortable SS-leads (`leads - hubspotLeads`, native) and HS-leads columns across the whole dataset. The detail-page LEADS hover still reads the split live via `/api/production-items/[id]/cta-link` for the freshest single-item number.
- **Why:** the go.starterstory.com short links are the SOURCE OF TRUTH for CLICKS and LEADS. Notion no longer writes these (and SALES was removed entirely). Legacy posts get their historical clicks via the one-time `scripts/backfill-legacy-clicks.mjs`, which seeds archived `legacy`-tagged go links with the old count — this job then reads them back into the column.

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
  - Resolves the editor via Notion "Editor/Creator" email → `users.email` → format `editorNotionUserId` → brand `defaultEditorUserId` → global fallback (producer was dropped 2026-05-14 — Notion's Producer column is ignored)
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

### `hook-dispatch` — one item's unified hook pick (LLM)
- **Trigger:** fan-out child of cron `hook-dispatch-sweep` (every 5 min), `jobKey: hook-dispatch-{id}`
- **Files:** `src/jobs/tasks/hook-dispatch.ts`, `src/lib/services/hook-extract/dispatcher.ts` (`dispatchHookForItem`, `callLLM`)
- **Inputs:** items with `hookExtractedAt IS NULL` and at least one signal (title, caption/body, transcript, poster). One LLM call sees all of them.
- **Outputs:** stamps `hookExtractedAt` + `hookExtractor`; writes `hook`/`hookSource` (and `overlay` when the source is overlay), `coverDescription`/`visionExtractedAt` when a poster was sent
- **Rules:**
  - Supersedes the per-item `extract-hook` / `hook-fallback` / `vision-extract` tasks (still registered for back-compat, no longer fanned out)
  - `hookSource IN ('clip_idea','manual')` is untouchable; re-running requires clearing `hookExtractedAt`
  - **OpenAI 400s fail soft, they do not retry.** A 400 is a permanent rejection of a body we built, so all 25 graphile attempts would fail identically. On 400 the dispatcher retries once without the poster image (the common cause — a `.jpg` key holding HEIC bytes); if that also 400s, or the 400 was raised with no poster in play, it returns a skipped result with `reasoning: openai-400:<stage>:<msg>` and the caller still stamps `hookExtractedAt` so the item leaves the sweep. Non-400 errors still throw and retry normally. Matched on HTTP status, not only `instanceof BadRequestError`.

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
  - **NOOP in production** (`NODE_ENV=production` → logs and returns):
    YouTube bot-blocks Heroku's datacenter IPs, so in-dyno yt-dlp always hits
    "Sign in to confirm you're not a bot". Production YouTube archiving is
    owned by the **home-machine hourly cron** (`home-machine/yt-archive/` —
    launchd job `com.hubandspoke.yt-archive` running
    `scripts/archive-yt-local.ts` from a residential IP). `yt-archive-watch`
    (below) alarms when that cron stops landing archives.
  - **Brand scope is `--brands=auto` (2026-08-20):** the script resolves the
    brand list from the prod DB on every run — every brand with an active
    (non-deleted) YouTube account whose brand isn't disabled. Adding a brand +
    YouTube account in the settings UI is the whole onboarding step; the
    account-create backfill syncs the metadata rows and the next hourly tick
    archives anything published in the last `RUN_SINCE_DAYS` (currently 30)
    days. To exclude a brand from archiving, deactivate its YouTube account or
    set an explicit slug list in `~/.config/hubandspoke/yt-archive.env`.
  - **Auth via cookies (2026-07-29):** YouTube now bot-blocks *cookieless*
    downloads even from the residential home IP ("Sign in to confirm you're not
    a bot"), so the cron authenticates with a pre-exported Netscape cookie file
    at `~/.config/hubandspoke/cookies.txt` (`archive-yt-local.ts --cookies=<file>`;
    yt-dlp rewrites it after each run to stay fresh). It can't use
    `--cookies-from-browser` because launchd is headless — no keychain/GUI, and
    Chrome holds an exclusive lock on its live cookie DB. Re-export when it goes
    stale: `yt-dlp --cookies-from-browser chrome --cookies
    ~/.config/hubandspoke/cookies.txt --skip-download --simulate <any-yt-url>`.
  - `MAX_ATTEMPTS = 5` defined locally (`youtube-download-sweep.ts:14`); same constant duplicated in `enrichment/orchestrator.ts:20`
  - Sweep gate paces retries; dyno-level maxAttempts only retries the same tick

### `account-content-sync-sweep` — per-account content fan-out (hourly)
- **Trigger:** cron `5 * * * *` (hourly at :05). Was `*/30` before 2026-04-27 — halved frequency to cut SC spend; the PUT-time auto-fetch on operator-pasted publish links handles the common discovery case.
- **Cost:** ~22 SC credits per sweep at current volume (3 IG + 3 LinkedIn + 2 Threads + 3 TikTok + 3 X + 4 YouTube × 2 endpoints). 24 sweeps/day → ~528 SC calls/day. Tunable via `CRONTAB` in `src/jobs/crontab.ts`.
- **Files:** `src/jobs/tasks/scheduled.ts` (`accountContentSyncSweepTask`)
- **Inputs:** every active `accounts` row on an SC-supported platform
  (`youtube, instagram, tiktok, linkedin, x, threads, facebook`)
- **Outputs:** enqueues one `account-content-sync` per row with `mode=latest`, `jobKey: account-content-sync-{id}-latest`
- **Downstream:** `account-content-sync`
- **Rules:**
  - Replaces the old MATG-only `matg-sync` cron. MATG handles are just
    regular account rows now — no special-casing.
  - Skips platforms with no SC content-list coverage (`newsletter`, `other`)
  - `x` and `threads` are enqueued but always in `latest` mode (neither
    platform's SC endpoint paginates)
  - `facebook` requires `accounts.url` to be set (the page URL); the fetcher
    throws if it's missing
  - Sweeps use jobKey + `unsafe_dedupe` so overlapping ticks don't
    double-enqueue a pending account

### `schedule-reconcile-sweep` — tie live posts back to Scheduled items (every 10 min)
- **Trigger:** cron `*/10 * * * *`
- **Files:** `src/jobs/tasks/scheduled.ts` (`scheduleReconcileSweepTask`),
  `src/lib/services/schedule-reconcile/{matcher,reconcile,review}.ts`,
  `src/lib/services/merge-production-items.ts` (`reconcileScheduledIntoPublished`)
- **Why:** operators schedule a post via a platform's native scheduler / a
  post-scheduler and mark the planning item **Scheduled** (publish route,
  `mode=schedule`). When it goes live, `account-content-sync` discovers it as
  a *separate* Published row. This sweep reunites them.
- **Two jobs per tick:**
  1. **Targeted freshness:** enqueues `account-content-sync` (`mode=latest`,
     jobKey dedup) for ONLY the distinct accounts that own a pending Scheduled
     item (not given-up). ≈$0 extra SC spend when nothing is scheduled.
  2. **Match pass:** `runScheduleReconcile()` over current data. For each
     pending Scheduled item: structural candidate gate (same account,
     Published, synced-origin, published inside the scheduling window, same
     post_type) → Haiku scorer (`matcher.ts`, single pinned `return_match`
     tool, fail-soft) → tier policy.
- **Tier policy (`reconcile.ts`):** score **≥85** → auto-merge
  (`reconcileScheduledIntoPublished`: Scheduled item is pinned as merge keeper,
  absorbs the synced row, flips to Published with the real link/date/thumbnail,
  emits `status_change` + `content_changed`, schedules velocity snapshots);
  **55–84** → upsert a `scheduled_match_suggestions` row (pending) for human
  Confirm/Reject at `/[brand]/scheduled`; **<55** → leave Scheduled, retry.
- **Give-up window (per post_type):** unmatched past `staleWindowHours()` —
  **24h** for fast formats (x, tiktok, threads, instagram_*), **48h** otherwise
  — stamps `production_items.schedule_needs_attention_at`, surfaces a
  needs-attention badge, and stops matching that item. "Some content should
  never sit at Scheduled more than 24h."
- **Rules / idempotency:** matcher runs against whatever Published rows exist
  now, so a post synced this tick is matched next tick (~10-min latency, by
  design). Rejected (item, candidate) pairs are excluded from future matching.
  LLM error on a tick = treat as no-match, retry. System merges pass
  `userId=null` and skip the `production_items_merges` audit row (trail is in
  `content_events`).
- **Scope:** only processes items where `scheduled_no_date = false` (or null).
  Items with `scheduled_no_date = true` are handled exclusively by
  `schedule-nodate-sweep` below.

### `schedule-nodate-sweep` — reconcile "no publish date yet" Scheduled items (every 60 min)
- **Trigger:** cron `50 * * * *`
- **Files:** `src/jobs/tasks/scheduled.ts` (`scheduleNodateSweepTask`),
  `src/lib/services/schedule-reconcile/reconcile.ts` (`runScheduleNodateReconcile`)
- **Why:** some brands upload YouTube videos as private/scheduled without
  knowing the publish date. Setting `scheduledNoDate=true` via the Schedule
  dialog (new "No publish date yet" checkbox) marks the item for this sweep
  instead of the 10-min sweep. The YouTube video is invisible to the sync API
  until it goes public, so checking hourly is sufficient — there's no date to
  target — and keeps Social Curator API usage low over the longer window.
- **Two jobs per tick:** identical structure to `schedule-reconcile-sweep`
  (targeted `account-content-sync` enqueue + `runScheduleNodateReconcile()`
  match pass), but filtered to `scheduled_no_date = true` items only.
- **Give-up window:** **14 days** from `scheduled_at` (vs 24/48h for date-known
  items). Stamps `schedule_needs_attention_at` and surfaces the same
  "Needs attention" badge when exceeded.
- **Tier policy:** identical to `schedule-reconcile-sweep` (≥85 auto-merge,
  55–84 suggestion, <55 retry).
- **Detection latency:** ~60 min (acceptable — operator doesn't know the date).
- **UI:** items with `scheduled_no_date=true` show a blue "No date yet" badge
  alongside the status chip in the content detail view.
- **Surface:** `/[brand]/scheduled` (page) + `GET /api/scheduled-matches` +
  `POST /api/scheduled-matches/[id]` (`confirm` → reconcile, `reject` → exclude).

### Feedhook push receiver — new-post webhooks (DARK as of 2026-07-13)
- **Trigger:** `POST /api/webhooks/feedhook` — signed deliveries from Feedhook
  (`feedhook.walls.sh`, Pat's webhook service). `video.published` for YouTube
  channels (WebSub push, ~8s after upload); `post.published` for polled
  platforms (x / instagram / tiktok — Feedhook polls Pulse `/content` every
  ~10 min server-side).
- **Files:** `src/app/api/webhooks/feedhook/route.ts`,
  `src/lib/feedhook.ts` (signature verify + types),
  `scripts/feedhook-subscribe.mjs` (cutover: create one subscription per
  active account, stamp `accounts.feedhook_subscription_id`).
- **What it does:** verify `x-feedhook-signature` (HMAC-SHA256 of the raw
  body with the shared `FEEDHOOK_WEBHOOK_SECRET` — every subscription is
  created with this same secret), match the account by
  `feedhook_subscription_id`, and enqueue the existing
  `account-content-sync` (mode=latest) for it. Duplicate deliveries are
  harmless — the sync's upsert dedup absorbs them. Always answers 2xx to
  verified deliveries (Feedhook retries 8x over ~9h otherwise).
- **DARK:** two independent switches, both currently off in prod:
  (1) no subscriptions exist until `scripts/feedhook-subscribe.mjs --apply`
  runs; (2) `FEEDHOOK_SYNC_ENABLED` unset → the receiver verifies + acks +
  logs `DARK: would sync …` but enqueues nothing.
- **Cutover intent:** replaces the SC-credit cost of `schedule-reconcile-sweep`'s
  10-min polling (push tells us when to sync instead of asking SC on a
  timer) and lets the hourly `account-content-sync-sweep` drop to a
  safety-net cadence. The reconciler itself is unchanged — it keys off
  Published rows, however they arrive.
- **Env at cutover:** `FEEDHOOK_WEBHOOK_SECRET` (receiver + subscribe script),
  `FEEDHOOK_SYNC_ENABLED=1`, `FEEDHOOK_API_KEY` (subscribe script only; the
  Feedhook account should be on the internal plan — the fleet exceeds the
  pro feed limit).

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

### `klaviyo-sync-sweep` — discover Klaviyo campaigns (every 30 min)
- **Trigger:** cron `*/30 * * * *`
- **Files:** `src/jobs/tasks/klaviyo-sync-sweep.ts`, `src/jobs/tasks/klaviyo-sync-account.ts`, `src/lib/services/klaviyo-sync.ts`, `src/lib/services/klaviyo-client.ts`
- **Inputs:** every active `accounts` row with `platform='newsletter'` AND a non-null `external_id` (the Klaviyo list id, e.g. `KBDbDN`)
- **Outputs:** enqueues one `klaviyo-sync-account` per row with `jobKey: klaviyo-sync-account-{id}` (`unsafe_dedupe` mode)
- **Downstream:** `klaviyo-sync-account` → `enrich-item` + `refresh-item-metrics` for every newly inserted row
- **Rules:**
  - Skips newsletter accounts with no `external_id` set — un-syncable, surface a config error rather than fail every tick
  - Only Sent campaigns whose `audiences.included` contains the account's list id become production_items (drafts, scheduled, segment-targeted sends are ignored)
  - Upsert keyed on `(account_id, platform_content_id)` where `platform_content_id` is the Klaviyo campaign id — same partial unique index used by `account-content-sync`. Re-runs UPDATE instead of INSERT
  - `createdVia='sync:klaviyo'` on every new row; subject → `title`, send_time → `publishedAt`, list id → `klaviyo_list_id` (per-item audit). Body / preview text / metrics are filled by enrichment + decay sweeps, not by this sync
  - API key resolution is per-handle env var (`KLAVIYO_API_KEY_<HANDLE_UPPER_SNAKE>`) with `KLAVIYO_API_KEY` as the fallback. Lets us add HubSpot brands' own Klaviyo accounts later by setting one env var per account, no code change

### `klaviyo-sync-account` — sync one newsletter account
- **Trigger:** enqueued by `klaviyo-sync-sweep`; on-demand by `scripts/backfill-klaviyo-campaigns.ts` (12-month one-shot)
- **Files:** `src/jobs/tasks/klaviyo-sync-account.ts`, `src/lib/services/klaviyo-sync.ts`
- **Inputs:** `{ accountId, sinceIso?, untilIso?, enqueueDownstream? }`
- **Outputs:** upserts to `productionItems`; stamps `accounts.lastContentSyncAt` (success) / `lastContentSyncError` (failure). Enqueues per-item `enrich-item` + `refresh-item-metrics` for newly inserted rows so body + opens land within minutes instead of waiting for the next sweep tick (toggle off via `enqueueDownstream: false`).
- **Pagination:** Klaviyo's cursor-based `links.next` URL — followed until exhausted or `maxPages` cap (200 default). Default `since` window is `accounts.lastContentSyncAt ?? now-7d`; backfills override.
- **Rate limits:** Klaviyo allows 75 r/s steady, 700 r/s burst on `GET /campaigns`. The client retries 429 / 5xx three times with exponential backoff (1s/2s/4s) and honors `Retry-After`. Sweep volume is tiny (one paginated walk per account per 30 min) so we never approach the limit in steady state.

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
  - **No-original-repost platforms (2026-05-27):** `sourceType='original'` items on YouTube are dropped — you don't re-upload a long-form video the way you re-share a banger tweet or reel. YouTube *clips* / *cross-posts* (`repurposed` / `cross_post`) stay eligible; only `original` is barred. The platform set lives in `NO_ORIGINAL_REPOST_PLATFORMS` (`repost-candidates.ts`) via the exported `isOriginalRepostBlocked(platform, sourceType)` predicate; the drop count surfaces as `stats.droppedOriginalOnPlatform` and the set as `config.noOriginalRepostPlatforms`.
  - **No-repost platforms (2026-06-23):** items on `newsletter` accounts are dropped outright — a newsletter is an email blast, not a re-shareable post — regardless of source type (vs the YouTube rule above, which only bars `original`). The set lives in `NO_REPOST_PLATFORMS` (`repost-candidates.ts`) via the exported `isPlatformRepostBlocked(platform)` predicate; the drop count surfaces as `stats.droppedNonRepostablePlatform` and the set as `config.noRepostPlatforms`.
  - **Permanent suppression:** any prior `Killed` repost on the same source → never resurface. (Operator already decided.)
  - **In-flight block:** any `Idea` / `Assigned` / `Ready To Publish` repost on the same source → skip.
  - **Cooldown:** any `Published` repost on the same source within the platform's cooldown window → skip. instagram 30d, youtube/linkedin/threads 60d, x 120d, default 60d.
  - **Cohort ladder (P75 in all three tiers):** (1) `(account, format, postType)` all-time, min cohort 5; (2) `(brand, format, postType)` all-time, min cohort 5; (3) `(format, postType)` cross-brand over 365d, min cohort 5. The strongest tier with a bar wins.
  - **Admission:** lifetime ratio (`candidate.views / cohort_P75`) ≥ 1.5×. Sort items by max ratio desc. Unlike cross-post v3 (which uses P50 and auto-admits new formats), candidates with **no cohort at all are NOT auto-admitted** — reposts require evidence; "this beat its peers" needs peers.
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

**2026-08-09 incident — 7.3M-row queue runaway; every enqueue of this task now
carries `jobKey: descript-publish:<itemId>` + `jobKeyMode: "replace"` (all five
sites: both self-polls, both auto-chain kickoffs, the manual route).** Root
cause was NOT this task's logic: the May DB migration dropped
`graphile_worker._private_tasks`' primary key and unique constraint (identity
sequence also reset). graphile registers tasks with `ON CONFLICT DO NOTHING` —
with no unique constraint the conflict never fires, so every worker boot
re-inserted all ~55 identifiers (→7,473 rows), and because job inserts resolve
task by identifier, **every single enqueue inserted one job row per duplicate
task row** (~×3,974 by the end, +1 per enqueue). This task's 10s self-poll made
it the dominant victim: 5.8M pending rows, each *worked* poll spawning ~4k
more, ~490k rows/hour at peak. Fallout: repeated phase-1 re-kicks created real
Descript publish jobs (the "clip ready in Descript ×hundreds" notifications),
the dashboard's `descript-status` route seq-scanned the 2.9 GB table on every
poll (H12 timeouts = "server crashing"), and cross-post enqueues drowned.
Remediation: purged the queue (7.36M → 241 legit rows), rebuilt
`_private_tasks` (55 rows, pkey + unique restored, ambiguous task_ids resolved
by payload shape), `VACUUM FULL` (2,984 MB → 240 KB), and added the jobKeys as
belt-and-braces. **Diagnostic that cracked it:** `SELECT count(*), count(DISTINCT
identifier) FROM graphile_worker._private_tasks` — if those numbers ever
diverge again, the constraints are gone again. A one-row-per-instant burst
(`GROUP BY created_at ORDER BY count DESC`) shows the amplification factor.
Note: the popular first guess "millions of *failed* jobs" was wrong — only 263
jobs had failed; 7.17M had never been attempted because workers only fetch jobs
whose task_id matches the task rows registered at their own boot.

- **Files:**
  - `src/jobs/tasks/descript-publish-and-archive.ts` — self-polling task. Phase 1 calls `POST /jobs/publish` and stamps `descript_publish_job_id`. Phase 2 polls `GET /jobs/{id}` every 10s; on `job_state="stopped"` + `result.status="success"`, downloads the MP4 via `archiveRemoteToS3`, deletes prior Descript-published media rows (matched by `source_url LIKE 'https://production-273614-media-export.storage.googleapis.com/%'`, so manual uploads are preserved), **inserts the new `production_item_media` row at `index = 0`** (shifts every remaining row up by 1 first, via a two-pass negative-scratch UPDATE so the `(production_item_id, index)` unique constraint doesn't collide mid-renumber), mirrors the cover columns, and stamps `descript_published_at`. **Index-0 is the canonical slot for the rendered clip** — simulator `slides[0]` and the legacy `mediaS3Key` mirror (which picks the lowest-index row) both resolve to it. Inherited source media from `repost-seed` (which copies the parent's media preserving the parent's original index) gets pushed to index 1+ instead of squatting on index 0 and hiding the render. 15-minute deadline.
  - `src/jobs/tasks/descript-clip-resolve.ts` — auto-chains: after stamping `descript_composition_id` on the derivative item, enqueues `descript-publish-and-archive`. **Underlord settle delay (2026-05-20):** when the resolver finishes an agent path (`importMode=false`, i.e. Underlord just stopped), the publish enqueue runs with `runAt = now + DESCRIPT_UNDERLORD_SETTLE_MS` (default 60s). Descript flips the agent job to `stopped` as soon as instructions are dispatched, but the composition mutations (layout pack, captions, filler trims) can still be writing for ~30-60s afterwards; publishing immediately renders a pre-layout MP4. Cold-import (`importMode=true`) has no Underlord involved, so no delay. Same settle wait applies in `clip-idea-precise-cut.ts pollLayoutOnce` after the precise-cut layout-pack Underlord call stops. Override via env. Idempotent (no-op if already rendered).
  - `src/lib/descript.ts` — `publishDescriptComposition({projectId, compositionId, resolution, accessLevel})` returns `{jobId}`. `DESCRIPT_EXPORT_URL_PREFIX` constant identifies Descript's GCS export bucket for source-URL matching. **Dual-account routing (2026-08-10):** `authHeader(account?)` selects `DESCRIPT_API_TOKEN_HUBSPOT` when `account === 'hubspot'`, otherwise falls back to `DESCRIPT_API_TOKEN` (Pat's legacy account). All outbound call functions (`publishDescriptComposition`, `fetchDescriptJob`, `invokeDescriptAgent`, `duplicateDescriptComposition`, `cutSegmentWithRules`, `createDescriptProjectFromUrl`) accept `account?: string | null` and pass it to `authHeader`. Every call site reads `descript_account` from the item's DB row and threads it through. New project creation always passes `account: 'hubspot'` and stamps `descript_account = 'hubspot'` on the row. Existing rows with `descript_account IS NULL` use the legacy token with no behavior change.
  - `src/app/api/production-items/[id]/sync-descript-publish/route.ts` — manual re-trigger. Race guard: returns 409 if a render is already in flight, unless `{force: true}` is passed (used by the Retry button on a failed pill).
  - `src/lib/services/enrichment/shared.ts` — `archiveRemoteToS3` now handles files up to 500 MB. Files ≤200 MB: buffered via `arrayBuffer()` (unchanged). Files 200–500 MB: streamed directly to S3 via `Readable.fromWeb(res.body)` + `putObjectFromStream` (no RAM spike). Files >500 MB: rejected with a hard error. The `Content-Length` header is required for the streaming path; servers that omit it fall through to the 200 MB buffer cap. (2026-08-25: Descript was rendering some 1080p compositions at ~242 MB, silently poisoning the `media-heavy` graphile-worker queue on retries.)
  - `src/app/api/production-items/[id]/descript-status/route.ts` — extended to return a `publish: { state, jobId, publishedAt, error }` block. Pill polls every 10s while `state === "rendering"`.
- **Schema:** columns on `production_items`:
  - `descript_account` — which Descript account owns this item's project. `NULL` = Pat's legacy account (`DESCRIPT_API_TOKEN`); `'hubspot'` = HubSpot shared account (`DESCRIPT_API_TOKEN_HUBSPOT`). Stamped at project-creation time; never changes after that. Migration: `drizzle/0100_giant_molly_hayes.sql`.
  - `descript_publish_job_id` — current/last publish job id (null = idle).
  - `descript_published_at` — when the MP4 archive completed.
  - `descript_publish_error` — last error if failed (truncated to 1000 chars).
  - Derivable states: `idle` (both null), `rendering` (job id set, not published, no error), `rendered` (published_at set), `failed` (error set).
- **Race condition:** every polling tick re-reads `descript_publish_job_id` from the row; if it doesn't match the payload's job id (the user clicked Sync mid-poll and a fresh job kicked off), the stale poller bails.
- **Failure tolerance:** task throws on Descript errors / timeout; graphile-worker retries with backoff. Every failure path — including the Phase-1 kickoff call to `publishDescriptComposition` (fixed 2026-08-29) — stamps `descript_publish_error` before rethrowing, so the error is surfaced via the pill with a Retry button. **Any path that throws without stamping leaves the row in the derivable `rendering` state forever** (stale job id, no error, no `published_at`): the pill spins, no Retry appears, and the only signal is a Sentry event once the job exhausts its 25 attempts days later. That's what stranded item `78b7cc20` from 2026-08-12 to 2026-08-29 after its Descript composition was deleted.
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
| `src/app/api/production-items/route.ts` | PUT (link added on already-Published) | existing `publishedAt`, or stamped `new Date()` on fresh transition |
| `src/app/api/production-items/[id]/publish/route.ts` | POST mode=`publish` (Ready→Published transition) | existing `publishedAt`, or stamped `new Date()` on first publish |

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
  - **Cohort:** same `format` over the last 90 days, cross-brand. Lifetime cohort floor is 0 (a brand-new format with one prior post still gets a noisy P50 — operators dismiss what they don't want); per-checkpoint cohort floor is 5 (velocity baselines need at least a handful of points to be meaningful). Formats with no cohort at all auto-admit and are tagged `NEW` in the badge.
  - **Hotness signals:** for each candidate we compute up to two flavors of ratio and take the strongest:
    - **Lifetime** — cumulative `views` ÷ format's lifetime P50.
    - **Velocity** — for each `view_snapshots.checkpoint_key` available on the candidate (15m / 30m / 1h / 2h / 4h / 8h / 24h / 48h), `views_at_checkpoint` ÷ format's same-checkpoint P50.
  - **Admission:** max ratio ≥ 1.0× (or auto-admit when no cohort exists). Sort by max ratio desc. The top signal drives the badge label (`8.7× 1h` vs `1.8× lifetime`) and a `whyHot` explainer string is computed server-side and surfaced in the modal + tooltip.
  - **Why P50 instead of P75:** young posts haven't had time to accumulate the lifetime views that the 90-day cohort has, so the lifetime gate is biased against them. P50 (median) surfaces ideas that beat the average without flooding the queue. Velocity comparisons are age-fair (snapshot-vs-snapshot) and not affected.
  - **Already-done dedup:** drop a candidate if every eligible `(target account, target post type)` pair already has a `productionItems` row with `sourceType='cross_post'` and `repostedFromItemId = candidate.id`. Modal still shows partially-done state (per-target disabled cards "Already posted · Xd ago") when some targets remain. The check walks the candidate's DOWNSTREAM repost tree only (descendants reached via `reposted_from_item_id` edges) — it does *not* walk up to the lineage root and then back down through siblings. A repost is its own content event for cross-posting purposes; the ancestor's months-old cross-posts shouldn't gate it. See HUBANDSPOKE-? (2026-05-15) for the regression that prompted this when an "up-then-down" walk was briefly the behavior.
  - **Dismissal:** "Not interested" → `POST /api/production-items/[id]/cross-post-dismiss` writes a `contentEvents` row with `type='cross_post_dismissed'`. The candidate selector hides it for 30 days; after that it can resurface if it's still hot.
  - **Format compat:** unchanged from v2 — `compatibleTargetsFor()` matrix gates which target post types appear as cards in the modal.

### v2 cross-post scanner (`cross-post-scan`) — REMOVED 2026-05-02
v2 (LLM-recommended source × target pairs admitted to the queue at ≥70 confidence) was retired in favor of the v3 candidate queue above. `runCrossPostScan`, `cross-post-recommend.ts`, the manual `/api/cross-post-scan` route, the graphile-worker task, and `scripts/run-cross-post-scan.mjs` are all deleted. `cross_post_decisions`, `crossPostFitVerdicts`, `crossPostRules`, and `productionItems.crossPostConfidence` remain for historical reads (retrospective at `/[brand]/accounts/cross-posting`); see Planned-removal in `docs/features.md`.

### `account-refresh-sweep` — weekly metadata refresh
- **Trigger:** cron `0 17 * * 1` (Mondays 17:00 UTC)
- **Files:** `src/jobs/tasks/scheduled.ts:125-147`
- **Inputs:** active `accounts` on SC-supported platforms (`youtube, instagram, x, tiktok, linkedin, threads, facebook`)
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
- **Outputs:** one HubSpot SMTP send per recipient. No DB writes.
- **Downstream:** none.
- **Preview / dogfood:** admin-only `GET /api/admin/scorecard-email/preview`
  renders the HTML in-browser; append `?send=me` to send the rendered
  email to the logged-in admin's address (real email send).
- **Recipient gate:** the column is the source of truth — `role='admin'`
  is not re-checked at send time. If a non-admin gets the flag set, they
  get the email. Toggle from `/settings/users` (admin-only UI) or via
  direct SQL.
- **Failure mode:** each send is wrapped; one email-send failure increments
  the `failed` counter and logs but does not starve the rest of the batch.
  The whole task is retried by graphile-worker on uncaught exceptions
  (e.g. DB unavailable), but a per-recipient failure does not retry.

### `sc-credits-watch` — Scrape Creators credit-exhaustion alert
- **Trigger:** cron `*/15 * * * *` (every 15 minutes).
- **Files:** `src/jobs/tasks/scheduled.ts` (`scCreditsWatchTask`),
  `src/lib/services/sc-credits-watch.ts` (detection + dedupe),
  `src/lib/email.ts` (`sendScCreditsExhaustedEmail`),
  `src/lib/services/alert-recipients.ts` (`ALERT_RECIPIENTS`)
- **Inputs:** `sc_call_log` rows in the last hour where `ok=false` and
  notes match `%out of credits%` or `%(402)%`.
- **Outputs:**
  - Email to every address in `ALERT_RECIPIENTS` (Pat + Sam). Updated
    2026-05-18 from the prior `daily_scorecard_email_enabled` opt-in
    list — credit-exhaustion blocks the workflow and needs to reach the
    operators who can act on it regardless of any per-user opt-in.
  - One `sync_logs` row with `sync_type='sc-credits-alert'` per send for
    dedupe — the next 4 hours of ticks read this and skip emailing.
  - Drives the dashboard banner indirectly: `/api/sc-credits-status`
    reads the same detection helper and `<ScCreditsBanner>` polls it
    every 60s on every dashboard page.
- **Downstream:** none. The banner clears itself the moment SC starts
  returning 200s again — no manual reset needed.
- **Why every 15 min and not the 60s the banner polls:** the banner is
  the user-facing surface (instant visibility); the cron's only job is
  to send one email on state transition, where 15-min granularity is
  fine and avoids hammering the mail provider on flapping.

### `descript-credits-watch` — Descript AI-credit exhaustion alert
- **Trigger:** cron `*/15 * * * *` (every 15 minutes). Added 2026-05-18.
- **Files:** `src/jobs/tasks/scheduled.ts` (`descriptCreditsWatchTask`),
  `src/lib/services/descript-credits-watch.ts` (detection + dedupe),
  `src/lib/email.ts` (`sendDescriptCreditsExhaustedEmail`),
  `src/lib/services/alert-recipients.ts`
- **Inputs:** `graphile_worker.jobs` rows updated in the last hour where
  `task_identifier` is one of `descript-clip-resolve`,
  `descript-derivative-create`, `descript-publish-and-archive`, or
  `clip-idea-precise-cut`, AND `last_error` matches
  `%Insufficient AI credits%` or `%Out of AI credits%`.
- **Outputs:**
  - Email to `ALERT_RECIPIENTS` (Pat + Sam) — same fixed list the SC
    watcher uses.
  - One `sync_logs` row with `sync_type='descript-credits-alert'` per
    send for dedupe — the next 4 hours of ticks skip emailing.
  - Drives the dashboard banner indirectly: `/api/descript-credits-status`
    reads the same detection helper and `<DescriptCreditsBanner>`
    polls it every 60s on every dashboard page.
- **Downstream:** none. The banner auto-clears within ~1 minute of the
  first Descript job retrying successfully (a successful job leaves the
  queue → row disappears from the view → count drops to zero).
- **Why graphile_worker.jobs and not a dedicated descript_call_log:**
  there's no Descript-side call log table today and standing one up
  just for this alarm would be over-engineered. The queue view already
  carries the upstream's verbatim error in `last_error` and tracks
  `updated_at` on every retry, which is the auto-resolve signal.

### `yt-archive-watch` — home-machine YouTube archiver watchdog
- **Trigger:** cron `45 * * * *` (hourly at :45). Added 2026-06-09 after the
  home cron silently failed for 3 days (the repo checkout it `git pull`s was
  switched off the branch carrying its `--since-days` flag support — fixed by
  landing the flags on `main`, but the class of failure is "anything that
  stops the home Mac's hourly run", which nothing server-side noticed).
- **Files:** `src/jobs/tasks/scheduled.ts` (`ytArchiveWatchTask`),
  `src/lib/services/yt-archive-watch.ts` (detection + dedupe),
  `src/lib/email.ts` (`sendYtArchiveBehindEmail`),
  `src/lib/services/alert-recipients.ts`
- **Inputs:** `productionItems` where `status='Published' AND youtube_id IS
  NOT NULL AND media_s3_key IS NULL AND COALESCE(youtube_download_attempts,0)=0`,
  brand in the watched set, published more than 12h ago (grace window) and
  within the last 30 days (the home cron's own look-back).
- **Outputs:**
  - **Sentry event** every tick while broken — fingerprinted to one grouped
    issue (`yt-archive-behind`) so alert rules fire on new/regression and the
    event count is the "still broken" heartbeat.
  - Email to `ALERT_RECIPIENTS` (Pat + Sam), deduped to one per 6h via
    `sync_logs.sync_type='yt-archive-alert'`.

    **The email deliberately does not assert a cause.** It only knows items
    aren't being archived; it cannot distinguish "Mac is off" from "downloads
    failing" from "Heroku creds expired". It claimed *"has likely stopped
    running"* twice in a row (2026-07-30, 2026-08-06) and named the wrong reason
    both times — sending people to `heroku login` for a memory problem, and to
    the launchd job for a credentials problem. It now says runs aren't
    completing, points at the log as authoritative, and includes an exit-code
    decoder (0/2 ran fine · 6 Heroku creds · 8 host OOM · other = bailed early).
- **Downstream:** none. Once the home cron is healthy it backfills
  automatically (it looks back `RUN_SINCE_DAYS`) and the alert self-clears.
- **Why attempts=0 and not "no media":** `archive-yt-local.ts` increments
  `youtube_download_attempts` on success AND failure, so attempts=0 past the
  grace window means the cron never even saw the item — machine off, wrapper
  broken, checkout wedged. Items with attempts>0 are per-video failures
  (dead/private/bot-gated), which are expected and not systemic.
- **This invariant was false until 2026-07-30.** `archiveOne` returned early on
  the "all player-client strategies failed" path instead of throwing, skipping
  the catch block that does the increment. So the single most common systemic
  failure — every strategy timing out — looked identical to "the Mac is off",
  and the watchdog emailed Pat + Sam that the archiver had *stopped running*
  while it was in fact running hourly and failing on those exact items. It also
  meant those items never aged past the `attempts < 3` candidate filter, so each
  hourly run re-downloaded the same doomed videos. Fixed at
  `scripts/archive-yt-local.ts:267` (throw, don't return). **When reading a
  `yt-archive-behind` alert, confirm against
  `~/Library/Logs/hubandspoke-yt-archive.log` before concluding the cron is
  down** — attempts=0 is now trustworthy, but the log is authoritative.
- **Brand scope:** the home cron only archives the brands in its env file
  (`BRANDS` in `~/.config/hubandspoke/yt-archive.env`). The watchdog mirrors
  that list in `DEFAULT_WATCH_BRANDS`, overridable without a deploy via the
  `YT_ARCHIVE_WATCH_BRANDS` Heroku config var — **keep both in sync when
  changing the brand set.**
- **Belt-and-braces:** the wrapper itself (`home-machine/yt-archive/wrapper.sh`)
  also fires a Sentry event (fingerprint `yt-archive-home-cron`) on any exit
  other than 0/2, with the log tail attached. The server-side watch is the
  authoritative catcher — it fires even when the Mac is off.
- **Host-contention guards (added 2026-07-30).** The home Mac is shared with
  Pulse's local LLM judge, whose ollama model (`qwen3:30b-a3b`) holds ~19 GB
  resident on a 32 GB box. When that drove swap to 97% full, every yt-dlp child
  stalled past its 300s per-strategy timeout and one `heroku config:get` wedged
  in uninterruptible I/O for 60+ minutes. Because launchd will not start a
  second instance of a `StartInterval` job while the first is alive, that single
  hang blocked *every* subsequent hourly tick. Three guards now exist:
  - **Work check before anything else** (`--count-only`, added 2026-08-07) —
    the wrapper resolves `DATABASE_URL`, runs `archive-yt-local.ts --count-only`
    (a single DB query, prints `CANDIDATES=<n>`), and **exits 0 without touching
    ollama when there is no work**. Previously the eviction ran unconditionally,
    so a quiet day still cost 24 evictions — ~450 GB/day of pointless SSD reads
    reloading an 18.8 GB model plus 24 needless judge stalls. Measured: a no-work
    tick is now ~6s and leaves the model resident.

    The probe **fails open**: a timeout, error, or unparseable output means "assume
    there is work" and the normal path runs. A guard that quietly stops archiving
    is the exact failure that cost 2026-07-31 — never let this one do that.
    `--count-only` also skips the `HUBANDSPOKE_S3_BUCKET` requirement, so an
    unrelated S3 misconfiguration can't make the probe fail closed.
  - **Memory preflight with model eviction** — *only reached when there is work.*
    When swap free < 2 GB *and* system free memory < 15%, the wrapper evicts the
    loaded ollama model, waits for reclamation, and runs. Only exits **8**
    (→ Sentry) if memory is still exhausted afterwards.

    **Why eviction and not just skipping:** skipping alone was tried first and
    failed — Slope's judge holds `qwen3:30b-a3b` (~18.8 GB) resident 24/7 on
    this 32 GB box, so the preflight skipped **24 consecutive hourly ticks** and
    nothing archived for a full day. Measured over 5 minutes, the model never
    actually unloads on its own: it enters `Stopping...` and Slope re-requests
    it before the memory is released, so free memory never leaves 8–9%. There is
    no idle window to wait for, and a bare `ollama stop` is undone within
    seconds. The archiver has to take the memory, use it, and give it back.

    **Measured cost:** eviction reclaims ~2 GB of swap in ~32s; a full 5-video
    batch (incl. a 411 MB video) ran in 233s; the model reloads automatically on
    Slope's next judge call in **6s cold** — against pulse's 120s
    `AbortSignal.timeout`. So the price is a ~6s judge latency spike once an
    hour, only when there is archiving work. Set `YT_ARCHIVE_EVICT_OLLAMA=0` in
    `~/.config/hubandspoke/yt-archive.env` to disable and revert to skipping.

    Eviction is deliberately narrow: it fires only when the **top memory
    consumer is `llama-server`**, and only calls `ollama stop <model>`. It never
    kills arbitrary processes.
  - **`timeout 120` on `heroku config:get`** and **`timeout 3000` on the
    archive run** — no single call can ever again block later ticks.
  - **`LowPriorityIO` removed from the plist.** Its comment claimed it skipped
    runs on battery; it does not (that would be `PowerType`). It only
    deprioritized this job's disk I/O, which made the archiver the first thing
    on the machine to starve under memory pressure.

---

## Per-item child tasks

### `enrich-item` — enrich one item
- **Trigger:** enqueued by `enrichment-sweep`; on-demand `GET /api/cron/enrichment-sweep?itemId=<id>` (runs inline, doesn't enqueue); on-demand `POST /api/production-items/[id]/enrich`
- **Files:** `src/jobs/tasks/enrich-item.ts`, `src/lib/services/enrichment/orchestrator.ts:61-124` (`enrichSingleItem`), platform enrichers in `src/lib/services/enrichment/{instagram,youtube,youtube-community,twitter,threads,linkedin,tiktok,newsletter}.ts`
- **Inputs:** `{ productionItemId, force?, withMedia? }`
- **Outputs:** writes per-platform enriched fields (caption, author, like counts, media URLs); on success stamps `enrichmentCompletedAt`, clears `enrichmentError`, increments `enrichmentAttempts`. On **transient** failure (network, SC 5xx, 429): increments `enrichmentAttempts`, writes `enrichmentError` (1000-char cap), **throws** (graphile retries with backoff). On **permanent** failure (see rule below): stamps `enrichmentAttempts = MAX_ATTEMPTS` + `enrichmentError`, **swallows** (no throw → no retry, no Sentry).
- **Downstream:** **if `result.updates.mediaS3Key` was set**, enqueues `transcribe-whisper` via `maybeEnqueueWhisperTranscribe()` (`enrichment/orchestrator.ts`)
- **Rules:**
  - Idempotent on `enrichmentCompletedAt` (skips unless `force=true`)
  - Returns `null` if no enricher matches the platform (null / unmapped `post_type`) — but before returning, stamps `enrichmentAttempts = MAX_ATTEMPTS` + `enrichmentError = 'no-enricher-for-post-type:<pt>'` + fresh `updatedAt`. **Why (2026-07-14):** without this, unenrichable rows kept `attempts=0` and their old `updated_at`, so they stayed pinned to the front of the `(attempts ASC, updated_at ASC)` selection and ate the entire 50-item batch every tick — the sweep enqueued the same ~68 dead rows hourly and never advanced to real work. Stamping drops them out of the primary `attempts < 5` branch; the `updated_at < now()-24h` cooldown clause still re-checks them daily in case an enricher for their platform later lands. Mirrors the performance-decay path's `stampSyncResult()` guard.
  - **Permanent per-item failures fail soft (2026-07-19):** a bad/missing `published_link` (post_type routes to an enricher but the URL is for a different platform or absent — e.g. an `x.com` link on a `threads` item) or a deleted/private source post (SC 404/400) can never succeed on retry. The enrichers throw a typed `PermanentEnrichmentError` for URL mismatches (`src/lib/services/enrichment/errors.ts`); the orchestrator also classifies `ScrapeCreatorsError` with status 404/403/400 as permanent (403 = SC "forbidden" for private/age-gated/blocked posts, HUBANDSPOKE-26). Both catch blocks (`enrichSingleItem` + `runEnrichmentSweep`) stamp `attempts = MAX_ATTEMPTS` and **swallow** instead of re-throwing — before this, every such row threw out of the task every tick → graphile retry storm → one Sentry page per max-attempts exhaustion (HUBANDSPOKE-20/27/1Z/23/28/29/2A, the top recurring worker errors). Rows are left **un-completed**, so a corrected `published_link` self-heals on the next 24h-cooldown sweep. The final persist (`persistEnrichmentUpdates`) additionally catches a `23505` collision on `uniq_production_items_platform_content_id_global` (two rows backed by the same underlying post — the newsletter enricher deriving a duplicate campaign id) and re-persists the rest of the enrichment without `platform_content_id` rather than crashing (HUBANDSPOKE-1Y).
  - `withMedia=true` (Instagram only) also archives the raw video to S3 (10 SC credits vs ~2)
  - **LinkedIn OG image fallback (V1.4, 2026-05-09):** when SC's `/v1/linkedin/post` returns empty `images[]` AND no `thumbnail` / `thumbnailUrl`, the LinkedIn enricher fetches the post URL itself (5s timeout, ~64 KB read cap) and parses `<meta property="og:image">` from the head as a final fallback before giving up on media. Best-effort: failures log a `console.warn` and never block enrichment. Closes the gap where SC under-reports media on some LinkedIn share variants.
  - **Newsletter (Klaviyo) enricher (2026-05-15):** for `post_type='newsletter'`, fetches `GET /api/campaign-messages?filter=equals(campaign_id,…)` then `GET /api/campaign-messages/{id}` and writes: subject → `title`, raw HTML → `newsletterBodyHtml`, plaintext (via `sanitize-html` + block-tag → newline pre-pass) → `contentBody`, preheader → `newsletterPreviewText`, `from_email`/`from_label` → `authorHandle`/`authorDisplayName`. First sentence → `hook` (`hookSource='body'`, `hookExtractor='newsletter-enricher:v1'`) so newsletters get a populated hook column without the LLM hook sweep (which is short-form-only).
    - **Campaign id URL fallback (2026-05-15):** when `platform_content_id` is null but `published_link` matches `https://(www.)?klaviyo.com/campaign/<ulid>/…`, the enricher extracts the campaign id from the URL and stamps it onto the row (`updates.platformContentId`) so the next run skips this step. Recovers Notion-imported rows that predate the Klaviyo sync and never got a campaign id stamped. Backfill: `scripts/backfill-newsletter-enrichment.mjs --apply` re-enqueues `enrich-item` with `force=true` for rows matching this shape.

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
- **Non-image poster guard:** before calling vision, the extractor checks `posterS3Key`'s extension and short-circuits to a skip+stamp if it's not jpg/png/webp/gif (OpenAI's actual supported set — *not* heic/heif/avif, which the API rejects with `400 You uploaded an unsupported image`; HUBANDSPOKE-V, 179 events in 8 min when an iPhone HEIC poster slipped through). Same `isLikelyImageKey` helper is now also applied in `src/lib/services/hook-extract/dispatcher.ts` before presigning the poster URL, so the unified dispatcher path doesn't bypass the check. Legacy rows (pre-2026-05) can have a video key in `posterS3Key` because the media-confirm route used to fall back to `s3Key` for video slides — see HUBANDSPOKE-J (Sentry).
- **Bytes-level fallback (2026-05-17):** the extension allowlist catches obvious mismatches but not bytes-level ones — a `.jpg` key whose contents are actually HEIC, or a truncated/zero-byte poster-extract output. The dispatcher (`callLLM` in `src/lib/services/hook-extract/dispatcher.ts`) now wraps the image-bearing OpenAI call in a try/catch — on `BadRequestError`, it retries once without the image so text signals (title/body/transcript) still produce a hook and `hookExtractedAt` stamps. Without this every sweep re-tried the same item; HUBANDSPOKE-V was 237 events in one day on this bypass before the catch landed.

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

### Clip-format resolution tolerates a stale `target_format` (2026-06-19)
- **Where:** `src/lib/services/promote-clip-idea.ts` — `loadPromotedClipFormat`, called by all three `createClipIdeaInDescript*` paths.
- **What:** the clip-idea generator stores `formats.name` into `clip_ideas.target_format` at generation time. When a format is later **renamed**, every previously-generated idea's stored string stops matching. `loadPromotedClipFormat` does an exact-name lookup; the no-match branch used to throw `NoClippableFormatForBrandError`, which **no route caught** → the promote UI showed a bare `Failed (502)`. This stranded ~4000 suggested ideas (my-first-million `Repackage Section w/ Hook` → renamed to `Repackage Section With Hook`; futurepedia `Repackage Section w/ Hook` → renamed to `Shorts: Repackage Section with Hook`).
- **Fix:** on no exact match, fall back to the brand's primary clippable format (same contract as `getPrimaryClippableFormat`) and `console.warn` the drift, instead of throwing. `NoClippableFormatForBrandError` now fires only when the brand has **zero** clippable formats, and all three routes catch it → actionable 400, never a 502. Safe because every brand carrying stale rows has exactly one clippable format; multi-clippable brands (matg, starter-story) have no stale rows.
- **Stops the drift at the source (2026-06-19):** the fallback above rescues *existing* stale rows; `cascadeFormatRename` (`src/lib/services/format-rename.ts`) stops new ones. Format name is the string key that `production_items.format` + `clip_ideas.target_format`/`accepted_target_format` join on, so `PUT /api/formats` now rewrites every referencing row in the same transaction as the `formats.name` UPDATE, **brand-scoped** (clip_ideas has no brand column — scoped via `source_production_item_id → production_items.brand`; the same name can exist on two brands, e.g. "X Quotables" on matg + starter-story, so an unscoped rewrite would corrupt the other brand). `GET /api/formats/rename-impact` feeds the format-detail confirm dialog its blast radius before the rename commits. Replaced the old unconditional, unscoped `productionItems.format`-only rewrite in the PUT route (cross-brand bug; skipped clip_ideas entirely).

### Underlord agent prompt — Descript packs (per-format)
- **Tables:** `descript_packs` (id, name, prompt, created/updated_at) — first-class reusable entity. `formats.descript_pack_id` is a nullable FK; null means "no Descript creation allowed for this format" and gates all four clip-triage dropdown items.
- **Where:** `src/lib/services/promote-clip-idea.ts` (`buildDescriptPrompt` + `loadPromotedClipFormat` for the agent path); `src/jobs/tasks/clip-idea-precise-cut.ts` (loads pack via `repurpose_triggers.target_format_id → formats.descript_pack_id → descript_packs.prompt` for the precise-cut layout-apply phase); `src/lib/descript.ts` (`buildLayoutPackPrompt`, `substituteFormatPrompt`).
- **Pack prompt is path-agnostic:** describes what to do *to a composition* (apply layout pack, set hook track, ignore fillers, etc.). Code wraps with path-specific scaffolding — agent path adds "find segment X-Y, create a new comp" preamble; precise-cut adds "apply to compositionId='Y'" preamble. Same pack prompt drives both paths.
- **Placeholders** substituted before sending to Underlord: `{{hook}}`, `{{startTimestamp}}` (HH:MM:SS), `{{endTimestamp}}`, `{{startSec}}`, `{{endSec}}`, `{{durationSec}}`, `{{compositionId}}` (empty on agent path). Unknown placeholders pass through (so typos are visible).
- **Layout-pack URL** lives literally inside the pack prompt as a Descript project URL like `https://web.descript.com/<uuid>` (verified Underlord resolves URLs end-to-end on 2026-05-05). Editing that URL in the pack swaps the layout for every format using the pack on the next promotion — the dynamic-config goal.
- **Gating** (`createClipIdeaInDescript*` + clip-triage UI): the styling paths (Precise Cut, Underlord Edit, Full Video) require a Skill/pack — service throws `FormatMissingDescriptPackError` (caught by the routes → 400) when missing, and the UI disables those items + shows "No Descript pack attached". **Buffered Cut is exempt (2026-08-27):** it runs no Underlord call, so it works for formats with no pack (e.g. X Quotables, which has Descript info but no layout pack). Enforced by `loadPromotedClipFormat({ requireSkill: false })` in the buffered branch + the buffered UI item no longer being `disabled={!packAttached}`.
- **Three promotion options surfaced in BOTH the clip-triage dropdown** (`src/components/dashboard/clip-triage-dialog.tsx`) **and the content-detail "Send to Descript" submenu** (`src/components/dashboard/content-detail.tsx` → `POST /api/production-items/[id]/send-to-descript?mode=…` → `reprocess-in-descript.ts`). As of 2026-08-27 both surfaces show identical labels, descriptions, and order:

  | UI Button | Service entrypoint (triage) / `mode` (content-detail) | What editor receives |
  |---|---|---|
  | Full Video | `createClipIdeaInDescriptFullVideo` / `mode=full` | Full pillar video as a new composition — editor trims manually. No AI. |
  | Precise Cut + Layout Pack | `createClipIdeaInDescriptPreciseCut({ applyLayoutPack: true })` / `mode=precise` | New project with exactly Claude's startSec–endSec, then the format layout pack applied via Underlord. No re-trim (see below). |
  | Buffered Cut (No Underlord) | `createClipIdeaInDescriptPreciseCut({ buffered: true })` (route drops `ai=1`) / `mode=buffered` | New project with Claude's range ±60s padding. Plain trim — **NO Underlord call**, imports as-is (source orientation), no layout pack. Editor finalizes the boundaries and styles it. Original timestamps preserved. |

  **Buffered Cut deliberately skips Underlord (2026-08-27):** enforced at the service layer — `createClipIdeaInDescriptPreciseCut` forces `applyLayoutPack=false` when `buffered`, and `reprocess-in-descript` sends `applyLayoutPack: mode === "precise"`. So buffered never fires a paid Underlord call regardless of the route's `ai` param. Rationale: buffered exists for editing room (the editor re-trims), so applying a tight-clip layout pack to un-finalized footage is premature; and pack application was unreliable anyway (see [[descript-layout-pack-fidelity-account-switch]]). Re-enabling is a one-line flip once the Descript-side pack fidelity is fixed.

  **Underlord Edit was removed from BOTH UIs on 2026-08-27** — its route (`create-in-descript`) and backend (agent path / `reprocess … mode=agent`) are retained for now; scheduled for separate removal after confirming no other callers.

  Internal `descriptImportPath` values (`"full-video"`, `"precise-cut"`, `"agent"`) are unchanged — previously queued jobs continue to resolve correctly. Buffered Cut reuses `"precise-cut"` as its import path; the wider range is carried in `ClipIdeaPreciseCutPayload.cutStartSec`/`cutEndSec`.

- **Precise Cut's layout step NEVER re-clips (2026-08-27):** when `applyLayoutPack=true` (Precise Cut, or the agent-fallthrough), the `clip-idea-precise-cut` task imports a composition ffmpeg has already trimmed to a deliberate range, so its layout phase always calls `buildLayoutPackPrompt({ preserveAllFootage: true })` — the hard no-trim override. Previously it re-clipped unless an intro was prepended, which could re-trim a Precise Cut below Claude's exact range (Underlord's free-form re-selection was observed grabbing a garbage frame). The override's framing follows the format's resolved `aspectRatio` (16:9 formats like X Quotables stay horizontal) instead of a hardcoded 9:16. Buffered Cut no longer reaches this phase (`applyLayoutPack=false`).

- **Buffered Cut range:** `cutStartSec = Math.max(0, startSec - 60)`, `cutEndSec = endSec + 60`. ffmpeg stops naturally at actual EOF if `cutEndSec` exceeds file length. Original `startSec`/`endSec` on the clip idea row are never overwritten.
- **Agent-path fall-through:** when a clip-idea source has `mediaS3Key` but no Descript project yet, `createClipIdeaInDescript` transparently falls through to `createClipIdeaInDescriptPreciseCut({ applyLayoutPack: true })` — the precise-cut Underlord layout-apply path. This is an internal routing detail not visible in the UI.
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
- **Downstream:** **narrow auto-enqueue of `generate-clip-ideas` (2026-06-09):** after a phase-2 transcript save, `maybeAutoEnqueueClipIdeas` fans out one `generate-clip-ideas` job per clippable format — but ONLY when a cost gate in `src/lib/services/clip-ideas-auto.ts` passes. Two paths through the gate: (1) **source_recording items** (`source_type='source_recording'`, `post_type='youtube_long'` — covers both MP4 uploads via `+ Custom MP4 upload` and external YouTube links via `+ Upload external link`) — skip the brand allowlist, Published status, and recency cap entirely; the upload itself is the intent signal. (2) **standard youtube_long originals** — brand auto-enabled (since 2026-08-20 the default is derived from the data: any brand with ≥1 clippable format qualifies, so creating the clippable format in the UI IS the per-brand opt-in; setting `AUTO_CLIP_IDEAS_BRANDS` overrides with an explicit allowlist, empty string = kill switch), `status='Published'`, `source_type='original'`, `post_type='youtube_long'`, and published within the last 7 days (`AUTO_CLIP_IDEAS_MAX_AGE_DAYS`); recency cap exists so whisper backfill scripts over old videos never fan out. **Account-aware routing (2026-08-31):** once the gate passes, the fan-out no longer targets every clippable format on the brand — it targets only the clippable formats wired to the pillar's OWN source account, mirroring the threshold-monitor-sweep's routing (root formats via `format_trigger_sources`; derivative formats via the DIRECT PARENT's `format_channels`, matched on account + post_type). This stops a sibling channel on a shared brand (e.g. @Howfinity) from spawning another channel's clip ideas (e.g. @futurepedia_io's `Repackage Section w/ Hook`). Accountless items (some source_recordings) have no channel to route by and fall back to the brand-wide fan-out via `getClippableFormats`. Same routing governs the manual Regenerate route's default fan-out (`/api/production-items/[id]/clip-ideas/generate`); an explicit `targetFormatId` there still bypasses the check as an operator override. Best-effort: enqueue failures log and never fail the transcript save. Everything else remains manual-only.
- **Rules:**
  - **Skips at top if a `transcripts` row with non-empty `fullText` exists** for this item (don't burn another API call).
  - **Fail-soft on unprocessable media (2026-07-19):** the task catches `WhisperTranscribeError` whose kind is permanent (`no_media`, `not_av`, `ffmpeg_failed`, `audio_too_large` — see `isPermanentWhisperError`) and returns cleanly instead of throwing. Before this, a video with no decodable stream (corrupt / wrong container / image mislabeled as video) threw `ffmpeg exited 1: Output file #0 does not contain any stream` on every graphile retry until max-attempts → a Sentry page each time (HUBANDSPOKE-24). The ffmpeg **timeout** path was split off to its own retryable kind `ffmpeg_timeout` (a slow-dyno/big-file resource condition, not bad input), so genuine timeouts still retry with backoff; only truly-unprocessable media is swallowed.
  - **Short-invocation pattern**: phase 1 finishes with a re-enqueue for phase 2 (1s delay), so a SIGTERM during ffmpeg or Whisper doesn't waste the other half.
  - Uses jobKey `transcribe-whisper:<id>` so back-to-back UI refetch clicks dedupe.
  - **Chunking** handles long-form content (podcasts): each chunk is ≤10 min and stays under OpenAI's 25 MB per-request cap. For chunk N>0 the prompt appends the tail of running fullText so context carries across the cut (helps with mid-sentence splits and keeps name-bias sticky).
  - Extracted audio stays in S3 — enables future re-runs (different model, diarization, vision) without re-downloading the full video. ~5 MB per 24-min video.

### `generate-clip-ideas` — Splice v10 two-pass clip-idea pipeline
- **Trigger:** **Fan-out per clippable format**, from two places:
  - **Manual:** `POST /api/production-items/[id]/clip-ideas/generate` enqueues one job per `is_clippable_format=true` row on the pillar's brand. Body accepts `{ targetFormatId?, forceSections? }` — `targetFormatId` limits to one format; `forceSections: true` kills the existing section batch + cascade-deletes its derived clip_ideas across every format and re-detects from scratch.
  - **Auto (2026-06-09, narrow; extended 2026-06-29):** `transcribe-whisper` phase-2 success fires the same fan-out for (a) `source_recording` items uploaded via `+ Custom MP4 Upload` (`source_type='source_recording'` bypasses brand allowlist/status/recency gates) and (b) youtube_long originals on auto-enabled brands — gates in `src/lib/services/clip-ideas-auto.ts` (default since 2026-08-20: any brand with ≥1 clippable format; `AUTO_CLIP_IDEAS_BRANDS` env = explicit-allowlist override, empty = kill switch; plus Published + original + youtube_long, ≤7-day recency `AUTO_CLIP_IDEAS_MAX_AGE_DAYS`). The global post-`transcribe-whisper` auto-enqueue removed 2026-05-03 stays removed for everything else; per-(pillar, format) idempotency makes the auto path safe to race with a manual click.
- **Files:** Section picker → `src/lib/clip-section-agent.ts` (Sonnet 4.6, format-agnostic) + `src/lib/services/clip-sections-detect.ts` (advisory-lock + persistence). Hook writer → `src/lib/clip-hook-agent.ts` (Haiku 4.5, per-(section, format)). Orchestrator → `src/lib/services/clip-idea-generate.ts`. Shared anchor utils → `src/lib/clip-anchor-utils.ts` (used by both v1 legacy and v2 agents). Worker task → `src/jobs/tasks/generate-clip-ideas.ts`.
- **Brand language (2026-08-20):** the orchestrator (`clip-idea-generate.ts`) looks up `brands.language` by slug after loading the item and passes it into `writeFormatHookForSection` (`HookGenerateArgs.language`). When `"pt-BR"`, the hook writer appends `"Respond exclusively in Brazilian Portuguese."` to its system prompt. All other brands default to English (no prompt change).
- **v10 two-pass architecture (2026-05-22):** clip ideas are now generated in two passes instead of one full Sonnet pass per format:
  - **Pass 1 — section detection (Sonnet 4.6, `claude-sonnet-4-6:section-v1`, ~$0.10/pillar):** reads the full pillar transcript, picks 8-15 distinct "interesting moments" and persists each as a `clip_sections` row with `start/end_sec`, verbatim `transcript_anchor_quote`, one-line `topic`, neutral 2-3 sentence `summary`, free-form `theme_tags`, and `estimated_views`. Format-agnostic. One batch per pillar; subsequent format jobs for the same pillar reuse it via a Postgres advisory lock keyed on `pillar_id`. `force_sections: true` marks the existing batch killed and re-runs.
  - **Pass 2 — per-format hook writing (Haiku 4.5, `claude-haiku-4-5-20251001:hook-v2`, ~$0.003/call):** for each section × clippable format, a Haiku call reads the section's transcript excerpt + that format's `## Clip Idea Generation` skill section + 5 reference hooks. Returns `{ eligible, reason, hook?, angle?, rationale?, extras?, tightStartSec?, ... }`. **Auto-eligibility model:** when the section doesn't fit the format (e.g. a non-tech-stack section evaluated against the Tech Stack format), Haiku returns `eligible: false` with a one-sentence reason — no `clip_ideas` row inserted, reason logged to worker output + Sentry. Format formats see ~30-70% eligibility on a typical pillar.
  - **hook-v2 — subject-strict eligibility (2026-05-27):** v1 decided fit on framing and would stretch a section to match a format's name — it accepted an app-feature *demo* (founder walking through what his app does: calculator, dose logger, injection tracker) for the Tech Stack format by relabeling it a "feature stack." The eligibility constraint never reached the writer: the Tech Stack format had **no `## Clip Idea Generation` section**, so the writer fell back to the generic default block (zero subject rule) — the only "tech stack only" instruction lived in `### Descript Clip & Pack Info`, read far later at cut time. Fix was two-part: (1) the shared eligibility prompt (`clip-hook-agent.ts` step 1) now matches on the section's *actual subject* and explicitly forbids reframing/relabeling to fit a narrow-subject format; (2) the Tech Stack format gained a `## Clip Idea Generation` section defining tech-stack (tools the product is built on) vs app-features (what the product does for users). Guarded by `src/lib/clip-hook-agent.eval.test.ts` (gated live Haiku eval — `npm run test:eval`) + deterministic wiring tests in `clip-hook-agent.test.ts`.
  - **Per-pillar cost (3 clippable formats, ~15K char transcript):** ~$0.10 (sections) + 36 gpt-4.1 hook calls ≈ ~$0.50–1.00. Adding a 4th format costs ~$0.15 marginal. Was ~$0.30 in v9 (3 × $0.10 independent Sonnet passes). Hook writer upgraded from gpt-4.1-mini to gpt-4.1 (2026-08-04) to recover clip quality.
- **Legacy V9 prompt (2026-05-21, retired):** single Sonnet pass per format with `SECTION_SELECTION_PROMPT_BASE` + per-format FORMAT block. Replaced by v10's two-pass split. Legacy `clip_ideas` rows (4358 as of cutover) have `clip_section_id = NULL` and stay readable in their per-format Queue tabs; promote/Descript flows are unaffected.
- **V8/V7/V6 history:** lead-in cap (`MAX_LEAD_IN_SEC=15`), verbatim `transcriptAnchorQuote` gate, `blueprintAnchorHook` from format reference library. All preserved in v10's shared `clip-anchor-utils.ts` + per-pass validation.
- **Outputs:**
  - One `clip_sections` batch per pillar (8-15 rows, one batch alive at a time per pillar; older batches killed when `force_sections: true`).
  - Per-format: one `clip_ideas` row per eligible section (count varies by format — universal formats get ~all sections, conditional formats like Tech Stack get a subset). Each row carries `clip_section_id` FK + `eligibility_reason` (Haiku's audit trail) + `target_format` + `extras` JSONB.
  - One paired `production_items` row per `clip_ideas` row (`source_type='repurposed'`, `source_clip_idea_id` back-link, platform/postType from format's `clip_target_*` columns).
- **Downstream:** new `Idea` rows surface in the brand's per-format Queue tab. Killing a `clip_sections` row cascade-deletes its derived `clip_ideas` (and via existing FK, the production_items siblings). Operator-facing "Regenerate" on the per-pillar Clip Ideas panel offers two modes — "Regenerate hooks only" (re-runs pass 2 across all formats, sections unchanged) vs "Regenerate sections + hooks (full)" (re-runs both passes).
- **Rules:**
  - **Backfill path gates** on `source_type='original'` AND `post_type='youtube_long'`. Manual route passes `skipPostTypeGate: true`.
  - **Idempotent at two layers:** (1) sections are detect-once-per-pillar via the advisory lock; (2) per-(pillar, target_format) clip_ideas skip if a batch already exists (unless `force: true`). Worker retries are safe.
  - **Concurrency:** Pass 2 runs hook writers across sections in parallel with a 5-wide semaphore (`mapWithConcurrency` in clip-idea-generate.ts).
  - Editor on the new prod_item rows: manual route uses the actor; cron/backfill path falls through `resolveEditor`.
  - **Eligibility logs:** every skipped (section, format) pair is logged to worker output as `[clip-idea-generate] section "<topic>" skipped for format "<name>": <reason>`. Useful when triaging "why didn't Tech Stack spawn ideas for pillar X?"
  - **Per-format clip count cap (`clip-count` block, 2026-08-17):** a format's `## Clip Idea Generation` skill section can include a fenced block to cap how many clip ideas get inserted. When present, the service sorts eligible sections by estimated views descending and takes only the top N. Absent = no cap (all eligible sections produce a clip idea — existing behavior for every format without the block). Example: add the block below to a format's skill to cap at 1 idea per pillar: ` ```clip-count` / `1` / ` ``` `. Parsed by `extractClipCount` in `src/lib/format-skill.ts`; applied in `src/lib/services/clip-idea-generate.ts` after pass 2 completes.

### `draft-algorithm-run` — The Draft Algorithm V1.7 (2026-05-15)
- **Trigger:** auto-enqueued from four places — (1) `POST /api/production-items/[id]/cross-post` after the seed-content tx commits, for any post type in `CROSS_POST_SEEDED_TARGETS`; (2) `POST /api/production-items/[id]/repurpose` after the new row + repurpose-trigger inserts (manual repurpose); (3) `threshold-monitor-sweep.ts` after each cron-created `sourceType='repurposed'` row — so derivatives created when a pillar crosses a child format's `viewThreshold` land with a populated draft instead of a blank form; (4) `promote-clip-idea.ts` — every clip-idea promotion path (`assignClipIdea`, `createClipIdeaInDescript`, `createClipIdeaInDescriptPreciseCut`, `createClipIdeaInDescriptFullVideo`) fire-and-forgets after flipping the production_item to `Assigned`, so the new Reel/Short lands with a populated caption instead of a blank field. Also called *synchronously* by `POST /api/production-items/[id]/draft` — the Regenerate button on every simulator caption panel skips the queue and waits for the agent inline (Opus call ~5–10s; route's `maxDuration` is 60s). **Repost does not fire** — the seeded `copy:source` body is kept verbatim because same-content same-platform doesn't benefit from a rewrite.
- **Files:** `src/jobs/tasks/draft-algorithm-run.ts`, `src/lib/services/draft-algorithm/run.ts`, `src/lib/services/draft-algorithm/exemplars.ts`, `src/lib/draft-agent.ts` (the underlying Opus agent — unchanged), `src/app/api/production-items/[id]/draft/route.ts`. **Forwarder:** `src/jobs/tasks/generate-instagram-caption.ts` is kept under the old task name so any in-flight `generate-instagram-caption` jobs in `graphile_worker.jobs` resolve to the new algorithm; safe to delete in V2 once queue has drained.
- **Inputs:** `{ productionItemId, force? }`. Service loads (a) the pillar transcript via `getTranscriptForPrompt(item.pillarContentItemId ?? item.id)`, (b) `formats.instructions` for editorial voice, (c) up to 8 **view-ranked, format-scoped-first** published `productionItems.contentBody` rows. **V1.2 exemplar policy:** the helper first pulls rows where `lower(format) = lower(item.format)` AND `(brand, post_type)` match AND `published_at > now() - 180 days`, ordered `views DESC NULLS LAST`. If fewer than 5 format-scoped winners exist, the bag is topped up to 8 with platform-scoped rows (v1.1's brand+post_type filter, excluding the format ids already pulled). The two groups are tagged via a `source: "format" | "platform"` discriminator on `PastCaptionExample` — the prompt builder renders them as separate labeled blocks (`## TOP-PERFORMING EXAMPLES IN THIS FORMAT — "<format name>"` vs `## OTHER STRONG EXAMPLES ON THIS PLATFORM`). The system prompt's STRUCTURE RULE points only at the format block: "mirror recurring structural patterns (timestamp breakdowns, listicles) when the format examples share one." Platform-scoped rows stay voice/tone reference. Whole premise: structure lives at the format level — see HUBANDSPOKE issue / Pat's screenshot of Full Video On X! tweets that all open with a hook + bulleted timestamps.
- **Outputs:** a new `contentDrafts` row via the demote-then-insert tx (current row → `is_current=false`, new row → `is_current=true`, same `production_item_id`, version+1). `generatedBy = "draft-algo:v1.7:claude-opus-4-7:v13"` — the prefix tags the algorithm version, the suffix carries the underlying agent model+prompt version (`PROMPT_VERSION` bumped to 13 for the v13 proximity rule + prior-pairs few-shot + required-field validation — see V1.8 rule below). `modelUsage` populated. **V1.1 media write still active:** if the agent's `media_action` is `attach_pillar_full_video` or `attach_pillar_poster` AND the item has zero existing `production_item_media` rows AND the action is fulfillable (pillar has the asset, platform rule accepts the kind), the algorithm inserts a media row pointing at the pillar's S3 key (byte-cost zero — same bucket reuse) inside the same tx, and mirrors `mediaS3Key/Bucket/ContentType/posterS3Key` on `productionItems` to keep legacy single-media columns consistent.
- **Downstream:** none.
- **Rules:**
  - **Source-type branch:** `repost` with `force=false` (auto-fire) skips with `repost_kept_verbatim`; `repost` with `force=true` (manual Regenerate, 2026-05-20) takes the re-seed path below; `original` with no `pillarContentItemId` (= a true pillar item) skips with `pillar_item_no_draft`; `cross_post`, `repurposed` (covers both threshold-monitor cron auto-spawns AND clip-idea-promoted rows — the latter set `sourceClipIdeaId`), and `original`-with-pillar (manually-created repurpose) all fall through and draft.
  - **Repost re-seed (V1.8, 2026-05-20):** clicking Regenerate on a `sourceType='repost'` row used to hit the unconditional skip and toast `repost_kept_verbatim` — useless when the initial seed wrote an empty body (source unenriched at create time) or the source body has since changed. Manual Regenerate now calls `reseedRepostDraft` (in `run.ts`): re-fetches `source.contentBody`, runs it through `stripDateOpenerWithLLM` (same Haiku cleanup as the create route), demote-then-inserts a new draft version with `generatedBy="copy:source:reseed"`, and emits an `import`-source `content_changed` event. No LLM rewrite — repost is same-content same-platform, the agent loop stays out of this path. New skip codes for the unhappy cases: `source_body_empty` (source exists but has no body) and `no_source_for_reseed` (defensive — `repostedFromItemId` null or pointing at a missing row). Both surface as friendly toasts on the `/draft` route. Auto-fire path (any non-Regenerate enqueue, today there are none) keeps the verbatim skip.
  - **V1.1 media-action enum:** the agent emits `media_action ∈ {attach_pillar_full_video, attach_pillar_poster, none}`. Decision is driven by the format **Skill** (the `formats.instructions` text) — directives like *"This tweet should have the full video from YouTube as the media of the tweet"* translate to `attach_pillar_full_video`. The service skips the attach silently if the item already has any media (preserves manual edits and makes Redraft idempotent), if the pillar lacks the requested asset, or if the platform rule rejects the implied kind.
  - **V1 supported post types** (everything else skips with `unsupported_post_type`): `x`, `linkedin`, `instagram_post`, `instagram_reel`, `instagram_story`, `tiktok`, `youtube_community`, `youtube_shorts`, `threads`. Newsletter + youtube_long are out of scope — editors hand-write those today.
  - **Idempotency:** skips with `reason="already_filled"` when the current draft has a non-empty primary caption AND `generatedBy !== "copy:source"` AND `force=false`. Auto-fire overwrites the seeded `copy:source` body; manual Regenerate button passes `force=true` when an existing caption is present.
  - **Substrate (V1.4):** the agent grounds its draft in either (a) the upstream's transcript when one exists (long-form pillar derivatives — unchanged path) or (b) the upstream's `contentBody`, falling back to `description` (LinkedIn long-form bodies live in this column — SC routinely returns the multi-paragraph LinkedIn body under `data.description` rather than `data.text/bodyText/postBody/headline`, and the LinkedIn enricher writes it through unchanged), then `title`. Upstream resolution chain is `pillarContentItemId ?? repostedFromItemId ?? item.id` — V1.2 was missing the `repostedFromItemId` step, so cross-posts always fell through to `item.id` (the just-created empty new row) and skipped with `no_transcript`. **Skip code is `no_substrate`** and only fires when transcript, body, description, AND title are all empty across the chain. Auto-fire silently no-ops on `no_substrate`; manual route returns 400 with a friendly message.
  - **Rich-substrate prompt directive (V1.4) — REPLACED by platform-proximity rule (V1.8, see below).** Original behavior: when the resolved `source_body` substrate was ≥120 characters or contained a newline, the SOURCE POST BODY block told the agent to *pull EVERY concrete element*; short substrates got a softer "adapt this." Now keyed off platform proximity, not source length.
  - **Platform-proximity rule (V1.8, 2026-05-20):** the SOURCE POST BODY directive is now driven by the (sourcePostType, targetPostType) pair instead of source body length. Three tiers in `src/lib/services/draft-algorithm/platform-proximity.ts`: `same_surface` (x ↔ threads — preserve near-verbatim, only trim for length cap), `same_family` (text-primary triad crossings like x ↔ linkedin, visual-primary caption family like instagram_post ↔ tiktok — preserve spine, tighten/expand at edges), `cross_family` (everything else — the legacy "pull every concrete element" behavior). System prompt has a new PROXIMITY RULE section paired with the existing STRUCTURE RULE — proximity HARD-OVERRIDES the past-caption exemplars on rewrite aggressiveness (exemplars still teach voice and structure). Fixes the Threads → X failure where the v7 length-based heuristic told the agent to expand a near-identical surface.
  - **Prior cross-post pairs few-shot (V1.8, 2026-05-20):** for `source_body` substrates, the algorithm now loads the team's last 3 published `(sourcePostType → targetPostType)` cross-post pairs for the same `accountId` via `src/lib/services/draft-algorithm/prior-cross-post-examples.ts` and renders them as a `## PRIOR CROSS-POST EXAMPLES` block ABOVE the past-captions exemplars. Same-brand only — see plan: cross-brand pairs risk mixing voices. The PROXIMITY RULE tells the agent these examples HARD-OVERRIDE exemplars on the *how much rewriting* question. Block is omitted when no pairs exist; proximity rule alone is the signal until the team accumulates pairs in a direction.
  - **Required-field validation + one-shot retry (V1.8, 2026-05-20):** after the agent calls `propose_draft`, `findEmptyRequiredFields(input, fieldSchema)` walks the platform's field schema for any `required: true` field that normalizes to empty. If empty: the loop appends a tool_result + corrective user message naming the empty fields and re-calls the agent ONCE. After one retry, throws `DraftGenerationError` with `code: "empty_required_field"` instead of writing an empty draft to the DB. Fixes the YouTube Community failure where the agent silently returned `body: ""` and the editor saw the `"Write a post for the Community tab…"` placeholder.
  - **`itemAlreadyHasMedia` (V1.4):** the algorithm queries `production_item_media` rows on the target item before calling the agent and surfaces `{ count, kinds }` in `MediaContext`. Cross-posts inherit source media via `seedRepostContent` *before* the algorithm fires, so this signal tells the agent the post will publish with N images already attached and to pick `media_action="none"` (the system prompt's MEDIA ACTION RULES enforce this). Without the signal the agent had no idea the source-mirrored media existed and could try to attach pillar media on top.
  - **Agentic tool loop (V1.5, 2026-05-10):** `generateDraft` is no longer a single-shot `messages.create` with `tool_choice` forcing `propose_draft`. It's now a loop (max 5 iterations) with `tool_choice: "auto"` — the agent picks tool calls itself. Specialized tools run as separate Anthropic calls and return their results to the main agent via `tool_result` messages; the main agent calls `propose_draft` as its terminal action. Architecture supports adding more tools (e.g. `find_money_quote`, `find_image_moment`) as one-file changes inside the same loop. Loop bounds: typical drafts run 1–2 iterations (zero or one tool call + the propose_draft); the 5-iteration cap throws so runaway tool-loops are visible in Sentry. Token usage on `content_drafts.modelUsage` accumulates across iterations.
  - **First specialized tool: `find_interesting_timestamps` (V1.5).** Lives in `src/lib/services/draft-algorithm/timestamp-finder.ts`. Registered in the agent's `tools[]` only when `substrate.kind === "transcript"` (cross-posts using source-body substrate skip the tool entirely — single-shot exactly like v1.4). The tool runs a separate Opus 4.7 sub-agent with the raw `transcripts.segments` jsonb array (not just the rendered markdown) and returns `Array<{ mmss, label, reason }>` with N validated picks. Each `mmss` is post-validated against the segments — out-of-range values are dropped with a `console.warn` so the main agent never sees fabricated timestamps. Cost: ~$0.015/call, so a transcript-bearing draft that triggers the tool is ~$0.045 vs $0.03 for tool-less drafts. Pat picked Opus deliberately for editorial judgment ("what's interesting" needs nuance).
  - **On-demand exemplar enrichment (V1.6, 2026-05-10):** the format-scoped exemplars query no longer pre-filters on `contentBody IS NOT NULL`. It pulls the top N by views regardless, then on-demand calls `enrichSingleItem` on any row missing a body — in parallel, capped at 10 seconds total wall time. Pre-v1.6 the algorithm silently skipped top-performer items that hadn't been enriched yet (e.g. the 373K-view "Full Video On X!" tweet was sitting in the DB unenriched and never reaching the agent — see Pat's audit). Rows that still have no body after the enrichment pass are dropped with a `console.warn` listing their ids. Platform-scoped top-up rows keep the contentBody filter (no enrichment) to bound SC credit cost — they're voice/tone reference, not structural.
  - **Skill-count adherence (V1.6):** the system prompt's TOOLS section now spells out that when the format Skill specifies a count (e.g. "4-6 timestamp bulletpoints"), the agent must pass that count to `find_interesting_timestamps` and retry ONCE with a broader focus if the tool short-returns. The `tool_result` body now carries `{ requestedCount, validatedCount, timestamps, note? }` so the agent has structured numbers to reason about rather than counting an array by eyeballing.
  - **Diagnostic logging (V1.6):** worker logs now print, per draft, `draft-algorithm v1.6 item=<id> format="<name>" substrate=<kind> skill_chars=<n> skill_head="<first 160 chars>"` and `exemplars_format=<n> exemplars_platform=<n>`. Plus per tool call: `draft-agent v1.6 tool=find_interesting_timestamps iter=<i> focus="..." count=N` and `timestamp-finder: focus="..." requested=N validated=M (dropped K)`. Lets Pat audit Skill-reading and tool-counting end-to-end via `heroku logs --dyno worker --tail | grep draft`.
  - **Descript branch (V1.7, 2026-05-14; cold-import added 2026-05-15; per-derivative hook generation added 2026-05-15; flag decoupled from clip-promotion 2026-05-18):** after the caption-write tx commits, the algorithm checks whether the format Skill contains a `### Descript Clip & Pack Info` heading. When it does, it runs `runDescriptStepForDerivative` (in `src/lib/services/draft-algorithm/descript-step.ts`) which extracts the format Skill's `### Descript Clip & Pack Info` section. If that section contains the `{{hook}}` placeholder (six of the in-use clip-descript formats do — e.g. "Repackage Tech Stack With Hook"), it calls `generateDerivativeHook` *before* firing Underlord: a single Haiku 4.5 call grounded in the pillar's `transcripts.full_text` plus up to 12 past hooks from the same `format` (ordered by views desc) writes a one-line hook in the format's style. The hook is persisted on the derivative row (`hook`, `hook_source='derivative-hook-v1'`, `hook_extractor`, `hook_extracted_at`) and substituted into the Skill via `substituteFormatPrompt` (same quote-escaping the clip-idea path uses). Fail-soft: when the pillar has no transcript or Haiku errors, the warning `descript-step item=<id> hook-generation failed: <reason>` is logged and the literal `{{hook}}` passes through to Underlord — better a visible bad-hook than a blocked Descript step. The fix exists because earlier triggers (pre-2026-05-15) shipped clips with the literal text `{{ hook }}` painted on top — see the Angus Cheng incident on item `a641b637-52a1-40c3-8717-eb43c965b4be`. **Why the signal is Skill-section presence, NOT `formats.is_clip_descript_format`:** the `is_clip_descript_format` flag's original (and only) purpose is to mark the clip-idea promotion target for a brand — `loadPromotedClipFormat` is a `LIMIT 1` lookup with no `ORDER BY`, so the flag MUST be exactly-one-per-brand. The original V1.7 gated the Descript step on the same flag, so editors who wanted to fire Descript on a second format ticked the box on that format too, which silently broke clip-idea routing (the lookup started returning whichever row Postgres emitted first). Decoupling makes the two concerns independent: the flag stays clip-idea-routing-only; any format whose Skill has the section heading fires Descript on its derivatives. Picks one of two paths by pillar state:
    - **Warm (`triggered_warm`)** — pillar already has `descriptProjectId`: invoke Descript's `/jobs/agent` against that project with the Skill prompt; stamp `descriptProjectId/Url` on the derivative and clear `descriptCompositionId` + publish state so the UI shows "rendering…" until the resolver fires; insert `repurposeTriggers` (`descriptImportPath="agent"`); enqueue `descript-clip-resolve` which writes the new composition id back and auto-chains `descript-publish-and-archive`.
    - **Cold (`triggered_cold_import`)** — pillar has `mediaS3Key` but no `descriptProjectId`: presigned-URL upload via `createDescriptProjectFromUrl`, stamp the pillar with the new `descriptProjectId / descriptProjectUrl / descriptImportedAt` immediately (so concurrent / subsequent derivatives for the same pillar take the warm path), stamp the derivative with the same project, insert `repurposeTriggers` (`descriptImportPath="agent-cold-import"`) carrying the agent prompt on `descriptPrompt`, and enqueue `descript-clip-resolve` with `importMode=true` + `postImportAgentPrompt`. The resolver's cold-chain branch: when the import stops, stamps the imported composition_id on the pillar as `descriptSeedCompositionId` (warming it for future derivatives' duplicate-via-agent path), invokes Underlord on the now-warm project with the saved prompt, repoints the trigger at the agent job_id, and re-enqueues itself with `importMode=false`. On the next stop, the existing non-import branch writes the derivative's composition_id and chains publish. Tiny race window: two concurrent derivatives on the same cold pillar could each start an import; first writer wins on the pillar stamp, the loser's project becomes a harmless orphan in Descript.
    - **Skip reasons** surface as `descriptStep` on the return (and the manual `/draft` route's response): `skipped_no_skill` (no Descript section in the format Skill), `skipped_no_video_source` (text-only pillar — no Descript project AND no S3 media), `skipped_already_done` (derivative already has a composition AND `force=false`).
    - **Redraft (`force=true`)** re-fires Underlord and replaces the stale composition. **Errors don't fail the draft** — caption still saves; the Descript step's exception is logged with prefix `draft-algorithm v1.6 item=<id> descript_step error:` and dropped.
  - **Overload retry (V1.7):** every `client.messages.create` call inside the agent loop is wrapped with `createMessagesWithOverloadRetry` — one retry after 1.5s when Anthropic returns 529 (`overloaded_error`). Brief Anthropic capacity blips were surfacing as "couldn't redraft" toasts in the UI; one retry covers the common case where the second request lands on a less-loaded shard. Persistent overloads still fail fast (no loop). Manual workaround when 529s persist: `heroku run --app hubandspoke npx tsx scripts/fire-descript-for-item.ts <itemId>` runs the Descript step standalone (bypasses caption regen) for a single derivative.
  - **CTA reply baseline (V1.7, 2026-05-15):** the `cta` field on x / linkedin / youtube_community drafts is now always-on. v1.6 left it empty when the format Skill was silent on CTAs — every editor opening a draft hit an "Add a reply with the CTA..." placeholder. v1.7 routes a `channel` per post type (`CTA_CHANNEL_BY_POST_TYPE` in `run.ts`: `x → "x"`, `linkedin → "linkedin"`, `youtube_community → "ytcommunity"`) and the item's `utmCampaign` into a new `## CTA CONTEXT` block in the per-call payload. The agent's system prompt swaps `CTA RULES` for `CTA BASELINE TEMPLATE` (in `draft-agent.ts`): default shape `"If you want more stuff like this, check out\n\n<link>"`, link defaults to `https://starterstory.com/micro`, UTMs pasted verbatim from CTA CONTEXT. **Skill still wins** — when `FORMAT REFERENCES & EDITORIAL NOTES` specifies an explicit CTA pattern (link template, copy, or shape), the agent follows the Skill instead of the baseline. **Episode lookup:** when this draft has a `cta`, the algorithm registers Anthropic's `web_search_20250305` server tool with `max_uses: 2`; the prompt tells the agent to call it ONLY when the Skill/context implies "link to the actual episode" (vs a lead magnet), so the lookup runs rarely and adds bounded cost when it does. Other post types (instagram_*, tiktok, threads, youtube_long/shorts) have no `cta` field in `PLATFORM_FIELD_SCHEMAS` — the algorithm omits both the CTA context block and the web_search tool for those, and the agent single-shots the v1.6 path.
  - **Smart tracked CTA (v2, 2026-06-06):** the reply CTA is no longer drafted inside the body agent. `run.ts` now passes `cta: undefined` to `generateDraft` and, for x / linkedin / youtube_community / threads, drafts the CTA in a SEPARATE step via the shared `generateTrackedCta` service (`src/lib/services/draft-algorithm/tracked-cta.ts`) — the same service the Regenerate CTA button uses. It (1) reads the freshly-generated post body + format Skill + the lead-magnet catalog (`listLeadMagnets` → StarterStory `GET /api/v1/lead_magnets`); (2) one Opus 4.7 call picks a target **episode-first** (a `find_episode` tool backed by `searchContent` → `GET /api/v1/content` resolves a specific guest's episode) **else the best-fit lead magnet**, and writes a house-style one-liner ending in a colon (few-shot from `cta-exemplars.ts`); (3) mints ONE tracked link per post — reuse-or-create against `findShortLinksByContent` / `createShortLink` / `updateShortLink`, destination = target + UTMs (`buildDestinationUrl`), recording the content association (`content_external_id`=production_items.id, `lead_magnet_id`, `target_type`, `channel`, `utm_campaign`) on the Rails `short_links` table, and persists the slug to `productionItems.shortLinkSlug`; (4) the final cta is `"<one-liner>:\n https://go.starterstory.com/<slug>"`. Failures are caught and logged — the draft still saves with a blank cta the editor can Regenerate. Format Skill still wins (`target_type="custom"`). The old `web_search` episode lookup + the hard-coded `starterstory.com/micro` baseline are gone (replaced by the content API + real lead-magnet selection).
  - **Prompt caching:** `cache_control: { type: "ephemeral" }` markers on the system prompt and the format-stable preamble (target platform + field schema + `formatInstructions` + past captions). Transcript stays uncached because it's per-item. Regenerate within 5 minutes reads the cached prefix.
  - **Cost:** ~$0.03 per Opus call. Caching takes a chunk off the input tokens on Regenerate.
  - **Brand language (2026-08-20):** `run.ts` looks up `brands.language` by slug after loading the item. For `generateDraft`, a second (uncached) system block `"Respond exclusively in Brazilian Portuguese."` is appended when `language === "pt-BR"` — placed after the cached prompt so the cache hit is unaffected. For `runDescriptStepForDerivative` (and transitively `generateDerivativeHook`), the language is threaded through `descript-step.ts` → `derivative-hook.ts`, where it's appended to `SS_SYSTEM_PROMPT` / `NON_SS_SYSTEM_PROMPT` at call time. English brands: no change.

### Underlord usage tracking (added 2026-05-18)

Every `invokeDescriptAgent` call writes a row to `descript_agent_calls` BEFORE hitting Descript's API — so even calls that throw or get killed mid-flight leave a trace. Columns: `caller` (string tag, required), `project_id`, `production_item_id` (nullable), `prompt`, `descript_job_id`, `status` (`started` / `ok` / `failed`), `error_message`, `created_at`, `completed_at`. Indexed on `created_at` and `caller`.

Diagnostic queries:

```sql
-- Who's firing right now?
SELECT caller, count(*) FROM descript_agent_calls
WHERE created_at > now() - interval '30 minutes'
GROUP BY caller ORDER BY count DESC;

-- Anything stuck in "started" longer than a minute? = process crash or hung call
SELECT id, caller, project_id, created_at FROM descript_agent_calls
WHERE status = 'started' AND created_at < now() - interval '1 minute';

-- Recent failures
SELECT caller, error_message, count(*) FROM descript_agent_calls
WHERE status = 'failed' AND created_at > now() - interval '24 hours'
GROUP BY caller, error_message ORDER BY count DESC;
```

**Global rate limit:** `assertUnderlordBudget` runs before every call; refuses with a thrown error when there are ≥10 calls in the last 10 minutes (override via `UNDERLORD_RATE_LIMIT_PER_10MIN`). Sized to cap worst-case burn around $35 — the spike that motivated this instrumentation. Raise it deliberately when you have a legitimate burst workflow.

**Live callers** (all explicit user-action paths):

- `clip-idea-promote-agent` — `POST /api/clip-ideas/[id]/create-in-descript`
- `clip-idea-promote-full-video` — `POST /api/clip-ideas/[id]/create-in-descript-full`
- `clip-idea-promote-precise-layout` — `POST /api/clip-ideas/[id]/create-in-descript-precise?ai=1` (post-import layout-pack phase only)
- `legacy-descript-clip-out` — `POST /api/descript/clip-out`

**Disabled callers** (kept in-tree behind kill switches for easy re-enable):

- `draft-algorithm-descript-step` — gated off by `UNDERLORD_AUTO_FIRE_ENABLED = false` in `src/lib/services/draft-algorithm/descript-step.ts`. Used to fire on every derivative whose format Skill had `### Descript Clip & Pack Info`.
- `descript-derivative-create-*` — no longer enqueued automatically on cross-post creation (disabled 2026-05-18), but re-enabled as a **manual** trigger via `POST /api/production-items/[id]/descript-derivative-create` (2026-09-02). The helper in `src/jobs/tasks/descript-derivative-create.ts` also handles in-queue jobs predating commit `e61a6d9`.
- `descript-clip-resolve-post-import` — the cold-chain post-import agent invoke. Removed from `src/jobs/tasks/descript-clip-resolve.ts`; the cold path now just stamps `descript_seed_composition_id` on the pillar and returns.

Regression guard: `src/lib/services/underlord-auto-fire.regression.test.ts` greps the relevant source files and fails CI if `enqueue("descript-derivative-create", …)` or `invokeDescriptAgent` is reintroduced in any of the disabled call sites.

### `descript-derivative-create` — copy a composition for cross-post / repost (auto-fire DISABLED 2026-05-18; manual trigger re-enabled 2026-09-02)
- **Status:** Auto-fire on cross-post/repost creation was disabled 2026-05-18 (cost ~$3.50/call). **Manual trigger re-enabled 2026-09-02:** `POST /api/production-items/[id]/descript-derivative-create` enqueues this task for a cross-post item when the operator clicks "Create in Descript" in the `DescriptStatusPill` popover. The route validates `sourceType === "cross_post"` and `repostedFromItemId` is set before enqueuing. Cross-post rules (from the format Skill's `### Cross Post Rules` section) are read by the task and passed as `crossPostRules` to `invokeRulesAwareDuplicate`, which tells Underlord to re-aspect (e.g. vertical Instagram Reel → horizontal for X/LinkedIn).
- **Trigger (historical):** enqueued by `POST /api/production-items/[id]/cross-post` and `POST /api/production-items/[id]/repost` after the new derivative row is inserted. Each route hard-gated upfront on `checkRepostReadiness(source)`. **Manual escape (still live on cross-post):** `{ manual: true }` bypasses the readiness gate; the row is created empty for the operator to attach media themselves. Surfaced in `cross-post-triage-dialog.tsx` as the "I'll do it manually" button on the inline gate-failure banner.
- **Files:** `src/jobs/tasks/descript-derivative-create.ts`, `src/lib/services/descript-derivative.ts` (helpers: `hasDescriptableMedia` / `hasDescriptableMediaForRepost`, `resolveImportTarget` / `resolveImportTargetForRepost`, `loadPillarForSource`, `coldImportPillar`)
- **Inputs:** `{ derivativeItemId, sourceItemId, mode?: "repost" | "cross-post", attempt? }` — `mode` defaults to `cross-post` for back-compat with jobs enqueued before the field was added.
- **Outputs:** Inserts a `repurpose_triggers` row tagged `descript_import_path='derivative-copy'`, enqueues `descript-clip-resolve` to poll the duplicate-composition job. The new composition_id is written to the derivative when the resolver fires.
- **Downstream:** `descript-clip-resolve` → `descript-publish-and-archive`
- **Rules:**
  - **Cross-post mode** — pillar-aware. Target = pillar (or source-as-pillar when source has no upstream). Decision tree:
    1. Source has own composition → duplicate it via `invokeRulesAwareDuplicate` (applies Cross Post Rules from the source's format so Underlord re-aspects for the target platform).
    2. Pillar has seed → transcript-anchored cut via `findAnchorInWords` + `cutSegmentWithRules`. Both source and target need word-level Whisper transcripts.
    3. Pillar has only `mediaS3Key` → `coldImportPillar(pillar.id)` + `descript-clip-resolve` for the pillar import + 60s self re-enqueue. Next pass picks up the freshly-stamped seed.
    4. Otherwise → `blocked:needs_pillar_media`.
  - **Repost mode (added 2026-05-16)** — same-platform / same-aspect. Pillar IGNORED even when present; target is always source-as-pillar via `resolveImportTargetForRepost`. Decision tree:
    1. Source has own composition → plain `invokeRulesAwareDuplicate` with `crossPostRules=null` (no re-aspect prompt).
    2. Source has own seed → plain `duplicateDescriptComposition` of the seed. No anchor search (cut range is "full duration"), no transcript required.
    3. Source has only `mediaS3Key` → `coldImportPillar(source.id)` (stamps source's own row) + `descript-clip-resolve` + 60s self re-enqueue. Next pass picks up the seed on the source.
    4. Otherwise → `blocked:needs_pillar_media` (same error code; details say "repost source has no own composition and no archived media").
  - Repost mode never consults `pillarContentItemId` because a Reel's already-cropped pixels ARE the correct material to re-air. The repost route's pre-gate enrichment (`enrichSingleItem(..., { withMedia: true })`) usually backfills `source.mediaS3Key` for video-bearing posts before this task ever runs, so case 3 is the common path for legacy derivatives.
  - Idempotent: returns early if a `repurpose_triggers` row already exists for the derivative with `descript_import_path='derivative-copy'`. Repeated enqueues are no-ops.
  - `coldImportPillar` uses `SELECT … FOR UPDATE` on the import-target row (pillar in cross-post mode, source in repost mode) to serialize parallel cold-imports; the second caller sees `descript_project_id` set and returns `imported:false`.
  - 10 attempts max; throws after that so the failure shows up in `graphile_worker.jobs.last_error` instead of looping forever.

### `descript-clip-resolve` — poll Descript clip-out
- **Trigger:** enqueued by `POST /api/descript/clip-out`; enqueued by `promote-clip-idea` service (agent flow + full-video flow); enqueued by `runDraftAlgorithm`'s V1.7 Descript branch when a derivative is created/redrafted for a format flagged `is_clip_descript_format` and the pillar is already in Descript
- **Files:** `src/jobs/tasks/descript-clip-resolve.ts`
- **Inputs:** `{ triggerId, jobId, derivativeItemId?, pillarItemId?, importMode?, deadlineAt? }`
- **Outputs:** `repurposeTriggers.descriptCompositionId`; if `derivativeItemId`, also `productionItems.descriptCompositionId` on the derivative (pre-checked via `assertCompositionUnique` and protected by a unique partial index on `descript_composition_id`); if `pillarItemId` + `importMode`, also stamps `productionItems.descript_seed_composition_id` on the pillar so future full-video clips skip the upload. **Pillars never own a `descript_composition_id`** — that column is reserved for the derivative that holds the composition. The pillar's `descript_seed_composition_id` points at the same Descript composition (it's the "what should the warm path duplicate from?" pointer) but lives in a different column so the unique constraint holds. Inserts a `tool_action` row into `content_events` (tool=`descript`, action=`clip_created`) so the activity feed surfaces the completion with an "Open in Descript" link.
- **Downstream:** none
- **Rules:**
  - Polls every 5s, 10-min deadline; short-invocation re-enqueue
  - `importMode=true` switches the result parse from `agent_response` (regex) to `created_compositions[0].id` (used by the cold full-video upload path)
  - Hard error on cross-row composition collision: writing a `descript_composition_id` that's already on another `production_items` row throws (service-layer `assertCompositionUnique` + DB unique partial index). Graphile-worker retries with exponential backoff and surfaces the error in `graphile_worker.jobs.last_error` after exhaustion.
  - **Composition ID extraction order (2026-08-13):** `created_compositions[0].id` → last `compositionId="…"` regex match in `agent_response` → null. When null, logs the raw `agent_response` (first 600 chars) for diagnosis. A regex match on a `<target compositionId="…">` tag (Underlord's reference to an *existing* composition) will still trigger `assertCompositionUnique` and the job will exhaust — this is intentional, surfaces real Descript-side failures.
  - **`descript_seed_composition_id` invariant:** this column on a pillar must point to the **full-length source composition** — the one Underlord reads to find the requested time range. The Underlord-edit prompt passes this ID explicitly as `compositionId="<seed>"` in step 1 (since 2026-08-13). If the seed is corrupted (e.g. a prior ambiguous "main composition" Underlord run edited the source down to a short clip), all Underlord-edit and Full-video–no-AI jobs from that pillar will fail. To repair: open the Descript project, find the full-length source composition ID, and run `UPDATE production_items SET descript_seed_composition_id = '<correct-id>' WHERE id = '<pillar-id>';`. If the source composition was permanently edited/destroyed, re-import the pillar's `media_s3_key` via the "Full video – no AI" cold path (clears project-level state and starts fresh).

### `clip-idea-precise-cut` — ffmpeg trim + Descript import + (optional) Underlord layout-pack apply
- **Trigger:** enqueued by `promote-clip-idea` service from two button paths in the clip-triage dialog: "Precise cut — no AI" (`applyLayoutPack=false`) and "Precise cut + Underlord" (`applyLayoutPack=true`). Same task, same payload shape, different terminal behavior.
- **Files:** `src/jobs/tasks/clip-idea-precise-cut.ts`
- **Inputs:** `{ clipIdeaId, triggerId, derivativeItemId, uploadJobId?, layoutJobId?, applyLayoutPack?, deadlineAt? }`
- **Outputs:**
  - Phase 1 (no `uploadJobId`, no `layoutJobId`): download source from S3, ffmpeg-trim to [startSec, endSec], **re-upload the trimmed mp4 to a temp S3 key (`<prefix>/clip-tmp/<clipIdeaId>/<uuid>.mp4`)**, then call `createDescriptProjectFromUrl` with a presigned GET URL so Descript pulls the bytes itself. Save `descriptJobId` + `descriptProjectUrl` to `repurposeTriggers`; save `descriptProjectId` + URL to `productionItems`. (We previously used Descript's signed-PUT path — `createDescriptProjectWithUpload` + PUT bytes — but Descript's importer started rejecting those uploads with a generic "Import failed" 1–2s after PUT, even for synthetic test patterns; verified 2026-05-05. URL-fetch path is what the cold full-video flow already uses and remains stable.)
  - **Hook prepend (2026-06-25):** if `clip_ideas.hook_segments` is non-empty (the editor ticked "Include intro at top" in the triage dialog), phase 1 assembles `[hook ranges…, body]` instead of a single trim. Each entry is a source `[startSec,endSec]` range pulled from elsewhere in the video (typically the opening line). The assembly is one `ffmpeg` pass that opens the source once PER segment with input seeking (`-ss <start> -t <dur> -i src` per range) then `concat`s them — built by `buildConcatFfmpegArgs` in `src/lib/clip-assembly.ts` (pure, unit-tested in `clip-assembly.test.ts`). **Input-seek is load-bearing for perf:** the original single-input `filter_complex trim` decoded the source from 0 up to the LAST segment's end — minutes of wasted decode on the Basic dyno when the body sits deep in a long pillar (observed jobs locked 6+ min). Input-seeking only decodes the seconds kept. Same libx264/AAC/+faststart codecs and clean-PTS property as the single trim, so Descript's importer accepts it identically. Invalid ranges are filtered (`isValidSegment`); empty/absent `hook_segments` is the unchanged single-range path. Descript still re-transcribes the assembled file, so on-screen captions cover the prepended hook for free. **Only the precise-cut paths honor `hook_segments`** — the full-video/agent paths can't prepend a non-contiguous range, so the triage UI disables them when an intro is active. **Layout-pack never re-clips (2026-08-27):** when the layout phase runs (`applyLayoutPack=true` — Precise Cut or the agent-fallthrough; Buffered Cut skips it entirely), it ALWAYS calls `buildLayoutPackPrompt({ preserveAllFootage: true })` — the hard no-trim override — because this task always imports an already-trimmed composition (exact Precise Cut, or intro+body). Without the override the format Skill's "only clip out the section…" instruction makes Underlord re-clip: it would re-trim a Precise Cut below Claude's range or DELETE a prepended intro. With the override Underlord only styles (pack + hook + filler marking) and keeps all footage. (Previously the override was gated on `hook_segments` being present, so plain Precise cuts were re-clipped.)
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
- **Outputs:** HubSpot SMTP email send; `notifications.emailedAt` stamp
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

### `zernio-create-draft` — scheduled TikTok LIVE publish (Zernio)

TikTok-only. Publishes the item's rendered video **live** to the connected
TikTok account via the Zernio API (a pre-audited TikTok Content Posting client
— direct post, `publishNow: true`, no own-app audit). _(Name kept from the
draft-mode original; `createTikTokPost({draft:true})` can re-enable inbox
delivery.)_

- **Trigger:** the **immediate** publish runs inline in `POST /api/production-items/[id]/tiktok-draft` (`mode=send-now`). The **scheduled** publish enqueues `zernio-create-draft` with `runAt` = the operator's go-live time and `jobKey=zernio:<id>` (`jobKeyMode='replace'`, so reschedule never leaves a second job).
- **Files:** `src/jobs/tasks/zernio-create-draft.ts`, `src/lib/services/tiktok-draft/send.ts` (shared sender + guardrails, used by both the route and the task), `src/lib/zernio.ts` (API client).
- **Inputs:** `{ productionItemId, privacyLevel? }` — the task re-validates every guardrail against a fresh DB read at fire time.
- **Outputs:** Zernio post created via `POST https://zernio.com/api/v1/posts` (`publishNow:true` + `tiktokSettings` with the chosen `privacyLevel` + consent flags). Stamps `production_items.zernio_post_id` + `zernio_status` (`published` if the response is already live, else `publishing`) + `zernio_sent_at`. **On a live URL** also sets `published_link` + `status='Published'` + `published_at` — folding into the normal publish pipeline. Inserts a `tool_action` row (`tool=zernio`, `action=published`). The presigned S3 video URL is minted **inside the send**, immediately before the call (never persisted / passed in the payload).
- **Downstream:** `/api/webhooks/zernio` — `post.published` sets `published_link` + `status='Published'` + `zernio_status='published'`; `post.failed` sets `zernio_status='failed'` + error. (Direct publish is async on Zernio's side; the webhook is how a `publishing` item becomes `published` with its live link.)
- **Guardrails (all hard blocks; nothing mutates on block):** postType must be exactly `tiktok`; **exactly one** `production_item_media` row that is a video (the slideshow guard — counts the table, NOT the legacy `media_s3_key` mirror); S3 object exists (`headObject`); non-empty caption; account has `zernio_account_id`; not already published/in-flight (atomic claim `zernio_status='sending'`, excludes sending/publishing/published/delivered); media/caption unchanged since preview. Warn-only: video >287 MB, 24h count ≥25 (TikTok's API cap — Zernio's 429 is the authority).
- **Rules:**
  - Scheduling is held in OUR queue (we call Zernio with `publishNow` at fire time) — never Zernio's `scheduledFor`, so the presigned URL is always fresh.
  - Race-guard: the task bails if `zernio_status` is no longer `scheduled` (cancelled/superseded) or `zernio_post_id` is already set (idempotent).
  - Hard guardrail blocks at fire time are swallowed after stamping `zernio_error` (retry can't help); Zernio API errors re-throw → graphile retries.
  - Privacy levels + TikTok consent are enforced server-side: the publish dialog's GET preview fetches `GET /accounts/{id}/tiktok/creator-info` for allowed `privacyLevel`s; the send sets `contentPreviewConfirmed`/`expressConsentGiven`.
  - Requires `ZERNIO_API_KEY` + `ZERNIO_PROFILE_ID` (and `ZERNIO_WEBHOOK_SECRET` for the webhook). Account connection (`accounts.zernio_account_id`) is set by the in-app OAuth flow at `/api/integrations/zernio/connect` → `/api/integrations/zernio/callback`.

### Finalizing a publish — `reconcileTikTokPublish` (3 funnels, one idempotent fn)

Direct publish is **async** on Zernio's side: the create returns `zernio_status='publishing'` and the live result lands seconds later. Three paths converge on `reconcileTikTokPublish(itemId)` in `src/lib/services/tiktok-draft/send.ts` (idempotent — re-running on a settled item is a noop) to flip `publishing → published` (+ `published_link`/`status='Published'` when TikTok returns a URL) or `→ failed`:

1. **Client poll (primary, no infra needed):** the content page's `TiktokDraftBanner` shows an animated spinner and polls `GET /api/production-items/[id]/tiktok-status` every 3s (cap ~40 tries / 2 min) while `publishing`; the endpoint calls reconcile and returns `{ settled }`. Works locally with no worker, and is what the watching user sees.
2. **Worker poll (closed-tab fallback, prod):** `sendTikTokDraft` enqueues `zernio-poll-publish` (`jobKey=zernio-poll:<id>`) on a `publishing` result; the task reconciles + self-re-enqueues every 10s until settled or a 5-min deadline. Needs the worker dyno (no-op locally).
3. **Webhook (belt-and-suspenders):** `POST /api/webhooks/zernio` `post.published` also sets `published_link`/`status`. Only fires if the Zernio webhook is configured.

**The live link:** TikTok's API almost never returns `platformPostUrl` — but `platformPostId` is `v_pub_url~v2-1.<videoId>`, so `resolveLiveUrl()` constructs the canonical `https://www.tiktok.com/@<handle>/video/<videoId>` from the embedded 19-digit video id + the connected account's handle. So `published_link` is set automatically on every publish, going forward. (For SELF_ONLY/private test posts the URL is valid but only the owner can view it; for Public posts it's the real public link.)

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
    → sendEmailForNotification() via HubSpot SMTP
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

### Media storage — `media_s3_bucket` is canonical, readers must route by it
Uploaded media no longer lives in one bucket. Browser **multipart uploads** of source video/audio (the Upload Recording / draft-dropzone flow → `/api/uploads/multipart/create`) go to **Cloudflare R2** unconditionally — R2 is ~$0.015/GB-mo with **zero egress**, which matters because raw pillars get re-read repeatedly (transcribe → clip → Descript import). Everything else (images, server-side archive of IG/TikTok/YouTube media, ffmpeg-cut clips via `putObjectFromFile`) still goes to **AWS S3**. The upload route stamps `production_items.media_s3_bucket` with whichever bucket the object landed in.

`src/lib/s3.ts` routes a single client per call by bucket name: `clientForBucket(bucket)` returns the R2 client when `bucket === r2BucketName()`, else the AWS S3 client. `getPresignedGetUrl`, `headObject`, and the multipart helpers all take an optional `bucket` arg (default = AWS S3 bucket).

**The invariant:** any task that reads archived media back MUST `select` `media_s3_bucket` alongside `media_s3_key` and pass `{ bucket: row.mediaS3Bucket ?? undefined }` into the presign/head call. Omitting it signs the URL against AWS S3 — a silent 404 at download time for any R2-stored item (transcription, clipping, and Descript cold-import all fail with no upload-side symptom). `?? undefined` keeps legacy S3 rows (null bucket) on the default path unchanged. Readers that obey this: `transcribe-whisper` (`whisper-pipeline.ts`), `clip-idea-precise-cut`, `extract-poster` (→ `poster-extract-pipeline.ts`'s `sourceBucket` param), `coldImportPillar` in `descript-derivative.ts` (live via `promote-clip-idea`), and `descript-step.ts`. **Not yet bucket-aware** (safe today only because `production_item_media` is never written by the R2 path): the TikTok send path (`tiktok-draft/send.ts` reads `production_item_media.s3Key` but never selects `s3Bucket`) — fix it before any R2 object can reach `production_item_media`.

Routing contract is pinned by `src/lib/s3.test.ts`.

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
| HubSpot SMTP | `notification-send`, password reset, invite emails, credit/archiver alerts, daily scorecard | Same token pair as Starter Story (`HUBSPOT_SMTP_USER`/`HUBSPOT_SMTP_PASSWORD`); host smtp.hubapi.com:587 |
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

## Ops-loop escalation → GitHub (2026-08-09)

The health loop (`/lap`, driven by `~/.claude/loop-runner.sh`) runs hourly with fresh
context each lap. It fixes what it is allowed to fix and says nothing about it. Anything
it *can't* or *shouldn't* fix reaches humans as a **GitHub issue** — or, when it can write
the fix but not merge it, a **draft PR with the code in it**.

`scripts/ops-escalate.ts` is the only sanctioned path. Decision rules live in
`src/lib/ops/escalation-policy.ts` (pure, unit-tested in `escalation-policy.test.ts`);
the script owns the `gh` calls and the state file at
`~/.claude/hubandspoke-ops-state.json`.

```bash
npx tsx scripts/ops-escalate.ts status     # open + building + muted (run at lap start)
npx tsx scripts/ops-escalate.ts report --fingerprint <key> --severity warn|crit|attn \
    --title <t> --body-file <evidence.md> [--branch <b>]   # --branch => draft PR
npx tsx scripts/ops-escalate.ts resolve --fingerprint <key> [--note <why>]
```

**Why GitHub rather than a table in our own DB:** open/closed is acknowledgement,
`wontfix` is a permanent mute, and a closed issue is how a human decision survives into a
lap that has no memory of the conversation. The team sees the same queue Pat does.

**Noise controls** (all enforced in the policy module, all unit-tested):

| control | rule |
|---|---|
| streak gate | nothing is raised until it appears in 3 consecutive laps (2 for CRIT); `attn` never escalates |
| silent updates | an already-open finding gets its **body edited** each lap — GitHub does not notify on edits |
| comments | only when severity climbs, or when the loop auto-closes the finding |
| rate limit | at most 2 new artifacts per 90 minutes, regardless of how bad the lap is |
| auto-close | unreported for ~3.5h (≈3 missed laps) → labelled `ops:auto-closed`, then closed with a comment |
| mute | close the issue = quiet 7 days; close it with `wontfix` = never raised again |
| re-raise | a closed artifact carrying `ops:auto-closed` was the loop's own sweep, not a decision — the condition recurring opens a fresh artifact and mutes nothing |

Identity is the **fingerprint**: a stable key for the *condition*, not the moment
(`sync-error:linkedin:company-page-url`). It is written into the artifact body as
`<!-- ops-fingerprint: … -->`, so dedup survives a lost state file or a new machine.

Labels `ops-loop`, `ops:warn`, `ops:crit` are created on demand by the script.

## Error tracking (Sentry)

Both dynos report unhandled errors to Sentry — org `pat-walls`, project
`hubandspoke` (https://pat-walls.sentry.io/issues/?project=hubandspoke).

**Sentry is reserved for CRIT.** The ops loop no longer files a Sentry event per finding
— that practice produced a 22-issue unresolved backlog nobody triaged. Loop findings go
to GitHub (above); Sentry fires only for a CRIT that should page someone.

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

### Worker liveness (2026-05-15)

The worker dyno can silently wedge: the Node process stays alive (Heroku
healthcheck happy) but its connection to Postgres stops polling for jobs,
so backed-up cron work never runs. We hit this 2026-05-15 — `performance-decay`
queued up 5 hourly ticks and one user's `refresh-item-metrics` sat for ~10h
before Pat noticed views weren't syncing.

Detection mechanism:

- **Heartbeat table:** `worker_heartbeat` (singleton row, `id="singleton"`).
- **Cron task:** `worker-heartbeat` runs every minute via `* * * * *` in
  `src/jobs/crontab.ts`; the task body upserts `last_seen_at = NOW()` and
  records the current `DYNO` name. A wedged worker stops firing this, so
  staleness is the signal — by design, the worker can't lie about being
  alive.
- **Public endpoint:** `GET /api/health/worker` reads the row and returns
  503 when `NOW() - last_seen_at > 180s`, otherwise 200 with the age in
  seconds. Unauthenticated (middleware bypass on `/api/health/*`); body
  contains no sensitive data.
- **External monitor:** point UptimeRobot (or equivalent) at
  `https://hubandspoke.starterstory.com/api/health/worker` on a 3–5 min
  cadence with paging on non-200. That's the actual "page Pat" trigger.

Threshold rationale: cron fires every 60s, so 180s tolerates one missed
tick (deploy restart, brief blip) without paging. Anything longer than
~3 min of silence is the wedge.

Fix-on-page: `heroku ps:restart worker --app hubandspoke`. No locked
jobs to interrupt during a wedge (the worker isn't running anything —
that's the whole problem) and all queued tasks are designed idempotent.

---

**User context on web errors:** every authed Sentry event carries
`{ id, email, username }` so the issue page's "Affected users" panel and
filters work. Wired via `setSentrySessionUser(session)` (in
`src/lib/sentry-user.ts`) called from three places that already resolve
the session: `requireSession` / `requireAdmin` in `src/lib/auth-guards.ts`
(every authed API route), and the `await auth()` in
`src/app/(dashboard)/layout.tsx` + `src/app/formats/layout.tsx` (every
authed RSC page render). The matching browser-side stamp comes from a
tiny `<SentryUser />` client component (`src/components/sentry-user.tsx`)
rendered at the top of each authed layout — it runs `Sentry.setUser`
on mount so unhandled browser exceptions land with the same identity.
Each request/page gets its own `@sentry/nextjs` isolation scope so user
identity never leaks across users. Worker tasks don't stamp user context
yet — most cron/sweep work isn't user-attributable.

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
- **`assignees.ts` resolution chain** is consolidated under `resolveEditor()` — source item → format `editorNotionUserId` → brand `defaultEditorUserId` → global fallback. The producer role and its parallel chain were dropped 2026-05-14; every creation site (Notion sync, manual CRUD, derivative routes, threshold-monitor, account-content-sync) goes through this one function.

### Web-dyno boot warmup (2026-08-10)
- `Procfile` web = `bash scripts/boot-web.sh`: starts Next, then fires
  `GET /api/warm` (Bearer `CRON_SECRET`, middleware-exempt like /api/cron)
  once the port answers. The warmer imports the heavy server modules and
  pre-populates the shared 60s report cache (`src/lib/db/queries-cached.ts`)
  for every enabled brand + the credits banners — measured 892ms total.
  Why: the first user after every deploy paid ~2.3s of lazy route-module
  init PLUS cold caches on every dashboard route ("everything feels slow
  right after a deploy" — 2026-08-09). Re-callable any time; safe noop
  without the secret.
