CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_item_id" uuid NOT NULL,
	"source" text DEFAULT 'descript' NOT NULL,
	"language" text DEFAULT 'en',
	"raw_vtt" text NOT NULL,
	"full_text" text NOT NULL,
	"segments" jsonb NOT NULL,
	"word_count" integer,
	"duration_sec" numeric,
	"descript_published_slug" text,
	"descript_share_url" text,
	"descript_published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcripts_production_item_id_unique" UNIQUE("production_item_id")
);
--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;