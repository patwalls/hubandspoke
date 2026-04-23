import postgres from 'postgres';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'off' ? false : 'require',
});

// Check what formats exist in MATG
const formats = await sql`
  SELECT DISTINCT format, COUNT(*) as count
  FROM production_items
  WHERE brand = 'matg'
  GROUP BY format
  ORDER BY count DESC
`;

console.log("\n📊 Format distribution in MATG brand:");
console.log("─".repeat(60));
formats.forEach(f => {
  console.log(`  ${(f.format || '(null)').padEnd(40)} : ${f.count} items`);
});

// Also check formats table
console.log("\n📋 Formats in the database for MATG:");
console.log("─".repeat(60));
const dbFormats = await sql`
  SELECT name, brand FROM formats
  WHERE brand = 'matg'
  ORDER BY name
`;

dbFormats.forEach(f => {
  console.log(`  • ${f.name}`);
});

await sql.end();
