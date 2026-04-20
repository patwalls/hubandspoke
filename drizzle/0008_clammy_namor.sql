ALTER TABLE "production_items" ADD COLUMN "is_evergreen" boolean;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "evergreen_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "evergreen_reasoning" text;