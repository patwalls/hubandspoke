import { Client } from "@notionhq/client";
import { db } from "@/lib/db";
import { productionItems, syncLogs, users } from "@/lib/db/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { isNotionAuthoritative } from "@/lib/platform";
import { resolveAssignees } from "@/lib/services/assignees";

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

// Browsers outside Safari can't render HEIC/HEIF; Notion happily serves them
// as the raw S3 URL if a user uploaded one. Null them out so the UI falls back
// to initials instead of a broken image icon.
function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const lower = url.toLowerCase().split("?")[0];
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return null;
  return url;
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
    avatarUrl: safeAvatarUrl(p?.avatar_url),
  };
}

type NotionPerson = {
  email: string | null;
  userId: string | null;
  name: string | null;
  avatarUrl: string | null;
};

type PersonRow = {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  notionUserId: string | null;
};

function collectPerson(
  bucket: Map<string, PersonRow>,
  p: NotionPerson
): void {
  if (!p.email) return;
  const email = p.email.toLowerCase().trim();
  if (!email) return;
  // Last write wins for name/avatar — the full-sync pass sees every page, so
  // later entries for the same email tend to be just as good as earlier ones.
  bucket.set(email, {
    email,
    name: p.name,
    avatarUrl: p.avatarUrl,
    notionUserId: p.userId,
  });
}

async function flushUserUpserts(
  bucket: Map<string, PersonRow>
): Promise<number> {
  const rows = [...bucket.values()];
  if (rows.length === 0) return 0;
  // Single INSERT ... ON CONFLICT for all collected people. notion_user_id is
  // only set when NULL so a later row claiming a different notion_user_id for
  // the same email doesn't collide with the table's UNIQUE(notion_user_id).
  await db
    .insert(users)
    .values(rows)
    .onConflictDoUpdate({
      target: users.email,
      set: {
        name: sql`COALESCE(${users.name}, EXCLUDED.name)`,
        avatarUrl: sql`EXCLUDED.avatar_url`,
        notionUserId: sql`COALESCE(${users.notionUserId}, EXCLUDED.notion_user_id)`,
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
    const peopleBucket = new Map<string, PersonRow>();

    // Cache email → users.id lookups for this sync so each unique producer/editor
    // email hits the DB at most once. Populated lazily in resolveAssigneeFromEmail.
    const emailUserCache = new Map<string, string | null>();
    async function resolveAssigneeFromEmail(
      email: string | null
    ): Promise<string | null> {
      if (!email) return null;
      const key = email.toLowerCase();
      if (emailUserCache.has(key)) return emailUserCache.get(key) ?? null;
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${key}`)
        .limit(1);
      const id = row?.id ?? null;
      emailUserCache.set(key, id);
      return id;
    }

    // Process each item
    for (const item of allResults) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const properties = (item as any).properties || {};
      const notionId = item.id;
      // Push every scanned id so the orphan-delete below doesn't nuke rows we
      // *intentionally* skipped (e.g. a Short re-tagged from a long-form YT
      // page still has a real Notion page we just don't want to overwrite
      // H&S from).
      notionIds.push(notionId);

      const platform = extractPlatform(properties);

      // Pages whose platform isn't on the Notion-authoritative allowlist are
      // owned by Hub & Spoke — skip them entirely. Don't overwrite the H&S
      // row, don't upsert the producer/editor directory from their fields.
      // An empty/missing platform is also treated as non-authoritative so
      // unlabeled drafts in Notion can't accidentally clobber H&S state.
      if (!isNotionAuthoritative(platform)) {
        continue;
      }

      const publishedLink = extractPublishedLink(properties);
      const formatName = await extractFormat(properties, notion);

      const producer = extractPerson(properties, "Producer");
      const editor = extractPerson(properties, "Editor/Creator");

      collectPerson(peopleBucket, producer);
      collectPerson(peopleBucket, editor);

      // Fields every sync row writes. Producer/editor are deliberately absent:
      // assignments are app-owned post-insert (see below for INSERT-only seed).
      const commonData = {
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
        // views/likes/comments intentionally NOT written here — Scrape Creators
        // owns those via the performance-decay service. See metric-refresh below.
        clicks: extractNumber(properties, "Clicks"),
        leads: extractNumber(properties, "Leads"),
        salesNum: extractNumber(properties, "Sales Num"),
        salesAmount: extractNumber(properties, "Sales Amount")?.toString() ?? null,
        ctrFirstHour: extractNumber(properties, "CTR (First Hour)")?.toString() ?? null,
        apvFirst24Hours: extractNumber(properties, "APV (First 24 Hours)")?.toString() ?? null,
        pillarContentNotionId: extractPillarContentNotionId(properties),
        updatedAt: new Date(),
      };

      // Upsert
      const existing = await db
        .select()
        .from(productionItems)
        .where(eq(productionItems.notionId, notionId))
        .limit(1);

      if (existing.length > 0) {
        // UPDATE path: skip producer/editor entirely. Hub & Spoke is now the
        // source of truth for assignments — Notion edits to Producer/Editor
        // after first sync are intentionally ignored.
        await db
          .update(productionItems)
          .set(commonData)
          .where(eq(productionItems.notionId, notionId));
        totalUpdated++;
      } else {
        // INSERT path: seed the legacy email/name columns for display, and
        // resolve producer/editor FKs inline — prefer an email match against
        // users, fall through to format/brand/global via resolveAssignees.
        // The email lookup uses an in-memory cache so each unique email hits
        // the DB once per sync.
        const [producerFromEmail, editorFromEmail] = await Promise.all([
          resolveAssigneeFromEmail(producer.email),
          resolveAssigneeFromEmail(editor.email),
        ]);
        let producerUserId = producerFromEmail;
        let editorUserId = editorFromEmail;
        if (!producerUserId || !editorUserId) {
          const resolved = await resolveAssignees({
            brand: "starter-story",
            format: formatName,
          });
          producerUserId = producerUserId ?? resolved.producerUserId;
          editorUserId = editorUserId ?? resolved.editorUserId;
        }
        await db.insert(productionItems).values({
          ...commonData,
          producerEmail: producer.email,
          producerNotionUserId: producer.userId,
          producerName: producer.name,
          editorEmail: editor.email,
          editorNotionUserId: editor.userId,
          editorName: editor.name,
          producerUserId,
          editorUserId,
        });
        totalCreated++;
      }
    }

    // Upsert users directory from the producers/editors we saw.
    await flushUserUpserts(peopleBucket);

    // Delete orphaned records — but ONLY authoritative ones. H&S-owned rows
    // (Shorts, IG, LinkedIn, Newsletter, etc.) with a stale notionId must not
    // be nuked just because their Notion page is gone or was never scanned.
    if (completedFetch && notionIds.length > 0) {
      const deleted = await db
        .delete(productionItems)
        .where(
          and(
            notInArray(productionItems.notionId, notionIds),
            sql`${productionItems.platform} && ARRAY['YouTube', 'YouTube (SS)', 'YouTube (SS Build)']::text[]`
          )
        )
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

    // Publish-hook: if this run created any rows, kick off the unified
    // metrics refresh so a just-published post gets its first views/likes
    // within minutes instead of waiting for the top-of-hour tick. The decay
    // gate skips items that aren't due, so this is cheap when nothing new
    // shipped.
    if (totalCreated > 0) {
      try {
        const { syncPerformanceData } = await import("./performance-decay");
        await syncPerformanceData();
      } catch (hookErr) {
        console.error("[notion-sync] publish-hook refresh failed:", hookErr);
      }
    }

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
