/**
 * One-shot cleanup: soft-delete the stray `repurposed` Idea rows that
 * `threshold-monitor-sweep` created for CLIPPABLE formats before the
 * 2026-05-27 guard landed.
 *
 * Clippable formats are produced exclusively from the Clip Ideas queue, so a
 * pillar crossing a clippable child's `viewThreshold` should never have
 * spawned a repurposed Idea. The cron now skips clippable children
 * (src/jobs/tasks/threshold-monitor-sweep.ts) and so does the SPOKE queue,
 * but the rows it already created are still sitting in the queue as `Idea`s.
 *
 * Targets: production_items where
 *   created_via = 'cron:threshold-monitor-sweep'
 *   AND source_type = 'repurposed'
 *   AND status = 'Idea'              (untouched — never assigned/published)
 *   AND deleted_at IS NULL
 *   AND format maps to an is_clippable_format=true row for the same brand
 *
 * Soft-delete only (sets deleted_at) — reversible. We deliberately leave the
 * paired repurpose_triggers rows in place: they harmlessly mark the pair as
 * already-triggered, and the cron's clippable skip means it won't recreate
 * these regardless.
 *
 * Defaults to --dry-run. Pass --apply to actually write.
 *
 *   node --env-file=.env.local scripts/backfill-soft-delete-clippable-repurposed.mjs           # dry
 *   node --env-file=.env.local scripts/backfill-soft-delete-clippable-repurposed.mjs --apply   # commit
 *   heroku run --app hubandspoke node scripts/backfill-soft-delete-clippable-repurposed.mjs --apply
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
  max: 4,
});

// Shared predicate: cron-created clippable repurposed Ideas, still live.
// Used verbatim by both the count and the UPDATE so they can't drift.
const where = sql`
  pi.created_via = 'cron:threshold-monitor-sweep'
  AND pi.source_type = 'repurposed'
  AND pi.status = 'Idea'
  AND pi.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM formats f
    WHERE f.brand = pi.brand
      AND lower(trim(f.name)) = lower(trim(pi.format))
      AND f.is_clippable_format = true
  )
`;

async function main() {
  console.log(
    `\n${dryRun ? "DRY RUN" : "APPLY"} — soft-delete clippable cron-repurposed Ideas\n`,
  );

  const breakdown = await sql`
    SELECT pi.brand, pi.format, count(*)::int AS n
    FROM production_items pi
    WHERE ${where}
    GROUP BY pi.brand, pi.format
    ORDER BY n DESC
  `;

  if (breakdown.length === 0) {
    console.log("Nothing to clean up. ✅");
    await sql.end();
    return;
  }

  console.table(breakdown);
  const total = breakdown.reduce((acc, r) => acc + r.n, 0);
  console.log(`\nTotal candidates: ${total}`);

  if (dryRun) {
    console.log("\nDry run — no rows written. Re-run with --apply to soft-delete.");
    await sql.end();
    return;
  }

  const updated = await sql`
    UPDATE production_items pi
    SET deleted_at = now(), updated_at = now()
    WHERE ${where}
    RETURNING pi.id
  `;

  console.log(`\nSoft-deleted ${updated.length} rows. ✅`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
