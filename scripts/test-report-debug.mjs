import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

async function debugReport() {
  console.log('Debugging getContentReport logic...\n');

  // Simulate the exact query from getContentReport
  const startDate = '2026-01-23';
  const endDate = '2026-04-23';

  console.log(`Query conditions:`);
  console.log(`  brand = 'starter-story'`);
  console.log(`  published_date IS NOT NULL`);
  console.log(`  status = 'Published'`);
  console.log(`  published_date >= '${startDate}'`);
  console.log(`  published_date <= '${endDate}'`);
  console.log(`  platform IS NOT NULL`);
  console.log(`  All filters: all (no platform/format/post_type filter)\n`);

  const rows = await sql`
    SELECT
      pi.id,
      pi.title,
      pi.account_id,
      a.id as account_id_join,
      a.platform,
      a.handle,
      a.display_name,
      pi.published_date
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.brand = 'starter-story'
      AND pi.published_date IS NOT NULL
      AND pi.status = 'Published'
      AND pi.published_date >= ${startDate}
      AND pi.published_date <= ${endDate}
      AND pi.platform IS NOT NULL
    ORDER BY a.handle, pi.title
    LIMIT 30
  `;

  console.log(`Query returned ${rows.length} rows\n`);

  // Simulate the aggregation
  const primaryRowMetaByKey = new Map();
  let skipped = 0;

  for (const r of rows) {
    if (!r.account_id_join || !r.handle || !r.platform) {
      console.log(`SKIP: ${r.title.substring(0, 40)} - account_id_join: ${r.account_id_join}, handle: ${r.handle}, platform: ${r.platform}`);
      skipped++;
      continue;
    }

    const key = `${r.platform}|${r.handle}|`;
    if (!primaryRowMetaByKey.has(key)) {
      primaryRowMetaByKey.set(key, {
        label: `@${r.handle}`,
        platform: r.platform,
        handle: r.handle,
      });
    }
  }

  console.log(`\nProcessed ${rows.length - skipped} rows, skipped ${skipped}`);
  console.log(`\nUnique accounts found:`);
  primaryRowMetaByKey.forEach((meta, key) => {
    console.log(`  - ${meta.label} (${meta.platform})`);
  });

  // Now count all published items by account
  console.log('\n\nTotal published items by X account:');
  const allItems = await sql`
    SELECT
      a.handle,
      COUNT(*) as count,
      pi.platform
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.brand = 'starter-story'
      AND pi.status = 'Published'
      AND pi.published_date IS NOT NULL
      AND pi.platform IS NOT NULL
      AND a.platform = 'x'
    GROUP BY a.handle, pi.platform
    ORDER BY count DESC
  `;

  allItems.forEach(row => {
    console.log(`  ${row.handle}: ${row.count} items`);
  });

  await sql.end();
}

debugReport().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
