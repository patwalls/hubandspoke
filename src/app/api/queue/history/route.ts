import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  contentEvents,
  productionItems,
  users,
  type ContentEventPayload,
} from "@/lib/db/schema";

export const dynamic = "force-dynamic";

// "How much has moved through the queue" — every event where an item left
// the Idea state, brand-scoped, last 30 days, capped at 100 rows. Reads from
// content_events, which is already populated by the existing PUT/POST
// production-items routes — no schema changes, no backfill needed.

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 100;

const HISTORY_EVENT_TYPES = ["killed", "accepted", "status_change"] as const;

export interface QueueHistoryEvent {
  id: string;
  contentItemId: string;
  eventType: string;
  payload: ContentEventPayload;
  createdAt: string;
  actor: { id: string; name: string | null; email: string | null } | null;
  item: {
    title: string | null;
    sourceType: string | null;
    format: string | null;
    postType: string | null;
    currentStatus: string | null;
    brand: string | null;
  };
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand) {
    return NextResponse.json(
      { error: "brand query param required" },
      { status: 400 },
    );
  }

  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const daysParam = Number(request.nextUrl.searchParams.get("days"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 500)
      : DEFAULT_LIMIT;
  const days =
    Number.isFinite(daysParam) && daysParam > 0
      ? Math.min(daysParam, 365)
      : DEFAULT_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: contentEvents.id,
      contentItemId: contentEvents.contentItemId,
      eventType: contentEvents.eventType,
      payload: contentEvents.payload,
      createdAt: contentEvents.createdAt,
      actorId: users.id,
      actorName: users.name,
      actorEmail: users.email,
      itemTitle: productionItems.title,
      itemSourceType: productionItems.sourceType,
      itemFormat: productionItems.format,
      itemPostType: productionItems.postType,
      itemStatus: productionItems.status,
      itemBrand: productionItems.brand,
    })
    .from(contentEvents)
    .innerJoin(
      productionItems,
      eq(productionItems.id, contentEvents.contentItemId),
    )
    .leftJoin(users, eq(users.id, contentEvents.userId))
    .where(
      and(
        inArray(contentEvents.eventType, [...HISTORY_EVENT_TYPES]),
        gte(contentEvents.createdAt, since),
        isNull(productionItems.deletedAt),
        ...(brand === "all" ? [] : [eq(productionItems.brand, brand)]),
        // Only events that took the item OUT of the Idea state are queue
        // movements. status_change events from other transitions (Assigned →
        // Review, etc.) are noise for this view.
        sql`${contentEvents.payload}->>'from' = 'Idea'`,
      ),
    )
    .orderBy(desc(contentEvents.createdAt))
    .limit(limit);

  const events: QueueHistoryEvent[] = rows.map((r) => ({
    id: r.id,
    contentItemId: r.contentItemId,
    eventType: r.eventType,
    payload: r.payload as ContentEventPayload,
    createdAt: r.createdAt.toISOString(),
    actor: r.actorId
      ? { id: r.actorId, name: r.actorName, email: r.actorEmail }
      : null,
    item: {
      title: r.itemTitle,
      sourceType: r.itemSourceType,
      format: r.itemFormat,
      postType: r.itemPostType,
      currentStatus: r.itemStatus,
      brand: r.itemBrand,
    },
  }));

  return NextResponse.json({ events });
}
