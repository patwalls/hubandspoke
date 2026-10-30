CREATE TABLE "api_webhook_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"items_updated_at" timestamp with time zone NOT NULL,
	"transcripts_updated_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_webhook_item_state" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"status" text,
	"transcript_fetched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret" text NOT NULL,
	"brand" text,
	"active" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" jsonb DEFAULT '["read"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_webhook_deliveries" ADD CONSTRAINT "api_webhook_deliveries_webhook_id_api_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."api_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_webhook_item_state" ADD CONSTRAINT "api_webhook_item_state_item_id_production_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_webhooks" ADD CONSTRAINT "api_webhooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_webhook_deliveries_hook_created" ON "api_webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_webhooks_user" ON "api_webhooks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_production_items_updated_at" ON "production_items" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_transcripts_updated_at" ON "transcripts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_transcripts_fulltext" ON "transcripts" USING gin (to_tsvector('english', "full_text"));