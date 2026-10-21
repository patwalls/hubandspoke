CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" text DEFAULT 'view' NOT NULL,
	"screen" text NOT NULL,
	"brand" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whats_new_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_events_created" ON "usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_events_user_created" ON "usage_events" USING btree ("user_id","created_at");