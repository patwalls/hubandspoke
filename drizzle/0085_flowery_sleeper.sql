CREATE TABLE "clip_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pillar_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"start_sec" numeric NOT NULL,
	"end_sec" numeric NOT NULL,
	"transcript_anchor_quote" text NOT NULL,
	"transcript_anchor_start_sec" numeric,
	"topic" text NOT NULL,
	"summary" text NOT NULL,
	"theme_tags" jsonb DEFAULT '[]'::jsonb,
	"estimated_views" bigint,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"generated_by" text NOT NULL,
	"model_usage" jsonb,
	"killed_at" timestamp with time zone,
	"killed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD COLUMN "clip_section_id" uuid;--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD COLUMN "eligibility_reason" text;--> statement-breakpoint
ALTER TABLE "clip_sections" ADD CONSTRAINT "clip_sections_pillar_id_production_items_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_sections" ADD CONSTRAINT "clip_sections_killed_by_user_id_users_id_fk" FOREIGN KEY ("killed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clip_sections_pillar" ON "clip_sections" USING btree ("pillar_id");--> statement-breakpoint
CREATE INDEX "idx_clip_sections_batch" ON "clip_sections" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "clip_ideas" ADD CONSTRAINT "clip_ideas_clip_section_id_clip_sections_id_fk" FOREIGN KEY ("clip_section_id") REFERENCES "public"."clip_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clip_ideas_clip_section_id" ON "clip_ideas" USING btree ("clip_section_id");