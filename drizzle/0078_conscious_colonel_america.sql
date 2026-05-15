-- The pre-existing constraint was created before drizzle was adopted, so its
-- on-disk name is the legacy Rails-style `_fkey` suffix, not the drizzle
-- naming convention. Drop by the real name, re-add using drizzle's name so
-- future generations stay in sync with the snapshot.
ALTER TABLE "repurpose_triggers" DROP CONSTRAINT IF EXISTS "repurpose_triggers_production_item_id_fkey";
--> statement-breakpoint
ALTER TABLE "repurpose_triggers" DROP CONSTRAINT IF EXISTS "repurpose_triggers_production_item_id_production_items_id_fk";
--> statement-breakpoint
ALTER TABLE "repurpose_triggers" ADD CONSTRAINT "repurpose_triggers_production_item_id_production_items_id_fk" FOREIGN KEY ("production_item_id") REFERENCES "public"."production_items"("id") ON DELETE cascade ON UPDATE no action;
