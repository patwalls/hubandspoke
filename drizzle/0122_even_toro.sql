ALTER TABLE "formats" ADD COLUMN "newsletter_template" jsonb;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "slot_key" text;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "sections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "source_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "regenerating" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_drafts_slot_key_uniq" ON "newsletter_drafts" USING btree ("slot_key") WHERE "newsletter_drafts"."slot_key" IS NOT NULL;