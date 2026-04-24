import { db } from "@/lib/db";
import { productionItems, formats, brands, users, accounts } from "@/lib/db/schema";
import { aliasedTable } from "drizzle-orm";
import { and, eq, gte, lte, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import { getPresignedGetUrl } from "@/lib/s3";

export const PIPELINE_STATUSES = [
  "Ready To Publish",
  "Final Review",
  "Review",
  "Assigned",
  "Idea",
] as const;

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
      | "cross_post",
    repostedFromItemId: item.repostedFromItemId,
    pillarContentItemId: item.pillarContentItemId,
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

  const { weeklyGoal, weekStartDay } = await getBrandSettings("starter-story");

  // Build periods
  const periods = buildPeriods(
    new Date(startDate + "T00:00:00"),
    new Date(endDate + "T00:00:00"),
    viewType,
    weekStartDay
  );

  // Build query conditions — scoped to starter-story brand only
  const conditions = [
    eq(productionItems.brand, "starter-story"),
    isNotNull(productionItems.publishedDate),
    eq(productionItems.status, "Published"),
    gte(productionItems.publishedDate, startDate),
    lte(productionItems.publishedDate, endDate),
    isNotNull(productionItems.platform),
    isNull(productionItems.deletedAt),
  ];

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

  if (source === "internal") {
    conditions.push(eq(productionItems.isExternal, false));
  } else if (source === "external") {
    conditions.push(eq(productionItems.isExternal, true));
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

  // Also include all SS format names (pillar + repurposed) from the formats table
  const dbFormats = await db
    .select({ name: formats.name })
    .from(formats)
    .where(eq(formats.brand, "starter-story"));
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
    })
    .from(productionItems)
    .leftJoin(producers, eq(producers.id, productionItems.producerUserId))
    .leftJoin(editors, eq(editors.id, productionItems.editorUserId))
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .leftJoin(brands, eq(brands.id, accounts.brandId))
    .where(
      and(
        eq(productionItems.brand, brand),
        inArray(productionItems.status, PIPELINE_STATUSES as unknown as string[]),
        isNull(productionItems.deletedAt)
      )
    );

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

/**
 * Top-performing short-form clips for a brand. Used by the clip-idea agent
 * as ground-truth examples of what works for this audience.
 *
 * Optionally excludes rows that descend from a given pillar so the brand-wide
 * sample doesn't overlap with the pillar's own derivatives block.
 */
export async function topShortFormPerformers(params: {
  brand: string;
  excludeDerivativesOfPillarId?: string;
  limit?: number;
}): Promise<TopShortFormRow[]> {
  const { brand, excludeDerivativesOfPillarId, limit = 30 } = params;

  // JSONB containment — "any of these platforms" via OR over containment for
  // each short-form platform string. Mirrors the pattern at queries.ts:116-120.
  const platformOr = sql.join(
    SHORT_FORM_PLATFORMS.map(
      (p) =>
        sql`${productionItems.platform}::jsonb @> ${JSON.stringify([p])}::jsonb`
    ),
    sql` OR `
  );

  const conditions = [
    eq(productionItems.brand, brand),
    eq(productionItems.status, "Published"),
    isNotNull(productionItems.views),
    sql`(${platformOr})`,
    isNull(productionItems.deletedAt),
  ];

  if (excludeDerivativesOfPillarId) {
    // Exclude direct children of the pillar. Grandchildren etc. stay — for the
    // 30-row sample the overlap cost is tiny and a recursive exclude is
    // overkill.
    conditions.push(
      sql`(${productionItems.pillarContentItemId} IS NULL OR ${productionItems.pillarContentItemId} <> ${excludeDerivativesOfPillarId})`
    );
  }

  const rows = await db
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
    .where(and(...conditions))
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    platform: r.platform as string[] | null,
  }));
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
