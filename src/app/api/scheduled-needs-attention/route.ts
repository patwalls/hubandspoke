import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { countNeedsAttention } from "@/lib/services/schedule-reconcile/review";

/**
 * GET /api/scheduled-needs-attention?brand=<slug>
 *
 * Polled by the brand-scoped header banner. Returns the count of that brand's
 * Scheduled items flagged "needs attention" (couldn't be auto-marked published
 * within their surface window). Returns 0 for the "all" sentinel or a missing
 * brand so the banner stays hidden off a real brand page.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const brand = request.nextUrl.searchParams.get("brand")?.trim() ?? "";
  if (!brand || brand === "all") {
    return NextResponse.json({ count: 0 });
  }

  const count = await countNeedsAttention(brand);
  return NextResponse.json({ count });
}
