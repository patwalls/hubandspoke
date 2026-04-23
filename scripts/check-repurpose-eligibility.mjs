import postgres from 'postgres';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'off' ? false : 'require',
});

// Check the 81 items we just converted
const items = await sql`
  SELECT 
    id,
    title,
    format,
    status,
    views,
    published_date,
    pillar_content_item_id
  FROM production_items
  WHERE brand = 'matg' 
    AND format = 'Podcast Episode'
    AND created_at > (NOW() - INTERVAL '7 days')
  ORDER BY views DESC
  LIMIT 100
`;

console.log("\n📊 Recently converted 'Podcast Episode' items (eligibility check):");
console.log("─".repeat(80));

let publishedCount = 0;
let withViews = 0;
let withPillar = 0;

items.forEach(item => {
  const isPublished = item.status === 'Published';
  const hasViews = item.views && item.views > 0;
  const hasPillar = item.pillar_content_item_id !== null;
  
  if (isPublished) publishedCount++;
  if (hasViews) withViews++;
  if (hasPillar) withPillar++;
  
  const statusEmoji = isPublished ? '✅' : '⏳';
  const viewsStr = item.views ? `${item.views.toLocaleString()} views` : 'no views';
  
  console.log(`${statusEmoji} ${item.title?.substring(0, 50)} (${viewsStr})`);
});

console.log("\n📈 Summary:");
console.log(`  • Total items checked: ${items.length}`);
console.log(`  • Published: ${publishedCount}`);
console.log(`  • With views: ${withViews}`);
console.log(`  • With pillar content: ${withPillar}`);

// Check if there are repurpose targets for Podcast Episode
const format = await sql`
  SELECT id, name FROM formats
  WHERE name = 'Podcast Episode' AND brand = 'matg'
`;

if (format.length > 0) {
  const targets = await sql`
    SELECT id, name FROM formats
    WHERE parent_format_id = ${format[0].id}
  `;
  
  console.log(`\n🎯 Repurpose targets for 'Podcast Episode':`);
  if (targets.length > 0) {
    targets.forEach(t => {
      console.log(`  • ${t.name}`);
    });
  } else {
    console.log(`  (no child formats configured)`);
  }
}

await sql.end();
