import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, ilike, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, formats, productionItems } from "@/lib/db/schema";

const CONTENT_LIMIT = 12;
const FORMAT_LIMIT = 8;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const brand = params.get("brand");
  const q = (params.get("q") || "").trim();

  if (!brand) {
    return NextResponse.json({ error: "brand is required" }, { status: 400 });
  }

  if (!q) {
    return NextResponse.json({ content: [], formats: [] });
  }

  const pattern = `%${q}%`;

  const [contentRows, formatRows] = await Promise.all([
    db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        format: productionItems.format,
        platform: productionItems.platform,
        postType: productionItems.postType,
        status: productionItems.status,
        publishedDate: productionItems.publishedDate,
        views: productionItems.views,
        accountId: accounts.id,
        accountPlatform: accounts.platform,
        accountHandle: accounts.handle,
      })
      .from(productionItems)
      .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
      .where(
        and(
          eq(productionItems.brand, brand),
          isNotNull(productionItems.notionId),
          ilike(productionItems.title, pattern),
          isNull(productionItems.deletedAt),
        ),
      )
      .orderBy(
        // Rank popular items first; keep a recency tiebreaker so fresh posts
        // with no view count yet still surface above forgotten duds.
        sql`coalesce(${productionItems.views}, 0) desc`,
        desc(productionItems.publishedDate),
      )
      .limit(CONTENT_LIMIT),
    db
      .select({
        id: formats.id,
        name: formats.name,
        channels: formats.channels,
      })
      .from(formats)
      .where(and(eq(formats.brand, brand), ilike(formats.name, pattern)))
      .orderBy(asc(formats.name))
      .limit(FORMAT_LIMIT),
  ]);

  // Flatten the joined `account` fields into a nested object so the UI can
  // pass it directly to <AccountBadge>.
  const content = contentRows.map((r) => ({
    id: r.id,
    title: r.title,
    format: r.format,
    platform: r.platform as string[] | null,
    postType: r.postType,
    status: r.status,
    publishedDate: r.publishedDate,
    views: r.views,
    account: r.accountId && r.accountPlatform && r.accountHandle
      ? {
          id: r.accountId,
          platform: r.accountPlatform,
          handle: r.accountHandle,
          displayName: null,
        }
      : null,
  }));

  return NextResponse.json({ content, formats: formatRows });
}
