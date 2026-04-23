import postgres from 'postgres';
import { getContentReport } from '../src/lib/db/queries.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

async function testReport() {
  try {
    console.log('Testing getContentReport function...\n');

    // Test with default params (last 90 days, all filters)
    const params = {
      startDate: '2026-01-23',
      endDate: '2026-04-23',
      viewType: 'weekly',
      platform: 'all',
      platformKey: 'all',
      accountId: 'all',
      postType: 'all',
      format: 'all',
      source: 'all',
    };

    console.log('Calling getContentReport with params:', params);
    const report = await getContentReport(params);

    console.log('\nReport structure:');
    console.log('- accountList:', report.accountList.map(a => `${a.label} (${a.platform})`).join(', '));
    console.log('- primaryRows:', report.primaryRows.slice(0, 5).join(', '), '...');
    console.log('- primaryRowMeta keys:', Object.keys(report.primaryRowMeta).slice(0, 5).join(', '), '...');

    console.log('\nX platform accounts in report:');
    const xAccounts = report.accountList.filter(a => a.platform === 'x');
    xAccounts.forEach(a => {
      console.log(`  ${a.label} (handle: ${a.handle})`);
    });

    console.log('\nX-related rows in primaryRows:');
    const xRows = report.primaryRows.filter(r => r.includes('@'));
    xRows.forEach(r => {
      if (r.includes('X') || r.includes('@')) {
        console.log(`  ${r}`);
      }
    });

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testReport();
