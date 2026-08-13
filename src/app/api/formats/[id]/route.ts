import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  accounts,
  brands,
  formats,
  productionItems,
} from "@/lib/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getPresignedGetUrl } from "@/lib/s3";
import { buildDescriptCompositionUrl } from "@/lib/descript";
import { getChannelsForFormats } from "@/lib/format-channels";
import {
  computeProvenStatusForBrand,
  staleProvenStatus,
} from "@/lib/services/format-proven";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;

    const [format] = await db
      .select()
      .from(formats)
      .where(eq(formats.id, id))
      .limit(1);

    if (!format) {
      return NextResponse.json({ error: "Format not found" }, { status: 404 });
    }

    const children = await db
      .select()
      .from(formats)
      .where(eq(formats.parentFormatId, id))
      .orderBy(formats.name);

    // Walk up the chain to build an ancestors breadcrumb.
    const ancestors: { id: string; name: string }[] = [];
    let cursor = format.parentFormatId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const [row] = await db
        .select({ id: formats.id, name: formats.name, parentFormatId: formats.parentFormatId })
        .from(formats)
        .where(eq(formats.id, cursor));
      if (!row) break;
      ancestors.unshift({ id: row.id, name: row.name });
      cursor = row.parentFormatId;
    }

    // Pull channels for the format + all children in one query so each row
    // can be enriched without an N+1.
    const formatIdsForChannels = [format.id, ...children.map((c) => c.id)];
    const channelsByFormat = await getChannelsForFormats(formatIdsForChannels);

    const allItems = await db
      .select()
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, format.brand),
          eq(productionItems.format, format.name)
        )
      )
      .orderBy(desc(productionItems.views));

    // Killed ideas don't belong in the format's content roster — they're dead
    // weight in the table and skew perceptions of format performance.
    const items = allItems.filter((i) => i.status !== "Killed");

    const publishedItems = items.filter(
      (i) => i.status === "Published" && i.publishedDate
    );
    const totalPosts = publishedItems.length;
    const totalViews = publishedItems.reduce((sum, i) => sum + (i.views || 0), 0);
    const itemsWithViews = publishedItems.filter((i) => (i.views || 0) > 0);
    const avgViews = itemsWithViews.length
      ? Math.round(totalViews / itemsWithViews.length)
      : 0;

    let lastPublished: string | null = null;
    publishedItems.forEach((i) => {
      if (i.publishedDate && (!lastPublished || i.publishedDate > lastPublished)) {
        lastPublished = i.publishedDate;
      }
    });

    // Resolve account_id → account so the items table can render an
    // AccountBadge instead of the legacy `platform` string list.
    const itemAccountIds = Array.from(
      new Set(items.map((i) => i.accountId).filter((x): x is string => Boolean(x)))
    );
    const accountById = new Map<
      string,
      { id: string; platform: string; handle: string; displayName: string | null; brandSlug: string; brandLabel: string }
    >();
    if (itemAccountIds.length) {
      const accountRows = await db
        .select({
          id: accounts.id,
          platform: accounts.platform,
          handle: accounts.handle,
          displayName: accounts.displayName,
          brandSlug: brands.slug,
          brandLabel: brands.label,
        })
        .from(accounts)
        .innerJoin(brands, eq(brands.id, accounts.brandId))
        .where(inArray(accounts.id, itemAccountIds))
        .orderBy(asc(accounts.handle));
      for (const a of accountRows) accountById.set(a.id, a);
    }

    // Presign archived S3 objects so the items table can fall back to a durable
    // cover when the upstream `thumbnail` CDN URL has expired.
    const keys = new Set<string>();
    for (const i of items) {
      if (i.posterS3Key) keys.add(i.posterS3Key);
      if (i.mediaS3Key) keys.add(i.mediaS3Key);
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

    // descriptPack used to be inlined here; the table was folded into
    // formats.instructions (Skill) on 2026-05-11. No back-compat field —
    // the only client was the format-detail page and it stopped reading
    // the field in the same release.

    const provenByName = await computeProvenStatusForBrand(format.brand);
    const formatProvenStatus =
      provenByName.get(format.name) ?? staleProvenStatus();

    return NextResponse.json({
      format: {
        ...format,
        accountChannels: channelsByFormat.get(format.id) ?? [],
        proven: formatProvenStatus.isProven,
        provenStatus: formatProvenStatus,
      },
      children: children.map((c) => ({
        ...c,
        accountChannels: channelsByFormat.get(c.id) ?? [],
      })),
      ancestors,
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        platform: i.platform,
        publishedDate: i.publishedDate,
        publishedLink: i.publishedLink,
        thumbnail: i.thumbnail,
        posterUrl: i.posterS3Key ? urlByKey.get(i.posterS3Key) ?? null : null,
        mediaUrl: i.mediaS3Key ? urlByKey.get(i.mediaS3Key) ?? null : null,
        mediaContentType: i.mediaContentType,
        views: i.views,
        likes: i.likes,
        comments: i.comments,
        leads: i.leads,
        status: i.status,
        viewsEstimated: i.viewsEstimated ?? false,
        descriptProjectUrl: i.descriptProjectUrl,
        descriptCompositionUrl:
          i.descriptProjectId && i.descriptCompositionId
            ? buildDescriptCompositionUrl(i.descriptProjectId, i.descriptCompositionId)
            : null,
        accountId: i.accountId,
        postType: i.postType,
        account: i.accountId ? accountById.get(i.accountId) ?? null : null,
      })),
      metrics: {
        totalPosts,
        totalViews,
        avgViews,
        lastPublished,
      },
    });
  } catch (error) {
    console.error("Error fetching format detail:", error);
    return NextResponse.json(
      { error: "Failed to fetch format" },
      { status: 500 }
    );
  }
}
