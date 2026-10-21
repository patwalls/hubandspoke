import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ itemId: string }>;
}

/** The newsletter edition (editor draft) behind a queue item, so the queue can open the newsletter editor. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { itemId } = await context.params;
  const [row] = await db
    .select({ id: newsletterDrafts.id })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.productionItemId, itemId))
    .limit(1);
  if (!row) return NextResponse.json({ error: "No newsletter edition for this item" }, { status: 404 });
  return NextResponse.json({ draftId: row.id });
}
