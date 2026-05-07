import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems, productionItemMedia } from "@/lib/db/schema";
import { removeMediaRowFromDraft } from "@/lib/services/draft-media";

interface RouteContext {
  params: Promise<{ id: string; mediaId: string }>;
}

/**
 * DELETE /api/production-items/[id]/media/[mediaId]
 *
 * Drops the row from `production_item_media`. The S3 object is preserved
 * — same `s3_key` may be referenced by another item (reposts share keys).
 *
 * If the deleted row was index 0, recompute the legacy single-cover
 * columns (`media_s3_*`, `poster_s3_key`) from the new index 0 (or null
 * them when no rows remain).
 *
 * Refuses on a published item — same gate as the upload route.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id, mediaId } = await context.params;

  const [item] = await db
    .select({
      id: productionItems.id,
      status: productionItems.status,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (item.status === "Published") {
    return NextResponse.json(
      { error: "Cannot edit media on a published post." },
      { status: 400 },
    );
  }

  const result = await db.transaction(async (tx) => {
    const removed = await removeMediaRowFromDraft(tx, { itemId: id, mediaId });
    if (!removed) return { removed: null };

    // Recompute the legacy single-cover columns from whatever's now at
    // index 0 (or null them if the carousel is empty).
    const [lowest] = await tx
      .select({
        s3Bucket: productionItemMedia.s3Bucket,
        s3Key: productionItemMedia.s3Key,
        contentType: productionItemMedia.contentType,
        posterS3Key: productionItemMedia.posterS3Key,
      })
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, id))
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
      .where(eq(productionItems.id, id));

    return { removed };
  });

  if (!result.removed) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: result.removed.id });
}
