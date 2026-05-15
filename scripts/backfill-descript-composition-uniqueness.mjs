/**
 * Fix every pillar+derivative pair that share the same
 * `production_items.descript_composition_id`. Caused by the pre-fix
 * `descript-clip-resolve` task, which on cold full-video import wrote the
 * new composition_id to BOTH the derivative (correct) AND the pillar
 * (incorrect — should have been the pillar's seed_composition_id).
 *
 * For each duplicate composition_id:
 *   - find the pillar (`source_type='original'`) carrying it
 *   - find every other row carrying it (almost always 1 derivative)
 *   - on the pillar: move `descript_composition_id` → `descript_seed_composition_id`
 *     and null `descript_composition_id`
 *   - leave the derivative(s) untouched
 *
 * Idempotent: re-runs see zero rows because the WHERE clause requires a
 * row that's still duplicating. Safe to run multiple times.
 *
 * Defaults to dry-run.
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-descript-composition-uniqueness.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-descript-composition-uniqueness.mjs --apply
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

async function main() {
  const duplicates = await sql`
    SELECT
      descript_composition_id,
      ARRAY_AGG(id ORDER BY (source_type = 'original') DESC) AS row_ids,
      ARRAY_AGG(source_type ORDER BY (source_type = 'original') DESC) AS source_types,
      ARRAY_AGG(title ORDER BY (source_type = 'original') DESC) AS titles
    FROM production_items
    WHERE descript_composition_id IS NOT NULL
    GROUP BY descript_composition_id
    HAVING COUNT(*) > 1
    ORDER BY descript_composition_id
  `;

  console.log(`Found ${duplicates.length} duplicate composition_id group(s).\n`);
  if (duplicates.length === 0) {
    console.log("Nothing to do.");
    await sql.end();
    return;
  }

  let pillarsUpdated = 0;
  let skipped = 0;

  for (const dup of duplicates) {
    const { descript_composition_id, row_ids, source_types, titles } = dup;
    const pillarId =
      source_types[0] === "original" ? row_ids[0] : null;
    const pillarTitle = source_types[0] === "original" ? titles[0] : null;

    if (!pillarId) {
      // Pair without a 'original' source_type — surface but don't touch.
      // These are anomalies (two repurposed items sharing a composition)
      // that need manual investigation, not blanket fixing.
      console.log(
        `! composition=${descript_composition_id} has no original/pillar row; rows=${row_ids.join(",")} types=${source_types.join(",")}. SKIPPING.`,
      );
      skipped++;
      continue;
    }

    console.log(
      `composition=${descript_composition_id}\n  pillar=${pillarId} (${pillarTitle ?? "untitled"})\n  derivatives=${row_ids.slice(1).join(",")}`,
    );

    if (dryRun) {
      console.log(
        `  DRY-RUN: would set pillar.descript_seed_composition_id=${descript_composition_id}, pillar.descript_composition_id=NULL\n`,
      );
    } else {
      await sql`
        UPDATE production_items
        SET
          descript_seed_composition_id = descript_composition_id,
          descript_composition_id = NULL,
          updated_at = now()
        WHERE id = ${pillarId}
      `;
      pillarsUpdated++;
      console.log(`  ✓ pillar updated\n`);
    }
  }

  console.log(
    `\nDone. ${dryRun ? "Would update" : "Updated"} ${pillarsUpdated || (dryRun ? duplicates.length - skipped : 0)} pillar(s); skipped ${skipped}.`,
  );

  if (!dryRun) {
    // Post-condition sanity check.
    const remaining = await sql`
      SELECT descript_composition_id, COUNT(*) AS n
      FROM production_items
      WHERE descript_composition_id IS NOT NULL
      GROUP BY descript_composition_id
      HAVING COUNT(*) > 1
    `;
    if (remaining.length === 0) {
      console.log("✓ No duplicate composition_ids remain.");
    } else {
      console.error(
        `✗ ${remaining.length} duplicate group(s) still remain — unique index would FAIL. Investigate.`,
      );
      for (const r of remaining) {
        console.error(`  composition=${r.descript_composition_id} count=${r.n}`);
      }
      process.exitCode = 1;
    }
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
