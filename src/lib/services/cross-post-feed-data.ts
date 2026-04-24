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
  velocity: {
    viewsAt1h: number | null;
    velocityRatio: number | null;
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

  const pendingSourceIds = Array.from(
    new Set(
      pendingRows.map((r) => r.sourceItemId).filter((x): x is string => !!x)
    )
  );

  const velocityMap =
    pendingSourceIds.length > 0
      ? await loadVelocityForSources(pendingSourceIds)
      : new Map<string, { viewsAt1h: number; velocityRatio: number | null }>();

  const pending: FeedPendingItem[] = pendingRows.map((r) => {
    const v = r.sourceItemId ? velocityMap.get(r.sourceItemId) : undefined;
    return {
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
      velocity: v ?? { viewsAt1h: null, velocityRatio: null },
      reasoning: r.decisionReasoning,
    };
  });

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

async function loadVelocityForSources(
  sourceIds: string[]
): Promise<Map<string, { viewsAt1h: number; velocityRatio: number | null }>> {
  const map = new Map<
    string,
    { viewsAt1h: number; velocityRatio: number | null }
  >();

  const rows = await db.execute<{
    source_item_id: string;
    views_at_1h: number;
    account_id: string;
    post_type: string;
  }>(sql`
    SELECT DISTINCT ON (vs.production_item_id)
      vs.production_item_id AS source_item_id,
      vs.views AS views_at_1h,
      pi.account_id,
      pi.post_type
    FROM view_snapshots vs
    JOIN production_items pi ON pi.id = vs.production_item_id
    WHERE vs.production_item_id IN (${sql.join(
      sourceIds.map((id) => sql`${id}::uuid`),
      sql`, `
    )})
      AND vs.post_age_minutes BETWEEN 45 AND 75
    ORDER BY vs.production_item_id, abs(vs.post_age_minutes - 60) ASC
  `);

  const baselineByPair = new Map<string, number>();
  if (rows.length > 0) {
    const baselineRows = await db.execute<{
      account_id: string;
      post_type: string;
      baseline: string;
    }>(sql`
      WITH per_item AS (
        SELECT DISTINCT ON (pi.id)
          pi.account_id,
          pi.post_type,
          vs.views
        FROM production_items pi
        JOIN view_snapshots vs ON vs.production_item_id = pi.id
        WHERE pi.source_type = 'original'
          AND pi.status = 'Published'
          AND pi.deleted_at IS NULL
          AND pi.published_at >= (now() - interval '30 days')
          AND vs.post_age_minutes BETWEEN 45 AND 75
        ORDER BY pi.id, abs(vs.post_age_minutes - 60) ASC
      )
      SELECT account_id,
             post_type,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY views) AS baseline
      FROM per_item
      GROUP BY account_id, post_type
      HAVING count(*) >= 5
    `);
    for (const b of baselineRows) {
      baselineByPair.set(`${b.account_id}:${b.post_type}`, Number(b.baseline));
    }
  }

  for (const r of rows) {
    const baseline = baselineByPair.get(`${r.account_id}:${r.post_type}`);
    const ratio = baseline && baseline > 0 ? r.views_at_1h / baseline : null;
    map.set(r.source_item_id, {
      viewsAt1h: r.views_at_1h,
      velocityRatio: ratio,
    });
  }
  return map;
}
