ALTER TABLE "production_items" ADD COLUMN "manychat_keyword" text;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "manychat_link" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_production_items_manychat_keyword" ON "production_items" USING btree ("account_id","manychat_keyword") WHERE "production_items"."manychat_keyword" IS NOT NULL;