CREATE TABLE "production_items_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"primary_item_id" uuid NOT NULL,
	"secondary_item_id" uuid NOT NULL,
	"merged_by" uuid NOT NULL,
	"merge_strategy" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_items_merges" ADD CONSTRAINT "production_items_merges_primary_item_id_production_items_id_fk" FOREIGN KEY ("primary_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_items_merges" ADD CONSTRAINT "production_items_merges_secondary_item_id_production_items_id_fk" FOREIGN KEY ("secondary_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_items_merges" ADD CONSTRAINT "production_items_merges_merged_by_users_id_fk" FOREIGN KEY ("merged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_production_items_merges_primary" ON "production_items_merges" USING btree ("primary_item_id");--> statement-breakpoint
CREATE INDEX "idx_production_items_merges_secondary" ON "production_items_merges" USING btree ("secondary_item_id");--> statement-breakpoint
CREATE INDEX "idx_production_items_merges_created_at" ON "production_items_merges" USING btree ("created_at");