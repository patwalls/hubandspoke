import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

async function setup() {
  console.log('Setting up format channels for MATG repurposing...\n');

  // Get the format IDs and account IDs we need
  const [clipFormat] = await sql`
    SELECT id FROM formats WHERE name = 'Podcast Clip With Hook' AND brand = 'matg'
  `;

  const [linkedinFormat] = await sql`
    SELECT id FROM formats WHERE name = 'Full Podcast On LinkedIn' AND brand = 'matg'
  `;

  // Get MATG accounts - pick the main ones for each platform
  const [matgpodYt] = await sql`
    SELECT id FROM accounts WHERE handle = 'matgpod' AND platform = 'youtube' AND brand_id IN (SELECT id FROM brands WHERE slug = 'matg')
  `;

  const [matgLinkedin] = await sql`
    SELECT id FROM accounts WHERE handle = 'marketing-against-the-grain' AND platform = 'linkedin' AND brand_id IN (SELECT id FROM brands WHERE slug = 'matg')
  `;

  const [hubspotLinkedin] = await sql`
    SELECT id FROM accounts WHERE handle = 'hubspot-marketing-against-the-grain' AND platform = 'linkedin' AND brand_id IN (SELECT id FROM brands WHERE slug = 'matg')
  `;

  if (!clipFormat || !linkedinFormat) {
    console.error('❌ Could not find required MATG formats');
    process.exit(1);
  }

  console.log('Found formats:');
  console.log(`  Podcast Clip With Hook: ${clipFormat.id}`);
  console.log(`  Full Podcast On LinkedIn: ${linkedinFormat.id}\n`);

  console.log('Setting up format channels...\n');

  // Ensure Podcast Clip With Hook → matgpod YouTube exists
  if (matgpodYt) {
    try {
      // Try to insert or ignore if exists
      await sql`
        INSERT INTO format_channels (format_id, account_id, post_type)
        VALUES (${clipFormat.id}, ${matgpodYt.id}, 'youtube_shorts')
        ON CONFLICT DO NOTHING
      `;
      console.log('✓ Podcast Clip With Hook → @matgpod (YouTube)');
    } catch (e) {
      console.log('✓ Podcast Clip With Hook → @matgpod (YouTube) [already exists]');
    }
  }

  // Set up Full Podcast On LinkedIn → marketing-against-the-grain LinkedIn
  if (matgLinkedin) {
    try {
      await sql`
        INSERT INTO format_channels (format_id, account_id, post_type)
        VALUES (${linkedinFormat.id}, ${matgLinkedin.id}, 'linkedin')
        ON CONFLICT DO NOTHING
      `;
      console.log('✓ Full Podcast On LinkedIn → @marketing-against-the-grain (LinkedIn)');
    } catch (e) {
      console.log('✓ Full Podcast On LinkedIn → @marketing-against-the-grain (LinkedIn) [already exists]');
    }
  } else if (hubspotLinkedin) {
    try {
      await sql`
        INSERT INTO format_channels (format_id, account_id, post_type)
        VALUES (${linkedinFormat.id}, ${hubspotLinkedin.id}, 'linkedin')
        ON CONFLICT DO NOTHING
      `;
      console.log('✓ Full Podcast On LinkedIn → @hubspot-marketing-against-the-grain (LinkedIn)');
    } catch (e) {
      console.log('✓ Full Podcast On LinkedIn → @hubspot-marketing-against-the-grain (LinkedIn) [already exists]');
    }
  }

  console.log('\nVerifying setup:');
  const configured = await sql`
    SELECT
      f.name as format_name,
      a.handle as account_handle,
      a.platform
    FROM format_channels fc
    LEFT JOIN formats f ON fc.format_id = f.id
    LEFT JOIN accounts a ON fc.account_id = a.id
    WHERE f.brand = 'matg'
    ORDER BY f.name
  `;

  for (const row of configured) {
    console.log(`  ${row.format_name} → @${row.account_handle} (${row.platform})`);
  }

  await sql.end();
}

setup().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
