import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  brands,
  contentEvents,
  productionItems,
  viewSnapshots,
} from "@/lib/db/schema";
import { POST_TYPE_SHORT_LABEL } from "@/lib/platforms";
import type { PostType } from "@/lib/platform-field-schemas";
import {
  fetchAccountFormatViewBars,
  fetchBrandFormatViewBars,
  fetchFormatViewBars,
  fetchFormatCheckpointBars,
  type AccountFormatBars,
  type BrandFormatBars,
  type FormatBars,
  type FormatCheckpointBars,
} from "@/lib/services/format-view-bars";

// Repost candidate queue v2 — live percentile-within-format×account view.
//
// Mirrors the cross-post v3 pattern (live query, no pre-populated Idea
// rows, hotness ratios, signal breakdown UI), but aimed at the opposite
// end of the post lifecycle:
//   - cross-post v3: candidates from the last 21 days, low bar (P60×1.0)
//   - repost v2: candidates that are MONTHS or YEARS old, high bar
//     (P75×1.5, ≈ top 10-12% of evergreen), strict per-account cohort
//
// The "elite evergreen" framing: a candidate must outperform its peers
// on the same channel in the same format. Otherwise it's just a post
// that did okay once — not worth re-running.

const COHORT_PERCENTILE = 0.75;
const HOTNESS_THRESHOLD = 1.5;
const MIN_COHORT = 5;
const DISMISSAL_TTL_DAYS = 30;
/** Cross-brand fallback cohort window. The first two tiers are all-time
 *  (account/brand cohorts are usually small enough that we want every
 *  data point); tier 3 is broad enough that 365 days is plenty. */
const FORMAT_FALLBACK_WINDOW_DAYS = 365;

/** Source types eligible for the repost queue. Excludes `repost` itself
 *  (no recursion) and items synced as a duplicate of an external post.
 *  `repurposed` covers the old `clip` value after the 2026-05-11
 *  consolidation. */
const ELIGIBLE_SOURCE_TYPES = [
  "original",
  "cross_post",
  "repurposed",
] as const;

/** A repost can't be in flight on the same source. These statuses count
 *  as "in flight" — Killed and Published-but-old don't. */
const PENDING_REPOST_STATUSES = ["Idea", "Assigned", "Ready To Publish"] as const;

/** Minimum age before an item is even considered for repost. The
 *  "evergreen months/years later" intent means we want the original to
 *  have settled — not a post that's still aging into its lifetime view
 *  count. Falls back to 180 for any platform not listed. */
const MIN_AGE_DAYS_BY_PLATFORM: Record<string, number> = {
  x: 365,
  instagram: 90,
  linkedin: 180,
  threads: 180,
  youtube: 180,
  tiktok: 180,
};
const MIN_AGE_DAYS_DEFAULT = 180;

/** Cooldown since the last *published* repost on the same source. Avoids
 *  re-recommending an already-recently-reposted hit. */
const COOLDOWN_DAYS_BY_PLATFORM: Record<string, number> = {
  x: 120,
  instagram: 30,
  linkedin: 60,
  threads: 60,
  youtube: 60,
  tiktok: 60,
};
const COOLDOWN_DAYS_DEFAULT = 60;

const CHECKPOINT_LABEL: Record<string, string> = {
  "15m": "15 min after publish",
  "30m": "30 min after publish",
  "1h": "1h after publish",
  "2h": "2h after publish",
  "4h": "4h after publish",
  "8h": "8h after publish",
  "24h": "24h after publish",
  "48h": "48h after publish",
};

export interface HotnessSignal {
  /** "lifetime" or one of the velocity checkpoint keys. */
  kind: string;
  label: string;
  views: number;
  bar: number;
  ratio: number;
  percentile: number;
  cohortSize: number;
  /** Which cohort tier produced this bar. UI surfaces a fallback marker
   *  when not the strict per-account cohort. */
  cohortKind: "account" | "brand" | "format";
  cohortLabel: string;
}

export interface PriorRepost {
  productionItemId: string;
  status: string | null;
  publishedAt: string | null;
  /** `published_date` (date) fallback — older synced items often have this
   *  set but no `published_at` timestamp, so the modal can still surface a
   *  date for them. */
  publishedDate: string | null;
  views: number | null;
  likes: number | null;
  killReason: string | null;
}

export interface RepostCandidate {
  id: string;
  brand: string;
  title: string | null;
  thumbnail: string | null;
  publishedAt: string | null;
  publishedDate: string | null;
  publishedLink: string | null;
  postType: string;
  format: string;
  sourceType: string;
  views: number;
  likes: number | null;
  comments: number | null;
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  pillarContentItemId: string | null;
  pillarContentTitle: string | null;
  hotnessSignals: HotnessSignal[];
  topSignal: HotnessSignal | null;
  hotnessRatio: number;
  whyHot: string;
  /** Existing reposts on this source (Published or otherwise non-Killed),
   *  surfaced in the modal so editors see the lineage. Killed reposts
   *  are NEVER surfaced — that candidate is permanently blocked, so it
   *  never reaches `items[]`. */
  priorReposts: PriorRepost[];
  /** Optional flavor text from the LLM evergreen classifier (Phase A of
   *  evergreen-scan). Reused as-is from v1. May be null. */
  evergreenReasoning: string | null;
}

export interface RepostCandidatesResult {
  items: RepostCandidate[];
  stats: {
    rawCandidates: number;
    droppedDismissed: number;
    droppedPriorKilled: number;
    droppedCooldown: number;
    droppedPendingInFlight: number;
    droppedNoCohort: number;
    droppedBelowThreshold: number;
  };
  config: {
    cohortPercentile: number;
    hotnessThreshold: number;
    minCohort: number;
    minAgeDaysByPlatform: Record<string, number>;
    minAgeDaysDefault: number;
  };
}

export async function selectRepostCandidates(opts: {
  brand: string;
}): Promise<RepostCandidatesResult> {
  const { brand } = opts;

  const stats = {
    rawCandidates: 0,
    droppedDismissed: 0,
    droppedPriorKilled: 0,
    droppedCooldown: 0,
    droppedPendingInFlight: 0,
    droppedNoCohort: 0,
    droppedBelowThreshold: 0,
  };

  // Resolve brand → brand id once. Used for the brand-cohort fallback
  // tier and for filtering the candidate query (productionItems.brand
  // is a slug, but the cohort fetch keys off accounts.brand_id).
  const [brandRow] = await db
    .select({ id: brands.id, slug: brands.slug })
    .from(brands)
    .where(eq(brands.slug, brand))
    .limit(1);
  if (!brandRow) {
    return {
      items: [],
      stats,
      config: configBlock(),
    };
  }

  // Eligibility filter (SQL): brand-scoped, eligible source type, all
  // required fields populated. Per-platform min-age applied in code
  // because per-row age depends on the joined account.platform.
  const rawCandidates = await db
    .select({
      id: productionItems.id,
      brand: productionItems.brand,
      title: productionItems.title,
      thumbnail: productionItems.thumbnail,
      publishedAt: productionItems.publishedAt,
      publishedDate: productionItems.publishedDate,
      publishedLink: productionItems.publishedLink,
      postType: productionItems.postType,
      format: productionItems.format,
      sourceType: productionItems.sourceType,
      views: productionItems.views,
      likes: productionItems.likes,
      comments: productionItems.comments,
      accountId: productionItems.accountId,
      pillarContentItemId: productionItems.pillarContentItemId,
      evergreenReasoning: productionItems.evergreenReasoning,
      accountPlatform: accounts.platform,
      accountHandle: accounts.handle,
      accountDisplayName: accounts.displayName,
      accountAvatarUrl: accounts.avatarUrl,
    })
    .from(productionItems)
    .innerJoin(accounts, eq(productionItems.accountId, accounts.id))
    .where(
      and(
        eq(productionItems.brand, brand),
        inArray(productionItems.sourceType, [...ELIGIBLE_SOURCE_TYPES]),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${productionItems.views} IS NOT NULL AND ${productionItems.views} > 0`,
        sql`${productionItems.format} IS NOT NULL`,
        sql`${productionItems.postType} IS NOT NULL`,
        sql`${productionItems.publishedAt} IS NOT NULL`,
      )
    );

  stats.rawCandidates = rawCandidates.length;

  if (rawCandidates.length === 0) {
    return { items: [], stats, config: configBlock() };
  }

  // Apply per-platform minimum age. Done in code rather than SQL so the
  // per-platform map is the single source of truth.
  const ageEligible = rawCandidates.filter((c) => {
    if (!c.publishedAt) return false;
    const minDays =
      MIN_AGE_DAYS_BY_PLATFORM[c.accountPlatform] ?? MIN_AGE_DAYS_DEFAULT;
    const ageMs = Date.now() - c.publishedAt.getTime();
    return ageMs >= minDays * 86_400_000;
  });

  if (ageEligible.length === 0) {
    return { items: [], stats, config: configBlock() };
  }

  const candidateIds = ageEligible.map((c) => c.id);

  // Cohort bars — three tiers, all P75. Account and brand cohorts are
  // all-time; cross-brand falls back to a 365-day window.
  const accountIds = Array.from(
    new Set(ageEligible.map((c) => c.accountId).filter((x): x is string => !!x))
  );
  const [
    accountFormatBars,
    brandFormatBars,
    crossBrandFormatBars,
    checkpointFormatBars,
  ] = await Promise.all([
    fetchAccountFormatViewBars({
      accountIds,
      percentile: COHORT_PERCENTILE,
      minCohort: MIN_COHORT,
      windowDays: undefined,
    }),
    fetchBrandFormatViewBars({
      brandIds: [brandRow.id],
      percentile: COHORT_PERCENTILE,
      minCohort: MIN_COHORT,
      windowDays: undefined,
    }),
    fetchFormatViewBars({
      percentile: COHORT_PERCENTILE,
      minCohort: MIN_COHORT,
      windowDays: FORMAT_FALLBACK_WINDOW_DAYS,
    }),
    fetchFormatCheckpointBars({
      percentile: COHORT_PERCENTILE,
      minCohort: MIN_COHORT,
      // Velocity snapshots only exist for items younger than ~2 weeks
      // at capture time, so the 90-day cohort window is always plenty.
      // (Repost candidates themselves are old, but the cohort bar is
      // built from the format's recent snapshots.)
      windowDays: 90,
    }),
  ]);

  // Velocity snapshots for each candidate. Most repost candidates are
  // far older than the snapshot pipeline (2026+), so this is usually
  // empty; we surface the signals when they happen to be there.
  const snapshotRows = await db
    .select({
      productionItemId: viewSnapshots.productionItemId,
      checkpointKey: viewSnapshots.checkpointKey,
      views: viewSnapshots.views,
    })
    .from(viewSnapshots)
    .where(
      and(
        inArray(viewSnapshots.productionItemId, candidateIds),
        sql`${viewSnapshots.checkpointKey} IS NOT NULL`
      )
    );
  const snapshotsByItem = new Map<string, Map<string, number>>();
  for (const row of snapshotRows) {
    if (!row.checkpointKey) continue;
    const m = snapshotsByItem.get(row.productionItemId) ?? new Map();
    m.set(row.checkpointKey, row.views);
    snapshotsByItem.set(row.productionItemId, m);
  }

  // Existing reposts on each candidate (any status, including Killed —
  // we use Killed to permanent-block the source). Sort by createdAt
  // desc so cooldown checks against the latest published repost.
  const existingReposts = await db
    .select({
      sourceItemId: productionItems.repostedFromItemId,
      productionItemId: productionItems.id,
      status: productionItems.status,
      publishedAt: productionItems.publishedAt,
      publishedDate: productionItems.publishedDate,
      views: productionItems.views,
      likes: productionItems.likes,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "repost"),
        inArray(productionItems.repostedFromItemId, candidateIds),
        isNull(productionItems.deletedAt)
      )
    );

  // For Killed reposts we want the kill reason for the modal. Pull
  // content_events of type 'killed' for those rows.
  const killedRepostIds = existingReposts
    .filter((r) => r.status === "Killed")
    .map((r) => r.productionItemId);
  const killReasonsByRepost = new Map<string, string | null>();
  if (killedRepostIds.length > 0) {
    const killEvents = await db
      .select({
        contentItemId: contentEvents.contentItemId,
        payload: contentEvents.payload,
        createdAt: contentEvents.createdAt,
      })
      .from(contentEvents)
      .where(
        and(
          eq(contentEvents.eventType, "killed"),
          inArray(contentEvents.contentItemId, killedRepostIds)
        )
      )
      .orderBy(desc(contentEvents.createdAt));
    for (const ev of killEvents) {
      if (killReasonsByRepost.has(ev.contentItemId)) continue;
      const reason =
        ev.payload && typeof ev.payload === "object" && "reason" in ev.payload
          ? (ev.payload as { reason?: string | null }).reason ?? null
          : null;
      killReasonsByRepost.set(ev.contentItemId, reason);
    }
  }

  const repostsBySource = new Map<string, typeof existingReposts>();
  for (const r of existingReposts) {
    if (!r.sourceItemId) continue;
    const list = repostsBySource.get(r.sourceItemId) ?? [];
    list.push(r);
    repostsBySource.set(r.sourceItemId, list);
  }

  // Dismissals — 30d hide-list.
  const dismissalRows = await db
    .select({ contentItemId: contentEvents.contentItemId })
    .from(contentEvents)
    .where(
      and(
        eq(contentEvents.eventType, "repost_dismissed"),
        inArray(contentEvents.contentItemId, candidateIds),
        gte(
          contentEvents.createdAt,
          sql`(now() - interval '${sql.raw(String(DISMISSAL_TTL_DAYS))} days')`
        )
      )
    );
  const dismissedIds = new Set(dismissalRows.map((r) => r.contentItemId));

  // Pillar titles for the table column.
  const pillarIds = Array.from(
    new Set(
      ageEligible
        .map((c) => c.pillarContentItemId)
        .filter((x): x is string => !!x)
    )
  );
  const pillarTitleById = new Map<string, string | null>();
  if (pillarIds.length > 0) {
    const pillars = await db
      .select({ id: productionItems.id, title: productionItems.title })
      .from(productionItems)
      .where(inArray(productionItems.id, pillarIds));
    for (const p of pillars) pillarTitleById.set(p.id, p.title);
  }

  void lte; // imported for potential future filters; keep linter quiet

  const items: RepostCandidate[] = [];

  for (const c of ageEligible) {
    if (!c.accountId || !c.format || !c.postType || c.views == null) continue;

    if (dismissedIds.has(c.id)) {
      stats.droppedDismissed++;
      continue;
    }

    const reposts = repostsBySource.get(c.id) ?? [];

    // Permanent block: any prior repost that was killed → never surface
    // this source again. The editor explicitly rejected the idea once.
    const hasKilledRepost = reposts.some((r) => r.status === "Killed");
    if (hasKilledRepost) {
      stats.droppedPriorKilled++;
      continue;
    }

    // Pending block: repost in flight (Idea / Assigned / Ready To Publish).
    const hasPending = reposts.some(
      (r) => r.status && (PENDING_REPOST_STATUSES as readonly string[]).includes(r.status)
    );
    if (hasPending) {
      stats.droppedPendingInFlight++;
      continue;
    }

    // Cooldown: skip if the most recent Published repost on this source
    // is still within the platform's cooldown window.
    const cooldownDays =
      COOLDOWN_DAYS_BY_PLATFORM[c.accountPlatform] ?? COOLDOWN_DAYS_DEFAULT;
    const cooldownCutoffMs = Date.now() - cooldownDays * 86_400_000;
    const tooRecentRepost = reposts.some(
      (r) =>
        r.status === "Published" &&
        r.publishedAt &&
        r.publishedAt.getTime() > cooldownCutoffMs
    );
    if (tooRecentRepost) {
      stats.droppedCooldown++;
      continue;
    }

    const signals = computeHotnessSignals({
      candidate: {
        accountId: c.accountId,
        format: c.format,
        postType: c.postType,
        views: c.views,
      },
      brandId: brandRow.id,
      accountFormatBars,
      brandFormatBars,
      crossBrandFormatBars,
      checkpointFormatBars,
      snapshots: snapshotsByItem.get(c.id) ?? null,
    });

    if (signals.length === 0) {
      // Reposts MUST have evidence — unlike cross-post v3, we don't
      // auto-admit cohort-less items. The whole pitch is "this beat its
      // peers"; with no peers there's no claim to make.
      stats.droppedNoCohort++;
      continue;
    }

    const topSignal = signals[0];
    const hotnessRatio = topSignal.ratio;
    if (hotnessRatio < HOTNESS_THRESHOLD) {
      stats.droppedBelowThreshold++;
      continue;
    }
    const whyHot = buildWhyHot(topSignal);

    const priorReposts: PriorRepost[] = reposts.map((r) => ({
      productionItemId: r.productionItemId,
      status: r.status,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      publishedDate: r.publishedDate ?? null,
      views: r.views,
      likes: r.likes,
      killReason: killReasonsByRepost.get(r.productionItemId) ?? null,
    }));

    items.push({
      id: c.id,
      brand: c.brand,
      title: c.title,
      thumbnail: c.thumbnail,
      publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
      publishedDate: c.publishedDate,
      publishedLink: c.publishedLink,
      postType: c.postType,
      format: c.format,
      sourceType: c.sourceType,
      views: c.views,
      likes: c.likes,
      comments: c.comments,
      account: {
        id: c.accountId,
        platform: c.accountPlatform ?? "",
        handle: c.accountHandle ?? "",
        displayName: c.accountDisplayName,
        avatarUrl: c.accountAvatarUrl,
      },
      pillarContentItemId: c.pillarContentItemId,
      pillarContentTitle: c.pillarContentItemId
        ? pillarTitleById.get(c.pillarContentItemId) ?? null
        : null,
      hotnessSignals: signals,
      topSignal,
      hotnessRatio,
      whyHot,
      priorReposts,
      evergreenReasoning: c.evergreenReasoning,
    });
  }

  items.sort((a, b) => b.hotnessRatio - a.hotnessRatio);

  return { items, stats, config: configBlock() };
}

function configBlock() {
  return {
    cohortPercentile: COHORT_PERCENTILE,
    hotnessThreshold: HOTNESS_THRESHOLD,
    minCohort: MIN_COHORT,
    minAgeDaysByPlatform: MIN_AGE_DAYS_BY_PLATFORM,
    minAgeDaysDefault: MIN_AGE_DAYS_DEFAULT,
  };
}

interface ComputeHotnessOpts {
  candidate: {
    accountId: string;
    format: string;
    postType: string;
    views: number;
  };
  brandId: string;
  accountFormatBars: AccountFormatBars;
  brandFormatBars: BrandFormatBars;
  crossBrandFormatBars: FormatBars;
  checkpointFormatBars: FormatCheckpointBars;
  snapshots: Map<string, number> | null;
}

function pickLifetimeBar(
  opts: Omit<ComputeHotnessOpts, "snapshots">
):
  | {
      bar: { p: number; percentile: number; cohortSize: number };
      cohortKind: "account" | "brand" | "format";
      cohortLabel: string;
    }
  | null {
  const { candidate, brandId, accountFormatBars, brandFormatBars, crossBrandFormatBars } = opts;
  // Tier 1: account × format × postType
  const ab = accountFormatBars[candidate.accountId]?.[candidate.format]?.[candidate.postType];
  if (ab && ab.p > 0) {
    return {
      bar: ab,
      cohortKind: "account",
      cohortLabel: cohortLabelAccount(candidate.format, candidate.postType),
    };
  }
  // Tier 2: brand × format × postType
  const bb = brandFormatBars[brandId]?.[candidate.format]?.[candidate.postType];
  if (bb && bb.p > 0) {
    return {
      bar: bb,
      cohortKind: "brand",
      cohortLabel: cohortLabelBrand(candidate.format, candidate.postType),
    };
  }
  // Tier 3: cross-brand format × postType (365-day window)
  const fb = crossBrandFormatBars[candidate.format]?.[candidate.postType];
  if (fb && fb.p > 0) {
    return {
      bar: fb,
      cohortKind: "format",
      cohortLabel: cohortLabelFormat(candidate.format, candidate.postType),
    };
  }
  return null;
}

function cohortLabelAccount(format: string, postType: string): string {
  const short = POST_TYPE_SHORT_LABEL[postType as PostType] ?? postType;
  return `${format} (${short}) on this account`;
}

function cohortLabelBrand(format: string, postType: string): string {
  const short = POST_TYPE_SHORT_LABEL[postType as PostType] ?? postType;
  return `${format} (${short}) brand-wide`;
}

function cohortLabelFormat(format: string, postType: string): string {
  const short = POST_TYPE_SHORT_LABEL[postType as PostType] ?? postType;
  return `${format} (${short}) across all brands`;
}

function computeHotnessSignals(opts: ComputeHotnessOpts): HotnessSignal[] {
  const { candidate, snapshots, checkpointFormatBars } = opts;
  const out: HotnessSignal[] = [];

  // Lifetime — the admission gate.
  const lifetime = pickLifetimeBar(opts);
  if (lifetime) {
    out.push({
      kind: "lifetime",
      label: "Lifetime",
      views: candidate.views,
      bar: lifetime.bar.p,
      ratio: candidate.views / lifetime.bar.p,
      percentile: lifetime.bar.percentile,
      cohortSize: lifetime.bar.cohortSize,
      cohortKind: lifetime.cohortKind,
      cohortLabel: lifetime.cohortLabel,
    });
  }

  // Velocity — bonus signals when snapshot rows happen to exist.
  // Cohort here is just the strict (format, postType) cross-brand
  // checkpoint bar; per-account checkpoint cohorts are too sparse to
  // be useful.
  if (snapshots) {
    for (const [key, viewsAtCheckpoint] of snapshots) {
      const fb =
        checkpointFormatBars[candidate.format]?.[candidate.postType]?.[key];
      if (!fb || fb.p <= 0) continue;
      out.push({
        kind: key,
        label: CHECKPOINT_LABEL[key] ?? key,
        views: viewsAtCheckpoint,
        bar: fb.p,
        ratio: viewsAtCheckpoint / fb.p,
        percentile: fb.percentile,
        cohortSize: fb.cohortSize,
        cohortKind: "format",
        cohortLabel: cohortLabelFormat(candidate.format, candidate.postType),
      });
    }
  }

  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

function buildWhyHot(top: HotnessSignal): string {
  const flavor =
    top.ratio >= 10
      ? "Off the charts"
      : top.ratio >= 5
        ? "Crushing it"
        : top.ratio >= 3
          ? "Outlier"
          : top.ratio >= 2
            ? "Well above average"
            : "Above the top quartile";
  const ratio = top.ratio.toFixed(1);
  return `${flavor} — ${ratio}× the typical ${top.cohortLabel}. ${formatNum(top.views)} views vs typical ${formatNum(top.bar)}.`;
}

function formatNum(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString();
}
