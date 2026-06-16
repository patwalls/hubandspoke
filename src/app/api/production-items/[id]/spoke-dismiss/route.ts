import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { contentEvents, formats, productionItems } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/spoke-dismiss
 *
 * `[id]` is the PILLAR production_item. Body: { targetFormatId, reason? }.
 *
 * Hides a single (pillar, format) pair from the "Repurposed" SPOKE queue for
 * 30 days. Writes a `content_events` row of type `spoke_dismissed` carrying
 * the target format id, so killing one derivative format doesn't hide the
 * pillar's other candidate formats. `selectSpokeCandidates` filters the pair
 * off the live query for that TTL. `reason` distinguishes "Not interested"
 * (null) from "Kill this idea" (a written reason) — mirrors repost-dismiss.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id as string;

  const { id } = await context.params;

  let body: { targetFormatId?: unknown; reason?: unknown };
  try {
    body = (await request.json().catch(() => ({}))) as {
      targetFormatId?: unknown;
      reason?: unknown;
    };
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON" },
      { status: 400 },
    );
  }

  const targetFormatId =
    typeof body.targetFormatId === "string" && body.targetFormatId.trim()
      ? body.targetFormatId.trim()
      : "";
  if (!targetFormatId) {
    return NextResponse.json(
      { error: "targetFormatId is required" },
      { status: 400 },
    );
  }

  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : null;

  const [pillar] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!pillar) {
    return NextResponse.json(
      { error: "Pillar item not found" },
      { status: 404 },
    );
  }

  const [target] = await db
    .select({ id: formats.id })
    .from(formats)
    .where(eq(formats.id, targetFormatId))
    .limit(1);
  if (!target) {
    return NextResponse.json(
      { error: "Target format not found" },
      { status: 404 },
    );
  }

  await db.insert(contentEvents).values({
    contentItemId: pillar.id,
    userId: actorUserId,
    eventType: "spoke_dismissed",
    payload: { type: "spoke_dismissed", formatId: target.id, reason },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
