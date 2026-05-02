/**
 * One-shot cleanup for the cross-post v2 → v3 cutover.
 *
 * Cross-post v3 (2026-05-02) replaces the (source × target) Idea rows the v2
 * scanner produced with a live percentile-within-format candidate list — the
 * Cross-post tab no longer surfaces Idea rows at all. This script transitions
 * any pending v2 cross-post Idea rows to `Killed` so they fall out of the
 * All / Cross-post tabs without being deleted (kills are auditable in the UI).
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-cross-post-ideas-archive.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-cross-post-ideas-archive.mjs --apply
 *
 * Defaults to dry-run; pass --apply to actually update rows.
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

const KILL_REASON =
  "Archived by cross-post v3 cutover (2026-05-02). The Cross-post queue is now a live candidate list — pre-existing v2 Idea rows are no longer surfaced.";

async function main() {
  const rows = await sql`
    SELECT id, title, account_id, post_type, brand
      FROM production_items
     WHERE source_type = 'cross_post'
       AND status = 'Idea'
       AND deleted_at IS NULL
     ORDER BY created_at DESC
  `;

  console.log(
    `Found ${rows.length} pending v2 cross-post Idea row${
      rows.length === 1 ? "" : "s"
    }. Mode: ${dryRun ? "DRY RUN" : "APPLY"}.`
  );

  for (const r of rows) {
    console.log(
      `  [${r.brand}] ${r.id}  →  "${r.title ?? "(untitled)"}" (${r.post_type})`
    );
  }

  if (dryRun || rows.length === 0) {
    await sql.end();
    return;
  }

  const result = await sql`
    UPDATE production_items
       SET status = 'Killed',
           updated_at = now()
     WHERE source_type = 'cross_post'
       AND status = 'Idea'
       AND deleted_at IS NULL
  `;

  console.log(`Marked ${result.count} row${result.count === 1 ? "" : "s"} Killed.`);

  // Also write content_events so the kill is auditable per item.
  await sql`
    INSERT INTO content_events (content_item_id, event_type, payload)
    SELECT id,
           'killed',
           jsonb_build_object(
             'type', 'killed',
             'from', 'Idea',
             'reason', ${KILL_REASON}
           )
      FROM production_items
     WHERE source_type = 'cross_post'
       AND status = 'Killed'
       AND deleted_at IS NULL
       AND updated_at >= now() - interval '1 minute'
  `;

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
