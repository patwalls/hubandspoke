import { NextRequest, NextResponse } from "next/server";
import { getTopBangers, type TopBangersParams } from "@/lib/db/queries";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  const params: TopBangersParams = {
    brand: sp.get("brand") || "starter-story",
    platform: sp.get("platform") || "all",
    startDate: sp.get("startDate") || undefined,
    endDate: sp.get("endDate") || undefined,
    limit: Math.min(Number(sp.get("limit")) || 10, 50),
  };

  try {
    const data = await getTopBangers(params);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error fetching top bangers:", error);
    return NextResponse.json(
      { error: "Failed to fetch top bangers" },
      { status: 500 }
    );
  }
}
