import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { enqueue } from "@/jobs/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Re-drive the most recent typefully-create-draft job for a production_item,
 * or enqueue a fresh one if no prior job exists. Surfaced as the "Re-run"
 * button in the Typefully status pill.
 *
 * Behavior:
 *   - If a queue job exists: release lock + reset attempts + bump run_at to
 *     now() so a live worker picks it up immediately.
 *   - If no queue job exists (e.g. the original enqueue call failed): enqueue
 *     a brand-new typefully-create-draft job.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [item] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = (await db.execute(sql`
    UPDATE graphile_worker._private_jobs
    SET locked_at = NULL,
        locked_by = NULL,
        attempts = 0,
        run_at = now(),
        last_error = NULL
    WHERE task_identifier = 'typefully-create-draft'
      AND payload->>'productionItemId' = ${id}
      AND id IN (
        SELECT id FROM graphile_worker._private_jobs
        WHERE task_identifier = 'typefully-create-draft'
          AND payload->>'productionItemId' = ${id}
        ORDER BY id DESC
        LIMIT 1
      )
    RETURNING id::text, task_identifier
  `)) as unknown as Array<{ id: string; task_identifier: string }>;

  if (updated[0]) {
    return NextResponse.json({
      ok: true,
      redriven: {
        jobId: updated[0].id,
        taskIdentifier: updated[0].task_identifier,
      },
    });
  }

  // No prior job — enqueue fresh.
  await enqueue("typefully-create-draft", { productionItemId: id });
  return NextResponse.json({ ok: true, enqueued: true });
}
