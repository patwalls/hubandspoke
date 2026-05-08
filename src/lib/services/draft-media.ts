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
import {
  getMediaRule,
  isSingleMediaMode,
  type MediaMode,
} from "@/lib/platform-media-rules";

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
 * Validate a proposed media set against a platform's rule. Generic over
 * `MediaMode` — adding a new platform = adding a row to
 * `PLATFORM_MEDIA_RULES`, no branching here. Validate at both the presign
 * and confirm steps so a stale client can't sneak past.
 */
export type MediaValidationOk = { ok: true };
export type MediaValidationErr = { ok: false; reason: string };
export type MediaValidationResult = MediaValidationOk | MediaValidationErr;

interface MediaShape {
  kind: "image" | "video";
}

const SINGULAR_REASON: Record<MediaMode, string> = {
  "single-video": "This platform allows a single video.",
  "single-any": "This platform allows one photo or video.",
  "photos-or-video": "Choose photos OR one video — not both.",
  "carousel-mixed": "",
  none: "",
};

export function validateMediaForPostType(
  postType: string | null,
  existing: MediaShape[],
  incoming: MediaShape[],
): MediaValidationResult {
  if (!postType) {
    return { ok: false, reason: "Set a post type before uploading media." };
  }

  const rule = getMediaRule(postType);
  if (rule.mode === "none") {
    return {
      ok: false,
      reason: `Manual media upload isn't enabled for ${postType} yet.`,
    };
  }

  const combined = [...existing, ...incoming];

  // Cap check is uniform across modes.
  if (combined.length > rule.maxCount) {
    return {
      ok: false,
      reason: `${postTypeLabel(postType)} allows up to ${rule.maxCount} ${
        rule.maxCount === 1 ? "item" : "items"
      }.`,
    };
  }

  // Per-item kind allowlist (e.g., Reel rejects photos).
  for (const m of incoming) {
    if (!rule.allowedKinds.includes(m.kind)) {
      return {
        ok: false,
        reason: SINGULAR_REASON[rule.mode] || `${m.kind} not allowed here.`,
      };
    }
  }

  // Mode-specific cross-item rules.
  if (rule.mode === "photos-or-video") {
    const hasVideo = combined.some((m) => m.kind === "video");
    if (hasVideo && combined.length > 1) {
      return { ok: false, reason: SINGULAR_REASON["photos-or-video"] };
    }
  }
  // single-video / single-any / carousel-mixed are fully covered by the
  // count + allowedKinds checks above.
  void isSingleMediaMode;
  return { ok: true };
}

function postTypeLabel(postType: string): string {
  switch (postType) {
    case "x":
      return "Tweets";
    case "instagram_post":
      return "Instagram carousels";
    case "instagram_reel":
      return "Reels";
    case "instagram_story":
      return "Stories";
    case "linkedin":
      return "LinkedIn posts";
    case "tiktok":
      return "TikTok posts";
    default:
      return "This platform";
  }
}


/**
 * Server-side allowlist of MIME types accepted by ANY supported platform.
 * Per-platform constraints (which subset is valid for which post type)
 * live in `validateMediaForPostType` and `dropZoneOptionsForPostType`.
 */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

/** Per-file size caps (bytes). Generous vs platform actual limits. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** Max files in a single upload batch — IG carousels go up to 10. */
export const MAX_FILES_PER_REQUEST = 10;

/**
 * Per-platform dropzone configuration for the React component. Thin
 * adapter over `PLATFORM_MEDIA_RULES` — keeps the dropzone props stable
 * while platform truth lives one place. Returns null for `mode: "none"`
 * post types so the dropzone renders no UI but still displays slides.
 */
export interface DropZoneOptions {
  accept: string;
  /** Combined cap (existing + new). Drives "add more" button visibility. */
  maxTotal: number;
  addButtonLabel: string;
  /** Replace label when at-cap on a single-* mode. */
  replaceButtonLabel: string;
  /** True when the dropzone should treat a new file as "delete existing
   *  then upload" rather than rejecting on cap. */
  replaceOnUpload: boolean;
}

export function dropZoneOptionsForPostType(
  postType: string | null,
): DropZoneOptions | null {
  if (!postType) return null;
  const rule = getMediaRule(postType);
  if (rule.mode === "none") return null;
  return {
    accept: rule.accept,
    maxTotal: rule.maxCount,
    addButtonLabel: rule.addLabel,
    replaceButtonLabel: rule.replaceLabel,
    replaceOnUpload: isSingleMediaMode(rule.mode),
  };
}

export function inferKindFromContentType(contentType: string): "image" | "video" | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return null;
}
