import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItemMedia, productionItems } from "@/lib/db/schema";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

/** `production_item_media.source_url` prefix that marks a row as a clip
 *  editor render. Re-exports replace rows with this prefix and nothing else,
 *  so manual uploads (and Descript renders) on the same item survive. */
export const CLIP_EDITOR_SOURCE_PREFIX = "clip-editor://render/";

/**
 * Make a finished render the item's canonical video.
 *
 * Index 0 is the slot every downstream consumer reads — the content-detail
 * simulator's first slide, the legacy `media_s3_key` mirror, and the publish
 * / scheduling flows that send media to the platforms — so landing there is
 * what plugs an editor render into the rest of the workflow with no changes
 * downstream. Same contract the Descript publish task established
 * (src/jobs/tasks/descript-publish-and-archive.ts); that task is deliberately
 * left untouched rather than refactored onto this helper while the editor is
 * behind a flag.
 *
 * Idempotent per render: a retry after the insert landed finds its own row
 * and returns.
 */
export async function installRenderedClipMedia(args: {
  productionItemId: string;
  renderId: string;
  s3Bucket: string;
  s3Key: string;
  sizeBytes: number;
}): Promise<void> {
  const sourceUrl = `${CLIP_EDITOR_SOURCE_PREFIX}${args.renderId}`;

  await db.transaction(async (tx) => {
    const [already] = await tx
      .select({ id: productionItemMedia.id })
      .from(productionItemMedia)
      .where(
        and(
          eq(productionItemMedia.productionItemId, args.productionItemId),
          eq(productionItemMedia.sourceUrl, sourceUrl),
        ),
      )
      .limit(1);
    if (already) return;

    const isPriorRender = and(
      eq(productionItemMedia.productionItemId, args.productionItemId),
      sql`${productionItemMedia.sourceUrl} LIKE ${CLIP_EDITOR_SOURCE_PREFIX + "%"}`,
    );
    const prior = await tx
      .select({
        id: productionItemMedia.id,
        index: productionItemMedia.index,
        kind: productionItemMedia.kind,
        s3Key: productionItemMedia.s3Key,
        posterS3Key: productionItemMedia.posterS3Key,
      })
      .from(productionItemMedia)
      .where(isPriorRender);
    await tx.delete(productionItemMedia).where(isPriorRender);

    // Renumber what's left to 1…n, freeing index 0. Renumbering (rather than
    // a blind +1 shift) matters on re-export: the old render was just deleted
    // from slot 0, and shifting would leave a gap that grows by one with
    // every export. Two passes through negative scratch values, because a
    // direct update trips the (production_item_id, index) unique constraint
    // mid-statement.
    await tx.execute(sql`
      UPDATE production_item_media m SET index = -r.rn
        FROM (
          SELECT id, row_number() OVER (ORDER BY index) AS rn
            FROM production_item_media
           WHERE production_item_id = ${args.productionItemId}
        ) r
       WHERE m.id = r.id
    `);
    await tx.execute(sql`
      UPDATE production_item_media SET index = -index
       WHERE production_item_id = ${args.productionItemId} AND index < 0
    `);

    const [inserted] = await tx
      .insert(productionItemMedia)
      .values({
        productionItemId: args.productionItemId,
        index: 0,
        kind: "video",
        s3Bucket: args.s3Bucket,
        s3Key: args.s3Key,
        contentType: "video/mp4",
        sizeBytes: args.sizeBytes,
        posterS3Key: null,
        sourceUrl,
      })
      .returning();

    const changes: ContentChange[] = [
      ...prior.map(
        (p): ContentChange => ({
          target: {
            kind: "media_removed",
            mediaId: p.id,
            index: p.index,
            mediaKind: p.kind as "image" | "video",
            s3Key: p.s3Key,
            posterS3Key: p.posterS3Key ?? null,
          },
        }),
      ),
      {
        target: {
          kind: "media_added",
          mediaId: inserted.id,
          index: inserted.index,
          mediaKind: "video",
          s3Key: inserted.s3Key,
          posterS3Key: null,
        },
      },
    ];
    await recordContentChanges({
      tx,
      contentItemId: args.productionItemId,
      userId: null,
      source: { kind: "tool", tool: "clip-editor" },
      changes,
    });

    // Mirror the lowest-index row onto the legacy single-media columns.
    const [lowest] = await tx
      .select({
        s3Bucket: productionItemMedia.s3Bucket,
        s3Key: productionItemMedia.s3Key,
        contentType: productionItemMedia.contentType,
        posterS3Key: productionItemMedia.posterS3Key,
      })
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, args.productionItemId))
      .orderBy(asc(productionItemMedia.index))
      .limit(1);
    await tx
      .update(productionItems)
      .set({
        mediaS3Bucket: lowest?.s3Bucket ?? null,
        mediaS3Key: lowest?.s3Key ?? null,
        mediaContentType: lowest?.contentType ?? null,
        posterS3Key: lowest?.posterS3Key ?? lowest?.s3Key ?? null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, args.productionItemId));
  });
}
