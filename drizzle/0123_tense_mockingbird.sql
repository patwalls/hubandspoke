CREATE TABLE "newsletter_issue_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text NOT NULL,
	"schedule_group" text NOT NULL,
	"external_id" text NOT NULL,
	"origin" text NOT NULL,
	"name" text,
	"subject" text,
	"sent_date" date,
	"source_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_issue_history_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE INDEX "newsletter_issue_history_group_date_idx" ON "newsletter_issue_history" USING btree ("schedule_group","sent_date");