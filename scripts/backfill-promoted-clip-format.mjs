/**
 * One-shot backfill: rewrite the canonical clip-promotion format from
 * "Repackage section with hook" → "Reel: Repackage Section w/ Hook"
 * across every existing reference, then delete the orphaned wrong-named
 * format row.
 *
 * Why: until 2026-05-05, three duplicated copies of the
 * `PROMOTED_CLIP_FORMAT` constant pointed at "Repackage section with
 * hook" — a brand-default Pillar with no Descript pack attached. The
 * intended format is "Reel: Repackage Section w/ Hook" (Derivative of
 * "Business Breakdown", Pat-edited, has the "Starter Story Reels" pack
 * attached). 4,406 production_items + 42 repurpose_triggers got the
 * wrong reference. The constant is now extracted to a single source of
 * truth (`src/lib/services/promote-clip-idea.ts`) and points at the
 * correct name; this script normalizes the historical data.
 *
 * Strategy:
 *   1. UPDATE repurpose_triggers.target_format_id from the wrong format
 *      uuid (`86e4e595-…`) to the right one (`68d6a688-…`).
 *      Only starter-story has trigger rows — other brands never had a
 *      promotion happen.
 *   2. UPDATE production_items.format text from "Repackage section with
 *      hook" to "Reel: Repackage Section w/ Hook" across all 4 brands
 *      (futurepedia, matg, my-first-million, starter-story). Bumps
 *      updated_at.
 *   3. DELETE the wrong format row. Validated nothing else references it
 *      (parent_format_id, format_channels, source_format_id all return 0).
 *
 * Idempotent: re-running matches 0 rows on every UPDATE/DELETE. Safe to
 * run twice.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-promoted-clip-format.mjs         # dry-run
 *   node --env-file=.env.local scripts/backfill-promoted-clip-format.mjs --apply
 *
 * Production:
 *   heroku run --app=hubandspoke node scripts/backfill-promoted-clip-format.mjs --apply
 */
import postgres from "postgres";

const WRONG_FORMAT_ID = "86e4e595-5039-4c49-a7c0-b76b5a2f356d";
const RIGHT_FORMAT_ID = "68d6a688-a4c7-4a42-af5f-4dfc82ed677a";
const WRONG_NAME = "Repackage section with hook";
const RIGHT_NAME = "Reel: Repackage Section w/ Hook";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };
const sql = postgres(databaseUrl, { max: 1, ssl, prepare: false });

async function main() {
  console.log(`[mode] ${dryRun ? "DRY RUN" : "APPLY"}`);

  // Pre-flight: confirm the right format actually exists. If a fresh
  // database is missing it (unlikely in prod, but defensive), bail —
  // re-pointing triggers at a non-existent FK target would fail anyway.
  const [right] = await sql`
    SELECT id, name, brand FROM formats WHERE id = ${RIGHT_FORMAT_ID}
  `;
  if (!right) {
    console.error(
      `Right-side format ${RIGHT_FORMAT_ID} (${RIGHT_NAME}) not found. Bailing.`,
    );
    process.exit(2);
  }
  console.log(
    `[ok] right-side format present: ${right.name} (brand=${right.brand})`,
  );

  // Pre-flight counts so the apply mode logs are interpretable.
  const [{ count: itemsToUpdate }] = await sql`
    SELECT count(*)::int AS count FROM production_items WHERE format = ${WRONG_NAME}
  `;
  const [{ count: triggersToUpdate }] = await sql`
    SELECT count(*)::int AS count FROM repurpose_triggers WHERE target_format_id = ${WRONG_FORMAT_ID}
  `;
  const [wrongFormatRow] = await sql`
    SELECT id, name, brand FROM formats WHERE id = ${WRONG_FORMAT_ID}
  `;

  console.log(`[scope] production_items.format='${WRONG_NAME}': ${itemsToUpdate}`);
  console.log(`[scope] repurpose_triggers.target_format_id=${WRONG_FORMAT_ID}: ${triggersToUpdate}`);
  console.log(
    `[scope] wrong format row: ${wrongFormatRow ? `${wrongFormatRow.name} (${wrongFormatRow.id})` : "(already deleted)"}`,
  );

  if (dryRun) {
    console.log("[dry-run] no changes written. Re-run with --apply.");
    return;
  }

  await sql.begin(async (tx) => {
    // 1. Re-point triggers
    const triggerRes = await tx`
      UPDATE repurpose_triggers
      SET target_format_id = ${RIGHT_FORMAT_ID}
      WHERE target_format_id = ${WRONG_FORMAT_ID}
    `;
    console.log(`[step 1] repurpose_triggers updated: ${triggerRes.count}`);

    // 2. Rewrite production_items.format text
    const itemRes = await tx`
      UPDATE production_items
      SET format = ${RIGHT_NAME}, updated_at = now()
      WHERE format = ${WRONG_NAME}
    `;
    console.log(`[step 2] production_items updated: ${itemRes.count}`);

    // 3. Drop the orphan format row.
    const deleteRes = await tx`
      DELETE FROM formats WHERE id = ${WRONG_FORMAT_ID}
    `;
    console.log(`[step 3] formats deleted: ${deleteRes.count}`);
  });

  // Post-condition checks.
  const [{ count: leftoverItems }] = await sql`
    SELECT count(*)::int AS count FROM production_items WHERE format = ${WRONG_NAME}
  `;
  const [{ count: leftoverTriggers }] = await sql`
    SELECT count(*)::int AS count FROM repurpose_triggers WHERE target_format_id = ${WRONG_FORMAT_ID}
  `;
  const [{ count: leftoverFormat }] = await sql`
    SELECT count(*)::int AS count FROM formats WHERE id = ${WRONG_FORMAT_ID}
  `;

  console.log(`[verify] production_items leftover: ${leftoverItems}`);
  console.log(`[verify] repurpose_triggers leftover: ${leftoverTriggers}`);
  console.log(`[verify] wrong format leftover: ${leftoverFormat}`);

  if (leftoverItems !== 0 || leftoverTriggers !== 0 || leftoverFormat !== 0) {
    console.error("[fail] post-condition not met — leftover rows exist.");
    process.exit(3);
  }

  console.log("[done] all references normalized.");
}

try {
  await main();
} finally {
  await sql.end();
}
