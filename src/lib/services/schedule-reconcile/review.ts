// Read model for the Scheduled review surface (/[brand]/scheduled).
// Two lists:
//   - suggestions: borderline (55–84) matches awaiting a human Confirm/Reject,
//     joined with both the Scheduled planning item and the candidate live post.
//     Only surfaces pairs whose scheduled item is still actually Scheduled.
//   - needsAttention: Scheduled items the matcher gave up on (aged past their
//     per-post-type window) — an operator should publish them manually.

import { aliasedTable, and, desc, eq, isNotNull, isNull, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, scheduledMatchSuggestions } from "@/lib/db/schema";

export interface ScheduledMatchSuggestionView {
  id: string;
  score: number;
  reason: string | null;
  createdAt: string;
  scheduled: {
    id: string;
    title: string | null;
    hook: string | null;
    postType: string | null;
    scheduledAt: string | null;
    expectedPublishAt: string | null;
  };
  candidate: {
    id: string;
    title: string | null;
    hook: string | null;
    postType: string | null;
    publishedLink: string | null;
    publishedAt: string | null;
    thumbnail: string | null;
  };
}

export interface NeedsAttentionItemView {
  id: string;
  title: string | null;
  postType: string | null;
  scheduledAt: string | null;
  expectedPublishAt: string | null;
}

export interface WatchingNoDateItemView {
  id: string;
  title: string | null;
  postType: string | null;
  scheduledAt: string | null;
}

export interface ScheduledReviewData {
  suggestions: ScheduledMatchSuggestionView[];
  needsAttention: NeedsAttentionItemView[];
  watching: WatchingNoDateItemView[];
}

export async function getScheduledReviewData(
  brand: string,
): Promise<ScheduledReviewData> {
  const scheduled = aliasedTable(productionItems, "sched");
  const candidate = aliasedTable(productionItems, "cand");

  const suggestionRows = await db
    .select({
      id: scheduledMatchSuggestions.id,
      score: scheduledMatchSuggestions.score,
      reason: scheduledMatchSuggestions.reason,
      createdAt: scheduledMatchSuggestions.createdAt,
      schedId: scheduled.id,
      schedTitle: scheduled.title,
      schedHook: scheduled.hook,
      schedPostType: scheduled.postType,
      schedScheduledAt: scheduled.scheduledAt,
      schedExpectedPublishAt: scheduled.expectedPublishAt,
      candId: candidate.id,
      candTitle: candidate.title,
      candHook: candidate.hook,
      candPostType: candidate.postType,
      candPublishedLink: candidate.publishedLink,
      candPublishedAt: candidate.publishedAt,
      candThumbnail: candidate.thumbnail,
    })
    .from(scheduledMatchSuggestions)
    .innerJoin(scheduled, eq(scheduledMatchSuggestions.scheduledItemId, scheduled.id))
    .innerJoin(candidate, eq(scheduledMatchSuggestions.candidateItemId, candidate.id))
    .where(
      and(
        eq(scheduledMatchSuggestions.status, "pending"),
        eq(scheduled.brand, brand),
        // Only show suggestions still actionable: the planning item must
        // still be Scheduled (an auto-merge or manual publish moots it) and
        // the candidate must not have been merged away.
        eq(scheduled.status, "Scheduled"),
        isNull(scheduled.deletedAt),
        isNull(candidate.deletedAt),
      ),
    )
    .orderBy(desc(scheduledMatchSuggestions.score), desc(scheduledMatchSuggestions.createdAt));

  const needsAttentionRows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      postType: productionItems.postType,
      scheduledAt: productionItems.scheduledAt,
      expectedPublishAt: productionItems.expectedPublishAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.status, "Scheduled"),
        isNotNull(productionItems.scheduleNeedsAttentionAt),
        isNull(productionItems.deletedAt),
      ),
    )
    .orderBy(desc(productionItems.scheduleNeedsAttentionAt));

  // No-date items currently being watched by the hourly sweep (not yet timed out).
  const watchingRows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      postType: productionItems.postType,
      scheduledAt: productionItems.scheduledAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.status, "Scheduled"),
        eq(productionItems.scheduledNoDate, true),
        isNull(productionItems.scheduleNeedsAttentionAt),
        isNull(productionItems.deletedAt),
      ),
    )
    .orderBy(asc(productionItems.scheduledAt));

  return {
    suggestions: suggestionRows.map((r) => ({
      id: r.id,
      score: r.score,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      scheduled: {
        id: r.schedId,
        title: r.schedTitle,
        hook: r.schedHook,
        postType: r.schedPostType,
        scheduledAt: r.schedScheduledAt?.toISOString() ?? null,
        expectedPublishAt: r.schedExpectedPublishAt?.toISOString() ?? null,
      },
      candidate: {
        id: r.candId,
        title: r.candTitle,
        hook: r.candHook,
        postType: r.candPostType,
        publishedLink: r.candPublishedLink,
        publishedAt: r.candPublishedAt?.toISOString() ?? null,
        thumbnail: r.candThumbnail,
      },
    })),
    needsAttention: needsAttentionRows.map((r) => ({
      id: r.id,
      title: r.title,
      postType: r.postType,
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      expectedPublishAt: r.expectedPublishAt?.toISOString() ?? null,
    })),
    watching: watchingRows.map((r) => ({
      id: r.id,
      title: r.title,
      postType: r.postType,
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
    })),
  };
}
