import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { selectSpokeCandidates } from "@/lib/services/spoke-candidates";

export const dynamic = "force-dynamic";

/**
 * GET /api/spoke-queue?brand=<slug>
 *
 * Live SPOKE algorithm — scores (pillar YouTube long-form × eligible
 * format) pairs by pillar strength × format fit × freshness × pair
 * history. Returns top candidates for the "Repurposed" queue tab.
 * Re-runs on every page load (no precomputed scores).
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

  const result = await selectSpokeCandidates({ brand });
  return NextResponse.json(result);
}
