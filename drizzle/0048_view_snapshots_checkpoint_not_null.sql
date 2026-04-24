DROP INDEX "uniq_view_snapshots_item_checkpoint";--> statement-breakpoint
ALTER TABLE "view_snapshots" ALTER COLUMN "checkpoint_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_view_snapshots_item_checkpoint" ON "view_snapshots" USING btree ("production_item_id","checkpoint_key");