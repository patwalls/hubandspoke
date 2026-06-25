ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "brand_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "brand_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
