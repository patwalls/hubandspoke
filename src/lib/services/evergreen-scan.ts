import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import {
  classifyEvergreen,
  type PastKillReason,
} from "@/lib/evergreen-agent";
import { resolveAssignees } from "@/lib/services/assignees";
import { isNotionAuthoritative } from "@/lib/platform";
import { generateUtmCampaign } from "@/lib/utm-campaign";

// Tunables. Keep at module top so the first operator to look at this file can
// see every knob in one place.
const MIN_VIEWS = 10_000;
const MIN_REPOST_SPACING_DAYS = 30; // don't re-suggest the same (item, channel) pair within 30d
const PENDING_QUEUE_TARGET = 10; // keep the Idea queue topped up to ~10 repost suggestions
const CANDIDATE_POOL_SIZE = 80; // how many evergreen candidates to pull per run before picking suggestions
const MAX_PER_PLATFORM = Math.ceil(PENDING_QUEUE_TARGET * 0.4); // diversity cap
const RECLASSIFY_BATCH = 5; // re-examine items that were classified false before their body was captured
const KILL_REASON_HISTORY = 10; // negative exemplars fed to the classifier prompt

// Per-platform classification quotas. Each bucket has its own age gate because
// shelf-life differs dramatically by platform. Twitter keeps the 365-day gate
// (same audience scrolls the feed regularly, so reposts need real distance).
// Instagram's algorithm redistributes to different viewers every time, so a
// 90-day-old evergreen Reel is essentially new content. LinkedIn and Threads
// fall between. Without per-platform gates, IG is blocked entirely because
// no IG item in the DB is >1y old.
const CLASSIFY_QUOTAS: Array<{
  bucket: string;
  channels: string[];
  limit: number;
  minAgeDays: number;
}> = [
  { bucket: "twitter", channels: ["Twitter", "Twitter (Pat Walls)"], limit: 8, minAgeDays: 365 },
  { bucket: "instagram", channels: ["Instagram Reel", "Instagram Post"], limit: 6, minAgeDays: 90 },
  { bucket: "linkedin", channels: ["LinkedIn"], limit: 2, minAgeDays: 180 },
  { bucket: "threads", channels: ["Threads"], limit: 2, minAgeDays: 180 },
  { bucket: "youtube", channels: ["YouTube Community", "YouTube Shorts"], limit: 2, minAgeDays: 180 },
];

function isInstagramChannel(channel: string): boolean {
  return channel.startsWith("Instagram");
}

export interface EvergreenScanResult {
  classified: number;
  reclassified: number;
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
 *   A. Classify a stratified batch of aged, high-view ORIGINAL items — per-platform
 *      quotas so low-volume channels (IG, LinkedIn) get evaluated instead of being
 *      starved by Twitter. Also re-classifies a small pool of items that were
 *      marked not-evergreen before their caption/media was captured.
 *   B. Refill the Idea queue with repost suggestions, applying a per-platform
 *      diversity cap and a permanent hard-suppression for any (item, channel)
 *      whose past repost was killed.
 *
 * Safe to re-run: Phase A only touches rows it hasn't seen (or that have
 * fresher body data), and Phase B skips any (item, channel) pair with a recent
 * or killed repost.
 */
export async function runEvergreenScan(): Promise<EvergreenScanResult> {
  const result: EvergreenScanResult = {
    classified: 0,
    reclassified: 0,
    markedEvergreen: 0,
    markedNotEvergreen: 0,
    suggestionsCreated: 0,
    suggestionsDetails: [],
  };

  // Fetch once: recent kill reasons fed to the classifier as negative exemplars.
  const pastKillReasons = await fetchPastKillReasons();

  // ─── Phase A: classify (stratified by platform, per-platform age gate) ──
  for (const quota of CLASSIFY_QUOTAS) {
    const candidates = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        platform: productionItems.platform,
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
          sql`${productionItems.platform} ?| array[${sql.join(
            quota.channels.map((c) => sql`${c}`),
            sql`, `
          )}]::text[]`
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
      platform: productionItems.platform,
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

  // ─── Phase B: refill suggestion queue ────────────────────────────────
  const pending = await db
    .select({ platform: productionItems.platform })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        eq(productionItems.status, "Idea")
      )
    );

  const pendingCount = pending.length;
  const slots = Math.max(0, PENDING_QUEUE_TARGET - pendingCount);
  if (slots === 0) return result;

  // Running per-channel counts, seeded from what's already pending.
  const perChannelCount = new Map<string, number>();
  for (const p of pending) {
    for (const ch of (p.platform ?? []) as string[]) {
      perChannelCount.set(ch, (perChannelCount.get(ch) ?? 0) + 1);
    }
  }

  // Pool of evergreen originals ordered by views DESC. Fetching more than we
  // need because many will be filtered out by the recency/kill/media guards.
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
      contentBody: productionItems.contentBody,
      contentMediaUrl: productionItems.contentMediaUrl,
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

  // Pull repost history for this whole pool in two flavors:
  //   1. Any repost created within the 30-day spacing window (soft guard)
  //   2. Any repost ever killed (hard, permanent suppression)
  const originalIds = pool.map((p) => p.id);
  const history = await db
    .select({
      repostedFromItemId: productionItems.repostedFromItemId,
      platform: productionItems.platform,
      status: productionItems.status,
      createdAt: productionItems.createdAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        inArray(productionItems.repostedFromItemId, originalIds),
        or(
          eq(productionItems.status, "Killed"),
          gt(
            productionItems.createdAt,
            sql`now() - interval '${sql.raw(String(MIN_REPOST_SPACING_DAYS))} days'`
          )
        )
      )
    );
  const blockedKey = new Set<string>();
  for (const r of history) {
    if (!r.repostedFromItemId) continue;
    for (const ch of (r.platform ?? []) as string[]) {
      blockedKey.add(`${r.repostedFromItemId}::${ch}`);
    }
  }

  for (const original of pool) {
    if (result.suggestionsCreated >= slots) break;
    const channels = ((original.platform ?? []) as string[]).filter(
      (ch) => !isNotionAuthoritative([ch])
    );
    if (channels.length === 0) continue;

    // Pick the first channel that passes every guard: not a recent/killed
    // (original, channel) pair, and not over the per-platform diversity cap.
    const channel = channels.find((ch) => {
      if (blockedKey.has(`${original.id}::${ch}`)) return false;
      if ((perChannelCount.get(ch) ?? 0) >= MAX_PER_PLATFORM) return false;
      // IG reposts need something to grab — caption or archived media. If the
      // original has neither, skip (the operator can't do anything with it).
      if (
        isInstagramChannel(ch) &&
        !original.contentBody?.trim() &&
        !original.contentMediaUrl?.trim()
      ) {
        return false;
      }
      return true;
    });
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
        utmCampaign: await generateUtmCampaign(original.title),
        producerUserId: assignees.producerUserId,
        editorUserId: assignees.editorUserId,
      })
      .returning({ id: productionItems.id });

    // Block this (original, channel) for the rest of the run and bump the
    // per-channel count toward the diversity cap.
    blockedKey.add(`${original.id}::${channel}`);
    perChannelCount.set(channel, (perChannelCount.get(channel) ?? 0) + 1);
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

async function classifyAndPersist(
  c: {
    id: string;
    title: string | null;
    platform: string[] | null;
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
  // Skip items whose only channels are Notion-authoritative long-form —
  // those are tracked separately and repost UX for them differs.
  const platform = (c.platform ?? []) as string[];
  if (
    isNotionAuthoritative(platform) &&
    platform.every((p) => isNotionAuthoritative([p]))
  ) {
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
    return;
  }

  try {
    const verdict = await classifyEvergreen({
      title: c.title,
      platform,
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
  // item's channel — gives the classifier a little more signal per exemplar.
  const rows = await db
    .select({
      reason: sql<string>`${contentEvents.payload}->>'reason'`,
      platform: productionItems.platform,
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
    platform: ((r.platform ?? []) as string[])[0] ?? null,
  }));
}
