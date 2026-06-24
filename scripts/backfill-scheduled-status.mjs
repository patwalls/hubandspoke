/**
 * Idempotent backfill: ensure every brand has a "Scheduled" status row.
 *
 * The schedule-reconcile feature promotes "Scheduled" from a write-only
 * placeholder into a real lifecycle stage. Brands seeded before this change
 * already have a full status palette (so the broader
 * backfill-brand-statuses.mjs skips them), but none of them carry a
 * "Scheduled" row — without it, items at status='Scheduled' render with no
 * colored chip. This script inserts a protected "Scheduled" row positioned
 * just before "Published" (shifting Published/Killed down by one) for any
 * brand that lacks it.
 *
 * Safe to re-run — brands that already have "Scheduled" are skipped.
 *
 * Run (local): node --env-file=.env.local scripts/backfill-scheduled-status.mjs
 * Run (prod):  heroku run --app=hubandspoke node scripts/backfill-scheduled-status.mjs
 */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

async function main() {
  const brands = await sql`SELECT id, slug FROM brands ORDER BY slug`;
  console.log(`Found ${brands.length} brand(s).`);

  let inserted = 0;
  let skipped = 0;
  for (const brand of brands) {
    const existing = await sql`
      SELECT 1 FROM brand_statuses
      WHERE brand_id = ${brand.id} AND lower(name) = 'scheduled'
      LIMIT 1
    `;
    if (existing.length > 0) {
      console.log(`  ${brand.slug}: skip (already has Scheduled)`);
      skipped++;
      continue;
    }

    // Find the position of "Published" so we can slot "Scheduled" right
    // before it. Fall back to end-of-list if Published is somehow absent.
    const [published] = await sql`
      SELECT position FROM brand_statuses
      WHERE brand_id = ${brand.id} AND name = 'Published'
      LIMIT 1
    `;

    await sql.begin(async (tx) => {
      let insertPos;
      if (published) {
        insertPos = published.position;
        // Shift Published (and everything after it) down by one to make room.
        await tx`
          UPDATE brand_statuses
          SET position = position + 1, updated_at = NOW()
          WHERE brand_id = ${brand.id} AND position >= ${insertPos}
        `;
      } else {
        const [{ max }] = await tx`
          SELECT COALESCE(MAX(position), -1)::int AS max
          FROM brand_statuses WHERE brand_id = ${brand.id}
        `;
        insertPos = max + 1;
      }
      await tx`
        INSERT INTO brand_statuses (brand_id, name, color, position, is_pipeline_column, is_protected)
        VALUES (${brand.id}, 'Scheduled', 'blue', ${insertPos}, false, true)
      `;
    });
    console.log(`  ${brand.slug}: inserted Scheduled`);
    inserted++;
  }

  console.log(`\nDone: inserted ${inserted} brand(s); skipped ${skipped}.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
