import { NextRequest, NextResponse } from "next/server";
import { loadCrossPostFeedData } from "@/lib/services/cross-post-feed-data";

// GET /api/cross-post-feed?brand=<slug>
// Returns { pending, recent, feedback } for the cross-post feed UI. Used by
// the standalone /accounts/cross-posting page and by the Queue's Cross-post
// tab so both surfaces show the same rich data.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const brand = req.nextUrl.searchParams.get("brand");
  if (!brand) {
    return NextResponse.json(
      { error: "brand query param required" },
      { status: 400 }
    );
  }
  const data = await loadCrossPostFeedData(brand);
  return NextResponse.json(data);
}
