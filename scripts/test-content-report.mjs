import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

// Simplified version of getContentReport to test X account aggregation
async function testContentReport() {
  const brand = 'starter-story';

  console.log('Testing X account aggregation in content report...\n');

  // Get all accounts for brand
  const accounts = await sql`
    SELECT id, platform, handle
    FROM accounts
    WHERE platform = 'x' AND brand_id IN (SELECT id FROM brands WHERE slug = ${brand})
    ORDER BY handle
  `;

  console.log('Available X accounts:', accounts.map(a => `@${a.handle}`).join(', '));
  console.log('');

  // Simulate the report data aggregation
  const { productionItems, brands } = await import('../src/lib/db/schema.ts').catch(() => ({}));

  // Just do a raw SQL query to see what items we get
  console.log('Sample of published items on X accounts:');
  const items = await sql`
    SELECT
      pi.id,
      pi.title,
      pi.account_id,
      a.handle,
      pi.views
    FROM production_items pi
    LEFT JOIN accounts a ON pi.account_id = a.id
    WHERE pi.brand = ${brand}
      AND pi.status = 'Published'
      AND a.platform = 'x'
    ORDER BY a.handle, pi.title
    LIMIT 10
  `;

  for (const item of items) {
    console.log(`${item.handle}: ${item.title.substring(0, 40)} (${item.views} views)`);
  }

  await sql.end();
}

testContentReport().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
