import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentEvents,
  crossPostDecisions,
  productionItems,
} from "@/lib/db/schema";
import { auth } from "@/lib/auth";

// Accept / kill a production item (primarily used by the cross-post feed).
// Captures the operator's reason, stamps a content_events row, and — when
// the item is a cross-post — mirrors the outcome onto the
// cross_post_decisions row that produced it so the LLM's feedback loop sees
// both sides.
//
// POST /api/production-items/:id/outcome
// body: { action: "accept" | "kill", reason: string }

const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 2000;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const session = await auth();
  const actorUserId = session?.user?.id ?? null;

  let body: { action?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "accept" && action !== "kill") {
    return NextResponse.json(
      { error: "action must be 'accept' or 'kill'" },
      { status: 400 }
    );
  }

  const reasonRaw = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reasonRaw.length < MIN_REASON_LENGTH) {
    return NextResponse.json(
      {
        error: `A ${action} reason of at least ${MIN_REASON_LENGTH} characters is required`,
      },
      { status: 400 }
    );
  }
  const reason = reasonRaw.slice(0, MAX_REASON_LENGTH);

  const [existing] = await db
    .select({
      id: productionItems.id,
      status: productionItems.status,
      sourceType: productionItems.sourceType,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const fromStatus = existing.status;
  const toStatus = action === "accept" ? "Assigned" : "Killed";

  try {
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(productionItems)
        .set({ status: toStatus, updatedAt: new Date() })
        .where(eq(productionItems.id, id))
        .returning();

      await tx.insert(contentEvents).values({
        contentItemId: id,
        userId: actorUserId,
        eventType: action === "accept" ? "accepted" : "killed",
        payload:
          action === "accept"
            ? { type: "accepted", from: fromStatus, reason }
            : { type: "killed", from: fromStatus, reason },
      });

      if (existing.sourceType === "cross_post") {
        await tx
          .update(crossPostDecisions)
          .set({
            outcome: action === "accept" ? "accepted" : "killed",
            outcomeReason: reason,
            outcomeAt: new Date(),
          })
          .where(
            and(
              eq(crossPostDecisions.ideaItemId, id),
              isNull(crossPostDecisions.outcome)
            )
          );
      }

      return row;
    });

    return NextResponse.json({ item: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to apply outcome: ${message}` },
      { status: 500 }
    );
  }
}
