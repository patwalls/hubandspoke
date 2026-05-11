import { NextRequest, NextResponse } from "next/server";
import { findDuplicates } from "@/lib/services/find-duplicates";
import { requireSession } from "@/lib/auth-guards";

/**
 * Find potential duplicate items for a brand.
 *
 * Query parameters:
 * - brand (required): Brand slug (e.g., "matg")
 * - limit (optional): Max pairs to return (default 50, max 500)
 * - onlyUnmerged (optional): Skip already-merged pairs (default true)
 *
 * Response:
 * {
 *   duplicatePairs: [
 *     {
 *       pair_id: string,
 *       primary: { id, title, platform, published_date, views, sourceType },
 *       secondary: { id, title, platform, published_date, views, sourceType },
 *       confidence: number (0-100),
 *       reason: string
 *     }
 *   ],
 *   total: number
 * }
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  try {
    const { searchParams } = new URL(request.url);
    const brand = searchParams.get("brand");
    const limitStr = searchParams.get("limit");
    const onlyUnmergedStr = searchParams.get("onlyUnmerged");

    if (!brand) {
      return NextResponse.json(
        { error: "Missing required parameter: brand" },
        { status: 400 }
      );
    }

    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 500) : 50;
    const onlyUnmerged = onlyUnmergedStr !== "false";

    const pairs = await findDuplicates(brand, { limit, onlyUnmerged });

    return NextResponse.json({
      duplicatePairs: pairs,
      total: pairs.length,
    });
  } catch (err) {
    console.error("[find-duplicates] error:", err);
    return NextResponse.json(
      { error: "Failed to find duplicates" },
      { status: 500 }
    );
  }
}
