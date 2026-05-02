import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { selectCrossPostCandidates } from "@/lib/services/cross-post-candidates";

export const dynamic = "force-dynamic";

/**
 * GET /api/cross-post-queue?brand=<slug>
 *
 * Returns the list of high-performing source posts (top 25% within their
 * format over the last 90 days, published in the last 7 days) plus the
 * brand's accounts so the modal can render eligible target cards. Live
 * query — re-runs on every page load.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand) {
    return NextResponse.json(
      { error: "brand query param is required" },
      { status: 400 }
    );
  }

  const result = await selectCrossPostCandidates({ brand });
  return NextResponse.json(result);
}
