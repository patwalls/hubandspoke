import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { classifyEvergreen } from "@/lib/evergreen-agent";
import { resolveAssignees } from "@/lib/services/assignees";
import { isNotionAuthoritative } from "@/lib/platform";

// Tunables. Keep at module top so the first operator to look at this file can
// see every knob in one place.
const MIN_VIEWS = 10_000;
const MIN_AGE_DAYS = 365;
const MIN_REPOST_SPACING_DAYS = 30; // don't re-suggest the same (item, channel) pair within 30d
const CLASSIFY_BATCH_SIZE = 20; // cap per run to bound LLM cost
const PENDING_QUEUE_TARGET = 5; // keep the Idea queue topped up to ~5 repost suggestions
const CANDIDATE_POOL_SIZE = 50; // how many evergreen candidates to pull per run before picking suggestions

export interface EvergreenScanResult {
  classified: number;
  markedEvergreen: number;
  markedNotEvergreen: number;
  suggestionsCreated: number;
  suggestionsDetails: Array<{
    originalId: string;
    newItemId: string;
    channel: string;
    title: string;
  }>;
}

/**
 * Daily scan. Two phases:
 *   A. Classify a batch of aged, high-view ORIGINAL items the classifier
 *      hasn't seen yet. Persist the verdict + reasoning on the item.
 *   B. Refill the Idea queue with repost suggestions from the evergreen pool,
 *      capping pending reposts at PENDING_QUEUE_TARGET.
 *
 * Safe to re-run: Phase A only touches rows with is_evergreen IS NULL, and
 * Phase B skips any (item, channel) pair that already has a recent repost.
 */
export async function runEvergreenScan(): Promise<EvergreenScanResult> {
  const result: EvergreenScanResult = {
    classified: 0,
    markedEvergreen: 0,
    markedNotEvergreen: 0,
    suggestionsCreated: 0,
    suggestionsDetails: [],
  };

  // ─── Phase A: classify ───────────────────────────────────────────────
  const classifyCandidates = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      platform: productionItems.platform,
      publishedDate: productionItems.publishedDate,
      format: productionItems.format,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "original"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.isEvergreen),
        gt(productionItems.views, MIN_VIEWS),
        lt(
          productionItems.publishedDate,
          sql`(now() - interval '${sql.raw(String(MIN_AGE_DAYS))} days')::date`
        )
      )
    )
    .orderBy(desc(productionItems.views))
    .limit(CLASSIFY_BATCH_SIZE);

  for (const c of classifyCandidates) {
    if (!c.title) continue;
    // Skip items whose only channels are Notion-authoritative long-form —
    // those are tracked separately and repost UX for them differs.
    const platform = (c.platform ?? []) as string[];
    if (isNotionAuthoritative(platform) && platform.every((p) => isNotionAuthoritative([p]))) {
      await db
        .update(productionItems)
        .set({
          isEvergreen: false,
          evergreenEvaluatedAt: new Date(),
          evergreenReasoning:
            "Skipped: long-form Notion-authoritative content; not a repost candidate.",
        })
        .where(eq(productionItems.id, c.id));
      result.classified++;
      result.markedNotEvergreen++;
      continue;
    }

    try {
      const verdict = await classifyEvergreen({
        title: c.title,
        platform,
        publishedDate: c.publishedDate,
        format: c.format,
      });
      await db
        .update(productionItems)
        .set({
          isEvergreen: verdict.isEvergreen,
          evergreenEvaluatedAt: new Date(),
          evergreenReasoning: verdict.reasoning,
        })
        .where(eq(productionItems.id, c.id));
      result.classified++;
      if (verdict.isEvergreen) result.markedEvergreen++;
      else result.markedNotEvergreen++;
    } catch (err) {
      console.error(
        `[evergreen-scan] classify failed for ${c.id}:`,
        err instanceof Error ? err.message : err
      );
      // Leave is_evergreen NULL so the next run retries.
    }
  }

  // ─── Phase B: refill suggestion queue ────────────────────────────────
  const [{ pendingCount }] = await db
    .select({
      pendingCount: sql<number>`count(*)::int`,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        eq(productionItems.status, "Idea")
      )
    );

  const slots = Math.max(0, PENDING_QUEUE_TARGET - pendingCount);
  if (slots === 0) return result;

  // Pool of evergreen originals ordered by views DESC. Fetching more than we
  // need because many will be filtered out by the recency guard below.
  const pool = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      platform: productionItems.platform,
      format: productionItems.format,
      brand: productionItems.brand,
      thumbnail: productionItems.thumbnail,
      views: productionItems.views,
      publishedDate: productionItems.publishedDate,
      evergreenReasoning: productionItems.evergreenReasoning,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "original"),
        eq(productionItems.isEvergreen, true),
        eq(productionItems.status, "Published")
      )
    )
    .orderBy(desc(productionItems.views))
    .limit(CANDIDATE_POOL_SIZE);

  if (pool.length === 0) return result;

  // Pull recent repost history for this whole pool in one query — keyed by
  // (originalId, channel) for O(1) lookup.
  const originalIds = pool.map((p) => p.id);
  const recentReposts = await db
    .select({
      repostedFromItemId: productionItems.repostedFromItemId,
      platform: productionItems.platform,
      createdAt: productionItems.createdAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        inArray(productionItems.repostedFromItemId, originalIds),
        gt(
          productionItems.createdAt,
          sql`now() - interval '${sql.raw(String(MIN_REPOST_SPACING_DAYS))} days'`
        )
      )
    );
  const recentKey = new Set<string>();
  for (const r of recentReposts) {
    if (!r.repostedFromItemId) continue;
    for (const ch of (r.platform ?? []) as string[]) {
      recentKey.add(`${r.repostedFromItemId}::${ch}`);
    }
  }

  for (const original of pool) {
    if (result.suggestionsCreated >= slots) break;
    const channels = ((original.platform ?? []) as string[]).filter(
      (ch) => !isNotionAuthoritative([ch])
    );
    if (channels.length === 0) continue;

    // One repost per original per run. Pick the first channel without a recent
    // repost. That keeps producer load predictable and spaced out.
    const channel = channels.find(
      (ch) => !recentKey.has(`${original.id}::${ch}`)
    );
    if (!channel) continue;

    const assignees = await resolveAssignees({
      brand: original.brand,
      sourceItemId: original.id,
      format: original.format,
    });

    const [inserted] = await db
      .insert(productionItems)
      .values({
        brand: original.brand,
        title: original.title,
        status: "Idea",
        platform: [channel],
        format: original.format,
        thumbnail: original.thumbnail,
        sourceType: "repost",
        repostedFromItemId: original.id,
        evergreenReasoning: original.evergreenReasoning,
        producerUserId: assignees.producerUserId,
        editorUserId: assignees.editorUserId,
      })
      .returning({ id: productionItems.id });

    // Block this (original, channel) from being picked again in the same run
    // by a sibling loop iteration.
    recentKey.add(`${original.id}::${channel}`);
    result.suggestionsCreated++;
    result.suggestionsDetails.push({
      originalId: original.id,
      newItemId: inserted.id,
      channel,
      title: original.title ?? "(untitled)",
    });
  }

  return result;
}
