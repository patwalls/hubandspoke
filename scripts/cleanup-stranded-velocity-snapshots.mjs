/**
 * One-shot cleanup: delete view_snapshots rows whose interpretation no
 * longer matches reality.
 *
 * Background: a snapshot row stores `post_age_minutes` computed against
 * the item's `published_at` AT THE MOMENT OF WRITE. If `published_at`
 * is later overwritten (e.g. account-content-sync rewriting it from
 * SC), the row's age label becomes meaningless: a snapshot tagged
 * "First 15 minutes" might actually reflect views accumulated over
 * many days.
 *
 * Detection: compare the stored `post_age_minutes` against the current
 * `(taken_at - published_at)`. If they disagree by more than
 * `DRIFT_THRESHOLD_MIN`, the publishedAt has shifted since write and
 * the row is no longer a faithful snapshot.
 *
 * Safe: only deletes rows that have demonstrably drifted. New occurrences
 * are prevented at the source by the insert-only `publishedAt` policy in
 * `account-content-sync.ts` (UPDATE no longer writes `publishedAt`), so
 * the timestamp can no longer thrash post-INSERT. This script is the
 * one-time backfill for rows already stranded before that policy.
 *
 * Defaults to dry-run. Pass --apply to commit.
 *
 *   heroku run --app hubandspoke -- node scripts/cleanup-stranded-velocity-snapshots.mjs
 *   heroku run --app hubandspoke -- node scripts/cleanup-stranded-velocity-snapshots.mjs --apply
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

// Tolerance: snapshots within this many minutes of their stored age are
// considered consistent. 30 min comfortably accommodates worker dispatch
// latency; anything beyond is real publishedAt drift.
const DRIFT_THRESHOLD_MIN = 30;

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

async function main() {
  // First, count + sample the offenders so the operator sees what's
  // about to be deleted.
  const offenders = await sql`
    SELECT vs.id,
           vs.checkpoint_key,
           vs.post_age_minutes,
           vs.taken_at,
           pi.id AS item_id,
           pi.title,
           pi.published_at,
           round(extract(epoch FROM (vs.taken_at - pi.published_at)) / 60)::int AS apparent_age_min
      FROM view_snapshots vs
      JOIN production_items pi ON pi.id = vs.production_item_id
     WHERE abs(extract(epoch FROM (vs.taken_at - pi.published_at)) / 60 - vs.post_age_minutes) > ${DRIFT_THRESHOLD_MIN}
     ORDER BY vs.taken_at DESC
  `;

  console.log(
    `Found ${offenders.length} stranded snapshot rows (drift > ${DRIFT_THRESHOLD_MIN} min). Mode: ${
      dryRun ? "DRY RUN" : "APPLY"
    }.`
  );
  if (offenders.length === 0) {
    console.log("Nothing to do.");
    await sql.end();
    return;
  }

  // Show a sample so the operator can spot-check.
  const sample = offenders.slice(0, 8);
  console.log("");
  for (const o of sample) {
    console.log(
      `  ${o.id}  cp=${o.checkpoint_key.padEnd(3)}  stored_age=${String(o.post_age_minutes).padStart(5)}m  apparent_age=${String(o.apparent_age_min).padStart(7)}m  ${(o.title ?? "").slice(0, 50)}`
    );
  }
  if (offenders.length > sample.length) {
    console.log(`  … and ${offenders.length - sample.length} more.`);
  }

  if (dryRun) {
    console.log("");
    console.log("Dry run — nothing deleted. Pass --apply to commit.");
    await sql.end();
    return;
  }

  const deleted = await sql`
    DELETE FROM view_snapshots vs
     USING production_items pi
     WHERE pi.id = vs.production_item_id
       AND abs(extract(epoch FROM (vs.taken_at - pi.published_at)) / 60 - vs.post_age_minutes) > ${DRIFT_THRESHOLD_MIN}
    RETURNING vs.id
  `;
  console.log("");
  console.log(`Deleted ${deleted.length} stranded snapshot rows.`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
