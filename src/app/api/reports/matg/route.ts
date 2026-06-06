import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { productionItems, formats, accounts, brands } from "@/lib/db/schema";
import { and, eq, gte, inArray, lte, isNotNull, isNull, sql } from "drizzle-orm";
import {
  computeProvenStatusForBrand,
  summarizeProvenStatuses,
} from "@/lib/services/format-proven";
import { buildPeriods, findPeriod, getWeekProgress } from "@/lib/utils/dates";
import { getBrandSettings } from "@/lib/db/queries";
import { format, subDays } from "date-fns";
import { todayInclusiveOfUtc } from "@/lib/dates";
import type { ContentReportData, MetricData, ProductionItem } from "@/types";

/**
 * PATCH /api/reports/matg
 *
 * Update a production item's format (allows manual format editing in dashboard).
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { itemId, format: newFormat } = body;

    if (!itemId) {
      return NextResponse.json({ error: "itemId required" }, { status: 400 });
    }

    await db
      .update(productionItems)
      .set({ format: newFormat || null, updatedAt: new Date() })
      .where(eq(productionItems.id, itemId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating item format:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

/**
 * GET /api/reports/matg
 *
 * Returns MATG content report with the same structure as Starter Story.
 * Supports date range, view type, platform, format, and source filters.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = todayInclusiveOfUtc();

  const startDate = searchParams.get("startDate") || defaultStart;
  const endDate = searchParams.get("endDate") || defaultEnd;
  const viewType = (searchParams.get("viewType") || "weekly") as "weekly" | "daily";
  const platformFilter = searchParams.get("platform") || "all";
  const platformKeyFilter = searchParams.get("platformKey") || "all";
  const accountIdFilter = searchParams.get("accountId") || "all";
  const postTypeFilter = searchParams.get("postType") || "all";
  const formatFilter = searchParams.get("format") || "all";
  const sourceFilter = searchParams.get("source") || "all";
  const provenOnly = searchParams.get("provenOnly") === "1";
  const originFilter = searchParams.get("origin") || "all";

  try {
    const { weeklyGoal, weeklyViewsGoal, weekStartDay } = await getBrandSettings("matg");

    // Build periods
    const periods = buildPeriods(
      new Date(startDate + "T00:00:00"),
      new Date(endDate + "T00:00:00"),
      viewType,
      weekStartDay
    );

    // Build query conditions — MATG brand, has published date
    const conditions = [
      eq(productionItems.brand, "matg"),
      isNotNull(productionItems.publishedDate),
      gte(productionItems.publishedDate, startDate),
      lte(productionItems.publishedDate, endDate),
      isNull(productionItems.deletedAt),
    ];

    if (platformFilter !== "all") {
      conditions.push(
        sql`${productionItems.platform}::jsonb @> ${JSON.stringify([platformFilter])}::jsonb`
      );
    }
    // New-world filters (prefer these over the legacy string filter above).
    if (accountIdFilter !== "all") {
      conditions.push(eq(productionItems.accountId, accountIdFilter));
    }
    if (platformKeyFilter !== "all") {
      conditions.push(eq(accounts.platform, platformKeyFilter));
    }
    if (postTypeFilter !== "all") {
      conditions.push(eq(productionItems.postType, postTypeFilter));
    }

    if (formatFilter !== "all") {
      conditions.push(eq(productionItems.format, formatFilter));
    }

    // Proven-format gate. Computed brand-wide on a 180-day window so the
    // headline tile and the chart filter share a definition. Skipping the
    // filter when nothing qualifies short-circuits the query to empty.
    const provenByName = await computeProvenStatusForBrand("matg");
    const provenSummary = summarizeProvenStatuses(provenByName.values());
    if (provenOnly) {
      const provenNames = Array.from(provenByName.entries())
        .filter(([, s]) => s.isProven)
        .map(([name]) => name);
      if (provenNames.length === 0) {
        conditions.push(sql`false`);
      } else {
        conditions.push(inArray(productionItems.format, provenNames));
      }
    }

    // Source filter classifies by sourceType (original / repurposed /
    // repost / cross_post). NULL is treated as "original" since that's
    // the historical default.
    if (sourceFilter === "original") {
      conditions.push(
        sql`(${productionItems.sourceType} IS NULL OR ${productionItems.sourceType} = 'original')`
      );
    } else if (sourceFilter === "repurposed") {
      conditions.push(eq(productionItems.sourceType, "repurposed"));
    } else if (sourceFilter === "repost") {
      conditions.push(eq(productionItems.sourceType, "repost"));
    } else if (sourceFilter === "cross_post") {
      conditions.push(eq(productionItems.sourceType, "cross_post"));
    }

    // Origin filter — see getContentReport in src/lib/db/queries.ts for the
    // canonical comment. Explicit `createdVia` is definitive; the
    // `sourceType` fallback covers pre-2026-05-11 rows with the
    // documented small-false-positive risk from retroactive backfills.
    if (originFilter === "hubandspoke") {
      conditions.push(
        sql`(
          (${productionItems.createdVia} IS NOT NULL AND ${productionItems.createdVia} NOT LIKE 'sync:%')
          OR ${productionItems.sourceType} IN ('repost', 'cross_post', 'repurposed')
        )`
      );
    } else if (originFilter === "synced") {
      conditions.push(
        sql`(
          ${productionItems.createdVia} LIKE 'sync:%'
          OR (
            ${productionItems.createdVia} IS NULL
            AND (${productionItems.sourceType} IS NULL OR ${productionItems.sourceType} = 'original')
          )
        )`
      );
    }

    // Join accounts+brands so each returned item carries a shaped
    // `account` for the UI's AccountBadge — avoids the N+1 lookup the
    // dashboard used to do on the client.
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

    // Always show all MATG platforms, even those with 0 output
    const MATG_PLATFORMS = [
      "YouTube",
      "YouTube Shorts",
      "Instagram Reel",
      "Instagram Post",
      "X",
    ];

    const allPlatforms = new Set<string>(MATG_PLATFORMS);
    const allFormats = new Set<string>();

    items.forEach((item) => {
      const platforms = item.platform as string[] | null;
      platforms?.forEach((p) => allPlatforms.add(p));
      if (item.format) allFormats.add(item.format);
    });

    // Also include all MATG format names (pillar + repurposed) from the formats table
    const dbFormats = await db
      .select({ name: formats.name })
      .from(formats)
      .where(eq(formats.brand, "matg"));
    dbFormats.forEach((f) => allFormats.add(f.name));

    const platformList = Array.from(allPlatforms).sort();
    const formatList = Array.from(allFormats).sort();

    // Primary rows are per (account, post_type) instead of raw platform
    // strings — mirrors the starter-story shape. See getContentReport in
    // src/lib/db/queries.ts for the spec.
    type PrimaryRowMeta = {
      label: string;
      accountId: string;
      platform: string;
      handle: string;
      postType: string | null;
      avatarUrl: string | null;
    };
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
    const primaryRowMetaByKey = new Map<string, PrimaryRowMeta>();
    const itemToRowKey = new Map<string, string>();
    for (const r of rows) {
      if (!r.accountId || !r.accountHandle || !r.accountPlatform) continue;
      const pt = r.item.postType ?? null;
      const key = `${r.accountPlatform}|${r.accountHandle}|${pt ?? ""}`;
      itemToRowKey.set(r.item.id, key);
      if (!primaryRowMetaByKey.has(key)) {
        const label = pt && platformHasMultipleTypes(r.accountPlatform)
          ? `@${r.accountHandle} · ${postTypeShort[pt] ?? pt}`
          : `@${r.accountHandle}`;
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
    const primaryRowMetaList = Array.from(primaryRowMetaByKey.values()).sort(
      (a, b) => a.label.localeCompare(b.label)
    );
    const primaryRowMeta: Record<string, PrimaryRowMeta> = Object.fromEntries(
      primaryRowMetaList.map((m) => [m.label, m])
    );

    // Determine if we show formats in primary table
    const showingFormats = platformFilter !== "all" && formatFilter === "all";

    let primaryRows: string[];
    if (showingFormats) {
      primaryRows = [...formatList];
      if (items.some((i) => !i.format)) primaryRows.push("(No Format)");
    } else {
      primaryRows = primaryRowMetaList.map((m) => m.label);
    }

    // Initialize metric data
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

    // Primary table metrics
    const primaryProduction = initMetricData(primaryRows);
    const primaryViews = initMetricData(primaryRows);
    const primaryClicks = initMetricData(primaryRows);
    const primaryLeads = initMetricData(primaryRows);

    // Format table metrics
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
      const clicks = item.clicks || 0;
      const leads = item.leads || 0;

      if (showingFormats) {
        const formatKey = item.format || "(No Format)";
        if (primaryProduction[formatKey]) {
          primaryProduction[formatKey][period.label] += 1;
          primaryViews[formatKey][period.label] += views;
          primaryClicks[formatKey][period.label] += clicks;
          primaryLeads[formatKey][period.label] += leads;
        }
      } else {
        const rowKey = itemToRowKey.get(item.id);
        const label = rowKey ? primaryRowMetaByKey.get(rowKey)?.label : null;
        if (label && primaryProduction[label]) {
          primaryProduction[label][period.label] += 1;
          primaryViews[label][period.label] += views;
          primaryClicks[label][period.label] += clicks;
          primaryLeads[label][period.label] += leads;
        }
      }

      const fKey = item.format || "(No Format)";
      if (formatProduction[fKey]) {
        formatProduction[fKey][period.label] += 1;
        formatViews[fKey][period.label] += views;
        formatLeads[fKey][period.label] += leads;
      }
    });

    // Views per post
    const calcViewsPerPost = (production: MetricData, views: MetricData): MetricData => {
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

    // Map items
    const mappedItems: ProductionItem[] = items.map((item) => ({
      id: item.id,
      notionId: item.notionId,
      youtubeId: item.youtubeId,
      youtubeUrl: item.youtubeUrl,
      thumbnail: item.thumbnail,
      title: item.title,
      publishedDate: item.publishedDate,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      status: item.status,
      sourceType: item.sourceType as
        | "original"
        | "repost"
        | "cross_post"
        | "repurposed",
      platform: item.platform as string[] | null,
      postType: item.postType ?? null,
      accountId: item.accountId ?? null,
      account: accountByItemId.get(item.id) ?? null,
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
      ctrFirstHour: item.ctrFirstHour ? parseFloat(item.ctrFirstHour) : null,
      apvFirst24Hours: item.apvFirst24Hours ? parseFloat(item.apvFirst24Hours) : null,
      editorEmail: item.editorEmail,
      editorName: item.editorName,
      editorAvatarUrl: null,
      editorUserId: item.editorUserId,
      viewsEstimated: item.viewsEstimated ?? false,
      lastPerformanceSyncAt: item.lastPerformanceSyncAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    }));

    const data: ContentReportData = {
      periods,
      byPlatform: {
        production: primaryProduction,
        views: primaryViews,
        clicks: primaryClicks,
        leads: primaryLeads,
        viewsPerPost: primaryViewsPerPost,
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
      weeklyViewsGoal,
      primaryRowMeta,
      provenSummary,
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error("Error fetching MATG report:", error);
    return NextResponse.json(
      { error: "Failed to fetch MATG report" },
      { status: 500 }
    );
  }
}
