ALTER TABLE "production_items" ADD COLUMN "poster_s3_key" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "author_handle" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "author_display_name" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "author_follower_count" integer;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "author_verified" boolean;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "enrichment_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "enrichment_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "enrichment_error" text;--> statement-breakpoint
CREATE INDEX "idx_production_items_enrichment_pending" ON "production_items" USING btree ("enrichment_completed_at");