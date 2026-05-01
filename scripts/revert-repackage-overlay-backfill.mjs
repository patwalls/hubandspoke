#!/usr/bin/env node
/**
 * Reverts the bad data written by `scripts/backfill-repackage-hook.mjs`
 * (hook_extractor='repackage-overlay-backfill:v1').
 *
 * Why: that script trusted `title` as a proxy for the on-video burn-in
 * overlay. Spot-checks against the rendered cover image showed the
 * assumption was wrong on multiple posts — title is often the caption's
 * first sentence (or some draft framing), not the bold text painted onto
 * the video. The only reliable source for overlay text is OCR on the
 * poster image, which a follow-up enqueue of `vision-extract` jobs will
 * provide.
 *
 * This script clears the wrong fields so vision can populate them cleanly.
 * Idempotent: skips rows already cleared.
 *
 * Usage:
 *   node scripts/revert-repackage-overlay-backfill.mjs              # dry-run
 *   node scripts/revert-repackage-overlay-backfill.mjs --apply
 *   heroku run --app=hubandspoke "node scripts/revert-repackage-overlay-backfill.mjs --apply"
 */
import postgres from "postgres";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "..", ".env.local") });

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

const BAD_EXTRACTOR = "repackage-overlay-backfill:v1";
const TITLE_EDIT_EXTRACTOR = "repackage-overlay:title-edit";
const DISPATCHER_SHORTCIRCUIT_EXTRACTOR = "repackage-overlay:v1";

async function main() {
  console.log(`[revert-repackage-overlay-backfill] mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}`);

  const candidates = await sql`
    SELECT id, hook, overlay, hook_source, hook_extractor
    FROM production_items
    WHERE hook_extractor IN (
      ${BAD_EXTRACTOR},
      ${TITLE_EDIT_EXTRACTOR},
      ${DISPATCHER_SHORTCIRCUIT_EXTRACTOR}
    )
  `;

  console.log(`[revert-repackage-overlay-backfill] found ${candidates.length} rows to revert`);

  if (APPLY && candidates.length > 0) {
    const result = await sql`
      UPDATE production_items
      SET hook = NULL,
          overlay = NULL,
          hook_source = NULL,
          hook_extracted_at = NULL,
          hook_extractor = NULL,
          updated_at = now()
      WHERE hook_extractor IN (
        ${BAD_EXTRACTOR},
        ${TITLE_EDIT_EXTRACTOR},
        ${DISPATCHER_SHORTCIRCUIT_EXTRACTOR}
      )
    `;
    console.log(`[revert-repackage-overlay-backfill] reverted ${result.count} rows`);
  } else if (!APPLY) {
    console.log("(dry-run — re-run with --apply to commit)");
    for (const row of candidates.slice(0, 5)) {
      console.log(`  - ${row.id}  hook=${truncate(row.hook)}`);
    }
    if (candidates.length > 5) console.log(`  ... and ${candidates.length - 5} more`);
  }

  await sql.end();
}

function truncate(s) {
  if (s == null) return "(null)";
  const flat = String(s).replace(/\s+/g, " ");
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
