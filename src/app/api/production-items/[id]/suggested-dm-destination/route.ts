import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { suggestCtaDestination } from "@/lib/services/draft-algorithm/tracked-cta";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Runs the CTA target picker (one Opus call) — give it the same headroom as the
// regenerate-cta route so a cold start doesn't 504.
export const maxDuration = 60;

/**
 * GET /api/production-items/[id]/suggested-dm-destination
 *
 * Suggests a smart Destination URL for the Attach-DM-keyword dialog: the post's
 * best CTA target (episode-first / best lead magnet) + utm_source=instagram +
 * the post's utm_campaign. Read-only — mints nothing. Fail-soft: returns
 * `{ destination: null }` on any error so the dialog just keeps its manual
 * default.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  try {
    const destination = await suggestCtaDestination({
      productionItemId: id,
      channel: "instagram",
    });
    return NextResponse.json({ destination });
  } catch (err) {
    console.error("suggested-dm-destination failed:", err);
    return NextResponse.json({ destination: null });
  }
}
