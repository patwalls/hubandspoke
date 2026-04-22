import { db } from "@/lib/db";
import { productionItems, formats, brandSettings, users } from "@/lib/db/schema";
import { aliasedTable } from "drizzle-orm";
import { and, eq, gte, lte, isNotNull, inArray, sql } from "drizzle-orm";
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
    status: item.status,
    platform: item.platform as string[] | null,
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
    .select({ weeklyGoal: brandSettings.weeklyGoal })
    .from(brandSettings)
    .where(eq(brandSettings.brand, brand))
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
      weeklyGoal: brandSettings.weeklyGoal,
      weekStartDay: brandSettings.weekStartDay,
    })
    .from(brandSettings)
    .where(eq(brandSettings.brand, brand))
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
  viewType: "weekly" | "daily";
  platform: string;
  format: string;
  source: string;
}

export async function getContentReport(
  params: ReportParams
): Promise<ContentReportData> {
  const { startDate, endDate, viewType, platform, format, source } = params;

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
  ];

  if (platform !== "all") {
    // Filter where platform JSONB array contains the value
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

  const items = await db
    .select()
    .from(productionItems)
    .where(and(...conditions));

  // Get all platforms and formats
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

  // Determine rows for the primary table
  let primaryRows: string[];
  if (showingFormats) {
    primaryRows = [...formatList];
    if (items.some((i) => !i.format)) primaryRows.push("(No Format)");
  } else {
    primaryRows = platformList;
  }

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
      const platforms = (item.platform as string[]) || [];
      platforms.forEach((p) => {
        if (primaryProduction[p]) {
          primaryProduction[p][period.label] += 1;
          primaryViews[p][period.label] += views;
          primaryLeads[p][period.label] += leads;
          primarySales[p][period.label] += sales;
        }
      });
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

  const mappedItems: ProductionItem[] = items.map((it) => mapProductionItem(it));
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
    })
    .from(productionItems)
    .leftJoin(producers, eq(producers.id, productionItems.producerUserId))
    .leftJoin(editors, eq(editors.id, productionItems.editorUserId))
    .where(
      and(
        eq(productionItems.brand, brand),
        inArray(productionItems.status, PIPELINE_STATUSES as unknown as string[])
      )
    );

  return rows.map((r) =>
    mapProductionItem(r.item, {
      producerUserName: r.producerUserName,
      producerAvatarUrl: r.producerAvatarUrl,
      editorUserName: r.editorUserName,
      editorAvatarUrl: r.editorAvatarUrl,
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
