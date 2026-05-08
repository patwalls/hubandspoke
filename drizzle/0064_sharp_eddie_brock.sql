ALTER TABLE "production_items" ADD COLUMN "descript_publish_job_id" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "descript_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "descript_publish_error" text;