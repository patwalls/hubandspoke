import {
  pgTable,
  uuid,
  text,
  date,
  boolean,
  integer,
  bigint,
  decimal,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const productionItems = pgTable(
  "production_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    notionId: text("notion_id").unique(),
    youtubeId: text("youtube_id").unique(),
    // Platform-native content id (YouTube videoId, X rest_id, IG shortcode,
    // TikTok aweme_id, LinkedIn activity urn, Threads post pk). Populated by
    // the generalized per-account content sync so the same post is never
    // re-inserted when a handle resyncs. URL-based dedup is still used as a
    // fallback for legacy rows where this column has not been backfilled.
    platformContentId: text("platform_content_id"),
    youtubeUrl: text("youtube_url"),
    thumbnail: text("thumbnail"),
    title: text("title"),
    publishedDate: date("published_date"),
    // Precise publish moment for sort tie-breaking within a day. Populated
    // from the platform API when available (SC response timestamps during
    // sync / "Add from link"), or stamped when an item transitions to
    // status = "Published" in-app. Nullable for historic rows; the content
    // view falls back to midnight of `publishedDate` when this is null.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    status: text("status"),
    platform: jsonb("platform").$type<string[]>(),
    format: text("format"),
    brand: text("brand").default("starter-story").notNull(),
    // Account the item was posted to (or is destined for). FK to `accounts`.
    // Replaces the legacy `platform` string-array for identity (which handle /
    // channel this lives on). Nullable during the accounts rollout backfill;
    // NOT NULL after the finalize migration. onDelete: "restrict" mirrors the
    // editor pattern — can't delete an account that still owns items.
    accountId: uuid("account_id").references((): AnyPgColumn => accounts.id, {
      onDelete: "restrict",
    }),
    // Canonical post-type key — one of youtube_long | youtube_shorts |
    // youtube_community | instagram_reel | instagram_post | instagram_story |
    // x | tiktok | linkedin | threads | newsletter. Replaces the implicit
    // post-type-in-platform-string convention. See src/lib/post-types.ts for
    // the source of truth. Nullable for legacy/oddball rows (e.g. "SS Case
    // Study") that don't map to a canonical social post shape.
    postType: text("post_type"),
    campaign: text("campaign"),
    utmCampaign: text("utm_campaign"),
    publishedLink: text("published_link"),
    // Full post body (tweet text, IG caption, YT description). Captured from
    // the upstream API at sync/publish time. For long-form video, the
    // transcript lives in `transcripts` instead — this column is only used
    // for short-form text posts where the body *is* the content.
    contentBody: text("content_body"),
    contentBodyFetchedAt: timestamp("content_body_fetched_at", {
      withTimezone: true,
    }),
    contentBodySource: text("content_body_source"),
    // Permanent URL to the primary media file for this item (e.g. a
    // ScrapeCreators-hosted .mp4 for IG reels, an image for IG photos).
    // Distinct from `thumbnail` — thumbnail may be an ephemeral IG CDN URL
    // that expires; this column is meant to survive.
    contentMediaUrl: text("content_media_url"),
    isExternal: boolean("is_external").default(false).notNull(),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    clicks: integer("clicks"),
    leads: integer("leads"),
    // Subset of `leads` captured via the HubSpot lead form. The rest of
    // `leads` are native Starter Story captures (signups, pricing/checkout
    // intent, opt-ins). leads === hubspotLeads + native, so the UI can split
    // LEADS into HS vs SS columns. Synced from the short-link API alongside
    // `leads` by link-metrics-sync.
    hubspotLeads: integer("hubspot_leads"),
    ctrFirstHour: decimal("ctr_first_hour"),
    apvFirst24Hours: decimal("apv_first_24_hours"),
    // Cross-post scanner confidence (0-100) captured at Idea creation time.
    // Only populated for sourceType='cross_post' rows. The scanner's LLM
    // recommender decides this; the UI surfaces it as a badge. Null for
    // everything else.
    crossPostConfidence: integer("cross_post_confidence"),
    editorEmail: text("editor_email"),
    editorNotionUserId: text("editor_notion_user_id"),
    editorName: text("editor_name"),
    // App-owned assignment FK. Required: every production item has an editor —
    // the single owner across the pipeline (the legacy producer role was
    // removed 2026-05-14). Defaults come from resolveEditor (source → format →
    // brand → global). Notion sync stops touching this on update — edits
    // happen only in-app. Legacy email/name columns remain for historical
    // display on archived items whose people aren't in our users directory.
    // onDelete: "restrict" since NOT NULL would reject anything else — user
    // deletion is blocked while they own items.
    editorUserId: uuid("editor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    viewsEstimated: boolean("views_estimated").default(false),
    lastPerformanceSyncAt: timestamp("last_performance_sync_at", {
      withTimezone: true,
    }),
    lastPerformanceSyncError: text("last_performance_sync_error"),
    descriptProjectId: text("descript_project_id"),
    descriptProjectUrl: text("descript_project_url"),
    descriptCompositionId: text("descript_composition_id"),
    // Only meaningful on pillars (source_type='original'). Points at "the
    // composition future clips should duplicate from" so the warm-clip path
    // doesn't have to claim a composition as the pillar's own. Distinct from
    // descript_composition_id so the unique partial index on that column can
    // hold across pillars+derivatives.
    descriptSeedCompositionId: text("descript_seed_composition_id"),
    descriptImportedAt: timestamp("descript_imported_at", {
      withTimezone: true,
    }),
    // Descript publish-and-archive state (sync OUT direction). Set when we
    // ask Descript to render an MP4 of this composition and download it
    // back to S3. Three derivable states:
    //   idle: both null → nothing in flight, never published
    //   rendering: jobId set, publishedAt null, error null → polling
    //   rendered: publishedAt set → MP4 archived, productionItemMedia row exists
    //   failed: error set → most recent attempt failed; user can retry
    descriptPublishJobId: text("descript_publish_job_id"),
    descriptPublishedAt: timestamp("descript_published_at", {
      withTimezone: true,
    }),
    descriptPublishError: text("descript_publish_error"),
    // Canva "create copy" state. Fires when an instagram_post derivative is
    // created from a format whose Skill contains a canva.com/design link.
    // Three derivable states (same pattern as descriptPublish*):
    //   idle: all null → no Canva link in the format Skill, or repurpose
    //         predates this feature
    //   creating: canvaAutofillJobId set, canvaDesignId null → polling
    //   ready: canvaDesignId + canvaEditUrl set, canvaAutofillJobId null →
    //          unfilled copy exists in our Canva account, editor opens the
    //          edit URL and fills it in
    canvaAutofillJobId: text("canva_autofill_job_id"),
    canvaDesignId: text("canva_design_id"),
    canvaEditUrl: text("canva_edit_url"),
    // Canva design-export state (parallels descript publish-and-archive).
    // After autofill succeeds, we export every page of the design as PNG via
    // /v1/exports and insert one `production_item_media` row per page so the
    // IG-Post carousel simulator on the detail page renders the slides.
    // Derivable states (mirror descript pattern):
    //   idle: both null → nothing exported, never asked to export
    //   exporting: jobId set, exportedAt null, error null → polling
    //   exported: exportedAt set → PNGs archived, media rows present
    //   failed: error set → most recent attempt failed; user can retry
    canvaExportJobId: text("canva_export_job_id"),
    canvaExportedAt: timestamp("canva_exported_at", { withTimezone: true }),
    canvaExportError: text("canva_export_error"),
    // Page-3 video export state. After PNG slides land, we also export
    // the video-bearing page as MP4 so the IG simulator can render a
    // playable <video> at the right carousel index instead of a static
    // image. Same idle / exporting / exported / failed shape as
    // canva_export_*.
    canvaVideoExportJobId: text("canva_video_export_job_id"),
    canvaVideoExportedAt: timestamp("canva_video_exported_at", {
      withTimezone: true,
    }),
    canvaVideoExportError: text("canva_video_export_error"),
    // Typefully draft created automatically when a new X/LinkedIn item is
    // inserted with no publishedLink. The pill in the content-detail header
    // links to typefullyPrivateUrl. Webhook receiver (/api/webhooks/typefully)
    // keeps these columns in sync as the user schedules/publishes inside
    // Typefully. Soft-skipped for accounts without typefullySocialSetId.
    typefullyDraftId: bigint("typefully_draft_id", { mode: "number" }),
    typefullyStatus: text("typefully_status"),
    typefullyShareUrl: text("typefully_share_url"),
    typefullyPrivateUrl: text("typefully_private_url"),
    typefullyScheduledDate: timestamp("typefully_scheduled_date", {
      withTimezone: true,
    }),
    typefullyPublishedAt: timestamp("typefully_published_at", {
      withTimezone: true,
    }),
    typefullyError: text("typefully_error"),
    // Zernio TikTok publish state (sync OUT, TikTok only). Set when we ask
    // Zernio to publish this item's video LIVE to the connected TikTok account
    // (riding Zernio's pre-audited Content Posting client). Once a live URL
    // lands it folds into the normal publish pipeline (publishedLink + status=
    // Published). Derivable states:
    //   idle:       postId + status both null → never sent
    //   sending:    status='sending', postId null → an immediate publish is mid-flight (the claim)
    //   scheduled:  status='scheduled', scheduledAt set, postId null → queued in OUR worker
    //   publishing: postId set, status='publishing' → Zernio accepted it, finishing async (webhook confirms)
    //   published:  postId set, status='published' → live; publishedLink populated
    //   failed:     status='failed', error set → retryable
    // (A legacy 'delivered' value meant inbox-draft mode, kept as a fallback
    //  if the draft path is ever re-enabled via createTikTokPost({draft:true}).)
    zernioPostId: text("zernio_post_id"),
    zernioStatus: text("zernio_status"),
    zernioScheduledAt: timestamp("zernio_scheduled_at", {
      withTimezone: true,
    }),
    zernioSentAt: timestamp("zernio_sent_at", { withTimezone: true }),
    zernioError: text("zernio_error"),
    // ── Legacy single-media columns ──────────────────────────────────────
    // Source-of-truth for media is `production_item_media` (carousel rows).
    // The columns below mirror the row at `index = 0` for cheap reads (queue
    // cards, list views, sync-errors page) — they avoid a JOIN per list view.
    // INVARIANT: every writer that adds/removes a `production_item_media`
    // row must keep these in sync (the upload route, the DELETE route,
    // enrichment writers, repost-seed). Don't write these standalone — they
    // are a derived cache, not an independent storage path.
    // The `scripts/backfill-legacy-media.mjs` one-shot promotes any item
    // that has these set but no carousel rows into a real row.
    // ─────────────────────────────────────────────────────────────────────
    mediaS3Bucket: text("media_s3_bucket"),
    mediaS3Key: text("media_s3_key"),
    mediaS3UploadedAt: timestamp("media_s3_uploaded_at", {
      withTimezone: true,
    }),
    mediaSizeBytes: bigint("media_size_bytes", { mode: "number" }),
    mediaContentType: text("media_content_type"),
    // Durable cover image. Distinct from `thumbnail`, which holds an upstream
    // CDN URL that may expire. Lives in the same bucket as `mediaS3Key`.
    posterS3Key: text("poster_s3_key"),
    // Long-form description (YouTube video description, LinkedIn article body
    // intro). Distinct from `contentBody`, which is the short-form caption /
    // post text — both can coexist on a YT video that has a caption-style
    // title and a long description.
    description: text("description"),
    // Owner/author snapshot at the moment of last enrichment. Author follower
    // counts at publish time are gold for trend analysis later — they drift
    // over time on the platform side.
    authorHandle: text("author_handle"),
    authorDisplayName: text("author_display_name"),
    authorFollowerCount: integer("author_follower_count"),
    authorVerified: boolean("author_verified"),
    // One-shot enrichment state. NULL → eligible for the next enrichment
    // sweep; a timestamp → fully enriched, skip. Per-field gates inside each
    // enricher decide which SC calls to actually make on a partial re-run.
    enrichmentCompletedAt: timestamp("enrichment_completed_at", {
      withTimezone: true,
    }),
    enrichmentAttempts: integer("enrichment_attempts").default(0).notNull(),
    enrichmentError: text("enrichment_error"),
    // YouTube archive state. Independent of `enrichment*` because download is
    // best-effort (Heroku datacenter IPs get rate-limited by YouTube; some
    // videos are age-gated/geo-blocked). Success fills `mediaS3Key` et al;
    // failure bumps attempts + writes the last error. The sweep stops
    // retrying after 5 attempts.
    youtubeDownloadAttempts: integer("youtube_download_attempts")
      .default(0)
      .notNull(),
    youtubeDownloadError: text("youtube_download_error"),
    youtubeDownloadSource: text("youtube_download_source"),
    // Raw Notion page ID of the pillar (captured directly from the "Pillar
    // Content" relation during sync). Kept alongside the resolved FK so we can
    // still reconcile if a pillar is re-synced out of order.
    pillarContentNotionId: text("pillar_content_notion_id"),
    // Resolved self-referencing FK to this table's id. Populated by a single
    // UPDATE at the end of each Notion sync by joining on notion_id. This is
    // what derivative queries hit — indexed for fast lookup.
    pillarContentItemId: uuid("pillar_content_item_id").references(
      (): AnyPgColumn => productionItems.id,
      { onDelete: "set null" }
    ),
    // How this item entered the system. See docs/post-classification.md for
    // the canonical rules; the platform-based axis is: same content + same
    // platform (any account) = "repost", same content + different platform =
    // "cross_post". "repurposed" covers every derivative of a pillar — both
    // threshold-monitor-sweep auto-spawns and items promoted from clip ideas.
    // Distinct from pillarContentItemId (format-derivative tree) so repost
    // rollups and repurpose queries don't collide. Not editable from the UI;
    // set only by system flows + the one-shot consolidation backfill.
    sourceType: text("source_type").notNull().default("original"),
    repostedFromItemId: uuid("reposted_from_item_id").references(
      (): AnyPgColumn => productionItems.id,
      { onDelete: "set null" }
    ),
    // When set, this productionItem was promoted from a clip-idea row.
    // sourceType is always "repurposed" in that case (post-consolidation),
    // and the FK is what UI / API code keys on to render the
    // ClipTriageDialog, run the Descript clip pipeline, and use the LLM
    // estimated_views in production reports. The partial uniq index below
    // guarantees one productionItem per clip idea at the DB level.
    sourceClipIdeaId: uuid("source_clip_idea_id").references(
      (): AnyPgColumn => clipIdeas.id,
      { onDelete: "set null" }
    ),
    // Populated once by the evergreen classifier on an original item. null =
    // not yet evaluated; true/false = AI verdict. Reasoning is copied onto
    // generated repost rows so the triage UI has context without re-fetching.
    isEvergreen: boolean("is_evergreen"),
    evergreenEvaluatedAt: timestamp("evergreen_evaluated_at", {
      withTimezone: true,
    }),
    evergreenReasoning: text("evergreen_reasoning"),
    // Cached verdict from the cross-post-fit classifier. Populated once per
    // original item when the cross-post scanner first considers it (given a
    // non-empty contentBody). null = not yet evaluated; true/false = AI
    // verdict. Bad-fit items are skipped by the scanner on subsequent runs
    // without re-calling the model.
    crossPostFitGood: boolean("cross_post_fit_good"),
    crossPostFitCheckedAt: timestamp("cross_post_fit_checked_at", {
      withTimezone: true,
    }),
    crossPostFitReasoning: text("cross_post_fit_reasoning"),
    // Predicted views at the moment this item transitioned to "Published".
    // Written once on the first published-transition and never overwritten —
    // lets the detail page show actual-vs-predicted after the fact.
    predictedViewsSnapshot: integer("predicted_views_snapshot"),
    predictedViewsSnapshotAt: timestamp("predicted_views_snapshot_at", {
      withTimezone: true,
    }),
    // Verbatim 1–2 sentence opening of the post — the hook that stopped the
    // scroll. Fed back into the clip-idea agent as exemplar data so "this hook
    // + this view count" trains the next batch of suggestions. Three fill
    // paths: copied from clip_ideas.hook on promotion (hookSource='clip_idea'),
    // LLM-extracted from transcript by the hook-extract sweep
    // (hookSource='llm'), or hand-edited (hookSource='manual'). NULL = not yet
    // extracted; short-form only in practice (sweep only considers short-form
    // platforms).
    hook: text("hook"),
    hookSource: text("hook_source"),
    hookExtractor: text("hook_extractor"),
    hookExtractedAt: timestamp("hook_extracted_at", {
      withTimezone: true,
    }),
    // Verbatim burn-in text painted onto the cover/video itself — the bold
    // overlay sentence above the speaker on a Reel/Short/TikTok. Distinct from
    // `hook` (which is the chosen scroll-stopping line, may come from caption
    // /transcript/title) so we can answer "does this clip have a designed
    // overlay?" without parsing format names. For "Reel: Repackage Section
    // w/ Hook" the editor types the overlay into `title`, so we mirror it
    // here on save and stamp `hookSource='overlay'`. The vision sweep also
    // writes here when it OCRs overlay text from a poster image.
    overlay: text("overlay"),
    // One-sentence visual description of the cover image (Haiku vision).
    // Independent signal from the hook — populated even when there's no
    // on-screen overlay text to extract. Useful for search and for feeding
    // visual context to the clip-idea agent.
    coverDescription: text("cover_description"),
    // Stamped once per item when the vision sweep has processed the poster.
    // One-shot: NULL → eligible; timestamp → done (success or no-clear-hook).
    // Also the coverage signal for how much visual data we've captured.
    visionExtractedAt: timestamp("vision_extracted_at", {
      withTimezone: true,
    }),
    // Slug in the StarterStory short-link pool (go.starterstory.com/<slug>) that
    // this post's ManyChat auto-DM sends. NULL = no keyword attached. We don't
    // store the destination URL here — it lives on the StarterStory side and is
    // fetched on demand; a single post reusing a pool slug picks up whatever
    // the slug currently points at.
    shortLinkSlug: text("short_link_slug"),
    // True when this post is a reply rather than a top-level post — used to
    // exclude reply-with-CTA chains (Threads especially) from analytics.
    // Populated by the per-account content sync from the platform's reply
    // markers (Threads: `text_post_app_info.is_reply` /
    // `reply_to_author` / parent-pk fields). Defaults to false; sync skips
    // inserting fresh replies and the cleanup script deletes legacy ones.
    isReply: boolean("is_reply").default(false).notNull(),
    // ── Newsletter (Klaviyo) fields ──────────────────────────────────────
    // Subject lives on `title`, plaintext body on `contentBody`, opens on
    // `views`, sent timestamp on `publishedAt` — same column reuse pattern
    // every other channel uses. The columns below are the bits that don't
    // map onto an existing slot.
    // Preheader / inbox preview text. Maps to the newsletter schema's
    // `preview_text` field. Klaviyo's campaign-message `preview_text`.
    newsletterPreviewText: text("newsletter_preview_text"),
    // Raw HTML of the rendered email. Kept alongside the plaintext in
    // `contentBody` so we can re-extract or re-render later (theme change,
    // better stripper, click-through analysis). Klaviyo's
    // campaign-message `definition.content.body`.
    newsletterBodyHtml: text("newsletter_body_html"),
    // List size at send time — denominator for the open-rate metric.
    // From Klaviyo's `campaign-values-reports` `recipients` statistic.
    newsletterRecipients: integer("newsletter_recipients"),
    // Klaviyo list id this campaign targeted (e.g. "KBDbDN" for the main
    // Starter Story list). Captured per-item for audit even though it
    // mirrors the parent account's `external_id` — campaigns can target
    // segments / multiple lists, and we may want to filter mixed-list
    // accounts later.
    klaviyoListId: text("klaviyo_list_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Soft-delete: stamped by the account-delete endpoint when the parent
    // account is soft-deleted. User-visible list queries filter this column;
    // by-id internal fetches (enrichment, transcription, etc.) don't, so in-
    // flight jobs finish writing to a hidden row harmlessly. Restore by
    // setting back to NULL.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Provenance: which code path created this row. Set at every insert
    // site so SELECTs can audit "where did all these tagged-with-X items
    // come from?" without crawling logs. Standard values: 'api:create',
    // 'api:repost', 'api:cross-post', 'api:repurpose', 'api:duplicate',
    // 'sync:account-content', 'sync:notion', 'sync:klaviyo',
    // 'cron:threshold-monitor-sweep', 'service:clip-promote',
    // 'service:clip-promote-full', 'service:clip-idea-generate',
    // 'legacy:descript-clip-out'. Null on rows created before 2026-05-11.
    // Paired with a content_events row (eventType='item_created') that
    // carries the full {actor_user_id, format, source_type, post_type}
    // payload for the Activity tab.
    createdVia: text("created_via"),
    // ── Scheduled-status reconciliation ──────────────────────────────────
    // Stamped (first transition only) when an item moves to status =
    // "Scheduled" via the publish route's schedule mode. The schedule-
    // reconcile sweep keys off this to (a) find pending Scheduled items and
    // (b) decide when an unmatched item has aged past its give-up window.
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    // Optional operator-entered "I expect this to go live around then" time
    // captured in the Schedule dialog. Used as a strong publish-time
    // proximity signal by the matcher; falls back to `scheduledAt` when null.
    expectedPublishAt: timestamp("expected_publish_at", {
      withTimezone: true,
    }),
    // Set when the reconcile sweep gives up auto-matching a Scheduled item
    // (aged past its per-post-type stale window with no confident match).
    // The item stays Scheduled but is badged "needs attention" so an
    // operator publishes it manually; the matcher skips it from then on.
    scheduleNeedsAttentionAt: timestamp("schedule_needs_attention_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    index("idx_production_items_published_date").on(table.publishedDate),
    index("idx_production_items_published_at").on(table.publishedAt),
    index("idx_production_items_status").on(table.status),
    // Reconcile sweep filters pending Scheduled items by scheduledAt; partial
    // so it only indexes the handful of rows actually awaiting a match.
    index("idx_production_items_scheduled_at")
      .on(table.scheduledAt)
      .where(sql`${table.scheduledAt} IS NOT NULL`),
    index("idx_production_items_brand").on(table.brand),
    index("idx_production_items_account").on(table.accountId),
    index("idx_production_items_post_type").on(table.postType),
    index("idx_production_items_last_perf_sync").on(table.lastPerformanceSyncAt),
    index("idx_production_items_enrichment_pending").on(
      table.enrichmentCompletedAt
    ),
    index("idx_production_items_hook_pending").on(
      table.status,
      table.hookExtractedAt
    ),
    index("idx_production_items_pillar_notion").on(table.pillarContentNotionId),
    index("idx_production_items_pillar_item").on(table.pillarContentItemId),
    index("idx_production_items_reposted_from").on(table.repostedFromItemId),
    index("idx_production_items_editor_user").on(table.editorUserId),
    uniqueIndex("uniq_production_items_utm_campaign")
      .on(table.utmCampaign)
      .where(sql`${table.utmCampaign} IS NOT NULL`),
    uniqueIndex("uniq_production_items_source_clip_idea")
      .on(table.sourceClipIdeaId)
      .where(sql`${table.sourceClipIdeaId} IS NOT NULL`),
    // One Descript composition belongs to one production_item. Pillars hold
    // a `descript_seed_composition_id` instead — that column is the warm-
    // clip path's "duplicate from this" pointer and is exempt from this
    // index. Cold-import-then-warm-clip flows write the same Descript
    // composition id to both columns (different rows): the derivative's
    // `descript_composition_id` and the pillar's `descript_seed_composition_id`.
    uniqueIndex("uniq_production_items_descript_composition")
      .on(table.descriptCompositionId)
      .where(sql`${table.descriptCompositionId} IS NOT NULL`),
    // Dedup key for per-account content sync: a single platform-native id
    // can only exist once per account. Partial so legacy rows without a
    // populated platform_content_id remain valid.
    uniqueIndex("uniq_production_items_account_platform_content_id")
      .on(table.accountId, table.platformContentId)
      .where(sql`${table.platformContentId} IS NOT NULL`),
    // Global cross-account dedup. Same X tweet / IG reel / YT video can only
    // live once across the whole table — every platform's native id is
    // globally unique by construction (X rest_id, YT videoId, IG shortcode),
    // so two rows sharing one is always a duplicate. Carve out soft-deleted
    // rows so account-restore doesn't trip the constraint. We deliberately
    // do NOT mirror this on `published_link` because legitimate placeholder
    // URLs (homepage, "Twitter Post", Klaviyo campaign URLs reused across
    // accounts) appear thousands of times — uniqueness on the URL would
    // block correct usage. The script `scripts/backfill-find-duplicates.mjs`
    // surfaces URL-level collisions for manual review.
    uniqueIndex("uniq_production_items_platform_content_id_global")
      .on(table.platformContentId)
      .where(
        sql`${table.platformContentId} IS NOT NULL AND ${table.deletedAt} IS NULL`
      ),
  ]
);

// Borderline (55–84 confidence) match proposals from the schedule-reconcile
// sweep: "this newly-synced Published post is probably the post that this
// Scheduled item was planning." High-confidence matches (≥85) auto-merge and
// never land here; these wait for a human to Confirm (→ reconcile) or Reject.
// One pending row per (scheduledItem, candidate) — the unique index lets
// re-sweeps upsert the score/reason instead of piling up duplicates.
export const scheduledMatchSuggestions = pgTable(
  "scheduled_match_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The Scheduled planning item awaiting reconciliation.
    scheduledItemId: uuid("scheduled_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    // The synced Published row the matcher thinks corresponds to it.
    candidateItemId: uuid("candidate_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    // 0–100 confidence from the matcher (only 55–84 reach this table).
    score: integer("score").notNull(),
    // Short human-readable rationale from the matcher (LLM + structural).
    reason: text("reason"),
    // pending → confirmed (reconciled) | rejected (left Scheduled).
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("uniq_scheduled_match_suggestion_pair").on(
      table.scheduledItemId,
      table.candidateItemId
    ),
    index("idx_scheduled_match_suggestions_scheduled").on(
      table.scheduledItemId
    ),
    index("idx_scheduled_match_suggestions_status").on(table.status),
  ]
);

// One row per production item. Populated by the `transcribe-whisper` task
// for long-form/audio sources, and by `scrape_creators_*` enrichers for
// short-form social posts (which ship platform-provided captions). The
// `transcribe-whisper` path: ffmpeg extracts audio from the S3 media →
// OpenAI Whisper API returns segment + word timestamps → we persist both.
// `audioS3Key` points at the extracted audio we keep in S3 so we can
// re-run Whisper (or layer on diarization/vision) without re-downloading
// the full video; `audioChunks` is the ordered list when we had to split
// long audio to stay under Whisper's 25 MB per-request cap.
export const transcripts = pgTable("transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  productionItemId: uuid("production_item_id")
    .references(() => productionItems.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  source: text("source").notNull().default("whisper"),
  language: text("language").default("en"),
  // Raw WEBVTT from `scrape_creators_*` enrichers (TikTok, YouTube
  // auto-captions, etc.). Whisper rows leave this null — segments + words
  // are the canonical shape.
  rawVtt: text("raw_vtt"),
  fullText: text("full_text").notNull(),
  segments: jsonb("segments")
    .$type<Array<{ startSec: number; endSec: number; text: string; speaker?: string }>>()
    .notNull(),
  // Word-level timestamps, populated by Whisper's `timestamp_granularities:
  // ["word"]`. Null on `scrape_creators_*` rows that only carry segment-level
  // captions; clip-idea generation gates on `source_type='original' AND
  // post_type='youtube_long'` so those rows never feed V7 anchor matching.
  words: jsonb("words").$type<
    Array<{ word: string; startSec: number; endSec: number }>
  >(),
  wordCount: integer("word_count"),
  durationSec: decimal("duration_sec"),
  // Model identifier, e.g. "whisper-1". Null on `scrape_creators_*` rows.
  model: text("model"),
  // Pointer to the extracted audio in S3 — kept so future re-runs don't
  // need to re-download the full video. Set on Whisper rows
  // (= chunks[0].key); null on `scrape_creators_*` rows.
  audioS3Bucket: text("audio_s3_bucket"),
  audioS3Key: text("audio_s3_key"),
  // Ordered list of audio chunks in S3 — one entry per Whisper call that
  // produced this transcript. Single-element for short audio, multiple
  // entries for long-form content we had to split to stay under OpenAI's
  // 25 MB per-request limit. `startSec` is the offset in the original
  // video so we can shift chunk-local Whisper timestamps back to global
  // time. Null on `scrape_creators_*` rows.
  audioChunks: jsonb("audio_chunks").$type<
    Array<{ key: string; startSec: number }>
  >(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// One row per slide in a carousel / multi-image post. Populated during
// enrichment by the SC scraper — IG posts, Threads carousel_media, Twitter
// extended_entities.media, LinkedIn images, YouTube Community images. The
// legacy single-media columns on `production_items` (mediaS3Key, posterS3Key)
// continue to mirror the index-0 slide so existing UI that renders a single
// cover works unchanged; callers that want the full carousel read this table.
export const productionItemMedia = pgTable(
  "production_item_media",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productionItemId: uuid("production_item_id")
      .notNull()
      .references(() => productionItems.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    kind: text("kind").notNull(),
    s3Bucket: text("s3_bucket").notNull(),
    s3Key: text("s3_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    posterS3Key: text("poster_s3_key"),
    sourceUrl: text("source_url"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("production_item_media_item_idx_uniq").on(
      t.productionItemId,
      t.index
    ),
    index("production_item_media_item_idx").on(t.productionItemId),
  ]
);

// Clip idea candidates generated by the LLM from a pillar's transcript.
// Multiple rows per (sourceProductionItemId, batchId). Generic for now — no
// target format. `status` starts as 'suggested'; killed ideas stay in the
// table for feedback/training.
export const clipIdeas = pgTable(
  "clip_ideas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceProductionItemId: uuid("source_production_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    // The clippable format this idea was generated for (e.g.
    // "Repackage Section w/ Hook", "X Quotables"). Source of truth for
    // the per-format Queue tab filter. Stored as the format name (not
    // FK) to mirror productionItems.format and survive format renames
    // gracefully via existing rename machinery. Nullable so legacy
    // pre-2026-05-21 rows still read; backfilled via
    // scripts/backfill-clip-ideas-target-format.mjs.
    targetFormat: text("target_format"),
    batchId: uuid("batch_id").notNull(),
    startSec: decimal("start_sec").notNull(),
    endSec: decimal("end_sec").notNull(),
    // Optional spoken-footage hook(s) prepended before the main
    // [startSec,endSec] range when the clip is cut. Each entry is a source
    // time range the editor pulled from elsewhere in the video (typically a
    // punchy intro line). The precise-cut worker ffmpeg-trims each entry and
    // concatenates them in order ahead of the body before uploading to
    // Descript, so the final clip plays hook→body as one file. Null/empty =
    // body only (the original single-range behavior). Only honored by the
    // precise-cut paths — the full-video/agent paths can't prepend a
    // non-contiguous range.
    hookSegments: jsonb("hook_segments").$type<
      Array<{ startSec: number; endSec: number }>
    >(),
    hook: text("hook").notNull(),
    angle: text("angle").notNull(),
    rationale: text("rationale").notNull(),
    // V6: the verbatim hook from the brand's REFERENCE LIBRARY whose
    // structural pattern this idea is mirroring. Lets us audit which viral
    // hook each idea descends from. Nullable so older V5 rows still read.
    blueprintAnchorHook: text("blueprint_anchor_hook"),
    // V7: a verbatim line copied from the source transcript that delivers
    // the clip's payoff. The agent must cite this; we then locate it in the
    // word-level transcript and snap startSec/endSec around it. Lets us
    // audit which moment a clip is actually built around. Nullable so older
    // V5/V6 rows still read.
    transcriptAnchorQuote: text("transcript_anchor_quote"),
    transcriptAnchorStartSec: decimal("transcript_anchor_start_sec"),
    // Legacy field from the first cut; unused now that the agent returns
    // estimatedViews. Kept nullable so older rows still read.
    confidence: decimal("confidence"),
    estimatedViews: bigint("estimated_views", { mode: "number" }),
    generatedBy: text("generated_by").notNull(),
    promptVersion: integer("prompt_version").notNull().default(1),
    modelUsage: jsonb("model_usage"),
    // Format-specific output payload. For "X Quotables":
    //   { quotables: ["…", "…", "…"] }
    // For "Repackage Section w/ Hook": null/empty.
    // Shape is declared in the format's `## Clip Idea Generation` skill
    // section, which the agent reads at generation time to build a
    // dynamic tool schema.
    extras: jsonb("extras"),
    // V2 (2026-05-22 / Splice v10): the parent section this clip idea was
    // derived from. With the two-pass pipeline, section detection runs once
    // per pillar (clip_sections) and each format's hook-writer produces N
    // clip_ideas pointing at the same sections. Nullable for legacy v1 rows
    // generated by the single-pass Splice v9 agent. ON DELETE CASCADE so
    // killing a section drops all its format variants automatically.
    clipSectionId: uuid("clip_section_id").references(
      (): AnyPgColumn => clipSections.id,
      { onDelete: "cascade" },
    ),
    // V2: one-sentence audit trail from the hook writer — either why this
    // idea fits the format, or (for the format-skip case persisted by the
    // worker logs) why it didn't. Surfaces in operator UI + Sentry.
    eligibilityReason: text("eligibility_reason"),
    status: text("status").notNull().default("suggested"),
    killReason: text("kill_reason"),
    acceptedNotionPageId: text("accepted_notion_page_id"),
    acceptedNotionPageUrl: text("accepted_notion_page_url"),
    acceptedTargetFormat: text("accepted_target_format"),
    acceptedEditorUserId: uuid("accepted_editor_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    // Set when a clip idea is assigned and gets promoted into a real
    // production_items row (status "Assigned"). The clip idea stays as the
    // triage record; the FK lets the panel deep-link to the created content.
    acceptedProductionItemId: uuid("accepted_production_item_id").references(
      (): AnyPgColumn => productionItems.id,
      { onDelete: "set null" }
    ),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_clip_ideas_source").on(table.sourceProductionItemId),
    index("idx_clip_ideas_batch").on(table.batchId),
    index("idx_clip_ideas_source_target_format").on(
      table.sourceProductionItemId,
      table.targetFormat
    ),
    index("idx_clip_ideas_clip_section_id").on(table.clipSectionId),
  ]
);

/**
 * V2 (Splice v10, 2026-05-22): format-agnostic section detection. The
 * section picker runs once per pillar — Sonnet 4.6 reads the transcript
 * and picks 8-15 "interesting moments," each one a cue-aligned window
 * with a verbatim anchor quote, a one-line topic, a neutral 2-3 sentence
 * summary, and free-form theme tags. Per-format hook writers (Haiku 4.5)
 * then fan out across these sections; each writer decides eligibility
 * for its format and writes a hook variant when appropriate. Replaces
 * the v1 model where each format independently re-read the transcript
 * and picked its own sections (~3x cost on a 3-format brand).
 *
 * Lifecycle:
 *   - A new "batch" is inserted per detection run. Only one non-killed
 *     batch per pillar is live at a time (idempotency in
 *     `detectClipSectionsForPillar`).
 *   - Killing a section cascade-deletes its derived clip_ideas variants.
 *   - Forced re-detection (operator action) marks the prior batch's
 *     sections as killed and inserts a new batch.
 */
export const clipSections = pgTable(
  "clip_sections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pillarId: uuid("pillar_id")
      .references((): AnyPgColumn => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    /** Groups sections from a single detection run. Lets the operator UI
     *  show "this batch of sections" together and bulk-kill them. */
    batchId: uuid("batch_id").notNull(),
    startSec: decimal("start_sec").notNull(),
    endSec: decimal("end_sec").notNull(),
    /** Verbatim ≥8-word quote from the transcript that anchors this
     *  section's payoff. Same shape + matcher as v1's clipIdeas anchor. */
    transcriptAnchorQuote: text("transcript_anchor_quote").notNull(),
    transcriptAnchorStartSec: decimal("transcript_anchor_start_sec"),
    /** One-line summary of what this section is about, e.g.
     *  "Bo's $1.7M business runs on Bubble". Surfaces in operator UI. */
    topic: text("topic").notNull(),
    /** 2-3 neutral sentences describing the section's content. Read by
     *  per-format hook writers to decide eligibility + frame the hook
     *  without needing the full transcript again. */
    summary: text("summary").notNull(),
    /** Free-form classification tags from the section picker, e.g.
     *  ["tech_stack", "revenue_reveal", "tactical_advice"]. Surface for
     *  analytics + search; not used for hook-writer eligibility (auto-
     *  eligibility model means the writer decides based on the section's
     *  full context, not on tags). */
    themeTags: jsonb("theme_tags").$type<string[]>().default([]),
    /** Baseline view estimate the picker calibrated from brand bench
     *  performance. The per-format hook writer can adjust per format. */
    estimatedViews: bigint("estimated_views", { mode: "number" }),
    promptVersion: integer("prompt_version").notNull().default(1),
    /** e.g. "claude-sonnet-4-6:section-v1". Surfaces in algorithm-version
     *  badges on the operator UI alongside the hook writer's version. */
    generatedBy: text("generated_by").notNull(),
    modelUsage: jsonb("model_usage"),
    /** When set, this section + all its derived clip_ideas variants are
     *  hidden from operator UI. Set by force-re-detection (so the prior
     *  batch ages out) or by an explicit operator kill. */
    killedAt: timestamp("killed_at", { withTimezone: true }),
    killedByUserId: uuid("killed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_clip_sections_pillar").on(table.pillarId),
    index("idx_clip_sections_batch").on(table.batchId),
  ]
);

// Schema describing the fields a draft contains. Keyed by *platform* (where
// the post lives) — see `src/lib/platform-field-schemas.ts` for the
// authoritative map. The `prompt` on each field is the AI directive used at
// generation time; a `format.instructions` string is composed alongside as
// editorial-voice context. The top-level `version` lets the schema shape
// evolve without a full backfill — store a snapshot on each draft row.
export type FormatFieldSchema = {
  version: number;
  fields: Array<{
    key: string;
    label: string;
    type: "text" | "longtext" | "tags" | "slides";
    prompt: string;
    maxLength?: number;
    required?: boolean;
  }>;
};

// Platform-specific draft content (caption, description, tweet text, slide
// copy) for a production item. One "current" row per item — edits mutate it
// in place via auto-persist-on-blur. A fresh AI generation or an explicit
// "save version" clones the current row: the new row becomes current, the
// previous row stays as a frozen snapshot. History lives in the same table
// ordered by `version`.
//
// `fieldSchemaSnapshot` captures the format's `fieldSchema` at write time so
// old drafts survive later format edits. `modelUsage` + `promptVersion`
// mirror the `clipIdeas` pattern so we can audit cost + regressions.
export type ContentDraftSlide = {
  id: string;        // stable id — used as feedback key suffix later (Stage 3)
  order: number;
  text: string;
  imageUrl?: string;
};

export type ContentDraftContent = Record<
  string,
  string | string[] | ContentDraftSlide[] | null
>;

export const contentDrafts = pgTable(
  "content_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productionItemId: uuid("production_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    content: jsonb("content").$type<ContentDraftContent>().notNull(),
    fieldSchemaSnapshot: jsonb("field_schema_snapshot")
      .$type<FormatFieldSchema>()
      .notNull(),
    generatedBy: text("generated_by").notNull(), // "ai:<model>:v<n>" | "user"
    promptVersion: integer("prompt_version"),
    modelUsage: jsonb("model_usage"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_content_drafts_item").on(table.productionItemId),
    // Partial unique index — at most one current draft per item. Cleaner than
    // a racy isCurrent boolean + app-level invariant; Postgres enforces it.
    uniqueIndex("uq_content_drafts_current")
      .on(table.productionItemId)
      .where(sql`${table.isCurrent} = true`),
    uniqueIndex("uq_content_drafts_item_version").on(
      table.productionItemId,
      table.version,
    ),
  ],
);

export const formats = pgTable(
  "formats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Display name. Uniqueness scoped to (brand, lower(name)) below — names
    // are free-form across brands, and we rely on the index (not a global
    // UNIQUE) to prevent within-brand duplicates that would confuse
    // `production_items.format` (a text reference, not an FK) lookups.
    name: text("name").notNull(),
    brand: text("brand").default("starter-story").notNull(),
    channels: jsonb("channels").$type<string[]>().default([]),
    event: text("event"),
    viewThreshold: integer("view_threshold"),
    contentOwner: text("content_owner"), // deprecated — use editor
    editor: text("editor"),
    // The format's "Skill" — author-defined natural-language brief that
    // covers what the format is, how to produce it, and (for clip
    // formats) the verbatim Descript Underlord prompt. Folded the old
    // `descript_packs.prompt` content into this column on 2026-05-11
    // so the format has a single source of truth. Supports `{{hook}}`,
    // `{{startTimestamp}}`, `{{endTimestamp}}`, `{{durationSec}}`,
    // `{{compositionId}}` placeholders that get substituted by
    // `substituteFormatPrompt` before being sent to Descript.
    instructions: text("instructions"),
    // Marks this format as a clippable format for its brand: clip-idea
    // generation can target it, and the Descript clip pipeline (four
    // "Create in Descript" flows) is enabled here. **Multiple per brand
    // is allowed** — each clippable format gets its own queue tab and its
    // own clip-idea agent run (with its own hook style, output extras,
    // and platform target). For callers that still need a single "primary"
    // clip format (Descript Create-in default, etc.), use
    // `getPrimaryClippableFormat(brand)` which returns the first by
    // created_at. Replaces the old `is_clip_descript_format` flag
    // (renamed 2026-05-21) and the older PROMOTED_CLIP_FORMAT_BY_BRAND
    // constant.
    isClippableFormat: boolean("is_clippable_format")
      .default(false)
      .notNull(),
    // When a clip idea is generated for this format, the spawned
    // productionItems row inherits these values. Replaces the hardcoded
    // ["Instagram Reel"] / "instagram_reel" defaults in
    // clip-idea-generate.ts. Null means "fall back to the legacy default"
    // (Reels) — set explicitly when a format targets a different surface
    // (e.g. X Quotables → ["X"] / "x").
    clipTargetPlatform: jsonb("clip_target_platform").$type<string[]>(),
    clipTargetPostType: text("clip_target_post_type"),
    // "9:16" or "16:9". Drives the Descript composition layout for clips
    // in this format. Null = derive from post_type (Reel/Shorts/TikTok →
    // 9:16; X / YouTube long → 16:9). Author can override per-format.
    clipAspectRatio: text("clip_aspect_ratio"),
    // Marks this format as a Canva-autofill target. When true AND the Skill
    // contains a canva.com/brand/brand-templates/<id> URL, the repurpose
    // route enqueues canva-create-copy to produce an autofilled design.
    // When false, the Canva path is skipped entirely — even if the Skill
    // happens to include a Canva URL (so editors can paste Canva links as
    // reference material without accidentally triggering the integration).
    // Like isClippableFormat, this can be true on multiple formats per
    // brand (every IG-Post-style format that maps to a Canva template).
    isCanvaFormat: boolean("is_canva_format").default(false).notNull(),
    // When true, new productionItems created in this format default to
    // `sourceType='original'` instead of `'repurposed'`. Pillar/source
    // formats (Business Breakdown, YouTube long-form, etc.) get this
    // ticked; derivative formats leave it off. Replaces the YT-long-form
    // heuristic from the 2026-05-11 consolidation backfill — going
    // forward the source of truth is this format-level flag, looked up
    // by every sourceType-assigning write site via
    // `resolveSourceTypeForFormat(brand, format)` in
    // `src/lib/services/source-type-resolver.ts`.
    labelsAsOriginal: boolean("labels_as_original")
      .default(false)
      .notNull(),
    // NULL parent = root (pillar). ON DELETE SET NULL promotes direct children
    // to roots so we don't silently wipe entire subtrees.
    parentFormatId: uuid("parent_format_id").references(
      (): AnyPgColumn => formats.id,
      { onDelete: "set null" }
    ),
    notionPageId: text("notion_page_id"), // Notion page ID for format relation
    editorNotionUserId: text("editor_notion_user_id"), // Notion user ID for editor/creator
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_formats_parent_format_id").on(table.parentFormatId),
    uniqueIndex("uniq_formats_brand_name_lower").on(
      table.brand,
      sql`lower(${table.name})`
    ),
  ]
);

// Per-format publishing targets in the new account+post_type model. Replaces
// the legacy `formats.channels` jsonb string array which conflated account
// identity (which YouTube channel) with post shape (long vs short vs
// community). One row per (format, account, post_type) target. post_type is
// nullable so "other" production buckets (SS Case Study, Paid Ad) can be
// represented as account-only rows.
export const formatChannels = pgTable(
  "format_channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    formatId: uuid("format_id")
      .notNull()
      .references(() => formats.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    postType: text("post_type"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Dedupe rows. NULLs in unique constraints get treated as distinct in
    // Postgres, so coalesce to '' to enforce one (format, account, no-post-
    // type) row per format. Matches the "Other" account semantics on
    // production_items where post_type is also NULL.
    uniqueIndex("uniq_format_channels_format_account_post_type").on(
      table.formatId,
      table.accountId,
      sql`COALESCE(${table.postType}, '')`
    ),
    index("idx_format_channels_format").on(table.formatId),
    index("idx_format_channels_account").on(table.accountId),
  ]
);

export const repurposeTriggers = pgTable(
  "repurpose_triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productionItemId: uuid("production_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    sourceFormatId: uuid("source_format_id").references(() => formats.id),
    // Nullable because cross-post and repost derivative-copy triggers don't
    // map to a (source_format → target_format) tuple — the source already
    // carries a format and the derivative inherits it. Clip-idea + repurpose
    // sweep flows still populate this.
    targetFormatId: uuid("target_format_id").references(() => formats.id),
    notionTaskPageId: text("notion_task_page_id"),
    viewsAtTrigger: integer("views_at_trigger"),
    descriptCompositionId: text("descript_composition_id"),
    descriptProjectUrl: text("descript_project_url"),
    descriptJobId: text("descript_job_id"),
    descriptPrompt: text("descript_prompt"),
    compositionName: text("composition_name"),
    // Which flow produced this trigger: "agent" hits /jobs/agent with a
    // natural-language prompt in the source project; "precise-cut" trims the
    // source video with ffmpeg and imports a brand-new Descript project via
    // /jobs/import/project_media. Null on legacy rows.
    descriptImportPath: text("descript_import_path"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_repurpose_triggers_item").on(table.productionItemId),
  ]
);

// One row per Descript Underlord agent call. Every `invokeDescriptAgent`
// site MUST write a row here (the function is the only entry point, so
// instrumenting it once covers everything). Underlord costs ~$1.50–$3.50
// per call billed by Descript, so a runaway loop can burn dozens of
// dollars in minutes. Added 2026-05-18 after a $35-in-30-minutes spike
// caused by the cross-post / repost auto-fire we just disabled.
//
// `caller` is a string tag that identifies WHICH code path fired the
// call — required, so the next spike can be triaged in one SQL query.
// The pre-fetch INSERT is what makes that work: even if Descript times
// out and the call throws, we still have a row.
//
// Use cases:
//   - SELECT caller, count(*) FROM descript_agent_calls WHERE created_at > now() - interval '30 minutes' GROUP BY caller ORDER BY count DESC;
//   - WHO is firing right now, and at what rate?
//   - assertUnderlordBudget() reads this table for the in-process rate limit guard.
export const descriptAgentCalls = pgTable(
  "descript_agent_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Tag identifying the code path that fired this call. Required.
     *  Examples: "clip-idea-promote-agent",
     *  "clip-idea-promote-full-video", "legacy-descript-clip-out". */
    caller: text("caller").notNull(),
    projectId: text("project_id").notNull(),
    /** Set when the call ties to a specific derivative. Nullable because
     *  the legacy /api/descript/clip-out path operates on a source item
     *  and doesn't always know the derivative id at call time. */
    productionItemId: uuid("production_item_id").references(
      () => productionItems.id,
      { onDelete: "set null" },
    ),
    prompt: text("prompt").notNull(),
    /** Descript's response job_id. Stamped on success; null if the call
     *  threw before Descript returned. */
    descriptJobId: text("descript_job_id"),
    /** "started" | "ok" | "failed". `started` rows that never flip to
     *  ok/failed indicate the process crashed mid-call. */
    status: text("status").notNull().default("started"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_descript_agent_calls_created_at").on(table.createdAt),
    index("idx_descript_agent_calls_caller").on(table.caller),
  ],
);

// Rules driving the cross-post scanner: "when a published item on
// `sourcePlatform` passes `viewThreshold` views, queue a cross-post idea
// targeting `targetPlatform`." One row per (source → target) pair per brand.
// Formats used to carry this via parent→child rows; that conflated syndication
// with true repurpose. Rules keep the formats tree for real repurpose work.
export const crossPostRules = pgTable(
  "cross_post_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    brand: text("brand").notNull().default("starter-story"),
    sourcePlatform: text("source_platform").notNull(),
    viewThreshold: integer("view_threshold").notNull(),
    targetPlatform: text("target_platform").notNull(),
    // Account-scoped replacements for (brand, source_platform, target_platform).
    // Nullable during the accounts rollout backfill; NOT NULL after the
    // finalize migration drops the string columns.
    sourceAccountId: uuid("source_account_id").references(
      (): AnyPgColumn => accounts.id,
      { onDelete: "cascade" }
    ),
    targetAccountId: uuid("target_account_id").references(
      (): AnyPgColumn => accounts.id,
      { onDelete: "cascade" }
    ),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uniq_cross_post_rules_brand_src_tgt").on(
      table.brand,
      table.sourcePlatform,
      table.targetPlatform
    ),
    index("idx_cross_post_rules_source_account").on(table.sourceAccountId),
    index("idx_cross_post_rules_target_account").on(table.targetAccountId),
  ]
);

// Cached LLM fit verdicts per (source item × target platform). The classifier
// now judges target-aware fit, so a single source can be a good fit for one
// target platform and a bad fit for another. Replaces the source-scoped
// crossPostFit* columns on production_items (which are now unused).
export const crossPostFitVerdicts = pgTable(
  "cross_post_fit_verdicts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => productionItems.id, { onDelete: "cascade" }),
    targetPlatform: text("target_platform").notNull(),
    isGoodFit: boolean("is_good_fit").notNull(),
    reasoning: text("reasoning"),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("uniq_cross_post_fit_verdicts_source_target").on(
      t.sourceItemId,
      t.targetPlatform
    ),
  ]
);

// Point-in-time view counters for published items. Written by the
// fresh-metrics-sync cron every ~15min for items in their first 72h so the
// cross-post scanner can compute velocity (views at ~1h vs account+postType
// baseline). Also the raw material for future views-over-time charts.
// `postAgeMinutes` is computed at insert so we don't have to rejoin
// productionItems.publishedAt for every query.
export const viewSnapshots = pgTable(
  "view_snapshots",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    productionItemId: uuid("production_item_id")
      .notNull()
      .references(() => productionItems.id, { onDelete: "cascade" }),
    views: integer("views").notNull(),
    likes: integer("likes"),
    comments: integer("comments"),
    takenAt: timestamp("taken_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Actual age of the post when the snapshot was taken, in whole
    // minutes. Informational — may differ from the checkpoint's target
    // age by a few minutes (worker dispatch latency, clock skew). The
    // scanner treats `checkpoint_key` as the authoritative "which
    // checkpoint is this" and uses `post_age_minutes` only for
    // debugging / sparkline X-axis. CHECK constraint rejects negatives.
    postAgeMinutes: integer("post_age_minutes").notNull(),
    // Stable checkpoint tag — one of the `VELOCITY_CHECKPOINTS` keys in
    // `src/lib/velocity-checkpoints.ts` ("15m" | "30m" | "1h" | "2h" |
    // "4h"). Enforced at the DB level via a CHECK constraint so no
    // future writer can sneak in an arbitrary string. Unique per
    // (item, checkpoint) — retries / rediscovery can't produce
    // duplicates.
    checkpointKey: text("checkpoint_key").notNull(),
  },
  (t) => [
    index("idx_view_snapshots_item_taken").on(t.productionItemId, t.takenAt),
    index("idx_view_snapshots_item_age").on(t.productionItemId, t.postAgeMinutes),
    uniqueIndex("uniq_view_snapshots_item_checkpoint").on(
      t.productionItemId,
      t.checkpointKey
    ),
    check(
      "view_snapshots_checkpoint_key_valid",
      sql`${t.checkpointKey} IN ('15m', '30m', '1h', '2h', '4h', '8h', '24h', '48h')`
    ),
    check(
      "view_snapshots_post_age_nonneg",
      sql`${t.postAgeMinutes} >= 0`
    ),
    check("view_snapshots_views_nonneg", sql`${t.views} >= 0`),
  ]
);

// Per-proposal log from the cross-post scanner. One row per target the LLM
// proposed for a given source item, whether or not it became an Idea. Rows
// with `ideaItemId` set correspond to Ideas actually created; null means the
// proposal was logged but filtered out by the confidence floor or per-brand
// queue cap. Supersedes `crossPostFitVerdicts` once the finalize migration
// drops that table.
export const crossPostDecisions = pgTable(
  "cross_post_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => productionItems.id, { onDelete: "cascade" }),
    targetAccountId: uuid("target_account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    targetPostType: text("target_post_type").notNull(),
    confidence: integer("confidence").notNull(),
    reasoning: text("reasoning"),
    proposedAt: timestamp("proposed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Populated when the proposal cleared both the confidence floor and
    // queue cap, and an Idea row was inserted for it. Null while the
    // proposal was logged-only, or cleared once the Idea gets hard-deleted.
    ideaItemId: uuid("idea_item_id").references(
      (): AnyPgColumn => productionItems.id,
      { onDelete: "set null" }
    ),
    // 'accepted' | 'killed' | 'stale'. Null until the operator or the stale
    // sweep takes action. Written by the outcome route when the operator
    // accepts/kills the Idea.
    outcome: text("outcome"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    outcomeReason: text("outcome_reason"),
  },
  (t) => [
    index("idx_cross_post_decisions_source").on(t.sourceItemId),
    index("idx_cross_post_decisions_target").on(t.targetAccountId),
    index("idx_cross_post_decisions_idea").on(t.ideaItemId),
    index("idx_cross_post_decisions_proposed").on(t.proposedAt),
  ]
);

export const brandSettings = pgTable("brand_settings", {
  brand: text("brand").primaryKey(),
  weeklyGoal: integer("weekly_goal"),
  // 0 = Sunday .. 6 = Saturday. Controls dashboard week buckets.
  weekStartDay: integer("week_start_day").notNull().default(0),
  // Per-brand fallback used by resolveEditor when a new item can't inherit
  // from a source item or its format. NULL → fall through to the global
  // fallback (pat).
  defaultEditorUserId: uuid("default_editor_user_id").references(
    () => users.id,
    { onDelete: "set null" }
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    role: text("role", { enum: ["admin", "creator"] })
      .notNull()
      .default("creator"),
    // Opt-in flag for the daily scorecard email. Default false so adding new
    // users doesn't accidentally email them; flip via a settings UI (or
    // direct SQL for now). Cron filters on this column directly — it is the
    // source of truth for "who gets the daily scorecard," not `role='admin'`.
    dailyScorecardEmailEnabled: boolean("daily_scorecard_email_enabled")
      .notNull()
      .default(false),
    invitedBy: uuid("invited_by").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
    }),
    // Notion-side identity. Populated during sync so we can resolve Notion
    // comment authors + assignments back to our user rows even when the email
    // isn't exposed to integrations (Notion redacts it for some accounts).
    notionUserId: text("notion_user_id").unique(),
    // Brand UUIDs this user is associated with — purely informational, does
    // not gate access. Edited in Settings → Users.
    brandIds: jsonb("brand_ids").$type<string[]>().notNull().default([]),
    // Content workflow role — purely informational, no access gating.
    contentRole: text("content_role", {
      enum: ["producer", "curator", "member"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("idx_users_email_lower").on(sql`lower(${table.email})`)]
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "creator"] })
      .notNull()
      .default("creator"),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Channels + content role pre-assigned at invite time — copied to users on accept.
    brandIds: jsonb("brand_ids").$type<string[]>().notNull().default([]),
    contentRole: text("content_role", {
      enum: ["producer", "curator", "member"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_invites_email_lower").on(sql`lower(${table.email})`),
    index("idx_invites_status").on(
      table.acceptedAt,
      table.revokedAt,
      table.expiresAt
    ),
  ]
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_password_reset_tokens_user").on(table.userId)]
);

export const contentComments = pgTable(
  "content_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentItemId: uuid("content_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    notionCommentId: text("notion_comment_id").unique(),
    // Notion rarely exposes the commenter's email to integrations, so a
    // notion-sourced comment usually can't be linked to a local user.
    // These columns preserve the display name/avatar from Notion so the
    // UI has something better than "Deleted user" to render.
    authorName: text("author_name"),
    authorAvatarUrl: text("author_avatar_url"),
  },
  (table) => [
    index("idx_content_comments_item_created").on(
      table.contentItemId,
      table.createdAt,
    ),
  ],
);

// Activity feed events alongside content_comments. One generic table holds every
// non-comment event type (status change today, field changes / lifecycle events
// tomorrow). Type + jsonb payload keeps future additions to inserts + a new
// payload shape + a new renderer branch — no schema migration per event.
export type ContentEventPayload =
  | { type: "status_change"; from: string | null; to: string | null }
  | { type: "killed"; from: string | null; reason: string | null }
  | { type: "accepted"; from: string | null; reason: string | null }
  | { type: "editor_change"; from: string | null; to: string | null }
  | { type: "cross_post_dismissed"; reason: string | null }
  | {
      type: "cross_post_created";
      sourceItemId: string;
      sourceTitle: string | null;
      targetAccountHandle: string | null;
      targetPostType: string | null;
    }
  | { type: "repost_dismissed"; reason: string | null }
  | {
      type: "repost_created";
      sourceItemId: string;
      sourceTitle: string | null;
    }
  // SPOKE "Repurposed" queue dismissal. Scoped to a (pillar, format) PAIR —
  // the row's content_item_id is the pillar, `formatId` narrows it to the one
  // target format the operator rejected. `reason` distinguishes "Not
  // interested" (null) from "Kill this idea" (a written reason). 30-day hide,
  // mirroring repost_dismissed.
  | { type: "spoke_dismissed"; formatId: string; reason: string | null }
  // Generic tool-integration events. Single envelope so adding a tool is
  // (1) emit with a new `tool` string, (2) register the icon/label in
  // content-activity.tsx's TOOL_REGISTRY. No new variant per tool, no
  // new renderer branch, no migration. `label` is pre-rendered by the
  // emitter so the renderer stays trivial.
  | {
      type: "tool_action";
      tool: string; // "descript" | "typefully" | …
      action: string; // "clip_created" | "draft_created" | …
      status: "success" | "error" | "info";
      label: string;
      url: string | null;
      meta?: Record<string, string | number | null>;
    }
  // Provenance for new production_items. Written from every insert site
  // (api:create, api:repost, sync:account-content, cron:threshold-monitor-
  // sweep, …). Pairs with productionItems.createdVia (which stores the
  // same `source` string for fast SELECT-WHERE audits). Rendered as the
  // first row of the Activity tab so editors can see where a tagged item
  // came from. See `recordItemCreated` in `src/lib/services/item-created.ts`.
  | {
      type: "item_created";
      source: string; // e.g. "api:create", "sync:account-content"
      format: string | null;
      sourceType: string; // "original" | "repost" | "cross_post" | "repurposed" | "source_recording"
      postType: string | null;
    }
  // Versioning / audit-trail variant. Emitted whenever a tracked field on
  // a production_item, a content_drafts.content key, or a
  // production_item_media row changes. Source identifies the writer kind
  // so the activity feed can render "Pat changed Hook" vs
  // "Draft Algorithm rewrote the caption" vs "Slice Algorithm trimmed
  // this clip". User edits go on `content_events.user_id` (the existing
  // column); algorithm / tool / sync / import writes leave it null and
  // get a registry-driven badge instead of an avatar. See
  // `src/lib/services/content-revisions.ts` for the single helper that
  // emits these.
  | {
      type: "content_changed";
      source: ContentChangeSource;
      target: ContentChangeTarget;
      /** Before-value. Omitted for media variants (target carries enough
       *  info). String values are truncated at 2000 chars + `truncated`
       *  flag set; full prior content is recoverable from `content_drafts`
       *  version rows for draft_field changes. */
      from?: string | number | boolean | null;
      to?: string | number | boolean | null;
      truncated?: boolean;
    };

/**
 * Who/what wrote a `content_changed` event. Adding a new algorithm = add
 * a literal to `name` here + a row in `ALGORITHM_REGISTRY` in
 * `src/lib/content-event-algorithms.ts`. Tools mirror the existing
 * `TOOL_REGISTRY` keys in `content-activity.tsx`.
 */
export type ContentChangeSource =
  | { kind: "user" }
  | {
      kind: "algorithm";
      name:
        | "draft-algorithm"
        | "slice-algorithm"
        | "hook-extractor"
        | "vision-extractor"
        | "threshold-monitor"
        | "clip-idea-generator"
        | "evergreen-classifier"
        | "cross-post-classifier"
        | "enrichment";
    }
  | { kind: "tool"; tool: "descript" | "canva" | "typefully" }
  | { kind: "sync"; system: "notion" | "account-content" | "metrics" }
  | { kind: "import" }
  | { kind: "api" };

/**
 * What changed. Discriminated by `kind`. Field-level targets carry the
 * field name; media targets snapshot enough metadata to render a
 * thumbnail in the activity feed even after the underlying row is gone.
 */
export type ContentChangeTarget =
  | { kind: "production_item_field"; field: string }
  | {
      kind: "draft_field";
      draftId: string;
      version: number;
      field: string;
    }
  | {
      kind: "media_added" | "media_removed";
      mediaId: string;
      index: number;
      mediaKind: "image" | "video";
      s3Key: string | null;
      posterS3Key: string | null;
    }
  | {
      kind: "media_reordered";
      mediaId: string;
      fromIndex: number;
      toIndex: number;
    };

export const contentEvents = pgTable(
  "content_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentItemId: uuid("content_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<ContentEventPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_content_events_item_created").on(
      table.contentItemId,
      table.createdAt,
    ),
  ],
);

// Per-recipient inbox of collaboration events. One row per (event, recipient)
// so unread counts are an indexed partial scan and each user marks their copy
// independently. Polymorphic via `kind` + `payload`; today we emit 'assigned'
// and 'comment'. `emailed_at` is stamped fire-and-forget after we ship the
// email so we don't double-send if a row gets requeued.
export type NotificationPayload =
  | { kind: "assigned"; title: string | null }
  | {
      kind: "comment";
      title: string | null;
      excerpt: string;
      authorName: string | null;
    }
  | {
      kind: "mention";
      title: string | null;
      excerpt: string;
      authorName: string | null;
    };

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").notNull(),
    contentItemId: uuid("content_item_id").references(
      () => productionItems.id,
      { onDelete: "cascade" },
    ),
    commentId: uuid("comment_id").references(() => contentComments.id, {
      onDelete: "set null",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    payload: jsonb("payload").$type<NotificationPayload>().notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_notifications_user_created").on(
      table.userId,
      table.createdAt,
    ),
    index("idx_notifications_user_unread")
      .on(table.userId)
      .where(sql`${table.readAt} IS NULL`),
  ],
);

// First-class brand registry. Seeded from the old `src/lib/config/brands.ts`
// constants during the accounts rollout; from there on, brands are added/edited
// via the settings UI. Folds the old `brand_settings` row (1:1 by slug) into
// the same table — weekly goal + week start day + default editor all
// live here. The `brand_settings` table is dropped in the finalize migration.
export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    label: text("label").notNull(),
    avatarUrl: text("avatar_url"),
    // Tailwind gradient (e.g. "from-emerald-500 to-emerald-700") preserved from
    // the old config. Kept as plain text so a new brand can set any gradient
    // without a code change.
    color: text("color"),
    disabled: boolean("disabled").notNull().default(false),
    weeklyGoal: integer("weekly_goal"),
    weeklyViewsGoal: integer("weekly_views_goal"),
    // 0 = Sunday .. 6 = Saturday. Controls dashboard week buckets.
    weekStartDay: integer("week_start_day").notNull().default(0),
    defaultEditorUserId: uuid("default_editor_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    watermarkS3Key: text("watermark_s3_key"),
    brandGuidelines: text("brand_guidelines"),
    // Controls the order brands appear in the top nav and settings table.
    // Lower values appear first. Editable via drag-and-drop in settings.
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("idx_brands_slug_lower").on(sql`lower(${table.slug})`)]
);

export const brandWatermarks = pgTable(
  "brand_watermarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    s3Key: text("s3_key").notNull(),
    fileName: text("file_name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_brand_watermarks_brand_id").on(table.brandId)]
);

// Per-brand status palette. Replaces the old hard-coded STATUS_COLORS map and
// PIPELINE_STATUSES list — each brand now owns its own statuses, ordering, and
// chip colors. Four names are seeded with isProtected = true on every brand
// because the app hard-codes them elsewhere: Idea + Assigned are the target
// status of the auto-creation flows (repost / cross-post / clip-out /
// triage-accept / threshold-monitor), Published is referenced by the
// publish-date filters in queries.ts, and Killed is referenced by the
// kill-confirmation modal in content-detail.tsx. See
// PROTECTED_STATUS_NAMES in src/lib/db/brand-statuses.ts.
export const brandStatuses = pgTable(
  "brand_statuses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Color *token* (e.g. "yellow", "pink", "emerald"). Resolved to Tailwind
    // bg-/text-/border- classes at render time via STATUS_COLOR_TOKENS in
    // src/lib/badge-colors.ts.
    color: text("color").notNull(),
    position: integer("position").notNull().default(0),
    // When true, this status renders as a kanban column on /[brand]/production
    // and is counted as "in-flight" by queries.ts.
    isPipelineColumn: boolean("is_pipeline_column").notNull().default(false),
    // Locked from rename/delete in the settings UI. Set on the seeded
    // "Published" / "Killed" rows.
    isProtected: boolean("is_protected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_brand_statuses_brand_name_lower").on(
      table.brandId,
      sql`lower(${table.name})`
    ),
    index("idx_brand_statuses_brand_position").on(table.brandId, table.position),
  ]
);

// Social account / channel identity. One row per (platform, handle) — e.g. the
// Starter Story YouTube channel is one row regardless of whether an item is a
// long video, a short, or a community post (post type lives on production_items
// instead). "X (Starter Story)" and "X (Pat Walls)" are two rows; same handle
// on different platforms is two rows. Scrape Creators account-level data
// (follower count, avatar, bio) is refreshed into these rows by the
// account-refresh task.
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "restrict" }),
    // Canonical platform key: youtube | instagram | x | tiktok | linkedin |
    // threads | newsletter | other. Finer-grained post-type lives on the
    // production item (`post_type`), not here — one YouTube channel can host
    // long videos, shorts, and community posts.
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    url: text("url"),
    avatarUrl: text("avatar_url"),
    // Platform-native identifier (YouTube channelId UC…, IG pk/id, X rest_id).
    // Stored when Scrape Creators returns it so downstream syncs can key off
    // the stable id instead of the mutable handle.
    externalId: text("external_id"),
    bio: text("bio"),
    followerCount: integer("follower_count"),
    /** Accounts this account follows. Helps gauge whether it's an
     *  actively-curating identity vs a broadcast channel. */
    followingCount: integer("following_count"),
    /** Lifetime total posts / videos / tweets on the platform. Useful for
     *  posting-cadence sanity checks and audience-growth ratios. */
    postCount: integer("post_count"),
    /** Lifetime total views on the account (YouTube channel-level views,
     *  Threads public view count). Null on platforms that don't expose it. */
    totalViews: bigint("total_views", { mode: "number" }),
    /** Platform verification flag (YouTube isVerified, X is_blue_verified,
     *  IG is_verified, TikTok verified, Threads is_verified). */
    verified: boolean("verified"),
    /** Platform header image URL (YouTube channel banner, X profile banner).
     *  Nullable — most platforms don't expose one. */
    bannerUrl: text("banner_url"),
    /** Free-text location the user has set on their profile (X + LinkedIn). */
    location: text("location"),
    // Misc SC fields — keep the full response here as a future-proof
    // escape hatch. The promoted columns above are the ones we actually
    // render in the UI.
    metadata: jsonb("metadata"),
    isActive: boolean("is_active").notNull().default(true),
    // Replaces the hardcoded NOTION_AUTHORITATIVE_PLATFORMS set. When true,
    // Notion sync owns items on this account (long-form YouTube pillars);
    // when false, the account is Hub & Spoke-owned and Notion is ignored.
    syncedFromNotion: boolean("synced_from_notion").notNull().default(false),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    lastRefreshError: text("last_refresh_error"),
    // Stamped by the per-account content sync (account-content-sync task).
    // Distinct from lastRefreshedAt, which is the profile-metadata sweep.
    lastContentSyncAt: timestamp("last_content_sync_at", { withTimezone: true }),
    lastContentSyncError: text("last_content_sync_error"),
    // Maps this hubandspoke account to a Typefully social set. Null = skip
    // Typefully draft auto-creation for this account. Get the id from
    // GET https://api.typefully.com/v2/social-sets.
    typefullySocialSetId: bigint("typefully_social_set_id", { mode: "number" }),
    // Maps this account to a Zernio ConnectedAccount `_id` (the value passed as
    // `accountId` when posting). Null = TikTok posting not connected for this
    // account. Stamped by the Zernio OAuth callback
    // (/api/integrations/zernio/callback). Only meaningful on platform='tiktok'
    // accounts for v1.
    zernioAccountId: text("zernio_account_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Soft-delete. Stamped by DELETE /api/accounts/[id] inside a transaction
    // that also stamps deleted_at on linked production_items. Every account-
    // read query in src/lib/db/accounts.ts filters deleted_at IS NULL.
    // Restore by nulling this + production_items.deleted_at.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Global identity is (platform, lower(handle)). Keeps case variants from
    // producing duplicate rows (e.g. "Starterstory" vs "starterstory").
    uniqueIndex("uniq_accounts_platform_handle").on(
      table.platform,
      sql`lower(${table.handle})`
    ),
    index("idx_accounts_brand").on(table.brandId),
    index("idx_accounts_platform").on(table.platform),
  ]
);

// Users can "link" accounts to their profile — powers the "my accounts"
// filter, default notification routing, and (eventually) per-user default
// editor assignments. No permission gating: any admin can see and
// edit any account. Composite PK (user_id, account_id) blocks duplicates.
export const userAccounts = pgTable(
  "user_accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.accountId] }),
    index("idx_user_accounts_account").on(table.accountId),
  ]
);

export const syncLogs = pgTable("sync_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  syncType: text("sync_type").notNull(),
  status: text("status").notNull(),
  itemsFetched: integer("items_fetched"),
  itemsCreated: integer("items_created"),
  itemsUpdated: integer("items_updated"),
  itemsDeleted: integer("items_deleted"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// Per-task-invocation Scrape Creators credit usage log. One row per call
// to `recordScUsage` from an instrumented task or route — the granularity
// is "task fired and spent N credits", not "individual HTTP request".
// That's enough for cost analysis (rollups by caller/account/platform/day)
// without the write volume of per-call logging. Drives the /admin/sc-usage
// dashboard.
export const scCallLog = pgTable(
  "sc_call_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caller: text("caller").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    productionItemId: uuid("production_item_id").references(
      () => productionItems.id,
      { onDelete: "set null" }
    ),
    platform: text("platform"),
    credits: integer("credits").notNull(),
    itemsCreated: integer("items_created"),
    itemsUpdated: integer("items_updated"),
    ok: boolean("ok").notNull().default(true),
    notes: text("notes"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("idx_sc_call_log_created_at").on(t.createdAt),
    index("idx_sc_call_log_caller_created_at").on(t.caller, t.createdAt),
    index("idx_sc_call_log_account_created_at").on(t.accountId, t.createdAt),
  ]
);

/**
 * Audit log for manual merges of duplicate production items.
 * Tracks which items were merged, by whom, when, and what strategy was used.
 */
export const productionItemsMerges = pgTable(
  "production_items_merges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    primaryItemId: uuid("primary_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    secondaryItemId: uuid("secondary_item_id")
      .references(() => productionItems.id, { onDelete: "cascade" })
      .notNull(),
    mergedBy: uuid("merged_by")
      .references(() => users.id, { onDelete: "set null" })
      .notNull(),
    mergeStrategy: text("merge_strategy").notNull(), // "keepPrimary" | "keepSecondary" | "mergeMetrics"
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("idx_production_items_merges_primary").on(t.primaryItemId),
    index("idx_production_items_merges_secondary").on(t.secondaryItemId),
    index("idx_production_items_merges_created_at").on(t.createdAt),
  ]
);

// Canva Connect OAuth state. Singleton row (id="default") because we
// authenticate as one Canva account globally — not per-brand, not per-user.
// Refresh tokens rotate on EVERY exchange, so they must be persisted: storing
// them in an env var alone would invalidate after the first API call. The
// access token is cached here too so multiple worker invocations within a 1h
// window share a single refresh.
//
// Concurrent refresh is serialized via pg_advisory_lock in src/lib/canva.ts —
// otherwise two parallel refreshes would invalidate each other's RT.
export const canvaOauth = pgTable("canva_oauth", {
  id: text("id").primaryKey(), // always "default"
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Worker-dyno liveness heartbeat. Singleton row (id="singleton") bumped
// by the per-minute `worker-heartbeat` cron task. Read by the public
// `GET /api/health/worker` endpoint — UptimeRobot (or any external
// uptime monitor) polls that route every few minutes; when
// `last_seen_at` falls behind, the endpoint returns 503 and the monitor
// pages us. Catches silent worker wedges (process alive, polling dead)
// that Heroku's healthchecks miss.
export const workerHeartbeat = pgTable("worker_heartbeat", {
  id: text("id").primaryKey(), // always "singleton"
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  workerDyno: text("worker_dyno"), // e.g. "worker.1" — informational
});

