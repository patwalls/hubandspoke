ALTER TABLE "brand_settings" DROP CONSTRAINT "brand_settings_default_producer_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "brands" DROP CONSTRAINT "brands_default_producer_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "production_items" DROP CONSTRAINT "production_items_producer_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_production_items_producer_user";--> statement-breakpoint
ALTER TABLE "brand_settings" DROP COLUMN "default_producer_user_id";--> statement-breakpoint
ALTER TABLE "brands" DROP COLUMN "default_producer_user_id";--> statement-breakpoint
ALTER TABLE "formats" DROP COLUMN "producer";--> statement-breakpoint
ALTER TABLE "formats" DROP COLUMN "producer_notion_user_id";--> statement-breakpoint
ALTER TABLE "production_items" DROP COLUMN "producer_email";--> statement-breakpoint
ALTER TABLE "production_items" DROP COLUMN "producer_notion_user_id";--> statement-breakpoint
ALTER TABLE "production_items" DROP COLUMN "producer_name";--> statement-breakpoint
ALTER TABLE "production_items" DROP COLUMN "producer_user_id";