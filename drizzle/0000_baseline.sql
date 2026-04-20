CREATE TABLE "brand_settings" (
	"brand" text PRIMARY KEY NOT NULL,
	"weekly_goal" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_item_id" uuid NOT NULL,
	"user_id" uuid,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"brand" text DEFAULT 'starter-story' NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb,
	"event" text,
	"view_threshold" integer,
	"content_owner" text,
	"content_owner_asana_gid" text,
	"editor" text,
	"editor_asana_gid" text,
	"producer" text,
	"producer_asana_gid" text,
	"instructions" text,
	"parent_format_id" uuid,
	"notion_page_id" text,
	"editor_notion_user_id" text,
	"producer_notion_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formats_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'creator' NOT NULL,
	"invited_by_user_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "production_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notion_id" text,
	"youtube_id" text,
	"youtube_url" text,
	"thumbnail" text,
	"title" text,
	"published_date" date,
	"status" text,
	"platform" jsonb,
	"format" text,
	"brand" text DEFAULT 'starter-story' NOT NULL,
	"campaign" text,
	"utm_campaign" text,
	"published_link" text,
	"is_external" boolean DEFAULT false NOT NULL,
	"views" integer,
	"likes" integer,
	"comments" integer,
	"clicks" integer,
	"leads" integer,
	"sales_num" integer,
	"sales_amount" numeric(12, 2),
	"ctr_first_hour" numeric,
	"apv_first_24_hours" numeric,
	"producer_email" text,
	"producer_notion_user_id" text,
	"producer_name" text,
	"editor_email" text,
	"editor_notion_user_id" text,
	"editor_name" text,
	"views_estimated" boolean DEFAULT false,
	"last_performance_sync_at" timestamp with time zone,
	"descript_project_id" text,
	"descript_project_url" text,
	"descript_composition_id" text,
	"descript_imported_at" timestamp with time zone,
	"media_s3_bucket" text,
	"media_s3_key" text,
	"media_s3_uploaded_at" timestamp with time zone,
	"media_size_bytes" bigint,
	"media_content_type" text,
	"pillar_content_notion_id" text,
	"pillar_content_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_items_notion_id_unique" UNIQUE("notion_id"),
	CONSTRAINT "production_items_youtube_id_unique" UNIQUE("youtube_id")
);
--> statement-breakpoint
CREATE TABLE "repurpose_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_item_id" uuid NOT NULL,
	"source_format_id" uuid,
	"target_format_id" uuid NOT NULL,
	"notion_task_page_id" text,
	"views_at_trigger" integer,
	"descript_composition_id" text,
	"descript_project_url" text,
	"descript_job_id" text,
	"descript_prompt" text,
	"composition_name" text,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_type" text NOT NULL,
	"status" text NOT NULL,
	"items_fetched" integer,
	"items_created" integer,
	"items_updated" integer,
	"items_deleted" integer,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text,
	"avatar_url" text,
	"role" text DEFAULT 'creator' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "content_comments" ADD CONSTRAINT "content_comments_content_item_id_production_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_comments" ADD CONSTRAINT "content_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formats" ADD CONSTRAINT "formats_parent_format_id_formats_id_fk" FOREIGN KEY ("parent_format_id") REFERENCES "public"."formats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_pillar_content_item_id_production_items_id_fk" FOREIGN KEY ("pillar_content_item_id") REFERENCES "public"."production_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repurpose_triggers" ADD CONSTRAINT "repurpose_triggers_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repurpose_triggers" ADD CONSTRAINT "repurpose_triggers_source_format_id_formats_id_fk" FOREIGN KEY ("source_format_id") REFERENCES "public"."formats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repurpose_triggers" ADD CONSTRAINT "repurpose_triggers_target_format_id_formats_id_fk" FOREIGN KEY ("target_format_id") REFERENCES "public"."formats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_comments_item_created" ON "content_comments" USING btree ("content_item_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_formats_parent_format_id" ON "formats" USING btree ("parent_format_id");--> statement-breakpoint
CREATE INDEX "idx_invites_email_lower" ON "invites" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "idx_invites_status" ON "invites" USING btree ("accepted_at","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "idx_password_reset_tokens_user" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_production_items_published_date" ON "production_items" USING btree ("published_date");--> statement-breakpoint
CREATE INDEX "idx_production_items_status" ON "production_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_production_items_brand" ON "production_items" USING btree ("brand");--> statement-breakpoint
CREATE INDEX "idx_production_items_last_perf_sync" ON "production_items" USING btree ("last_performance_sync_at");--> statement-breakpoint
CREATE INDEX "idx_production_items_pillar_notion" ON "production_items" USING btree ("pillar_content_notion_id");--> statement-breakpoint
CREATE INDEX "idx_production_items_pillar_item" ON "production_items" USING btree ("pillar_content_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_production_items_pillar_format" ON "production_items" USING btree ("pillar_content_item_id",lower("format")) WHERE "production_items"."pillar_content_item_id" IS NOT NULL AND "production_items"."format" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_repurpose_triggers_item" ON "repurpose_triggers" USING btree ("production_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email_lower" ON "users" USING btree (lower("email"));