import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import { enrichSingleItem } from "@/lib/services/enrichment/orchestrator";
import { ScrapeCreatorsError } from "@/lib/services/sc-client";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// download_media for IG can take a while — give the worst-case enricher room.
export const maxDuration = 180;

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const force = request.nextUrl.searchParams.get("force") === "true";
  const withMedia =
    request.nextUrl.searchParams.get("withMedia") === "true";

  try {
    const result = await enrichSingleItem(id, { force, withMedia });
    if (!result) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason:
          "Item is already enriched (pass ?force=true to re-run) or has no supported platform",
      });
    }
    return NextResponse.json({
      ok: true,
      creditsSpent: result.creditsSpent,
      fields: result.fields,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ScrapeCreatorsError ? err.status : 500;
    return NextResponse.json(
      { ok: false, error: message },
      { status: status === 404 ? 404 : 502 }
    );
  }
}
