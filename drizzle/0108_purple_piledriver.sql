ALTER TABLE "formats" ADD COLUMN "design_template" jsonb;--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "design_template_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "clip_template" jsonb;--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "clip_template_updated_at" timestamp with time zone;