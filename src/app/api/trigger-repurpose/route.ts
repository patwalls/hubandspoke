import { NextRequest, NextResponse } from "next/server";
import { triggerRepurposeTasks } from "@/lib/services/asana";

/**
 * POST /api/trigger-repurpose
 *
 * Body: {
 *   formatId: string        – the source format whose threshold was crossed
 *   videoTitle?: string      – optional title for the Asana task name
 *   views?: number           – current view count at time of trigger
 * }
 *
 * Creates one Asana task per repurpose target and returns a summary.
 */
export async function POST(request: NextRequest) {
  try {
    const { formatId, videoTitle, views } = await request.json();

    if (!formatId) {
      return NextResponse.json(
        { error: "formatId is required" },
        { status: 400 }
      );
    }

    const result = await triggerRepurposeTasks(formatId, {
      videoTitle,
      views,
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
