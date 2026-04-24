DROP INDEX "uniq_production_items_manychat_keyword";--> statement-breakpoint
ALTER TABLE "production_items" DROP COLUMN "manychat_keyword";--> statement-breakpoint
ALTER TABLE "production_items" DROP COLUMN "manychat_link";