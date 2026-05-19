CREATE TABLE "descript_agent_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller" text NOT NULL,
	"project_id" text NOT NULL,
	"production_item_id" uuid,
	"prompt" text NOT NULL,
	"descript_job_id" text,
	"status" text DEFAULT 'started' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "descript_agent_calls" ADD CONSTRAINT "descript_agent_calls_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_descript_agent_calls_created_at" ON "descript_agent_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_descript_agent_calls_caller" ON "descript_agent_calls" USING btree ("caller");