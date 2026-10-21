import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  accounts,
  productionItemMedia,
  productionItems,
  scheduledMatchSuggestions,
} from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";

/**
 * A brand's Ready To Publish items, for the Publish screen
 * (`/[brand]/publish`): everything an editor still has to post somewhere and
 * then paste the live link back for. Oldest-waiting first. Each row carries
 * its post kit (caption to copy, media to download) and, when the hourly
 * publish-live-sweep thinks the post is already live, that suggestion.
 */
export interface ReadyToPublishItem {
  id: string;
  title: string | null;
  hook: string | null;
  postType: string | null;
  sourceType: string;
  accountHandle: string | null;
  readySince: string | null;
  pillarId: string | null;
  pillarTitle: string | null;
  /** The caption to post: the item's own body, else (cross-posts) the
   *  original post's body it was cross-posted from. */
  caption: string | null;
  /** Presigned download links (Content-Disposition: attachment), carousel order. */
  media: Array<{ url: string; filename: string }>;
  liveMatch: {
    suggestionId: string;
    link: string | null;
    publishedAt: string | null;
    excerpt: string | null;
    score: number;
  } | null;
}

const READY_LIMIT = 200;
const DOWNLOAD_TTL_SECONDS = 60 * 60;

function readyWhere(brand: string) {
  return and(
    eq(productionItems.brand, brand),
    eq(productionItems.status, "Ready To Publish"),
    isNull(productionItems.deletedAt),
  );
}

/** The number on the Publish tab. */
export async function countReadyToPublish(brand: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(productionItems)
    .where(readyWhere(brand));
  return Number(row?.n ?? 0);
}

function extFor(key: string, contentType: string | null): string {
  const fromKey = key.split("/").pop()?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromKey) return fromKey.toLowerCase();
  if (contentType?.startsWith("video/")) return "mp4";
  if (contentType === "image/png") return "png";
  return "jpg";
}

export async function getReadyToPublish(brand: string): Promise<ReadyToPublishItem[]> {
  const pillar = alias(productionItems, "pillar");
  const original = alias(productionItems, "original");
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      hook: productionItems.hook,
      postType: productionItems.postType,
      sourceType: productionItems.sourceType,
      accountHandle: accounts.handle,
      updatedAt: productionItems.updatedAt,
      pillarId: productionItems.pillarContentItemId,
      pillarTitle: pillar.title,
      body: productionItems.contentBody,
      originalBody: original.contentBody,
      mediaBucket: productionItems.mediaS3Bucket,
      mediaKey: productionItems.mediaS3Key,
      mediaContentType: productionItems.mediaContentType,
      originalMediaBucket: original.mediaS3Bucket,
      originalMediaKey: original.mediaS3Key,
      originalMediaContentType: original.mediaContentType,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(productionItems.accountId, accounts.id))
    .leftJoin(pillar, eq(productionItems.pillarContentItemId, pillar.id))
    .leftJoin(original, eq(productionItems.repostedFromItemId, original.id))
    .where(readyWhere(brand))
    .orderBy(asc(productionItems.updatedAt))
    .limit(READY_LIMIT);

  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const [mediaRows, matchRows] = await Promise.all([
    db
      .select({
        itemId: productionItemMedia.productionItemId,
        bucket: productionItemMedia.s3Bucket,
        key: productionItemMedia.s3Key,
        contentType: productionItemMedia.contentType,
      })
      .from(productionItemMedia)
      .where(inArray(productionItemMedia.productionItemId, ids))
      .orderBy(asc(productionItemMedia.index)),
    db
      .select({
        suggestionId: scheduledMatchSuggestions.id,
        itemId: scheduledMatchSuggestions.scheduledItemId,
        score: scheduledMatchSuggestions.score,
        link: productionItems.publishedLink,
        publishedAt: productionItems.publishedAt,
        title: productionItems.title,
        body: productionItems.contentBody,
      })
      .from(scheduledMatchSuggestions)
      .innerJoin(
        productionItems,
        eq(scheduledMatchSuggestions.candidateItemId, productionItems.id),
      )
      .where(
        and(
          inArray(scheduledMatchSuggestions.scheduledItemId, ids),
          eq(scheduledMatchSuggestions.status, "pending"),
          eq(productionItems.status, "Published"),
          isNull(productionItems.deletedAt),
        ),
      )
      .orderBy(desc(scheduledMatchSuggestions.score)),
  ]);

  const mediaByItem = new Map<string, typeof mediaRows>();
  for (const m of mediaRows) {
    const list = mediaByItem.get(m.itemId) ?? [];
    list.push(m);
    mediaByItem.set(m.itemId, list);
  }
  const matchByItem = new Map<string, (typeof matchRows)[number]>();
  for (const m of matchRows) {
    if (!matchByItem.has(m.itemId)) matchByItem.set(m.itemId, m);
  }

  return Promise.all(
    rows.map(async (r) => {
      // Carousel/attached media first, then the item's own primary file,
      // then (cross-posts) the original post's file.
      let files: Array<{ bucket: string | null; key: string; contentType: string | null }> =
        mediaByItem.get(r.id) ?? [];
      if (files.length === 0 && r.mediaKey) {
        files = [{ bucket: r.mediaBucket, key: r.mediaKey, contentType: r.mediaContentType }];
      }
      if (files.length === 0 && r.originalMediaKey) {
        files = [
          {
            bucket: r.originalMediaBucket,
            key: r.originalMediaKey,
            contentType: r.originalMediaContentType,
          },
        ];
      }
      // A presign failure (no S3 creds locally) just drops the button.
      const media = (
        await Promise.all(
          files.map(async (f, i) => {
            const filename = `${r.postType ?? "post"}-${r.id.slice(0, 8)}${
              files.length > 1 ? `-${i + 1}` : ""
            }.${extFor(f.key, f.contentType)}`;
            try {
              const url = await getPresignedGetUrl(f.key, DOWNLOAD_TTL_SECONDS, {
                downloadFileName: filename,
                bucket: f.bucket ?? undefined,
              });
              return { url, filename };
            } catch {
              return null;
            }
          }),
        )
      ).filter((m): m is { url: string; filename: string } => m !== null);
      const match = matchByItem.get(r.id);
      return {
        id: r.id,
        title: r.title,
        hook: r.hook,
        postType: r.postType,
        sourceType: r.sourceType,
        accountHandle: r.accountHandle,
        readySince: r.updatedAt ? r.updatedAt.toISOString() : null,
        pillarId: r.pillarId,
        pillarTitle: r.pillarTitle,
        caption: r.body?.trim() || r.originalBody?.trim() || null,
        media,
        liveMatch: match
          ? {
              suggestionId: match.suggestionId,
              link: match.link,
              publishedAt: match.publishedAt ? match.publishedAt.toISOString() : null,
              excerpt: (match.body || match.title || "").trim().slice(0, 140) || null,
              score: match.score,
            }
          : null,
      };
    }),
  );
}
