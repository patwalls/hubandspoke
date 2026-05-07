/**
 * Draft media primitive.
 *
 * Owns "add / remove media rows on a draft." Three call sites today:
 *   - Manual upload route (`/api/production-items/[id]/media`)
 *   - Manual delete route (`/api/production-items/[id]/media/[mediaId]`)
 *   - Future: Instagram / cross-post flows when they get an inline drafting surface
 *
 * NOT a substitute for `archiveCarouselMedia` (used by the enrichment pipeline
 * to ingest from remote URLs) or `seedRepostContent` (mirrors source media on
 * a fresh repost). Those write into the same `production_item_media` table
 * with the same column conventions — that's the single shared schema. This
 * helper is the third write path: bytes-from-the-browser-already-in-S3.
 */
import { and, desc, eq } from "drizzle-orm";
import { productionItemMedia } from "@/lib/db/schema";
import type { db as dbClient } from "@/lib/db";

type Tx = Parameters<Parameters<typeof dbClient.transaction>[0]>[0];

export type ProductionItemMediaRow = typeof productionItemMedia.$inferSelect;

export interface AddDraftMediaInput {
  itemId: string;
  files: Array<{
    s3Bucket: string;
    s3Key: string;
    contentType: string;
    sizeBytes: number;
    kind: "image" | "video";
    posterS3Key?: string | null;
    sourceUrl?: string | null;
  }>;
}

/**
 * Append rows to `production_item_media` for the given item. Computes the
 * next free `index` inside the transaction so concurrent uploads can't
 * collide on the (production_item_id, index) unique constraint.
 *
 * Returns the inserted rows in the same order as `input.files` so callers
 * can match them back to optimistic placeholders.
 */
export async function addMediaRowsToDraft(
  tx: Tx,
  input: AddDraftMediaInput,
): Promise<ProductionItemMediaRow[]> {
  if (input.files.length === 0) return [];

  const [highest] = await tx
    .select({ index: productionItemMedia.index })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, input.itemId))
    .orderBy(desc(productionItemMedia.index))
    .limit(1);
  const startIndex = (highest?.index ?? -1) + 1;

  const rows = input.files.map((f, i) => ({
    productionItemId: input.itemId,
    index: startIndex + i,
    kind: f.kind,
    s3Bucket: f.s3Bucket,
    s3Key: f.s3Key,
    contentType: f.contentType,
    sizeBytes: f.sizeBytes,
    posterS3Key: f.posterS3Key ?? null,
    sourceUrl: f.sourceUrl ?? null,
  }));

  return await tx.insert(productionItemMedia).values(rows).returning();
}

/**
 * Delete one row. Returns the deleted row (or null if not found / not
 * owned by the given item). The same `s3_key` may be referenced by other
 * items (reposts share keys), so we never delete the S3 object here —
 * orphan cleanup is a separate concern.
 */
export async function removeMediaRowFromDraft(
  tx: Tx,
  { itemId, mediaId }: { itemId: string; mediaId: string },
): Promise<ProductionItemMediaRow | null> {
  const [deleted] = await tx
    .delete(productionItemMedia)
    .where(
      and(
        eq(productionItemMedia.id, mediaId),
        eq(productionItemMedia.productionItemId, itemId),
      ),
    )
    .returning();
  return deleted ?? null;
}

/**
 * Per-platform media rules. Encodes platform truth (X = up to 4 photos
 * OR 1 video, no mixing). Validate at both the presign and confirm steps
 * so a stale client can't sneak past.
 */
export type MediaValidationOk = { ok: true };
export type MediaValidationErr = { ok: false; reason: string };
export type MediaValidationResult = MediaValidationOk | MediaValidationErr;

interface MediaShape {
  kind: "image" | "video";
}

export function validateMediaForPostType(
  postType: string | null,
  existing: MediaShape[],
  incoming: MediaShape[],
): MediaValidationResult {
  if (!postType) {
    return { ok: false, reason: "Set a post type before uploading media." };
  }

  if (postType === "x") {
    const combined = [...existing, ...incoming];
    if (combined.length > 4) {
      return {
        ok: false,
        reason: "Tweets allow up to 4 photos or 1 video.",
      };
    }
    const hasVideo = combined.some((m) => m.kind === "video");
    if (hasVideo && combined.length > 1) {
      return {
        ok: false,
        reason: "A tweet can have 1 video OR up to 4 photos, not both.",
      };
    }
    return { ok: true };
  }

  // Other platforms haven't been wired for manual upload yet. Refuse so the
  // call site explicitly opts in when adding (and adds the right rule).
  return {
    ok: false,
    reason: `Manual media upload isn't enabled for ${postType} yet.`,
  };
}

/** Allowlist for X. Mirrors what the X feed actually accepts on publish. */
export const X_ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

/** Per-file size caps (bytes). Generous vs Twitter's actual limits. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export function inferKindFromContentType(contentType: string): "image" | "video" | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return null;
}
