import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getScheduledReviewData } from "@/lib/services/schedule-reconcile/review";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduled-matches?brand=<slug>
 *
 * Returns the Scheduled review surface data: borderline match suggestions
 * (55–84 confidence) awaiting a human Confirm/Reject, plus Scheduled items
 * the reconciler gave up on (needs-attention).
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand) {
    return NextResponse.json(
      { error: "brand query param is required" },
      { status: 400 },
    );
  }

  const data = await getScheduledReviewData(brand);
  return NextResponse.json(data);
}
