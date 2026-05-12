-- Roll Descript packs into format Skill (formats.instructions) and drop the
-- now-obsolete descript_packs table. Data-preservation is baked into the SQL
-- so the release-phase migration can't accidentally lose pack prompts before
-- the operator runs the consolidation script.
UPDATE "formats" f
SET "instructions" = CASE
    WHEN f.instructions IS NULL OR length(trim(f.instructions)) = 0
      THEN dp.prompt
    WHEN position(dp.prompt IN f.instructions) > 0
      THEN f.instructions
    ELSE f.instructions || E'\n\n---\n\n' || dp.prompt
  END,
  "updated_at" = NOW()
FROM "descript_packs" dp
WHERE f.descript_pack_id = dp.id
  AND dp.prompt IS NOT NULL
  AND length(trim(dp.prompt)) > 0;
--> statement-breakpoint
ALTER TABLE "descript_packs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "descript_packs" CASCADE;--> statement-breakpoint
ALTER TABLE "formats" DROP CONSTRAINT IF EXISTS "formats_descript_pack_id_descript_packs_id_fk";
--> statement-breakpoint
ALTER TABLE "formats" DROP COLUMN IF EXISTS "descript_pack_id";
