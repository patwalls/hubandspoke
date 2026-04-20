ALTER TABLE "content_comments"
  ADD COLUMN IF NOT EXISTS "author_name" text;
--> statement-breakpoint
ALTER TABLE "content_comments"
  ADD COLUMN IF NOT EXISTS "author_avatar_url" text;
