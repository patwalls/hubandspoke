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
  console.log('Assigning correct accounts to repurposed items based on format_channels...\n');

  // Get all repurposed items
  const repurposed = await sql`
    SELECT
      pi.id,
      pi.format,
      f.id as format_id
    FROM production_items pi
    LEFT JOIN formats f ON f.name = pi.format AND f.brand = pi.brand
    WHERE pi.source_type = 'repurposed'
  `;

  console.log(`Found ${repurposed.length} repurposed items\n`);

  let updated = 0;
  for (const item of repurposed) {
    if (!item.format_id) {
      console.log(`⚠ ${item.format} - format not found`);
      continue;
    }

    // Look up the account for this format
    const [channel] = await sql`
      SELECT account_id
      FROM format_channels
      WHERE format_id = ${item.format_id}
      LIMIT 1
    `;

    if (channel) {
      // Get account details for display
      const [account] = await sql`
        SELECT handle, platform
        FROM accounts
        WHERE id = ${channel.account_id}
      `;

      await sql`
        UPDATE production_items
        SET account_id = ${channel.account_id}, updated_at = now()
        WHERE id = ${item.id}
      `;

      updated++;
      console.log(`✓ ${item.format} → @${account.handle} (${account.platform})`);
    } else {
      console.log(`- ${item.format} (no format channel configured)`);
    }
  }

  console.log(`\n✓ Updated ${updated} repurposed items with correct accounts`);

  // Verify
  console.log('\nFinal state of repurposed items:');
  const final = await sql`
    SELECT
      pi.format,
      COUNT(*) as count,
      COUNT(CASE WHEN pi.account_id IS NOT NULL THEN 1 END) as with_account,
      STRING_AGG(DISTINCT a.handle, ', ') as accounts
    FROM production_items pi
    LEFT JOIN accounts a ON pi.account_id = a.id
    WHERE pi.source_type = 'repurposed'
    GROUP BY pi.format
    ORDER BY pi.format
  `;

  console.table(final);

  await sql.end();
}

fix().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
