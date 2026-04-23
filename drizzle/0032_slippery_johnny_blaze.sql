ALTER TABLE "production_items" ADD COLUMN "youtube_download_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "youtube_download_error" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "youtube_download_source" text;