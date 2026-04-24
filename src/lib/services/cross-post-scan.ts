import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  brands,
  contentEvents,
  crossPostDecisions,
  productionItemMedia,
  productionItems,
  viewSnapshots,
} from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { isNotionAuthoritative } from "@/lib/platform";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { PLATFORM_META, toPlatform } from "@/lib/platforms";
import {
  compatibleTargetsFor,
  hasAnyCompatibleTarget,
} from "@/lib/cross-post-compat";
import type { PostType } from "@/lib/platform-field-schemas";
import {
  recommendCrossPosts,
  type CandidateTarget,
  type PastOutcome,
} from "@/lib/services/cross-post-recommend";

// v2 cross-post scanner. Replaces the rules-driven scan.
//
// Pipeline: find fast-growing originals (via view_snapshots), enumerate
// format-compatible target accounts, let an LLM propose which ones are worth
// cross-posting to (with confidence), log every proposal, then admit Ideas
// to the operator's queue in confidence order subject to a per-brand cap.
//
// Feedback loop: past operator kills AND accepts (from content_events) are
// fed back into the LLM prompt so the system learns what to propose / avoid
// without anyone writing a policy doc.

// Only consider items published within this window. Matches the
// fresh-metrics-sync window so by the time we scan, every candidate should
// have a 45–75 min snapshot.
const FRESH_WINDOW_HOURS = 72;

// Post-age window used to compute "views at ~1h". We accept anything 45-75m
// because the fresh-metrics cron runs every 15m so a window this wide
// virtually guarantees a hit.
const TARGET_AGE_MIN = 45;
const TARGET_AGE_MAX = 75;

// Baseline = median "views at ~1h" across the same account+postType over the
// last BASELINE_WINDOW_DAYS. Only computed when a cohort has at least
// MIN_COHORT_SIZE items — smaller than this is too noisy to compare against.
const BASELINE_WINDOW_DAYS = 30;
const MIN_COHORT_SIZE = 5;

// Velocity gate. A candidate is "taking off" if its views_at_1h divided by
// the account+postType baseline is >= this multiplier.
const VELOCITY_MIN_RATIO = 2.0;

// Don't re-propose a source we've already considered in this window. Gives
// the operator time to act before the scanner touches it again.
const DEDUP_WINDOW_HOURS = 48;

// Only admit Ideas with confidence >= this floor. Below-floor proposals are
// still logged in cross_post_decisions for retrospective.
const MIN_CONFIDENCE = 70;

// Per-brand cap on un-actioned cross-post Ideas. Default for automated
// invocations; manual invocations (the "Populate queue" button) override
// via `options.maxIdeas`.
const MAX_PENDING_CROSSPOST_IDEAS = 12;

// Hard cap on how many candidates go through the LLM in a single run.
// Keeps LLM cost bounded on manual invocations where the caller picks the
// top N by velocity. Default (no cap) keeps the prior behavior.
const DEFAULT_MAX_CANDIDATES = Number.POSITIVE_INFINITY;

// How many past accept + kill reasons to feed into the LLM per run.
const FEEDBACK_HISTORY = 15;

export interface RunCrossPostScanOptions {
  /** Hard cap on how many velocity-qualified candidates get LLM-scored.
   *  When more candidates qualify than this, we keep the top N by velocity
   *  ratio. Useful for the manual button so a runaway click can't bill
   *  dozens of LLM calls. */
  maxCandidates?: number;
  /** Cap on how many new Idea rows this run may insert *per brand*. Serves
   *  as the upper bound of the operator's queue depth. */
  maxIdeas?: number;
}

export interface CrossPostScanResult {
  candidatesConsidered: number;
  candidatesDropped: {
    noCompatibleTargets: number;
    noBaseline: number;
    belowVelocity: number;
    recentlyProposed: number;
    llmFallback: number;
  };
  proposalsLogged: number;
  ideasCreated: number;
  ideasDetails: Array<{
    sourceItemId: string;
    newItemId: string;
    targetAccountId: string;
    targetPostType: string;
    confidence: number;
    title: string;
  }>;
}

interface Candidate {
  id: string;
  title: string | null;
  thumbnail: string | null;
  brand: string;
  accountId: string;
  postType: string;
  contentBody: string | null;
  publishedDate: string | null;
  publishedAt: Date;
  format: string | null;
  pillarContentNotionId: string | null;
  pillarContentItemId: string | null;
  mediaContentType: string | null;
  platform: string[] | null;
  sourceAccountHandle: string | null;
  viewsAt1h: number;
  velocityRatio: number;
}

export async function runCrossPostScan(
  options: RunCrossPostScanOptions = {}
): Promise<CrossPostScanResult> {
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const maxIdeas = options.maxIdeas ?? MAX_PENDING_CROSSPOST_IDEAS;

  const result: CrossPostScanResult = {
    candidatesConsidered: 0,
    candidatesDropped: {
      noCompatibleTargets: 0,
      noBaseline: 0,
      belowVelocity: 0,
      recentlyProposed: 0,
      llmFallback: 0,
    },
    proposalsLogged: 0,
    ideasCreated: 0,
    ideasDetails: [],
  };

  // 1. Candidate pool — originals published in the fresh window that have at
  // least one view_snapshot in the target age window.
  const rawCandidates = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      thumbnail: productionItems.thumbnail,
      brand: productionItems.brand,
      accountId: productionItems.accountId,
      postType: productionItems.postType,
      contentBody: productionItems.contentBody,
      publishedDate: productionItems.publishedDate,
      publishedAt: productionItems.publishedAt,
      format: productionItems.format,
      pillarContentNotionId: productionItems.pillarContentNotionId,
      pillarContentItemId: productionItems.pillarContentItemId,
      mediaContentType: productionItems.mediaContentType,
      platform: productionItems.platform,
      accountHandle: accounts.handle,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(productionItems.accountId, accounts.id))
    .where(
      and(
        eq(productionItems.sourceType, "original"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        gte(
          productionItems.publishedAt,
          sql`(now() - interval '${sql.raw(String(FRESH_WINDOW_HOURS))} hours')`
        )
      )
    );

  if (rawCandidates.length === 0) return result;

  // 2. Pull every candidate's best "views at ~1h" snapshot in one query.
  const candidateIds = rawCandidates.map((c) => c.id);
  const viewsAt1hByItem = await fetchViewsAt1h(candidateIds);

  // 3. Compute per-(account, postType) baselines in one query.
  const baselines = await fetchBaselinesForGroups(
    rawCandidates
      .filter((c) => c.accountId && c.postType)
      .map((c) => ({ accountId: c.accountId!, postType: c.postType! }))
  );

  // 4. Pre-check 48h dedup in one query.
  const recentlyProposed = await fetchRecentlyProposed(candidateIds);

  // 5. Bulk-load all accounts grouped by brand slug — we'll need these for
  // target enumeration.
  const accountsByBrand = await fetchAccountsByBrand();

  // 6. Fetch feedback (past accepts + kills) once for the whole run.
  const pastOutcomes = await fetchPastOutcomes();

  // Collect decisions-to-log before we start inserting, so we can score
  // across candidates and admit Ideas in global-confidence order per brand.
  interface PendingDecision {
    candidate: Candidate;
    targetAccountId: string;
    targetPostType: string;
    confidence: number;
    reasoning: string;
  }
  const pending: PendingDecision[] = [];

  // Phase 1 — qualify candidates. Apply all filters that don't need the
  // LLM so we can sort survivors by velocity and cap LLM spend when the
  // caller asked us to.
  type RawCandidate = (typeof rawCandidates)[number];
  // Narrows the nullable fields we already guarded during qualification so
  // the LLM loop below can use them without non-null assertions.
  type QualifiedRaw = Omit<RawCandidate, "accountId" | "postType" | "publishedAt"> & {
    accountId: string;
    postType: string;
    publishedAt: Date;
  };
  interface QualifiedCandidate {
    raw: QualifiedRaw;
    viewsAt1h: number;
    velocityRatio: number;
  }
  const qualified: QualifiedCandidate[] = [];
  for (const raw of rawCandidates) {
    if (!raw.accountId || !raw.postType) continue;
    if (!raw.publishedAt) continue;
    if (!hasAnyCompatibleTarget(raw.postType as PostType)) {
      result.candidatesDropped.noCompatibleTargets++;
      continue;
    }
    const viewsAt1h = viewsAt1hByItem.get(raw.id);
    if (viewsAt1h == null) continue; // No snapshot yet.
    result.candidatesConsidered++;

    const baseline = baselines.get(`${raw.accountId}:${raw.postType}`);
    if (!baseline) {
      result.candidatesDropped.noBaseline++;
      continue;
    }
    const velocityRatio = viewsAt1h / Math.max(baseline, 1);
    if (velocityRatio < VELOCITY_MIN_RATIO) {
      result.candidatesDropped.belowVelocity++;
      continue;
    }
    if (recentlyProposed.has(raw.id)) {
      result.candidatesDropped.recentlyProposed++;
      continue;
    }
    qualified.push({
      raw: raw as QualifiedRaw,
      viewsAt1h,
      velocityRatio,
    });
  }

  // Top-N by velocity. When maxCandidates is Infinity this is effectively
  // a no-op sort; when the caller passes a real cap, we process only the
  // strongest-growing items.
  const topQualified = qualified
    .sort((a, b) => b.velocityRatio - a.velocityRatio)
    .slice(0, Number.isFinite(maxCandidates) ? maxCandidates : qualified.length);

  // Phase 2 — LLM classification + decision logging.
  for (const { raw, viewsAt1h, velocityRatio } of topQualified) {
    // Enumerate candidate targets: all accounts in the source's brand that
    // (a) aren't the source account and (b) support at least one post type
    // in the source's compatibility list.
    const compats = compatibleTargetsFor(raw.postType as PostType);
    const brandAccounts = accountsByBrand.get(raw.brand) ?? [];
    const targets: CandidateTarget[] = [];
    for (const acct of brandAccounts) {
      if (acct.id === raw.accountId) continue;
      const supported = PLATFORM_META[toPlatform(acct.platform)].postTypes;
      for (const pt of supported) {
        if (!compats.includes(pt as PostType)) continue;
        if (isNotionAuthoritative(pt)) continue; // Can't auto-create on Notion-owned channels.
        targets.push({
          targetAccountId: acct.id,
          handle: acct.handle,
          platform: acct.platform,
          postType: pt,
        });
      }
    }
    if (targets.length === 0) {
      result.candidatesDropped.noCompatibleTargets++;
      continue;
    }

    const candidate: Candidate = {
      id: raw.id,
      title: raw.title,
      thumbnail: raw.thumbnail,
      brand: raw.brand,
      accountId: raw.accountId,
      postType: raw.postType,
      contentBody: raw.contentBody,
      publishedDate: raw.publishedDate,
      publishedAt: raw.publishedAt,
      format: raw.format,
      pillarContentNotionId: raw.pillarContentNotionId,
      pillarContentItemId: raw.pillarContentItemId,
      mediaContentType: raw.mediaContentType,
      platform: (raw.platform as string[] | null) ?? null,
      sourceAccountHandle: raw.accountHandle,
      viewsAt1h,
      velocityRatio,
    };

    const media = deriveMediaFromItem(candidate.mediaContentType);
    const richMedia = await fetchMediaSignals([candidate.id]);
    const finalMedia = richMedia.get(candidate.id) ?? media;

    const sourceAccount = brandAccounts.find(
      (a) => a.id === candidate.accountId
    );
    const rec = await recommendCrossPosts({
      title: candidate.title,
      contentBody: candidate.contentBody,
      sourcePlatform: sourceAccount?.platform ?? "unknown",
      sourcePostType: candidate.postType,
      sourceAccountHandle: candidate.sourceAccountHandle,
      brand: candidate.brand,
      publishedDate: candidate.publishedDate,
      viewsAt1h: candidate.viewsAt1h,
      velocityRatio: candidate.velocityRatio,
      hasVideo: finalMedia.hasVideo,
      hasImage: finalMedia.hasImage,
      mediaCount: finalMedia.mediaCount,
      candidates: targets,
      pastOutcomes,
    });

    if (rec.isFallback) {
      result.candidatesDropped.llmFallback++;
      continue;
    }

    // Log every proposal to cross_post_decisions so the operator can see
    // what the model thought, even for low-confidence/unadmitted ones.
    for (const p of rec.proposals) {
      const [inserted] = await db
        .insert(crossPostDecisions)
        .values({
          sourceItemId: candidate.id,
          targetAccountId: p.targetAccountId,
          targetPostType: p.targetPostType,
          confidence: p.confidence,
          reasoning: p.reasoning,
        })
        .returning({ id: crossPostDecisions.id });
      result.proposalsLogged++;

      pending.push({
        candidate,
        targetAccountId: p.targetAccountId,
        targetPostType: p.targetPostType,
        confidence: p.confidence,
        reasoning: p.reasoning,
      });

      // Track the decision id so we can backfill idea_item_id if it gets
      // admitted below.
      (p as Proposal & { _decisionId: string })._decisionId = inserted.id;
    }
  }

  // 7. Admit pending proposals to the Idea queue in confidence order,
  // subject to MIN_CONFIDENCE and per-brand caps.
  const sortedPending = pending
    .filter((p) => p.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);

  const slotsByBrand = new Map<string, number>();
  for (const p of sortedPending) {
    let slots = slotsByBrand.get(p.candidate.brand);
    if (slots == null) {
      const pendingCount = await countPendingCrossPostIdeas(p.candidate.brand);
      slots = Math.max(0, maxIdeas - pendingCount);
      slotsByBrand.set(p.candidate.brand, slots);
    }
    if (slots <= 0) continue;

    // Insert the Idea row.
    const assignees = await resolveAssignees({
      brand: p.candidate.brand,
      sourceItemId: p.candidate.id,
      format: p.candidate.format,
    });

    const targetPlatformKey = (() => {
      const ta = accountsByBrand
        .get(p.candidate.brand)
        ?.find((a) => a.id === p.targetAccountId);
      return ta?.platform ?? null;
    })();

    const [inserted] = await db
      .insert(productionItems)
      .values({
        brand: p.candidate.brand,
        title: p.candidate.title,
        thumbnail: p.candidate.thumbnail,
        status: "Idea",
        platform: targetPlatformKey ? [targetPlatformKey] : null,
        accountId: p.targetAccountId,
        postType: p.targetPostType,
        sourceType: "cross_post",
        repostedFromItemId: p.candidate.id,
        format: p.candidate.format,
        pillarContentNotionId: p.candidate.pillarContentNotionId,
        pillarContentItemId: p.candidate.pillarContentItemId,
        utmCampaign: await generateUtmCampaign(p.candidate.title),
        producerUserId: assignees.producerUserId,
        editorUserId: assignees.editorUserId,
        crossPostConfidence: p.confidence,
      })
      .returning({ id: productionItems.id });

    // Link back the decision row so the feed can show which decision
    // produced which idea.
    await db
      .update(crossPostDecisions)
      .set({ ideaItemId: inserted.id })
      .where(
        and(
          eq(crossPostDecisions.sourceItemId, p.candidate.id),
          eq(crossPostDecisions.targetAccountId, p.targetAccountId),
          eq(crossPostDecisions.targetPostType, p.targetPostType),
          isNull(crossPostDecisions.ideaItemId)
        )
      );

    result.ideasCreated++;
    result.ideasDetails.push({
      sourceItemId: p.candidate.id,
      newItemId: inserted.id,
      targetAccountId: p.targetAccountId,
      targetPostType: p.targetPostType,
      confidence: p.confidence,
      title: p.candidate.title ?? "(untitled)",
    });

    slotsByBrand.set(p.candidate.brand, slots - 1);
  }

  return result;
}

// ─── helpers ─────────────────────────────────────────────────────────────

interface MediaSignals {
  hasVideo: boolean;
  hasImage: boolean;
  mediaCount: number;
}

interface Proposal {
  targetAccountId: string;
  targetPostType: string;
  confidence: number;
  reasoning: string;
}

async function fetchMediaSignals(
  itemIds: string[]
): Promise<Map<string, MediaSignals>> {
  const map = new Map<string, MediaSignals>();
  if (itemIds.length === 0) return map;

  const rows = await db
    .select({
      productionItemId: productionItemMedia.productionItemId,
      kind: productionItemMedia.kind,
    })
    .from(productionItemMedia)
    .where(inArray(productionItemMedia.productionItemId, itemIds));

  for (const row of rows) {
    const existing = map.get(row.productionItemId) ?? {
      hasVideo: false,
      hasImage: false,
      mediaCount: 0,
    };
    if (row.kind === "video") existing.hasVideo = true;
    if (row.kind === "image") existing.hasImage = true;
    existing.mediaCount += 1;
    map.set(row.productionItemId, existing);
  }

  return map;
}

function deriveMediaFromItem(mediaContentType: string | null): MediaSignals {
  if (!mediaContentType) return { hasVideo: false, hasImage: false, mediaCount: 0 };
  const isVideo = mediaContentType.startsWith("video/");
  const isImage = mediaContentType.startsWith("image/");
  return {
    hasVideo: isVideo,
    hasImage: isImage,
    mediaCount: isVideo || isImage ? 1 : 0,
  };
}

/**
 * For each item, pick the view_snapshots row whose post_age_minutes is
 * closest to 60 within the [TARGET_AGE_MIN, TARGET_AGE_MAX] window. Returns
 * a map of itemId → views.
 */
async function fetchViewsAt1h(
  itemIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (itemIds.length === 0) return map;

  const rows = await db.execute<{
    production_item_id: string;
    views: number;
  }>(
    sql`
      SELECT DISTINCT ON (production_item_id)
        production_item_id,
        views
      FROM view_snapshots
      WHERE production_item_id IN (${sql.join(
        itemIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
        AND post_age_minutes BETWEEN ${TARGET_AGE_MIN} AND ${TARGET_AGE_MAX}
      ORDER BY production_item_id, abs(post_age_minutes - 60) ASC
    `
  );
  for (const row of rows) {
    map.set(row.production_item_id, row.views);
  }
  return map;
}

/**
 * Baseline: for each (accountId, postType) group, compute the median
 * "views at ~1h" across the last BASELINE_WINDOW_DAYS of published originals
 * that have such a snapshot. Returns a map keyed `${accountId}:${postType}`.
 * Groups with fewer than MIN_COHORT_SIZE items are omitted (too noisy to
 * compare against).
 */
async function fetchBaselinesForGroups(
  groups: Array<{ accountId: string; postType: string }>
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (groups.length === 0) return map;

  const uniqueKeys = Array.from(
    new Set(groups.map((g) => `${g.accountId}:${g.postType}`))
  );

  // One query: pre-aggregate the nearest-to-60m snapshot per item over the
  // baseline window, then group by (accountId, postType) and compute median
  // with percentile_cont plus a cohort count for the size gate.
  const rows = await db.execute<{
    account_id: string;
    post_type: string;
    baseline: number;
    cohort_size: number;
  }>(
    sql`
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
          AND pi.published_at >= (now() - interval '${sql.raw(
            String(BASELINE_WINDOW_DAYS)
          )} days')
          AND vs.post_age_minutes BETWEEN ${TARGET_AGE_MIN} AND ${TARGET_AGE_MAX}
        ORDER BY pi.id, abs(vs.post_age_minutes - 60) ASC
      )
      SELECT account_id,
             post_type,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY views) AS baseline,
             count(*) AS cohort_size
      FROM per_item
      GROUP BY account_id, post_type
      HAVING count(*) >= ${MIN_COHORT_SIZE}
    `
  );

  for (const row of rows) {
    const key = `${row.account_id}:${row.post_type}`;
    if (!uniqueKeys.includes(key)) continue;
    map.set(key, Number(row.baseline));
  }
  return map;
}

async function fetchRecentlyProposed(itemIds: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  if (itemIds.length === 0) return set;

  const rows = await db
    .select({ sourceItemId: crossPostDecisions.sourceItemId })
    .from(crossPostDecisions)
    .where(
      and(
        inArray(crossPostDecisions.sourceItemId, itemIds),
        gte(
          crossPostDecisions.proposedAt,
          sql`(now() - interval '${sql.raw(String(DEDUP_WINDOW_HOURS))} hours')`
        )
      )
    );
  for (const row of rows) set.add(row.sourceItemId);
  return set;
}

async function fetchAccountsByBrand(): Promise<
  Map<string, Array<{ id: string; platform: string; handle: string; brandId: string }>>
> {
  const rows = await db
    .select({
      id: accounts.id,
      platform: accounts.platform,
      handle: accounts.handle,
      brandId: accounts.brandId,
      brandSlug: brands.slug,
    })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(isNull(accounts.deletedAt), eq(accounts.isActive, true)));

  const map = new Map<
    string,
    Array<{ id: string; platform: string; handle: string; brandId: string }>
  >();
  for (const r of rows) {
    const list = map.get(r.brandSlug) ?? [];
    list.push({
      id: r.id,
      platform: r.platform,
      handle: r.handle,
      brandId: r.brandId,
    });
    map.set(r.brandSlug, list);
  }
  return map;
}

async function countPendingCrossPostIdeas(brand: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.sourceType, "cross_post"),
        eq(productionItems.status, "Idea"),
        isNull(productionItems.deletedAt)
      )
    );
  return row?.n ?? 0;
}

/**
 * Load the last FEEDBACK_HISTORY accept + kill events across all cross-post
 * items, with a short tag describing the (source→target) pair. The LLM uses
 * these as soft policy so the operator's taste gets learned.
 */
async function fetchPastOutcomes(): Promise<PastOutcome[]> {
  // Pull killed and accepted events on cross-post items, joined back through
  // production_items so we can tag each reason with the target account
  // (platform/postType) it applied to. Killed events exist today; accepted
  // events are emitted by the v2 outcome route.
  const rows = await db
    .select({
      eventType: sql<string>`${contentEvents.payload}->>'type'`,
      reason: sql<string>`${contentEvents.payload}->>'reason'`,
      targetPostType: productionItems.postType,
      createdAt: contentEvents.createdAt,
    })
    .from(contentEvents)
    .innerJoin(
      productionItems,
      eq(productionItems.id, contentEvents.contentItemId)
    )
    .where(
      and(
        eq(productionItems.sourceType, "cross_post"),
        sql`${contentEvents.payload}->>'type' IN ('killed', 'accepted')`,
        sql`${contentEvents.payload}->>'reason' IS NOT NULL`,
        sql`length(${contentEvents.payload}->>'reason') >= 10`
      )
    )
    .orderBy(desc(contentEvents.createdAt))
    .limit(FEEDBACK_HISTORY * 2);

  return rows.map((r) => ({
    outcome: r.eventType === "accepted" ? "accepted" : "killed",
    reason: r.reason,
    pair: r.targetPostType ? `→ ${r.targetPostType}` : null,
  }));
}
