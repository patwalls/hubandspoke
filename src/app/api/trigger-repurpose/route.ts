import { NextRequest, NextResponse } from "next/server";
import { triggerRepurposeTasks } from "@/lib/services/asana";

/**
 * POST /api/trigger-repurpose
 *
 * Body: {
 *   formatId: string                  – the source format whose threshold was crossed
 *   sourceProductionItemId?: string    – the production item ID (for pillar content title)
 *   videoTitle?: string               – fallback title if sourceProductionItemId not provided
 *   views?: number                    – current view count at time of trigger
 *   contentLink?: string              – link to the content
 * }
 *
 * Creates one Asana task per repurpose target and returns a summary.
 * Task names follow the format: "{sourceFormat} → {targetFormat} ({pillarContentTitle})"
 */
export async function POST(request: NextRequest) {
  try {
    const { formatId, sourceProductionItemId, videoTitle, views, contentLink } =
      await request.json();

    if (!formatId) {
      return NextResponse.json(
        { error: "formatId is required" },
        { status: 400 }
      );
    }

    const result = await triggerRepurposeTasks(formatId, {
      sourceProductionItemId,
      videoTitle,
      views,
      contentLink,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("Error triggering repurpose tasks:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
