-- content_comments was in drizzle/0000_baseline.sql, but prod was bootstrapped
-- with scripts/bootstrap-drizzle-migrations.mjs, which only records migration
-- hashes — it does NOT execute baseline SQL. If the legacy
-- scripts/add-content-comments.mjs was never run on prod, the table is missing.
-- This migration recreates it idempotently; a no-op on any DB that already has it.

CREATE TABLE IF NOT EXISTS "content_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_item_id" uuid NOT NULL,
	"user_id" uuid,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "content_comments"
		ADD CONSTRAINT "content_comments_content_item_id_production_items_id_fk"
		FOREIGN KEY ("content_item_id") REFERENCES "public"."production_items"("id")
		ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "content_comments"
		ADD CONSTRAINT "content_comments_user_id_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
		ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_content_comments_item_created"
	ON "content_comments" USING btree ("content_item_id","created_at");
