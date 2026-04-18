import { Client } from "@notionhq/client";
import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { eq, notInArray, sql } from "drizzle-orm";
import { estimateViewsFromLikes, shouldEstimate } from "./view-estimator";

const DATABASE_ID = "8cb6cee4163d4282a5c87991ea689bde";

const INTERNAL_HANDLES = [
  "thepatwalls",
  "starter_story",
  "starterstory",
  "patrickwalls",
];

const INTERNAL_PLATFORM_KEYWORDS = [
  "(SS)",
  "(SS Build)",
  "(Pat Walls)",
  "Newsletter",
  "SS Case Study",
  "SS Database",
  "Paid Ad",
  "YouTube Community",
  "YouTube Shorts",
  "Instagram Reel",
  "Instagram Post",
  "Instagram Story",
  "TikTok",
  "LinkedIn",
  "Threads",
];

const SOCIAL_MEDIA_DOMAINS = [
  "x.com",
  "twitter.com",
  "tiktok.com",
  "instagram.com",
  "threads.net",
  "threads.com",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "facebook.com",
];

// Cache for format page ID → name lookups
const formatCache = new Map<string, string>();

function getNotionClient() {
  return new Client({ auth: process.env.NOTION_API_SECRET });
}

function detectExternal(
  publishedLink: string | null,
  platform: string[] | null
): boolean {
  const link = (publishedLink || "").trim().toLowerCase();

  if (!link || !link.startsWith("http")) return false;

  // Platform keywords that are always internal
  if (platform?.some((p) => INTERNAL_PLATFORM_KEYWORDS.some((k) => p.includes(k)))) {
    return false;
  }

  // Internal domains
  if (
    link.includes("starterstory.com") ||
    link.includes("klaviyo.com") ||
    link.includes("slack.com")
  ) {
    return false;
  }

  // Internal handles in the URL
  if (INTERNAL_HANDLES.some((handle) => link.includes(handle))) {
    return false;
  }

  // Only external if on a known social media domain
  return SOCIAL_MEDIA_DOMAINS.some((domain) => link.includes(domain));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTitle(properties: any): string | null {
  const titleProp =
    properties["Content"] || properties["Name"] || properties["Title"];
  if (!titleProp) return null;
  const titleArray = titleProp.title || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return titleArray.map((t: any) => t.plain_text).join("") || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPublishDate(properties: any): string | null {
  return properties["Publish Date"]?.date?.start || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractStatus(properties: any): string | null {
  return properties["Status"]?.select?.name || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPlatform(properties: any): string[] | null {
  const channels = properties["Channel"]?.multi_select || [];
  if (channels.length === 0) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return channels.map((c: any) => c.name).filter(Boolean);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUtmCampaign(properties: any): string | null {
  return properties["utm_campaign"]?.rich_text?.[0]?.plain_text || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPublishedLink(properties: any): string | null {
  return properties["Published Link"]?.url || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractNumber(properties: any, field: string): number | null {
  const val = properties[field]?.number;
  return val != null ? val : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractCampaign(properties: any): string | null {
  const prop = properties["Campaign"];
  if (!prop) return null;

  switch (prop.type) {
    case "select":
      return prop.select?.name || null;
    case "multi_select": {
      const selections = prop.multi_select || [];
      if (selections.length === 0) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return selections.map((s: any) => s.name).filter(Boolean).join(", ");
    }
    case "title":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (prop.title || []).map((t: any) => t.plain_text).join("") || null;
    case "rich_text":
      return (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (prop.rich_text || []).map((t: any) => t.plain_text).join("") || null
      );
    case "formula":
      return prop.formula?.string || prop.formula?.number?.toString() || null;
    default:
      return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPillarContentNotionId(properties: any): string | null {
  const rel = properties["Pillar Content"]?.relation;
  if (!Array.isArray(rel) || rel.length === 0) return null;
  return rel[0]?.id || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractProducerEmail(properties: any): string | null {
  const people = properties["Producer"]?.people;
  if (!Array.isArray(people) || people.length === 0) return null;
  return people[0]?.person?.email || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractProducerUserId(properties: any): string | null {
  const people = properties["Producer"]?.people;
  if (!Array.isArray(people) || people.length === 0) return null;
  return people[0]?.id || null;
}

async function extractFormat(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties: any,
  notion: Client
): Promise<string | null> {
  const relations = properties["Format"]?.relation || [];
  if (relations.length === 0) return null;

  const formatPageId = relations[0].id;

  // Check cache first
  if (formatCache.has(formatPageId)) {
    return formatCache.get(formatPageId)!;
  }

  try {
    const page = await notion.pages.retrieve({ page_id: formatPageId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pageProps = (page as any).properties || {};
    const titleProp = pageProps["Name"] || pageProps["Title"];
    if (!titleProp) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const name = (titleProp.title || []).map((t: any) => t.plain_text).join("");
    if (name) formatCache.set(formatPageId, name);
    return name || null;
  } catch (e) {
    console.error(`Error fetching format page ${formatPageId}:`, e);
    return null;
  }
}

export async function syncFromNotion(): Promise<{
  success: boolean;
  totalFetched: number;
  totalCreated: number;
  totalUpdated: number;
  totalDeleted: number;
  error?: string;
}> {
  const notion = getNotionClient();
  let totalFetched = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;

  // Create sync log
  const [logEntry] = await db
    .insert(syncLogs)
    .values({ syncType: "notion_full", status: "running" })
    .returning();

  try {
    // Fetch all items from Notion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allResults: any[] = [];
    let hasMore = true;
    let nextCursor: string | undefined;
    let pageCount = 0;
    const maxPages = 50;
    let completedFetch = true;

    while (hasMore && pageCount < maxPages) {
      pageCount++;
      const response = await notion.databases.query({
        database_id: DATABASE_ID,
        page_size: 100,
        start_cursor: nextCursor,
      });

      allResults.push(...response.results);
      hasMore = response.has_more;
      nextCursor = response.next_cursor ?? undefined;
    }

    if (hasMore) completedFetch = false;
    totalFetched = allResults.length;

    const notionIds: string[] = [];

    // Process each item
    for (const item of allResults) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const properties = (item as any).properties || {};
      const notionId = item.id;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const notionLastEdited = (item as any).last_edited_time
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? new Date((item as any).last_edited_time)
        : null;
      notionIds.push(notionId);

      const platform = extractPlatform(properties);
      const publishedLink = extractPublishedLink(properties);
      const formatName = await extractFormat(properties, notion);

      const notionViews = extractNumber(properties, "Views");
      const notionLikes = extractNumber(properties, "Likes");
      const notionComments = extractNumber(properties, "Comments");

      // Apply view estimation for platforms that don't return real view counts.
      // Only estimates if: platform needs it, likes > 0, and views aren't already real (API-sourced).
      let finalViews = notionViews;
      let viewsEstimated = false;
      if (platform && shouldEstimate(platform) && notionLikes && notionLikes > 0 && !notionViews) {
        const estimation = estimateViewsFromLikes(platform, notionLikes);
        if (estimation.estimated) {
          finalViews = estimation.views;
          viewsEstimated = true;
        }
      }

      const data = {
        notionId,
        title: extractTitle(properties),
        publishedDate: extractPublishDate(properties),
        status: extractStatus(properties),
        platform,
        format: formatName,
        campaign: extractCampaign(properties),
        utmCampaign: extractUtmCampaign(properties),
        publishedLink,
        isExternal: detectExternal(publishedLink, platform),
        views: finalViews,
        likes: notionLikes,
        comments: notionComments,
        clicks: extractNumber(properties, "Clicks"),
        leads: extractNumber(properties, "Leads"),
        salesNum: extractNumber(properties, "Sales Num"),
        salesAmount: extractNumber(properties, "Sales Amount")?.toString() ?? null,
        ctrFirstHour: extractNumber(properties, "CTR (First Hour)")?.toString() ?? null,
        apvFirst24Hours: extractNumber(properties, "APV (First 24 Hours)")?.toString() ?? null,
        producerEmail: extractProducerEmail(properties),
        producerNotionUserId: extractProducerUserId(properties),
        pillarContentNotionId: extractPillarContentNotionId(properties),
        viewsEstimated,
        updatedAt: new Date(),
      };

      // Upsert
      const existing = await db
        .select()
        .from(productionItems)
        .where(eq(productionItems.notionId, notionId))
        .limit(1);

      if (existing.length > 0) {
        const existingItem = existing[0];

        // Preserve API-sourced metrics (Scrape Creators) if they're fresher than Notion data.
        // If lastPerformanceSyncAt is set and is newer than Notion's last edit,
        // the API data is more accurate — don't overwrite views/likes/comments.
        if (
          existingItem.lastPerformanceSyncAt &&
          notionLastEdited &&
          existingItem.lastPerformanceSyncAt > notionLastEdited
        ) {
          // Skip overwriting performance metrics — API data is fresher
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { views, likes, comments, viewsEstimated: _ve, ...dataWithoutMetrics } = data;
          await db
            .update(productionItems)
            .set(dataWithoutMetrics)
            .where(eq(productionItems.notionId, notionId));
        } else if (existingItem.viewsEstimated && platform && shouldEstimate(platform) && notionLikes && notionLikes > 0) {
          // Re-estimate views as likes may have changed since last sync
          const reEstimation = estimateViewsFromLikes(platform, notionLikes);
          await db
            .update(productionItems)
            .set({ ...data, views: reEstimation.views ?? data.views, viewsEstimated: reEstimation.estimated })
            .where(eq(productionItems.notionId, notionId));
        } else {
          await db
            .update(productionItems)
            .set(data)
            .where(eq(productionItems.notionId, notionId));
        }
        totalUpdated++;
      } else {
        await db.insert(productionItems).values(data);
        totalCreated++;
      }
    }

    // Delete orphaned records
    if (completedFetch && notionIds.length > 0) {
      const deleted = await db
        .delete(productionItems)
        .where(notInArray(productionItems.notionId, notionIds))
        .returning();
      totalDeleted = deleted.length;
    }

    // Resolve pillar_content_item_id from pillar_content_notion_id in a single
    // indexed UPDATE. Done after the main loop so order-of-insert doesn't
    // matter — every derivative and its pillar are both in the table by now.
    await db.execute(sql`
      UPDATE production_items AS derivative
      SET pillar_content_item_id = pillar.id
      FROM production_items AS pillar
      WHERE derivative.pillar_content_notion_id = pillar.notion_id
        AND (
          derivative.pillar_content_item_id IS NULL
          OR derivative.pillar_content_item_id <> pillar.id
        )
    `);
    await db.execute(sql`
      UPDATE production_items
      SET pillar_content_item_id = NULL
      WHERE pillar_content_notion_id IS NULL
        AND pillar_content_item_id IS NOT NULL
    `);

    // Update sync log
    await db
      .update(syncLogs)
      .set({
        status: "completed",
        itemsFetched: totalFetched,
        itemsCreated: totalCreated,
        itemsUpdated: totalUpdated,
        itemsDeleted: totalDeleted,
        completedAt: new Date(),
      })
      .where(eq(syncLogs.id, logEntry.id));

    return {
      success: true,
      totalFetched,
      totalCreated,
      totalUpdated,
      totalDeleted,
    };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "Unknown error";
    await db
      .update(syncLogs)
      .set({
        status: "failed",
        errorMessage,
        completedAt: new Date(),
      })
      .where(eq(syncLogs.id, logEntry.id));

    return {
      success: false,
      totalFetched,
      totalCreated,
      totalUpdated,
      totalDeleted,
      error: errorMessage,
    };
  }
}
