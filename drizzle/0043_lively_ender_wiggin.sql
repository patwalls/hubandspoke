ALTER TABLE "accounts" ADD COLUMN "last_content_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "last_content_sync_error" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "platform_content_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_production_items_account_platform_content_id" ON "production_items" USING btree ("account_id","platform_content_id") WHERE "production_items"."platform_content_id" IS NOT NULL;