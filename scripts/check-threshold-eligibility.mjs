import postgres from 'postgres';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'off' ? false : 'require',
});

// Check all Podcast Episode items that should now trigger repurpose tasks
const items = await sql`
  SELECT 
    id,
    title,
    status,
    views,
    published_date
  FROM production_items
  WHERE brand = 'matg' 
    AND format = 'Podcast Episode'
    AND status = 'Published'
    AND views IS NOT NULL
    AND views > 0
  ORDER BY views DESC
`;

console.log("\n📊 Published Podcast Episodes with views (threshold eligibility):");
console.log("─".repeat(100));

let eligible5k = 0;
let eligible10k = 0;
let eligible100k = 0;

items.forEach(item => {
  const views = item.views || 0;
  let triggers = [];
  
  if (views >= 5000) {
    eligible5k++;
    triggers.push("Podcast Clip With Hook");
  }
  if (views >= 10000) {
    eligible10k++;
    triggers.push("Full Podcast On LinkedIn");
  }
  if (views >= 100000) {
    eligible100k++;
    triggers.push("Produced Clip");
  }
  
  if (triggers.length > 0) {
    const triggersStr = triggers.join(", ");
    console.log(`✅ ${views.toLocaleString().padEnd(10)} views → ${triggersStr}`);
    console.log(`   "${item.title?.substring(0, 70)}"`);
  }
});

console.log("\n📈 Summary:");
console.log(`  • Total published with views: ${items.length}`);
console.log(`  • Eligible for 'Podcast Clip With Hook' (5K+): ${eligible5k}`);
console.log(`  • Eligible for 'Full Podcast On LinkedIn' (10K+): ${eligible10k}`);
console.log(`  • Eligible for 'Produced Clip' (100K+): ${eligible100k}`);

console.log("\n🎯 Expected repurpose tasks to be created:");
const totalTasks = eligible5k + eligible10k + eligible100k;
console.log(`  • Total new tasks: ${totalTasks}`);

await sql.end();
