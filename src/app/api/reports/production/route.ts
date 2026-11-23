import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getProductionReportFast } from "@/lib/services/production-report";
import { isFeatureEnabled } from "@/lib/feature-flags";

// Thin envelope — the report itself lives in
// src/lib/services/production-report.ts (shared with the queue page's SSR
// and /api/warm; 60s cache). A slow rebuild answers with the last report
// and `stale: true`; the page asks again (services/production-report.ts).
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand") || "starter-story";
  const excludeIdea = request.nextUrl.searchParams.get("excludeIdea") === "true";
  // The queue's "Last 30 days" view (flag queueRecentOnly): recent Idea rows
  // + counts of the older ones.
  const recentIdeas =
    !excludeIdea &&
    request.nextUrl.searchParams.get("ideas") === "recent" &&
    isFeatureEnabled("queueRecentOnly", guard.session?.user);
  try {
    const data = await getProductionReportFast(
      brand,
      excludeIdea ? "no-ideas" : recentIdeas ? "recent-ideas" : "all",
    );
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error generating production pipeline:", error);
    return NextResponse.json(
      { error: "Failed to generate production pipeline" },
      { status: 500 }
    );
  }
}
