import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { buildDescriptCompositionUrl } from "@/lib/descript";
import {
  BLOCKED_ERROR_PREFIX,
  type BlockedReason,
} from "@/jobs/tasks/descript-derivative-create";

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

  // Short-circuit when the item itself has zero Descript context. Both
  // the agent flow and the precise-cut flow stamp the derivative's own
  // descript_* columns once Descript work is in flight; if everything is
  // still null the item isn't a Descript clip — it's a Canva post, a
  // text-only item, or a fresh row that never got promoted. Without this
  // gate the trigger lookup below walks up to the pillar and picks up
  // ANY Descript trigger the pillar has (often from a sibling derivative
  // that's a different format), so the "Descript ready" pill leaks onto
  // unrelated rows.
  const itemHasDescriptContext =
    item.descriptProjectId !== null ||
    item.descriptCompositionId !== null ||
    item.descriptPublishJobId !== null ||
    item.descriptPublishedAt !== null ||
    item.descriptPublishError !== null;
  // Precise-cut sits in a gap right after enqueue: the trigger row exists,
  // the clip-idea-precise-cut job is queued, but no descript_* column on
  // the production_item has been stamped yet (the worker writes
  // descriptProjectId only after the import call returns). Treat a queued
  // clip-promotion job keyed by THIS derivative as enough Descript context
  // to keep the lookup going — otherwise the chip flashes "not_started"
  // for the first ~5-30s after the user clicks Create.
  let hasQueuedClipPromoteJob = false;
  if (!itemHasDescriptContext) {
    const probe = (await db.execute(sql`
      SELECT 1
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier IN ('clip-idea-precise-cut', 'descript-clip-resolve')
        AND j.payload->>'derivativeItemId' = ${id}
      LIMIT 1
    `)) as unknown as Array<unknown>;
    hasQueuedClipPromoteJob = probe.length > 0;
  }
  if (!itemHasDescriptContext && !hasQueuedClipPromoteJob) {
    return NextResponse.json({
      status: "not_started" as const,
      detail: "Not a Descript clip.",
      compositionId: null,
      compositionUrl: null,
      projectId: null,
      projectUrl: null,
      queueJob: null,
      trigger: null,
      publish: { state: "idle" as const, jobId: null, publishedAt: null, error: null },
    });
  }

  // Trigger row keyed off the source pillar (clip promotions write the
  // trigger against the pillar's production_item id, not the derivative).
  // Fall back to any trigger created BY this row if the row IS a pillar.
  // Filter to triggers that actually carry Descript state — every
  // repurpose action (including non-Descript paths like Canva) writes a
  // trigger row for dedup, but only Descript-promoted clips populate
  // descriptJobId / descriptCompositionId. Without this filter the
  // working-state pill leaks onto every repurpose target.
  //
  // Lookup order: the derivative-copy path (cross-post / repost) creates
  // a trigger tied to THIS row's id, so try item.id first. The full-video
  // / agent / precise-cut clip-promotion paths create triggers tied to the
  // pillar, so we fall back to pillar.id. ORDER BY `productionItemId =
  // item.id` DESC ensures the derivative's own trigger wins when both
  // exist (e.g. a clip that was then cross-posted).
  const triggerSourceIds = [item.id, item.pillarContentItemId].filter(
    (x): x is string => !!x,
  );
  const [trigger] = await db
    .select({
      id: repurposeTriggers.id,
      productionItemId: repurposeTriggers.productionItemId,
      descriptJobId: repurposeTriggers.descriptJobId,
      descriptCompositionId: repurposeTriggers.descriptCompositionId,
      descriptImportPath: repurposeTriggers.descriptImportPath,
      descriptProjectUrl: repurposeTriggers.descriptProjectUrl,
    })
    .from(repurposeTriggers)
    .where(
      and(
        // Use `inArray` rather than a raw `= ANY(${triggerSourceIds})`.
        // Drizzle's template-tag interpolation of a JS array becomes a
        // tuple `($1, $2)`, which Postgres rejects ("op ANY/ALL (array)
        // requires array on right side", 42809). Every poll on a
        // pillar+derivative pair was 500ing, so the status pill never
        // surfaced even when Underlord was running.
        inArray(repurposeTriggers.productionItemId, triggerSourceIds),
        sql`(${repurposeTriggers.descriptJobId} IS NOT NULL OR ${repurposeTriggers.descriptCompositionId} IS NOT NULL)`,
      ),
    )
    .orderBy(
      sql`(${repurposeTriggers.productionItemId} = ${item.id}) DESC`,
      desc(repurposeTriggers.id),
    )
    .limit(1);

  // Pull the most recent queue job for this trigger or for this item.
  // Three task families can be in flight, each keyed differently in the
  // payload:
  //   - `clip-idea-precise-cut` and `descript-clip-resolve` → keyed by
  //     `triggerId` (set when the clip-promotion trigger was created)
  //   - `descript-publish-and-archive` → keyed by `productionItemId`
  //     (the publish task is owned by the item, not the trigger)
  //
  // Without the publish-and-archive branch the pill flips to "Descript
  // ready" the moment Underlord finishes — but the MP4 archive job is
  // still in the queue waiting to render. Including it here keeps the
  // status honest until the MP4 actually lands.
  let queueJob: QueueJobRow | null = null;
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
    WHERE
      (
        t.identifier IN ('clip-idea-precise-cut', 'descript-clip-resolve')
        AND ${trigger ? sql`j.payload->>'triggerId' = ${trigger.id}` : sql`FALSE`}
      )
      OR (
        -- Same task families, but matched by the derivative's id directly.
        -- The trigger lookup above filters out triggers that don't yet
        -- carry a descriptJobId OR descriptCompositionId (to keep the pill
        -- from leaking onto non-Descript repurpose paths). The precise-cut
        -- path inserts a trigger WITHOUT a descriptJobId — the worker only
        -- stamps it after the import call returns — so during that
        -- ~5-30s gap the trigger is invisible to the filter and the chip
        -- shows "not_started" even though a job is queued. Looking up by
        -- derivativeItemId lights the chip up the second the row is
        -- enqueued, so editors see "Trimming clip…" immediately.
        t.identifier IN ('clip-idea-precise-cut', 'descript-clip-resolve')
        AND j.payload->>'derivativeItemId' = ${id}
      )
      OR (
        t.identifier = 'descript-publish-and-archive'
        AND j.payload->>'productionItemId' = ${id}
      )
      OR (
        -- Cross-post / repost composition copy task. Keyed by
        -- derivativeItemId on the payload — this row is the derivative.
        -- Surfacing it here makes the pill show "Working on Descript
        -- composition…" between the click and the first Descript API
        -- call, so the operator sees that something IS happening even
        -- before descript_project_id is stamped on the row.
        t.identifier = 'descript-derivative-create'
        AND j.payload->>'derivativeItemId' = ${id}
      )
      OR (
        -- Whisper transcription. The cross-post chain requires a
        -- transcript for this row (when source-side anchoring needs it),
        -- so a queued transcribe-whisper for THIS row maps onto the
        -- same in-progress pill — same "we're doing prep work, come
        -- back later" semantics from the operator's POV.
        t.identifier = 'transcribe-whisper'
        AND j.payload->>'productionItemId' = ${id}
      )
    ORDER BY j.id DESC
    LIMIT 1
  `)) as unknown as QueueJobRow[];
  queueJob = rows[0] ?? null;

  // Strict 1:1 — never surface a composition_id that isn't on THIS row.
  // The old fallback chain (`item ?? trigger ?? null`) would emit a deep-
  // link to the trigger's composition_id, which belongs to a different
  // production_item (typically the pillar or a sibling clip), and clicking
  // it sent editors to the wrong Descript composition. If this row hasn't
  // had its composition stamped yet, return null so the UI hides the link
  // until the resolver writes it.
  const compositionId = item.descriptCompositionId ?? null;
  const projectId = item.descriptProjectId ?? null;
  // Strict 1:1, same reasoning as compositionId above: the trigger's
  // descriptProjectUrl is reused across re-promotions of the same clip idea,
  // so falling back to it surfaces a STALE project from a previous cut — while
  // a fresh cut is still processing (this row's URL not yet stamped), the
  // "Open project in Descript" link would send editors to a different clip.
  // Only link the project this row actually owns; hide it until the worker
  // stamps it.
  const projectUrl = item.descriptProjectUrl ?? null;
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
    | "blocked"
    | "not_started";

  /** Extract structured blocked-reason from a task's last_error.
   *  `descript-derivative-create` throws Error("blocked:<reason>: <detail>")
   *  when the cross-post can't proceed without human action. The status
   *  route surfaces this as a distinct UI state so the pill shows
   *  "Needs pillar media" / "Needs transcript" / etc. instead of a
   *  generic "Descript failed" red. */
  function parseBlockedReason(
    err: string | null,
  ): { reason: BlockedReason; detail: string } | null {
    if (!err || !err.includes(BLOCKED_ERROR_PREFIX)) return null;
    const idx = err.indexOf(BLOCKED_ERROR_PREFIX);
    const rest = err.slice(idx + BLOCKED_ERROR_PREFIX.length);
    const colonAt = rest.indexOf(":");
    if (colonAt < 0) return null;
    const reason = rest.slice(0, colonAt) as BlockedReason;
    const detail = rest.slice(colonAt + 1).trim();
    if (
      reason !== "needs_pillar_media" &&
      reason !== "needs_transcript" &&
      reason !== "no_segment_match"
    ) {
      return null;
    }
    return { reason, detail };
  }
  // Prefer active queue state OVER `compositionId is set`. The
  // precise-cut + Underlord flow stamps `compositionId` at end of Phase 1
  // (import) and then continues running Phase 2 (Underlord layout-pack)
  // as a follow-up invocation of `clip-idea-precise-cut`. Without this
  // precedence flip the pill would say "Descript ready" while Underlord
  // is still applying the layout pack — misleading. The agent flow
  // (`descript-clip-resolve`) finishes its task at composition stamp, so
  // there's no active queue job after — `compositionId` falls through
  // here and lands on "connected" correctly.
  let status: Status;
  let detail: string;
  let blockedReason: BlockedReason | null = null;
  // Blocked state — derivative-create raised a structured error. Surfaces
  // even when the job hasn't fully exhausted retries yet, because the
  // error is deterministic (won't fix itself) and we want the pill to
  // direct the user to the actionable resolution immediately.
  const blocked = parseBlockedReason(queueJob?.last_error ?? null);
  if (queueJob && blocked) {
    status = "blocked";
    blockedReason = blocked.reason;
    detail = blocked.detail;
  } else if (queueJob) {
    const lockedAt = queueJob.locked_at ? new Date(queueJob.locked_at) : null;
    const lockAgeMs = lockedAt ? Date.now() - lockedAt.getTime() : 0;
    const isMaxedOut =
      queueJob.attempts >= queueJob.max_attempts && queueJob.last_error;
    // Phase identifier for the detail string: "import", "Underlord
    // layout-pack", "MP4 render", or generic. Helps the editor know
    // which step they're looking at.
    const phaseLabel =
      queueJob.task_identifier === "clip-idea-precise-cut"
        ? compositionId
          ? "Underlord layout-pack"
          : "import"
        : queueJob.task_identifier === "descript-clip-resolve"
          ? "import"
          : queueJob.task_identifier === "descript-publish-and-archive"
            ? "MP4 render"
            : queueJob.task_identifier === "descript-derivative-create"
              ? "cross-post composition"
              : queueJob.task_identifier === "transcribe-whisper"
                ? "transcript (prep)"
                : queueJob.task_identifier;
    if (isMaxedOut) {
      status = "failed";
      detail = `Job exhausted ${queueJob.max_attempts} attempts. Last error: ${queueJob.last_error}`;
    } else if (lockedAt && lockAgeMs > STUCK_LOCK_MINUTES * 60_000) {
      status = "stuck";
      detail = `Job locked ${Math.floor(lockAgeMs / 60_000)} min ago by a worker that's no longer running. Re-run to release the lock.`;
    } else if (lockedAt) {
      status = "processing";
      detail = `Worker is running ${phaseLabel}. Locked ${Math.max(1, Math.floor(lockAgeMs / 1000))}s ago.`;
    } else {
      status = "processing";
      detail = `${phaseLabel} queued, run_at ${new Date(queueJob.run_at).toLocaleString()}.`;
    }
  } else if (compositionId) {
    status = "connected";
    detail = "Composition is ready in Descript.";
  } else if (trigger || projectId) {
    status = "stalled";
    detail =
      "Descript project exists but no composition was written and no queue job is active. Re-run to start fresh.";
  } else if (item.sourceClipIdeaId || item.pillarContentItemId) {
    status = "not_started";
    detail = "No Descript work has been started for this item yet.";
  } else {
    status = "not_started";
    detail = "Not a clip — Descript work isn't expected.";
  }

  return NextResponse.json({
    status,
    detail,
    blockedReason,
    /** Pillar id surfaced when the row has one, so the blocked-state pill
     *  can deep-link to "open pillar" without a second fetch. Null when
     *  this item IS the pillar (or has no pillar lineage). */
    pillarItemId: item.pillarContentItemId,
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
    /** Whether "Start Over" is available — true when this item was promoted
     *  from a clip idea AND the job is in any error/stuck/stalled state so
     *  there's actually something broken to recover from. */
    startOverAvailable:
      !!item.sourceClipIdeaId &&
      (status === "stuck" ||
        status === "failed" ||
        status === "stalled"),
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
