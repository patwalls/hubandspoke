import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const sql = postgres(DATABASE_URL, { ssl: { rejectUnauthorized: false } });

async function testFix() {
  const rows = await sql`
    SELECT
      pi.id,
      pi.account_id,
      a.id as account_id_join,
      a.platform,
      a.handle,
      pi.post_type
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.brand = 'starter-story'
      AND pi.published_date IS NOT NULL
      AND pi.status = 'Published'
      AND pi.published_date >= '2025-10-01'
      AND pi.published_date <= '2026-05-31'
      AND pi.platform IS NOT NULL
  `;

  // Detect multi-platform accounts
  const handlePlatformCombos = new Map();
  for (const r of rows) {
    if (!r.account_id_join || !r.handle || !r.platform) continue;
    if (!handlePlatformCombos.has(r.handle)) {
      handlePlatformCombos.set(r.handle, new Set());
    }
    handlePlatformCombos.get(r.handle).add(r.platform);
  }

  // Build labels with new logic
  const primaryRowMetaByKey = new Map();
  for (const r of rows) {
    if (!r.account_id_join || !r.handle || !r.platform) continue;
    const pt = r.post_type ?? null;
    const key = `${r.platform}|${r.handle}|${pt ?? ""}`;

    if (!primaryRowMetaByKey.has(key)) {
      const accountPlatforms = handlePlatformCombos.get(r.handle);
      let label;

      if (accountPlatforms.size > 1) {
        // Multi-platform account
        const platformLabel = r.platform.charAt(0).toUpperCase() + r.platform.slice(1);
        label = `@${r.handle} · ${platformLabel}`;
      } else {
        // Single platform
        label = `@${r.handle}`;
      }

      primaryRowMetaByKey.set(key, { label, platform: r.platform, handle: r.handle });
    }
  }

  console.log('Labels after fix:');
  const labels = Array.from(primaryRowMetaByKey.values())
    .map(m => m.label)
    .sort();

  // Remove duplicates for display
  const uniqueLabels = [...new Set(labels)];
  uniqueLabels.forEach(l => console.log(`  ${l}`));

  // Check for Threads
  const hasThreads = uniqueLabels.some(l => l.includes('Threads'));
  console.log(`\n✓ Threads has own row: ${hasThreads}`);

  // Find the Threads label
  const threadsLabel = uniqueLabels.find(l => l.includes('Threads'));
  console.log(`Threads label: ${threadsLabel || 'NOT FOUND'}`);

  await sql.end();
}

testFix();
