CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"url" text,
	"avatar_url" text,
	"external_id" text,
	"bio" text,
	"follower_count" integer,
	"metadata" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"synced_from_notion" boolean DEFAULT false NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_refresh_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"avatar_url" text,
	"color" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"weekly_goal" integer,
	"week_start_day" integer DEFAULT 0 NOT NULL,
	"default_producer_user_id" uuid,
	"default_editor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_accounts" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_accounts_user_id_account_id_pk" PRIMARY KEY("user_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "cross_post_rules" ADD COLUMN "source_account_id" uuid;--> statement-breakpoint
ALTER TABLE "cross_post_rules" ADD COLUMN "target_account_id" uuid;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "post_type" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_default_producer_user_id_users_id_fk" FOREIGN KEY ("default_producer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_default_editor_user_id_users_id_fk" FOREIGN KEY ("default_editor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_accounts_platform_handle" ON "accounts" USING btree ("platform",lower("handle"));--> statement-breakpoint
CREATE INDEX "idx_accounts_brand" ON "accounts" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_platform" ON "accounts" USING btree ("platform");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_brands_slug_lower" ON "brands" USING btree (lower("slug"));--> statement-breakpoint
CREATE INDEX "idx_user_accounts_account" ON "user_accounts" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "cross_post_rules" ADD CONSTRAINT "cross_post_rules_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_post_rules" ADD CONSTRAINT "cross_post_rules_target_account_id_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cross_post_rules_source_account" ON "cross_post_rules" USING btree ("source_account_id");--> statement-breakpoint
CREATE INDEX "idx_cross_post_rules_target_account" ON "cross_post_rules" USING btree ("target_account_id");--> statement-breakpoint
CREATE INDEX "idx_production_items_account" ON "production_items" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_production_items_post_type" ON "production_items" USING btree ("post_type");