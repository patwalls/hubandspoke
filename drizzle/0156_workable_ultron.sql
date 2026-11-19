CREATE TABLE "clip_idea_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pillar_id" uuid NOT NULL,
	"format_id" uuid NOT NULL,
	"format_name" text NOT NULL,
	"sections_considered" integer NOT NULL,
	"ideas_created" integer NOT NULL,
	"agent_errors" integer NOT NULL,
	"skips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_idea_runs" ADD CONSTRAINT "clip_idea_runs_pillar_id_production_items_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_idea_runs" ADD CONSTRAINT "clip_idea_runs_format_id_formats_id_fk" FOREIGN KEY ("format_id") REFERENCES "public"."formats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clip_idea_runs_pillar_format" ON "clip_idea_runs" USING btree ("pillar_id","format_id","created_at");