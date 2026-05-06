import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

interface QueueJobRow {
  id: string;
  task_identifier: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
}

const STUCK_LOCK_MINUTES = 10;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Surface the Typefully-side state of a production_item to the detail page
 * header so editors see at a glance whether the draft is being created,
 * already in Typefully as a draft, scheduled, published, or failed.
 *
 * Decision order:
 *   - typefully_published_at set → "published"
 *   - typefully_scheduled_date set → "scheduled"
 *   - typefully_draft_id set → "draft" (or "publishing" if status said so)
 *   - active queue job locked < STUCK_LOCK_MINUTES → "creating"
 *   - queue job locked > STUCK_LOCK_MINUTES → "stuck"
 *   - queue job at max attempts with last_error → "error"
 *   - none of the above → "not_started"
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [item] = await db
    .select({
      id: productionItems.id,
      postType: productionItems.postType,
      typefullyDraftId: productionItems.typefullyDraftId,
      typefullyStatus: productionItems.typefullyStatus,
      typefullyShareUrl: productionItems.typefullyShareUrl,
      typefullyPrivateUrl: productionItems.typefullyPrivateUrl,
      typefullyScheduledDate: productionItems.typefullyScheduledDate,
      typefullyPublishedAt: productionItems.typefullyPublishedAt,
      typefullyError: productionItems.typefullyError,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Most recent typefully-create-draft job for this production item.
  const rows = (await db.execute(sql`
    SELECT id::text, task_identifier, attempts, max_attempts, run_at, locked_at, locked_by, last_error
    FROM graphile_worker._private_jobs
    WHERE task_identifier = 'typefully-create-draft'
      AND payload->>'productionItemId' = ${id}
    ORDER BY id DESC
    LIMIT 1
  `)) as unknown as QueueJobRow[];
  const queueJob: QueueJobRow | null = rows[0] ?? null;

  type Status =
    | "published"
    | "scheduled"
    | "draft"
    | "publishing"
    | "creating"
    | "stuck"
    | "error"
    | "not_started";
  let status: Status;
  let detail: string;

  if (item.typefullyPublishedAt) {
    status = "published";
    detail = "Published from Typefully.";
  } else if (item.typefullyScheduledDate) {
    status = "scheduled";
    detail = `Scheduled in Typefully for ${item.typefullyScheduledDate.toLocaleString()}.`;
  } else if (item.typefullyDraftId) {
    if (item.typefullyStatus === "publishing") {
      status = "publishing";
      detail = "Typefully is publishing this draft now.";
    } else {
      status = "draft";
      detail = "Draft is in Typefully, ready for review.";
    }
  } else if (queueJob) {
    const lockedAt = queueJob.locked_at ? new Date(queueJob.locked_at) : null;
    const lockAgeMs = lockedAt ? Date.now() - lockedAt.getTime() : 0;
    const isMaxedOut =
      queueJob.attempts >= queueJob.max_attempts && queueJob.last_error;
    if (isMaxedOut) {
      status = "error";
      detail = `Job exhausted ${queueJob.max_attempts} attempts. Last error: ${queueJob.last_error}`;
    } else if (lockedAt && lockAgeMs > STUCK_LOCK_MINUTES * 60_000) {
      status = "stuck";
      detail = `Job locked ${Math.floor(lockAgeMs / 60_000)} min ago by a worker that's no longer running. Re-run to release the lock.`;
    } else if (lockedAt) {
      status = "creating";
      detail = `Worker is creating the Typefully draft. Locked ${Math.max(1, Math.floor(lockAgeMs / 1000))}s ago.`;
    } else {
      status = "creating";
      detail = `Queued, run_at ${new Date(queueJob.run_at).toLocaleString()}.`;
    }
  } else if (item.typefullyError) {
    status = "error";
    detail = item.typefullyError;
  } else {
    status = "not_started";
    detail = "No Typefully draft has been created for this item.";
  }

  return NextResponse.json({
    status,
    detail,
    postType: item.postType,
    draftId: item.typefullyDraftId,
    shareUrl: item.typefullyShareUrl,
    privateUrl: item.typefullyPrivateUrl,
    scheduledDate: item.typefullyScheduledDate,
    publishedAt: item.typefullyPublishedAt,
    error: item.typefullyError,
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
    redriveAvailable:
      status === "stuck" ||
      status === "error" ||
      status === "not_started" ||
      status === "creating",
  });
}
