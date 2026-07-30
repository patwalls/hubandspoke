import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { productionItems, accounts, brands } from "@/lib/db/schema";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { ProductionItem } from "@/types";

export interface DuplicateItem extends ProductionItem {
  /** Non-null + not starting with "sync:" → created inside Hub & Spoke. */
  createdVia: string | null;
  /** Manual operator override marking this item as H&S-origin even if synced. */
  hubSpokeOverride: boolean | null;
  /** Count of internal Hub & Spoke comments on this item. */
  commentCount: number;
}

export interface DuplicateGroup {
  key: string;
  keyType: "publishedLink" | "platformContentId";
  items: DuplicateItem[];
}

function shapeItem(r: {
  item: typeof productionItems.$inferSelect;
  accountId: string | null;
  accountPlatform: string | null;
  accountHandle: string | null;
  accountDisplayName: string | null;
  accountAvatarUrl: string | null;
  accountBrandSlug: string | null;
  accountBrandLabel: string | null;
  commentCount: number;
}): DuplicateItem {
  const account = r.accountId
    ? {
        id: r.accountId,
        platform: r.accountPlatform!,
        handle: r.accountHandle!,
        displayName: r.accountDisplayName,
        avatarUrl: r.accountAvatarUrl ?? null,
        brandSlug: r.accountBrandSlug!,
        brandLabel: r.accountBrandLabel!,
      }
    : null;
  const item = r.item;
  return {
    id: item.id,
    notionId: item.notionId,
    youtubeId: item.youtubeId,
    youtubeUrl: item.youtubeUrl,
    thumbnail: item.thumbnail,
    title: item.title,
    publishedDate: item.publishedDate,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    status: item.status,
    platform: item.platform as string[] | null,
    postType: item.postType ?? null,
    accountId: item.accountId ?? null,
    account,
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
    hubspotLeads: item.hubspotLeads,
    ctrFirstHour: item.ctrFirstHour ? parseFloat(item.ctrFirstHour) : null,
    apvFirst24Hours: item.apvFirst24Hours
      ? parseFloat(item.apvFirst24Hours)
      : null,
    editorEmail: item.editorEmail,
    editorName: item.editorName,
    editorAvatarUrl: null,
    editorUserId: item.editorUserId,
    viewsEstimated: item.viewsEstimated ?? false,
    lastPerformanceSyncAt: item.lastPerformanceSyncAt?.toISOString() ?? null,
    sourceType: item.sourceType as
      | "original"
      | "repost"
      | "cross_post"
      | "repurposed",
    sourceClipIdeaId: item.sourceClipIdeaId,
    clipEstimatedViews: null,
    clipAlgorithmLabel: null,
    repostedFromItemId: item.repostedFromItemId,
    pillarContentItemId: item.pillarContentItemId,
    pillarContentTitle: null,
    pillarPublishedDate: null,
    posterS3Key: item.posterS3Key,
    mediaS3Key: item.mediaS3Key,
    mediaContentType: item.mediaContentType,
    predictedViewsSnapshot: item.predictedViewsSnapshot,
    predictedViewsSnapshotAt:
      item.predictedViewsSnapshotAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    // Duplicate-view extras
    createdVia: item.createdVia,
    hubSpokeOverride: item.hubSpokeOverride,
    commentCount: r.commentCount,
  };
}

export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!brand) {
    return NextResponse.json({ error: "brand required" }, { status: 400 });
  }

  const sel = {
    item: productionItems,
    accountId: accounts.id,
    accountPlatform: accounts.platform,
    accountHandle: accounts.handle,
    accountDisplayName: accounts.displayName,
    accountAvatarUrl: accounts.avatarUrl,
    accountBrandSlug: brands.slug,
    accountBrandLabel: brands.label,
    commentCount: sql<number>`(
      SELECT COUNT(*) FROM content_comments
      WHERE content_item_id = ${productionItems.id}
    )`,
  };

  const baseWhere = and(
    eq(productionItems.brand, brand),
    isNull(productionItems.deletedAt)
  );

  // Items sharing a publishedLink with another non-deleted item on this brand
  const byLinkRows = await db
    .select(sel)
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .leftJoin(brands, eq(brands.id, accounts.brandId))
    .where(
      and(
        baseWhere,
        isNotNull(productionItems.publishedLink),
        sql`${productionItems.publishedLink} IN (
          SELECT published_link FROM production_items
          WHERE brand = ${brand} AND deleted_at IS NULL AND published_link IS NOT NULL
          GROUP BY published_link HAVING COUNT(*) > 1
        )`
      )
    );

  // Items sharing a platformContentId — exclude any already captured by the
  // publishedLink pass above so groups don't overlap.
  const linkItemIds = new Set(byLinkRows.map((r) => r.item.id));
  const byContentIdRows = await db
    .select(sel)
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .leftJoin(brands, eq(brands.id, accounts.brandId))
    .where(
      and(
        baseWhere,
        isNotNull(productionItems.platformContentId),
        sql`${productionItems.platformContentId} IN (
          SELECT platform_content_id FROM production_items
          WHERE brand = ${brand} AND deleted_at IS NULL AND platform_content_id IS NOT NULL
          GROUP BY platform_content_id HAVING COUNT(*) > 1
        )`
      )
    );

  // Group by link
  const linkGroups = new Map<string, DuplicateItem[]>();
  for (const r of byLinkRows) {
    const key = r.item.publishedLink!;
    if (!linkGroups.has(key)) linkGroups.set(key, []);
    linkGroups.get(key)!.push(shapeItem(r));
  }

  // Group by platformContentId — skip items already in a link group
  const contentIdGroups = new Map<string, DuplicateItem[]>();
  for (const r of byContentIdRows) {
    if (linkItemIds.has(r.item.id)) continue;
    const key = r.item.platformContentId!;
    if (!contentIdGroups.has(key)) contentIdGroups.set(key, []);
    contentIdGroups.get(key)!.push(shapeItem(r));
  }

  const groups: DuplicateGroup[] = [
    ...Array.from(linkGroups.entries()).map(([key, items]) => ({
      key,
      keyType: "publishedLink" as const,
      items,
    })),
    ...Array.from(contentIdGroups.entries()).map(([key, items]) => ({
      key,
      keyType: "platformContentId" as const,
      items,
    })),
  ];

  return NextResponse.json({ groups });
}
