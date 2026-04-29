/**
 * One-time backfill: seed brand_statuses for existing brands.
 *
 * Idempotent — for each brand:
 *   - If the brand already has any rows in brand_statuses, skip it.
 *   - For "starter-story", seed the full legacy set (everything currently
 *     in src/lib/badge-colors.ts STATUS_COLORS) so existing
 *     production_items.status text keeps its colored chip.
 *   - For every other brand, seed the default 7-status set (matches what
 *     POST /api/brands now does for newly-created brands).
 *
 * Run (local): node --env-file=.env.local scripts/backfill-brand-statuses.mjs
 * Run (prod):  heroku run --app=hubandspoke node scripts/backfill-brand-statuses.mjs
 */
import postgres from "postgres";

const STARTER_STORY_LEGACY = [
  { name: "Idea", color: "zinc" },
  { name: "To Assign", color: "zinc" },
  { name: "Pre-Production", color: "pink" },
  { name: "Scoping Call", color: "zinc" },
  { name: "Scoping Call Done", color: "blue" },
  { name: "Outreach", color: "emerald" },
  { name: "Yes BUT Later", color: "green" },
  { name: "Scheduled Shoot", color: "zinc" },
  { name: "Searching/Planning", color: "sky" },
  { name: "Assigned", color: "pink", isPipelineColumn: true },
  { name: "Editing (V1)", color: "amber" },
  { name: "Graphics (V2)", color: "zinc" },
  { name: "Review", color: "yellow", isPipelineColumn: true },
  { name: "Final Review", color: "orange", isPipelineColumn: true },
  { name: "Ready To Publish", color: "pink", isPipelineColumn: true },
  { name: "Published", color: "pink", isProtected: true },
  { name: "Killed", color: "zinc", isProtected: true },
];

const DEFAULT_SET = [
  { name: "Idea", color: "zinc" },
  { name: "Assigned", color: "pink", isPipelineColumn: true },
  { name: "Review", color: "yellow", isPipelineColumn: true },
  { name: "Final Review", color: "orange", isPipelineColumn: true },
  { name: "Ready To Publish", color: "pink", isPipelineColumn: true },
  { name: "Published", color: "pink", isProtected: true },
  { name: "Killed", color: "zinc", isProtected: true },
];

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

async function main() {
  const brands = await sql`SELECT id, slug, label FROM brands ORDER BY slug`;
  console.log(`Found ${brands.length} brand(s).`);

  let seeded = 0;
  let skipped = 0;
  for (const brand of brands) {
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM brand_statuses WHERE brand_id = ${brand.id}
    `;
    if (count > 0) {
      console.log(`  ${brand.slug}: skip (already has ${count} status row(s))`);
      skipped++;
      continue;
    }
    const seed = brand.slug === "starter-story" ? STARTER_STORY_LEGACY : DEFAULT_SET;
    const rows = seed.map((s, idx) => ({
      brand_id: brand.id,
      name: s.name,
      color: s.color,
      position: idx,
      is_pipeline_column: s.isPipelineColumn ?? false,
      is_protected: s.isProtected ?? false,
    }));
    await sql`
      INSERT INTO brand_statuses ${sql(rows, "brand_id", "name", "color", "position", "is_pipeline_column", "is_protected")}
    `;
    console.log(`  ${brand.slug}: seeded ${rows.length} statuses`);
    seeded++;
  }

  console.log(`\nDone. Seeded ${seeded} brand(s); skipped ${skipped}.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
