import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

async function testAggregation() {
  console.log('Detailed aggregation trace...\n');

  // Fetch rows exactly as getContentReport does
  const rows = await sql`
    SELECT
      pi.id,
      pi.title,
      pi.account_id,
      a.id as account_id_join,
      a.platform,
      a.handle,
      a.avatar_url,
      pi.post_type
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.brand = 'starter-story'
      AND pi.published_date IS NOT NULL
      AND pi.status = 'Published'
      AND pi.published_date >= '2026-01-23'
      AND pi.published_date <= '2026-04-23'
      AND pi.platform IS NOT NULL
  `;

  console.log(`Total rows from query: ${rows.length}\n`);

  // Simulate the aggregation loop
  const primaryRowMetaByKey = new Map();
  const itemToRowKey = new Map();

  console.log('Processing rows...\n');

  let processedCount = 0;
  let skippedCount = 0;

  for (const r of rows) {
    // This is the exact check from the code
    if (!r.account_id_join || !r.handle || !r.platform) {
      skippedCount++;
      continue;
    }

    const pt = r.post_type ?? null;
    const key = `${r.platform}|${r.handle}|${pt ?? ""}`;

    itemToRowKey.set(r.id, key);

    if (!primaryRowMetaByKey.has(key)) {
      const label = `@${r.handle}`;
      primaryRowMetaByKey.set(key, {
        label,
        platform: r.platform,
        handle: r.handle,
        postType: pt,
      });
      console.log(`  FIRST TIME SEEN: ${key} → ${label}`);
    }

    processedCount++;
  }

  console.log(`\nProcessing complete:`);
  console.log(`  Processed: ${processedCount} rows`);
  console.log(`  Skipped (missing account info): ${skippedCount} rows`);

  console.log(`\nUnique row keys in primaryRowMetaByKey (${primaryRowMetaByKey.size}):`);
  Array.from(primaryRowMetaByKey.entries()).forEach(([key, meta]) => {
    console.log(`  ${key} → ${meta.label}`);
  });

  // Now check items for thepatwalls
  const thepat = 'e1bf53af-d59b-41f9-b741-69dad94ecef0';
  const thepat_items = rows.filter(r => r.account_id_join === thepat);
  console.log(`\nRows with thepatwalls account ID: ${thepat_items.length}`);
  if (thepat_items.length > 0) {
    console.log('First few:');
    thepat_items.slice(0, 3).forEach(r => {
      const key = `${r.platform}|${r.handle}|${r.post_type ?? ""}`;
      console.log(`  ${r.title.substring(0, 40)} → key: ${key}`);
    });
  }

  // Check if thepatwalls is in the final meta
  const thepat_keys = Array.from(primaryRowMetaByKey.keys()).filter(k => k.includes('thepatwalls'));
  console.log(`\nKeys containing 'thepatwalls': ${thepat_keys.length}`);
  thepat_keys.forEach(k => console.log(`  ${k}`));

  await sql.end();
}

testAggregation().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
