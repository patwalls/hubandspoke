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
import { PLATFORM_FIELD_SCHEMAS, type PostType } from "@/lib/platform-field-schemas";
import type { db as dbClient } from "@/lib/db";

type Tx = Parameters<Parameters<typeof dbClient.transaction>[0]>[0];

export interface SeedRepostContentInput {
  sourceId: string;
  repostId: string;
  postType: PostType;
  /** Source's published-snapshot text. May be null if enrichment hasn't run.
   *  Treated as "" so the editor still has a row to PATCH against. */
  sourceContentBody: string | null;
  actorUserId: string;
}

export async function seedRepostContent(tx: Tx, input: SeedRepostContentInput) {
  const { sourceId, repostId, postType, sourceContentBody, actorUserId } = input;

  // 1. Mirror carousel media. The (production_item_id, index) unique index
  //    means we insert with the same `index` values; collisions can't happen
  //    because the new repost row has zero existing rows.
  const sourceMedia = await tx
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

  if (sourceMedia.length > 0) {
    await tx.insert(productionItemMedia).values(
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
      }))
    );
  }

  // 2. v1 draft pre-filled with the source's text. `copy:source` is a new
  //    sentinel for `generatedBy` — distinct from `ai:...` and `user` so
  //    we can later filter "did the editor actually rewrite this, or ship
  //    it verbatim?" analytics.
  const fieldSchema = PLATFORM_FIELD_SCHEMAS[postType];
  const captionField = fieldSchema.fields.find((f) => f.required) ?? fieldSchema.fields[0];
  const draftContent: Record<string, string> = captionField
    ? { [captionField.key]: sourceContentBody ?? "" }
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
}
