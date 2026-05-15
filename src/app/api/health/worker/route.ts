import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workerHeartbeat } from "@/lib/db/schema";

/**
 * Public liveness check for the worker dyno. Reads the singleton
 * `worker_heartbeat.last_seen_at` (bumped every minute by the
 * `worker-heartbeat` cron task) and returns 503 when it's stale.
 *
 * Wire an external uptime monitor (UptimeRobot, Pingdom, BetterStack)
 * to GET this every few minutes; the monitor pages when the response
 * status flips off 200. Catches the silent-worker-wedge failure mode
 * (process alive, polling dead) that Heroku's own healthchecks miss.
 *
 * Unauthenticated by design — see middleware.ts `isHealthApi` bypass.
 *
 * Threshold: 180s. The cron fires every 60s, so a 3-minute window
 * tolerates one missed tick (worker restart, deploy, brief blip)
 * without paging. Anything longer than ~3 min of silence is the wedge.
 */
const STALE_THRESHOLD_MS = 180_000;

export async function GET() {
  const [row] = await db
    .select()
    .from(workerHeartbeat)
    .where(eq(workerHeartbeat.id, "singleton"))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      {
        ok: false,
        reason: "no heartbeat row yet — worker may have never started",
      },
      { status: 503 },
    );
  }

  const ageMs = Date.now() - row.lastSeenAt.getTime();
  const ok = ageMs < STALE_THRESHOLD_MS;

  return NextResponse.json(
    {
      ok,
      lastSeenAt: row.lastSeenAt.toISOString(),
      ageSeconds: Math.round(ageMs / 1000),
      thresholdSeconds: STALE_THRESHOLD_MS / 1000,
      workerDyno: row.workerDyno,
    },
    { status: ok ? 200 : 503 },
  );
}
