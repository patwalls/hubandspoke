#!/usr/bin/env node
// One-shot cleanup script for the repost v1 → v2 cutover.
//
// Bulk-stamps every existing `sourceType='repost' status='Idea'` row to
// status='Killed' with reason 'superseded by repost v2 algorithm'. This
// clears the v1-populated queue so the live v2 query (cohort-driven,
// P75×1.5×) takes over with a clean slate.
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

const REASON = "superseded by repost v2 algorithm (live percentile-driven queue)";

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock-and-find candidates so the activity-event insert can reference
    // the killed rows by id.
    const { rows: targets } = await client.query(
      `SELECT id, title, account_id, post_type
       FROM production_items
       WHERE source_type = 'repost' AND status = 'Idea'
       FOR UPDATE`
    );

    if (targets.length === 0) {
      console.log("No v1 repost Idea rows to clean up — already done.");
      await client.query("ROLLBACK");
      return;
    }

    console.log(`Found ${targets.length} v1 repost Idea rows. Killing them...`);

    // Stamp status=Killed.
    await client.query(
      `UPDATE production_items
       SET status = 'Killed', updated_at = now()
       WHERE source_type = 'repost' AND status = 'Idea'`
    );

    // Activity event per row so the kill is auditable + the kill reason
    // feeds the evergreen classifier's negative-exemplar history.
    const valuesSql = targets
      .map(
        (_t, i) =>
          `($${i * 4 + 1}, NULL, 'killed', $${i * 4 + 2}::jsonb, now())`
      )
      .join(", ");
    const params = targets.flatMap((t) => [
      t.id,
      JSON.stringify({ type: "killed", from: "Idea", reason: REASON }),
    ]);
    await client.query(
      `INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
       VALUES ${valuesSql}`,
      params
    );

    await client.query("COMMIT");
    console.log(`✅ Killed ${targets.length} legacy repost rows.`);
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
