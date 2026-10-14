CREATE TABLE "design_cover_styles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_item_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"media_s3_bucket" text,
	"media_s3_key" text NOT NULL,
	"doc" jsonb,
	"summary" text,
	"notes" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_cover_styles_production_item_id_unique" UNIQUE("production_item_id")
);
--> statement-breakpoint
ALTER TABLE "design_cover_styles" ADD CONSTRAINT "design_cover_styles_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;