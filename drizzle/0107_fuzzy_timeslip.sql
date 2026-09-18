CREATE TABLE "design_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_item_id" uuid NOT NULL,
	"sec" numeric(10, 2) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"s3_bucket" text,
	"s3_key" text,
	"width" integer,
	"height" integer,
	"origin" text DEFAULT 'auto' NOT NULL,
	"is_pick" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_frames" ADD CONSTRAINT "design_frames_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "design_frames_item_sec_uniq" ON "design_frames" USING btree ("production_item_id","sec");