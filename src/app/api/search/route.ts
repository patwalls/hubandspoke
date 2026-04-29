import { NextRequest, NextResponse } from "next/server";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, formatChannels, formats, productionItems } from "@/lib/db/schema";
import { extractContentIdFromUrl, looseUrlKey } from "@/lib/platform-url";
import { getStatusPalette } from "@/lib/db/brand-statuses";

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

  // If the user pasted a URL, prefer matching against the platform-native
  // content id (indexed, exact) and fall back to a loose substring of the URL
  // for legacy rows whose `platform_content_id` hasn't been backfilled. We
  // skip the title/format text searches in that case — a URL never matches a
  // human-readable name, and showing unrelated text hits would just be noise.
  const urlMatch = extractContentIdFromUrl(q);
  const urlLooseKey = urlMatch ? looseUrlKey(q) : null;

  const contentMatchExpr = urlMatch
    ? or(
        eq(productionItems.platformContentId, urlMatch.contentId),
        urlLooseKey
          ? ilike(productionItems.publishedLink, `%${urlLooseKey}%`)
          : undefined,
        urlLooseKey
          ? ilike(productionItems.youtubeUrl, `%${urlLooseKey}%`)
          : undefined,
      )!
    : ilike(productionItems.title, pattern);

  const [contentRows, formatRows] = await Promise.all([
    db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        format: productionItems.format,
        postType: productionItems.postType,
        status: productionItems.status,
        publishedDate: productionItems.publishedDate,
        views: productionItems.views,
        accountId: accounts.id,
        accountPlatform: accounts.platform,
        accountHandle: accounts.handle,
        accountDisplayName: accounts.displayName,
      })
      .from(productionItems)
      .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
      .where(
        and(
          eq(productionItems.brand, brand),
          isNotNull(productionItems.notionId),
          contentMatchExpr,
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
    urlMatch
      ? Promise.resolve([] as Array<{ id: string; name: string }>)
      : db
          .select({
            id: formats.id,
            name: formats.name,
          })
          .from(formats)
          .where(and(eq(formats.brand, brand), ilike(formats.name, pattern)))
          .orderBy(asc(formats.name))
          .limit(FORMAT_LIMIT),
  ]);

  // Pull format channels for the matched formats so the UI can render
  // AccountBadge pills next to each format hit.
  const formatIds = formatRows.map((f) => f.id);
  const formatChannelRows = formatIds.length
    ? await db
        .select({
          formatId: formatChannels.formatId,
          postType: formatChannels.postType,
          accountId: accounts.id,
          accountPlatform: accounts.platform,
          accountHandle: accounts.handle,
          accountDisplayName: accounts.displayName,
        })
        .from(formatChannels)
        .innerJoin(accounts, eq(accounts.id, formatChannels.accountId))
        .where(inArray(formatChannels.formatId, formatIds))
    : [];

  const channelsByFormatId = new Map<
    string,
    Array<{
      postType: string | null;
      account: {
        id: string;
        platform: string;
        handle: string;
        displayName: string | null;
      };
    }>
  >();
  for (const row of formatChannelRows) {
    const list = channelsByFormatId.get(row.formatId) ?? [];
    list.push({
      postType: row.postType,
      account: {
        id: row.accountId,
        platform: row.accountPlatform,
        handle: row.accountHandle,
        displayName: row.accountDisplayName,
      },
    });
    channelsByFormatId.set(row.formatId, list);
  }

  // Resolve the brand's status palette so each hit can carry its color
  // token; the UI doesn't have to know about the brand_statuses table.
  const palette = await getStatusPalette(brand);

  // Flatten the joined `account` fields into a nested object so the UI can
  // pass it directly to <AccountBadge>.
  const content = contentRows.map((r) => ({
    id: r.id,
    title: r.title,
    format: r.format,
    postType: r.postType,
    status: r.status,
    statusColor: r.status ? palette.get(r.status) ?? null : null,
    publishedDate: r.publishedDate,
    views: r.views,
    account: r.accountId && r.accountPlatform && r.accountHandle
      ? {
          id: r.accountId,
          platform: r.accountPlatform,
          handle: r.accountHandle,
          displayName: r.accountDisplayName,
        }
      : null,
  }));

  const formatsOut = formatRows.map((f) => ({
    id: f.id,
    name: f.name,
    channels: channelsByFormatId.get(f.id) ?? [],
  }));

  return NextResponse.json({ content, formats: formatsOut });
}
