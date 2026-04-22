CREATE TABLE "production_item_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_item_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"kind" text NOT NULL,
	"s3_bucket" text NOT NULL,
	"s3_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint,
	"poster_s3_key" text,
	"source_url" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_item_media" ADD CONSTRAINT "production_item_media_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_item_media_item_idx_uniq" ON "production_item_media" USING btree ("production_item_id","index");--> statement-breakpoint
CREATE INDEX "production_item_media_item_idx" ON "production_item_media" USING btree ("production_item_id");