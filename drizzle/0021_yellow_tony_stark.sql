ALTER TABLE "production_items" ADD COLUMN "content_body" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "content_body_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "content_body_source" text;