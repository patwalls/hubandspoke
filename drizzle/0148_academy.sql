CREATE TABLE "academy_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "academy_progress" (
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"checked_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academy_progress_user_id_video_id_pk" PRIMARY KEY("user_id","video_id")
);
--> statement-breakpoint
CREATE TABLE "academy_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"video_url" text,
	"duration_label" text,
	"learn_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academy_videos_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "academy_progress" ADD CONSTRAINT "academy_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_progress" ADD CONSTRAINT "academy_progress_video_id_academy_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."academy_videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_videos" ADD CONSTRAINT "academy_videos_category_id_academy_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."academy_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_academy_videos_category" ON "academy_videos" USING btree ("category_id","sort_order");