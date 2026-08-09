import { NextRequest, NextResponse } from "next/server";
import { getProductionReportCached } from "@/lib/services/production-report";

// Thin envelope — the report itself lives in
// src/lib/services/production-report.ts (shared with the queue page's SSR
// and /api/warm; 60s cache).
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "starter-story";
  const excludeIdea = request.nextUrl.searchParams.get("excludeIdea") === "true";
  try {
    const data = await getProductionReportCached(brand, excludeIdea);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error generating production pipeline:", error);
    return NextResponse.json(
      { error: "Failed to generate production pipeline" },
      { status: 500 }
    );
  }
}
