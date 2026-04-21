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
    status: text("status"),
    platform: jsonb("platform").$type<string[]>(),
    format: text("format"),
    brand: text("brand").default("starter-story").notNull(),
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
    // different channel. Distinct from pillarContentItemId (format-derivative
    // tree) so repost rollups and repurpose queries don't collide.
    sourceType: text("source_type").notNull().default("original"),
    repostedFromItemId: uuid("reposted_from_item_id").references(
      (): AnyPgColumn => productionItems.id,
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
    // Predicted views at the moment this item transitioned to "Published".
    // Written once on the first published-transition and never overwritten —
    // lets the detail page show actual-vs-predicted after the fact.
    predictedViewsSnapshot: integer("predicted_views_snapshot"),
    predictedViewsSnapshotAt: timestamp("predicted_views_snapshot_at", {
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
    index("idx_production_items_status").on(table.status),
    index("idx_production_items_brand").on(table.brand),
    index("idx_production_items_last_perf_sync").on(table.lastPerformanceSyncAt),
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
    name: text("name").notNull().unique(),
    brand: text("brand").default("starter-story").notNull(),
    channels: jsonb("channels").$type<string[]>().default([]),
    event: text("event"),
    viewThreshold: integer("view_threshold"),
    contentOwner: text("content_owner"), // deprecated — use editor/producer
    contentOwnerAsanaGid: text("content_owner_asana_gid"), // deprecated
    editor: text("editor"),
    editorAsanaGid: text("editor_asana_gid"),
    producer: text("producer"),
    producerAsanaGid: text("producer_asana_gid"),
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
  (table) => [index("idx_formats_parent_format_id").on(table.parentFormatId)]
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
