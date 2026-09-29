#!/usr/bin/env node
/**
 * Backfill estimated views for already-synced `facebook_post` rows.
 *
 * Scrape Creators' /facebook/profile/posts returns no view count for any FB
 * post (photo or video), so these rows synced with views=NULL. The view
 * estimator now maps facebook_post → reactions × 165 (see
 * src/lib/services/view-estimator.ts), but that only fires on future syncs.
 * This one-shot populates the estimate on existing rows.
 *
 * Only touches rows where:
 *   post_type = 'facebook_post' AND views IS NULL AND likes > 0
 * Rows with zero/null reactions (~26% of FB posts) have no anchor and are
 * intentionally left blank. Idempotent — re-running is a no-op once applied.
 *
 * MULTIPLIER is duplicated here (165) rather than imported because this is a
 * plain .mjs script; keep it in sync with POST_TYPE_VIEW_MULTIPLIERS.facebook_post.
 *
 * Usage:
 *   Local dry:    node --env-file=.env.local scripts/backfill-facebook-views.mjs
 *   Local apply:  node --env-file=.env.local scripts/backfill-facebook-views.mjs --apply
 *   Heroku:       heroku run --app=hubandspoke "node scripts/backfill-facebook-views.mjs --apply"
 */
import postgres from "postgres";

const MULTIPLIER = 165;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY_RUN = !APPLY;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

console.log(`Mode: ${DRY_RUN ? "DRY RUN (use --apply)" : "APPLY"}`);
console.log(`Multiplier: reactions × ${MULTIPLIER}`);

try {
  const candidates = await sql`
    SELECT id, likes,
           ROUND(likes * ${MULTIPLIER}) AS est_views
    FROM production_items
    WHERE post_type = 'facebook_post'
      AND views IS NULL
      AND likes > 0
    ORDER BY likes DESC
  `;

  const skipped = await sql`
    SELECT COUNT(*)::int AS n
    FROM production_items
    WHERE post_type = 'facebook_post'
      AND views IS NULL
      AND (likes IS NULL OR likes = 0)
  `;

  console.log(`\n${candidates.length} facebook_post rows will get estimated views.`);
  console.log(`${skipped[0].n} rows have no reactions and stay blank.`);

  if (candidates.length > 0) {
    console.log("\nSample (top 5 by reactions):");
    for (const r of candidates.slice(0, 5)) {
      console.log(`  ${r.id}  likes=${r.likes}  → est_views=${r.est_views}`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — no rows written. Re-run with --apply to commit.");
  } else {
    const updated = await sql`
      UPDATE production_items
      SET views = ROUND(likes * ${MULTIPLIER}),
          views_estimated = true
      WHERE post_type = 'facebook_post'
        AND views IS NULL
        AND likes > 0
    `;
    console.log(`\nApplied. Updated ${updated.count} rows.`);
  }
} finally {
  await sql.end();
}
