import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { countReadyToPublish } from "@/lib/publish/ready";

/**
 * GET /api/publish/ready-count?brand=<slug>
 *
 * The number on the Publish tab: how many of the brand's posts are Ready To
 * Publish. Fetched once per brand switch (and after a publish on the Publish
 * screen), never on a timer. 0 for "all" or a missing brand.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const brand = request.nextUrl.searchParams.get("brand")?.trim() ?? "";
  if (!brand || brand === "all") {
    return NextResponse.json({ count: 0 });
  }
  return NextResponse.json({ count: await countReadyToPublish(brand) });
}
