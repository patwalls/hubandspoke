CREATE TABLE "clip_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_idea_id" uuid NOT NULL,
	"doc" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_edit_id" uuid NOT NULL,
	"production_item_id" uuid NOT NULL,
	"doc" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"output_s3_bucket" text,
	"output_s3_key" text,
	"output_size_bytes" bigint,
	"duration_sec" numeric,
	"render_seconds" numeric,
	"requested_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_edits" ADD CONSTRAINT "clip_edits_clip_idea_id_clip_ideas_id_fk" FOREIGN KEY ("clip_idea_id") REFERENCES "public"."clip_ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_edits" ADD CONSTRAINT "clip_edits_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_renders" ADD CONSTRAINT "clip_renders_clip_edit_id_clip_edits_id_fk" FOREIGN KEY ("clip_edit_id") REFERENCES "public"."clip_edits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_renders" ADD CONSTRAINT "clip_renders_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_renders" ADD CONSTRAINT "clip_renders_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_edits_clip_idea_uniq" ON "clip_edits" USING btree ("clip_idea_id");--> statement-breakpoint
CREATE INDEX "idx_clip_renders_item_created" ON "clip_renders" USING btree ("production_item_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_clip_renders_edit" ON "clip_renders" USING btree ("clip_edit_id");