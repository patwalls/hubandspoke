import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { scheduledMatchSuggestions } from "@/lib/db/schema";
import { requireBrandEdit } from "@/lib/auth-guards";
import { brandOfProductionItem } from "@/lib/brand-access";
import { reconcileScheduledIntoPublished } from "@/lib/services/merge-production-items";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/scheduled-matches/[id]
 * Body: { action: "confirm" | "reject" }
 *
 * confirm → reconcile the Scheduled item into the candidate published post
 *   (Scheduled item becomes Published, candidate is absorbed) and mark the
 *   suggestion confirmed.
 * reject  → mark the suggestion rejected; the item stays Scheduled and the
 *   matcher won't re-propose this pair.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
  };
  const action = body.action;
  if (action !== "confirm" && action !== "reject") {
    return NextResponse.json(
      { error: "Body must include action: 'confirm' | 'reject'." },
      { status: 400 },
    );
  }

  const [suggestion] = await db
    .select({
      id: scheduledMatchSuggestions.id,
      scheduledItemId: scheduledMatchSuggestions.scheduledItemId,
      candidateItemId: scheduledMatchSuggestions.candidateItemId,
      status: scheduledMatchSuggestions.status,
    })
    .from(scheduledMatchSuggestions)
    .where(eq(scheduledMatchSuggestions.id, id))
    .limit(1);

  if (!suggestion) {
    return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
  }
  // Confirming rewrites both items (the candidate is absorbed), so the
  // caller needs edit access to each item's brand.
  const guard = await requireBrandEdit(await brandOfProductionItem(suggestion.scheduledItemId));
  if (guard.response) return guard.response;
  const candidateGuard = await requireBrandEdit(await brandOfProductionItem(suggestion.candidateItemId));
  if (candidateGuard.response) return candidateGuard.response;
  const actorUserId = (guard.session.user.id as string | undefined) ?? null;
  if (suggestion.status !== "pending") {
    return NextResponse.json(
      { error: `Suggestion already ${suggestion.status}` },
      { status: 409 },
    );
  }

  const now = new Date();

  if (action === "reject") {
    await db
      .update(scheduledMatchSuggestions)
      .set({
        status: "rejected",
        resolvedAt: now,
        resolvedBy: actorUserId,
        updatedAt: now,
      })
      .where(eq(scheduledMatchSuggestions.id, id));
    return NextResponse.json({ status: "rejected" });
  }

  // confirm → reconcile
  const result = await reconcileScheduledIntoPublished(
    suggestion.scheduledItemId,
    suggestion.candidateItemId,
    actorUserId,
  );
  if (!result.success) {
    return NextResponse.json({ error: result.message }, { status: 422 });
  }

  await db
    .update(scheduledMatchSuggestions)
    .set({
      status: "confirmed",
      resolvedAt: now,
      resolvedBy: actorUserId,
      updatedAt: now,
    })
    .where(eq(scheduledMatchSuggestions.id, id));

  // Any other pending suggestions for the same now-published item are moot.
  await db
    .update(scheduledMatchSuggestions)
    .set({ status: "superseded", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(scheduledMatchSuggestions.scheduledItemId, suggestion.scheduledItemId),
        eq(scheduledMatchSuggestions.status, "pending"),
        ne(scheduledMatchSuggestions.id, id),
      ),
    );

  return NextResponse.json({
    status: "confirmed",
    publishedItemId: result.publishedItemId,
  });
}
