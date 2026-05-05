# Features

The current surface of Hub & Spoke, grouped by area. Each row has a
**Status** so this doubles as a cleanup backlog. Update when adding,
removing, or deprecating anything.

**Status legend**
- **Active** — load-bearing, intentionally kept
- **Legacy** — still functioning, but has a successor; do not extend
- **Deprecated** — replaced; no new callers; safe to delete after one more grep
- **Planned-removal** — known going away; flagged with the migration plan
- **Planned** — not yet built, captured here so it doesn't get forgotten

---

## Content

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Content library / list | Active | `/(dashboard)/[brand]/content`, `GET /api/production-items/search` | `productionItems` | Filter by status / format / account / post-type. Sort-by-Published uses `publishedAt` (timestamp) for same-day tie-breaking, falling back to `publishedDate` midnight when null |
| Item detail (metadata, comments, drafts, transcript) | Active | `/(dashboard)/[brand]/content/[contentId]`, `GET\|PATCH\|DELETE /api/production-items/[id]` | `productionItems`, `contentComments`, `contentDrafts`, `transcripts` | |
| Manual item creation | Active | `POST /api/production-items` | `productionItems` | For platforms API can't pull from. Dialog exposes the CTA UTM (auto-generated via `POST /api/production-items/generate-utm`) so operators can copy it into the published link before saving — caller-supplied `utmCampaign` wins, blank falls back to server generation. Cross-account dedup: if the URL's `platform_content_id` (X rest_id, YT videoId, IG shortcode, …) already lives on another item, returns `409 { error: "DUPLICATE_URL", existingItemId, existingAccountHandle, message }` so the UI can deep-link to the existing item instead of creating a second row that would double-count metrics. PUT enforces the same on URL changes. |
| Add post from link (URL → pre-filled dialog) | Active | "+ Add Post" dropdown on the performance table → `POST /api/production-items/preview-link` | `productionItems`, `accounts` | Paste a social URL; SC API fills title/date/metrics/thumbnail/author; UTM auto-generates on fetch; user reviews then saves |
| Repost (same platform) | Active | `POST /api/production-items/[id]/repost` | `productionItems` (sourceType=`repost`, repostedFromItemId) | See `docs/post-classification.md` for the rules — same platform any account = repost, including @brandA → @brandB on the same platform |
| Cross-post (different platform, manual) | Active | `POST /api/production-items/[id]/cross-post` (per-item submenu on `/content/[id]` → status=`Idea`; queue modal sends `assign:true` + required `editorUserId` → status=`Ready To Publish` + `cross_post_created` activity event linking back to source) | `productionItems` (sourceType=`cross_post`), `contentEvents` (`type='cross_post_created'` on queue-driven creates) | See `docs/post-classification.md` for the platform-based axis vs. repost |
| Cross-post candidate queue (v3.2) | Active | `/(dashboard)/[brand]/queue` Cross-post tab → `GET /api/cross-post-queue`; click a row → `CrossPostTriageDialog` (channel checkboxes + required Assign-to picker) → per-target `POST /api/production-items/[id]/cross-post` with `editorUserId` (lands new rows in `Ready To Publish` with a `cross_post_created` activity entry); "Not interested" → `POST /api/production-items/[id]/cross-post-dismiss` | `productionItems` (Published items from last 21d, sourceType ∈ {`original`, `clip`, `repost`}), `view_snapshots` (per-checkpoint velocity), `contentEvents` (`type='cross_post_dismissed'` for the 30d hide-list; `type='cross_post_created'` on the new row's activity feed) | Hotness = max(lifetime views ÷ format lifetime P60, velocity at each available checkpoint ÷ format same-checkpoint P60). Admit when max ratio ≥ 1.0×; sort desc. Brand-new formats with no cohort auto-admit (`NEW` badge). Per-row `whyHot` explainer shows which signal triggered. Live query — no cron, no populate. |
| Threshold-based auto-repurpose | Active | `threshold-monitor-sweep` cron (every :15) | `productionItems` (sourceType=`repurposed`, pillarContentItemId), `repurposeTriggers`, `formats` (parent→child + viewThreshold) | Replaces the Asana `/api/trigger-repurpose` flow with a pure-DB scan; new items land as `Idea` |
| Create derivative (manual) | Active | Repurpose tab on `/[brand]/content/[id]` → per-target `Create` button → `POST /api/production-items/[id]/repurpose` | `productionItems` (status=`Assigned`, pillarContentItemId, format=target), `repurposeTriggers` | One-click "spawn a derivative draft in this format and take me to it." Replaced the Claude+Descript+Notion dispatcher (2026-05-02). Editor = current user. Dedups on `(pillarContentItemId, lower(format))`: re-clicking returns 409 with the existing id and the UI redirects to it. Writes a `repurposeTriggers` row so the cron's dedup sees manually-created derivatives too. No LLM, no external API — all subsequent work is manual on the new item's detail page. |
| Duplicate item | Active | `POST /api/production-items/[id]/duplicate` | `productionItems` | |
| Comments + activity feed | Active | `GET\|POST /api/production-items/[id]/comments`, `POST /api/production-items/[id]/activity` | `contentComments`, `contentEvents` | |
| Drafts (versioned per-platform copy) | Active | `GET\|POST\|PATCH /api/production-items/[id]/drafts`, `POST .../drafts/generate` | `contentDrafts` | AI gen via Anthropic Opus 4.7 (kept on Anthropic — copywriting nuance is load-bearing); UI auto-persists on blur |
| Clip ideas (LLM-generated short clips) | Active | `POST /api/production-items/[id]/clip-ideas/generate`, `GET .../clip-ideas`, `GET/PATCH /api/clip-ideas/[id]`, `POST /api/clip-ideas/[id]/triage` | `clipIdeas`, `productionItems` (sourceType=`clip`, sourceClipIdeaId) | Generated from transcripts on evergreen pillars. Each clip_idea now spawns a sibling `production_items` row at generation time (status=`Idea`) so it appears in the central Queue Clip tab. Acceptance flips that row to `Assigned` in place; killing flips it to `Killed`. Backfill: `scripts/backfill-clip-idea-production-items.mjs`. |
| Clip → Descript (agent flow) | Active | `POST /api/clip-ideas/[id]/create-in-descript`, `POST /api/descript/clip-out` (now format-detail-only — content-detail uses the simpler `/repurpose` route as of 2026-05-02) | `repurposeTriggers` (descriptImportPath=`agent`) | Agent decides cut points |
| Clip → Descript (precise-cut flow) | Active | `POST /api/clip-ideas/[id]/create-in-descript-precise` | `repurposeTriggers` (descriptImportPath=`precise-cut`) | ffmpeg trims [startSec, endSec] before upload |
| Clip → Descript (full-video flow) | Active | `POST /api/clip-ideas/[id]/create-in-descript-full` | `repurposeTriggers` (descriptImportPath=`full-video`), `productionItems` (pillar's `descriptProjectId` cache) | Hands the editor the full pillar to trim manually. Cold path: uploads pillar to Descript via presigned URL, stamps `descriptProjectId`/`descriptCompositionId` on the **pillar** so it's done once. Warm path: agent-prompt duplicates the existing composition. Both paths use `descript-clip-resolve` (extended for import jobs) to fill in the new compositionId. |
| Search (global) | Active | `GET /api/search` | `productionItems`, `formats`, `users`, `accounts` | Title/format ilike by default. If `q` parses as a known platform URL, matches by extracted `platform_content_id` (indexed) with a loose `published_link` / `youtube_url` ilike fallback for un-backfilled rows. |
| Body fetch (IG caption, X tweet text) | Active | `POST /api/production-items/[id]/instagram-body/fetch`, `.../tweet-body/fetch` | `productionItems.contentBody` | One-click backfill from item detail |
| AI summary (for clip-idea prompt context) | Active | `POST /api/production-items/[id]/summary` | `productionItems` (cached) | |
| Direct media upload (bypass YouTube download) | Active | `POST /api/uploads/s3-presign`, `POST /api/uploads/confirm`, `POST /api/uploads/download` | `productionItems` (mediaS3Key, posterS3Key) | Triggers `transcribe-whisper` on confirm |
| **Old cross-post fit fields on productionItems** | **Deprecated** | (no live writers) | `productionItems.crossPostFitGood`, `crossPostFitReasoning` | Replaced by `cross_post_decisions`; columns kept for back-data only |
| **`crossPostFitVerdicts` cache** | **Planned-removal** | (no live writers after v2 scanner ships) | `cross_post_fit_verdicts` table | Superseded by `cross_post_decisions`; drop in finalize migration |
| **`crossPostRules` table + UI/API** | **Planned-removal** | (no live writers after v2 scanner ships; legacy rows retained during soak) | `cross_post_rules` | Rules replaced by LLM-driven recommender; drop in finalize migration |
| **`cross_post_decisions` table + retrospective page** | **Planned-removal** | `/(dashboard)/[brand]/accounts/cross-posting` is the only reader; v2 scanner deleted 2026-05-02 so no new writers | `cross_post_decisions`, `productionItems.crossPostConfidence` | Drop the table + retrospective page once historical value expires (~1 quarter post-cutover). |
| **v2 cross-post scanner** | **Removed (2026-05-02)** | — | — | `runCrossPostScan`, `cross-post-recommend.ts`, `POST /api/cross-post-scan`, `cross-post-scan` graphile-worker task — all deleted. Replaced by the v3 candidate queue above. |

---

## Accounts

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Account registry (per-brand) | Active | `/(dashboard)/[brand]/accounts`, `GET\|POST /api/accounts`, `GET\|PATCH\|DELETE /api/accounts/[id]` | `accounts`, `brands` | Unique on (platform, lower(handle)) per brand. Table shows a Content column (live count of linked production items). DELETE = soft delete: stamps `accounts.deleted_at` + every linked `production_items.deleted_at` in one tx, also sets `isActive=false`. Server enforces `confirmHandle` echo; UI also forces the user to retype the handle. Restore: `UPDATE accounts SET deleted_at = NULL WHERE id = '…'; UPDATE production_items SET deleted_at = NULL WHERE account_id = '…';` |
| Account refresh (manual) | Active | `POST /api/accounts/[id]/refresh` (sync or `?mode=async`) | `accounts` | Async path enqueues `account-refresh` task |
| Account refresh (weekly auto) | Active | `account-refresh-sweep` cron (Mon 17:00 UTC) | `accounts` | Skips newsletter / `other` (no SC support) |
| Content sync (manual, per account) | Active | "Sync" / "Backfill" buttons on accounts table, `POST /api/accounts/[id]/sync-content?mode=latest\|backfill` | `productionItems`, `accounts.lastContentSyncAt` | Enqueues `account-content-sync`. Backfill only available for platforms that paginate (YouTube / IG / TikTok / LinkedIn). See also the daily `account-content-sync-sweep` cron entry in External Integrations. |
| Cross-post retrospective | Active (read-only) | `/(dashboard)/[brand]/accounts/cross-posting` | `cross_post_decisions`, `contentEvents` | Historical view of v2 LLM proposals + the operator's accept/kill reasons. No new decisions since the v2 scanner was retired 2026-05-02; the page survives until the historical data is dropped. |
| Per-account weekly goals | Active | `/(dashboard)/[brand]/accounts/goals` | `brands.weeklyGoal`, `accounts` | |
| Platform boundaries (limits/constraints UI) | Active | `/(dashboard)/[brand]/accounts/boundaries` | `accounts.metadata`, hardcoded mappings | |
| Per-brand status palette | Active | `/(dashboard)/[brand]/accounts/statuses`, `GET\|POST /api/brand-statuses`, `PATCH\|DELETE /api/brand-statuses/[id]` | `brand_statuses` | Replaces hard-coded `STATUS_COLORS` / `PIPELINE_STATUSES`. Each brand owns its own status names, chip colors (14 Tailwind tokens), order, and `isPipelineColumn` flag. Default seed inserted on `POST /api/brands` and via `scripts/backfill-brand-statuses.mjs` for existing brands. **Protected names** (`Idea`, `Assigned`, `Published`, `Killed`) are seeded with `isProtected=true` and locked from rename/delete in the UI — see `PROTECTED_STATUS_NAMES` in `src/lib/db/brand-statuses.ts` for the call sites that hard-code each. |
| User → account associations | Active | `userAccounts` table; populated via settings | `userAccounts` | Powers "my accounts" filter; not a permission gate |

---

## Formats

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Format hierarchy (pillars + derivatives) | Active | `/(dashboard)/[brand]/formats`, `/(dashboard)/[brand]/formats/[formatId]`, `GET\|POST /api/formats`, `GET\|PATCH\|DELETE /api/formats/[id]` | `formats` (parentFormatId self-ref) | ON DELETE parent SET NULL → orphans become roots |
| Format publishing channels | Active | Format detail UI | `formatChannels` (formatId, accountId, postType) | Replaces `formats.channels` JSONB |
| Format top-performers report | Active | `GET /api/formats/top-performers` | `formats`, `productionItems` | |
| **Old `formats.channels` JSONB** | **Planned-removal** | Column still on the table; no writers, no readers as of 2026-04-25 | `formats.channels` | `legacyChannelString()` and the mirror writes were deleted 2026-04-25; column drop pending the same migration that removes `production_items.platform`. |
| **Legacy `production_items.platform` JSONB** | **Planned-removal** | Column still on the table; remaining readers: `clip-ideas/generate`, `drafts/generate`, `matg` report SQL filter, `sync-errors` page, `my-work` page, format-detail item filter, queue/format search filters | `production_items.platform` | `accountId` + `postType` superseded this; the visible-UI consumers and repost/cross-post inserts were migrated 2026-04-25. Column drop pending migration of the remaining read sites listed at left. |
| **Asana editor/producer fields on formats** | **Deprecated** | (referenced only in legacy trigger-repurpose flow) | `formats.editorAsanaGid`, `producerAsanaGid`, `contentOwnerAsana*` | Replaced by `editorUserId` / `producerUserId` and `editorNotionUserId` / `producerNotionUserId` |
| **Producer field (formats + content)** | **Hidden** | UI removed from formats index, format detail, content detail (2026-04-23). Column still written by `resolveAssignees()` on new items. | `formats.producer`/`producerUserId`, `productionItems.producerUserId` | Visual removal only; data preserved. Re-introduce the field or drop the columns in a later pass. |

---

## Notifications & Collaboration

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Notification inbox | Active | `/(dashboard)/notifications`, `GET /api/notifications`, `POST /api/notifications/mark-read` | `notifications` | |
| Email notifications (assignment, comment, mention) | Active | `notification-send` task, enqueued from comments / clip-idea triage / item create | `notifications` (emailedAt stamp) | Skips self-notifications and uninvited contractors |

---

## My Work / Reports

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| My Work queue | Active | `/(dashboard)/my-work` | `productionItems` (filtered by current user) | |
| Coverage analytics | Active | `/(dashboard)/coverage` | `productionItems` aggregates | Cross-brand metrics |
| **All (cross-brand dashboard)** | Active | `/(dashboard)/all`, `/(dashboard)/all/content`, `/(dashboard)/all/content/[contentId]`, `/(dashboard)/all/production`, `/(dashboard)/all/queue`, `/(dashboard)/all/queue/[source]` | `productionItems` aggregates (no brand filter) | Synthetic "All" entry in the brand sidebar (left of Starter Story) — not a DB row. `brand="all"` is the cross-brand sentinel: `getProductionPipeline`, `getContentReport`, `getWeeklyGoal`, `getBrandSettings`, `buildViewPredictorContext` all drop their brand predicate when called with it. Home renders the same `<ContentReport>` the per-brand homes use, summed across brands; weekly goal is the sum of every enabled brand's goal. Formats / Accounts / cross-post-rules / settings are intentionally absent at /all — they're brand-scoped config. Create-item flow is hidden in the cross-brand view (would corrupt the brand column). |
| Production calendar / timeline | Active | `/(dashboard)/[brand]/production` | `productionItems` | Published items + performance |
| Queue view | Active | `/(dashboard)/[brand]/queue` (tabs: All / Original / Repost / Cross-post / Clip / History) | `productionItems` (status workflow), `clip_ideas` (joined for the Clip tab), `contentEvents` (drives the History tab) | Clip tab opens `ClipTriageDialog` (not the standard `TriageDialog`); Est. Views on clip rows uses the LLM's `clip_ideas.estimated_views` instead of the format-based predictor. **History** is a read-only side tab (`GET /api/queue/history`) showing items that left the `Idea` state in the last 30d — outcome (Killed / Assigned / Published), actor, and any kill reason. **Repost tab** has an admin-only Repopulate button (`POST /api/queue/refill-reposts`) that enqueues the `evergreen-scan` task on demand. |
| Brand home dashboard | Active | `/(dashboard)/[brand]` | `productionItems` aggregates | |
| Daily scorecard email | Active | `/api/admin/scorecard-email/preview` (admin-only HTML preview, `?send=me` to test-send), `daily-scorecard-email` cron at 13:00 UTC, `users.daily_scorecard_email_enabled` checkbox in `/(dashboard)/settings/users` | `productionItems`, `accounts`, `brands`, `users` | Rolling-7-day publish counts to opted-in admins. Email template at `src/lib/email-templates/daily-scorecard.ts`; data via `src/lib/services/scorecard.ts`. |
| Content metrics report | Active | `GET /api/reports/content` | `productionItems` | |
| Production metrics report | Active | `GET /api/reports/production` | `productionItems`, `users` | |
| MATG metrics report | Active | `GET /api/reports/matg` | `productionItems` (brand=`matg`) | |

---

## Settings & Admin

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Users & invites | Active | `/(dashboard)/settings/users`, `GET\|POST /api/users`, `POST\|DELETE /api/invites/[id]`, `POST /api/invites/validate`, `POST /api/invites/accept` | `users`, `invites` | |
| Brands CRUD | Active | `/(dashboard)/settings/brands`, `/(dashboard)/settings/brands/[brand]`, `GET\|POST /api/brands`, `GET\|PATCH\|DELETE /api/brands/[slug]` | `brands` | Defaults (producer/editor, weekly goal) live here |
| Short links admin (ManyChat redirect pool) | Active | `/(dashboard)/settings/links`, `GET\|POST\|PATCH\|DELETE /api/short-links/[slug]` | (none — data lives in the StarterStory Rails app's `short_links` table) | `/settings/links` page is admin-only; the underlying API routes are open to any authenticated user so editors can attach/edit DM keywords on their posts. hubandspoke proxies CRUD to `SHORT_LINKS_API_URL` (the StarterStory REST API at `go.starterstory.com`) with `SHORT_LINKS_API_KEY`. The redirect + click tracking lives in the Rails app; this is a pure control plane. |
| Global accounts settings | Active | `/(dashboard)/settings/accounts` | `accounts` | All brands |
| Brand-scoped settings | Active | `/(dashboard)/[brand]/settings` | `brands`, `accounts` | |
| Sync errors monitor | Active | `/(dashboard)/settings/sync-errors` | `syncLogs` | Notion / YouTube / MATG / performance |
| Job queue monitor | Active | `/(dashboard)/settings/jobs` | `graphile_worker.jobs` | Live status of enrich, transcribe, cross-post-scan, etc. |
| SC usage dashboard | Active | `/(dashboard)/admin/sc-usage` | `scCallLog` | Per-task SC credit spend rolled up by caller, account, platform; recent-call list. One row per task invocation, written by `recordScUsage` from each instrumented caller. |
| **`brand-settings` API + table** | **Planned-removal** | `GET\|POST /api/brand-settings`, `brandSettings` table | `brandSettings` | Data fully migrated to `brands`; drop in next migration |

---

## Auth

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Email/password sign-in | Active | `/(auth)/login`, `POST\|GET /api/auth/[...nextauth]` | `users` (passwordHash) | Auth.js v5 + Credentials + JWT sessions + bcrypt |
| Forgot / reset password | Active | `/(auth)/forgot-password`, `/(auth)/reset-password`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` | `passwordResetTokens` | Postmark email |
| Accept invite | Active | `/(auth)/accept-invite`, `POST /api/invites/accept` | `invites`, `users` | Sets password on accept |

---

## External Integrations

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Notion sync (pull + push-back) | Active | `notion-sync` cron (every :30), `GET /api/cron/notion-sync` (manual) | `productionItems`, `syncLogs` | Only YouTube long-form is Notion-authoritative (`accounts.syncedFromNotion`) |
| Performance metrics sync (SC) | Active | `performance-decay` cron (every :00), `GET /api/cron/performance-sync` | `productionItems` (views/likes/comments + lastPerformanceSyncAt) | Decay-tier gated |
| Per-account content sync | Active | `account-content-sync-sweep` cron (daily 13:00 UTC), "Sync" / "Backfill" buttons on accounts settings, auto-enqueue on `POST /api/accounts` | `productionItems` (upsert by `(account_id, platform_content_id)`), `accounts.lastContentSyncAt`, `syncLogs` | Generalized per-account replacement for the old MATG-only cron. `x` and `threads` only support latest mode; `newsletter`/`other` are skipped. Backfill is 50 pages by default. |
| Enrichment (per-platform) | Active | `enrichment-sweep` cron (every :20), `GET /api/cron/enrichment-sweep` (on-demand backfill with platform/limit/force/itemId) | `productionItems` (many fields) | Dispatches to per-platform enrichers in `src/lib/services/enrichment/` |
| Hook extraction (gpt-4.1-mini, short-form) | Active | `hook-extract-sweep` cron (every :40) | `productionItems.hook`, `hookExtractedAt`, `hookSource='llm'` | Substring-validated to reject hallucinations. Migrated from Anthropic Haiku to OpenAI gpt-4.1-mini 2026-05-02 |
| Hook fallback (long-form / no-LLM) | Active | `hook-fallback-sweep` cron (every :50) | `productionItems.hook`, `hookExtractedAt` | Pure DB; gated on `hookExtractedAt IS NULL` so it can't override LLM/manual |
| Overlay text (on-video burn-in) | Active | `vision-extract-sweep` cron (every :55) → per-item `vision-extract`; dispatcher's vision-with-poster call also writes here when it picks `source='overlay'` | `productionItems.overlay` | Dedicated column for verbatim burn-in text on the cover/video. **Source of truth = OCR on the poster image** (gpt-4.1-mini vision, migrated from Haiku 2026-05-02); title is NOT a reliable proxy. `hookSource='vision'` ⇒ this clip's hook came from a designed overlay. Recovery scripts after the failed title-trust experiment: `scripts/revert-repackage-overlay-backfill.mjs`, `scripts/enqueue-vision-for-repackage.mjs`. |
| Evergreen classification | Active | `evergreen-scan` cron (daily 15:00 UTC) | `productionItems.isEvergreen`, `contentEvents` (suggestions) | Phase A classify, Phase B refill Idea queue |
| YouTube media archive (yt-dlp → S3) | Active | `youtube-download-sweep` cron (every 20 min) → per-item `youtube-download` | `productionItems` (mediaS3Bucket/Key/UploadedAt, mediaSizeBytes, etc.) | Tries 3 player-client strategies; ffmpeg merges video+audio |
| Whisper transcription | Active | Auto-enqueue from `enrich-item` (when it sets `mediaS3Key`), `youtube-download`, `POST /api/uploads/confirm`; manual refetch via `POST /api/production-items/[id]/transcript/fetch` | `transcripts` (segments, **words**, fullText, model=`whisper-1`, audioS3Key) | ffmpeg audio extract → OpenAI Whisper API (`whisper-1`, `verbose_json`, word+segment timestamps). 2-phase short-invocation. Extracted audio archived to S3 for re-runs. Kill switch: `WHISPER_TRANSCRIBE_LIVE=false`. |
| Descript clip resolve (agent flow) | Active | `POST /api/descript/clip-out` → `descript-clip-resolve` task | `repurposeTriggers.descriptCompositionId`, `productionItems` | |
| Descript precise-cut clip | Active | `POST /api/clip-ideas/[id]/create-in-descript-precise` → `clip-idea-precise-cut` task | `repurposeTriggers`, `productionItems` | ffmpeg trim → Descript import → poll |
| **Asana members API** | **Legacy** | `GET /api/asana-members` | — | Format detail / formats list still call this for the legacy picker; migrate to user dropdown |
| **Trigger-repurpose webhook** | **Deprecated** | `POST /api/trigger-repurpose` | `repurposeTriggers` (legacy rows) | Asana flow superseded by `threshold-monitor-sweep` (auto-repurpose) for the cron path and Descript clip-out for the manual path; no current callers |
| **`/api/cron/tick`** | **Active (debug)** | `GET /api/cron/tick?name=<task>` | — | Manual enqueue. Bare hit is a 200 noop. CRON_SECRET-gated. |
| **`/api/cron/notion-sync`, `/performance-sync`** | **Active (manual)** | These routes still run their underlying sync inline | `syncLogs` etc. | Used for manual re-runs; the cron path now lives in `src/jobs/crontab.ts`. (`/api/cron/youtube-sync` and `/api/sync/youtube` were removed when the MATG-only cron was folded into `account-content-sync-sweep`.) |
| Image proxy (CORS / caching) | Active | `GET /api/image-proxy?url=…` | — | Server-side proxy for external images |

---

## Operational

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Sync log audit trail | Active | `syncLogs` table; surfaced in `/(dashboard)/settings/sync-errors` | `syncLogs` | Notion / MATG / YouTube / performance |
| Background job queue | Active | `src/jobs/`, `graphile_worker` Postgres schema | `graphile_worker.*` | See `docs/automation.md` for the full task list |
| Worktree workflow | **Legacy** | `./scripts/worktree-up.sh` | — | Pat now works in main checkout per memory note; script kept for ad-hoc use |
| Local backfill scripts | Active | `scripts/backfill-*.mjs`, `scripts/merge-duplicate-formats.mjs`, `scripts/archive-yt-local.ts` (residential IP for bot-checked YT), `scripts/run-evergreen-scan.ts` | varies | Run via `heroku run` or local `node --env-file=.env.local`. `merge-duplicate-formats.mjs` consolidates `<base> (N)` workaround formats into the canonical row; one-shot, but idempotent — re-runs are no-ops. |
| Bootstrap drizzle migrations on existing DB | Active (one-shot) | `scripts/bootstrap-drizzle-migrations.mjs` | `drizzle.__drizzle_migrations` | Already run on prod 2026-04-19 |
| `scripts/add-*.mjs` / `scripts/create-*-table.mjs` | **Deprecated** | — | — | Pre-2026-04 ALTER TABLE pattern that caused outages. Don't extend. |

---

## IG comment-to-DM (fixed short-link pool)

Both the Meta Graph API direct dispatcher and the earlier `POST /api/manychat/lookup`
shim are gone. Replacement architecture:

- ManyChat automations hard-wire each fixed keyword (e.g. `BOOTSTRAP`) to DM a
  short link like `https://go.starterstory.com/bootstrap`.
- The redirect service lives in the StarterStory Rails app — `ShortLink` +
  `ShortLinkClick` models, `go.starterstory.com/:slug` → `Go::RedirectsController#show`.
- StarterStory exposes a REST API at `/api/v1/short_links` (bearer-token auth via
  `HUBANDSPOKE_API_TOKEN`) so hubandspoke can manage the pool remotely.
- hubandspoke owns `/settings/links` — admin-only UI, proxies CRUD through
  `/api/short-links/...` to the Rails API (API key stays server-side). The
  API routes themselves are open to any authenticated user so editors can
  attach/edit DM keywords on their own posts without needing admin.
- On each `instagram_*` post-detail page, anyone can see an **"Attach DM keyword"**
  row that opens a picker sorted by least-recently-used slug. Picking a slug
  prompts for its destination URL (shared across all posts using that slug),
  then two writes land: `PATCH /api/short-links/:slug` + `PUT /api/production-items`
  setting `productionItems.short_link_slug`.
- `productionItems.short_link_slug` is the only hubandspoke-side state for the
  per-post attachment. No tables, no redirect route, and no click-tracking code
  in hubandspoke — the slug is a pointer to the Rails-side short link.

---

## Cleanup backlog (the "things we want to remove" list)

In rough priority order — each is its own PR:

1. **`brandSettings` table + `/api/brand-settings` route** (Planned-removal). Data already on `brands`. Drop with a drizzle migration.
2. **`/api/trigger-repurpose` + Asana members surface area** (Deprecated). No live callers; remove with format-picker UI swap to user dropdown.
3. **`productionItems.crossPostFitGood` + `crossPostFitReasoning`** (Deprecated). All new reads go through `crossPostFitVerdicts`. Drop columns.
4. **`formats.channels` JSONB + `production_items.platform` JSONB** (Planned-removal). `legacyChannelString()`, `SS_CHANNELS`/`MATG_CHANNELS`, `ChannelChip`, and `platformClass()` were deleted 2026-04-25; visible-UI readers were migrated to `AccountBadge`. Remaining work: migrate `clip-ideas/generate`, `drafts/generate`, the `matg` report SQL filter, `sync-errors` page, `my-work` page, format-detail item filter, and queue/format search filters off `production_items.platform`. Then drop both columns in one migration.
5. **Format Asana columns** (`editorAsanaGid`, `producerAsanaGid`, `contentOwnerAsana*`) (Deprecated). Drop after #2 lands.
6. **Pre-2026-04 `scripts/add-*.mjs` / `create-*-table.mjs`** — historical, but we could prune any that are clearly obsolete.

When you knock one out, update this file: change `Planned-removal` → remove the row, or move the relevant feature row to its successor's notes.
