import { Client } from "@notionhq/client";
import { db } from "@/lib/db";
import { productionItems, syncLogs, users } from "@/lib/db/schema";
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
function extractPerson(properties: any, field: string): {
  email: string | null;
  userId: string | null;
  name: string | null;
  avatarUrl: string | null;
} {
  const people = properties[field]?.people;
  if (!Array.isArray(people) || people.length === 0) {
    return { email: null, userId: null, name: null, avatarUrl: null };
  }
  const p = people[0];
  return {
    email: p?.person?.email || null,
    userId: p?.id || null,
    name: p?.name || null,
    avatarUrl: p?.avatar_url || null,
  };
}

type NotionPerson = {
  email: string | null;
  userId: string | null;
  name: string | null;
  avatarUrl: string | null;
};

function collectPerson(
  bucket: Map<string, { email: string; name: string | null; avatarUrl: string | null }>,
  p: NotionPerson
): void {
  if (!p.email) return;
  const email = p.email.toLowerCase().trim();
  if (!email) return;
  // Last write wins for name/avatar — the full-sync pass sees every page, so
  // later entries for the same email tend to be just as good as earlier ones.
  bucket.set(email, { email, name: p.name, avatarUrl: p.avatarUrl });
}

async function flushUserUpserts(
  bucket: Map<string, { email: string; name: string | null; avatarUrl: string | null }>
): Promise<number> {
  const rows = [...bucket.values()];
  if (rows.length === 0) return 0;
  // Single INSERT ... ON CONFLICT for all collected people.
  await db
    .insert(users)
    .values(rows)
    .onConflictDoUpdate({
      target: users.email,
      set: {
        name: sql`COALESCE(${users.name}, EXCLUDED.name)`,
        avatarUrl: sql`EXCLUDED.avatar_url`,
        updatedAt: new Date(),
      },
    });
  return rows.length;
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
    const peopleBucket = new Map<
      string,
      { email: string; name: string | null; avatarUrl: string | null }
    >();

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

      const producer = extractPerson(properties, "Producer");
      const editor = extractPerson(properties, "Editor/Creator");

      collectPerson(peopleBucket, producer);
      collectPerson(peopleBucket, editor);

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
        producerEmail: producer.email,
        producerNotionUserId: producer.userId,
        producerName: producer.name,
        editorEmail: editor.email,
        editorNotionUserId: editor.userId,
        editorName: editor.name,
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

    // Upsert users directory from the producers/editors we saw.
    await flushUserUpserts(peopleBucket);

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
    // Resolve pillar_content_item_id via DISTINCT ON: at most one derivative
    // per (pillar, lower(format)) slot so the uniq_production_items_pillar_format
    // index doesn't reject the whole statement if a duplicate sneaks in. Oldest
    // derivative wins by created_at; duplicates keep their previous value (or
    // NULL) and get surfaced via the log below.
    await db.execute(sql`
      WITH non_null_format AS (
        SELECT DISTINCT ON (pillar.id, lower(derivative.format))
          derivative.id AS deriv_id,
          pillar.id AS pillar_id
        FROM production_items AS derivative
        JOIN production_items AS pillar
          ON derivative.pillar_content_notion_id = pillar.notion_id
        WHERE derivative.format IS NOT NULL
          AND (derivative.pillar_content_item_id IS NULL
               OR derivative.pillar_content_item_id <> pillar.id)
        ORDER BY pillar.id, lower(derivative.format), derivative.created_at, derivative.id
      ),
      null_format AS (
        SELECT derivative.id AS deriv_id, pillar.id AS pillar_id
        FROM production_items AS derivative
        JOIN production_items AS pillar
          ON derivative.pillar_content_notion_id = pillar.notion_id
        WHERE derivative.format IS NULL
          AND (derivative.pillar_content_item_id IS NULL
               OR derivative.pillar_content_item_id <> pillar.id)
      ),
      resolved AS (
        SELECT * FROM non_null_format
        UNION ALL
        SELECT * FROM null_format
      )
      UPDATE production_items AS d
      SET pillar_content_item_id = r.pillar_id
      FROM resolved r
      WHERE d.id = r.deriv_id
    `);

    const unresolvedRows = (await db.execute(sql`
      SELECT count(*)::text AS count
      FROM production_items AS derivative
      JOIN production_items AS pillar
        ON derivative.pillar_content_notion_id = pillar.notion_id
      WHERE derivative.format IS NOT NULL
        AND (derivative.pillar_content_item_id IS NULL
             OR derivative.pillar_content_item_id <> pillar.id)
    `)) as unknown as Array<{ count: string }>;
    const unresolvedCount = Number(unresolvedRows[0]?.count ?? 0);
    if (unresolvedCount > 0) {
      console.warn(
        `[notion-sync] ${unresolvedCount} derivative(s) could not be linked to their pillar — another derivative already occupies that (pillar, format) slot.`
      );
    }
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
