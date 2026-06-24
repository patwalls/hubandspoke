CREATE TABLE "scheduled_match_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_item_id" uuid NOT NULL,
	"candidate_item_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "expected_publish_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "schedule_needs_attention_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_match_suggestions" ADD CONSTRAINT "scheduled_match_suggestions_scheduled_item_id_production_items_id_fk" FOREIGN KEY ("scheduled_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_match_suggestions" ADD CONSTRAINT "scheduled_match_suggestions_candidate_item_id_production_items_id_fk" FOREIGN KEY ("candidate_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_match_suggestions" ADD CONSTRAINT "scheduled_match_suggestions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_scheduled_match_suggestion_pair" ON "scheduled_match_suggestions" USING btree ("scheduled_item_id","candidate_item_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_match_suggestions_scheduled" ON "scheduled_match_suggestions" USING btree ("scheduled_item_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_match_suggestions_status" ON "scheduled_match_suggestions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_production_items_scheduled_at" ON "production_items" USING btree ("scheduled_at") WHERE "production_items"."scheduled_at" IS NOT NULL;