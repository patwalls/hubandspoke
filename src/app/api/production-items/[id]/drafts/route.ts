import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/production-items/[id]/drafts
 *
 * Read-only access to the content_drafts version chain for one item.
 *
 *   - ?version=N → return that exact historical version, or 404 if absent.
 *     Used by the activity-feed "Show full diff" expander when a draft_field
 *     `content_changed` event was truncated in the payload — the expander
 *     fetches the un-truncated value out of the source draft row.
 *   - no version param → return the array of all versions, newest-first.
 *     Cheap enough at our scale (hundreds of versions per item is already
 *     a stretch) and lets later UI iterate over the chain without N
 *     follow-up requests.
 *
 * Auth: standard session guard. No restore / write capabilities — that's
 * a separate plan.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const versionParam = request.nextUrl.searchParams.get("version");

  if (versionParam !== null) {
    const version = Number(versionParam);
    if (!Number.isInteger(version) || version < 1) {
      return NextResponse.json(
        { error: "version must be a positive integer" },
        { status: 400 },
      );
    }
    const [draft] = await db
      .select()
      .from(contentDrafts)
      .where(
        and(
          eq(contentDrafts.productionItemId, id),
          eq(contentDrafts.version, version),
        ),
      )
      .limit(1);
    if (!draft) {
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    }
    return NextResponse.json({ draft });
  }

  const drafts = await db
    .select()
    .from(contentDrafts)
    .where(eq(contentDrafts.productionItemId, id))
    .orderBy(desc(contentDrafts.version));
  return NextResponse.json({ drafts });
}
