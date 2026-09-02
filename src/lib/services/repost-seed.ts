/**
 * Seed the per-platform content that a fresh repost needs in order for the
 * detail page to render a non-empty preview on the redirect.
 *
 * Two side effects, kept in one helper so both repost-creation paths (the
 * manual `/api/production-items/[id]/repost` route today, and the cron-driven
 * `runEvergreenScan` path later) seed the same shape:
 *
 * 1. **Copy `production_item_media` rows** from source to the new repost.
 *    Same `s3_key`s — no re-upload, no duplicated bytes. The X simulator
 *    reads slides straight from these rows; without them the photo grid is
 *    empty.
 *
 * 2. **Insert a v1 `content_drafts` row** keyed by the platform's field
 *    schema. For X that's `{ tweet: <source.contentBody> }`. The
 *    `EditableField` editor binds via `draftId`, so a row has to exist for
 *    the first keystroke to PATCH cleanly.
 *
 * Gated to `postType === "x"` at the call site for now — every other
 * platform should opt in deliberately.
 */
import { eq } from "drizzle-orm";
import { contentDrafts, productionItemMedia } from "@/lib/db/schema";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";
import {
  PLATFORM_FIELD_MAP,
  PLATFORM_FIELD_SCHEMAS,
  type PostType,
} from "@/lib/platform-field-schemas";
import { getMediaRule } from "@/lib/platform-media-rules";
import {
  resolveCleanSourceMedia,
  classifyMediaSource,
} from "@/lib/services/clean-media-resolver";
import type { db as dbClient } from "@/lib/db";

type Tx = Parameters<Parameters<typeof dbClient.transaction>[0]>[0];

export interface SeedRepostContentInput {
  sourceId: string;
  repostId: string;
  postType: PostType;
  /** Source's published-snapshot text. May be null if enrichment hasn't run.
   *  Treated as "" so the editor still has a row to PATCH against. */
  sourceContentBody: string | null;
  /** Legacy single-media columns from the source's `production_items` row.
   *  Used as a fallback when the source has zero `production_item_media`
   *  rows — older enrichments wrote the MP4 directly onto the parent row
   *  instead of into the carousel-style table. When present we synthesize
   *  one carousel row on the new repost so the simulator can play it
   *  without a fresh Descript render. Pass null to skip the fallback. */
  sourceLegacyMedia: {
    s3Bucket: string | null;
    s3Key: string | null;
    contentType: string | null;
    posterS3Key: string | null;
  } | null;
  actorUserId: string;
  /** When true, limits mirrored media to the first video row (index 0) when
   *  the source has multiple video rows. Image rows are unaffected. Cross-posts
   *  of video clips should never inherit a second "full pillar video" slide
   *  that the draft algorithm may have attached to the source. */
  primaryVideoOnly?: boolean;
}

export async function seedRepostContent(tx: Tx, input: SeedRepostContentInput) {
  const {
    sourceId,
    repostId,
    postType,
    sourceContentBody,
    sourceLegacyMedia,
    actorUserId,
    primaryVideoOnly = false,
  } = input;

  // 1. Mirror carousel media. The (production_item_id, index) unique index
  //    means we insert with the same `index` values; collisions can't happen
  //    because the new repost row has zero existing rows.
  //
  //    Filter by the TARGET platform's allowed media kinds — without this,
  //    a video source cross-posted to a target that doesn't accept video
  //    (YT Community, which is image-only — see platform-media-rules.ts)
  //    would seed a row the target's simulator rejects with a "doesn't
  //    support video" warning. For same-kind targets the filter is a no-op.
  const allowedKinds = new Set(getMediaRule(postType).allowedKinds);

  // Prefer the ORIGINAL clean media over whatever the source happens to hold.
  // A TikTok source's archived video is a watermarked download; the resolver
  // walks lineage to the nearest saved clean media (our Descript export /
  // upload) so the repost publishes clean. Falls back to the source's own
  // rows only when no clean original exists anywhere.
  const resolution = await resolveCleanSourceMedia(sourceId);
  let mediaProvenance: "clean" | "watermark_fallback" | "none" = "none";
  let sourceMedia: Array<{
    index: number;
    kind: string;
    s3Bucket: string;
    s3Key: string;
    contentType: string;
    sizeBytes: number | null;
    posterS3Key: string | null;
    sourceUrl: string | null;
  }>;
  if (resolution.kind === "archived") {
    sourceMedia = resolution.rows.filter((m) =>
      allowedKinds.has(m.kind as "image" | "video"),
    );
    mediaProvenance = "clean";
  } else {
    // No clean original anywhere — mirror the source's own rows (today's
    // behavior). Flag when that fallback is a watermarked TikTok download so
    // the operator can hit "Swap in original media".
    const sourceMediaAll = await tx
      .select({
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
      .where(eq(productionItemMedia.productionItemId, sourceId));
    sourceMedia = sourceMediaAll.filter((m) =>
      allowedKinds.has(m.kind as "image" | "video"),
    );
    mediaProvenance = sourceMediaAll.some(
      (m) =>
        m.kind === "video" &&
        classifyMediaSource(m.sourceUrl) === "tiktok_dirty",
    )
      ? "watermark_fallback"
      : sourceMediaAll.length > 0
        ? "clean"
        : "none";
  }

  // Cross-post guard: when the source clip has multiple video rows (e.g. the
  // draft algorithm mistakenly attached the full pillar video), only keep the
  // first video row so the cross-post doesn't inherit a carousel of videos.
  // Image rows are untouched so IG-carousel cross-posts still mirror all slides.
  if (primaryVideoOnly) {
    const videoRows = sourceMedia.filter((m) => m.kind === "video");
    if (videoRows.length > 1) {
      const firstVideoIndex = Math.min(...videoRows.map((m) => m.index));
      sourceMedia = sourceMedia.filter(
        (m) => m.kind !== "video" || m.index === firstVideoIndex,
      );
    }
  }

  const mediaChanges: ContentChange[] = [];
  if (sourceMedia.length > 0) {
    const inserted = await tx
      .insert(productionItemMedia)
      .values(
        sourceMedia.map((m) => ({
          productionItemId: repostId,
          index: m.index,
          kind: m.kind,
          s3Bucket: m.s3Bucket,
          s3Key: m.s3Key,
          contentType: m.contentType,
          sizeBytes: m.sizeBytes,
          posterS3Key: m.posterS3Key,
          sourceUrl: m.sourceUrl,
        })),
      )
      .returning({
        id: productionItemMedia.id,
        index: productionItemMedia.index,
        kind: productionItemMedia.kind,
        s3Key: productionItemMedia.s3Key,
        posterS3Key: productionItemMedia.posterS3Key,
      });
    for (const row of inserted) {
      mediaChanges.push({
        target: {
          kind: "media_added",
          mediaId: row.id,
          index: row.index,
          mediaKind: row.kind as "image" | "video",
          s3Key: row.s3Key,
          posterS3Key: row.posterS3Key ?? null,
        },
      });
    }
  } else if (
    resolution.kind === "none" &&
    sourceLegacyMedia?.s3Bucket &&
    sourceLegacyMedia.s3Key &&
    sourceLegacyMedia.contentType
  ) {
    // Legacy fallback: pre-carousel enrichment archived the MP4 onto the
    // parent row's `mediaS3Key` instead of as a `production_item_media`
    // row. Synthesize one row on the new repost so the simulator's video
    // path lights up without re-rendering through Descript. Schema
    // requires s3Bucket / s3Key / contentType non-null — skip the row
    // if any is missing. Also gate on the target's allowed kinds (see
    // carousel branch above for the same reasoning) — if the legacy
    // media's kind isn't accepted, skip the row but still seed the v1
    // draft below.
    const kind: "image" | "video" = sourceLegacyMedia.contentType.startsWith(
      "video/",
    )
      ? "video"
      : "image";
    if (allowedKinds.has(kind)) {
    const [inserted] = await tx
      .insert(productionItemMedia)
      .values({
        productionItemId: repostId,
        index: 0,
        kind,
        s3Bucket: sourceLegacyMedia.s3Bucket,
        s3Key: sourceLegacyMedia.s3Key,
        contentType: sourceLegacyMedia.contentType,
        sizeBytes: null,
        posterS3Key: sourceLegacyMedia.posterS3Key,
        sourceUrl: null,
      })
      .returning({ id: productionItemMedia.id });
    mediaChanges.push({
      target: {
        kind: "media_added",
        mediaId: inserted.id,
        index: 0,
        mediaKind: kind,
        s3Key: sourceLegacyMedia.s3Key,
        posterS3Key: sourceLegacyMedia.posterS3Key ?? null,
      },
    });
    }
  }

  // Audit each mirrored slide so the activity feed on the new repost
  // shows "imported slide 1, slide 2, …" with thumbnails. Source is
  // `import` — distinct from `user` so the activity feed can group these
  // as "seeded from source" later if we want a different rendering.
  if (mediaChanges.length > 0) {
    await recordContentChanges({
      tx,
      contentItemId: repostId,
      userId: actorUserId,
      source: { kind: "import" },
      changes: mediaChanges,
    });
  }

  // 2. v1 draft pre-filled with the source's text. `copy:source` is a new
  //    sentinel for `generatedBy` — distinct from `ai:...` and `user` so
  //    we can later filter "did the editor actually rewrite this, or ship
  //    it verbatim?" analytics.
  //
  //    Target the **caption role** from PLATFORM_FIELD_MAP, not the first
  //    required field in the schema. For `instagram_reel` the schema lists
  //    `hook` first (and it's required), but `hook` is editorial on-screen
  //    text — the source's contentBody is the post caption and belongs in
  //    the `caption` field. PLATFORM_FIELD_MAP encodes the right mapping.
  const fieldSchema = PLATFORM_FIELD_SCHEMAS[postType];
  const captionFieldKey = PLATFORM_FIELD_MAP[postType]?.caption ?? null;
  const draftContent: Record<string, string> = captionFieldKey
    ? { [captionFieldKey]: sourceContentBody ?? "" }
    : {};

  await tx.insert(contentDrafts).values({
    productionItemId: repostId,
    version: 1,
    isCurrent: true,
    content: draftContent,
    fieldSchemaSnapshot: fieldSchema,
    generatedBy: "copy:source",
    createdByUserId: actorUserId,
  });

  // Let callers log/branch on whether we seeded the clean original vs fell
  // back to a watermarked download.
  return { mediaProvenance };
}
