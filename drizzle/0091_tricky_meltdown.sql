ALTER TABLE "invites" ADD COLUMN "brand_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "brand_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;