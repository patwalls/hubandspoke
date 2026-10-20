ALTER TABLE "newsletter_drafts" ADD COLUMN "send_date" date;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "special_copy" text;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "special_original" text;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "special_mode" text;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "special_source" jsonb;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "special_error" text;