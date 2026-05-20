import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guards";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface QueueJobRow {
  id: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_at: string | null;
  last_error: string | null;
}

/**
 * Reports whether the Draft Algorithm is queued/running for this
 * production_item, so the content-detail simulator can lock the caption
 * field and overlay a "Drafting…" indicator while it's in flight.
 *
 * Without this, an editor who opens the page right after a clip-promote
 * (which auto-fires `draft-algorithm-run`) might start typing in the
 * caption — only to have their text obliterated when the algorithm
 * writes its draft a few seconds later. The lock is best-effort UX,
 * not a hard guarantee: the algorithm's own idempotency guard refuses
 * to overwrite a draft that already has non-seeded content, so a race
 * past the lock just means the editor's text wins (the algorithm bails
 * silently). The lock is the friendlier UX of the two.
 *
 * Returns:
 *   - state="running"  if there is an active draft-algorithm-run job
 *     for this id (locked OR queued).
 *   - state="idle"     otherwise.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const rows = (await db.execute(sql`
    SELECT j.id::text,
           j.attempts,
           j.max_attempts,
           j.run_at,
           j.locked_at,
           j.last_error
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    WHERE t.identifier = 'draft-algorithm-run'
      AND j.payload->>'productionItemId' = ${id}
    ORDER BY j.id DESC
    LIMIT 1
  `)) as unknown as QueueJobRow[];
  const row = rows[0] ?? null;

  if (!row) {
    return NextResponse.json({
      state: "idle" as const,
      queueJob: null,
    });
  }

  // Exhausted-retry jobs aren't "running" anymore — they failed and
  // graphile-worker is no longer trying. Surface as idle so the lock
  // doesn't stick on an errored item until manual cleanup.
  const exhausted = row.attempts >= row.max_attempts && row.last_error;
  if (exhausted) {
    return NextResponse.json({
      state: "idle" as const,
      queueJob: {
        id: row.id,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        runAt: row.run_at,
        lockedAt: row.locked_at,
        lastError: row.last_error,
      },
    });
  }

  return NextResponse.json({
    state: "running" as const,
    queueJob: {
      id: row.id,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      runAt: row.run_at,
      lockedAt: row.locked_at,
      lastError: row.last_error,
    },
  });
}
