import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getFormatScoreboard, getRecentWinners } from "@/lib/db/winners";

// GET /api/reports/winners?brand=<slug> — the dashboard's "Beat their usual"
// strip: last 7 days' posts that beat their own account's median, plus the
// format scoreboard (last 28 days: which formats beat their usual most often).
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand || brand === "all") {
    return NextResponse.json({ winners: [], formats: [] });
  }
  try {
    const [winners, formats] = await Promise.all([getRecentWinners(brand), getFormatScoreboard(brand)]);
    return NextResponse.json({ winners, formats });
  } catch (error) {
    console.error("Error fetching winners:", error);
    return NextResponse.json({ error: "Failed to fetch winners" }, { status: 500 });
  }
}
