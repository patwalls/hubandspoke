CREATE TABLE "clip_idea_drought_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pillar_id" uuid NOT NULL,
	"format_id" uuid NOT NULL,
	"format_name" text NOT NULL,
	"alerted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_idea_drought_alerts" ADD CONSTRAINT "clip_idea_drought_alerts_pillar_id_production_items_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_idea_drought_alerts" ADD CONSTRAINT "clip_idea_drought_alerts_format_id_formats_id_fk" FOREIGN KEY ("format_id") REFERENCES "public"."formats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clip_idea_drought_pillar_format" ON "clip_idea_drought_alerts" USING btree ("pillar_id","format_id");