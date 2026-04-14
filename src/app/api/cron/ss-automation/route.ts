import { NextRequest, NextResponse } from "next/server";
import { syncSSYouTubeViews } from "@/lib/services/ss-sync";
import { checkSSThresholds } from "@/lib/services/threshold-monitor";

/**
 * GET /api/cron/ss-automation
 *
 * Combined cron endpoint for Starter Story automation:
 * 1. Syncs fresh YouTube view counts from Scrape Creators API
 * 2. Checks view thresholds and creates Notion repurpose tasks
 *
 * Protected by CRON_SECRET bearer token.
 * Recommended frequency: every 6 hours.
 * Credits: 1-2 per run (one per SS YouTube channel).
 *
 * Ships with DRY_RUN=true by default. Set SS_AUTOMATION_LIVE=true to create Notion tasks.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    // Step 1: Sync fresh YouTube views
    let viewSync;
    try {
      viewSync = await syncSSYouTubeViews();
    } catch (err) {
      viewSync = { error: String(err) };
    }

    // Step 2: Check thresholds (uses freshly updated views)
    let thresholdCheck;
    try {
      thresholdCheck = await checkSSThresholds();
    } catch (err) {
      thresholdCheck = { error: String(err) };
    }

    const durationMs = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      durationMs,
      viewSync,
      thresholdCheck,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: String(err),
        durationMs: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
