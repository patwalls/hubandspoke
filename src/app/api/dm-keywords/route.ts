import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { listDmKeywordPool } from "@/lib/services/dm-keyword";
import { ShortLinksApiError } from "@/lib/services/short-links";
import { RebrandlyApiError } from "@/lib/services/rebrandly";

/**
 * GET /api/dm-keywords?brand=<slug>
 *
 * The ManyChat DM keyword pool for a brand on Rebrandly (MATG / MFM): its
 * "<prefix>-<keyword>" clickhubspot.com links with clicks, last click, current
 * destination (followed through the current post's own link), and which
 * posts they're attached to. Same row shape as `/api/short-links?tag=dm` so the
 * Attach DM keyword dialog renders both. With `itemId`, also returns that
 * post's own link (`postLink`: its destination + clicks).
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand") ?? "";
  const itemId = request.nextUrl.searchParams.get("itemId") ?? undefined;
  try {
    return NextResponse.json(await listDmKeywordPool(brand, { itemId }));
  } catch (err) {
    if (err instanceof ShortLinksApiError || err instanceof RebrandlyApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("dm-keywords pool failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
