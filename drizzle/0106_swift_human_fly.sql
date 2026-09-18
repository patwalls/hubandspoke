CREATE TABLE "design_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_item_id" uuid NOT NULL,
	"doc" jsonb NOT NULL,
	"brief" jsonb,
	"brief_instruction" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_doc_id" uuid NOT NULL,
	"production_item_id" uuid NOT NULL,
	"doc" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"output_keys" jsonb,
	"render_seconds" numeric,
	"requested_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_docs" ADD CONSTRAINT "design_docs_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_docs" ADD CONSTRAINT "design_docs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_renders" ADD CONSTRAINT "design_renders_design_doc_id_design_docs_id_fk" FOREIGN KEY ("design_doc_id") REFERENCES "public"."design_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_renders" ADD CONSTRAINT "design_renders_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_renders" ADD CONSTRAINT "design_renders_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "design_docs_item_uniq" ON "design_docs" USING btree ("production_item_id");--> statement-breakpoint
CREATE INDEX "idx_design_renders_item_created" ON "design_renders" USING btree ("production_item_id","created_at");