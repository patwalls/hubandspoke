import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItemMedia, productionItems } from "@/lib/db/schema";
import { recordContentChanges, type ContentChange } from "@/lib/services/content-revisions";

export const DESIGN_EDITOR_SOURCE_PREFIX = "design-editor://render/";

/**
 * Make rendered pages the item's carousel: pages take indexes 0…n-1 (the
 * simulator's slides, in order), anything else on the item is renumbered
 * after them, and a previous design render is replaced. Manual uploads and
 * other tools' media survive. Idempotent per render.
 */
export async function installDesignMedia(args: {
  productionItemId: string;
  renderId: string;
  s3Bucket: string;
  pages: Array<{ s3Key: string; sizeBytes: number }>;
}): Promise<void> {
  const sourceUrl = `${DESIGN_EDITOR_SOURCE_PREFIX}${args.renderId}`;
  await db.transaction(async (tx) => {
    const [already] = await tx
      .select({ id: productionItemMedia.id })
      .from(productionItemMedia)
      .where(and(eq(productionItemMedia.productionItemId, args.productionItemId), eq(productionItemMedia.sourceUrl, sourceUrl)))
      .limit(1);
    if (already) return;

    const isPrior = and(
      eq(productionItemMedia.productionItemId, args.productionItemId),
      sql`${productionItemMedia.sourceUrl} LIKE ${DESIGN_EDITOR_SOURCE_PREFIX + "%"}`,
    );
    const prior = await tx
      .select({ id: productionItemMedia.id, index: productionItemMedia.index, kind: productionItemMedia.kind, s3Key: productionItemMedia.s3Key, posterS3Key: productionItemMedia.posterS3Key })
      .from(productionItemMedia)
      .where(isPrior);
    await tx.delete(productionItemMedia).where(isPrior);

    // Renumber the rest to n, n+1, … (two passes via negative scratch values
    // so the (item, index) unique constraint never trips mid-statement).
    const n = args.pages.length;
    await tx.execute(sql`
      UPDATE production_item_media m SET index = -(r.rn + ${n} - 1)
        FROM (SELECT id, row_number() OVER (ORDER BY index) AS rn FROM production_item_media WHERE production_item_id = ${args.productionItemId}) r
       WHERE m.id = r.id`);
    await tx.execute(sql`UPDATE production_item_media SET index = -index WHERE production_item_id = ${args.productionItemId} AND index < 0`);

    const inserted = await tx
      .insert(productionItemMedia)
      .values(
        args.pages.map((p, i) => ({
          productionItemId: args.productionItemId,
          index: i,
          kind: "image",
          s3Bucket: args.s3Bucket,
          s3Key: p.s3Key,
          contentType: "image/png",
          sizeBytes: p.sizeBytes,
          posterS3Key: null,
          sourceUrl,
        })),
      )
      .returning();

    const changes: ContentChange[] = [
      ...prior.map((p): ContentChange => ({ target: { kind: "media_removed", mediaId: p.id, index: p.index, mediaKind: p.kind as "image" | "video", s3Key: p.s3Key, posterS3Key: p.posterS3Key ?? null } })),
      ...inserted.map((m): ContentChange => ({ target: { kind: "media_added", mediaId: m.id, index: m.index, mediaKind: "image", s3Key: m.s3Key, posterS3Key: null } })),
    ];
    await recordContentChanges({ tx, contentItemId: args.productionItemId, userId: null, source: { kind: "tool", tool: "design-editor" }, changes });

    const [lowest] = await tx
      .select({ s3Bucket: productionItemMedia.s3Bucket, s3Key: productionItemMedia.s3Key, contentType: productionItemMedia.contentType, posterS3Key: productionItemMedia.posterS3Key })
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
