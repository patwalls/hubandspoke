import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents, productionItems, users } from "@/lib/db/schema";
import { REVIEW, type HandoffPerson } from "./pick";

const REVIEWER_WINDOW_DAYS = 30;

/** People who moved this brand's posts out of Review in 30 days, most first. */
export async function getBrandReviewers(brand: string): Promise<HandoffPerson[]> {
  const n = sql<number>`count(*)`;
  const rows = await db
    .select({ id: users.id, name: users.name, n })
    .from(contentEvents)
    .innerJoin(productionItems, eq(productionItems.id, contentEvents.contentItemId))
    .innerJoin(users, eq(users.id, contentEvents.userId))
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(contentEvents.eventType, "status_change"),
        sql`${contentEvents.payload}->>'from' = ${REVIEW}`,
        sql`${contentEvents.createdAt} > now() - make_interval(days => ${REVIEWER_WINDOW_DAYS})`,
      ),
    )
    .groupBy(users.id, users.name)
    .orderBy(desc(n))
    .limit(5);
  return rows.map((r) => ({ id: r.id, name: r.name ?? "Someone" }));
}

/** Who last moved this item into Review, if anyone. */
export async function getSentToReviewBy(itemId: string): Promise<HandoffPerson | null> {
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(contentEvents)
    .innerJoin(users, eq(users.id, contentEvents.userId))
    .where(
      and(
        eq(contentEvents.contentItemId, itemId),
        eq(contentEvents.eventType, "status_change"),
        sql`${contentEvents.payload}->>'to' = ${REVIEW}`,
      ),
    )
    .orderBy(desc(contentEvents.createdAt))
    .limit(1);
  return row ? { id: row.id, name: row.name ?? "Someone" } : null;
}

/** Who last moved each of these items into Review (My Work's rows, one query). */
export async function getSentToReviewByMany(
  itemIds: string[],
): Promise<Map<string, HandoffPerson>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([contentEvents.contentItemId], {
      itemId: contentEvents.contentItemId,
      id: users.id,
      name: users.name,
    })
    .from(contentEvents)
    .innerJoin(users, eq(users.id, contentEvents.userId))
    .where(
      and(
        inArray(contentEvents.contentItemId, itemIds),
        eq(contentEvents.eventType, "status_change"),
        sql`${contentEvents.payload}->>'to' = ${REVIEW}`,
      ),
    )
    .orderBy(contentEvents.contentItemId, desc(contentEvents.createdAt));
  return new Map(rows.map((r) => [r.itemId, { id: r.id, name: r.name ?? "Someone" }]));
}
