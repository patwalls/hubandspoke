ALTER TABLE "formats" RENAME COLUMN "is_clip_descript_format" TO "is_clippable_format";--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD COLUMN "target_format" text;--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD COLUMN "extras" jsonb;--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "clip_target_platform" jsonb;--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "clip_target_post_type" text;--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "clip_aspect_ratio" text;--> statement-breakpoint
CREATE INDEX "idx_clip_ideas_source_target_format" ON "clip_ideas" USING btree ("source_production_item_id","target_format");