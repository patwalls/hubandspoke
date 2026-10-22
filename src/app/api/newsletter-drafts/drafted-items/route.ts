import { NextResponse } from "next/server";
import { and, inArray, isNotNull } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";

/**
 * Queue items whose edition has a draft (drafting or saved) — the queue's
 * "Draft" badge. They stay in the queue until the email draft is created
 * (queue-status.ts).
 */
export async function GET() {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const rows = await db
    .selectDistinct({ itemId: newsletterDrafts.productionItemId })
    .from(newsletterDrafts)
    .where(and(isNotNull(newsletterDrafts.productionItemId), inArray(newsletterDrafts.status, ["drafting", "ready"])));
  return NextResponse.json({ itemIds: rows.map((r) => r.itemId) });
}
