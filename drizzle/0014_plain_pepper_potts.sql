ALTER TABLE "clip_ideas" ADD COLUMN "estimated_views" bigint;--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD COLUMN "accepted_notion_page_id" text;--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD COLUMN "accepted_notion_page_url" text;--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD COLUMN "accepted_target_format" text;--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD COLUMN "accepted_editor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD CONSTRAINT "clip_ideas_accepted_editor_user_id_users_id_fk" FOREIGN KEY ("accepted_editor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;