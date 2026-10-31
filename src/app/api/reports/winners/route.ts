import { NextRequest, NextResponse } from "next/server";
import { getRecentWinners } from "@/lib/db/winners";

// GET /api/reports/winners?brand=<slug> — the dashboard's "Beat their usual"
// strip: last 7 days' posts that beat their own account's median.
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand || brand === "all") {
    return NextResponse.json({ winners: [] });
  }
  try {
    const winners = await getRecentWinners(brand);
    return NextResponse.json({ winners });
  } catch (error) {
    console.error("Error fetching winners:", error);
    return NextResponse.json({ error: "Failed to fetch winners" }, { status: 500 });
  }
}
