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
  console.log('Updating repurposed item names to match naming convention...\n');

  const repurposed = await sql`
    SELECT
      pi.id,
      pi.title as old_title,
      pi.format as target_format,
      pp.format as pillar_format,
      pp.title as pillar_title
    FROM production_items pi
    LEFT JOIN production_items pp ON pi.pillar_content_item_id = pp.id
    WHERE pi.source_type = 'repurposed' AND pi.pillar_content_item_id IS NOT NULL
  `;

  console.log(`Found ${repurposed.length} repurposed items to rename\n`);

  let updated = 0;
  for (const item of repurposed) {
    const newTitle = `${item.pillar_format} → ${item.target_format} (${item.pillar_title})`;

    await sql`
      UPDATE production_items
      SET title = ${newTitle}, updated_at = now()
      WHERE id = ${item.id}
    `;

    updated++;
    console.log(`✓ Updated`);
    console.log(`  Old: ${item.old_title.substring(0, 50)}`);
    console.log(`  New: ${newTitle.substring(0, 80)}`);
  }

  console.log(`\n✓ Updated ${updated} repurposed items`);

  // Verify
  console.log('\nSample of updated names:');
  const samples = await sql`
    SELECT
      title,
      format,
      source_type
    FROM production_items
    WHERE source_type = 'repurposed'
    LIMIT 5
  `;

  for (const item of samples) {
    console.log(`  ${item.title.substring(0, 80)}`);
  }

  await sql.end();
}

fix().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
