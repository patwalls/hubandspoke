CREATE TABLE "newsletter_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text NOT NULL,
	"format_id" uuid NOT NULL,
	"account_id" uuid,
	"status" text DEFAULT 'drafting' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"preview_text" text,
	"body_markdown" text,
	"notes" text,
	"model" text,
	"error" text,
	"hubspot_email_id" text,
	"hubspot_email_url" text,
	"hubspot_status" text,
	"hubspot_error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD CONSTRAINT "newsletter_drafts_format_id_formats_id_fk" FOREIGN KEY ("format_id") REFERENCES "public"."formats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD CONSTRAINT "newsletter_drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD CONSTRAINT "newsletter_drafts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "newsletter_drafts_brand_created_idx" ON "newsletter_drafts" USING btree ("brand","created_at");