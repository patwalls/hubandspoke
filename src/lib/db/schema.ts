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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const productionItems = pgTable(
  "production_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    notionId: text("notion_id").unique(),
    youtubeId: text("youtube_id").unique(),
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
    // producer/editor pattern — can't delete an account that still owns items.
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
    salesNum: integer("sales_num"),
    salesAmount: decimal("sales_amount", { precision: 12, scale: 2 }),
    ctrFirstHour: decimal("ctr_first_hour"),
    apvFirst24Hours: decimal("apv_first_24_hours"),
    producerEmail: text("producer_email"),
    producerNotionUserId: text("producer_notion_user_id"),
    producerName: text("producer_name"),
    editorEmail: text("editor_email"),
    editorNotionUserId: text("editor_notion_user_id"),
    editorName: text("editor_name"),
    // App-owned assignment FKs. Required: every production item has both a
    // producer and an editor. Defaults come from resolveAssignees (source →
    // format → brand → global). Notion sync stops touching these on update —
    // edits happen only in-app. Legacy email/name columns remain for
    // historical display on archived items whose people aren't in our users
    // directory. onDelete: "restrict" over "set null" since NOT NULL would
    // reject that anyway — user deletion is blocked while they own items.
    producerUserId: uuid("producer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
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
    descriptImportedAt: timestamp("descript_imported_at", {
      withTimezone: true,
    }),
    // Permanent media archive: source video uploaded to S3 before being
    // handed to Descript via a presigned GET URL. Lets us re-import to
    // Descript without re-uploading from the browser.
    mediaS3Bucket: text("media_s3_bucket"),
    mediaS3Key: text("media_s3_key"),
    mediaS3UploadedAt: timestamp("media_s3_uploaded_at", {
      withTimezone: true,
    }),
    mediaSizeBytes: bigint("media_size_bytes", { mode: "number" }),
    mediaContentType: text("media_content_type"),
    // Durable cover image for video platforms (IG reel, YT, TikTok) and a
    // backup copy of the cover for image posts. Distinct from `thumbnail`,
    // which holds an upstream CDN URL that may expire. Lives in the same
    // bucket as `mediaS3Key` (see `mediaS3Bucket`).
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
    // How this item entered the system. "original" is user-authored or
    // Notion-synced; "repost" is a same-content/same-channel re-run of an
    // earlier item; "cross_post" is (reserved) a one-to-one sibling post on a
    // different channel; "clip" is promoted from a clip-idea triage (many
    // clips can share a pillar + format, so the uniq (pillar, format) index
    // below deliberately scopes itself to sourceType='original'). Distinct
    // from pillarContentItemId (format-derivative tree) so repost rollups
    // and repurpose queries don't collide.
    sourceType: text("source_type").notNull().default("original"),
    repostedFromItemId: uuid("reposted_from_item_id").references(
      (): AnyPgColumn => productionItems.id,
      { onDelete: "set null" }
    ),
    // For sourceType='clip' rows: FK back to the triaged clip_ideas row this
    // production item was promoted from. Enables a direct "came from clip
    // idea X" lookup; the partial uniq index below guarantees exactly one
    // production item per clip idea at the DB level.
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_production_items_published_date").on(table.publishedDate),
    index("idx_production_items_published_at").on(table.publishedAt),
    index("idx_production_items_status").on(table.status),
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
    index("idx_production_items_producer_user").on(table.producerUserId),
    index("idx_production_items_editor_user").on(table.editorUserId),
    uniqueIndex("uniq_production_items_pillar_format")
      .on(table.pillarContentItemId, sql`lower(${table.format})`)
      .where(
        sql`${table.pillarContentItemId} IS NOT NULL AND ${table.format} IS NOT NULL AND ${table.sourceType} = 'original'`
      ),
    uniqueIndex("uniq_production_items_utm_campaign")
      .on(table.utmCampaign)
      .where(sql`${table.utmCampaign} IS NOT NULL`),
    uniqueIndex("uniq_production_items_source_clip_idea")
      .on(table.sourceClipIdeaId)
      .where(sql`${table.sourceClipIdeaId} IS NOT NULL`),
  ]
);

// One row per production item. Populated on demand (Stage 1) by publishing the
// linked Descript composition and parsing the WEBVTT subtitles on the
// published_projects endpoint. `rawVtt` is kept so re-parsing is possible
// without re-publishing; `segments` is the parsed form used by the UI and by
// getTranscriptForPrompt() for LLM calls.
export const transcripts = pgTable("transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  productionItemId: uuid("production_item_id")
    .references(() => productionItems.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  source: text("source").notNull().default("descript"),
  language: text("language").default("en"),
  rawVtt: text("raw_vtt").notNull(),
  fullText: text("full_text").notNull(),
  segments: jsonb("segments")
    .$type<Array<{ startSec: number; endSec: number; text: string; speaker?: string }>>()
    .notNull(),
  wordCount: integer("word_count"),
  durationSec: decimal("duration_sec"),
  descriptPublishedSlug: text("descript_published_slug"),
  descriptShareUrl: text("descript_share_url"),
  descriptPublishedAt: timestamp("descript_published_at", {
    withTimezone: true,
  }),
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
    batchId: uuid("batch_id").notNull(),
    startSec: decimal("start_sec").notNull(),
    endSec: decimal("end_sec").notNull(),
    hook: text("hook").notNull(),
    angle: text("angle").notNull(),
    rationale: text("rationale").notNull(),
    // Legacy field from the first cut; unused now that the agent returns
    // estimatedViews. Kept nullable so older rows still read.
    confidence: decimal("confidence"),
    estimatedViews: bigint("estimated_views", { mode: "number" }),
    generatedBy: text("generated_by").notNull(),
    promptVersion: integer("prompt_version").notNull().default(1),
    modelUsage: jsonb("model_usage"),
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
    contentOwner: text("content_owner"), // deprecated — use editor/producer
    editor: text("editor"),
    producer: text("producer"),
    instructions: text("instructions"),
    // NULL parent = root (pillar). ON DELETE SET NULL promotes direct children
    // to roots so we don't silently wipe entire subtrees.
    parentFormatId: uuid("parent_format_id").references(
      (): AnyPgColumn => formats.id,
      { onDelete: "set null" }
    ),
    notionPageId: text("notion_page_id"), // Notion page ID for format relation
    editorNotionUserId: text("editor_notion_user_id"), // Notion user ID for editor/creator
    producerNotionUserId: text("producer_notion_user_id"), // Notion user ID for producer/reviewer
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
      .references(() => productionItems.id)
      .notNull(),
    sourceFormatId: uuid("source_format_id").references(() => formats.id),
    targetFormatId: uuid("target_format_id")
      .references(() => formats.id)
      .notNull(),
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

export const brandSettings = pgTable("brand_settings", {
  brand: text("brand").primaryKey(),
  weeklyGoal: integer("weekly_goal"),
  // 0 = Sunday .. 6 = Saturday. Controls dashboard week buckets.
  weekStartDay: integer("week_start_day").notNull().default(0),
  // Per-brand fallbacks used by resolveAssignees when a new item can't
  // inherit from a source item or its format. NULL → fall through to the
  // global fallback (pat).
  defaultProducerUserId: uuid("default_producer_user_id").references(
    () => users.id,
    { onDelete: "set null" }
  ),
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
    invitedBy: uuid("invited_by").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
    }),
    // Notion-side identity. Populated during sync so we can resolve Notion
    // comment authors + assignments back to our user rows even when the email
    // isn't exposed to integrations (Notion redacts it for some accounts).
    notionUserId: text("notion_user_id").unique(),
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
  | { type: "killed"; from: string | null; reason: string | null };

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
  | { kind: "assigned"; role: "producer" | "editor"; title: string | null }
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
// the same table — weekly goal + week start day + default producer/editor all
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
    // 0 = Sunday .. 6 = Saturday. Controls dashboard week buckets.
    weekStartDay: integer("week_start_day").notNull().default(0),
    defaultProducerUserId: uuid("default_producer_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
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
  },
  (table) => [uniqueIndex("idx_brands_slug_lower").on(sql`lower(${table.slug})`)]
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
// producer/editor assignments. No permission gating: any admin can see and
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
