import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { selectCrossPostCandidates } from "@/lib/services/cross-post-candidates";
import { getCrossPostCandidatesCached } from "@/lib/services/queue-candidates-cached";
import { invalidateQueueCaches } from "@/lib/invalidate-report-caches";
import { fetchChannelReach } from "@/lib/channel-reach-query";

export const dynamic = "force-dynamic";

/**
 * GET /api/cross-post-queue?brand=<slug>
 *
 * Returns the list of high-performing source posts (top 25% within their
 * format over the last 90 days, published in the last 7 days) plus the
 * brand's accounts so the modal can render eligible target cards. Live
 * query — re-runs on every page load. Also returns `channelReach` (what each
 * target typically gets over 30 days), drawn quietly on the picker's rows.
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

  // `fresh=1` (the queue's refetch after a triage action): recompute and
  // reset the shared entry so the next plain load doesn't serve the row
  // that was just dismissed. See services/queue-candidates-cached.ts.
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  if (fresh) invalidateQueueCaches();
  const [result, channelReach] = await Promise.all([
    fresh ? selectCrossPostCandidates({ brand }) : getCrossPostCandidatesCached(brand),
    // Reach is a nicety: a failed read draws the picker without it.
    fetchChannelReach(brand).catch(() => ({})),
  ]);
  return NextResponse.json({ ...result, channelReach });
}
