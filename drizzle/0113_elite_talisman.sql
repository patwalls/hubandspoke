ALTER TABLE "brands" ADD COLUMN "cta_fallback_url" text;--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "cta_strategy" text;--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "cta_fixed_url" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "cta_offer_url" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "cta_offer_label" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "cta_offer_checked_at" timestamp with time zone;