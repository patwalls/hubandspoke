/**
 * Idempotent backfill: seed brand_statuses for existing brands and keep the
 * is_protected flag in sync with PROTECTED_STATUS_NAMES.
 *
 * Two passes:
 *   1. Seed: for each brand with zero rows, insert the default set. For
 *      "starter-story" specifically, insert the full legacy palette so
 *      historic production_items.status text keeps its colored chip.
 *   2. Re-flag: UPDATE existing rows whose name is in PROTECTED — flips
 *      is_protected = true. Catches brands seeded under earlier rules that
 *      didn't lock Idea/Assigned (those statuses are auto-created by
 *      repost / cross-post / clip-out / triage-accept / threshold-monitor
 *      and renaming them would break those flows silently).
 *
 * Safe to re-run.
 *
 * Run (local): node --env-file=.env.local scripts/backfill-brand-statuses.mjs
 * Run (prod):  heroku run --app=hubandspoke node scripts/backfill-brand-statuses.mjs
 */
import postgres from "postgres";

// Mirrors PROTECTED_STATUS_NAMES in src/lib/db/brand-statuses.ts.
const PROTECTED = ["Idea", "Assigned", "Published", "Killed"];

const STARTER_STORY_LEGACY = [
  { name: "Idea", color: "zinc", isProtected: true },
  { name: "To Assign", color: "zinc" },
  { name: "Pre-Production", color: "pink" },
  { name: "Scoping Call", color: "zinc" },
  { name: "Scoping Call Done", color: "blue" },
  { name: "Outreach", color: "emerald" },
  { name: "Yes BUT Later", color: "green" },
  { name: "Scheduled Shoot", color: "zinc" },
  { name: "Searching/Planning", color: "sky" },
  { name: "Assigned", color: "pink", isPipelineColumn: true, isProtected: true },
  { name: "Editing (V1)", color: "amber" },
  { name: "Graphics (V2)", color: "zinc" },
  { name: "Review", color: "yellow", isPipelineColumn: true },
  { name: "Final Review", color: "orange", isPipelineColumn: true },
  { name: "Ready To Publish", color: "pink", isPipelineColumn: true },
  { name: "Published", color: "pink", isProtected: true },
  { name: "Killed", color: "zinc", isProtected: true },
];

const DEFAULT_SET = [
  { name: "Idea", color: "zinc", isProtected: true },
  { name: "Assigned", color: "pink", isPipelineColumn: true, isProtected: true },
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

  console.log(`\nSeed pass: seeded ${seeded} brand(s); skipped ${skipped}.`);

  // Pass 2: re-flag protected names. Catches rows from earlier seed runs
  // that didn't lock Idea / Assigned. Idempotent — flipping an already-true
  // flag is a no-op write.
  const flagged = await sql`
    UPDATE brand_statuses
    SET is_protected = true, updated_at = NOW()
    WHERE name IN ${sql(PROTECTED)} AND is_protected = false
    RETURNING (SELECT slug FROM brands WHERE id = brand_id) AS brand_slug, name
  `;
  if (flagged.length > 0) {
    console.log(`Re-flagged ${flagged.length} row(s) as protected:`);
    for (const r of flagged) console.log(`  ${r.brand_slug}.${r.name}`);
  } else {
    console.log("Re-flag pass: nothing to update.");
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
