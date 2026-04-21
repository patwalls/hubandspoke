CREATE TABLE "content_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"content" jsonb NOT NULL,
	"field_schema_snapshot" jsonb NOT NULL,
	"generated_by" text NOT NULL,
	"prompt_version" integer,
	"model_usage" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "field_schema" jsonb;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_drafts_item" ON "content_drafts" USING btree ("production_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_drafts_current" ON "content_drafts" USING btree ("production_item_id") WHERE "content_drafts"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_drafts_item_version" ON "content_drafts" USING btree ("production_item_id","version");