CREATE TABLE "cross_post_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"target_account_id" uuid NOT NULL,
	"target_post_type" text NOT NULL,
	"confidence" integer NOT NULL,
	"reasoning" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idea_item_id" uuid,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"outcome_reason" text
);
--> statement-breakpoint
CREATE TABLE "view_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "view_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"production_item_id" uuid NOT NULL,
	"views" integer NOT NULL,
	"likes" integer,
	"comments" integer,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"post_age_minutes" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_items" ADD COLUMN "cross_post_confidence" integer;--> statement-breakpoint
ALTER TABLE "cross_post_decisions" ADD CONSTRAINT "cross_post_decisions_source_item_id_production_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_post_decisions" ADD CONSTRAINT "cross_post_decisions_target_account_id_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_post_decisions" ADD CONSTRAINT "cross_post_decisions_idea_item_id_production_items_id_fk" FOREIGN KEY ("idea_item_id") REFERENCES "public"."production_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_snapshots" ADD CONSTRAINT "view_snapshots_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cross_post_decisions_source" ON "cross_post_decisions" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "idx_cross_post_decisions_target" ON "cross_post_decisions" USING btree ("target_account_id");--> statement-breakpoint
CREATE INDEX "idx_cross_post_decisions_idea" ON "cross_post_decisions" USING btree ("idea_item_id");--> statement-breakpoint
CREATE INDEX "idx_cross_post_decisions_proposed" ON "cross_post_decisions" USING btree ("proposed_at");--> statement-breakpoint
CREATE INDEX "idx_view_snapshots_item_taken" ON "view_snapshots" USING btree ("production_item_id","taken_at");--> statement-breakpoint
CREATE INDEX "idx_view_snapshots_item_age" ON "view_snapshots" USING btree ("production_item_id","post_age_minutes");