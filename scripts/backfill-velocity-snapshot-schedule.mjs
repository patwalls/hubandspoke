/**
 * One-shot backfill: for every Published original whose `published_at` is
 * in the last 4 hours, enqueue `capture-velocity-snapshot` jobs for the
 * checkpoints that haven't passed yet. Run once right after deploying the
 * per-post snapshot architecture — otherwise we'd silently miss velocity
 * data on items published during the deploy window.
 *
 * Defaults to dry-run. Pass --apply to actually enqueue.
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-velocity-snapshot-schedule.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-velocity-snapshot-schedule.mjs --apply
 */
import postgres from "postgres";
import pg from "pg";
import { makeWorkerUtils } from "graphile-worker";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const VELOCITY_CHECKPOINTS = [
  { key: "15m", offsetMinutes: 15 },
  { key: "30m", offsetMinutes: 30 },
  { key: "1h", offsetMinutes: 60 },
  { key: "2h", offsetMinutes: 120 },
  { key: "4h", offsetMinutes: 240 },
];
const MIN_GRACE_MS = 60_000;

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

async function main() {
  // Items Published within the last 4h with a known publishedAt.
  const rows = await sql`
    SELECT id, published_at, title
      FROM production_items
     WHERE status = 'Published'
       AND source_type = 'original'
       AND deleted_at IS NULL
       AND published_at IS NOT NULL
       AND published_at >= (now() - interval '4 hours')
     ORDER BY published_at DESC
  `;

  console.log(
    `Found ${rows.length} items published within the last 4h. Mode: ${
      dryRun ? "DRY RUN" : "APPLY"
    }.`
  );

  const now = Date.now();
  const plan = [];
  for (const row of rows) {
    const publishedMs = new Date(row.published_at).getTime();
    const pending = [];
    for (const cp of VELOCITY_CHECKPOINTS) {
      const runAtMs = publishedMs + cp.offsetMinutes * 60_000;
      if (runAtMs <= now + MIN_GRACE_MS) continue;
      pending.push({ key: cp.key, runAt: new Date(runAtMs) });
    }
    if (pending.length === 0) continue;
    plan.push({ id: row.id, title: row.title, pending });
  }

  console.log("");
  for (const p of plan) {
    const cps = p.pending.map((x) => `${x.key}@${x.runAt.toISOString()}`).join(", ");
    console.log(
      `  ${p.id}  ${(p.title ?? "").slice(0, 60).padEnd(60)}  → ${cps}`
    );
  }
  const totalJobs = plan.reduce((n, p) => n + p.pending.length, 0);
  console.log("");
  console.log(
    `Total: ${plan.length} items, ${totalJobs} jobs to enqueue${
      dryRun ? " (dry run)" : ""
    }.`
  );

  if (dryRun) {
    await sql.end();
    return;
  }

  const pgPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  const workerUtils = await makeWorkerUtils({ pgPool });

  let enqueued = 0;
  for (const p of plan) {
    for (const cp of p.pending) {
      await workerUtils.addJob(
        "capture-velocity-snapshot",
        { productionItemId: p.id, checkpointKey: cp.key },
        { runAt: cp.runAt, jobKey: `velocity-${p.id}-${cp.key}` }
      );
      enqueued++;
    }
  }

  await workerUtils.release();
  await pgPool.end();
  await sql.end();
  console.log(`Enqueued ${enqueued} jobs.`);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
