import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import {
  classifyEvergreen,
  type PastKillReason,
} from "@/lib/evergreen-agent";
import type { PostType } from "@/lib/platform-field-schemas";

// Daily evergreen classifier — Phase A only as of 2026-05-06.
//
// History: this file used to do two things in sequence —
//   Phase A: LLM-classify aged, high-view ORIGINAL items as evergreen
//            or not, populating `is_evergreen` + `evergreen_reasoning`.
//   Phase B: refill the Repost Idea queue from the evergreen pool with
//            per-platform diversity caps and an X-only fit judge.
// Phase B was retired when repost-candidates.ts (live, percentile-
// driven, cohort-aware) replaced it. The classifier work in Phase A
// stays — it produces the `evergreen_reasoning` flavor text the repost
// triage modal still surfaces, and `is_evergreen` is useful as a
// corroborating signal even though the queue no longer gates on it.

// Tunables.
const MIN_VIEWS = 10_000;
const RECLASSIFY_BATCH = 5; // re-examine items classified false before body was captured
const KILL_REASON_HISTORY = 50; // negative exemplars for the LLM prompt

// Per-post-type classification quotas. Each bucket has its own age gate
// because shelf-life differs dramatically by platform. X keeps the 365-day
// gate; IG's algorithm redistributes to different viewers every time, so
// 90-day-old evergreen Reels are essentially new content.
const CLASSIFY_QUOTAS: Array<{
  bucket: string;
  postTypes: PostType[];
  limit: number;
  minAgeDays: number;
}> = [
  { bucket: "x", postTypes: ["x"], limit: 12, minAgeDays: 365 },
  { bucket: "instagram", postTypes: ["instagram_reel", "instagram_post"], limit: 10, minAgeDays: 90 },
  { bucket: "linkedin", postTypes: ["linkedin"], limit: 4, minAgeDays: 180 },
  { bucket: "threads", postTypes: ["threads"], limit: 4, minAgeDays: 180 },
  { bucket: "youtube", postTypes: ["youtube_community", "youtube_shorts"], limit: 4, minAgeDays: 180 },
];

export interface EvergreenScanResult {
  classified: number;
  reclassified: number;
  markedEvergreen: number;
  markedNotEvergreen: number;
}

/**
 * Daily LLM classifier. Touches a stratified batch of aged, high-view
 * ORIGINAL items, deciding whether each is evergreen and writing the
 * verdict + reasoning to the row. Also re-classifies a small pool of
 * items previously marked not-evergreen but whose body became available
 * after the fact.
 *
 * Safe to re-run: the WHERE clauses skip rows already evaluated at the
 * current state. Failures on individual items are logged and skipped;
 * the next run retries.
 */
export async function runEvergreenScan(): Promise<EvergreenScanResult> {
  const result: EvergreenScanResult = {
    classified: 0,
    reclassified: 0,
    markedEvergreen: 0,
    markedNotEvergreen: 0,
  };

  const pastKillReasons = await fetchPastKillReasons();

  // ─── Phase A: classify (stratified by post-type, per-platform age gate) ──
  for (const quota of CLASSIFY_QUOTAS) {
    const candidates = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        postType: productionItems.postType,
        publishedDate: productionItems.publishedDate,
        format: productionItems.format,
        contentBody: productionItems.contentBody,
        contentMediaUrl: productionItems.contentMediaUrl,
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
            sql`(now() - interval '${sql.raw(String(quota.minAgeDays))} days')::date`
          ),
          inArray(productionItems.postType, quota.postTypes)
        )
      )
      .orderBy(desc(productionItems.views))
      .limit(quota.limit);

    for (const c of candidates) {
      await classifyAndPersist(c, pastKillReasons, result, /*isReclassify*/ false);
    }
  }

  // ─── Phase A': re-classify items classified false before body was captured ─
  const reclassifyCandidates = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      postType: productionItems.postType,
      publishedDate: productionItems.publishedDate,
      format: productionItems.format,
      contentBody: productionItems.contentBody,
      contentMediaUrl: productionItems.contentMediaUrl,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "original"),
        eq(productionItems.status, "Published"),
        eq(productionItems.isEvergreen, false),
        gt(productionItems.views, MIN_VIEWS),
        sql`${productionItems.contentBody} IS NOT NULL`,
        sql`${productionItems.contentBody} <> ''`,
        sql`${productionItems.contentBodyFetchedAt} IS NOT NULL`,
        sql`${productionItems.evergreenEvaluatedAt} IS NOT NULL`,
        sql`${productionItems.contentBodyFetchedAt} > ${productionItems.evergreenEvaluatedAt}`
      )
    )
    .orderBy(desc(productionItems.views))
    .limit(RECLASSIFY_BATCH);

  for (const c of reclassifyCandidates) {
    await classifyAndPersist(c, pastKillReasons, result, /*isReclassify*/ true);
  }

  return result;
}

async function classifyAndPersist(
  c: {
    id: string;
    title: string | null;
    postType: string | null;
    publishedDate: string | null;
    format: string | null;
    contentBody: string | null;
    contentMediaUrl: string | null;
  },
  pastKillReasons: PastKillReason[],
  result: EvergreenScanResult,
  isReclassify: boolean
): Promise<void> {
  if (!c.title) return;

  try {
    const verdict = await classifyEvergreen({
      title: c.title,
      postType: c.postType,
      publishedDate: c.publishedDate,
      format: c.format,
      contentBody: c.contentBody,
      hasArchivedMedia: !!c.contentMediaUrl,
      pastKillReasons,
    });
    await db
      .update(productionItems)
      .set({
        isEvergreen: verdict.isEvergreen,
        evergreenEvaluatedAt: new Date(),
        evergreenReasoning: verdict.reasoning,
      })
      .where(eq(productionItems.id, c.id));
    if (isReclassify) result.reclassified++;
    else result.classified++;
    if (verdict.isEvergreen) result.markedEvergreen++;
    else result.markedNotEvergreen++;
  } catch (err) {
    console.error(
      `[evergreen-scan] classify failed for ${c.id}:`,
      err instanceof Error ? err.message : err
    );
    // Leave row as-is so the next run retries.
  }
}

async function fetchPastKillReasons(): Promise<PastKillReason[]> {
  // Join against production_items so we can tag the reason with the killed
  // item's post-type — gives the classifier a little more signal per exemplar.
  const rows = await db
    .select({
      reason: sql<string>`${contentEvents.payload}->>'reason'`,
      postType: productionItems.postType,
    })
    .from(contentEvents)
    .innerJoin(
      productionItems,
      eq(productionItems.id, contentEvents.contentItemId)
    )
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        sql`${contentEvents.payload}->>'type' = 'killed'`,
        sql`${contentEvents.payload}->>'reason' IS NOT NULL`,
        sql`length(${contentEvents.payload}->>'reason') >= 10`
      )
    )
    .orderBy(desc(contentEvents.createdAt))
    .limit(KILL_REASON_HISTORY);

  return rows.map((r) => ({
    reason: r.reason,
    postType: r.postType,
  }));
}
