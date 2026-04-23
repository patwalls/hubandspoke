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
  console.log('Linking repurposed items to their pillar items...\n');

  // For each repurposed item, find the parent published item with the same title
  // The pillar item should be:
  // - Same brand
  // - Same title
  // - Published status
  // - Format = "Podcast Episode" (for MATG Podcast Clip items)

  const repurposed = await sql`
    SELECT DISTINCT pi.id, pi.title, pi.brand, pi.format
    FROM production_items pi
    WHERE pi.source_type = 'repurposed'
      AND pi.pillar_content_item_id IS NULL
    ORDER BY pi.brand, pi.format
  `;

  console.log(`Found ${repurposed.length} repurposed items without pillar links\n`);

  let updated = 0;
  for (const item of repurposed) {
    // Find the pillar by exact title match in published items
    const [pillar] = await sql`
      SELECT id, title, format, status
      FROM production_items
      WHERE brand = ${item.brand}
        AND title = ${item.title}
        AND status = 'Published'
      LIMIT 1
    `;

    if (pillar) {
      await sql`
        UPDATE production_items
        SET pillar_content_item_id = ${pillar.id}, updated_at = now()
        WHERE id = ${item.id}
      `;
      updated++;
      console.log(`✓ ${item.format.substring(0, 30)}`);
      console.log(`  → Linked to: ${pillar.format} (${pillar.title.substring(0, 40)})`);
    } else {
      console.log(`⚠ ${item.format.substring(0, 30)}`);
      console.log(`  → No matching pillar found: "${item.title.substring(0, 40)}"`);
    }
  }

  console.log(`\n✓ Updated ${updated} repurposed items with pillar links`);

  // Verify
  console.log('\nVerification:');
  const stillMissing = await sql`
    SELECT COUNT(*) as count
    FROM production_items
    WHERE source_type = 'repurposed' AND pillar_content_item_id IS NULL
  `;

  if (stillMissing[0].count === 0) {
    console.log('✓ All repurposed items now have pillar links');
  } else {
    console.log(`⚠ ${stillMissing[0].count} repurposed items still missing pillar links`);
  }

  await sql.end();
}

fix().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
