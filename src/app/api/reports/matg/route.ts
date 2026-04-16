import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { productionItems, formats } from "@/lib/db/schema";
import { and, eq, gte, lte, isNotNull, sql } from "drizzle-orm";
import { buildPeriods, findPeriod, getWeekProgress } from "@/lib/utils/dates";
import { getWeeklyGoal } from "@/lib/db/queries";
import { format, subDays } from "date-fns";
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
  const defaultEnd = format(today, "yyyy-MM-dd");

  const startDate = searchParams.get("startDate") || defaultStart;
  const endDate = searchParams.get("endDate") || defaultEnd;
  const viewType = (searchParams.get("viewType") || "weekly") as "weekly" | "daily";
  const platformFilter = searchParams.get("platform") || "all";
  const formatFilter = searchParams.get("format") || "all";
  const sourceFilter = searchParams.get("source") || "all";

  try {
    // Build periods
    const periods = buildPeriods(
      new Date(startDate + "T00:00:00"),
      new Date(endDate + "T00:00:00"),
      viewType
    );

    // Build query conditions — MATG brand, has published date
    const conditions = [
      eq(productionItems.brand, "matg"),
      isNotNull(productionItems.publishedDate),
      gte(productionItems.publishedDate, startDate),
      lte(productionItems.publishedDate, endDate),
    ];

    if (platformFilter !== "all") {
      conditions.push(
        sql`${productionItems.platform}::jsonb @> ${JSON.stringify([platformFilter])}::jsonb`
      );
    }

    if (formatFilter !== "all") {
      conditions.push(eq(productionItems.format, formatFilter));
    }

    if (sourceFilter === "internal") {
      conditions.push(eq(productionItems.isExternal, false));
    } else if (sourceFilter === "external") {
      conditions.push(eq(productionItems.isExternal, true));
    }

    const items = await db
      .select()
      .from(productionItems)
      .where(and(...conditions));

    // Always show all MATG platforms, even those with 0 output
    const MATG_PLATFORMS = [
      "YouTube",
      "YouTube Shorts",
      "Instagram Reel",
      "Instagram Post",
      "Twitter",
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

    // Determine if we show formats in primary table
    const showingFormats = platformFilter !== "all" && formatFilter === "all";

    let primaryRows: string[];
    if (showingFormats) {
      primaryRows = [...formatList];
      if (items.some((i) => !i.format)) primaryRows.push("(No Format)");
    } else {
      primaryRows = platformList;
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
    const primaryLeads = initMetricData(primaryRows);
    const primarySales = initMetricData(primaryRows);

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
      const leads = item.leads || 0;
      const sales = item.salesAmount ? parseFloat(item.salesAmount) : 0;

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

    const weeklyGoal = await getWeeklyGoal("matg");

    // Map items
    const mappedItems: ProductionItem[] = items.map((item) => ({
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
      apvFirst24Hours: item.apvFirst24Hours ? parseFloat(item.apvFirst24Hours) : null,
      producerEmail: item.producerEmail,
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
      weekProgress: getWeekProgress(),
      platforms: platformList,
      formats: formatList,
      showingFormats,
      weeklyGoal,
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
