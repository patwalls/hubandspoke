import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { countReadyToPublish } from "@/lib/publish/ready";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/publish/ready-count?brand=<slug>[&pillar=<itemId>]
 *
 * The number on the Publish tab: how many of the brand's posts are Ready To
 * Publish. With `pillar`, only that pillar's posts (the content page's Publish
 * dialog uses it to offer the Publish tab when siblings are waiting). Fetched once per brand switch (and after a publish on the Publish
 * screen), never on a timer. 0 for "all" or a missing brand.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const brand = request.nextUrl.searchParams.get("brand")?.trim() ?? "";
  if (!brand || brand === "all") {
    return NextResponse.json({ count: 0 });
  }
  const pillar = request.nextUrl.searchParams.get("pillar")?.trim() || null;
  if (pillar && !UUID_RE.test(pillar)) {
    return NextResponse.json({ count: 0 });
  }
  return NextResponse.json({ count: await countReadyToPublish(brand, pillar) });
}
