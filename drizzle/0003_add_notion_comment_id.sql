ALTER TABLE "content_comments"
  ADD COLUMN IF NOT EXISTS "notion_comment_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_comments_notion_comment_id_unique"
  ON "content_comments" ("notion_comment_id")
  WHERE "notion_comment_id" IS NOT NULL;
