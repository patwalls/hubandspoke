import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  brands,
  contentEvents,
  productionItems,
} from "@/lib/db/schema";
import { isNotionAuthoritative } from "@/lib/platform";
import { PLATFORM_META, toPlatform } from "@/lib/platforms";
import { fetchFormatViewBars } from "@/lib/services/format-view-bars";

// Cross-post queue v3 — candidate finder.
//
// Replaces the v2 LLM-driven scanner (`runCrossPostScan`). The split is:
//   v3 algorithm: identify hot source content (this file).
//   v3 human:     pick where to cross-post to (the modal in the UI).
//
// "Hot" = top P75 of `views` within the source's `format` over the last 90
// days. Self-calibrating — as the data grows, the bar moves with it; no
// hardcoded velocity multipliers or confidence floors to drift.
//
// Pure read; no inserts, no LLM calls. Re-run on every page load of the
// Cross-post tab — the source of truth for views is `production_items.views`,
// already kept fresh by the `performance-decay` cron.

const CANDIDATE_WINDOW_DAYS = 7;
const DISMISSAL_TTL_DAYS = 30;

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
  formatP75: number;
  formatCohortSize: number;
  formatRatio: number;
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
  formatBars: Record<string, { p75: number; cohortSize: number }>;
  brandAccounts: BrandAccount[];
  /** For each source format, target (account, postType) pairs ranked by how
   *  often that pair has been used as a cross-post target for posts in that
   *  format historically. The modal sorts target cards by this. Empty for
   *  formats with no cross-post history yet. */
  targetCommonality: Record<
    string,
    Array<{ accountId: string; postType: string; count: number }>
  >;
  /** Counters useful for the populate toast / debugging. */
  stats: {
    rawCandidates: number;
    droppedNoFormatBar: number;
    droppedBelowP75: number;
    droppedDismissed: number;
    droppedAllTargetsCovered: number;
    droppedNoCompatibleTarget: number;
  };
}

export async function selectCrossPostCandidates(opts: {
  brand: string;
}): Promise<CrossPostCandidatesResult> {
  const { brand } = opts;

  const stats = {
    rawCandidates: 0,
    droppedNoFormatBar: 0,
    droppedBelowP75: 0,
    droppedDismissed: 0,
    droppedAllTargetsCovered: 0,
    droppedNoCompatibleTarget: 0,
  };

  // Per-format P75 view threshold over the last 90 days. Shared helper is
  // also called by the content view to render the same bars as a column.
  const formatBars = await fetchFormatViewBars();

  // Per-source-format target popularity. Drives the modal's card order so
  // the targets you usually pick for, say, "Laptop POV" content surface at
  // the top. Cheap query — single GROUP BY across the whole cross-post
  // history.
  const targetCommonality = await fetchTargetCommonalityByFormat();

  // Brand accounts — the universe of possible cross-post targets. Used for
  // both the "any-eligible-target" filter and surfacing target cards in the
  // modal.
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

  // Candidate pool: published originals from the last 7 days with joined
  // account context.
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
        eq(productionItems.sourceType, "original"),
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
      formatBars,
      brandAccounts,
      targetCommonality,
      stats,
    };
  }

  const candidateIds = rawCandidates.map((c) => c.id);

  // Existing cross-post production items derived from any of these
  // candidates. Used to (a) drop candidates fully covered, (b) show
  // disabled "already cross-posted to @x" cards in the modal.
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

  // Recently-dismissed candidates. Operator clicks "Not interested" → write
  // a content_events row of type 'cross_post_dismissed'. We hide the
  // candidate for DISMISSAL_TTL_DAYS; after that it can resurface if it's
  // still hot.
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

  // Pillar titles for display.
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

    const bar = formatBars[c.format];
    if (!bar) {
      stats.droppedNoFormatBar++;
      continue;
    }
    if (c.views < bar.p75) {
      stats.droppedBelowP75++;
      continue;
    }

    const existing = crossPostsBySource.get(c.id) ?? [];

    // Drop candidates where every eligible target pair already has a
    // cross-post production item — there's nothing left for the operator
    // to do. v3.1 widens "eligible" to every (account, postType) on the
    // brand other than the source's own and Notion-authoritative ones —
    // the operator picks compat manually in the modal.
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
      formatP75: bar.p75,
      formatCohortSize: bar.cohortSize,
      formatRatio: c.views / Math.max(bar.p75, 1),
      existingCrossPosts: existing,
    });
  }

  items.sort((a, b) => b.formatRatio - a.formatRatio);

  return { items, formatBars, brandAccounts, targetCommonality, stats };
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
      // Only the exact source pair is excluded; same-account different-
      // postType is a valid target (e.g. an Instagram Reel re-cut into an
      // Instagram Post on the same handle).
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
