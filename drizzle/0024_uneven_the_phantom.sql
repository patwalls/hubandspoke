ALTER TABLE "production_items" ADD COLUMN "cross_post_fit_good" boolean;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "cross_post_fit_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "cross_post_fit_reasoning" text;