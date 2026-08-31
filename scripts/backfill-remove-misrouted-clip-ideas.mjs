// One-shot cleanup: remove clip ideas (and their paired production_items) that
// were generated for a target format NOT wired to the source pillar's account
// under the account-aware routing added 2026-08-31 (root → format_trigger_sources;
// derivative → parent's format_channels, account + post_type).
//
// The concrete trigger: @Howfinity long-form pillars fanned out to @futurepedia_io
// clippable formats because the old fan-out was brand-only. Those ideas should
// never have existed.
//
// SAFETY:
//   • Dry-run by default. Pass --apply to delete.
//   • Only deletes when the paired production_item is still status 'Idea'
//     (untouched in the queue). Anything an editor already advanced beyond
//     'Idea' is reported for manual review and left alone.
//   • Accountless pillars (uploaded source_recordings) route brand-wide and are
//     never considered mis-routed.
//
//   node --env-file=.env.local scripts/backfill-remove-misrouted-clip-ideas.mjs
//   node --env-file=.env.local scripts/backfill-remove-misrouted-clip-ideas.mjs --apply

import pg from "pg";

const APPLY = process.argv.includes("--apply");
// By default only delete TRUE cross-account leaks (the target format is wired to
// a different account). Pass --include-unconfigured to also delete clips for
// formats that have no source wiring at all (only do this once every brand you
// care about is wired up — otherwise you may delete legitimate clips).
const INCLUDE_UNCONFIGURED = process.argv.includes("--include-unconfigured");

const IDENTIFY_SQL = `
  WITH ci AS (
    SELECT
      c.id                         AS clip_idea_id,
      c.target_format              AS target_format_name,
      c.status                     AS clip_status,
      c.accepted_production_item_id,
      p.id                         AS pillar_id,
      p.title                      AS pillar_title,
      p.account_id                 AS pillar_account_id,
      p.post_type                  AS pillar_post_type,
      p.brand                      AS pillar_brand,
      pa.handle                    AS pillar_account_handle
    FROM clip_ideas c
    JOIN production_items p ON p.id = c.source_production_item_id
    LEFT JOIN accounts pa ON pa.id = p.account_id
  ),
  resolved AS (
    SELECT ci.*, f.id AS format_id, f.parent_format_id
    FROM ci
    JOIN formats f
      ON f.brand = ci.pillar_brand
     AND lower(f.name) = lower(ci.target_format_name)
  ),
  misrouted AS (
    SELECT r.*
    FROM resolved r
    WHERE r.pillar_account_id IS NOT NULL
      AND NOT (
        (r.parent_format_id IS NULL AND EXISTS (
            SELECT 1 FROM format_trigger_sources fts
            WHERE fts.format_id = r.format_id
              AND fts.source_account_id = r.pillar_account_id))
        OR
        (r.parent_format_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM format_channels fc
            WHERE fc.format_id = r.parent_format_id
              AND fc.account_id = r.pillar_account_id
              AND (fc.post_type IS NULL OR fc.post_type = r.pillar_post_type)))
      )
  )
  SELECT
    m.clip_idea_id,
    m.target_format_name,
    m.clip_status,
    m.accepted_production_item_id,
    m.pillar_id,
    m.pillar_title,
    m.pillar_account_handle,
    pi.status AS paired_item_status,
    pi.id     AS paired_item_id,
    -- Does the target format have ANY source wiring at all? If yes, this is a
    -- true cross-account leak (format is configured, just for a DIFFERENT
    -- account). If no, the format is simply unconfigured — the clips may be
    -- from the correct/only channel and should NOT be deleted until the brand
    -- is wired up (re-run this script afterward).
    (
      (m.parent_format_id IS NULL AND EXISTS (
          SELECT 1 FROM format_trigger_sources fts WHERE fts.format_id = m.format_id))
      OR
      (m.parent_format_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM format_channels fc WHERE fc.format_id = m.parent_format_id))
    ) AS format_has_source_config
  FROM misrouted m
  LEFT JOIN production_items pi ON pi.id = m.accepted_production_item_id
  ORDER BY m.pillar_account_handle, m.target_format_name;
`;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false },
});

function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

try {
  const { rows } = await pool.query(IDENTIFY_SQL);

  const leaks = rows.filter((r) => r.format_has_source_config);
  const unconfigured = rows.filter((r) => !r.format_has_source_config);

  console.log(`\n=== Mis-routed clip ideas: ${rows.length} ===`);
  console.log(
    `  TRUE cross-account leaks (target format wired to another account): ${leaks.length}`,
  );
  console.log(
    `  Unconfigured formats (no source wiring — review, don't blind-delete): ${unconfigured.length}\n`,
  );

  console.log("TRUE LEAKS by (source channel → wrong target format):");
  for (const [k, n] of tally(leaks, (r) => `${r.pillar_account_handle} → ${r.target_format_name}`)) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  console.log("\nUNCONFIGURED by (source channel → target format):");
  for (const [k, n] of tally(unconfigured, (r) => `${r.pillar_account_handle} → ${r.target_format_name}`)) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }

  // The set this run is willing to delete.
  const candidates = INCLUDE_UNCONFIGURED ? rows : leaks;

  // Split: safe-to-delete (paired item still 'Idea', or no paired item) vs
  // progressed (needs manual review).
  const deletable = candidates.filter(
    (r) => r.paired_item_status === "Idea" || r.paired_item_status == null,
  );
  const progressed = candidates.filter(
    (r) => r.paired_item_status != null && r.paired_item_status !== "Idea",
  );

  console.log(
    `\nDelete scope: ${INCLUDE_UNCONFIGURED ? "leaks + unconfigured" : "TRUE LEAKS only"}`,
  );
  console.log(`  Safe to delete (paired item is 'Idea' or absent): ${deletable.length}`);
  console.log(`  Progressed beyond 'Idea' (left for manual review): ${progressed.length}`);
  if (progressed.length > 0) {
    console.log("\n  Progressed items in scope (NOT touched):");
    for (const r of progressed) {
      console.log(
        `    • [${r.paired_item_status}] ${r.pillar_account_handle} → ${r.target_format_name} (clip_idea ${r.clip_idea_id})`,
      );
    }
  }

  if (!APPLY) {
    console.log(
      "\nDRY RUN — nothing deleted." +
        "\n  --apply                 delete the safe TRUE-LEAK set" +
        "\n  --apply --include-unconfigured   also delete unconfigured (only after wiring brands up)\n",
    );
    await pool.end();
    process.exit(0);
  }

  const clipIdeaIds = deletable.map((r) => r.clip_idea_id);
  const pairedItemIds = deletable
    .map((r) => r.paired_item_id)
    .filter((id) => id != null);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Delete paired production_items first (FKs are ON DELETE SET NULL either
    // way, so order is not strictly required — but this keeps the intent clear).
    let deletedItems = 0;
    if (pairedItemIds.length > 0) {
      const res = await client.query(
        `DELETE FROM production_items WHERE id = ANY($1::uuid[])`,
        [pairedItemIds],
      );
      deletedItems = res.rowCount;
    }
    let deletedIdeas = 0;
    if (clipIdeaIds.length > 0) {
      const res = await client.query(
        `DELETE FROM clip_ideas WHERE id = ANY($1::uuid[])`,
        [clipIdeaIds],
      );
      deletedIdeas = res.rowCount;
    }
    await client.query("COMMIT");
    console.log(
      `\nAPPLIED — deleted ${deletedIdeas} clip_ideas and ${deletedItems} paired production_items.\n`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
