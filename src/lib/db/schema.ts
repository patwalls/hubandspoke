import {
  pgTable,
  uuid,
  text,
  date,
  boolean,
  integer,
  decimal,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const productionItems = pgTable(
  "production_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    notionId: text("notion_id").notNull().unique(),
    title: text("title"),
    publishedDate: date("published_date"),
    status: text("status"),
    platform: jsonb("platform").$type<string[]>(),
    format: text("format"),
    campaign: text("campaign"),
    utmCampaign: text("utm_campaign"),
    publishedLink: text("published_link"),
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
    lastPerformanceSyncAt: timestamp("last_performance_sync_at", {
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
  ]
);

export const formats = pgTable("formats", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  brand: text("brand").default("starter-story").notNull(),
  channels: jsonb("channels").$type<string[]>().default([]),
  event: text("event"),
  viewThreshold: integer("view_threshold"),
  contentOwner: text("content_owner"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const formatRepurposeMappings = pgTable(
  "format_repurpose_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceFormatId: uuid("source_format_id")
      .references(() => formats.id, { onDelete: "cascade" })
      .notNull(),
    targetFormatId: uuid("target_format_id")
      .references(() => formats.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_format_repurpose_unique").on(
      table.sourceFormatId,
      table.targetFormatId
    ),
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
