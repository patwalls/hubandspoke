import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

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
    .select({ id: repurposeTriggers.id })
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

  const updated = (await db.execute(sql`
    UPDATE graphile_worker._private_jobs
    SET locked_at = NULL,
        locked_by = NULL,
        attempts = 0,
        run_at = now(),
        last_error = NULL
    WHERE task_identifier IN ('clip-idea-precise-cut', 'descript-clip-resolve')
      AND payload->>'triggerId' = ${trigger.id}
      AND id IN (
        SELECT id FROM graphile_worker._private_jobs
        WHERE task_identifier IN ('clip-idea-precise-cut', 'descript-clip-resolve')
          AND payload->>'triggerId' = ${trigger.id}
        ORDER BY id DESC
        LIMIT 1
      )
    RETURNING id::text, task_identifier
  `)) as unknown as Array<{ id: string; task_identifier: string }>;

  const job = updated[0] ?? null;
  if (!job) {
    return NextResponse.json(
      {
        error:
          "No queue job found for this trigger. The original task may have completed or never been enqueued.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    redriven: { jobId: job.id, taskIdentifier: job.task_identifier },
  });
}
