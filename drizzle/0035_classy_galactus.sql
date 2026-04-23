CREATE TABLE "format_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"format_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"post_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "format_channels" ADD CONSTRAINT "format_channels_format_id_formats_id_fk" FOREIGN KEY ("format_id") REFERENCES "public"."formats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "format_channels" ADD CONSTRAINT "format_channels_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_format_channels_format_account_post_type" ON "format_channels" USING btree ("format_id","account_id",COALESCE("post_type", ''));--> statement-breakpoint
CREATE INDEX "idx_format_channels_format" ON "format_channels" USING btree ("format_id");--> statement-breakpoint
CREATE INDEX "idx_format_channels_account" ON "format_channels" USING btree ("account_id");