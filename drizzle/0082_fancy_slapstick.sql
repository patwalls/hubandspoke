ALTER TABLE "production_items" ADD COLUMN "newsletter_preview_text" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "newsletter_body_html" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "newsletter_recipients" integer;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "klaviyo_list_id" text;