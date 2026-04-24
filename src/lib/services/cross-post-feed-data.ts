import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  accounts,
  contentEvents,
  crossPostDecisions,
  productionItems,
} from "@/lib/db/schema";

// Server-only. Loads everything the cross-post feed UI (both the standalone
// page and the Queue's Cross-post tab) needs in a handful of queries.

export interface FeedPendingItem {
  ideaItemId: string;
  confidence: number | null;
  createdAt: string | null;
  target: {
    accountId: string | null;
    handle: string | null;
    platform: string | null;
    postType: string | null;
  };
  source: {
    itemId: string | null;
    title: string | null;
    thumbnail: string | null;
    platform: string | null;
    postType: string | null;
    handle: string | null;
    views: number | null;
    publishedAt: string | null;
  };
  reasoning: string | null;
}

export interface FeedRecentRow {
  id: string;
  proposedAt: string;
  confidence: number;
  reasoning: string | null;
  outcome: string | null;
  outcomeReason: string | null;
  ideaItemId: string | null;
  ideaStatus: string | null;
  source: {
    title: string | null;
    handle: string | null;
    platform: string | null;
    postType: string | null;
  };
  target: {
    handle: string | null;
    platform: string | null;
    postType: string;
  };
}

export interface FeedFeedbackEntry {
  reason: string;
  at: string;
  target: string | null;
}

export interface FeedData {
  pending: FeedPendingItem[];
  recent: FeedRecentRow[];
  feedback: {
    accepts: FeedFeedbackEntry[];
    kills: FeedFeedbackEntry[];
  };
}

export async function loadCrossPostFeedData(brand: string): Promise<FeedData> {
  const sourceAccounts = alias(accounts, "source_accounts");
  const targetAccounts = alias(accounts, "target_accounts");
  const sourceItems = alias(productionItems, "source_items");

  // 1. Pending Ideas — cross-post ideas awaiting the operator's action.
  const pendingRows = await db
    .select({
      id: productionItems.id,
      confidence: productionItems.crossPostConfidence,
      createdAt: productionItems.createdAt,
      title: productionItems.title,
      thumbnail: productionItems.thumbnail,
      postType: productionItems.postType,
      targetAccountId: productionItems.accountId,
      targetHandle: targetAccounts.handle,
      targetPlatform: targetAccounts.platform,
      sourceItemId: productionItems.repostedFromItemId,
      sourceTitle: sourceItems.title,
      sourceThumbnail: sourceItems.thumbnail,
      sourceViews: sourceItems.views,
      sourcePostType: sourceItems.postType,
      sourcePublishedAt: sourceItems.publishedAt,
      sourceHandle: sourceAccounts.handle,
      sourcePlatform: sourceAccounts.platform,
      decisionReasoning: crossPostDecisions.reasoning,
    })
    .from(productionItems)
    .leftJoin(targetAccounts, eq(targetAccounts.id, productionItems.accountId))
    .leftJoin(
      sourceItems,
      eq(sourceItems.id, productionItems.repostedFromItemId)
    )
    .leftJoin(sourceAccounts, eq(sourceAccounts.id, sourceItems.accountId))
    .leftJoin(
      crossPostDecisions,
      eq(crossPostDecisions.ideaItemId, productionItems.id)
    )
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.sourceType, "cross_post"),
        eq(productionItems.status, "Idea"),
        isNull(productionItems.deletedAt)
      )
    )
    .orderBy(
      desc(productionItems.crossPostConfidence),
      desc(productionItems.createdAt)
    );

  const pending: FeedPendingItem[] = pendingRows.map((r) => ({
    ideaItemId: r.id,
    confidence: r.confidence,
    createdAt: r.createdAt?.toISOString() ?? null,
    target: {
      accountId: r.targetAccountId,
      handle: r.targetHandle,
      platform: r.targetPlatform,
      postType: r.postType,
    },
    source: {
      itemId: r.sourceItemId,
      title: r.sourceTitle,
      thumbnail: r.sourceThumbnail,
      platform: r.sourcePlatform,
      postType: r.sourcePostType,
      handle: r.sourceHandle,
      views: r.sourceViews,
      publishedAt: r.sourcePublishedAt?.toISOString() ?? null,
    },
    reasoning: r.decisionReasoning,
  }));

  // 2. Recent decisions — last 30 days.
  const ideaRows = alias(productionItems, "idea_items");
  const recentRows = await db
    .select({
      id: crossPostDecisions.id,
      proposedAt: crossPostDecisions.proposedAt,
      confidence: crossPostDecisions.confidence,
      reasoning: crossPostDecisions.reasoning,
      outcome: crossPostDecisions.outcome,
      outcomeReason: crossPostDecisions.outcomeReason,
      ideaItemId: crossPostDecisions.ideaItemId,
      ideaStatus: ideaRows.status,
      sourceTitle: sourceItems.title,
      sourceHandle: sourceAccounts.handle,
      sourcePlatform: sourceAccounts.platform,
      sourcePostType: sourceItems.postType,
      targetHandle: targetAccounts.handle,
      targetPlatform: targetAccounts.platform,
      targetPostType: crossPostDecisions.targetPostType,
    })
    .from(crossPostDecisions)
    .innerJoin(
      sourceItems,
      eq(sourceItems.id, crossPostDecisions.sourceItemId)
    )
    .leftJoin(sourceAccounts, eq(sourceAccounts.id, sourceItems.accountId))
    .leftJoin(
      targetAccounts,
      eq(targetAccounts.id, crossPostDecisions.targetAccountId)
    )
    .leftJoin(ideaRows, eq(ideaRows.id, crossPostDecisions.ideaItemId))
    .where(
      and(
        eq(sourceItems.brand, brand),
        sql`${crossPostDecisions.proposedAt} > (now() - interval '30 days')`
      )
    )
    .orderBy(desc(crossPostDecisions.proposedAt))
    .limit(100);

  const recent: FeedRecentRow[] = recentRows.map((r) => ({
    id: r.id,
    proposedAt: r.proposedAt.toISOString(),
    confidence: r.confidence,
    reasoning: r.reasoning,
    outcome: r.outcome,
    outcomeReason: r.outcomeReason,
    ideaItemId: r.ideaItemId,
    ideaStatus: r.ideaStatus,
    source: {
      title: r.sourceTitle,
      handle: r.sourceHandle,
      platform: r.sourcePlatform,
      postType: r.sourcePostType,
    },
    target: {
      handle: r.targetHandle,
      platform: r.targetPlatform,
      postType: r.targetPostType,
    },
  }));

  // 3. Feedback panel — last 10 accepts + 10 kills brand-scoped.
  const feedbackRows = await db
    .select({
      type: sql<string>`${contentEvents.payload}->>'type'`,
      reason: sql<string>`${contentEvents.payload}->>'reason'`,
      createdAt: contentEvents.createdAt,
      targetHandle: targetAccounts.handle,
      targetPostType: productionItems.postType,
    })
    .from(contentEvents)
    .innerJoin(
      productionItems,
      eq(productionItems.id, contentEvents.contentItemId)
    )
    .leftJoin(targetAccounts, eq(targetAccounts.id, productionItems.accountId))
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.sourceType, "cross_post"),
        sql`${contentEvents.payload}->>'type' IN ('killed', 'accepted')`,
        sql`${contentEvents.payload}->>'reason' IS NOT NULL`
      )
    )
    .orderBy(desc(contentEvents.createdAt))
    .limit(40);

  const accepts: FeedFeedbackEntry[] = [];
  const kills: FeedFeedbackEntry[] = [];
  for (const r of feedbackRows) {
    const entry: FeedFeedbackEntry = {
      reason: r.reason,
      at: r.createdAt.toISOString(),
      target: r.targetHandle
        ? `@${r.targetHandle}${r.targetPostType ? ` · ${r.targetPostType}` : ""}`
        : null,
    };
    if (r.type === "accepted" && accepts.length < 10) accepts.push(entry);
    else if (r.type === "killed" && kills.length < 10) kills.push(entry);
  }

  return { pending, recent, feedback: { accepts, kills } };
}
