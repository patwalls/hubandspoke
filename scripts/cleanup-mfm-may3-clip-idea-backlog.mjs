#!/usr/bin/env node
/**
 * One-off cleanup: soft-delete the 2,520 My First Million `production_items`
 * rows created by a single stray run of backfill-clip-idea-production-items.mjs
 * on 2026-05-03. They were never triaged (untouched since 2026-05-17) and were
 * large enough (full-column fetch across ~3,000 rows) to blow past Next.js's
 * 2MB cache limit and time out the MFM queue/report query, taking the whole
 * web dyno down with them (R14 memory errors, cascading 503s on 2026-09-28).
 *
 * Scope is intentionally narrow — matches ALL of:
 *   - brand = 'my-first-million'
 *   - source_type = 'repurposed'
 *   - created_via IS NULL          (only the old backfill script leaves this blank;
 *                                   the live clip-idea-generate service stamps
 *                                   created_via = 'service:clip-idea-generate')
 *   - created_at::date = '2026-05-03'
 *   - status = 'Idea'              (never triaged)
 *   - deleted_at IS NULL           (not already deleted)
 *
 * This does NOT touch anything from the live generator (June 2026 onward,
 * including August/September) — those rows all have created_via set.
 *
 * Usage:
 *   node --env-file=.env.local scripts/cleanup-mfm-may3-clip-idea-backlog.mjs --dry-run
 *   node --env-file=.env.local scripts/cleanup-mfm-may3-clip-idea-backlog.mjs --apply
 *
 *   # Heroku:
 *   heroku run --app=hubandspoke node scripts/cleanup-mfm-may3-clip-idea-backlog.mjs --dry-run
 *   heroku run --app=hubandspoke node scripts/cleanup-mfm-may3-clip-idea-backlog.mjs --apply
 */
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run") || !apply;

async function main() {
  const sql = postgres(process.env.DATABASE_URL, {
    ssl: process.env.DATABASE_SSL === "off" ? false : "require",
  });

  const matches = await sql`
    SELECT id, title, created_at, status
    FROM production_items
    WHERE brand = 'my-first-million'
      AND source_type = 'repurposed'
      AND created_via IS NULL
      AND created_at::date = '2026-05-03'
      AND status = 'Idea'
      AND deleted_at IS NULL
    ORDER BY created_at ASC
  `;

  console.log(`Found ${matches.length} matching rows.`);
  if (matches.length > 0) {
    console.log(`  earliest: ${matches[0].created_at.toISOString()}`);
    console.log(`  latest:   ${matches[matches.length - 1].created_at.toISOString()}`);
  }

  if (dryRun) {
    console.log("🔍 Dry run — no changes made. Pass --apply to soft-delete these rows.");
    await sql.end();
    return;
  }

  if (matches.length === 0) {
    console.log("✅ Nothing to clean up.");
    await sql.end();
    return;
  }

  const ids = matches.map((r) => r.id);
  const result = await sql`
    UPDATE production_items
    SET deleted_at = NOW()
    WHERE id IN ${sql(ids)}
      AND deleted_at IS NULL
    RETURNING id
  `;

  console.log(`✅ Soft-deleted ${result.length} rows.`);
  await sql.end();
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
