import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { selectSpokeCandidates } from "@/lib/services/spoke-candidates";
import { getSpokeCandidatesCached } from "@/lib/services/queue-candidates-cached";
import { invalidateQueueCaches } from "@/lib/invalidate-report-caches";

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

  // `fresh=1` (the queue's refetch after a triage action): recompute and
  // reset the shared entry so the next plain load doesn't serve the row
  // that was just dismissed. See services/queue-candidates-cached.ts.
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  if (fresh) invalidateQueueCaches();
  const result = fresh ? await selectSpokeCandidates({ brand }) : await getSpokeCandidatesCached(brand);
  return NextResponse.json(result);
}
