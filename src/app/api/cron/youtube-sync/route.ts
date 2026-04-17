import { NextRequest, NextResponse } from "next/server";
import { syncAllMATG } from "@/lib/services/matg-sync";

/**
 * GET /api/cron/youtube-sync
 *
 * Daily cron endpoint to sync all MATG platforms (YouTube, Shorts, Instagram, Twitter).
 * Protected by CRON_SECRET. Dispatched by the unified scheduler in
 * `src/lib/cron/jobs.ts` via `/api/cron/tick`. Manual trigger:
 *   curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/youtube-sync
 *
 * This uses ~4 Scrape Creators API credits per run.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncAllMATG();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Cron MATG sync error:", error);
    return NextResponse.json(
      { error: "Sync failed", success: false },
      { status: 500 }
    );
  }
}
