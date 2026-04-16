/**
 * One-time backfill: estimate views for existing production items
 * that have likes but no views, for platforms that use estimation.
 *
 * Run: node scripts/backfill-estimated-views.mjs
 */
import postgres from 'postgres';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PLATFORM_MULTIPLIERS = {
  "LinkedIn": 163,
  "Threads": 150,
  "YouTube Community": 194,
  "Instagram Post": 137,
};

const sql = postgres(process.env.DATABASE_URL);

// Get all published items with likes but no views
const items = await sql`
  SELECT id, title, platform, likes, views
  FROM production_items
  WHERE status = 'Published'
    AND likes IS NOT NULL
    AND likes > 0
    AND views IS NULL
`;

console.log(`Found ${items.length} items with likes but no views`);

const counts = {};
let updated = 0;

for (const item of items) {
  const platforms = item.platform || [];
  let estimatedViews = null;
  let matchedPlatform = null;

  for (const p of platforms) {
    if (PLATFORM_MULTIPLIERS[p]) {
      estimatedViews = Math.round(item.likes * PLATFORM_MULTIPLIERS[p]);
      matchedPlatform = p;
      break;
    }
  }

  if (!estimatedViews || !matchedPlatform) continue;

  await sql`
    UPDATE production_items
    SET views = ${estimatedViews},
        views_estimated = true,
        updated_at = NOW()
    WHERE id = ${item.id}
  `;

  counts[matchedPlatform] = (counts[matchedPlatform] || 0) + 1;
  updated++;

  console.log(`  ✓ ${item.title?.slice(0, 50)} → ~${estimatedViews.toLocaleString()} views (${matchedPlatform} ${item.likes} likes × ${PLATFORM_MULTIPLIERS[matchedPlatform]})`);
}

console.log(`\nDone. Updated ${updated} items.`);
console.log('By platform:', counts);

await sql.end();
