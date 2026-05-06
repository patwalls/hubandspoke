import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/repost-dismiss
 *
 * Body: { reason?: string }
 *
 * Hides a candidate from the repost queue for 30 days. Writes a
 * `content_events` row of type `repost_dismissed`. The
 * selectRepostCandidates service filters dismissed items off the live
 * query for that TTL.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id as string;

  const { id } = await context.params;

  let reason: string | null = null;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      reason?: unknown;
    };
    if (typeof body.reason === "string" && body.reason.trim().length > 0) {
      reason = body.reason.trim();
    }
  } catch {
    // empty body fine — reason is optional
  }

  const [source] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!source) {
    return NextResponse.json({ error: "Source item not found" }, { status: 404 });
  }

  await db.insert(contentEvents).values({
    contentItemId: source.id,
    userId: actorUserId,
    eventType: "repost_dismissed",
    payload: { type: "repost_dismissed", reason },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
