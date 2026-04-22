import { NextRequest, NextResponse } from "next/server";
import { enqueue } from "@/jobs/enqueue";
import type { TaskPayloads } from "@/jobs/tasks";

export const dynamic = "force-dynamic";

/**
 * Manual enqueue endpoint kept around as a debug handle. Historically this
 * was the target of a Heroku Scheduler entry that fired every 10 minutes,
 * but scheduling now lives in `src/jobs/crontab.ts` and runs inside the
 * worker dyno via graphile-worker.
 *
 *   GET /api/cron/tick               → 200 noop
 *   GET /api/cron/tick?name=my-task  → enqueues `my-task` for immediate pickup
 *
 * CRON_SECRET gate preserved for parity with the old curl commands.
 */
const SCHEDULED_TASK_NAMES: ReadonlyArray<keyof TaskPayloads> = [
  "performance-decay",
  "notion-sync",
  "enrichment-sweep",
  "matg-sync",
  "evergreen-scan",
  "cross-post-scan",
];

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const forceName = request.nextUrl.searchParams.get("name");
  if (!forceName) {
    return NextResponse.json({
      noop: true,
      note: "Scheduling moved to graphile-worker crontab in src/jobs/crontab.ts. This endpoint is now a manual enqueue only — pass ?name=<task>.",
    });
  }

  const match = SCHEDULED_TASK_NAMES.find((n) => n === forceName);
  if (!match) {
    return NextResponse.json(
      { error: `Unknown task: ${forceName}. Valid: ${SCHEDULED_TASK_NAMES.join(", ")}` },
      { status: 404 }
    );
  }

  await enqueue(match, {} as never);
  return NextResponse.json({ ok: true, enqueued: match });
}
