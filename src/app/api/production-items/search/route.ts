import { NextRequest, NextResponse } from "next/server";
import { and, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";
import { extractContentIdFromUrl } from "@/lib/platform-url";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_RE = /^\d{6,}$/;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const brand = params.get("brand");
  const q = (params.get("q") || "").trim();
  const excludeId = params.get("excludeId");
  const includeAll = params.get("includeAll") === "1";

  if (!brand) {
    return NextResponse.json({ error: "brand is required" }, { status: 400 });
  }

  const conditions = [
    eq(productionItems.brand, brand),
    isNull(productionItems.deletedAt),
  ];
  // The Pillar picker needs items that can plausibly be a *parent* — i.e.
  // anything not already a derivative. Until 2026-05-06 this was gated
  // by `notionId IS NOT NULL`, which dated back to the era when every
  // pillar was Notion-synced. Account-content-sync, manual uploads, and
  // YouTube downloads now produce legitimate pillar candidates without
  // notion_ids; the old gate hid them. Source-type is the canonical
  // "is this a derivative" field — drop the Notion gate, exclude only
  // clip/repost/cross_post.
  if (!includeAll) {
    conditions.push(
      or(
        isNull(productionItems.sourceType),
        eq(productionItems.sourceType, "original"),
      )!,
    );
  }
  if (excludeId) conditions.push(ne(productionItems.id, excludeId));

  // Recognize ID-shaped pastes so the picker resolves them directly instead
  // of treating them as title text. Order: UUID (our row id) > URL (any
  // platform's published link) > bare numeric (X/TikTok/LinkedIn content id).
  // Falls through to multi-field ILIKE for free-text queries — title was
  // the only matched column until 2026-05-06, which made phrases like
  // "how i work" miss pillars whose title was different but whose hook
  // / description matched.
  if (q) {
    const urlMatch = extractContentIdFromUrl(q);
    if (UUID_RE.test(q)) {
      conditions.push(eq(productionItems.id, q));
    } else if (urlMatch) {
      conditions.push(
        or(
          eq(productionItems.platformContentId, urlMatch.contentId),
          ilike(productionItems.publishedLink, `%${urlMatch.contentId}%`),
        )!,
      );
    } else if (NUMERIC_ID_RE.test(q)) {
      conditions.push(
        or(
          eq(productionItems.platformContentId, q),
          ilike(productionItems.publishedLink, `%${q}%`),
        )!,
      );
    } else {
      const pattern = `%${q}%`;
      conditions.push(
        or(
          ilike(productionItems.title, pattern),
          ilike(productionItems.hook, pattern),
          ilike(productionItems.overlay, pattern),
          ilike(productionItems.description, pattern),
          ilike(productionItems.contentBody, pattern),
        )!,
      );
    }
  }

  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      status: productionItems.status,
      notionId: productionItems.notionId,
      publishedDate: productionItems.publishedDate,
      views: productionItems.views,
      sourceType: productionItems.sourceType,
      postType: productionItems.postType,
      platform: productionItems.platform,
      accountId: accounts.id,
      accountPlatform: accounts.platform,
      accountHandle: accounts.handle,
      accountDisplayName: accounts.displayName,
      accountAvatarUrl: accounts.avatarUrl,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(and(...conditions))
    // Heavy-hitter pillars (the ones operators reach for daily) first;
    // recency tiebreaks for items at the same view count. NULLS LAST so
    // unpublished/non-views rows don't pollute the top of the list.
    .orderBy(
      sql`${productionItems.views} DESC NULLS LAST`,
      sql`${productionItems.publishedDate} DESC NULLS LAST`,
    )
    .limit(25);

  // Reshape so the picker gets a nested `account` object (matches the
  // `AccountBadge` prop shape) without re-mapping client-side.
  const items = rows.map((r) => ({
    id: r.id,
    title: r.title,
    format: r.format,
    status: r.status,
    notionId: r.notionId,
    publishedDate: r.publishedDate,
    views: r.views,
    sourceType: r.sourceType,
    postType: r.postType,
    platform: r.platform,
    account:
      r.accountId && r.accountPlatform && r.accountHandle
        ? {
            id: r.accountId,
            platform: r.accountPlatform,
            handle: r.accountHandle,
            displayName: r.accountDisplayName,
            avatarUrl: r.accountAvatarUrl,
          }
        : null,
  }));

  return NextResponse.json({ items });
}
