import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { buildDescriptCompositionUrl } from "@/lib/descript";

interface QueueJobRow {
  id: string;
  task_identifier: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  payload: Record<string, unknown> | null;
}

const STUCK_LOCK_MINUTES = 10;

/**
 * Surface the current Descript-side state of a production_item to the
 * detail page header so editors can see at a glance whether the clip is
 * processing, connected, stuck, or failed — and re-drive it without
 * leaving the page.
 *
 * Status decision (in order):
 *   - composition_id stamped on the production_item or its trigger →
 *     "connected"
 *   - active queue job (precise-cut or descript-clip-resolve) with a
 *     fresh lock or no lock → "processing"
 *   - queue job locked > STUCK_LOCK_MINUTES ago → "stuck" (lock leaked
 *     when the worker dyno died mid-task; redrive releases the lock)
 *   - queue job hit max_attempts with last_error set → "failed"
 *   - any descript_project_id set but no composition + no queue job →
 *     "stalled" (the worker finished but didn't write composition_id —
 *     usually means Descript itself errored mid-import)
 *   - none of the above → "not_started"
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [item] = await db
    .select({
      id: productionItems.id,
      descriptProjectId: productionItems.descriptProjectId,
      descriptProjectUrl: productionItems.descriptProjectUrl,
      descriptCompositionId: productionItems.descriptCompositionId,
      descriptPublishJobId: productionItems.descriptPublishJobId,
      descriptPublishedAt: productionItems.descriptPublishedAt,
      descriptPublishError: productionItems.descriptPublishError,
      sourceType: productionItems.sourceType,
      sourceClipIdeaId: productionItems.sourceClipIdeaId,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Trigger row keyed off the source pillar (clip promotions write the
  // trigger against the pillar's production_item id, not the derivative).
  // Fall back to any trigger created BY this row if the row IS a pillar.
  const triggerSourceId = item.pillarContentItemId ?? item.id;
  const [trigger] = await db
    .select({
      id: repurposeTriggers.id,
      descriptJobId: repurposeTriggers.descriptJobId,
      descriptCompositionId: repurposeTriggers.descriptCompositionId,
      descriptImportPath: repurposeTriggers.descriptImportPath,
      descriptProjectUrl: repurposeTriggers.descriptProjectUrl,
    })
    .from(repurposeTriggers)
    .where(eq(repurposeTriggers.productionItemId, triggerSourceId))
    .orderBy(desc(repurposeTriggers.id))
    .limit(1);

  // Pull the most recent queue job for this trigger. graphile-worker's
  // payload is jsonb so we filter by triggerId inside it.
  let queueJob: QueueJobRow | null = null;
  if (trigger) {
    // graphile-worker 0.16+ stores task identifiers in `_private_tasks`;
    // join through `task_id` to filter by name.
    const rows = (await db.execute(sql`
      SELECT j.id::text,
             t.identifier AS task_identifier,
             j.attempts,
             j.max_attempts,
             j.run_at,
             j.locked_at,
             j.locked_by,
             j.last_error,
             j.payload
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier IN ('clip-idea-precise-cut', 'descript-clip-resolve')
        AND j.payload->>'triggerId' = ${trigger.id}
      ORDER BY j.id DESC
      LIMIT 1
    `)) as unknown as QueueJobRow[];
    queueJob = rows[0] ?? null;
  }

  const compositionId = item.descriptCompositionId ?? trigger?.descriptCompositionId ?? null;
  const projectId = item.descriptProjectId ?? null;
  const projectUrl =
    item.descriptProjectUrl ?? trigger?.descriptProjectUrl ?? null;
  const compositionUrl =
    projectId && compositionId
      ? buildDescriptCompositionUrl(projectId, compositionId)
      : null;

  type Status =
    | "connected"
    | "processing"
    | "stuck"
    | "failed"
    | "stalled"
    | "not_started";
  let status: Status;
  let detail: string;
  if (compositionId) {
    status = "connected";
    detail = "Composition is ready in Descript.";
  } else if (queueJob) {
    const lockedAt = queueJob.locked_at ? new Date(queueJob.locked_at) : null;
    const lockAgeMs = lockedAt ? Date.now() - lockedAt.getTime() : 0;
    const isMaxedOut =
      queueJob.attempts >= queueJob.max_attempts && queueJob.last_error;
    if (isMaxedOut) {
      status = "failed";
      detail = `Job exhausted ${queueJob.max_attempts} attempts. Last error: ${queueJob.last_error}`;
    } else if (lockedAt && lockAgeMs > STUCK_LOCK_MINUTES * 60_000) {
      status = "stuck";
      detail = `Job locked ${Math.floor(lockAgeMs / 60_000)} min ago by a worker that's no longer running. Re-run to release the lock.`;
    } else if (lockedAt) {
      status = "processing";
      detail = `Worker is running phase ${queueJob.task_identifier}. Locked ${Math.max(1, Math.floor(lockAgeMs / 1000))}s ago.`;
    } else {
      status = "processing";
      detail = `Queued, run_at ${new Date(queueJob.run_at).toLocaleString()}.`;
    }
  } else if (trigger || projectId) {
    status = "stalled";
    detail =
      "Descript project exists but no composition was written and no queue job is active. Re-run to start fresh.";
  } else if (
    item.sourceType === "clip" ||
    item.sourceClipIdeaId ||
    item.pillarContentItemId
  ) {
    status = "not_started";
    detail = "No Descript work has been started for this item yet.";
  } else {
    status = "not_started";
    detail = "Not a clip — Descript work isn't expected.";
  }

  return NextResponse.json({
    status,
    detail,
    compositionId,
    compositionUrl,
    projectId,
    projectUrl,
    trigger: trigger
      ? {
          id: trigger.id,
          descriptJobId: trigger.descriptJobId,
          descriptImportPath: trigger.descriptImportPath,
        }
      : null,
    queueJob: queueJob
      ? {
          id: queueJob.id,
          taskIdentifier: queueJob.task_identifier,
          attempts: queueJob.attempts,
          maxAttempts: queueJob.max_attempts,
          runAt: queueJob.run_at,
          lockedAt: queueJob.locked_at,
          lastError: queueJob.last_error,
        }
      : null,
    /** Whether the redrive endpoint will do something useful from the
     *  current state. False when already connected / not a clip. */
    redriveAvailable:
      status === "stuck" ||
      status === "failed" ||
      status === "stalled" ||
      status === "processing",
    /** Publish-and-archive state — separate axis from the composition
     *  status. The pill polls this independently and shows a secondary
     *  "Rendering MP4…" / "Rendered ✓" / "Render failed (Retry)" block
     *  inside the popover. */
    publish: derivePublishState(item),
  });
}

function derivePublishState(item: {
  descriptPublishJobId: string | null;
  descriptPublishedAt: Date | null;
  descriptPublishError: string | null;
}): {
  state: "idle" | "rendering" | "rendered" | "failed";
  jobId: string | null;
  publishedAt: string | null;
  error: string | null;
} {
  let state: "idle" | "rendering" | "rendered" | "failed" = "idle";
  if (item.descriptPublishError) state = "failed";
  else if (item.descriptPublishedAt) state = "rendered";
  else if (item.descriptPublishJobId) state = "rendering";
  return {
    state,
    jobId: item.descriptPublishJobId,
    publishedAt: item.descriptPublishedAt
      ? new Date(item.descriptPublishedAt).toISOString()
      : null,
    error: item.descriptPublishError,
  };
}

interface RouteContext {
  params: Promise<{ id: string }>;
}
