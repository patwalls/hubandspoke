/**
 * One-shot cleanup: delete every production_items row with
 * source_type='cross_post' AND status='Idea'. Run before the v2 scanner
 * starts seeding the feed, so the operator sees only fresh LLM-generated
 * proposals instead of a backlog of stale pre-v2 Ideas.
 *
 * Cascades: cross_post_fit_verdicts referencing the source items are NOT
 * removed (they key on source_item_id, not target-idea id) — those are
 * cache rows that'll die with the legacy fit-classifier when the finalize
 * migration drops the table. content_events rows attached to the killed
 * Idea rows cascade-delete automatically via FK.
 *
 * Default: dry-run. Pass --apply to commit.
 *
 *   node --env-file=.env.local scripts/cleanup-cross-post-ideas.mjs
 *   node --env-file=.env.local scripts/cleanup-cross-post-ideas.mjs --apply
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

async function main() {
  const targets = await sql`
    SELECT pi.id,
           pi.title,
           pi.brand,
           pi.account_id,
           pi.post_type,
           pi.reposted_from_item_id,
           pi.created_at
      FROM production_items pi
     WHERE pi.source_type = 'cross_post'
       AND pi.status = 'Idea'
     ORDER BY pi.created_at DESC
  `;

  console.log(
    `Found ${targets.length} cross_post + Idea rows. Mode: ${dryRun ? "DRY RUN" : "APPLY"}.`
  );
  for (const t of targets) {
    console.log(
      `  ${t.id}  ${t.brand.padEnd(20)}  ${(t.post_type ?? "-").padEnd(18)}  ${(
        t.title ?? ""
      )
        .slice(0, 60)
        .replace(/\n/g, " ")}`
    );
  }

  if (targets.length === 0) {
    console.log("Nothing to delete.");
    await sql.end();
    return;
  }

  if (dryRun) {
    console.log("");
    console.log("Dry run — no rows deleted. Pass --apply to commit.");
    await sql.end();
    return;
  }

  const deleted = await sql`
    DELETE FROM production_items
     WHERE source_type = 'cross_post'
       AND status = 'Idea'
    RETURNING id
  `;
  console.log("");
  console.log(`Deleted ${deleted.length} rows.`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
