#!/usr/bin/env node
/**
 * Backfill: Update orphaned "Business Interview" format references to "Podcast Episode"
 *
 * This script updates all production items in the MATG brand that reference the
 * deprecated "Business Interview" format to use "Podcast Episode" instead.
 *
 * Run: node scripts/backfill-business-interview-format.mjs
 */
import postgres from 'postgres';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'off' ? false : 'require',
});

async function backfillFormat() {
  try {
    console.log("🔄 Starting backfill: Business Interview → Podcast Episode");

    // Find all items with the old format
    const items = await sql`
      SELECT id, title, format FROM production_items
      WHERE brand = 'matg' AND format = 'Business Interview'
    `;

    console.log(`   Found ${items.length} items to update`);

    if (items.length === 0) {
      console.log("✅ No items to update!");
      await sql.end();
      return;
    }

    // Update the format
    const result = await sql`
      UPDATE production_items
      SET format = 'Podcast Episode'
      WHERE brand = 'matg' AND format = 'Business Interview'
    `;

    console.log(`✅ Updated ${items.length} items`);

    // Verify the update
    const remaining = await sql`
      SELECT COUNT(*) as count FROM production_items
      WHERE brand = 'matg' AND format = 'Business Interview'
    `;

    if (remaining[0].count === 0) {
      console.log("✅ Verification passed: all items updated successfully");
    } else {
      console.warn(`⚠️  Warning: ${remaining[0].count} items still have old format`);
    }

    // Show some examples of updated items
    console.log("\n📋 Sample updated items:");
    items.slice(0, 3).forEach((item) => {
      console.log(`   - "${item.title}" → Podcast Episode`);
    });

    await sql.end();
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

backfillFormat();
