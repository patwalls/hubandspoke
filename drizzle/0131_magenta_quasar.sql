CREATE TABLE "newsletter_template_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"format_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposal" jsonb,
	"rationale" text,
	"issue_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "newsletter_template_proposals" ADD CONSTRAINT "newsletter_template_proposals_format_id_formats_id_fk" FOREIGN KEY ("format_id") REFERENCES "public"."formats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_template_proposals" ADD CONSTRAINT "newsletter_template_proposals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "newsletter_template_proposals_format_idx" ON "newsletter_template_proposals" USING btree ("format_id","created_at");