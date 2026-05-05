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
import { buildRepostValues } from "@/lib/services/repost-values";
import { isNotionAuthoritativeAccount } from "@/lib/platform";
import type { PostType } from "@/lib/platform-field-schemas";
import { generateUtmCampaign } from "@/lib/utm-campaign";

// Tunables. Keep at module top so the first operator to look at this file can
// see every knob in one place.
const MIN_VIEWS = 10_000;
const PENDING_QUEUE_TARGET = 50; // bumped 2026-05-05 — operator wants more ideas/day; old 20 was view-yield-limiting
const POOL_PER_PLATFORM = 40; // top-N evergreens per platform pulled into the candidate pool
const RECLASSIFY_BATCH = 5; // re-examine items that were classified false before their body was captured
const KILL_REASON_HISTORY = 50; // negative exemplars; Phase A still slices first 10 inside buildSystemPrompt
const ACCEPT_EXEMPLAR_HISTORY = 30; // positive exemplars: originals the operator has actually published as reposts

// Per-platform queue caps. Sums to >= PENDING_QUEUE_TARGET so the queue can
// always fill, but no single platform can dominate. Bumped 2026-05-05 alongside
// PENDING_QUEUE_TARGET — view yield by platform (avg repost views: YT 174K, IG
// 91K, X 63K) drives the relative weighting; YouTube and IG are the high-yield
// channels and were under-fed at caps of 3.
const PLATFORM_QUEUE_CAPS: Record<string, number> = {
  x: 12,
  instagram: 15,
  linkedin: 6,
  threads: 5,
  youtube: 10,
  tiktok: 2,
};
const DEFAULT_PLATFORM_CAP = 2;
const POOL_PLATFORMS = ["x", "instagram", "linkedin", "threads", "youtube"] as const;

// Re-poolable when the last *published* repost on this original is older than
// the platform's cooldown. Replaced the prior "any prior repost = blocked
// forever" rule (2026-05-05) — that left only 31 of 325 evergreens eligible
// because we'd already reposted the easy winners. Cooldown lengths reflect
// audience-refresh dynamics: IG redistributes fastest (algorithm-driven), X
// has the longest scroll-back risk.
const REPOST_COOLDOWN_DAYS_BY_PLATFORM: Record<string, number> = {
  instagram: 30,
  youtube: 60,
  linkedin: 60,
  threads: 60,
  x: 120,
};
const DEFAULT_REPOST_COOLDOWN_DAYS = 90;

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
          platform: productionItems.platform,
          format: productionItems.format,
          brand: productionItems.brand,
          thumbnail: productionItems.thumbnail,
          views: productionItems.views,
          publishedDate: productionItems.publishedDate,
          evergreenReasoning: productionItems.evergreenReasoning,
          contentBody: productionItems.contentBody,
          contentMediaUrl: productionItems.contentMediaUrl,
          pillarContentItemId: productionItems.pillarContentItemId,
          pillarContentNotionId: productionItems.pillarContentNotionId,
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

  // Per-original repost history split into three pools:
  //   1. lastPublishedRepostByOriginal — newest published repost date,
  //      consulted against REPOST_COOLDOWN_DAYS_BY_PLATFORM. Re-poolable when
  //      cooldown has elapsed.
  //   2. pendingIdeaOriginals — already in the queue (status=Idea); skip to
  //      avoid double-stacking.
  //   3. permanentBlockOriginals — Killed reposts. The operator already
  //      decided this one isn't worth resurfacing; permanent suppression.
  // Replaced the prior "any prior repost blocks forever" rule on 2026-05-05.
  const originalIds = pool.map((p) => p.id);
  const history = await db
    .select({
      repostedFromItemId: productionItems.repostedFromItemId,
      status: productionItems.status,
      publishedDate: productionItems.publishedDate,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        inArray(productionItems.repostedFromItemId, originalIds)
      )
    );
  const lastPublishedRepostByOriginal = new Map<string, Date>();
  const pendingIdeaOriginals = new Set<string>();
  const permanentBlockOriginals = new Set<string>();
  for (const r of history) {
    if (!r.repostedFromItemId) continue;
    if (r.status === "Killed") {
      permanentBlockOriginals.add(r.repostedFromItemId);
      continue;
    }
    if (r.status === "Idea") {
      pendingIdeaOriginals.add(r.repostedFromItemId);
      continue;
    }
    if (r.status === "Published" && r.publishedDate) {
      const d = new Date(r.publishedDate);
      const cur = lastPublishedRepostByOriginal.get(r.repostedFromItemId);
      if (!cur || d > cur) lastPublishedRepostByOriginal.set(r.repostedFromItemId, d);
    }
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
    // Permanent suppression: operator killed a prior repost of this original.
    if (permanentBlockOriginals.has(original.id)) continue;
    // Already in the queue → don't double-stack on the same original.
    if (pendingIdeaOriginals.has(original.id)) continue;

    const platformKey = original.accountPlatform ?? "unknown";

    // Cooldown gate: re-poolable when the last published repost is older than
    // the platform's cooldown. Originals that have never been published as a
    // repost flow straight through.
    const lastPub = lastPublishedRepostByOriginal.get(original.id);
    if (lastPub) {
      const cooldownDays =
        REPOST_COOLDOWN_DAYS_BY_PLATFORM[platformKey] ??
        DEFAULT_REPOST_COOLDOWN_DAYS;
      const daysSince =
        (Date.now() - lastPub.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < cooldownDays) continue;
    }

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

    // Fit check is X-only. Operator kill rate over the last 90 days was 0% on
    // YouTube/IG/LinkedIn/Threads/TikTok and 17% on X — running the LLM judge
    // on platforms where everything gets accepted is the failure mode that
    // produced "0 ideas" runs (2026-05-05). For non-X platforms the operator
    // can still kill in triage; we trade a near-zero false-accept rate for a
    // populated queue.
    if (platformKey === "x" && original.title) {
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
      .values(
        buildRepostValues(
          {
            id: original.id,
            brand: original.brand,
            title: original.title,
            thumbnail: original.thumbnail,
            accountId: original.accountId,
            postType: original.postType,
            platform: original.platform,
            format: original.format,
            pillarContentItemId: original.pillarContentItemId,
            pillarContentNotionId: original.pillarContentNotionId,
            evergreenReasoning: original.evergreenReasoning,
          },
          {
            utmCampaign: await generateUtmCampaign(original.title),
            producerUserId: assignees.producerUserId,
            editorUserId: assignees.editorUserId,
          }
        )
      )
      .returning({ id: productionItems.id });

    // The new row is status='Idea' — track it so we don't re-pick the same
    // original later in this same run.
    pendingIdeaOriginals.add(original.id);
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
