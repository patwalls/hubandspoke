// Resolve the ORIGINAL clean media for an item by walking its lineage.
//
// Why: reposting/cross-posting a TikTok item bakes in the TikTok watermark,
// because the source's media was DOWNLOADED from TikTok (the enricher falls
// back to the watermarked `play_addr`). Our own Descript exports / manual
// uploads are clean. This resolver walks back through repost/cross-post and
// pillar lineage to find the nearest ALREADY-SAVED clean media so we seed /
// surface that instead of the watermarked download.
//
// Deliberately archived-media-only: if no clean media is already saved, we
// return `none` (the feature is simply absent). We never kick off a Descript
// render — per product decision, that media should already exist.

import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, productionItemMedia } from "@/lib/db/schema";
import { DESCRIPT_EXPORT_URL_PREFIX } from "@/lib/descript";

const MAX_DEPTH = 8;

export type MediaCleanliness =
  | "manual" // user upload — no sourceUrl
  | "descript" // our Descript/editor export
  | "platform_clean" // downloaded from a non-watermarking platform (IG/YT)
  | "tiktok_dirty"; // downloaded from TikTok — watermark risk

/**
 * Classify a `production_item_media.sourceUrl`. TikTok is the only platform
 * that watermarks, so it's the only "dirty" source; everything else is usable.
 */
export function classifyMediaSource(
  sourceUrl: string | null | undefined,
): MediaCleanliness {
  if (!sourceUrl) return "manual";
  if (sourceUrl.startsWith(DESCRIPT_EXPORT_URL_PREFIX)) return "descript";
  if (/tiktokcdn|tiktok\.com|musical\.ly/i.test(sourceUrl)) return "tiktok_dirty";
  return "platform_clean";
}

/** True when the media is safe to repost (not a watermarked TikTok download). */
function isCleanRow(kind: string, sourceUrl: string | null): boolean {
  // Only videos carry the TikTok watermark; image rows are always fine.
  if (kind !== "video") return true;
  return classifyMediaSource(sourceUrl) !== "tiktok_dirty";
}

export interface CleanMediaRow {
  index: number;
  kind: string;
  s3Bucket: string;
  s3Key: string;
  contentType: string;
  sizeBytes: number | null;
  posterS3Key: string | null;
  sourceUrl: string | null;
}

export interface CleanMediaOrigin {
  itemId: string;
  title: string | null;
  depth: number; // 0 = the item itself, 1 = its source, …
}

export type CleanMediaResolution =
  | {
      kind: "archived";
      rows: CleanMediaRow[];
      origin: CleanMediaOrigin;
      /** Human label for the UI, e.g. `Descript export from "…"`. */
      label: string;
    }
  | { kind: "none"; reason: string };

interface ChainNode {
  id: string;
  title: string | null;
  sourceType: string | null;
  repostedFromItemId: string | null;
  pillarContentItemId: string | null;
}

/** Walk the lineage nearest→origin. Prefers the repost/cross-post source
 *  (same literal content) over the pillar (format tree). Cycle- and
 *  depth-bounded. */
async function loadLineageChain(itemId: string): Promise<ChainNode[]> {
  const chain: ChainNode[] = [];
  const seen = new Set<string>();
  let currentId: string | null = itemId;
  while (currentId && !seen.has(currentId) && chain.length < MAX_DEPTH) {
    seen.add(currentId);
    const [node] = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        sourceType: productionItems.sourceType,
        repostedFromItemId: productionItems.repostedFromItemId,
        pillarContentItemId: productionItems.pillarContentItemId,
      })
      .from(productionItems)
      .where(eq(productionItems.id, currentId))
      .limit(1);
    if (!node) break;
    chain.push(node);
    if (node.sourceType === "original") break; // reached the root
    currentId = node.repostedFromItemId ?? node.pillarContentItemId ?? null;
  }
  return chain;
}

function labelFor(rows: CleanMediaRow[], node: ChainNode): string {
  const hasDescript = rows.some(
    (r) => classifyMediaSource(r.sourceUrl) === "descript",
  );
  const hasManual = rows.some((r) => !r.sourceUrl);
  const title = node.title ?? "source";
  if (hasDescript) return `Descript export from "${title}"`;
  if (hasManual) return `Original upload on "${title}"`;
  return `Original media from "${title}"`;
}

/**
 * Find the nearest already-saved clean media up the item's lineage. Returns
 * the rows to copy/download plus where they came from, or `none`.
 */
export async function resolveCleanSourceMedia(
  itemId: string,
): Promise<CleanMediaResolution> {
  const chain = await loadLineageChain(itemId);
  if (chain.length === 0) {
    return { kind: "none", reason: "Item not found." };
  }

  // One batched media load for the whole chain, grouped by item.
  const allMedia = await db
    .select({
      productionItemId: productionItemMedia.productionItemId,
      index: productionItemMedia.index,
      kind: productionItemMedia.kind,
      s3Bucket: productionItemMedia.s3Bucket,
      s3Key: productionItemMedia.s3Key,
      contentType: productionItemMedia.contentType,
      sizeBytes: productionItemMedia.sizeBytes,
      posterS3Key: productionItemMedia.posterS3Key,
      sourceUrl: productionItemMedia.sourceUrl,
    })
    .from(productionItemMedia)
    .where(
      inArray(
        productionItemMedia.productionItemId,
        chain.map((c) => c.id),
      ),
    )
    .orderBy(asc(productionItemMedia.index));

  const byItem = new Map<string, CleanMediaRow[]>();
  for (const m of allMedia) {
    const list = byItem.get(m.productionItemId) ?? [];
    list.push(m);
    byItem.set(m.productionItemId, list);
  }

  // Nearest node whose media is entirely clean (no watermarked video) wins.
  for (let depth = 0; depth < chain.length; depth++) {
    const node = chain[depth];
    const rows = byItem.get(node.id);
    if (!rows || rows.length === 0) continue;
    const allClean = rows.every((r) => isCleanRow(r.kind, r.sourceUrl));
    if (!allClean) continue; // this node's video is a TikTok download — keep walking
    return {
      kind: "archived",
      rows,
      origin: { itemId: node.id, title: node.title, depth },
      label: labelFor(rows, node),
    };
  }

  return {
    kind: "none",
    reason:
      "No clean original media found — this item has no saved Descript export or uploaded source to fall back to.",
  };
}
