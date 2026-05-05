import { NextRequest, NextResponse } from "next/server";
import { and, eq, ilike, isNotNull, isNull, ne, or, desc } from "drizzle-orm";
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
  if (!includeAll) conditions.push(isNotNull(productionItems.notionId));
  if (excludeId) conditions.push(ne(productionItems.id, excludeId));

  // Recognize ID-shaped pastes so the picker resolves them directly instead
  // of treating them as title text. Order: UUID (our row id) > URL (any
  // platform's published link) > bare numeric (X/TikTok/LinkedIn content id).
  // Falls through to title ILIKE for free-text queries.
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
      conditions.push(ilike(productionItems.title, `%${q}%`));
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
      accountId: accounts.id,
      accountPlatform: accounts.platform,
      accountHandle: accounts.handle,
      accountDisplayName: accounts.displayName,
      accountAvatarUrl: accounts.avatarUrl,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(and(...conditions))
    .orderBy(desc(productionItems.publishedDate))
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
