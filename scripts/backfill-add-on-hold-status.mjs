/**
 * Idempotent backfill: insert "On Hold" status for each brand that doesn't
 * already have one, positioned right after "Ready To Publish".
 *
 * For brands that have "Ready To Publish", "On Hold" is inserted at
 * readyToPublish.position + 1 and every row at that position or higher is
 * shifted up by 1 first.
 *
 * For brands that don't have "Ready To Publish", "On Hold" is appended at
 * the end.
 *
 * Safe to re-run.
 *
 * Run (local): node --env-file=.env.local scripts/backfill-add-on-hold-status.mjs
 * Run (prod):  heroku run --app=hubandspoke node scripts/backfill-add-on-hold-status.mjs
 */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

async function main() {
  const brands = await sql`SELECT id, slug FROM brands ORDER BY slug`;
  console.log(`Found ${brands.length} brand(s).`);

  for (const brand of brands) {
    const existing = await sql`
      SELECT name FROM brand_statuses
      WHERE brand_id = ${brand.id} AND name = 'On Hold'
    `;
    if (existing.length > 0) {
      console.log(`  ${brand.slug}: already has "On Hold", skipping`);
      continue;
    }

    const rtp = await sql`
      SELECT position FROM brand_statuses
      WHERE brand_id = ${brand.id} AND name = 'Ready To Publish'
    `;

    let insertPosition;
    if (rtp.length > 0) {
      insertPosition = rtp[0].position + 1;
      // Shift everything at insertPosition or higher up by 1
      await sql`
        UPDATE brand_statuses
        SET position = position + 1, updated_at = NOW()
        WHERE brand_id = ${brand.id} AND position >= ${insertPosition}
      `;
    } else {
      const [{ max }] = await sql`
        SELECT COALESCE(MAX(position), -1) AS max FROM brand_statuses
        WHERE brand_id = ${brand.id}
      `;
      insertPosition = max + 1;
    }

    await sql`
      INSERT INTO brand_statuses (brand_id, name, color, position, is_pipeline_column, is_protected)
      VALUES (${brand.id}, 'On Hold', 'slate', ${insertPosition}, true, false)
    `;
    console.log(`  ${brand.slug}: inserted "On Hold" at position ${insertPosition}`);
  }

  console.log("\nDone.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
