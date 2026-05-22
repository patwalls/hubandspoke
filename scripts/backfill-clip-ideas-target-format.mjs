#!/usr/bin/env node
/**
 * Backfill `clip_ideas.target_format` from each row's linked production_item
 * (or fall back to the brand's first clippable format) so pre-2026-05-21 rows
 * render in the correct per-format queue tab.
 *
 * Strategy (in priority order, per row):
 *   1. If `clip_ideas.accepted_production_item_id` is set, use that
 *      production_item.format — the format the operator actually promoted into.
 *   2. Otherwise look up the production_item that was pre-created at
 *      generation time via `production_items.source_clip_idea_id` and use its
 *      format column.
 *   3. Otherwise fall back to the brand's first clippable format (ordered by
 *      formats.created_at).
 *
 * Idempotent — only writes rows where target_format is NULL.
 *
 * Usage:
 *   Local dry:    node --env-file=.env.local scripts/backfill-clip-ideas-target-format.mjs
 *   Local apply:  node --env-file=.env.local scripts/backfill-clip-ideas-target-format.mjs --apply
 *   Heroku:       heroku run --app=hubandspoke "node scripts/backfill-clip-ideas-target-format.mjs --apply"
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const APPLY_IF_PENDING = args.includes("--apply-if-pending");
const APPLY = args.includes("--apply") || APPLY_IF_PENDING;
const DRY_RUN = !APPLY;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

console.log(
  `Mode: ${DRY_RUN ? "DRY RUN (use --apply)" : APPLY_IF_PENDING ? "APPLY (if-pending)" : "APPLY"}`,
);

try {
  // Release-phase short-circuit: bail silently when there's nothing to do.
  // Lets this script sit in Procfile's release line without failing deploys
  // on quiet rebuilds.
  if (APPLY_IF_PENDING) {
    const [{ n }] = await sql`
      SELECT COUNT(*)::int AS n FROM clip_ideas WHERE target_format IS NULL
    `;
    if (n === 0) {
      console.log("Nothing to backfill (target_format already populated). Skipping.");
      await sql.end();
      process.exit(0);
    }
    console.log(`Found ${n} rows pending backfill — applying.`);
  }
  // Pass 1: rows with accepted_production_item_id
  const fromAccepted = await sql`
    SELECT ci.id, pi.format AS target_format
    FROM clip_ideas ci
    JOIN production_items pi ON pi.id = ci.accepted_production_item_id
    WHERE ci.target_format IS NULL
      AND pi.format IS NOT NULL
  `;
  console.log(`Pass 1: ${fromAccepted.length} rows resolvable via accepted_production_item_id`);
  if (!DRY_RUN && fromAccepted.length > 0) {
    for (const row of fromAccepted) {
      await sql`UPDATE clip_ideas SET target_format = ${row.target_format} WHERE id = ${row.id}`;
    }
    console.log(`  wrote ${fromAccepted.length} rows`);
  }

  // Pass 2: rows with a sibling production_item (source_clip_idea_id)
  const fromSibling = await sql`
    SELECT ci.id, pi.format AS target_format
    FROM clip_ideas ci
    JOIN production_items pi ON pi.source_clip_idea_id = ci.id
    WHERE ci.target_format IS NULL
      AND pi.format IS NOT NULL
  `;
  console.log(`Pass 2: ${fromSibling.length} rows resolvable via sibling production_items`);
  if (!DRY_RUN && fromSibling.length > 0) {
    for (const row of fromSibling) {
      await sql`UPDATE clip_ideas SET target_format = ${row.target_format} WHERE id = ${row.id}`;
    }
    console.log(`  wrote ${fromSibling.length} rows`);
  }

  // Pass 3: remaining rows — fall back to brand's first clippable format
  const remaining = await sql`
    SELECT ci.id, pi.brand
    FROM clip_ideas ci
    JOIN production_items pi ON pi.id = ci.source_production_item_id
    WHERE ci.target_format IS NULL
  `;
  console.log(`Pass 3: ${remaining.length} rows still null — falling back to brand default`);
  if (remaining.length > 0) {
    const brandDefault = new Map();
    for (const row of remaining) {
      if (brandDefault.has(row.brand)) continue;
      const result = await sql`
        SELECT name FROM formats
        WHERE brand = ${row.brand} AND is_clippable_format = true
        ORDER BY created_at ASC
        LIMIT 1
      `;
      brandDefault.set(row.brand, result[0]?.name ?? null);
    }
    let wrote = 0;
    let skipped = 0;
    for (const row of remaining) {
      const fmt = brandDefault.get(row.brand);
      if (!fmt) {
        skipped += 1;
        continue;
      }
      if (!DRY_RUN) {
        await sql`UPDATE clip_ideas SET target_format = ${fmt} WHERE id = ${row.id}`;
      }
      wrote += 1;
    }
    console.log(`  ${DRY_RUN ? "would write" : "wrote"} ${wrote} rows; skipped ${skipped} (no clippable format on brand)`);
  }

  const stillNull = await sql`SELECT COUNT(*)::int AS n FROM clip_ideas WHERE target_format IS NULL`;
  console.log(`After backfill: ${stillNull[0].n} rows still have target_format=NULL`);
} finally {
  await sql.end();
}
