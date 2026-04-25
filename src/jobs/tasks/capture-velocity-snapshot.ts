import type { Task } from "graphile-worker";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, viewSnapshots } from "@/lib/db/schema";
import { refreshItemMetrics } from "@/lib/services/performance-decay";
import { enqueue } from "@/jobs/enqueue";
import {
  VELOCITY_CHECKPOINTS,
  isVelocityCheckpointKey,
  type VelocityCheckpointKey,
} from "@/lib/velocity-checkpoints";

export type { VelocityCheckpointKey };

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

  // Reject payloads with an invalid checkpoint key. A bad key would
  // otherwise silently fail the in-window lookup below and pollute
  // view_snapshots with something a DB CHECK constraint now also
  // rejects. Throwing here surfaces the bug immediately.
  if (!isVelocityCheckpointKey(checkpointKey)) {
    helpers.logger.error(
      `capture-velocity-snapshot invalid payload item=${productionItemId} cp=${checkpointKey} — expected one of ${VELOCITY_CHECKPOINTS.map((c) => c.key).join("|")}`
    );
    throw new Error(
      `capture-velocity-snapshot: invalid checkpointKey "${checkpointKey}"`
    );
  }

  if (typeof productionItemId !== "string" || productionItemId.length === 0) {
    throw new Error("capture-velocity-snapshot: missing productionItemId");
  }

  const [item] = await db
    .select({
      id: productionItems.id,
      publishedAt: productionItems.publishedAt,
      createdAt: productionItems.createdAt,
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

  const cp = VELOCITY_CHECKPOINTS.find((c) => c.key === checkpointKey);

  // Stale-publishedAt gate. The previous in-window check trusts that
  // `publishedAt` reflects the real moment the post went live. But that
  // value can be retroactively rewritten by `account-content-sync` (e.g.
  // SC briefly returned no `publishedTime`, our writer null-clobbered the
  // column, and a later sweep wrote a "fresh" approximation). When that
  // happens, the in-window check still passes — `now - publishedAt` lines
  // up with the checkpoint — but the captured view count reflects all the
  // post's accumulated views, not the first 15 minutes.
  //
  // Defense: if our app has known about this item for materially longer
  // than the checkpoint's target age, we cannot plausibly be at this
  // checkpoint right now. Refuse to write.
  if (cp) {
    const knownForMs = Date.now() - new Date(item.createdAt).getTime();
    const checkpointAgeMs = cp.offsetMinutes * 60_000;
    const STALE_PUBLISHED_AT_GRACE_MS = 60 * 60_000; // 1 hour
    if (knownForMs > checkpointAgeMs + STALE_PUBLISHED_AT_GRACE_MS) {
      helpers.logger.warn(
        `capture-velocity-snapshot stale-publishedAt item=${productionItemId} cp=${checkpointKey} known_for_min=${Math.round(knownForMs / 60_000)} max_allowed_min=${Math.round((checkpointAgeMs + STALE_PUBLISHED_AT_GRACE_MS) / 60_000)} — refusing (no SC call)`
      );
      return;
    }
  }

  // Age gate. If the job fires outside its checkpoint window (retry
  // backoff, worker downtime, clock skew), skip the SC call instead of
  // storing a snapshot mislabeled with the wrong age. The scanner tolerates
  // missing checkpoints; it can't tolerate silently-wrong ones.
  const ageMinutesAtFire = Math.max(
    0,
    Math.floor((Date.now() - new Date(item.publishedAt).getTime()) / 60_000)
  );
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
 * Enqueue velocity-snapshot jobs for an item, one per checkpoint still in
 * play. Each job runs at `max(publishedAt + offsetMinutes, now + grace)` —
 * if the target age has passed but the tolerance window is still open
 * (e.g. account-content-sync discovers a post at age 16m), we fire
 * immediately and the task's own window check validates at execution time.
 * Checkpoints whose full window has already closed are skipped.
 *
 * Idempotent on two levels:
 *   - Already-captured checkpoints (row in `view_snapshots`) are
 *     short-circuited here so we don't add worker churn on repeat syncs.
 *   - `jobKey: "velocity-<itemId>-<cp>"` + graphile-worker's default
 *     `jobKeyMode: "replace"` means repeat calls with updated publishedAt
 *     correct the `run_at` on still-pending jobs.
 *
 * Safe to call multiple times per item (POST/PUT on the web dyno, plus
 * INSERT and UPDATE branches of account-content-sync).
 */
export async function scheduleVelocitySnapshots(
  productionItemId: string,
  publishedAt: Date | string | null
): Promise<{ scheduled: number; skippedPast: number; skippedCaptured: number }> {
  if (!publishedAt) {
    return { scheduled: 0, skippedPast: 0, skippedCaptured: 0 };
  }
  const publishedMs =
    publishedAt instanceof Date
      ? publishedAt.getTime()
      : new Date(publishedAt).getTime();
  if (Number.isNaN(publishedMs)) {
    return { scheduled: 0, skippedPast: 0, skippedCaptured: 0 };
  }

  // Single SELECT pulling both already-captured checkpoint keys (for the
  // dedup short-circuit) and the item's `created_at` (for the stale-
  // publishedAt gate below). Saves a roundtrip vs. two queries.
  const itemRow = await db
    .select({
      createdAt: productionItems.createdAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (itemRow.length === 0) {
    return { scheduled: 0, skippedPast: 0, skippedCaptured: 0 };
  }
  const itemCreatedAt = itemRow[0].createdAt;

  const alreadyCaptured = await db
    .select({ checkpointKey: viewSnapshots.checkpointKey })
    .from(viewSnapshots)
    .where(
      and(
        eq(viewSnapshots.productionItemId, productionItemId),
        isNotNull(viewSnapshots.checkpointKey)
      )
    );
  const capturedKeys = new Set(
    alreadyCaptured.map((r) => r.checkpointKey).filter((k): k is string => !!k)
  );

  let scheduled = 0;
  let skippedPast = 0;
  let skippedCaptured = 0;
  const now = Date.now();
  // Same gate as the task uses, applied here so we don't even queue jobs
  // we'd reject at fire time. Cuts SC + worker waste when publishedAt is
  // briefly fresh-stamped on a long-known item.
  const STALE_PUBLISHED_AT_GRACE_MS = 60 * 60_000;
  const knownForMs = itemCreatedAt
    ? now - new Date(itemCreatedAt).getTime()
    : 0;
  // Minimum lead time on a job's run_at — keeps the fire from racing with
  // the insert that triggered the schedule.
  const MIN_GRACE_MS = 5_000;

  for (const cp of VELOCITY_CHECKPOINTS) {
    if (capturedKeys.has(cp.key)) {
      skippedCaptured++;
      continue;
    }
    // Stale-publishedAt gate (mirror of the task's check). If we've known
    // about this item for materially longer than this checkpoint's target
    // age, the publishedAt we were handed is retroactively-stamped, not
    // the real publish time. Skip — see the task for full rationale.
    const checkpointAgeMs = cp.offsetMinutes * 60_000;
    if (knownForMs > checkpointAgeMs + STALE_PUBLISHED_AT_GRACE_MS) {
      skippedPast++;
      continue;
    }
    const targetMs = publishedMs + cp.offsetMinutes * 60_000;
    const windowCloseMs = publishedMs + cp.windowMax * 60_000;
    if (now > windowCloseMs) {
      // Entire window already passed — no way to capture in-window.
      skippedPast++;
      continue;
    }
    // If the target is past but the window is still open, fire as soon as
    // graphile-worker can dequeue it. The task's window check validates.
    const runAtMs = Math.max(targetMs, now + MIN_GRACE_MS);
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
  return { scheduled, skippedPast, skippedCaptured };
}
