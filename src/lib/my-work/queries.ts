import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import { REVIEW_STATUS, splitMyWork, type MyWorkSplit } from "./split";

const TERMINAL = ["Published", "Killed"];
const REVIEWER_WINDOW_DAYS = 30;

export const myWorkColumns = {
  id: productionItems.id,
  title: productionItems.title,
  brand: productionItems.brand,
  status: productionItems.status,
  format: productionItems.format,
  platform: productionItems.platform,
  publishedDate: productionItems.publishedDate,
  thumbnail: productionItems.thumbnail,
  editorUserId: productionItems.editorUserId,
  updatedAt: productionItems.updatedAt,
};

export type MyWorkItem = {
  id: string;
  title: string | null;
  brand: string;
  status: string | null;
  format: string | null;
  platform: string[] | null;
  publishedDate: string | null;
  thumbnail: string | null;
  editorUserId: string | null;
  updatedAt: Date;
};

/** Brands where this person moved an item out of Review in the last 30 days. */
export async function getReviewBrands(userId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ brand: productionItems.brand })
    .from(contentEvents)
    .innerJoin(productionItems, eq(productionItems.id, contentEvents.contentItemId))
    .where(
      and(
        eq(contentEvents.userId, userId),
        eq(contentEvents.eventType, "status_change"),
        sql`${contentEvents.payload}->>'from' = ${REVIEW_STATUS}`,
        sql`${contentEvents.createdAt} > now() - make_interval(days => ${REVIEWER_WINDOW_DAYS})`,
      ),
    );
  return new Set(rows.map((r) => r.brand).filter(Boolean));
}

/** Everything on this person's plate, split into your turn / to review / waiting. */
export async function getMyWork(userId: string): Promise<MyWorkSplit<MyWorkItem>> {
  const [mine, reviewBrands] = await Promise.all([
    db
      .select(myWorkColumns)
      .from(productionItems)
      .where(
        and(
          eq(productionItems.editorUserId, userId),
          sql`(${productionItems.status} IS NULL OR ${productionItems.status} NOT IN (${sql.join(
            TERMINAL.map((s) => sql`${s}`),
            sql`, `,
          )}))`,
          isNull(productionItems.deletedAt),
        ),
      )
      .orderBy(desc(productionItems.updatedAt))
      .limit(200) as Promise<MyWorkItem[]>,
    getReviewBrands(userId),
  ]);

  const inReview = reviewBrands.size
    ? ((await db
        .select(myWorkColumns)
        .from(productionItems)
        .where(
          and(
            eq(productionItems.status, REVIEW_STATUS),
            inArray(productionItems.brand, [...reviewBrands]),
            isNull(productionItems.deletedAt),
          ),
        )
        // Oldest first: the one that has waited longest gets approved first.
        .orderBy(productionItems.updatedAt)
        .limit(200)) as MyWorkItem[])
    : [];

  return splitMyWork(mine, inReview, reviewBrands);
}
