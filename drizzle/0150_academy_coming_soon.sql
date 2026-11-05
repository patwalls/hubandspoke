ALTER TABLE "academy_videos" ADD COLUMN "coming_soon" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "academy_videos" ADD COLUMN "available_at" timestamp with time zone;