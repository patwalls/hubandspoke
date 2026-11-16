import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import { REVIEW } from "@/lib/handoff/pick";
import { loadDeliveryLinks } from "@/lib/production/delivery-link-query";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/production-items/[id]/delivery-link
 *
 * The content page's Review chip ("↗ YouTube Studio"): the link the editor
 * handed the work back with, picked the same way as the In Production list's
 * Review rows (lib/production/delivery-link). `{ link: null }` unless the
 * post is in Review and a comment since then carries a link. Two small reads.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [item] = await db
    .select({ status: productionItems.status, createdAt: productionItems.createdAt })
    .from(productionItems)
    .where(and(eq(productionItems.id, id), isNull(productionItems.deletedAt)))
    .limit(1);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (item.status !== REVIEW) return NextResponse.json({ link: null });

  const [entered] = await db
    .select({ at: contentEvents.createdAt })
    .from(contentEvents)
    .where(
      and(
        eq(contentEvents.contentItemId, id),
        eq(contentEvents.eventType, "status_change"),
        sql`${contentEvents.payload}->>'to' = ${REVIEW}`,
      ),
    )
    .orderBy(desc(contentEvents.createdAt))
    .limit(1);
  const links = await loadDeliveryLinks([{ id, statusSince: entered?.at ?? item.createdAt }]);
  return NextResponse.json({ link: links.get(id) ?? null });
}
