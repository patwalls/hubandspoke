import type { Task } from "graphile-worker";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, viewSnapshots } from "@/lib/db/schema";
import { refreshItemMetrics } from "@/lib/services/performance-decay";
import { enqueue } from "@/jobs/enqueue";

// Velocity checkpoints — the ages at which we want a view-count snapshot.
// Cross-post scanner reads these to judge how fast a post is growing. One
// SC call per checkpoint per post, scheduled up front at publish time so
// we never poll.
// Each checkpoint has a target age + a tolerance window. If a job fires
// outside its window (retry backoff, worker downtime), we skip the SC
// call rather than capture a misleading snapshot tagged at the wrong
// age. Windows are asymmetric around the target because late firing
// (retry delay) is far more common than early firing.
export const VELOCITY_CHECKPOINTS = [
  { key: "15m", offsetMinutes: 15, windowMin: 8, windowMax: 25 },
  { key: "30m", offsetMinutes: 30, windowMin: 20, windowMax: 45 },
  { key: "1h", offsetMinutes: 60, windowMin: 45, windowMax: 90 },
  { key: "2h", offsetMinutes: 120, windowMin: 100, windowMax: 150 },
  { key: "4h", offsetMinutes: 240, windowMin: 210, windowMax: 270 },
] as const;
export type VelocityCheckpointKey =
  (typeof VELOCITY_CHECKPOINTS)[number]["key"];

export interface CaptureVelocitySnapshotPayload {
  productionItemId: string;
  checkpointKey: VelocityCheckpointKey;
}

/**
 * Calls `refreshItemMetrics` (1 SC call) and writes a single
 * `view_snapshots` row tagged with the given checkpoint key. Idempotent
 * via the partial unique index on (productionItemId, checkpointKey) —
 * if a retry runs, the INSERT silently no-ops.
 *
 * Skips without a SC call if the item was deleted between enqueue and
 * execution.
 */
export const captureVelocitySnapshotTask: Task = async (
  rawPayload,
  helpers
) => {
  const { productionItemId, checkpointKey } =
    rawPayload as CaptureVelocitySnapshotPayload;
  const start = Date.now();

  const [item] = await db
    .select({
      id: productionItems.id,
      publishedAt: productionItems.publishedAt,
      status: productionItems.status,
      deletedAt: productionItems.deletedAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item || item.deletedAt) {
    helpers.logger.info(
      `capture-velocity-snapshot skipped item=${productionItemId} cp=${checkpointKey} (missing or deleted)`
    );
    return;
  }
  if (item.status !== "Published") {
    // Item was un-published (or never got there) before the scheduled
    // time. Drop the snapshot — velocity only makes sense for live posts.
    helpers.logger.info(
      `capture-velocity-snapshot skipped item=${productionItemId} cp=${checkpointKey} (status=${item.status})`
    );
    return;
  }
  if (!item.publishedAt) {
    helpers.logger.warn(
      `capture-velocity-snapshot skipped item=${productionItemId} cp=${checkpointKey} (no publishedAt)`
    );
    return;
  }

  // Quick idempotency check — the unique index will catch a true race, but
  // this saves a wasted SC call on retries.
  const [existing] = await db
    .select({ id: viewSnapshots.id })
    .from(viewSnapshots)
    .where(
      and(
        eq(viewSnapshots.productionItemId, productionItemId),
        eq(viewSnapshots.checkpointKey, checkpointKey)
      )
    )
    .limit(1);
  if (existing) {
    helpers.logger.info(
      `capture-velocity-snapshot already-captured item=${productionItemId} cp=${checkpointKey}`
    );
    return;
  }

  // Age gate. If the job fires outside its checkpoint window (retry
  // backoff, worker downtime, clock skew), skip the SC call instead of
  // storing a snapshot mislabeled with the wrong age. The scanner tolerates
  // missing checkpoints; it can't tolerate silently-wrong ones.
  const ageMinutesAtFire = Math.max(
    0,
    Math.floor((Date.now() - new Date(item.publishedAt).getTime()) / 60_000)
  );
  const cp = VELOCITY_CHECKPOINTS.find((c) => c.key === checkpointKey);
  if (cp && (ageMinutesAtFire < cp.windowMin || ageMinutesAtFire > cp.windowMax)) {
    helpers.logger.warn(
      `capture-velocity-snapshot out-of-window item=${productionItemId} cp=${checkpointKey} age=${ageMinutesAtFire}m window=${cp.windowMin}-${cp.windowMax}m — skipping (no SC call)`
    );
    return;
  }

  const refreshed = await refreshItemMetrics(productionItemId);

  if (!refreshed.updated || refreshed.views == null) {
    helpers.logger.info(
      `capture-velocity-snapshot no-snapshot item=${productionItemId} cp=${checkpointKey} platform=${refreshed.platform} note=${refreshed.note ?? "no views returned"}`
    );
    return;
  }

  const ageMs = Date.now() - new Date(item.publishedAt).getTime();
  const postAgeMinutes = Math.max(0, Math.floor(ageMs / 60_000));

  // Plain ON CONFLICT DO NOTHING (no target) — drizzle's `target:` form
  // can't match a partial unique index, and the pre-check above already
  // handles the retry-idempotency case. If a true race slips through,
  // the unique violation is caught below and the row is treated as a
  // duplicate.
  try {
    await db.insert(viewSnapshots).values({
      productionItemId,
      views: refreshed.views,
      likes: refreshed.likes,
      comments: refreshed.comments,
      postAgeMinutes,
      checkpointKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate key/i.test(msg)) {
      helpers.logger.info(
        `capture-velocity-snapshot race-caught item=${productionItemId} cp=${checkpointKey} — already inserted`
      );
      return;
    }
    throw err;
  }

  helpers.logger.info(
    `capture-velocity-snapshot ok item=${productionItemId} cp=${checkpointKey} views=${refreshed.views} age=${postAgeMinutes}m credits=${refreshed.creditsUsed} (${Date.now() - start}ms)`
  );
};

/**
 * Enqueue the five velocity-snapshot jobs for a newly-published item, each
 * with `runAt = publishedAt + checkpoint.offsetMinutes`. Checkpoints whose
 * target time has already passed (e.g. a sync that surfaces a post 2h after
 * publish) are silently skipped — we can't retroactively snapshot a moment
 * that's already gone.
 *
 * `jobKey` is set per (item, checkpoint) so repeat callers (e.g. a sync run
 * seeing the same item twice) can't stack duplicate jobs. graphile-worker
 * overwrites the queued job's `runAt` on re-enqueue, so this is safe to
 * call more than once.
 */
export async function scheduleVelocitySnapshots(
  productionItemId: string,
  publishedAt: Date | string | null
): Promise<{ scheduled: number; skippedPast: number }> {
  if (!publishedAt) return { scheduled: 0, skippedPast: 0 };
  const publishedMs =
    publishedAt instanceof Date
      ? publishedAt.getTime()
      : new Date(publishedAt).getTime();
  if (Number.isNaN(publishedMs)) return { scheduled: 0, skippedPast: 0 };

  let scheduled = 0;
  let skippedPast = 0;
  const now = Date.now();
  // Leave a small head-start grace so we don't fire a job that'll just
  // observe the post at age 14.9m and round to the "15m" checkpoint before
  // the platform has had a chance to register any views.
  const MIN_GRACE_MS = 60_000;

  for (const cp of VELOCITY_CHECKPOINTS) {
    const runAtMs = publishedMs + cp.offsetMinutes * 60_000;
    if (runAtMs <= now + MIN_GRACE_MS) {
      skippedPast++;
      continue;
    }
    await enqueue(
      "capture-velocity-snapshot",
      { productionItemId, checkpointKey: cp.key },
      {
        runAt: new Date(runAtMs),
        jobKey: `velocity-${productionItemId}-${cp.key}`,
      }
    );
    scheduled++;
  }
  return { scheduled, skippedPast };
}
