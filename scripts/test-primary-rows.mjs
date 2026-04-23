import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

async function testPrimaryRows() {
  console.log('Testing primary rows generation...\n');

  // Fetch rows
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

  // Build primaryRowMetaByKey
  const primaryRowMetaByKey = new Map();
  const itemToRowKey = new Map();

  for (const r of rows) {
    if (!r.account_id_join || !r.handle || !r.platform) continue;

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
    }
  }

  // Test with platformKey = 'all' and format = 'all' (default dashboard state)
  const platform = 'all';
  const format = 'all';
  const showingFormats = platform !== 'all' && format === 'all';

  console.log(`Conditions: platform='${platform}', format='${format}'`);
  console.log(`showingFormats: ${showingFormats}\n`);

  // Build primaryRowMetaList
  const primaryRowMetaList = Array.from(primaryRowMetaByKey.values()).sort(
    (a, b) => a.label.localeCompare(b.label)
  );

  let primaryRows;
  if (showingFormats) {
    console.log('Would show formats (showingFormats=true)');
    primaryRows = []; // would be format list
  } else {
    primaryRows = primaryRowMetaList.map((m) => m.label);
  }

  console.log(`primaryRowMetaList (${primaryRowMetaList.length} entries):`);
  primaryRowMetaList.forEach(m => {
    console.log(`  ${m.label}`);
  });

  console.log(`\nprimaryRows for metric initialization (${primaryRows.length} rows):`);
  primaryRows.forEach(r => {
    console.log(`  ${r}`);
  });

  // Check specifically for thepatwalls
  const hasThepatwalls = primaryRows.some(r => r.includes('thepatwalls'));
  console.log(`\n✓ Contains @thepatwalls: ${hasThepatwalls}`);
  const thepatRows = primaryRows.filter(r => r.includes('thepatwalls'));
  if (thepatRows.length > 0) {
    console.log('  Found:', thepatRows);
  }

  await sql.end();
}

testPrimaryRows().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
