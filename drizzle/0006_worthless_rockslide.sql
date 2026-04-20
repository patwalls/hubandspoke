CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_item_id" uuid,
	"comment_id" uuid,
	"actor_user_id" uuid,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "producer_user_id" uuid;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "editor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notion_user_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_content_item_id_production_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_content_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."content_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_user_created" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_producer_user_id_users_id_fk" FOREIGN KEY ("producer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_editor_user_id_users_id_fk" FOREIGN KEY ("editor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_production_items_producer_user" ON "production_items" USING btree ("producer_user_id");--> statement-breakpoint
CREATE INDEX "idx_production_items_editor_user" ON "production_items" USING btree ("editor_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_notion_user_id_unique" UNIQUE("notion_user_id");--> statement-breakpoint
-- Backfill producer_user_id / editor_user_id from the legacy email columns.
-- Case-insensitive match against users.email. Rows whose producer/editor email
-- doesn't resolve to a known user stay NULL (expected for external contributors).
UPDATE "production_items"
SET "producer_user_id" = u."id"
FROM "users" u
WHERE lower(u."email") = lower("production_items"."producer_email")
  AND "production_items"."producer_user_id" IS NULL;--> statement-breakpoint
UPDATE "production_items"
SET "editor_user_id" = u."id"
FROM "users" u
WHERE lower(u."email") = lower("production_items"."editor_email")
  AND "production_items"."editor_user_id" IS NULL;--> statement-breakpoint
-- Backfill users.notion_user_id from whichever production_item row first exposes
-- a Notion user id for that email. DISTINCT ON picks one notion_user_id per email
-- so the UNIQUE(notion_user_id) constraint holds.
WITH email_to_notion AS (
  SELECT DISTINCT ON (lower(email)) lower(email) AS email_lower, notion_id
  FROM (
    SELECT producer_email AS email, producer_notion_user_id AS notion_id
    FROM "production_items"
    WHERE producer_email IS NOT NULL AND producer_notion_user_id IS NOT NULL
    UNION ALL
    SELECT editor_email, editor_notion_user_id
    FROM "production_items"
    WHERE editor_email IS NOT NULL AND editor_notion_user_id IS NOT NULL
  ) src
  ORDER BY lower(email), notion_id
)
UPDATE "users"
SET "notion_user_id" = etn.notion_id
FROM email_to_notion etn
WHERE lower("users"."email") = etn.email_lower
  AND "users"."notion_user_id" IS NULL;