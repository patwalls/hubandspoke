import { NextRequest, NextResponse } from "next/server";
import { syncAllMATG } from "@/lib/services/matg-sync";

/**
 * GET /api/cron/youtube-sync
 *
 * Daily cron endpoint to sync all MATG platforms (YouTube, Shorts, Instagram, Twitter).
 * Protected by CRON_SECRET. Set up a daily cron (e.g. Railway cron or external)
 * to call: GET /api/cron/youtube-sync with Authorization: Bearer <CRON_SECRET>
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
