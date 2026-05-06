import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { selectRepostCandidates } from "@/lib/services/repost-candidates";

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

  const result = await selectRepostCandidates({ brand });
  return NextResponse.json(result);
}
