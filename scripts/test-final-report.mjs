import postgres from 'postgres';
import { format as dateFnsFormat, subDays, startOfWeek, endOfWeek, addWeeks, differenceInDays, isAfter } from 'date-fns';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

async function testFinalReport() {
  console.log('Testing final report structure...\n');

  // Parameters
  const startDate = '2026-01-23';
  const endDate = '2026-04-23';
  const viewType = 'weekly';
  const platform = 'all';
  const platformKey = 'all';
  const accountId = 'all';
  const postType = 'all';
  const format = 'all';
  const source = 'all';

  // Query
  const rows = await sql`
    SELECT
      pi.id,
      pi.title,
      pi.account_id,
      a.id as account_id_join,
      a.platform,
      a.handle,
      a.avatar_url,
      pi.post_type,
      pi.views
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.brand = 'starter-story'
      AND pi.published_date IS NOT NULL
      AND pi.status = 'Published'
      AND pi.published_date >= ${startDate}
      AND pi.published_date <= ${endDate}
      AND pi.platform IS NOT NULL
  `;

  console.log(`Query returned ${rows.length} rows\n`);

  // Build aggregation maps
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
        avatarUrl: r.avatar_url,
      });
    }
  }

  // Build primaryRows
  const showingFormats = platform !== 'all' && format === 'all';
  const primaryRowMetaList = Array.from(primaryRowMetaByKey.values()).sort(
    (a, b) => a.label.localeCompare(b.label)
  );

  let primaryRows;
  if (showingFormats) {
    primaryRows = [];
  } else {
    primaryRows = primaryRowMetaList.map((m) => m.label);
  }

  // Initialize metric data structures
  const initMetricData = (rows) => {
    const data = {};
    rows.forEach((row) => {
      data[row] = {
        'W1': 0,
        'W2': 0,
        'W3': 0,
        'W4': 0,
      };
    });
    return data;
  };

  const primaryProduction = initMetricData(primaryRows);

  // Aggregate
  let thepatCount = 0;
  rows.forEach((item) => {
    const rowKey = itemToRowKey.get(item.id);
    const label = rowKey ? primaryRowMetaByKey.get(rowKey)?.label : null;

    if (item.account_id_join === 'e1bf53af-d59b-41f9-b741-69dad94ecef0') {
      thepatCount++;
    }

    if (label && primaryProduction[label] !== undefined) {
      // Just count production for simplicity
      primaryProduction[label]['W1'] += 1;
    }
  });

  console.log(`Total thepatwalls items processed: ${thepatCount}`);
  console.log(`Keys in primaryProduction: ${Object.keys(primaryProduction).length}`);
  console.log(`\nPrimary rows (${primaryRows.length}):`);
  primaryRows.forEach(r => console.log(`  ${r}`));

  console.log(`\nProduction data keys:`);
  Object.keys(primaryProduction).forEach(k => console.log(`  ${k}`));

  // Check thepatwalls specifically
  const thepat_count_in_data = primaryProduction['@thepatwalls']?.['W1'] || 0;
  console.log(`\nProduction count for @thepatwalls in W1: ${thepat_count_in_data}`);
  console.log(`Expected count (should match thepatCount): ${thepatCount}`);

  if (thepat_count_in_data === 0 && thepatCount > 0) {
    console.log(`\n⚠️  ERROR: thepatwalls items exist (${thepatCount}) but count in production is 0!`);
  } else if (thepat_count_in_data > 0) {
    console.log(`\n✓ SUCCESS: @thepatwalls is in the report with ${thepat_count_in_data} items`);
  }

  await sql.end();
}

testFinalReport().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
