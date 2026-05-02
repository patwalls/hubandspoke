import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  brands,
  contentEvents,
  productionItems,
  viewSnapshots,
} from "@/lib/db/schema";
import { isNotionAuthoritative } from "@/lib/platform";
import { PLATFORM_META, toPlatform } from "@/lib/platforms";
import {
  fetchFormatViewBars,
  fetchFormatCheckpointBars,
  type FormatBars,
  type FormatCheckpointBars,
} from "@/lib/services/format-view-bars";

// Cross-post queue v3.2 — candidate finder.
//
// "Hot" is the max of multiple ratios per candidate:
//   - velocity ratio at each available capture-velocity-snapshot checkpoint
//     (15m / 30m / 1h / 2h / 4h / 8h / 24h / 48h) vs the same-checkpoint P60
//     across the format's 90-day cohort
//   - lifetime ratio: cumulative views vs the format's lifetime P60
//
// We take the strongest signal so a 6-hour-old rocket isn't penalized
// against a cohort that's had days to mature, while older posts that didn't
// pop early but accumulated views still surface via the lifetime path.
//
// Admit when max(ratio) >= 1.0. New formats with no cohort at all are
// auto-admitted — the operator wanted to be able to surface posts in
// a brand-new format immediately. Sort by max-ratio desc.

const CANDIDATE_WINDOW_DAYS = 21;
const DISMISSAL_TTL_DAYS = 30;
const HOTNESS_THRESHOLD = 1.0;
const PERCENTILE = 0.6; // P60 — looser than P75 to compensate for age bias.
const COHORT_WINDOW_DAYS = 90;

/** Source types eligible for the cross-post queue. Excludes `cross_post`
 *  to avoid recommending cross-posts of cross-posts. */
const ELIGIBLE_SOURCE_TYPES = ["original", "clip", "repost"] as const;

export interface HotnessSignal {
  /** "lifetime" or one of the velocity checkpoint keys (15m/30m/1h/...). */
  kind: string;
  /** Human-friendly label rendered in the UI ("Lifetime", "1h after publish"). */
  label: string;
  /** Candidate's views at this signal point (cumulative for lifetime, snapshot for checkpoints). */
  views: number;
  /** Format-cohort percentile bar at this signal point. */
  bar: number;
  /** views / bar. >=1 means at-or-above the bar. */
  ratio: number;
  /** Which percentile the bar represents (0.6 here, but exposed for the UI). */
  percentile: number;
  cohortSize: number;
}

export interface CrossPostCandidate {
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
  /** Every signal we could compute for this candidate, sorted by ratio desc.
   *  Empty for brand-new formats with no cohort at all. */
  hotnessSignals: HotnessSignal[];
  /** The signal that gives the strongest ratio. The badge in the table
   *  shows this one ("8.7× at 1h"). Null when the candidate is in a
   *  cohort-less format and was auto-admitted. */
  topSignal: HotnessSignal | null;
  /** Max ratio across all signals, or +Infinity for the auto-admit case
   *  (so they sort to the very top). Drives both admission and sort order. */
  hotnessRatio: number;
  /** One-line "why is this hot" string suitable for tooltip / explainer.
   *  Always populated. */
  whyHot: string;
  existingCrossPosts: Array<{
    productionItemId: string;
    accountId: string;
    postType: string | null;
    status: string | null;
  }>;
}

export interface BrandAccount {
  id: string;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  syncedFromNotion: boolean;
}

export interface CrossPostCandidatesResult {
  items: CrossPostCandidate[];
  brandAccounts: BrandAccount[];
  targetCommonality: Record<
    string,
    Array<{ accountId: string; postType: string; count: number }>
  >;
  /** Counters useful for debugging / UI explainer. */
  stats: {
    rawCandidates: number;
    droppedDismissed: number;
    droppedBelowThreshold: number;
    droppedAllTargetsCovered: number;
    droppedNoCompatibleTarget: number;
    autoAdmittedNewFormat: number;
  };
  config: {
    candidateWindowDays: number;
    cohortWindowDays: number;
    percentile: number;
    hotnessThreshold: number;
  };
}

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

export async function selectCrossPostCandidates(opts: {
  brand: string;
}): Promise<CrossPostCandidatesResult> {
  const { brand } = opts;

  const stats = {
    rawCandidates: 0,
    droppedDismissed: 0,
    droppedBelowThreshold: 0,
    droppedAllTargetsCovered: 0,
    droppedNoCompatibleTarget: 0,
    autoAdmittedNewFormat: 0,
  };

  // Bars: lifetime + per-checkpoint. P60 with no cohort floor — brand-new
  // formats with 1–2 prior posts still get a bar (noisy, but the operator
  // can dismiss); 0-cohort formats auto-admit downstream.
  const [lifetimeBars, checkpointBars] = await Promise.all([
    fetchFormatViewBars({
      percentile: PERCENTILE,
      windowDays: COHORT_WINDOW_DAYS,
      minCohort: 0,
    }),
    fetchFormatCheckpointBars({
      percentile: PERCENTILE,
      windowDays: COHORT_WINDOW_DAYS,
      minCohort: 5,
    }),
  ]);

  const targetCommonality = await fetchTargetCommonalityByFormat();

  const brandAccountsRows = await db
    .select({
      id: accounts.id,
      platform: accounts.platform,
      handle: accounts.handle,
      displayName: accounts.displayName,
      avatarUrl: accounts.avatarUrl,
      syncedFromNotion: accounts.syncedFromNotion,
    })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(
      and(
        eq(brands.slug, brand),
        eq(accounts.isActive, true),
        isNull(accounts.deletedAt)
      )
    );
  const brandAccounts: BrandAccount[] = brandAccountsRows;

  // Candidate pool: original / clip / repost (anything but cross_post)
  // published in the last CANDIDATE_WINDOW_DAYS.
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
      accountPlatform: accounts.platform,
      accountHandle: accounts.handle,
      accountDisplayName: accounts.displayName,
      accountAvatarUrl: accounts.avatarUrl,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(productionItems.accountId, accounts.id))
    .where(
      and(
        eq(productionItems.brand, brand),
        inArray(productionItems.sourceType, [...ELIGIBLE_SOURCE_TYPES]),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        gte(
          productionItems.publishedAt,
          sql`(now() - interval '${sql.raw(String(CANDIDATE_WINDOW_DAYS))} days')`
        )
      )
    );

  stats.rawCandidates = rawCandidates.length;

  if (rawCandidates.length === 0) {
    return {
      items: [],
      brandAccounts,
      targetCommonality,
      stats,
      config: {
        candidateWindowDays: CANDIDATE_WINDOW_DAYS,
        cohortWindowDays: COHORT_WINDOW_DAYS,
        percentile: PERCENTILE,
        hotnessThreshold: HOTNESS_THRESHOLD,
      },
    };
  }

  const candidateIds = rawCandidates.map((c) => c.id);

  // Existing cross-posts derived from these candidates — drives the modal's
  // disabled-card state and the "all targets covered" drop.
  const existingCrossPosts = await db
    .select({
      sourceItemId: productionItems.repostedFromItemId,
      productionItemId: productionItems.id,
      accountId: productionItems.accountId,
      postType: productionItems.postType,
      status: productionItems.status,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "cross_post"),
        inArray(productionItems.repostedFromItemId, candidateIds),
        isNull(productionItems.deletedAt)
      )
    );

  const crossPostsBySource = new Map<
    string,
    CrossPostCandidate["existingCrossPosts"]
  >();
  for (const row of existingCrossPosts) {
    if (!row.sourceItemId || !row.accountId) continue;
    const list = crossPostsBySource.get(row.sourceItemId) ?? [];
    list.push({
      productionItemId: row.productionItemId,
      accountId: row.accountId,
      postType: row.postType,
      status: row.status,
    });
    crossPostsBySource.set(row.sourceItemId, list);
  }

  // Per-candidate velocity snapshots. One query, batched on ID list.
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

  const dismissalRows = await db
    .select({ contentItemId: contentEvents.contentItemId })
    .from(contentEvents)
    .where(
      and(
        eq(contentEvents.eventType, "cross_post_dismissed"),
        inArray(contentEvents.contentItemId, candidateIds),
        gte(
          contentEvents.createdAt,
          sql`(now() - interval '${sql.raw(String(DISMISSAL_TTL_DAYS))} days')`
        )
      )
    );
  const dismissedIds = new Set(dismissalRows.map((r) => r.contentItemId));

  const pillarIds = Array.from(
    new Set(
      rawCandidates
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

  const items: CrossPostCandidate[] = [];
  for (const c of rawCandidates) {
    if (!c.postType || !c.format || !c.accountId || c.views == null) continue;
    if (isNotionAuthoritative(c.postType)) continue;
    if (dismissedIds.has(c.id)) {
      stats.droppedDismissed++;
      continue;
    }

    const signals = computeHotnessSignals({
      candidate: { id: c.id, format: c.format, views: c.views },
      lifetimeBars,
      checkpointBars,
      snapshots: snapshotsByItem.get(c.id) ?? null,
    });

    let hotnessRatio: number;
    let topSignal: HotnessSignal | null;
    let whyHot: string;
    let autoAdmitted = false;

    if (signals.length === 0) {
      // Brand-new format with no cohort and no checkpoint data — admit so
      // the operator can decide. Sort to the top of the queue (Infinity).
      hotnessRatio = Number.POSITIVE_INFINITY;
      topSignal = null;
      whyHot = `New format "${c.format}" — no cohort yet, surfacing for human review.`;
      autoAdmitted = true;
    } else {
      topSignal = signals[0]; // sorted desc by computeHotnessSignals
      hotnessRatio = topSignal.ratio;
      if (hotnessRatio < HOTNESS_THRESHOLD) {
        stats.droppedBelowThreshold++;
        continue;
      }
      whyHot = buildWhyHot(c.format, topSignal, signals);
    }

    const existing = crossPostsBySource.get(c.id) ?? [];
    const eligiblePairs = countEligibleTargetPairs(
      { accountId: c.accountId, postType: c.postType },
      brandAccounts
    );
    if (eligiblePairs === 0) {
      stats.droppedNoCompatibleTarget++;
      continue;
    }
    const existingPairs = new Set(
      existing.map((x) => `${x.accountId}:${x.postType ?? ""}`)
    );
    if (existingPairs.size >= eligiblePairs) {
      stats.droppedAllTargetsCovered++;
      continue;
    }

    if (autoAdmitted) stats.autoAdmittedNewFormat++;

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
      existingCrossPosts: existing,
    });
  }

  items.sort((a, b) => b.hotnessRatio - a.hotnessRatio);

  // Suppress an unused-import lint by referencing the symbol; `or` and `ne`
  // are imported for future filter additions and intentional belt/braces.
  void or;
  void ne;

  return {
    items,
    brandAccounts,
    targetCommonality,
    stats,
    config: {
      candidateWindowDays: CANDIDATE_WINDOW_DAYS,
      cohortWindowDays: COHORT_WINDOW_DAYS,
      percentile: PERCENTILE,
      hotnessThreshold: HOTNESS_THRESHOLD,
    },
  };
}

interface ComputeHotnessOpts {
  candidate: { id: string; format: string; views: number };
  lifetimeBars: FormatBars;
  checkpointBars: FormatCheckpointBars;
  snapshots: Map<string, number> | null;
}

function computeHotnessSignals(opts: ComputeHotnessOpts): HotnessSignal[] {
  const { candidate, lifetimeBars, checkpointBars, snapshots } = opts;
  const out: HotnessSignal[] = [];

  // Lifetime signal — uses cumulative `views` against the format's
  // lifetime P60. Falls in for every candidate that has a cohort.
  const lifetimeBar = lifetimeBars[candidate.format];
  if (lifetimeBar && lifetimeBar.p > 0) {
    out.push({
      kind: "lifetime",
      label: "Lifetime",
      views: candidate.views,
      bar: lifetimeBar.p,
      ratio: candidate.views / lifetimeBar.p,
      percentile: lifetimeBar.percentile,
      cohortSize: lifetimeBar.cohortSize,
    });
  }

  // Velocity signals — only checkpoints where the candidate has a snapshot
  // AND the format has a baseline. Posts published before the snapshot
  // pipeline existed will simply have no velocity entries.
  const formatCheckpointBars = checkpointBars[candidate.format];
  if (snapshots && formatCheckpointBars) {
    for (const [key, viewsAtCheckpoint] of snapshots) {
      const bar = formatCheckpointBars[key];
      if (!bar || bar.p <= 0) continue;
      out.push({
        kind: key,
        label: CHECKPOINT_LABEL[key] ?? key,
        views: viewsAtCheckpoint,
        bar: bar.p,
        ratio: viewsAtCheckpoint / bar.p,
        percentile: bar.percentile,
        cohortSize: bar.cohortSize,
      });
    }
  }

  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

function buildWhyHot(
  format: string,
  top: HotnessSignal,
  all: HotnessSignal[]
): string {
  const pctLabel = `P${Math.round(top.percentile * 100)}`;
  const ratioLabel = top.ratio.toFixed(1);
  const head = `${ratioLabel}× ${format} ${pctLabel} at ${top.label.toLowerCase()} (${formatNum(top.views)} vs ${formatNum(top.bar)} bar, cohort ${top.cohortSize}).`;
  if (all.length <= 1) return head;
  const others = all
    .slice(1)
    .map(
      (s) =>
        `${s.ratio.toFixed(1)}× at ${s.label.toLowerCase()} (${formatNum(s.views)} vs ${formatNum(s.bar)})`
    )
    .join("; ");
  return `${head} Other signals: ${others}.`;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString();
}

function countEligibleTargetPairs(
  source: { accountId: string; postType: string },
  brandAccounts: BrandAccount[]
): number {
  let count = 0;
  for (const acct of brandAccounts) {
    if (acct.syncedFromNotion) continue;
    const supported = PLATFORM_META[toPlatform(acct.platform)].postTypes;
    for (const pt of supported) {
      if (acct.id === source.accountId && pt === source.postType) continue;
      count++;
    }
  }
  return count;
}

async function fetchTargetCommonalityByFormat(): Promise<
  Record<string, Array<{ accountId: string; postType: string; count: number }>>
> {
  const rows = await db.execute<{
    source_format: string;
    target_account_id: string;
    target_post_type: string;
    n: string;
  }>(sql`
    SELECT
      src.format AS source_format,
      cp.account_id AS target_account_id,
      cp.post_type AS target_post_type,
      count(*) AS n
    FROM production_items cp
    JOIN production_items src ON src.id = cp.reposted_from_item_id
    WHERE cp.source_type = 'cross_post'
      AND src.format IS NOT NULL
      AND cp.account_id IS NOT NULL
      AND cp.post_type IS NOT NULL
      AND cp.deleted_at IS NULL
      AND cp.status <> 'Killed'
    GROUP BY src.format, cp.account_id, cp.post_type
  `);

  const map: Record<
    string,
    Array<{ accountId: string; postType: string; count: number }>
  > = {};
  for (const r of rows) {
    if (!map[r.source_format]) map[r.source_format] = [];
    map[r.source_format].push({
      accountId: r.target_account_id,
      postType: r.target_post_type,
      count: Number(r.n),
    });
  }
  for (const fmt of Object.keys(map)) {
    map[fmt].sort((a, b) => b.count - a.count);
  }
  return map;
}
