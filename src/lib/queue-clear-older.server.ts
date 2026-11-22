import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, contentEvents, productionItems } from "@/lib/db/schema";
import { CLEAR_OLDER_BULK_TAG, clearOlderCutoff } from "@/lib/queue-clear-older";

/**
 * Queries behind POST /api/queue/clear-older (see src/lib/queue-clear-older.ts).
 * The predicate mirrors the queue's Idea tabs: status Idea, not a cross-post
 * or repost candidate, not a long-form YouTube pillar (those live in Notion),
 * not deleted, created before the 30-day cutoff.
 */
function olderIdeasWhere(brand: string, format: string | null, now: number) {
  return and(
    eq(productionItems.brand, brand),
    eq(productionItems.status, "Idea"),
    isNull(productionItems.deletedAt),
    notInArray(productionItems.sourceType, ["cross_post", "repost"]),
    or(isNull(productionItems.postType), sql`${productionItems.postType} <> 'youtube_long'`),
    lt(productionItems.createdAt, clearOlderCutoff(now)),
    ...(format ? [eq(productionItems.format, format)] : []),
  );
}

export async function countOlderIdeas(
  brand: string,
  format: string | null,
  now = Date.now(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(productionItems)
    .where(olderIdeasWhere(brand, format, now));
  return row?.n ?? 0;
}

const EVENT_CHUNK = 1000;

/**
 * Kill every older Idea row in scope, in one transaction: the items go to
 * Killed, each gets a `killed` event with the reason (tagged bulk, so the
 * History tab skips it), and their clip ideas still 'suggested' are marked
 * killed with the same reason — the same end state as killing them one by one.
 */
export async function killOlderIdeas(args: {
  brand: string;
  format: string | null;
  reason: string;
  actorUserId: string | null;
  now?: number;
}): Promise<number> {
  const now = args.now ?? Date.now();
  return db.transaction(async (tx) => {
    const killed = await tx
      .update(productionItems)
      .set({ status: "Killed", updatedAt: new Date(now) })
      .where(olderIdeasWhere(args.brand, args.format, now))
      .returning({ id: productionItems.id, clipIdeaId: productionItems.sourceClipIdeaId });
    if (killed.length === 0) return 0;

    for (let i = 0; i < killed.length; i += EVENT_CHUNK) {
      await tx.insert(contentEvents).values(
        killed.slice(i, i + EVENT_CHUNK).map((k) => ({
          contentItemId: k.id,
          userId: args.actorUserId,
          eventType: "killed",
          payload: {
            type: "killed" as const,
            from: "Idea",
            reason: args.reason,
            bulk: CLEAR_OLDER_BULK_TAG,
          },
        })),
      );
    }

    const clipIdeaIds = killed.map((k) => k.clipIdeaId).filter((id): id is string => !!id);
    for (let i = 0; i < clipIdeaIds.length; i += EVENT_CHUNK) {
      await tx
        .update(clipIdeas)
        .set({
          status: "killed",
          killReason: args.reason,
          decidedAt: new Date(now),
          decidedByUserId: args.actorUserId,
        })
        .where(
          and(
            inArray(clipIdeas.id, clipIdeaIds.slice(i, i + EVENT_CHUNK)),
            eq(clipIdeas.status, "suggested"),
          ),
        );
    }
    return killed.length;
  });
}
