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
  console.log('Fixing repurposed items with incorrect account assignments...\n');

  // Update all repurposed items to remove accountId
  // (they should be assigned manually by creators based on target format)
  const result = await sql`
    UPDATE production_items
    SET
      account_id = null,
      updated_at = now()
    WHERE source_type = 'repurposed' AND account_id IS NOT NULL
  `;

  console.log(`✓ Updated ${result.count} repurposed items to remove incorrect accountId`);

  // Verify the fix
  console.log('\nVerification:');
  const remaining = await sql`
    SELECT COUNT(*) as count
    FROM production_items
    WHERE source_type = 'repurposed' AND account_id IS NOT NULL
  `;

  if (remaining[0].count === 0) {
    console.log('✓ All repurposed items now have accountId = null');
  } else {
    console.log(`⚠ ${remaining[0].count} repurposed items still have accountId set`);
  }

  // Show summary
  console.log('\nSummary of repurposed items:');
  const summary = await sql`
    SELECT
      brand,
      COUNT(*) as total,
      COUNT(CASE WHEN account_id IS NULL THEN 1 END) as unassigned
    FROM production_items
    WHERE source_type = 'repurposed'
    GROUP BY brand
  `;
  console.table(summary);

  await sql.end();
}

fix().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
