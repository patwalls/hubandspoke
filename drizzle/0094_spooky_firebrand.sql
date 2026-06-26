ALTER TABLE "accounts" ADD COLUMN "zernio_account_id" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "zernio_post_id" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "zernio_status" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "zernio_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "zernio_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "zernio_error" text;