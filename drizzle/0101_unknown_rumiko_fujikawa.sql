CREATE TABLE "format_trigger_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"format_id" uuid NOT NULL,
	"source_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "format_trigger_sources" ADD CONSTRAINT "format_trigger_sources_format_id_formats_id_fk" FOREIGN KEY ("format_id") REFERENCES "public"."formats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "format_trigger_sources" ADD CONSTRAINT "format_trigger_sources_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_format_trigger_sources_format_account" ON "format_trigger_sources" USING btree ("format_id","source_account_id");--> statement-breakpoint
CREATE INDEX "idx_format_trigger_sources_format" ON "format_trigger_sources" USING btree ("format_id");--> statement-breakpoint
CREATE INDEX "idx_format_trigger_sources_account" ON "format_trigger_sources" USING btree ("source_account_id");