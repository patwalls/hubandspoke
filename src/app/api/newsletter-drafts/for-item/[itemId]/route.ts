import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ itemId: string }>;
}

/**
 * The newsletter edition (editor draft) behind a queue item, so the queue can
 * open it: an undrafted one (`idea`) opens the start dialog prefilled with its
 * format, send date, pillar and angle; anything else opens the editor.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { itemId } = await context.params;
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      status: newsletterDrafts.status,
      brand: newsletterDrafts.brand,
      formatId: newsletterDrafts.formatId,
      sendDate: newsletterDrafts.sendDate,
      sourceItemId: newsletterDrafts.sourceItemId,
      sourcePinned: newsletterDrafts.sourcePinned,
      notes: newsletterDrafts.notes,
    })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.productionItemId, itemId))
    .limit(1);
  if (!row) return NextResponse.json({ error: "No newsletter edition for this item" }, { status: 404 });
  const { id, ...edition } = row;
  return NextResponse.json({ draftId: id, edition });
}
