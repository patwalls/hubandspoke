ALTER TABLE "accounts" ADD COLUMN "following_count" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "post_count" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "total_views" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "verified" boolean;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "banner_url" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "location" text;