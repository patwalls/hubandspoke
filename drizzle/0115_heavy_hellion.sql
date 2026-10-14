CREATE TABLE "design_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"s3_bucket" text NOT NULL,
	"s3_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"source_key" text,
	"sec" numeric(10, 2),
	"rank" integer,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_photos" ADD CONSTRAINT "design_photos_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_photos" ADD CONSTRAINT "design_photos_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_photos_item_idx" ON "design_photos" USING btree ("production_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_photos_item_key_uniq" ON "design_photos" USING btree ("production_item_id","s3_key");