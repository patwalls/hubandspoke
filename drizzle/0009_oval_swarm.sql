CREATE TABLE "cross_post_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text DEFAULT 'starter-story' NOT NULL,
	"source_platform" text NOT NULL,
	"view_threshold" integer NOT NULL,
	"target_platform" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_cross_post_rules_brand_src_tgt" ON "cross_post_rules" USING btree ("brand","source_platform","target_platform");