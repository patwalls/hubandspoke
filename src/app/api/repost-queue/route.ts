import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { selectRepostCandidates } from "@/lib/services/repost-candidates";
import { getRepostCandidatesCached } from "@/lib/services/queue-candidates-cached";
import { invalidateQueueCaches } from "@/lib/invalidate-report-caches";

export const dynamic = "force-dynamic";

/**
 * GET /api/repost-queue?brand=<slug>
 *
 * Live query — no cron, no pre-populated Idea rows. Returns elite
 * evergreen candidates: posts that outperformed the (format, account)
 * cohort by ≥1.5× P75 (with brand → cross-brand fallbacks). Results
 * sorted by hotness ratio desc.
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
  const result = fresh ? await selectRepostCandidates({ brand }) : await getRepostCandidatesCached(brand);
  return NextResponse.json(result);
}
