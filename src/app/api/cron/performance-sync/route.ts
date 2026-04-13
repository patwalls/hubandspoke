import { NextRequest, NextResponse } from "next/server";
import { syncPerformanceData } from "@/lib/services/performance-decay";

/**
 * GET /api/cron/performance-sync
 *
 * Hourly cron endpoint that updates content performance metrics
 * using a decay schedule. Fresh content syncs often, old content rarely.
 *
 * No cooldown needed — the decay logic self-throttles by only syncing
 * items that are actually due based on their age and last sync time.
 *
 * Protected by CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncPerformanceData();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Cron performance sync error:", error);
    return NextResponse.json(
      { error: "Performance sync failed", success: false },
      { status: 500 }
    );
  }
}
