import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gt, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, contentEvents, productionItems } from "@/lib/db/schema";
import {
  classifyEvergreen,
  judgeRepostFit,
  type PastKillReason,
  type RepostAcceptExemplar,
} from "@/lib/evergreen-agent";
import { resolveAssignees } from "@/lib/services/assignees";
import { isNotionAuthoritativeAccount } from "@/lib/platform";
import type { PostType } from "@/lib/platform-field-schemas";
import { generateUtmCampaign } from "@/lib/utm-campaign";

// Tunables. Keep at module top so the first operator to look at this file can
// see every knob in one place.
const MIN_VIEWS = 10_000;
const PENDING_QUEUE_TARGET = 20; // keep the Idea queue topped up to ~20 repost suggestions
const POOL_PER_PLATFORM = 40; // top-N evergreens per platform pulled into the candidate pool
const RECLASSIFY_BATCH = 5; // re-examine items that were classified false before their body was captured
const KILL_REASON_HISTORY = 50; // negative exemplars; Phase A still slices first 10 inside buildSystemPrompt
const ACCEPT_EXEMPLAR_HISTORY = 30; // positive exemplars: originals the operator has actually published as reposts

// Per-platform queue caps. Sums to >= PENDING_QUEUE_TARGET so the queue can
// always fill, but no single platform can dominate. Tuned around X having
// the largest pool of evergreens; IG is the second priority because IG's
// algorithm redistributes reposts to fresh viewers each time. The previous
// single MAX_PER_PLATFORM = ceil(target * 0.5) = 10 let X fill half the
// queue, defeating the diversity goal.
const PLATFORM_QUEUE_CAPS: Record<string, number> = {
  x: 6,
  instagram: 6,
  linkedin: 4,
  threads: 3,
  youtube: 3,
};
const DEFAULT_PLATFORM_CAP = 2;
const POOL_PLATFORMS = ["x", "instagram", "linkedin", "threads", "youtube"] as const;

// Per-post-type classification quotas. Each bucket has its own age gate because
// shelf-life differs dramatically by platform. X keeps the 365-day gate (same
// audience scrolls the feed regularly, so reposts need real distance). IG's
// algorithm redistributes to different viewers every time, so a 90-day-old
// evergreen Reel is essentially new content. LinkedIn and Threads fall between.
// Without per-platform gates, IG is blocked entirely because no IG item in the
// DB is >1y old.
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

function isInstagramPostType(postType: string | null | undefined): boolean {
  return !!postType && postType.startsWith("instagram_");
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
    accountId: string;
    postType: string;
    title: string;
  }>;
}

/**
 * Daily scan. Two phases:
 *   A. Classify a stratified batch of aged, high-view ORIGINAL items — per-platform
 *      quotas so low-volume channels (IG, LinkedIn) get evaluated instead of being
 *      starved by X. Also re-classifies a small pool of items that were marked
 *      not-evergreen before their caption/media was captured.
 *   B. Refill the Idea queue with repost suggestions, applying a per-platform
 *      diversity cap and a permanent hard-suppression for any original whose
 *      past repost was killed.
 *
 * Safe to re-run: Phase A only touches rows it hasn't seen (or that have
 * fresher body data), and Phase B skips originals with a recent or killed
 * repost.
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

  // Fetch once per run: kill reasons (negative) + accept exemplars (positive).
  // Both feed the per-candidate Phase B fit judge; Phase A only uses kill reasons.
  const [pastKillReasons, pastAcceptExemplars] = await Promise.all([
    fetchPastKillReasons(),
    fetchPastAcceptExemplars(),
  ]);

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

  // ─── Phase B: refill suggestion queue ────────────────────────────────
  const pending = await db
    .select({
      postType: productionItems.postType,
      accountPlatform: accounts.platform,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        eq(productionItems.status, "Idea")
      )
    );

  const pendingCount = pending.length;
  const slots = Math.max(0, PENDING_QUEUE_TARGET - pendingCount);
  if (slots === 0) return result;

  // Running per-platform counts, seeded from what's already pending. Keyed by
  // account.platform (e.g. "instagram") rather than per-post-type so a Reel
  // and a Post both count toward the same diversity budget.
  const perPlatformCount = new Map<string, number>();
  for (const p of pending) {
    const key = p.accountPlatform ?? "unknown";
    perPlatformCount.set(key, (perPlatformCount.get(key) ?? 0) + 1);
  }

  // Pool of evergreen originals, stratified per-platform. We pull top-N per
  // platform separately rather than top-N globally because X content has
  // dramatically higher view counts than IG/LinkedIn/Threads/YouTube — a
  // single global views-DESC query produces an X-dominated pool, and the
  // per-platform cap below can't pick non-X items that aren't there. Pulling
  // each platform independently guarantees non-X candidates are present;
  // iteration still goes views-DESC so the highest-quality candidates are
  // evaluated first within each platform's allowance.
  const platformPools = await Promise.all(
    POOL_PLATFORMS.map((platform) =>
      db
        .select({
          id: productionItems.id,
          title: productionItems.title,
          accountId: productionItems.accountId,
          postType: productionItems.postType,
          format: productionItems.format,
          brand: productionItems.brand,
          thumbnail: productionItems.thumbnail,
          views: productionItems.views,
          publishedDate: productionItems.publishedDate,
          evergreenReasoning: productionItems.evergreenReasoning,
          contentBody: productionItems.contentBody,
          contentMediaUrl: productionItems.contentMediaUrl,
          accountPlatform: accounts.platform,
          accountSyncedFromNotion: accounts.syncedFromNotion,
        })
        .from(productionItems)
        .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
        .where(
          and(
            eq(productionItems.sourceType, "original"),
            eq(productionItems.isEvergreen, true),
            eq(productionItems.status, "Published"),
            eq(accounts.platform, platform)
          )
        )
        .orderBy(desc(productionItems.views))
        .limit(POOL_PER_PLATFORM)
    )
  );
  const pool = platformPools
    .flat()
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));

  if (pool.length === 0) return result;

  // Pull repost history for this whole pool. Any prior repost — regardless of
  // status or age — blocks a new auto-suggestion. The DB-level
  // uniq_production_items_pillar_format used to be the back-stop for this; per
  // operator request the dedup now lives here at generation time: "if we've
  // already done it before, or it's already in production, don't generate."
  // Killed rows still count (they permanently suppress; the operator already
  // decided this isn't worth resurfacing).
  const originalIds = pool.map((p) => p.id);
  const history = await db
    .select({
      repostedFromItemId: productionItems.repostedFromItemId,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        inArray(productionItems.repostedFromItemId, originalIds)
      )
    );
  const blockedOriginals = new Set<string>();
  for (const r of history) {
    if (r.repostedFromItemId) blockedOriginals.add(r.repostedFromItemId);
  }

  for (const original of pool) {
    if (result.suggestionsCreated >= slots) break;
    // Skip Notion-authoritative originals (long-form YouTube) — those are
    // tracked in Notion and the repost UX for them differs.
    if (
      isNotionAuthoritativeAccount({
        syncedFromNotion: original.accountSyncedFromNotion,
      })
    ) {
      continue;
    }
    // Skip originals missing the new accountId/postType — they need backfilling
    // (see scripts/backfill-accounts.mjs) before they're repost-eligible.
    if (!original.accountId || !original.postType) continue;
    if (blockedOriginals.has(original.id)) continue;

    const platformKey = original.accountPlatform ?? "unknown";
    const platformCap = PLATFORM_QUEUE_CAPS[platformKey] ?? DEFAULT_PLATFORM_CAP;
    if ((perPlatformCount.get(platformKey) ?? 0) >= platformCap) continue;

    // IG reposts need something to grab — caption or archived media. If the
    // original has neither, skip (the operator can't do anything with it).
    if (
      isInstagramPostType(original.postType) &&
      !original.contentBody?.trim() &&
      !original.contentMediaUrl?.trim()
    ) {
      continue;
    }

    // Fit check: would this candidate draw a kill given recent operator
    // behavior? Phase A's kill-reason injection only steers newly-classified
    // items; this catches already-evergreen items the operator no longer wants
    // resurfaced (the salary-content failure mode).
    if (original.title) {
      try {
        const fit = await judgeRepostFit({
          title: original.title,
          postType: original.postType,
          publishedDate: original.publishedDate,
          format: original.format,
          contentBody: original.contentBody,
          pastKillReasons,
          pastAcceptExemplars,
        });
        if (!fit.wouldRepost) {
          console.log(
            `[evergreen-scan] fit-skip "${original.title}" (${original.postType}): ${fit.reasoning}`
          );
          continue;
        }
      } catch (err) {
        console.error(
          `[evergreen-scan] fit-judge failed for ${original.id}; allowing through:`,
          err instanceof Error ? err.message : err
        );
        // Fall through — don't block a suggestion on a transient API error.
      }
    }

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
        accountId: original.accountId,
        postType: original.postType,
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

    blockedOriginals.add(original.id);
    perPlatformCount.set(platformKey, (perPlatformCount.get(platformKey) ?? 0) + 1);
    result.suggestionsCreated++;
    result.suggestionsDetails.push({
      originalId: original.id,
      newItemId: inserted.id,
      accountId: original.accountId,
      postType: original.postType,
      title: original.title ?? "(untitled)",
    });
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

async function fetchPastAcceptExemplars(): Promise<RepostAcceptExemplar[]> {
  // Self-join: every repost row has repostedFromItemId pointing at the original.
  // We want originals whose reposts moved past triage (anything but Idea/Killed)
  // — that's the operator's positive signal of "yes, content like this is
  // worth resurfacing."
  const original = alias(productionItems, "orig");
  const rows = await db
    .select({
      title: original.title,
      postType: original.postType,
      format: original.format,
    })
    .from(productionItems)
    .innerJoin(original, eq(original.id, productionItems.repostedFromItemId))
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        notInArray(productionItems.status, ["Idea", "Killed"])
      )
    )
    .orderBy(desc(productionItems.createdAt))
    .limit(ACCEPT_EXEMPLAR_HISTORY);

  return rows
    .filter((r): r is { title: string; postType: string | null; format: string | null } =>
      typeof r.title === "string" && r.title.trim().length > 0
    )
    .map((r) => ({
      title: r.title,
      postType: r.postType,
      format: r.format,
    }));
}
