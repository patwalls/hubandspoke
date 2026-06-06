import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import {
  findShortLinksByContent,
  ShortLinksApiError,
} from "@/lib/services/short-links";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/production-items/[id]/cta-link
 *
 * Returns the tracking link minted for this post's CTA (one per post), with its
 * click count, so the content detail can surface "N clicks" next to the CTA.
 * Returns `{ shortLink: null }` when no CTA link has been minted yet.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  try {
    const links = await findShortLinksByContent(id);
    // One link per post; prefer the active one. Null when none minted yet.
    const link = links.find((l) => !l.archived) ?? links[0] ?? null;
    if (!link) return NextResponse.json({ shortLink: null });
    return NextResponse.json({
      shortLink: {
        slug: link.slug,
        clicksCount: link.clicksCount,
        lastClickedAt: link.lastClickedAt,
        destinationUrl: link.destinationUrl,
        targetType: link.targetType,
      },
    });
  } catch (err) {
    // Short-links service unconfigured / down: treat as "no stats" rather than
    // erroring the panel.
    if (err instanceof ShortLinksApiError) {
      return NextResponse.json({ shortLink: null });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("cta-link stats failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
