ALTER TABLE "accounts" ADD COLUMN "typefully_social_set_id" bigint;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "typefully_draft_id" bigint;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "typefully_status" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "typefully_share_url" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "typefully_private_url" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "typefully_scheduled_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "typefully_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "typefully_error" text;