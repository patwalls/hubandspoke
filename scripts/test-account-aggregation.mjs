import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

async function testAccountAggregation() {
  console.log('Testing account aggregation logic...\n');

  // First, get all X accounts for starter-story
  const accounts = await sql`
    SELECT id, platform, handle, display_name
    FROM accounts
    WHERE platform = 'x' AND brand_id IN (SELECT id FROM brands WHERE slug = 'starter-story')
    ORDER BY handle
  `;

  console.log(`Found ${accounts.length} X accounts for Starter Story:`);
  accounts.forEach(a => console.log(`  - ${a.handle} (id: ${a.id})`));

  // Now simulate what getContentReport does - fetch items with accounts
  console.log('\nFetching production items with account info...');

  const rows = await sql`
    SELECT
      pi.id,
      pi.title,
      pi.account_id,
      a.id as account_id_from_join,
      a.handle,
      a.platform,
      pi.published_date,
      pi.status
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.brand = 'starter-story'
      AND pi.status = 'Published'
      AND pi.published_date IS NOT NULL
      AND a.platform = 'x'
    ORDER BY a.handle, pi.title
    LIMIT 20
  `;

  console.log(`\nFetched ${rows.length} rows with X account data`);

  // Simulate the aggregation logic from getContentReport
  const primaryRowMetaByKey = new Map();

  for (const r of rows) {
    if (!r.account_id_from_join || !r.handle || !r.platform) {
      console.log(`Skipping row (missing account info): ${r.title}`);
      continue;
    }

    const pt = null; // postType would be here
    const key = `${r.platform}|${r.handle}|${pt ?? ""}`;

    if (!primaryRowMetaByKey.has(key)) {
      console.log(`Adding to primaryRowMeta: key="${key}" label="@${r.handle}"`);
      primaryRowMetaByKey.set(key, {
        label: `@${r.handle}`,
        platform: r.platform,
        handle: r.handle,
        postType: pt,
      });
    }
  }

  console.log(`\nFinal primaryRowMeta entries: ${primaryRowMetaByKey.size}`);
  primaryRowMetaByKey.forEach((meta, key) => {
    console.log(`  - ${key}: ${meta.label}`);
  });

  // Now let's count items by account to see the full picture
  console.log('\n\nCounting all published X items by account:');
  const counts = await sql`
    SELECT
      a.handle,
      COUNT(*) as item_count
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.brand = 'starter-story'
      AND pi.status = 'Published'
      AND pi.published_date IS NOT NULL
      AND a.platform = 'x'
    GROUP BY a.handle
    ORDER BY item_count DESC
  `;

  counts.forEach(c => {
    console.log(`  ${c.handle}: ${c.item_count} items`);
  });

  // Check items WITHOUT an account
  console.log('\n\nChecking items without accountId:');
  const orphaned = await sql`
    SELECT COUNT(*) as count
    FROM production_items pi
    WHERE pi.brand = 'starter-story'
      AND pi.status = 'Published'
      AND pi.published_date IS NOT NULL
      AND pi.account_id IS NULL
  `;
  console.log(`Items without accountId: ${orphaned[0].count}`);

  await sql.end();
}

testAccountAggregation().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
