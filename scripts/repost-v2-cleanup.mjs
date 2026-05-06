#!/usr/bin/env node
// One-shot cleanup script for the repost v1 → v2 cutover.
//
// Soft-deletes every existing `sourceType='repost' status='Idea'` row
// (stamps deleted_at). v2's selectRepostCandidates filters by
// deleted_at IS NULL when looking up prior reposts, so soft-deleting
// makes these rows vanish from v2's view entirely.
//
// CRITICAL: do NOT stamp status='Killed' — v2 treats any killed repost
// on a source as a *permanent operator rejection* and blocks the source
// from ever resurfacing. The v1 picks were system-generated, not
// operator-rejected, so the killed-status path is wrong for cleanup.
// (Learned this by accidentally suppressing 24 of v2's top candidates
// with the original version of this script.)
//
// Idempotent: re-running is a no-op because the WHERE clause filters
// to Idea status only. Run via:
//
//   heroku run --app hubandspoke node scripts/repost-v2-cleanup.mjs
//
// (Or locally: `node --env-file=.env.local scripts/repost-v2-cleanup.mjs`)

import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: countRow } = await client.query(
      `SELECT count(*)::int AS n
       FROM production_items
       WHERE source_type = 'repost' AND status = 'Idea' AND deleted_at IS NULL`
    );
    const toDelete = countRow[0]?.n ?? 0;

    if (toDelete === 0) {
      console.log("No v1 repost Idea rows to clean up — already done.");
      await client.query("ROLLBACK");
      return;
    }

    console.log(`Found ${toDelete} v1 repost Idea rows. Soft-deleting...`);

    await client.query(
      `UPDATE production_items
       SET deleted_at = now(), updated_at = now()
       WHERE source_type = 'repost' AND status = 'Idea' AND deleted_at IS NULL`
    );

    await client.query("COMMIT");
    console.log(`✅ Soft-deleted ${toDelete} legacy repost rows.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  await pool.end();
}

main();
