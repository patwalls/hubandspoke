/**
 * One-shot rescue: re-enqueue velocity-snapshot jobs for items that lost
 * tracking due to the stale-publishedAt gate (commit 8c5e358, shipped
 * 2026-04-25 ~17:48 UTC, removed in the follow-up fix).
 *
 * The gate used `production_items.created_at` as a proxy for "how long
 * the post has been live on-platform." That assumption holds for cross-
 * post / sync-discovered rows but breaks for the operator workflow
 * (Idea → Assigned → … → Published can span days). For any item that
 * lived as Idea for more than ~75 minutes before being marked Published,
 * the gate dropped all 8 checkpoint enqueues silently.
 *
 * Scope: items published in the bug window where at least one checkpoint
 * window is still open (publishedAt within last 48h). For each, enqueue
 * the missing checkpoints with run_at clamped to `max(target, now+grace)`.
 * Already-captured checkpoints are skipped via the view_snapshots
 * dedup query.
 *
 * Defaults to dry-run. Pass --apply to actually enqueue.
 *
 *   node --env-file=.env.local scripts/rescue-velocity-snapshots-202604.mjs
 *   heroku run --app hubandspoke -- node scripts/rescue-velocity-snapshots-202604.mjs
 *   heroku run --app hubandspoke -- node scripts/rescue-velocity-snapshots-202604.mjs --apply
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

// Mirror src/lib/velocity-checkpoints.ts. mjs can't import TS, so this is
// duplicated. Keep the keys/offsets/windows in sync with the canonical list.
const VELOCITY_CHECKPOINTS = [
  { key: "15m", offsetMinutes: 15, windowMin: 9, windowMax: 22 },
  { key: "30m", offsetMinutes: 30, windowMin: 23, windowMax: 45 },
  { key: "1h", offsetMinutes: 60, windowMin: 46, windowMax: 90 },
  { key: "2h", offsetMinutes: 120, windowMin: 100, windowMax: 179 },
  { key: "4h", offsetMinutes: 240, windowMin: 215, windowMax: 300 },
  { key: "8h", offsetMinutes: 480, windowMin: 420, windowMax: 720 },
  { key: "24h", offsetMinutes: 1440, windowMin: 1200, windowMax: 2160 },
  { key: "48h", offsetMinutes: 2880, windowMin: 2400, windowMax: 4320 },
];

const MIN_GRACE_MS = 5_000;
// Bug shipped at 2026-04-25 17:48:17 UTC (commit 8c5e358).
const BUG_SHIPPED_AT = "2026-04-25 17:48:00+00";

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

async function main() {
  // Items Published during the bug window whose 48h window is still open.
  // No source_type filter — all three types (original, repost, cross_post)
  // are affected if the operator marked them Published from a long-lived
  // Idea row. Cross-post inserts done in one shot have created_at ≈
  // publishedAt and the gate never fired for them, but harmless to
  // re-enqueue (alreadyCaptured short-circuit).
  const rows = await sql`
    SELECT id, published_at, title, status
      FROM production_items
     WHERE status = 'Published'
       AND deleted_at IS NULL
       AND published_at IS NOT NULL
       AND published_at >= ${BUG_SHIPPED_AT}::timestamptz
       AND published_at >= (now() - interval '48 hours')
     ORDER BY published_at DESC
  `;

  console.log(
    `Found ${rows.length} candidate items published since ${BUG_SHIPPED_AT}. Mode: ${
      dryRun ? "DRY RUN" : "APPLY"
    }.`
  );

  // Bulk-load already-captured (item, checkpointKey) pairs for the
  // candidate set. One query, then in-memory filter.
  const itemIds = rows.map((r) => r.id);
  let capturedByItem = new Map();
  if (itemIds.length > 0) {
    const captured = await sql`
      SELECT production_item_id, checkpoint_key
        FROM view_snapshots
       WHERE production_item_id IN ${sql(itemIds)}
         AND checkpoint_key IS NOT NULL
    `;
    for (const c of captured) {
      const set =
        capturedByItem.get(c.production_item_id) ?? new Set();
      set.add(c.checkpoint_key);
      capturedByItem.set(c.production_item_id, set);
    }
  }

  const now = Date.now();
  const plan = [];
  for (const row of rows) {
    const publishedMs = new Date(row.published_at).getTime();
    const captured = capturedByItem.get(row.id) ?? new Set();
    const pending = [];
    for (const cp of VELOCITY_CHECKPOINTS) {
      if (captured.has(cp.key)) continue;
      const targetMs = publishedMs + cp.offsetMinutes * 60_000;
      const windowCloseMs = publishedMs + cp.windowMax * 60_000;
      if (now > windowCloseMs) continue;
      const runAtMs = Math.max(targetMs, now + MIN_GRACE_MS);
      pending.push({ key: cp.key, runAt: new Date(runAtMs) });
    }
    if (pending.length === 0) continue;
    plan.push({ id: row.id, title: row.title, pending });
  }

  console.log("");
  for (const p of plan) {
    const cps = p.pending
      .map((x) => `${x.key}@${x.runAt.toISOString()}`)
      .join(", ");
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
