import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { attachDmKeyword } from "@/lib/services/dm-keyword";
import { ShortLinksApiError } from "@/lib/services/short-links";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/dm-keyword  { keywordSlug, destinationUrl }
 *
 * Wires an Instagram post's ManyChat DM keyword into per-post tracking via a
 * go→go chain — see `attachDmKeyword` (src/lib/services/dm-keyword.ts),
 * which the design editor also uses to attach a keyword automatically.
 * Returns the resolved chain; the item's `short_link_slug` is set.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { keywordSlug?: unknown; destinationUrl?: unknown };
  try {
    return NextResponse.json(await attachDmKeyword({ itemId: id, keywordSlug: String(body.keywordSlug ?? ""), destinationUrl: String(body.destinationUrl ?? "").trim() }));
  } catch (err) {
    if (err instanceof ShortLinksApiError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : String(err);
    console.error("dm-keyword chain failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
