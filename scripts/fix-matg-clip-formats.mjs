#!/usr/bin/env node

/**
 * Fix MATG clips that were created with the wrong format.
 * Updates all MATG production items with format "Repackage section with hook"
 * to use "Podcast Clip With Hook" instead.
 *
 * Run with: node --env-file=.env.local scripts/fix-matg-clip-formats.mjs
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: process.env.DATABASE_SSL !== "off" ? { rejectUnauthorized: false } : false,
});

async function main() {
  try {
    console.log("Starting MATG clip format migration...");

    // Count before - MATG items using the wrong Starter Story format
    const before = await sql`
      SELECT COUNT(*) as count FROM production_items
      WHERE brand = 'matg' AND format = 'Reel: Repackage Section w/ Hook'
    `;
    console.log(`Found ${before[0].count} MATG items with wrong format (Starter Story format)`);

    if (before[0].count === 0) {
      console.log("No items to migrate. Exiting.");
      await sql.end();
      return;
    }

    // Update the format to the correct MATG format
    const result = await sql`
      UPDATE production_items
      SET format = 'Podcast Clip With Hook'
      WHERE brand = 'matg' AND format = 'Reel: Repackage Section w/ Hook'
    `;

    console.log(`Updated ${result.count} items`);

    // Verify
    const after = await sql`
      SELECT COUNT(*) as count FROM production_items
      WHERE brand = 'matg' AND format = 'Reel: Repackage Section w/ Hook'
    `;

    if (after[0].count === 0) {
      console.log("✅ Migration complete! All MATG clips now use 'Podcast Clip With Hook'");
    } else {
      console.log(
        `⚠️  Warning: ${after[0].count} items still have the old format`
      );
    }

    // Show the new state. Post-consolidation (2026-05-11) clips live under
    // sourceType='repurposed' and are identified by a non-null
    // source_clip_idea_id.
    const newState = await sql`
      SELECT format, COUNT(*) as count FROM production_items
      WHERE brand = 'matg' AND source_clip_idea_id IS NOT NULL
      GROUP BY format
      ORDER BY count DESC
    `;

    console.log("\nMAT G clip formats after migration:");
    for (const row of newState) {
      console.log(`  ${row.format}: ${row.count} items`);
    }
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
