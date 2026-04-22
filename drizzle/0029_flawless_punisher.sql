CREATE TABLE "cross_post_fit_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"target_platform" text NOT NULL,
	"is_good_fit" boolean NOT NULL,
	"reasoning" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cross_post_fit_verdicts" ADD CONSTRAINT "cross_post_fit_verdicts_source_item_id_production_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_cross_post_fit_verdicts_source_target" ON "cross_post_fit_verdicts" USING btree ("source_item_id","target_platform");