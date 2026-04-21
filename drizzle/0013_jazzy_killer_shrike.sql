CREATE TABLE "clip_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_production_item_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"start_sec" numeric NOT NULL,
	"end_sec" numeric NOT NULL,
	"hook" text NOT NULL,
	"angle" text NOT NULL,
	"rationale" text NOT NULL,
	"confidence" numeric,
	"generated_by" text NOT NULL,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"model_usage" jsonb,
	"status" text DEFAULT 'suggested' NOT NULL,
	"kill_reason" text,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD CONSTRAINT "clip_ideas_source_production_item_id_production_items_id_fk" FOREIGN KEY ("source_production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD CONSTRAINT "clip_ideas_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clip_ideas_source" ON "clip_ideas" USING btree ("source_production_item_id");--> statement-breakpoint
CREATE INDEX "idx_clip_ideas_batch" ON "clip_ideas" USING btree ("batch_id");