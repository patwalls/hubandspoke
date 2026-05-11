import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { enqueue } from "@/jobs/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Manually re-drive the most recent Descript-related queue job for a
 * production_item. Surfaced as the "Re-run" button inside the Descript
 * status pill on the content detail page.
 *
 * Behavior:
 *   - Find the latest `clip-idea-precise-cut` or `descript-clip-resolve`
 *     job tied to the item's repurpose_trigger.
 *   - Release the lock (locked_at, locked_by → null) so a live worker
 *     can pick it up immediately. This handles the dominant failure
 *     mode: a dyno cycle SIGKILLs phase 1 mid-task and the lock sits
 *     for 4h until graphile-worker's default timeout.
 *   - Reset attempts to 0 and run_at to now() so a previously
 *     exhausted job retries fresh.
 *
 * Does NOT create new triggers or new Descript projects. To start over
 * (e.g. abandon a half-completed import and try a different option),
 * the caller should kill the row first and re-promote the clip-idea.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;
  try {
    return await runRedrive(id);
  } catch (err) {
    // Without this catch, anything that throws below (e.g. enqueue
    // hitting a connection issue, a malformed payload, etc.) bubbles
    // up to Next.js as an opaque 500 with no body — the toast then
    // shows "HTTP 500" with no actionable detail. Capture the message
    // and log the full error to the server so heroku logs have the
    // stack trace.
    console.error("[redrive-descript] unhandled", err);
    return NextResponse.json(
      {
        error: `Re-run failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}

async function runRedrive(id: string) {
  const [item] = await db
    .select({
      id: productionItems.id,
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
  const triggerSourceId = item.pillarContentItemId ?? item.id;
  const [trigger] = await db
    .select({
      id: repurposeTriggers.id,
      descriptJobId: repurposeTriggers.descriptJobId,
      descriptImportPath: repurposeTriggers.descriptImportPath,
    })
    .from(repurposeTriggers)
    .where(eq(repurposeTriggers.productionItemId, triggerSourceId))
    .orderBy(desc(repurposeTriggers.id))
    .limit(1);
  if (!trigger) {
    return NextResponse.json(
      { error: "No Descript trigger exists for this item — nothing to redrive." },
      { status: 400 },
    );
  }

  // graphile-worker 0.16+ stores task identifiers in `_private_tasks`; look
  // up the int task ids once, then filter by them.
  const taskIds = (await db.execute(sql`
    SELECT id, identifier FROM graphile_worker._private_tasks
    WHERE identifier IN ('clip-idea-precise-cut', 'descript-clip-resolve')
  `)) as unknown as Array<{ id: number; identifier: string }>;
  const idByName = new Map(taskIds.map((r) => [r.identifier, r.id]));
  const ids = [...idByName.values()];

  // Find the most recent job with matching triggerId, then filter by task_id in JS
  // to avoid Drizzle's array parameter expansion issue with ANY()
  const candidateJobs = ids.length
    ? ((await db.execute(sql`
        SELECT id, task_id FROM graphile_worker._private_jobs
        WHERE payload->>'triggerId' = ${trigger.id}
        ORDER BY id DESC
        LIMIT 10
      `)) as unknown as Array<{ id: number; task_id: number }>)
    : [];

  const recentJob = candidateJobs.filter((j) => ids.includes(j.task_id)).slice(0, 1);

  const updated = recentJob.length
    ? ((await db.execute(sql`
        UPDATE graphile_worker._private_jobs
        SET locked_at = NULL,
            locked_by = NULL,
            attempts = 0,
            run_at = now(),
            last_error = NULL
        WHERE id = ${recentJob[0].id}
        RETURNING id::text, task_id
      `)) as unknown as Array<{ id: string; task_id: number }>)
    : [];

  const jobResults = updated.map((r) => ({
    id: r.id,
    task_identifier:
      [...idByName.entries()].find(([, v]) => v === r.task_id)?.[0] ?? "unknown",
  }));

  const job = jobResults[0] ?? null;
  if (!job) {
    // Stalled state: trigger exists, project was created in Descript,
    // but no queue job is around to redrive (the original task either
    // exhausted its attempts and got swept, or crashed without
    // re-enqueueing the polling phase). If we still have the Descript-
    // side jobId, enqueue a fresh `descript-clip-resolve` to re-poll
    // it. The poller will either find the job stopped successfully
    // and stamp composition_id, or surface the Descript error in
    // last_error after retrying.
    if (!trigger.descriptJobId) {
      return NextResponse.json(
        {
          error:
            "No queue job and no Descript jobId on the trigger — there's nothing left to recover. Re-promote the clip from the source.",
        },
        { status: 400 },
      );
    }
    // importMode is path-derived where unambiguous; "full-video" can be
    // either cold-import or warm-duplicate, so we omit it and let the
    // task auto-detect from the job result shape.
    const importMode =
      trigger.descriptImportPath === "agent"
        ? false
        : trigger.descriptImportPath === "precise-cut"
          ? true
          : undefined;
    await enqueue("descript-clip-resolve", {
      triggerId: trigger.id,
      jobId: trigger.descriptJobId,
      derivativeItemId: id,
      pillarItemId: item.pillarContentItemId ?? undefined,
      ...(importMode !== undefined ? { importMode } : {}),
    });
    return NextResponse.json({
      ok: true,
      enqueued: { taskIdentifier: "descript-clip-resolve" },
    });
  }

  return NextResponse.json({
    ok: true,
    redriven: { jobId: job.id, taskIdentifier: job.task_identifier },
  });
}
