import { db } from "@/lib/db";
import { productionItems, formats, brands, users, accounts, clipIdeas, transcripts } from "@/lib/db/schema";
import { aliasedTable } from "drizzle-orm";
import { and, eq, gte, lte, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import { getPresignedGetUrl } from "@/lib/s3";
import {
  getInFlightStatusNames,
  getAllInFlightStatusNames,
} from "@/lib/db/brand-statuses";

// Legacy hard-coded fallback used only when a brand has no rows in
// brand_statuses (e.g. a fresh brand whose seed insert race-lost). The
// per-brand list takes precedence — see `resolveInFlightStatuses` below.
const FALLBACK_PIPELINE_STATUSES = [
  "Ready To Publish",
  "Final Review",
  "Review",
  "Assigned",
  "Idea",
] as const;

async function resolveInFlightStatuses(brand: string): Promise<string[]> {
  if (brand === "all") {
    const names = await getAllInFlightStatusNames();
    if (names.length > 0) return withIdea(names);
    return [...FALLBACK_PIPELINE_STATUSES];
  }
  const names = await getInFlightStatusNames(brand);
  if (names.length > 0) return withIdea(names);
  return [...FALLBACK_PIPELINE_STATUSES];
}

// "Idea" is the triage queue stage — not a pipeline column in brand_statuses,
// but the same /api/reports/production endpoint feeds both the queue and
// production views. Downstream filters separate them. Without this, the SQL
// filter drops Idea rows and the queue renders empty.
function withIdea(names: string[]): string[] {
  return names.includes("Idea") ? names : [...names, "Idea"];
}

type ProductionItemRow = typeof productionItems.$inferSelect;

type UserExtras = {
  producerUserName?: string | null;
  producerAvatarUrl?: string | null;
  editorUserName?: string | null;
  editorAvatarUrl?: string | null;
  /** Joined-account summary for UI badges. When absent the consumer falls
   *  back to the legacy platform[] string; populated by queries that
   *  already join accounts (detail + list endpoints post-accounts-PR). */
  account?: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    brandSlug: string;
    brandLabel: string;
  } | null;
  /** LLM per-clip view estimate (`clip_ideas.estimated_views`). When set,
   *  consumers prefer it over the generic format-based predictor for clip
   *  rows. Populated only by queries that JOIN clip_ideas. */
  clipEstimatedViews?: number | null;
  /** Title of the pillar production_item, resolved via self-join on
   *  pillarContentItemId. Surfaced in the clip queue's Pillar column. */
  pillarContentTitle?: string | null;
};

function mapProductionItem(
  item: ProductionItemRow,
  extras: UserExtras = {}
): ProductionItem {
  return {
    id: item.id,
    notionId: item.notionId,
    youtubeId: item.youtubeId,
    youtubeUrl: item.youtubeUrl,
    thumbnail: item.thumbnail,
    title: item.title,
    publishedDate: item.publishedDate,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    status: item.status,
    platform: item.platform as string[] | null,
    postType: item.postType ?? null,
    accountId: item.accountId ?? null,
    account: extras.account ?? null,
    format: item.format,
    brand: item.brand,
    campaign: item.campaign,
    utmCampaign: item.utmCampaign,
    publishedLink: item.publishedLink,
    isExternal: item.isExternal,
    views: item.views,
    likes: item.likes,
    comments: item.comments,
    clicks: item.clicks,
    leads: item.leads,
    salesNum: item.salesNum,
    salesAmount: item.salesAmount ? parseFloat(item.salesAmount) : null,
    ctrFirstHour: item.ctrFirstHour ? parseFloat(item.ctrFirstHour) : null,
    apvFirst24Hours: item.apvFirst24Hours
      ? parseFloat(item.apvFirst24Hours)
      : null,
    producerEmail: item.producerEmail,
    producerName: extras.producerUserName ?? item.producerName,
    producerAvatarUrl: extras.producerAvatarUrl ?? null,
    producerUserId: item.producerUserId,
    editorEmail: item.editorEmail,
    editorName: extras.editorUserName ?? item.editorName,
    editorAvatarUrl: extras.editorAvatarUrl ?? null,
    editorUserId: item.editorUserId,
    viewsEstimated: item.viewsEstimated ?? false,
    lastPerformanceSyncAt: item.lastPerformanceSyncAt?.toISOString() ?? null,
    sourceType: (item.sourceType ?? "original") as
      | "original"
      | "repost"
      | "cross_post"
      | "clip",
    sourceClipIdeaId: item.sourceClipIdeaId,
    clipEstimatedViews: extras.clipEstimatedViews ?? null,
    repostedFromItemId: item.repostedFromItemId,
    pillarContentItemId: item.pillarContentItemId,
    pillarContentTitle: extras.pillarContentTitle ?? null,
    posterS3Key: item.posterS3Key,
    mediaS3Key: item.mediaS3Key,
    mediaContentType: item.mediaContentType,
    predictedViewsSnapshot: item.predictedViewsSnapshot,
    predictedViewsSnapshotAt:
      item.predictedViewsSnapshotAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

// Presign every unique S3 key in `items` in parallel and attach posterUrl /
// mediaUrl to each. Failures fall through (url stays null); the UI has its own
// fallback to `thumbnail`. 1h TTL matches the detail endpoint.
async function attachPresignedCoverUrls(items: ProductionItem[]): Promise<void> {
  const keys = new Set<string>();
  for (const it of items) {
    if (it.posterS3Key) keys.add(it.posterS3Key);
    if (it.mediaS3Key) keys.add(it.mediaS3Key);
  }
  const urlByKey = new Map<string, string>();
  await Promise.all(
    Array.from(keys).map(async (key) => {
      try {
        urlByKey.set(key, await getPresignedGetUrl(key, 60 * 60));
      } catch {
        /* ignore */
      }
    })
  );
  for (const it of items) {
    it.posterUrl = it.posterS3Key ? urlByKey.get(it.posterS3Key) ?? null : null;
    it.mediaUrl = it.mediaS3Key ? urlByKey.get(it.mediaS3Key) ?? null : null;
  }
}

export async function getWeeklyGoal(brand: string): Promise<number | null> {
  if (brand === "all") {
    // Cross-brand "All" view: sum every enabled brand's goal. Brands with a
    // null goal contribute zero. Returns null if no brand has a goal set.
    const rows = await db
      .select({ weeklyGoal: brands.weeklyGoal })
      .from(brands)
      .where(eq(brands.disabled, false));
    const sum = rows.reduce((acc, r) => acc + (r.weeklyGoal ?? 0), 0);
    return sum > 0 ? sum : null;
  }
  const [row] = await db
    .select({ weeklyGoal: brands.weeklyGoal })
    .from(brands)
    .where(eq(brands.slug, brand))
    .limit(1);
  return row?.weeklyGoal ?? null;
}

export type BrandSettings = {
  weeklyGoal: number | null;
  weekStartDay: WeekStartsOn;
};

export async function getBrandSettings(brand: string): Promise<BrandSettings> {
  if (brand === "all") {
    // Cross-brand "All": sum-of-goals + Sunday week start. Picking one
    // weekStartDay across brands is impossible; default to Sunday (the
    // schema default) — week-keyed UI on /all renders against this.
    const weeklyGoal = await getWeeklyGoal("all");
    return { weeklyGoal, weekStartDay: 0 };
  }
  const [row] = await db
    .select({
      weeklyGoal: brands.weeklyGoal,
      weekStartDay: brands.weekStartDay,
    })
    .from(brands)
    .where(eq(brands.slug, brand))
    .limit(1);
  return {
    weeklyGoal: row?.weeklyGoal ?? null,
    weekStartDay: normalizeWeekStart(row?.weekStartDay),
  };
}

function normalizeWeekStart(value: number | null | undefined): WeekStartsOn {
  if (value == null) return 0;
  const clamped = Math.max(0, Math.min(6, Math.floor(value)));
  return clamped as WeekStartsOn;
}

import {
  buildPeriods,
  findPeriod,
  getWeekProgress,
  type WeekStartsOn,
} from "@/lib/utils/dates";
import type { ContentReportData, MetricData, ProductionItem } from "@/types";

interface ReportParams {
  brand: string;
  startDate: string;
  endDate: string;
  viewType: "weekly" | "daily" | "monthly";
  /** Legacy string filter — kept during the accounts rollout for URL
   *  compatibility. Prefer the three new filters below. */
  platform?: string;
  /** Canonical platform key (`youtube`, `instagram`, …) or "all". Filters
   *  via `accounts.platform` (joined). */
  platformKey?: string;
  /** `accounts.id` or "all". */
  accountId?: string;
  /** Canonical post_type or "all". */
  postType?: string;
  format: string;
  source: string;
}

export async function getContentReport(
  params: ReportParams
): Promise<ContentReportData> {
  const {
    brand,
    startDate,
    endDate,
    viewType,
    platform,
    platformKey,
    accountId,
    postType,
    format,
    source,
  } = params;

  const { weeklyGoal, weekStartDay } = await getBrandSettings(brand);

  // Build periods
  const periods = buildPeriods(
    new Date(startDate + "T00:00:00"),
    new Date(endDate + "T00:00:00"),
    viewType,
    weekStartDay
  );

  // Build query conditions — scoped to the requested brand. `brand="all"`
  // is the cross-brand sentinel used by the /all view; we drop the brand
  // predicate but keep every other filter (status, dates, etc.) intact so
  // the same page renders unchanged for one brand or all.
  const conditions = [
    isNotNull(productionItems.publishedDate),
    eq(productionItems.status, "Published"),
    gte(productionItems.publishedDate, startDate),
    lte(productionItems.publishedDate, endDate),
    isNotNull(productionItems.accountId),
    isNull(productionItems.deletedAt),
  ];
  if (brand !== "all") {
    conditions.unshift(eq(productionItems.brand, brand));
  }

  // New-world filters. `accountId` picks a single account; `platformKey`
  // scopes to one canonical platform (matched via the joined accounts row);
  // `postType` scopes to one canonical post_type.
  if (accountId && accountId !== "all") {
    conditions.push(eq(productionItems.accountId, accountId));
  }
  if (platformKey && platformKey !== "all") {
    conditions.push(eq(accounts.platform, platformKey));
  }
  if (postType && postType !== "all") {
    conditions.push(eq(productionItems.postType, postType));
  }
  // Legacy string filter, retained for URL back-compat.
  if (platform && platform !== "all") {
    conditions.push(
      sql`${productionItems.platform}::jsonb @> ${JSON.stringify([platform])}::jsonb`
    );
  }

  if (format !== "all") {
    conditions.push(eq(productionItems.format, format));
  }

  // Source filter classifies by sourceType (original / repost / cross_post).
  // NULL is treated as "original" since that's the historical default.
  if (source === "original") {
    conditions.push(
      sql`(${productionItems.sourceType} IS NULL OR ${productionItems.sourceType} = 'original')`
    );
  } else if (source === "repost") {
    conditions.push(eq(productionItems.sourceType, "repost"));
  } else if (source === "cross_post") {
    conditions.push(eq(productionItems.sourceType, "cross_post"));
  }

  // Join accounts+brands so each item carries a shaped `account` for the
  // UI's AccountBadge. Falls back to null when an item predates the
  // accounts backfill (shouldn't happen in practice; kept defensive).
  const rows = await db
    .select({
      item: productionItems,
      accountId: accounts.id,
      accountPlatform: accounts.platform,
      accountHandle: accounts.handle,
      accountDisplayName: accounts.displayName,
      accountAvatarUrl: accounts.avatarUrl,
      accountBrandSlug: brands.slug,
      accountBrandLabel: brands.label,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .leftJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(...conditions));
  const items = rows.map((r) => r.item);
  const accountByItemId = new Map(
    rows
      .filter((r) => r.accountId)
      .map((r) => [
        r.item.id,
        {
          id: r.accountId!,
          platform: r.accountPlatform!,
          handle: r.accountHandle!,
          displayName: r.accountDisplayName,
          avatarUrl: r.accountAvatarUrl ?? null,
          brandSlug: r.accountBrandSlug!,
          brandLabel: r.accountBrandLabel!,
        },
      ])
  );

  // Primary rows are now keyed by (account handle, post_type) instead of
  // the legacy platform string. Each row carries a shaped meta record so
  // the dashboard can render `[icon] @handle · PostType` in place of
  // "Instagram Reel" / "X (Pat Walls)" labels. An accounts-rollout win.
  type PrimaryRowMeta = {
    label: string;
    accountId: string;
    platform: string;
    handle: string;
    postType: string | null;
    avatarUrl: string | null;
  };
  const primaryRowMetaByKey = new Map<string, PrimaryRowMeta>();
  const itemToRowKey = new Map<string, string>();

  // Short-form labels per canonical post_type, matching the UI's
  // POST_TYPE_SHORT_LABEL. Inlined here to avoid a server → lib/ client
  // dependency; keep in sync.
  const postTypeShort: Record<string, string> = {
    youtube_long: "Long",
    youtube_shorts: "Short",
    youtube_community: "Community",
    instagram_reel: "Reel",
    instagram_post: "Post",
    instagram_story: "Story",
    x: "Post",
    tiktok: "Video",
    linkedin: "Post",
    threads: "Post",
    newsletter: "Issue",
  };
  const platformHasMultipleTypes = (p: string): boolean =>
    p === "youtube" || p === "instagram";

  // First pass: collect all unique (handle, platform) pairs to detect multi-platform accounts
  const handlePlatformCombos = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.accountId || !r.accountHandle || !r.accountPlatform) continue;
    const handleKey = r.accountHandle;
    if (!handlePlatformCombos.has(handleKey)) {
      handlePlatformCombos.set(handleKey, new Set());
    }
    handlePlatformCombos.get(handleKey)!.add(r.accountPlatform);
  }

  for (const r of rows) {
    if (!r.accountId || !r.accountHandle || !r.accountPlatform) continue;
    const pt = r.item.postType ?? null;
    const key = `${r.accountPlatform}|${r.accountHandle}|${pt ?? ""}`;
    itemToRowKey.set(r.item.id, key);
    if (!primaryRowMetaByKey.has(key)) {
      // Build label: account appears on multiple platforms → include platform suffix
      const accountPlatforms = handlePlatformCombos.get(r.accountHandle)!;
      let label: string;
      if (pt && platformHasMultipleTypes(r.accountPlatform)) {
        // YouTube/Instagram have multiple post types: show the type
        label = `@${r.accountHandle} · ${postTypeShort[pt] ?? pt}`;
      } else if (accountPlatforms.size > 1) {
        // Account on multiple platforms: add platform name for clarity
        const platformLabel = r.accountPlatform.charAt(0).toUpperCase() + r.accountPlatform.slice(1);
        label = `@${r.accountHandle} · ${platformLabel}`;
      } else {
        // Single platform: just show @handle
        label = `@${r.accountHandle}`;
      }
      primaryRowMetaByKey.set(key, {
        label,
        accountId: r.accountId,
        platform: r.accountPlatform,
        handle: r.accountHandle,
        postType: pt,
        avatarUrl: r.accountAvatarUrl ?? null,
      });
    }
  }

  // Keep `allPlatforms` around too — still used for the FilterPills
  // "Platform" picker (legacy-string values). Drops in a follow-up once
  // the filter swaps to account ids.
  const allPlatforms = new Set<string>();
  const allFormats = new Set<string>();

  items.forEach((item) => {
    const platforms = item.platform as string[] | null;
    platforms?.forEach((p) => allPlatforms.add(p));
    if (item.format) allFormats.add(item.format);
  });

  // Also include brand-scoped format names (pillar + repurposed) from the formats table
  const dbFormats = await db
    .select({ name: formats.name })
    .from(formats)
    .where(eq(formats.brand, brand));
  dbFormats.forEach((f) => allFormats.add(f.name));

  const platformList = Array.from(allPlatforms).sort();
  const formatList = Array.from(allFormats).sort();

  // Determine if we show platforms or formats in the primary table
  const showingFormats = platform !== "all" && format === "all";

  // Rows: either per-(account, post_type) (label) or per-format.
  const primaryRowMetaList = Array.from(primaryRowMetaByKey.values()).sort(
    (a, b) => a.label.localeCompare(b.label)
  );
  let primaryRows: string[];
  if (showingFormats) {
    primaryRows = [...formatList];
    if (items.some((i) => !i.format)) primaryRows.push("(No Format)");
  } else {
    primaryRows = primaryRowMetaList.map((m) => m.label);
  }
  // Expose the meta map (keyed by row label) so the UI can render an
  // icon + handle badge for each row.
  const primaryRowMeta: Record<string, PrimaryRowMeta> = Object.fromEntries(
    primaryRowMetaList.map((m) => [m.label, m])
  );

  // Initialize metric data structures
  const initMetricData = (rows: string[]): MetricData => {
    const data: MetricData = {};
    rows.forEach((row) => {
      data[row] = {};
      periods.forEach((p) => {
        data[row][p.label] = 0;
      });
    });
    return data;
  };

  // Primary table (by platform or by format when a platform is selected)
  const primaryProduction = initMetricData(primaryRows);
  const primaryViews = initMetricData(primaryRows);
  const primaryLeads = initMetricData(primaryRows);
  const primarySales = initMetricData(primaryRows);

  // Format table (always by format)
  const formatRows = [...formatList];
  if (items.some((i) => !i.format)) formatRows.push("(No Format)");

  const formatProduction = initMetricData(formatRows);
  const formatViews = initMetricData(formatRows);
  const formatLeads = initMetricData(formatRows);

  // Aggregate data
  items.forEach((item) => {
    if (!item.publishedDate) return;
    const period = findPeriod(item.publishedDate, periods);
    if (!period) return;

    const views = item.views || 0;
    const leads = item.leads || 0;
    const sales = item.salesAmount ? parseFloat(item.salesAmount) : 0;

    // Primary table aggregation
    if (showingFormats) {
      const formatKey = item.format || "(No Format)";
      if (primaryProduction[formatKey]) {
        primaryProduction[formatKey][period.label] += 1;
        primaryViews[formatKey][period.label] += views;
        primaryLeads[formatKey][period.label] += leads;
        primarySales[formatKey][period.label] += sales;
      }
    } else {
      // Resolve the row label from the item's composite account key.
      // Skip if the item predates the accounts backfill (no account FK).
      const rowKey = itemToRowKey.get(item.id);
      const label = rowKey ? primaryRowMetaByKey.get(rowKey)?.label : null;
      if (label && primaryProduction[label]) {
        primaryProduction[label][period.label] += 1;
        primaryViews[label][period.label] += views;
        primaryLeads[label][period.label] += leads;
        primarySales[label][period.label] += sales;
      }
    }

    // Format table aggregation (always)
    const fKey = item.format || "(No Format)";
    if (formatProduction[fKey]) {
      formatProduction[fKey][period.label] += 1;
      formatViews[fKey][period.label] += views;
      formatLeads[fKey][period.label] += leads;
    }
  });

  // Calculate views per post
  const calcViewsPerPost = (
    production: MetricData,
    views: MetricData
  ): MetricData => {
    const result: MetricData = {};
    Object.keys(production).forEach((row) => {
      result[row] = {};
      Object.keys(production[row]).forEach((period) => {
        const count = production[row][period];
        const v = views[row][period];
        result[row][period] = count > 0 ? Math.round(v / count) : 0;
      });
    });
    return result;
  };

  const primaryViewsPerPost = calcViewsPerPost(primaryProduction, primaryViews);
  const formatViewsPerPost = calcViewsPerPost(formatProduction, formatViews);

  const mappedItems: ProductionItem[] = items.map((it) =>
    mapProductionItem(it, { account: accountByItemId.get(it.id) ?? null })
  );
  await attachPresignedCoverUrls(mappedItems);

  return {
    periods,
    byPlatform: {
      production: primaryProduction,
      views: primaryViews,
      leads: primaryLeads,
      viewsPerPost: primaryViewsPerPost,
      sales: primarySales,
    },
    byFormat: {
      production: formatProduction,
      views: formatViews,
      leads: formatLeads,
      viewsPerPost: formatViewsPerPost,
    },
    items: mappedItems,
    weekProgress: getWeekProgress(weekStartDay),
    weekStartDay,
    platforms: platformList,
    formats: formatList,
    showingFormats,
    weeklyGoal,
    // New metadata consumed by the UI to render `[icon] @handle · Type`
    // row labels in place of raw platform strings.
    primaryRowMeta,
  };
}

export async function getProductionPipeline(
  brand: string
): Promise<ProductionItem[]> {
  const producers = aliasedTable(users, "producer_user");
  const editors = aliasedTable(users, "editor_user");

  const inFlightStatuses = await resolveInFlightStatuses(brand);

  const rows = await db
    .select({
      item: productionItems,
      producerUserName: producers.name,
      producerAvatarUrl: producers.avatarUrl,
      editorUserName: editors.name,
      editorAvatarUrl: editors.avatarUrl,
      accountId: accounts.id,
      accountPlatform: accounts.platform,
      accountHandle: accounts.handle,
      accountDisplayName: accounts.displayName,
      accountAvatarUrl: accounts.avatarUrl,
      accountBrandSlug: brands.slug,
      accountBrandLabel: brands.label,
      // LLM per-clip estimate (sourceType='clip' rows only). The partial
      // unique index on source_clip_idea_id keeps the join 1:1 without
      // exploding row counts for non-clip items.
      clipEstimatedViews: clipIdeas.estimatedViews,
    })
    .from(productionItems)
    .leftJoin(producers, eq(producers.id, productionItems.producerUserId))
    .leftJoin(editors, eq(editors.id, productionItems.editorUserId))
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .leftJoin(brands, eq(brands.id, accounts.brandId))
    .leftJoin(clipIdeas, eq(clipIdeas.id, productionItems.sourceClipIdeaId))
    .where(
      and(
        // `brand="all"` is the cross-brand sentinel; drop the predicate
        // entirely so /all/queue and /all/production aggregate everything.
        ...(brand === "all" ? [] : [eq(productionItems.brand, brand)]),
        inArray(productionItems.status, inFlightStatuses),
        isNull(productionItems.deletedAt)
      )
    );

  // Resolve pillar titles for any clip / repurpose row whose pillar lives
  // in the same productionItems table. Done as a separate IN query rather
  // than a self-join because Drizzle's type inference chokes on aliased
  // self-joins and the cardinality is small (one extra round-trip, ~one
  // row per distinct pillar — typically <50 in a brand's queue).
  const pillarIds = Array.from(
    new Set(
      rows
        .map((r) => r.item.pillarContentItemId)
        .filter((id): id is string => !!id)
    )
  );
  const pillarTitleById = new Map<string, string | null>();
  if (pillarIds.length > 0) {
    const pillarRows = await db
      .select({ id: productionItems.id, title: productionItems.title })
      .from(productionItems)
      .where(inArray(productionItems.id, pillarIds));
    for (const p of pillarRows) {
      pillarTitleById.set(p.id, p.title ?? null);
    }
  }

  return rows.map((r) =>
    mapProductionItem(r.item, {
      producerUserName: r.producerUserName,
      producerAvatarUrl: r.producerAvatarUrl,
      editorUserName: r.editorUserName,
      editorAvatarUrl: r.editorAvatarUrl,
      account: r.accountId
        ? {
            id: r.accountId,
            platform: r.accountPlatform!,
            handle: r.accountHandle!,
            displayName: r.accountDisplayName,
            avatarUrl: r.accountAvatarUrl ?? null,
            brandSlug: r.accountBrandSlug!,
            brandLabel: r.accountBrandLabel!,
          }
        : null,
      clipEstimatedViews:
        r.clipEstimatedViews != null ? Number(r.clipEstimatedViews) : null,
      pillarContentTitle: r.item.pillarContentItemId
        ? pillarTitleById.get(r.item.pillarContentItemId) ?? null
        : null,
    })
  );
}

const SHORT_FORM_PLATFORMS = ["YouTube Shorts", "Instagram Reel", "TikTok"];

export interface TopShortFormRow {
  id: string;
  title: string | null;
  platform: string[] | null;
  format: string | null;
  views: number | null;
  publishedDate: string | null;
  pillarContentItemId: string | null;
  hook: string | null;
}

export interface TopShortFormRowRich extends TopShortFormRow {
  contentBody: string | null;
  coverDescription: string | null;
  likes: number | null;
  comments: number | null;
  /** First ~1200 chars of the reel's own transcript (when one exists). */
  openingTranscript: string | null;
}

export interface TopShortFormPerformers {
  /** Rich-shaped top performers in the brand's preferred clip format. The
   *  clip-idea agent treats these as the pattern-match ground truth — full
   *  hook + caption + opening transcript + engagement. */
  blueprint: TopShortFormRowRich[];
  /** Lighter, broader short-form winners (any format) for view-count
   *  calibration. Excludes any id that's already in `blueprint`. */
  bench: TopShortFormRow[];
}

/**
 * Top-performing short-form clips for a brand. Used by the clip-idea agent
 * as ground-truth examples of what works for this audience.
 *
 * Returns a tiered shape (since 2026-05-01 / prompt V5):
 *   - `blueprint`: top N where format = `preferredFormat` (the brand's
 *     dominant clip format) and the row has a non-null hook. SELECT pulls
 *     caption, cover description, engagement, and the first ~1200 chars of
 *     the reel's own transcript via a left join on `transcripts`.
 *   - `bench`: top N short-form regardless of format, excluding anything
 *     already in `blueprint` (by id). Same shape as `TopShortFormRow`.
 *
 * Optionally excludes direct children of a given pillar so the brand-wide
 * sample doesn't overlap with the pillar's own derivatives block.
 */
export async function topShortFormPerformers(params: {
  brand: string;
  excludeDerivativesOfPillarId?: string;
  preferredFormat?: string;
  blueprintLimit?: number;
  benchLimit?: number;
}): Promise<TopShortFormPerformers> {
  const {
    brand,
    excludeDerivativesOfPillarId,
    preferredFormat,
    blueprintLimit = 10,
    benchLimit = 20,
  } = params;

  // JSONB containment — "any of these platforms" via OR over containment for
  // each short-form platform string. Mirrors the pattern at queries.ts:116-120.
  const platformOr = sql.join(
    SHORT_FORM_PLATFORMS.map(
      (p) =>
        sql`${productionItems.platform}::jsonb @> ${JSON.stringify([p])}::jsonb`
    ),
    sql` OR `
  );

  const baseConditions = [
    eq(productionItems.brand, brand),
    eq(productionItems.status, "Published"),
    isNotNull(productionItems.views),
    sql`(${platformOr})`,
    isNull(productionItems.deletedAt),
  ];

  if (excludeDerivativesOfPillarId) {
    // Exclude direct children of the pillar. Grandchildren etc. stay — for the
    // small sample the overlap cost is tiny and a recursive exclude is overkill.
    baseConditions.push(
      sql`(${productionItems.pillarContentItemId} IS NULL OR ${productionItems.pillarContentItemId} <> ${excludeDerivativesOfPillarId})`
    );
  }

  // Blueprint: format-locked top performers with the rich payload joined.
  // Only run when a preferredFormat is set — otherwise blueprint is empty
  // and the agent falls back to bench-only context.
  const blueprintRows: TopShortFormRowRich[] = preferredFormat
    ? (
        await db
          .select({
            id: productionItems.id,
            title: productionItems.title,
            platform: productionItems.platform,
            format: productionItems.format,
            views: productionItems.views,
            publishedDate: productionItems.publishedDate,
            pillarContentItemId: productionItems.pillarContentItemId,
            hook: productionItems.hook,
            contentBody: productionItems.contentBody,
            coverDescription: productionItems.coverDescription,
            likes: productionItems.likes,
            comments: productionItems.comments,
            openingTranscript: sql<string | null>`LEFT(${transcripts.fullText}, 1200)`,
          })
          .from(productionItems)
          .leftJoin(
            transcripts,
            eq(transcripts.productionItemId, productionItems.id)
          )
          .where(
            and(
              ...baseConditions,
              eq(productionItems.format, preferredFormat),
              isNotNull(productionItems.hook),
              sql`${productionItems.hook} <> ''`
            )
          )
          .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
          .limit(blueprintLimit)
      ).map((r) => ({
        ...r,
        platform: r.platform as string[] | null,
      }))
    : [];

  // Bench: broader top performers, light shape, excluding ids already in
  // blueprint to avoid duplication.
  const benchExcludeIds = blueprintRows.map((r) => r.id);
  const benchRows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      platform: productionItems.platform,
      format: productionItems.format,
      views: productionItems.views,
      publishedDate: productionItems.publishedDate,
      pillarContentItemId: productionItems.pillarContentItemId,
      hook: productionItems.hook,
    })
    .from(productionItems)
    .where(
      and(
        ...baseConditions,
        ...(benchExcludeIds.length > 0
          ? [sql`${productionItems.id} NOT IN (${sql.join(benchExcludeIds.map((id) => sql`${id}`), sql`, `)})`]
          : [])
      )
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(benchLimit);

  return {
    blueprint: blueprintRows,
    bench: benchRows.map((r) => ({
      ...r,
      platform: r.platform as string[] | null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  Coverage map                                                       */
/* ------------------------------------------------------------------ */

export interface CoverageRow {
  brand: string;
  platform: string;
  total: number;
  hasTranscript: number;
  hasEnrichment: number;
  hasPerfSync: number;
  hasMedia: number;
  hasAuthor: number;
  hasHook: number;
  hasClipIdeas: number;
  hasEvergreen: number;
}

/**
 * One row per (brand, primary platform) counting how many published items
 * have each durable data signal. Used by the `/coverage` page to spot data
 * gaps before running a backfill. "Primary platform" = first element of the
 * jsonb `platform` array; cross-posts still count once per row.
 */
export async function getCoverageMap(): Promise<CoverageRow[]> {
  const rows = (await db.execute(sql`
    SELECT
      pi.brand AS brand,
      COALESCE(pi.platform->>0, 'Unknown') AS platform,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL)::int AS has_transcript,
      COUNT(*) FILTER (WHERE pi.enrichment_completed_at IS NOT NULL)::int AS has_enrichment,
      COUNT(*) FILTER (WHERE pi.last_performance_sync_at IS NOT NULL)::int AS has_perf_sync,
      COUNT(*) FILTER (WHERE pi.media_s3_key IS NOT NULL)::int AS has_media,
      COUNT(*) FILTER (WHERE pi.author_handle IS NOT NULL)::int AS has_author,
      COUNT(*) FILTER (WHERE pi.hook IS NOT NULL)::int AS has_hook,
      COUNT(*) FILTER (WHERE ci_exists.one IS NOT NULL)::int AS has_clip_ideas,
      COUNT(*) FILTER (WHERE pi.evergreen_evaluated_at IS NOT NULL)::int AS has_evergreen
    FROM production_items pi
    LEFT JOIN transcripts t ON t.production_item_id = pi.id
    LEFT JOIN LATERAL (
      SELECT 1 AS one FROM clip_ideas
      WHERE source_production_item_id = pi.id
      LIMIT 1
    ) ci_exists ON TRUE
    WHERE pi.status = 'Published'
    GROUP BY pi.brand, platform
    ORDER BY pi.brand ASC, total DESC
  `)) as unknown as Array<{
    brand: string;
    platform: string;
    total: number;
    has_transcript: number;
    has_enrichment: number;
    has_perf_sync: number;
    has_media: number;
    has_author: number;
    has_hook: number;
    has_clip_ideas: number;
    has_evergreen: number;
  }>;

  return rows.map((r) => ({
    brand: r.brand,
    platform: r.platform,
    total: Number(r.total),
    hasTranscript: Number(r.has_transcript),
    hasEnrichment: Number(r.has_enrichment),
    hasPerfSync: Number(r.has_perf_sync),
    hasMedia: Number(r.has_media),
    hasAuthor: Number(r.has_author),
    hasHook: Number(r.has_hook),
    hasClipIdeas: Number(r.has_clip_ideas),
    hasEvergreen: Number(r.has_evergreen),
  }));
}

export interface HookSourceBreakdown {
  brand: string;
  total: number;
  withHook: number;
  withCoverDescription: number;
  bySource: {
    clip_idea: number;
    llm: number;
    vision: number;
    overlay: number;
    content_body: number;
    title: number;
    manual: number;
    other: number;
  };
}

/**
 * Per-brand breakdown of hook-population by source. Distinct from the
 * coverage table's single "has hook" column — answers "where did the hook
 * text come from?" so we can tell whether a brand's hooks are real
 * (LLM/clip_idea) or just title-fallback.
 */
export async function getHookSourceBreakdown(): Promise<HookSourceBreakdown[]> {
  const [bySourceRows, coverRows] = await Promise.all([
    db.execute(sql`
      SELECT
        pi.brand AS brand,
        pi.hook_source AS hook_source,
        COUNT(*)::int AS n,
        COUNT(*) FILTER (WHERE pi.hook IS NOT NULL)::int AS n_with_hook
      FROM production_items pi
      WHERE pi.status = 'Published'
      GROUP BY pi.brand, pi.hook_source
      ORDER BY pi.brand ASC
    `) as unknown as Promise<
      Array<{
        brand: string;
        hook_source: string | null;
        n: number;
        n_with_hook: number;
      }>
    >,
    db.execute(sql`
      SELECT
        pi.brand AS brand,
        COUNT(*) FILTER (WHERE pi.cover_description IS NOT NULL)::int AS n_with_cover
      FROM production_items pi
      WHERE pi.status = 'Published'
      GROUP BY pi.brand
    `) as unknown as Promise<
      Array<{ brand: string; n_with_cover: number }>
    >,
  ]);

  const coverByBrand = new Map(
    coverRows.map((r) => [r.brand, Number(r.n_with_cover)])
  );

  const byBrand = new Map<string, HookSourceBreakdown>();
  for (const r of bySourceRows) {
    let entry = byBrand.get(r.brand);
    if (!entry) {
      entry = {
        brand: r.brand,
        total: 0,
        withHook: 0,
        withCoverDescription: coverByBrand.get(r.brand) ?? 0,
        bySource: {
          clip_idea: 0,
          llm: 0,
          vision: 0,
          overlay: 0,
          content_body: 0,
          title: 0,
          manual: 0,
          other: 0,
        },
      };
      byBrand.set(r.brand, entry);
    }
    const n = Number(r.n);
    const nWithHook = Number(r.n_with_hook);
    entry.total += n;
    entry.withHook += nWithHook;

    if (nWithHook === 0) continue;
    switch (r.hook_source) {
      case "clip_idea":
      case "llm":
      case "vision":
      case "overlay":
      case "content_body":
      case "title":
      case "manual":
        entry.bySource[r.hook_source] += nWithHook;
        break;
      default:
        entry.bySource.other += nWithHook;
    }
  }
  return Array.from(byBrand.values()).sort((a, b) =>
    a.brand.localeCompare(b.brand)
  );
}

// ─── Velocity snapshot coverage ────────────────────────────────────────

export interface VelocityCoverageCell {
  /** Items eligible for this checkpoint: Published originals with a
   *  non-null `publishedAt` older than the checkpoint's windowMax (so the
   *  window has had its chance) AND published within the last 14 days
   *  (so we measure recent tracking health, not ancient history). */
  expected: number;
  /** How many of those items have a `view_snapshots` row for this
   *  checkpoint. */
  captured: number;
}

export interface VelocityCoverageRow {
  brand: string;
  /** Keyed by `VelocityCheckpointKey` — "15m" | "30m" | "1h" | ... */
  checkpoints: Record<string, VelocityCoverageCell>;
}

/**
 * Per-brand velocity-snapshot capture rate.
 *
 * For each of the 8 checkpoints, counts:
 *   - `expected` = Published originals with a publishedAt >= now-14d AND
 *      <= now - windowMax. (Eligible: published recently enough that the
 *      system was live, and long enough ago that the window has closed
 *      and any scheduled job should have fired by now.)
 *   - `captured` = how many of those have a `view_snapshots` row for
 *      this checkpoint_key.
 *
 * `captured / expected` → the health metric the /coverage page shows.
 * 100% is unrealistic — LinkedIn and YouTube Community posts legitimately
 * return no view signal until some likes accrue, so their snapshots are
 * correctly skipped (not a bug). Expect ≥80% on healthy weeks.
 */
export async function getVelocityCoverage(): Promise<VelocityCoverageRow[]> {
  const rows = await db.execute<{
    brand: string;
    checkpoint_key: string;
    expected: string;
    captured: string;
  }>(sql`
    WITH checkpoints AS (
      SELECT * FROM (VALUES
        ('15m', 22),
        ('30m', 45),
        ('1h', 90),
        ('2h', 179),
        ('4h', 300),
        ('8h', 720),
        ('24h', 2160),
        ('48h', 4320)
      ) AS t(key, window_max_min)
    ),
    -- Use the earliest taken_at as the velocity-tracking-live-since
    -- epoch. Items published before this point never had a chance to be
    -- captured and would unfairly drag the denominator to 0%. If no
    -- snapshots exist yet, COALESCE falls back to a far-future date so
    -- the expected count is 0 and the UI section hides.
    tracking_since AS (
      SELECT COALESCE(
        (SELECT min(taken_at) FROM view_snapshots),
        '9999-12-31'::timestamptz
      ) AS ts
    ),
    eligible AS (
      SELECT
        pi.id,
        pi.brand,
        cp.key AS checkpoint_key
      FROM production_items pi
      CROSS JOIN checkpoints cp
      CROSS JOIN tracking_since t
      WHERE pi.status = 'Published'
        AND pi.source_type = 'original'
        AND pi.deleted_at IS NULL
        AND pi.published_at IS NOT NULL
        AND pi.published_at <= now() - (cp.window_max_min * interval '1 minute')
        AND pi.published_at >= now() - interval '14 days'
        -- Only count items published after the capture system was running.
        AND pi.published_at >= t.ts
    )
    SELECT
      e.brand,
      e.checkpoint_key,
      count(*)::text AS expected,
      count(vs.id)::text AS captured
    FROM eligible e
    LEFT JOIN view_snapshots vs
      ON vs.production_item_id = e.id
     AND vs.checkpoint_key = e.checkpoint_key
    GROUP BY e.brand, e.checkpoint_key
  `);

  const byBrand = new Map<string, VelocityCoverageRow>();
  for (const r of rows) {
    let entry = byBrand.get(r.brand);
    if (!entry) {
      entry = { brand: r.brand, checkpoints: {} };
      byBrand.set(r.brand, entry);
    }
    entry.checkpoints[r.checkpoint_key] = {
      expected: Number(r.expected),
      captured: Number(r.captured),
    };
  }
  return Array.from(byBrand.values()).sort((a, b) =>
    a.brand.localeCompare(b.brand)
  );
}
