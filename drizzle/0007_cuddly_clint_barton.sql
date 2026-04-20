ALTER TABLE "production_items" ADD COLUMN "source_type" text DEFAULT 'original' NOT NULL;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "reposted_from_item_id" uuid;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_reposted_from_item_id_production_items_id_fk" FOREIGN KEY ("reposted_from_item_id") REFERENCES "public"."production_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_production_items_reposted_from" ON "production_items" USING btree ("reposted_from_item_id");