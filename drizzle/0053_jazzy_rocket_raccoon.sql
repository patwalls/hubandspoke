CREATE TABLE "sc_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller" text NOT NULL,
	"account_id" uuid,
	"production_item_id" uuid,
	"platform" text,
	"credits" integer NOT NULL,
	"items_created" integer,
	"items_updated" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"notes" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sc_call_log" ADD CONSTRAINT "sc_call_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sc_call_log" ADD CONSTRAINT "sc_call_log_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sc_call_log_created_at" ON "sc_call_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_sc_call_log_caller_created_at" ON "sc_call_log" USING btree ("caller","created_at");--> statement-breakpoint
CREATE INDEX "idx_sc_call_log_account_created_at" ON "sc_call_log" USING btree ("account_id","created_at");