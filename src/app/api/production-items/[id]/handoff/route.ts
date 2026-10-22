import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getBrandReviewers, getSentToReviewBy } from "@/lib/handoff/queries";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/production-items/[id]/handoff
 *
 * What the content page's handoff button needs (rules in
 * src/lib/handoff/pick.ts): you, the brand's reviewers (most approvals in 30
 * days first) and who last sent this item to review. Read-only; the handoff
 * itself is the usual PUT /api/production-items with status + editorUserId.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const me = guard.session.user.id ?? null;

  const { id } = await context.params;
  const [item] = await db
    .select({ brand: productionItems.brand })
    .from(productionItems)
    .where(and(eq(productionItems.id, id), isNull(productionItems.deletedAt)))
    .limit(1);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [reviewers, sentToReviewBy] = await Promise.all([
    item.brand ? getBrandReviewers(item.brand) : Promise.resolve([]),
    getSentToReviewBy(id),
  ]);
  return NextResponse.json({ me, reviewers, sentToReviewBy });
}
