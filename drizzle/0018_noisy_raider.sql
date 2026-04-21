ALTER TABLE "production_items" ADD COLUMN "predicted_views_snapshot" integer;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "predicted_views_snapshot_at" timestamp with time zone;