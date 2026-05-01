#!/usr/bin/env node
/**
 * One-time backfill: copy pillar_content_item_id + pillar_content_notion_id
 * from a repost's parent production_item onto the repost row.
 *
 * Background: until 2026-05-01, the evergreen-scan cron's auto-repost path
 * (src/lib/services/evergreen-scan.ts) inserted new rows without copying
 * pillar_content_item_id from the source. Result: an evergreen-suggested
 * repost showed "No pillar — click to choose" while its parent had a pillar
 * set. Manual reposts via /api/production-items/[id]/repost were correct;
 * only the cron-generated rows are affected. The producing code path has
 * been fixed forward in the same change.
 *
 * Strategy: SELECT every production_item where source_type='repost' AND
 * pillar_content_item_id IS NULL AND reposted_from_item_id IS NOT NULL,
 * then UPDATE each row's pillar columns from its parent. If the parent
 * itself has no pillar, the row is skipped and reported.
 *
 * Usage:
 *   Local:        node --env-file=.env.local scripts/backfill-repost-pillar.mjs
 *   Local apply:  node --env-file=.env.local scripts/backfill-repost-pillar.mjs --apply
 *   Heroku:       heroku run --app=hubandspoke "node scripts/backfill-repost-pillar.mjs --apply"
 *
 * Idempotent — re-running after --apply is a no-op.
 */
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

console.log(`Mode: ${DRY_RUN ? "DRY RUN (use --apply to write)" : "APPLY"}`);

try {
  const broken = await sql`
    SELECT
      r.id                          AS repost_id,
      r.title                       AS title,
      r.created_at                  AS created_at,
      p.id                          AS parent_id,
      p.pillar_content_item_id      AS parent_pillar_item_id,
      p.pillar_content_notion_id    AS parent_pillar_notion_id
    FROM production_items r
    JOIN production_items p ON p.id = r.reposted_from_item_id
    WHERE r.source_type = 'repost'
      AND r.pillar_content_item_id IS NULL
      AND r.reposted_from_item_id IS NOT NULL
    ORDER BY r.created_at DESC
  `;

  console.log(`Found ${broken.length} repost row(s) missing pillar_content_item_id`);

  let fixable = 0;
  let unfixable = 0;

  for (const row of broken) {
    if (!row.parent_pillar_item_id) {
      unfixable++;
      console.log(
        `  SKIP ${row.repost_id} "${(row.title ?? "").slice(0, 60)}" — parent ${row.parent_id} has no pillar`
      );
      continue;
    }
    fixable++;
    console.log(
      `  FIX  ${row.repost_id} "${(row.title ?? "").slice(0, 60)}" — pillar=${row.parent_pillar_item_id} notion=${row.parent_pillar_notion_id ?? "(null)"}`
    );

    if (!DRY_RUN) {
      await sql`
        UPDATE production_items
        SET pillar_content_item_id   = ${row.parent_pillar_item_id},
            pillar_content_notion_id = ${row.parent_pillar_notion_id},
            updated_at               = NOW()
        WHERE id = ${row.repost_id}
      `;
    }
  }

  console.log("");
  console.log(`Summary: fixable=${fixable}, unfixable=${unfixable}, total=${broken.length}`);
  if (unfixable > 0) {
    console.log(
      `Note: ${unfixable} row(s) couldn't be fixed because the parent original has no pillar set. Those reposts can be linked manually via the detail page.`
    );
  }
  if (DRY_RUN) {
    console.log("Re-run with --apply to persist changes.");
  } else {
    console.log("Done.");
  }
} finally {
  await sql.end();
}
