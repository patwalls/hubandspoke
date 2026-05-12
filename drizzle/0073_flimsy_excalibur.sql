ALTER TABLE "production_items" ADD COLUMN "canva_export_job_id" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "canva_exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "canva_export_error" text;