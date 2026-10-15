import { NextResponse } from "next/server";
import { evaluateQueueHealth, loadQueueHealthRows } from "@/lib/services/queue-health";

/**
 * Public queue-health check — the complement of `/api/health/worker`.
 * That one says "the worker process is alive"; this one says "work is
 * actually flowing": no due job waiting > 15 min, no lock held by a dead
 * pool > 5 min, no clip render stalled. 503 + `reasons` otherwise.
 *
 * Polled by `.github/workflows/health-monitor.yml` (every 5 min, off
 * Heroku) and the home-Mac probe (`home-machine/health-probe/`), and read
 * by the ops lap. Unauthenticated by design — middleware.ts `isHealthApi`
 * bypass; the body names queues, pool ids and render ids, nothing secret.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = evaluateQueueHealth(await loadQueueHealthRows());
    return NextResponse.json(health, { status: health.ok ? 200 : 503 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reasons: [`health query failed: ${err instanceof Error ? err.message : String(err)}`] },
      { status: 503 },
    );
  }
}
