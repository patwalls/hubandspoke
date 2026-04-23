import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

async function fix() {
  console.log('Setting post_type for repurposed items based on format_channels...\n');

  // For each repurposed item with an assigned account, look up the post_type from format_channels
  const repurposed = await sql`
    SELECT
      pi.id,
      pi.title,
      pi.account_id,
      fc.post_type
    FROM production_items pi
    LEFT JOIN accounts a ON pi.account_id = a.id
    LEFT JOIN format_channels fc ON fc.account_id = pi.account_id
    WHERE pi.source_type = 'repurposed' AND pi.account_id IS NOT NULL
  `;

  console.log(`Found ${repurposed.length} repurposed items with accounts\n`);

  let updated = 0;
  for (const item of repurposed) {
    if (item.post_type && !item.post_type.includes('youtube') && !item.post_type.includes('linkedin')) {
      // Item already has post_type set
      continue;
    }

    if (item.post_type) {
      // Update if post_type exists
      await sql`
        UPDATE production_items
        SET post_type = ${item.post_type}, updated_at = now()
        WHERE id = ${item.id}
      `;
      updated++;
      console.log(`✓ ${item.title.substring(0, 60)}`);
      console.log(`  → post_type: ${item.post_type}`);
    }
  }

  console.log(`\n✓ Updated ${updated} repurposed items with post_type`);

  // Verify
  console.log('\nSample of updated items:');
  const samples = await sql`
    SELECT
      pi.title,
      pi.post_type,
      a.handle,
      a.platform
    FROM production_items pi
    LEFT JOIN accounts a ON pi.account_id = a.id
    WHERE pi.source_type = 'repurposed'
    LIMIT 5
  `;

  for (const item of samples) {
    console.log(`  ${item.handle} (${item.post_type})`);
  }

  await sql.end();
}

fix().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
