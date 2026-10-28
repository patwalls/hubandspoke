import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import {
  OFF_PLATE_STATUSES,
  REVIEW_STATUS,
  YOUR_TURN_STATUSES,
  reviewLane,
  splitMyWork,
  type MyWorkSplit,
  type ReviewLanes,
} from "./split";
import { htmlToPlainText } from "@/lib/comments/sanitize";
import { rowNews, type RowNews } from "./news";
import { buildMyWorkDigest } from "./digest";

const REVIEWER_WINDOW_DAYS = 30;

export const myWorkColumns = {
  id: productionItems.id,
  title: productionItems.title,
  brand: productionItems.brand,
  status: productionItems.status,
  format: productionItems.format,
  platform: productionItems.platform,
  postType: productionItems.postType,
  publishedDate: productionItems.publishedDate,
  thumbnail: productionItems.thumbnail,
  editorUserId: productionItems.editorUserId,
  updatedAt: productionItems.updatedAt,
  repostedFromItemId: productionItems.repostedFromItemId,
  pillarContentItemId: productionItems.pillarContentItemId,
};

export type MyWorkItem = {
  id: string;
  title: string | null;
  brand: string;
  status: string | null;
  format: string | null;
  platform: string[] | null;
  postType: string | null;
  publishedDate: string | null;
  thumbnail: string | null;
  editorUserId: string | null;
  updatedAt: Date;
  /** What it was made from (Up next offers siblings first). */
  repostedFromItemId?: string | null;
  pillarContentItemId?: string | null;
};

/**
 * The lanes (brand + format) where anyone moved an item out of Review in the
 * last 30 days, and which of them this person did — see `ReviewLanes`.
 */
export async function getReviewLanes(userId: string): Promise<ReviewLanes> {
  const rows = await db
    .selectDistinct({
      brand: productionItems.brand,
      format: productionItems.format,
      isMine: sql<boolean>`${contentEvents.userId} = ${userId}::uuid`,
    })
    .from(contentEvents)
    .innerJoin(productionItems, eq(productionItems.id, contentEvents.contentItemId))
    .where(
      and(
        eq(contentEvents.eventType, "status_change"),
        sql`${contentEvents.userId} IS NOT NULL`,
        sql`${contentEvents.payload}->>'from' = ${REVIEW_STATUS}`,
        sql`${contentEvents.createdAt} > now() - make_interval(days => ${REVIEWER_WINDOW_DAYS})`,
      ),
    );
  const lanes = { mine: new Set<string>(), brands: new Set<string>(), covered: new Set<string>() };
  for (const r of rows) {
    if (!r.brand) continue;
    lanes.covered.add(reviewLane(r));
    if (r.isMine) {
      lanes.mine.add(reviewLane(r));
      lanes.brands.add(r.brand);
    }
  }
  return lanes;
}

/** Everything on this person's plate, split into your turn / to review / waiting. */
export async function getMyWork(userId: string): Promise<MyWorkSplit<MyWorkItem>> {
  const [mine, lanes] = await Promise.all([
    db
      .select(myWorkColumns)
      .from(productionItems)
      .where(
        and(
          eq(productionItems.editorUserId, userId),
          sql`${productionItems.status} NOT IN (${sql.join(
            OFF_PLATE_STATUSES.map((s) => sql`${s}`),
            sql`, `,
          )})`,
          isNull(productionItems.deletedAt),
        ),
      )
      // Your turn first, so a long Waiting list can't push it past the limit.
      .orderBy(
        desc(sql`${productionItems.status} IN (${sql.join(
          YOUR_TURN_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )})`),
        desc(productionItems.updatedAt),
      )
      .limit(200) as Promise<MyWorkItem[]>,
    getReviewLanes(userId),
  ]);

  const inReview = lanes.brands.size
    ? ((await db
        .select(myWorkColumns)
        .from(productionItems)
        .where(
          and(
            eq(productionItems.status, REVIEW_STATUS),
            inArray(productionItems.brand, [...lanes.brands]),
            isNull(productionItems.deletedAt),
          ),
        )
        // Oldest first: the one that has waited longest gets approved first.
        .orderBy(productionItems.updatedAt)
        .limit(200)) as MyWorkItem[])
    : [];

  return splitMyWork(mine, inReview, lanes);
}

const NEWS_WINDOW_DAYS = 30;

/**
 * Per item: the latest comment and send-back by someone else, and your own
 * last action — folded by `rowNews` into what the My Work row shows.
 */
export async function getRowNews(userId: string, itemIds: string[]): Promise<Map<string, RowNews>> {
  if (itemIds.length === 0) return new Map();
  const ids = sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `);
  const firstName = (name: string | null) => (name ?? "").trim().split(/\s+/)[0] || "Someone";

  const [comments, sendBacks, handedTo, mine] = await Promise.all([
    db.execute<{ item_id: string; body: string; at: Date | string; name: string | null }>(sql`
      SELECT DISTINCT ON (c.content_item_id)
        c.content_item_id AS item_id, c.body, c.created_at AS at,
        COALESCE(u.name, c.author_name) AS name
      FROM content_comments c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.content_item_id IN (${ids})
        AND (c.user_id IS NULL OR c.user_id <> ${userId}::uuid)
        AND c.created_at > now() - make_interval(days => ${NEWS_WINDOW_DAYS})
      ORDER BY c.content_item_id, c.created_at DESC
    `),
    db.execute<{ item_id: string; at: Date | string; name: string | null }>(sql`
      SELECT DISTINCT ON (e.content_item_id)
        e.content_item_id AS item_id, e.created_at AS at, u.name
      FROM content_events e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.content_item_id IN (${ids})
        AND e.event_type = 'status_change'
        AND e.payload->>'to' = 'Assigned'
        AND e.payload->>'from' IN (${REVIEW_STATUS}, 'Ready To Publish')
        AND e.user_id IS NOT NULL AND e.user_id <> ${userId}::uuid
        AND e.created_at > now() - make_interval(days => ${NEWS_WINDOW_DAYS})
      ORDER BY e.content_item_id, e.created_at DESC
    `),
    // editor_change payloads carry names, not ids (schema.ts ContentEventPayload).
    db.execute<{ item_id: string; at: Date | string; name: string | null }>(sql`
      SELECT DISTINCT ON (e.content_item_id)
        e.content_item_id AS item_id, e.created_at AS at, u.name
      FROM content_events e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.content_item_id IN (${ids})
        AND e.event_type = 'editor_change'
        AND e.payload->>'to' = (SELECT name FROM users WHERE id = ${userId}::uuid)
        AND e.user_id IS NOT NULL AND e.user_id <> ${userId}::uuid
        AND e.created_at > now() - make_interval(days => ${NEWS_WINDOW_DAYS})
      ORDER BY e.content_item_id, e.created_at DESC
    `),
    db.execute<{ item_id: string; at: Date | string }>(sql`
      SELECT item_id, max(at) AS at FROM (
        SELECT content_item_id AS item_id, created_at AS at FROM content_events
          WHERE user_id = ${userId}::uuid AND content_item_id IN (${ids})
        UNION ALL
        SELECT content_item_id, created_at FROM content_comments
          WHERE user_id = ${userId}::uuid AND content_item_id IN (${ids})
      ) x GROUP BY item_id
    `),
  ]);

  const commentBy = new Map([...comments].map((r) => [r.item_id, r]));
  const sendBackBy = new Map([...sendBacks].map((r) => [r.item_id, r]));
  const handedBy = new Map([...handedTo].map((r) => [r.item_id, r]));
  const mineBy = new Map([...mine].map((r) => [r.item_id, new Date(r.at)]));

  const out = new Map<string, RowNews>();
  for (const id of itemIds) {
    const c = commentBy.get(id);
    const b = sendBackBy.get(id);
    const h = handedBy.get(id);
    const news = rowNews({
      lastComment: c ? { author: firstName(c.name), text: htmlToPlainText(c.body), at: new Date(c.at) } : null,
      lastSendBack: b ? { by: firstName(b.name), at: new Date(b.at) } : null,
      lastHandedTo: h ? { by: firstName(h.name), at: new Date(h.at) } : null,
      myLastAt: mineBy.get(id) ?? null,
    });
    if (news) out.set(id, news);
  }
  return out;
}

/** The app origin links in emails point at. */
export function appBaseUrl(): string {
  return process.env.NEXTAUTH_URL?.replace(/\/$/, "") || "http://localhost:3000";
}

/**
 * This person's morning email (my-day M4), or null when nothing is waiting.
 * Shared by the `my-work-digest` task and the /my-work/email preview, so the
 * preview is exactly what lands in the inbox.
 */
export async function loadMyWorkDigest(userId: string, name: string | null) {
  const { yourTurn, toReview } = await getMyWork(userId);
  const [news, since] = await Promise.all([
    getRowNews(userId, [...new Set([...yourTurn, ...toReview].map((r) => r.id))]),
    getStatusSinceMany(toReview.map((r) => r.id)),
  ]);
  // No status history (a post synced in already in Review): updatedAt, as on /my-work.
  const reviewSince = new Map(toReview.map((r) => [r.id, since.get(r.id) ?? r.updatedAt]));
  return buildMyWorkDigest({
    firstName: (name ?? "").trim().split(/\s+/)[0] || null,
    yourTurn,
    toReview,
    news,
    reviewSince,
    baseUrl: appBaseUrl(),
  });
}

/**
 * When each item entered its current status: its latest status_change event
 * (my-day M11). Items with no status history aren't in the map; callers fall
 * back to `updatedAt`.
 */
export async function getStatusSinceMany(itemIds: string[]): Promise<Map<string, Date>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([contentEvents.contentItemId], {
      itemId: contentEvents.contentItemId,
      at: contentEvents.createdAt,
    })
    .from(contentEvents)
    .where(
      and(
        inArray(contentEvents.contentItemId, itemIds),
        eq(contentEvents.eventType, "status_change"),
      ),
    )
    .orderBy(contentEvents.contentItemId, desc(contentEvents.createdAt));
  return new Map(rows.map((r) => [r.itemId, r.at]));
}
