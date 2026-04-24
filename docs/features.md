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
| Manual item creation | Active | `POST /api/production-items` | `productionItems` | For platforms API can't pull from |
| Add post from link (URL → pre-filled dialog) | Active | "+ Add Post" dropdown on the performance table → `POST /api/production-items/preview-link` | `productionItems`, `accounts` | Paste a social URL; SC API fills title/date/metrics/thumbnail/author; user reviews then saves |
| Repost (same platform) | Active | `POST /api/production-items/[id]/repost` | `productionItems` (sourceType=`repost`, repostedFromItemId) | |
| Cross-post (different platform, manual) | Active | `POST /api/production-items/[id]/cross-post` | `productionItems` (sourceType=`cross_post`) | Manual companion to the auto cross-post-scan |
| Cross-post (auto suggestions) | Active | `cross-post-scan` cron (daily 16:00 UTC) | `crossPostRules`, `crossPostFitVerdicts`, `productionItems` | Suggestions land as `Idea` rows |
| Threshold-based auto-repurpose | Active | `threshold-monitor-sweep` cron (every :15) | `productionItems` (sourceType=`repurposed`, pillarContentItemId), `repurposeTriggers`, `formats` (parent→child + viewThreshold) | Replaces the Asana `/api/trigger-repurpose` flow with a pure-DB scan; new items land as `Idea` |
| Duplicate item | Active | `POST /api/production-items/[id]/duplicate` | `productionItems` | |
| Comments + activity feed | Active | `GET\|POST /api/production-items/[id]/comments`, `POST /api/production-items/[id]/activity` | `contentComments`, `contentEvents` | |
| Drafts (versioned per-platform copy) | Active | `GET\|POST\|PATCH /api/production-items/[id]/drafts`, `POST .../drafts/generate` | `contentDrafts` | AI gen via Anthropic; UI auto-persists on blur |
| Clip ideas (LLM-generated short clips) | Active | `POST /api/production-items/[id]/clip-ideas/generate`, `GET .../clip-ideas`, `PATCH /api/clip-ideas/[id]`, `POST /api/clip-ideas/[id]/triage` | `clipIdeas`, `productionItems` (sourceClipIdeaId) | Generated from transcripts on evergreen pillars |
| Clip → Descript (agent flow) | Active | `POST /api/clip-ideas/[id]/create-in-descript`, `POST /api/descript/clip-out` | `repurposeTriggers` (descriptImportPath=`agent`) | Agent decides cut points |
| Clip → Descript (precise-cut flow) | Active | `POST /api/clip-ideas/[id]/create-in-descript-precise` | `repurposeTriggers` (descriptImportPath=`precise-cut`) | ffmpeg trims [startSec, endSec] before upload |
| Search (global) | Active | `GET /api/search` | `productionItems`, `formats`, `users`, `accounts` | |
| Body fetch (IG caption, X tweet text) | Active | `POST /api/production-items/[id]/instagram-body/fetch`, `.../tweet-body/fetch` | `productionItems.contentBody` | One-click backfill from item detail |
| AI summary (for clip-idea prompt context) | Active | `POST /api/production-items/[id]/summary` | `productionItems` (cached) | |
| Direct media upload (bypass YouTube download) | Active | `POST /api/uploads/s3-presign`, `POST /api/uploads/confirm`, `POST /api/uploads/download` | `productionItems` (mediaS3Key, posterS3Key) | Triggers `descript-transcribe` on confirm |
| **Old cross-post fit fields on productionItems** | **Deprecated** | (no live writers) | `productionItems.crossPostFitGood`, `crossPostFitReasoning` | Replaced by `crossPostFitVerdicts`; columns kept for back-data only |

---

## Accounts

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Account registry (per-brand) | Active | `/(dashboard)/[brand]/accounts`, `GET\|POST /api/accounts`, `GET\|PATCH\|DELETE /api/accounts/[id]` | `accounts`, `brands` | Unique on (platform, lower(handle)) per brand. Table shows a Content column (live count of linked production items). DELETE = soft delete: stamps `accounts.deleted_at` + every linked `production_items.deleted_at` in one tx, also sets `isActive=false`. Server enforces `confirmHandle` echo; UI also forces the user to retype the handle. Restore: `UPDATE accounts SET deleted_at = NULL WHERE id = '…'; UPDATE production_items SET deleted_at = NULL WHERE account_id = '…';` |
| Account refresh (manual) | Active | `POST /api/accounts/[id]/refresh` (sync or `?mode=async`) | `accounts` | Async path enqueues `account-refresh` task |
| Account refresh (weekly auto) | Active | `account-refresh-sweep` cron (Mon 17:00 UTC) | `accounts` | Skips newsletter / `other` (no SC support) |
| Content sync (manual, per account) | Active | "Sync" / "Backfill" buttons on accounts table, `POST /api/accounts/[id]/sync-content?mode=latest\|backfill` | `productionItems`, `accounts.lastContentSyncAt` | Enqueues `account-content-sync`. Backfill only available for platforms that paginate (YouTube / IG / TikTok / LinkedIn). See also the daily `account-content-sync-sweep` cron entry in External Integrations. |
| Cross-posting rules | Active | `/(dashboard)/[brand]/accounts/cross-posting`, `GET\|POST /api/cross-post-rules`, `PATCH\|DELETE /api/cross-post-rules/[id]` | `crossPostRules` | Has new `sourceAccountId`/`targetAccountId` cols (nullable during rollout) |
| Per-account weekly goals | Active | `/(dashboard)/[brand]/accounts/goals` | `brands.weeklyGoal`, `accounts` | |
| Platform boundaries (limits/constraints UI) | Active | `/(dashboard)/[brand]/accounts/boundaries` | `accounts.metadata`, hardcoded mappings | |
| User → account associations | Active | `userAccounts` table; populated via settings | `userAccounts` | Powers "my accounts" filter; not a permission gate |

---

## Formats

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Format hierarchy (pillars + derivatives) | Active | `/(dashboard)/[brand]/formats`, `/(dashboard)/[brand]/formats/[formatId]`, `GET\|POST /api/formats`, `GET\|PATCH\|DELETE /api/formats/[id]` | `formats` (parentFormatId self-ref) | ON DELETE parent SET NULL → orphans become roots |
| Format publishing channels | Active | Format detail UI | `formatChannels` (formatId, accountId, postType) | Replaces `formats.channels` JSONB |
| Format top-performers report | Active | `GET /api/formats/top-performers` | `formats`, `productionItems` | |
| **Old `formats.channels` JSONB** | **Legacy** | Write-only mirror — no live UI reader as of 2026-04-23 | `formats.channels` | `setFormatChannels()` still updates it; safe to drop column once no external consumer remains |
| **`legacyChannelString()` helper** | **Legacy** | `src/lib/format-channels.ts` | — | Hardcoded (brand, platform, handle, postType) → chip-string map; dies with the JSONB |
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
| Production calendar / timeline | Active | `/(dashboard)/[brand]/production` | `productionItems` | Published items + performance |
| Queue view | Active | `/(dashboard)/[brand]/queue` | `productionItems` (status workflow) | |
| Brand home dashboard | Active | `/(dashboard)/[brand]` | `productionItems` aggregates | |
| Content metrics report | Active | `GET /api/reports/content` | `productionItems` | |
| Production metrics report | Active | `GET /api/reports/production` | `productionItems`, `users` | |
| MATG metrics report | Active | `GET /api/reports/matg` | `productionItems` (brand=`matg`) | |

---

## Settings & Admin

| Feature | Status | Entry points | Backing tables | Notes |
|---|---|---|---|---|
| Users & invites | Active | `/(dashboard)/settings/users`, `GET\|POST /api/users`, `POST\|DELETE /api/invites/[id]`, `POST /api/invites/validate`, `POST /api/invites/accept` | `users`, `invites` | |
| Brands CRUD | Active | `/(dashboard)/settings/brands`, `/(dashboard)/settings/brands/[brand]`, `GET\|POST /api/brands`, `GET\|PATCH\|DELETE /api/brands/[slug]` | `brands` | Defaults (producer/editor, weekly goal) live here |
| Short links admin (ManyChat redirect pool) | Active | `/(dashboard)/settings/links`, `GET\|POST\|PATCH\|DELETE /api/short-links/[slug]` | (none — data lives in the StarterStory Rails app's `short_links` table) | Admin-only UI for the ~20-keyword ManyChat pool. hubandspoke proxies CRUD to `SHORT_LINKS_API_URL` (the StarterStory REST API at `go.starterstory.com`) with `SHORT_LINKS_API_KEY`. The redirect + click tracking lives in the Rails app; this is a pure control plane. |
| Global accounts settings | Active | `/(dashboard)/settings/accounts` | `accounts` | All brands |
| Brand-scoped settings | Active | `/(dashboard)/[brand]/settings` | `brands`, `accounts` | |
| Sync errors monitor | Active | `/(dashboard)/settings/sync-errors` | `syncLogs` | Notion / YouTube / MATG / performance |
| Job queue monitor | Active | `/(dashboard)/settings/jobs` | `graphile_worker.jobs` | Live status of enrich, transcribe, cross-post-scan, etc. |
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
| Hook extraction (Haiku, short-form) | Active | `hook-extract-sweep` cron (every :40) | `productionItems.hook`, `hookExtractedAt`, `hookSource='haiku'` | Substring-validated to reject hallucinations |
| Hook fallback (long-form / no-LLM) | Active | `hook-fallback-sweep` cron (every :50) | `productionItems.hook`, `hookExtractedAt` | Pure DB; gated on `hookExtractedAt IS NULL` so it can't override LLM/manual |
| Evergreen classification | Active | `evergreen-scan` cron (daily 15:00 UTC) | `productionItems.isEvergreen`, `contentEvents` (suggestions) | Phase A classify, Phase B refill Idea queue |
| YouTube media archive (yt-dlp → S3) | Active | `youtube-download-sweep` cron (every 20 min) → per-item `youtube-download` | `productionItems` (mediaS3Bucket/Key/UploadedAt, mediaSizeBytes, etc.) | Tries 3 player-client strategies; ffmpeg merges video+audio |
| Descript transcribe | Active | Auto-enqueue from `enrich-item` and `youtube-download`; `POST /api/production-items/[id]/transcript/fetch` | `productionItems.descriptProjectId`, `transcripts` | 4-phase short-invocation with 30-min deadline |
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
| Local backfill scripts | Active | `scripts/backfill-*.mjs`, `scripts/archive-yt-local.ts` (residential IP for bot-checked YT), `scripts/run-evergreen-scan.ts` | varies | Run via `heroku run` or local `node --env-file=.env.local` |
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
  `/api/short-links/...` to the Rails API (API key stays server-side).
- On each `instagram_*` post-detail page, admins see an **"Attach DM keyword"**
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
4. **`formats.channels` JSONB + `legacyChannelString()`** (Legacy). Migrate remaining readers (formats list page, search) to `formatChannels` table, then drop.
5. **Format Asana columns** (`editorAsanaGid`, `producerAsanaGid`, `contentOwnerAsana*`) (Deprecated). Drop after #2 lands.
6. **Pre-2026-04 `scripts/add-*.mjs` / `create-*-table.mjs`** — historical, but we could prune any that are clearly obsolete.

When you knock one out, update this file: change `Planned-removal` → remove the row, or move the relevant feature row to its successor's notes.
