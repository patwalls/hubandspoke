CREATE TABLE "fixes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filed_by_user_id" uuid NOT NULL,
	"filed_by_email" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"category" text,
	"note" text NOT NULL,
	"url" text,
	"page_html" text,
	"photo_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fixes" ADD CONSTRAINT "fixes_filed_by_user_id_users_id_fk" FOREIGN KEY ("filed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_fixes_status" ON "fixes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fixes_created_at" ON "fixes" USING btree ("created_at");