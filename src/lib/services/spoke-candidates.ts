import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  formats as formatsTable,
  productionItems,
} from "@/lib/db/schema";

// SPOKE algorithm — live (pillar × format) candidate finder for the
// "Repurposed" queue tab. Successor to the dumb threshold-monitor-sweep
// rule (views > formats.viewThreshold → auto-insert one repurposed row),
// which had no concept of pair history, format fit, or freshness.
//
// Pillar = a Published YouTube long-form video (post_type='youtube_long')
// whose assigned format exists in the brand's formats table.
// Target formats = the **children** of the pillar's format in the
// `formats.parentFormatId` hierarchy (v1.2). A "Business Breakdown"
// pillar can only target its declared derivative formats, not the
// brand's entire format menu. Pillars whose format has no children are
// skipped (the operator never declared what to repurpose them into).
//
// Score (per pair):
//
//   spoke = pillarStrength × formatFit × freshnessFactor × pairHistory
//
//   pillarStrength : pillar.views ÷ this channel's lifetime P60 of
//                    YouTube long-form views (last 365d). Captures "is
//                    THIS video really crushing it for this channel."
//
//   formatFit      : (format brand P60 ÷ brand-all-formats P60) ×
//                    pair-source lift. Captures both "this format is hot
//                    right now" AND "this format historically performs
//                    well when sourced from this pillar's channel."
//
//   freshnessFactor: max(0.3, exp(-ageDays/90)). 90-day half-life floored
//                    at 0.3 so evergreen pillars still surface.
//
//   pairHistory    : in-flight pair → SKIP. Recently-published pair (<14d)
//                    → SKIP (cooldown). Older Published pair with views >
//                    format P50 → BOOST up to 2.5×. Older Published pair
//                    that flopped → dampen to 0.5×. Killed in last 60d →
//                    0.4×. No history → 1.0×.
//
// Admit when spoke ≥ 1.0. Live query, no precomputed scores. Promotion
// (operator clicks "Repurpose it") reuses the existing
// /api/production-items/[pillarId]/repurpose endpoint.

const PILLAR_WINDOW_DAYS = 730;
const CHANNEL_COHORT_WINDOW_DAYS = 365;
const FORMAT_COHORT_WINDOW_DAYS = 90;
const PAIR_SOURCE_COHORT_WINDOW_DAYS = 180;
const PAIR_PUB_COOLDOWN_DAYS = 14;
const PAIR_KILL_PENALTY_WINDOW_DAYS = 60;
const PERCENTILE = 0.6;
const PAIR_SOURCE_PERCENTILE = 0.5;
const MIN_FORMAT_HISTORY = 3;
const MIN_PAIR_SOURCE_COHORT = 3;
// Half-life + floor tuned 2026-05-19 (v1.1) after Pat reviewed live output:
// 90d / 0.3 let 1+ year old pillars rank near the top. 45d / 0.15 makes
// old crushing hits clear a higher bar before surfacing.
const FRESHNESS_HALF_LIFE_DAYS = 45;
const FRESHNESS_FLOOR = 0.15;
const SPOKE_THRESHOLD = 1.0;
const MAX_CANDIDATES = 200;
const PILLAR_POST_TYPE = "youtube_long";

const PENDING_STATUSES = [
  "Idea",
  "Assigned",
  "Drafting",
  "Ready To Publish",
] as const;

export interface SpokeSignalBreakdown {
  pillarStrength: number;
  formatFit: number;
  freshnessFactor: number;
  pairHistoryMultiplier: number;
  pillarChannelP60: number;
  pillarChannelCohortSize: number;
  formatBrandP60: number;
  formatBrandCohortSize: number;
  brandAllFormatsP60: number;
  pairSourceP50: number;
  pairSourceCohortSize: number;
  ageDays: number;
}

export interface SpokePriorAttempt {
  productionItemId: string;
  status: string | null;
  publishedAt: string | null;
  views: number | null;
  killedAt: string | null;
}

export interface SpokeCandidate {
  /** Stable id for React keys. Pair-shaped so duplicates are impossible. */
  id: string;
  brand: string;
  pillar: {
    id: string;
    title: string | null;
    thumbnail: string | null;
    publishedAt: string | null;
    publishedDate: string | null;
    publishedLink: string | null;
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
  };
  format: {
    id: string;
    name: string;
    targetPostType: string | null;
  };
  spokeScore: number;
  breakdown: SpokeSignalBreakdown;
  priorAttempts: SpokePriorAttempt[];
  whySpoke: string;
}

export interface SpokeCandidatesResult {
  items: SpokeCandidate[];
  stats: {
    rawPillars: number;
    rawFormats: number;
    rawPairs: number;
    droppedNoChannelCohort: number;
    droppedNoChildFormats: number;
    droppedInFlight: number;
    droppedCooldown: number;
    droppedBelowThreshold: number;
  };
  config: {
    pillarWindowDays: number;
    channelCohortWindowDays: number;
    formatCohortWindowDays: number;
    pairSourceCohortWindowDays: number;
    pairPubCooldownDays: number;
    percentile: number;
    minFormatHistory: number;
    spokeThreshold: number;
    freshnessHalfLifeDays: number;
    freshnessFloor: number;
  };
}

export async function selectSpokeCandidates(opts: {
  brand: string;
}): Promise<SpokeCandidatesResult> {
  const { brand } = opts;

  const stats = {
    rawPillars: 0,
    rawFormats: 0,
    rawPairs: 0,
    droppedNoChannelCohort: 0,
    droppedNoChildFormats: 0,
    droppedInFlight: 0,
    droppedCooldown: 0,
    droppedBelowThreshold: 0,
  };

  // 1. Eligible pillars: brand-scoped, YT long-form, Published, fresh-ish.
  const pillarRows = await db
    .select({
      id: productionItems.id,
      brand: productionItems.brand,
      title: productionItems.title,
      thumbnail: productionItems.thumbnail,
      publishedAt: productionItems.publishedAt,
      publishedDate: productionItems.publishedDate,
      publishedLink: productionItems.publishedLink,
      views: productionItems.views,
      likes: productionItems.likes,
      comments: productionItems.comments,
      format: productionItems.format,
      lastPerformanceSyncAt: productionItems.lastPerformanceSyncAt,
      accountId: productionItems.accountId,
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
        eq(productionItems.postType, PILLAR_POST_TYPE),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${productionItems.views} IS NOT NULL AND ${productionItems.views} > 0`,
        sql`${productionItems.publishedAt} IS NOT NULL`,
        // v1.1 gate: pillar must have a format assigned AND that format must
        // exist as a row in the brand's formats table. Free-form legacy
        // format strings (anything not in the formats table) get filtered.
        sql`${productionItems.format} IS NOT NULL`,
        sql`EXISTS (
          SELECT 1 FROM formats f
          WHERE f.brand = ${brand}
            AND lower(trim(f.name)) = lower(trim(${productionItems.format}))
        )`,
        gte(
          productionItems.publishedAt,
          sql`(now() - interval '${sql.raw(String(PILLAR_WINDOW_DAYS))} days')`,
        ),
      ),
    );

  stats.rawPillars = pillarRows.length;
  if (pillarRows.length === 0) {
    return { items: [], stats, config: configBlock() };
  }

  // 2. Brand format catalog + parent→children map. v1.2 narrows candidate
  //    formats per-pillar to the children of the pillar's own format
  //    (formats.parentFormatId), not the brand-wide format menu. Pillars
  //    whose format has no children get skipped.
  const allFormats = await db
    .select({
      id: formatsTable.id,
      name: formatsTable.name,
      parentFormatId: formatsTable.parentFormatId,
    })
    .from(formatsTable)
    .where(eq(formatsTable.brand, brand));

  const formatByLowerName = new Map<
    string,
    { id: string; name: string; parentFormatId: string | null }
  >();
  for (const f of allFormats) {
    formatByLowerName.set(f.name.toLowerCase().trim(), f);
  }
  const childrenByParentId = new Map<
    string,
    Array<{ id: string; name: string }>
  >();
  for (const f of allFormats) {
    if (!f.parentFormatId) continue;
    const arr = childrenByParentId.get(f.parentFormatId) ?? [];
    arr.push({ id: f.id, name: f.name });
    childrenByParentId.set(f.parentFormatId, arr);
  }
  stats.rawFormats = allFormats.length;
  if (allFormats.length === 0) {
    return { items: [], stats, config: configBlock() };
  }

  // 3. Format's representative target post type (for accountId resolution
  //    on promotion). Use the format's most-used post_type historically.
  const formatPostTypeRows = await db.execute<{
    format_id: string;
    post_type: string | null;
  }>(sql`
    SELECT DISTINCT ON (fc.format_id) fc.format_id::text AS format_id, fc.post_type
    FROM format_channels fc
    WHERE fc.format_id = ANY(${sql.raw(
      `ARRAY[${allFormats.map((f) => `'${f.id}'`).join(",")}]::uuid[]`,
    )})
    ORDER BY fc.format_id, fc.created_at ASC
  `);
  const targetPostTypeByFormatId = new Map<string, string | null>();
  for (const r of formatPostTypeRows) {
    targetPostTypeByFormatId.set(r.format_id, r.post_type);
  }

  // 4. Cohort bars — fetched once, indexed in memory.

  // 4a. Channel lifetime P60 for YT long-form (per pillar account).
  const pillarAccountIds = Array.from(
    new Set(pillarRows.map((p) => p.accountId).filter((x): x is string => !!x)),
  );
  const channelBarsRows = pillarAccountIds.length === 0
    ? []
    : await db.execute<{
        account_id: string;
        p: string;
        cohort_size: string;
      }>(sql`
        SELECT
          account_id::text AS account_id,
          percentile_cont(${PERCENTILE}) WITHIN GROUP (ORDER BY views) AS p,
          count(*)::text AS cohort_size
        FROM production_items
        WHERE account_id = ANY(${sql.raw(
          `ARRAY[${pillarAccountIds.map((id) => `'${id}'`).join(",")}]::uuid[]`,
        )})
          AND post_type = ${PILLAR_POST_TYPE}
          AND status = 'Published'
          AND deleted_at IS NULL
          AND views IS NOT NULL
          AND published_at >= (now() - interval '${sql.raw(
            String(CHANNEL_COHORT_WINDOW_DAYS),
          )} days')
        GROUP BY account_id
      `);
  const channelP60ByAccount = new Map<
    string,
    { p: number; cohortSize: number }
  >();
  for (const r of channelBarsRows) {
    channelP60ByAccount.set(r.account_id, {
      p: Number(r.p),
      cohortSize: Number(r.cohort_size),
    });
  }

  // 4b. Brand format P60 (per format, summed across post_types). One row
  //     per format using the largest-cohort post_type so we don't pool
  //     wildly different distributions.
  const formatBarsRows = await db.execute<{
    format: string;
    post_type: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      lower(trim(format)) AS format,
      post_type,
      percentile_cont(${PERCENTILE}) WITHIN GROUP (ORDER BY views) AS p,
      count(*)::text AS cohort_size
    FROM production_items
    WHERE brand = ${brand}
      AND format IS NOT NULL
      AND post_type IS NOT NULL
      AND status = 'Published'
      AND deleted_at IS NULL
      AND views IS NOT NULL
      AND published_at >= (now() - interval '${sql.raw(
        String(FORMAT_COHORT_WINDOW_DAYS),
      )} days')
    GROUP BY lower(trim(format)), post_type
  `);
  // Pick the largest-cohort post_type per format as the representative bar.
  // No MIN_FORMAT_HISTORY filter at fetch time anymore (v1.2) — child
  // formats with thin cohorts get a neutral formatFit=1.0 in scoring so
  // newly-declared derivatives don't fall out of the candidate list.
  const formatBarByName = new Map<
    string,
    { p: number; cohortSize: number; postType: string }
  >();
  for (const r of formatBarsRows) {
    const prev = formatBarByName.get(r.format);
    const cohort = Number(r.cohort_size);
    if (!prev || cohort > prev.cohortSize) {
      formatBarByName.set(r.format, {
        p: Number(r.p),
        cohortSize: cohort,
        postType: r.post_type,
      });
    }
  }

  // 4c. Brand-all-formats P60 (denominator for formatFit).
  const [brandBarRow] = (await db.execute<{ p: string; cohort_size: string }>(sql`
    SELECT
      percentile_cont(${PERCENTILE}) WITHIN GROUP (ORDER BY views) AS p,
      count(*)::text AS cohort_size
    FROM production_items
    WHERE brand = ${brand}
      AND status = 'Published'
      AND deleted_at IS NULL
      AND views IS NOT NULL
      AND published_at >= (now() - interval '${sql.raw(
        String(FORMAT_COHORT_WINDOW_DAYS),
      )} days')
  `)) as Array<{ p: string; cohort_size: string }>;
  const brandAllFormatsP60 = brandBarRow ? Number(brandBarRow.p) : 0;

  // 4d. Pair-source P50: per (format, pillar_account_id), historical median
  //     views of repurposes that came from THAT account. Captures "this
  //     format has worked well on this channel before."
  const pairSourceRows = await db.execute<{
    format: string;
    pillar_account_id: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      lower(trim(derivative.format)) AS format,
      pillar.account_id::text AS pillar_account_id,
      percentile_cont(${PAIR_SOURCE_PERCENTILE}) WITHIN GROUP (ORDER BY derivative.views) AS p,
      count(*)::text AS cohort_size
    FROM production_items derivative
    JOIN production_items pillar ON pillar.id = derivative.pillar_content_item_id
    WHERE derivative.brand = ${brand}
      AND derivative.status = 'Published'
      AND derivative.deleted_at IS NULL
      AND derivative.views IS NOT NULL
      AND derivative.format IS NOT NULL
      AND derivative.published_at >= (now() - interval '${sql.raw(
        String(PAIR_SOURCE_COHORT_WINDOW_DAYS),
      )} days')
      AND pillar.account_id IS NOT NULL
      AND pillar.post_type = ${PILLAR_POST_TYPE}
    GROUP BY lower(trim(derivative.format)), pillar.account_id
    HAVING count(*) >= ${MIN_PAIR_SOURCE_COHORT}
  `);
  const pairSourceByKey = new Map<
    string,
    { p: number; cohortSize: number }
  >();
  for (const r of pairSourceRows) {
    pairSourceByKey.set(`${r.format}|${r.pillar_account_id}`, {
      p: Number(r.p),
      cohortSize: Number(r.cohort_size),
    });
  }

  // 5. Prior-attempt history for every (pillar, format) pair we'll score.
  //    One batched query, then indexed by pillarId|formatNameLower.
  //    Format scope: any brand format (a pair's history is tied to the
  //    target format name, which is some child in the hierarchy).
  const pillarIds = pillarRows.map((p) => p.id);
  const allFormatNamesLower = allFormats.map((f) =>
    f.name.toLowerCase().trim(),
  );
  // killed_at: no dedicated column today. Approximate with updated_at when
  // status='Killed' — the row's updated_at flips when status transitions,
  // and the 60-day kill window is forgiving enough that an occasional
  // post-kill edit nudging this forward is acceptable. content_events of
  // type='killed' would be exact, but worth the join only if this becomes
  // a sharper gate later.
  const priorRows = await db.execute<{
    production_item_id: string;
    pillar_id: string;
    format: string;
    status: string | null;
    published_at: Date | string | null;
    views: number | null;
    killed_at: Date | string | null;
  }>(sql`
    SELECT
      id::text AS production_item_id,
      pillar_content_item_id::text AS pillar_id,
      lower(trim(format)) AS format,
      status,
      published_at,
      views,
      CASE WHEN status = 'Killed' THEN updated_at ELSE NULL END AS killed_at
    FROM production_items
    WHERE pillar_content_item_id = ANY(${sql.raw(
      `ARRAY[${pillarIds.map((id) => `'${id}'`).join(",")}]::uuid[]`,
    )})
      AND lower(trim(format)) = ANY(${sql.raw(
        `ARRAY[${allFormatNamesLower.map((n) => `'${n.replace(/'/g, "''")}'`).join(",")}]::text[]`,
      )})
      AND deleted_at IS NULL
  `);
  const priorByPair = new Map<string, SpokePriorAttempt[]>();
  for (const r of priorRows) {
    const key = `${r.pillar_id}|${r.format}`;
    const list = priorByPair.get(key) ?? [];
    list.push({
      productionItemId: r.production_item_id,
      status: r.status,
      publishedAt:
        r.published_at instanceof Date
          ? r.published_at.toISOString()
          : typeof r.published_at === "string"
            ? r.published_at
            : null,
      views: r.views,
      killedAt:
        r.killed_at instanceof Date
          ? r.killed_at.toISOString()
          : typeof r.killed_at === "string"
            ? r.killed_at
            : null,
    });
    priorByPair.set(key, list);
  }

  // 6. Per-pillar scoring. For each pillar, resolve its assigned format,
  //    look up that format's children via `parentFormatId`, and score
  //    only (pillar × child) pairs.
  const items: SpokeCandidate[] = [];
  const now = Date.now();

  for (const pillar of pillarRows) {
    if (!pillar.accountId || pillar.views == null || !pillar.publishedAt) continue;

    // Resolve pillar's format row → its children.
    if (!pillar.format) continue;
    const pillarFormatRow = formatByLowerName.get(
      pillar.format.toLowerCase().trim(),
    );
    if (!pillarFormatRow) continue; // shouldn't happen given v1.1 SQL gate
    const candidateFormats = childrenByParentId.get(pillarFormatRow.id) ?? [];
    if (candidateFormats.length === 0) {
      // Pillar's format has no declared children → operator never said
      // what to repurpose it into. Skip the entire pillar.
      stats.droppedNoChildFormats++;
      continue;
    }

    const channelBar = channelP60ByAccount.get(pillar.accountId);
    if (!channelBar || channelBar.p <= 0) {
      stats.droppedNoChannelCohort += candidateFormats.length;
      continue;
    }
    const pillarStrength = pillar.views / channelBar.p;
    const ageDays = (now - pillar.publishedAt.getTime()) / 86_400_000;
    const freshnessFactor = Math.max(
      FRESHNESS_FLOOR,
      Math.exp(-ageDays / FRESHNESS_HALF_LIFE_DAYS),
    );

    for (const fmt of candidateFormats) {
      stats.rawPairs++;
      const fmtKey = fmt.name.toLowerCase().trim();
      const formatBar = formatBarByName.get(fmtKey);
      // v1.2: missing format cohort → formatFit collapses to neutral 1.0.
      // Operator explicitly mapped this child format in the hierarchy;
      // we surface it for human review even without prior performance
      // data, rather than dropping the pair entirely.
      const haveFormatBar =
        !!formatBar && formatBar.p > 0 && brandAllFormatsP60 > 0;
      const formatLiftRatio = haveFormatBar
        ? formatBar!.p / brandAllFormatsP60
        : 1.0;
      const pairSource = pairSourceByKey.get(`${fmtKey}|${pillar.accountId}`);
      const pairSourceLift =
        pairSource && haveFormatBar
          ? Math.max(0.5, Math.min(2.5, pairSource.p / formatBar!.p))
          : 1.0;
      const formatFit = formatLiftRatio * pairSourceLift;

      const priors = priorByPair.get(`${pillar.id}|${fmtKey}`) ?? [];
      const inFlight = priors.some(
        (p) =>
          p.status &&
          (PENDING_STATUSES as readonly string[]).includes(p.status),
      );
      if (inFlight) {
        stats.droppedInFlight++;
        continue;
      }
      const cooldownCutoffMs = now - PAIR_PUB_COOLDOWN_DAYS * 86_400_000;
      const tooRecentlyPublished = priors.some(
        (p) =>
          p.status === "Published" &&
          p.publishedAt != null &&
          Date.parse(p.publishedAt) > cooldownCutoffMs,
      );
      if (tooRecentlyPublished) {
        stats.droppedCooldown++;
        continue;
      }

      // pairHistoryMultiplier needs SOMETHING to compare prior pair views
      // against. When the format has no brand cohort, fall back to the
      // brand-all-formats bar (less precise but better than 0, which would
      // collapse the multiplier to 1.0 via the divide-by-zero guard).
      const pairHistoryBar = haveFormatBar
        ? formatBar!.p
        : brandAllFormatsP60;
      const pairHistoryMultiplier = computePairHistoryMultiplier(
        priors,
        pairHistoryBar,
        now,
      );

      const spokeScore =
        pillarStrength * formatFit * freshnessFactor * pairHistoryMultiplier;
      if (spokeScore < SPOKE_THRESHOLD) {
        stats.droppedBelowThreshold++;
        continue;
      }

      const breakdown: SpokeSignalBreakdown = {
        pillarStrength,
        formatFit,
        freshnessFactor,
        pairHistoryMultiplier,
        pillarChannelP60: channelBar.p,
        pillarChannelCohortSize: channelBar.cohortSize,
        formatBrandP60: haveFormatBar ? formatBar!.p : 0,
        formatBrandCohortSize: haveFormatBar ? formatBar!.cohortSize : 0,
        brandAllFormatsP60,
        pairSourceP50: pairSource?.p ?? 0,
        pairSourceCohortSize: pairSource?.cohortSize ?? 0,
        ageDays,
      };

      items.push({
        id: `${pillar.id}:${fmt.id}`,
        brand: pillar.brand,
        pillar: {
          id: pillar.id,
          title: pillar.title,
          thumbnail: pillar.thumbnail,
          publishedAt: pillar.publishedAt.toISOString(),
          publishedDate: pillar.publishedDate,
          publishedLink: pillar.publishedLink,
          views: pillar.views,
          likes: pillar.likes,
          comments: pillar.comments,
          account: {
            id: pillar.accountId,
            platform: pillar.accountPlatform ?? "",
            handle: pillar.accountHandle ?? "",
            displayName: pillar.accountDisplayName,
            avatarUrl: pillar.accountAvatarUrl,
          },
        },
        format: {
          id: fmt.id,
          name: fmt.name,
          targetPostType: targetPostTypeByFormatId.get(fmt.id) ?? null,
        },
        spokeScore,
        breakdown,
        priorAttempts: priors,
        whySpoke: buildWhySpoke({
          pillarStrength,
          formatFit,
          freshnessFactor,
          pairHistoryMultiplier,
          formatLiftRatio,
          pairSourceLift,
          ageDays,
          priors,
        }),
      });
    }
  }

  items.sort((a, b) => b.spokeScore - a.spokeScore);
  const trimmed = items.slice(0, MAX_CANDIDATES);

  return { items: trimmed, stats, config: configBlock() };
}

export function computePairHistoryMultiplier(
  priors: SpokePriorAttempt[],
  formatP60: number,
  nowMs: number,
): number {
  const killCutoffMs = nowMs - PAIR_KILL_PENALTY_WINDOW_DAYS * 86_400_000;
  const recentlyKilled = priors.some((p) => {
    if (p.status !== "Killed") return false;
    if (!p.killedAt) return false;
    return Date.parse(p.killedAt) > killCutoffMs;
  });
  if (recentlyKilled) return 0.4;

  // Most-recent eligible Published attempt drives the boost/dampen.
  // (In-flight + cooldown skips already happened in the caller.)
  const published = priors
    .filter((p) => p.status === "Published" && p.views != null && p.publishedAt)
    .sort(
      (a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!),
    );
  if (published.length === 0) return 1.0;

  const latest = published[0];
  if (formatP60 <= 0 || latest.views == null) return 1.0;
  const ratio = latest.views / formatP60;
  return Math.max(0.5, Math.min(2.5, ratio));
}

export function buildWhySpoke(opts: {
  pillarStrength: number;
  formatFit: number;
  freshnessFactor: number;
  pairHistoryMultiplier: number;
  formatLiftRatio: number;
  pairSourceLift: number;
  ageDays: number;
  priors: SpokePriorAttempt[];
}): string {
  const {
    pillarStrength,
    formatFit,
    freshnessFactor,
    pairHistoryMultiplier,
    formatLiftRatio,
    pairSourceLift,
    ageDays,
    priors,
  } = opts;
  const published = priors.filter((p) => p.status === "Published");
  if (pairHistoryMultiplier > 1.3 && published.length > 0) {
    return `Already shipped ${published.length}× — last one at ${pairHistoryMultiplier.toFixed(1)}× the format baseline. Do more of these.`;
  }
  if (pillarStrength >= 2) {
    return `Pillar is ${pillarStrength.toFixed(1)}× this channel's median; format averages ${formatLiftRatio.toFixed(1)}× brand baseline.`;
  }
  if (formatFit >= 1.5) {
    const pairSuffix =
      pairSourceLift > 1.1
        ? ` (and ${pairSourceLift.toFixed(1)}× when sourced from this channel)`
        : "";
    return `Format is hot — ${formatLiftRatio.toFixed(1)}× brand baseline${pairSuffix} on a ${ageRoundLabel(ageDays)} pillar.`;
  }
  if (freshnessFactor < 0.5) {
    return `Older pillar at ${ageRoundLabel(ageDays)} but still clearing the bar — pillar ${pillarStrength.toFixed(1)}×, format ${formatFit.toFixed(1)}×.`;
  }
  return `Solid all-around — pillar ${pillarStrength.toFixed(1)}×, format ${formatFit.toFixed(1)}×, ${ageRoundLabel(ageDays)}.`;
}

function ageRoundLabel(days: number): string {
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

function configBlock() {
  return {
    pillarWindowDays: PILLAR_WINDOW_DAYS,
    channelCohortWindowDays: CHANNEL_COHORT_WINDOW_DAYS,
    formatCohortWindowDays: FORMAT_COHORT_WINDOW_DAYS,
    pairSourceCohortWindowDays: PAIR_SOURCE_COHORT_WINDOW_DAYS,
    pairPubCooldownDays: PAIR_PUB_COOLDOWN_DAYS,
    percentile: PERCENTILE,
    minFormatHistory: MIN_FORMAT_HISTORY,
    spokeThreshold: SPOKE_THRESHOLD,
    freshnessHalfLifeDays: FRESHNESS_HALF_LIFE_DAYS,
    freshnessFloor: FRESHNESS_FLOOR,
  };
}

