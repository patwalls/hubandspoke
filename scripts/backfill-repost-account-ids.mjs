#!/usr/bin/env node
/**
 * One-time backfill: copy account_id + post_type from a repost's parent
 * production_item onto the repost row.
 *
 * Background: until 2026-04-25, both repost-creation paths (manual API at
 * src/app/api/production-items/[id]/repost and the evergreen-scan cron) wrote
 * a legacy `platform[]` JSONB array but skipped the new account_id / post_type
 * columns. Result: repost rows showed the legacy "X (Starter Story)" pill
 * but the detail page Account selector was empty. This script fixes the
 * historic rows; the producing code paths have been fixed forward in the same
 * change.
 *
 * Strategy: SELECT every production_item where source_type='repost' AND
 * account_id IS NULL AND reposted_from_item_id IS NOT NULL, then UPDATE each
 * row's account_id + post_type from its parent. If the parent itself is also
 * missing account_id/post_type, the row is skipped and reported (those
 * originals need their own backfill — see scripts/backfill-accounts.mjs).
 *
 * Usage:
 *   Local:        node --env-file=.env.local scripts/backfill-repost-account-ids.mjs
 *   Local apply:  node --env-file=.env.local scripts/backfill-repost-account-ids.mjs --apply
 *   Heroku:       heroku run --app=hubandspoke "node scripts/backfill-repost-account-ids.mjs --apply"
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
      r.id          AS repost_id,
      r.title       AS title,
      r.platform    AS legacy_platform,
      r.created_at  AS created_at,
      p.id          AS parent_id,
      p.account_id  AS parent_account_id,
      p.post_type   AS parent_post_type
    FROM production_items r
    JOIN production_items p ON p.id = r.reposted_from_item_id
    WHERE r.source_type = 'repost'
      AND r.account_id IS NULL
      AND r.reposted_from_item_id IS NOT NULL
    ORDER BY r.created_at DESC
  `;

  console.log(`Found ${broken.length} repost row(s) missing account_id`);

  let fixable = 0;
  let unfixable = 0;

  for (const row of broken) {
    if (!row.parent_account_id) {
      unfixable++;
      console.log(
        `  SKIP ${row.repost_id} "${(row.title ?? "").slice(0, 60)}" — parent ${row.parent_id} also missing account_id`
      );
      continue;
    }
    fixable++;
    const platform = Array.isArray(row.legacy_platform)
      ? row.legacy_platform.join(", ")
      : "(none)";
    console.log(
      `  FIX  ${row.repost_id} "${(row.title ?? "").slice(0, 60)}" — legacy=[${platform}] → account=${row.parent_account_id} post_type=${row.parent_post_type ?? "(null)"}`
    );

    if (!DRY_RUN) {
      await sql`
        UPDATE production_items
        SET account_id = ${row.parent_account_id},
            post_type  = ${row.parent_post_type},
            updated_at = NOW()
        WHERE id = ${row.repost_id}
      `;
    }
  }

  console.log("");
  console.log(`Summary: fixable=${fixable}, unfixable=${unfixable}, total=${broken.length}`);
  if (unfixable > 0) {
    console.log(
      `Note: ${unfixable} row(s) couldn't be fixed because the parent original is also missing account_id. Run scripts/backfill-accounts.mjs first, then re-run this script.`
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
