import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, productionItemMedia } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { getPresignedGetUrl } from "@/lib/s3";
import { resolveCleanSourceMedia } from "@/lib/services/clean-media-resolver";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PRESIGN_GET_TTL = 60 * 60;

/**
 * The ORIGINAL clean media for an item — resolved by walking lineage to the
 * nearest saved Descript export / upload (skipping watermarked TikTok
 * downloads). See `resolveCleanSourceMedia`.
 *
 *   GET  → download the clean original video (302 to a presigned S3 URL).
 *          Works on any status, incl. Published (so you can grab it later).
 *   POST → "Swap in original media": replace this item's media with the clean
 *          original (pre-publish only). Shares S3 keys (no copy), mirrors the
 *          legacy cover columns, writes activity events.
 */

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [item] = await db
    .select({ title: productionItems.title })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const resolution = await resolveCleanSourceMedia(id);
  if (resolution.kind !== "archived") {
    return NextResponse.json(
      { error: resolution.kind === "none" ? resolution.reason : "No original media" },
      { status: 404 },
    );
  }

  // Prefer the (lowest-index) video; fall back to the first row for carousels.
  const primary =
    resolution.rows.find((r) => r.kind === "video") ?? resolution.rows[0];
  if (!primary) {
    return NextResponse.json({ error: "No original media" }, { status: 404 });
  }

  const baseName =
    (item.title || primary.s3Key.split("/").pop() || "video")
      .replace(/[^\w. -]+/g, "_")
      .slice(0, 120) || "video";
  const ext = primary.s3Key.match(/\.[a-z0-9]{1,8}$/i)?.[0] || ".mp4";
  const downloadFileName = baseName.toLowerCase().endsWith(ext.toLowerCase())
    ? baseName
    : `${baseName}${ext}`;

  const url = await getPresignedGetUrl(primary.s3Key, 60 * 5, { downloadFileName });
  return NextResponse.redirect(url, 302);
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = (guard.session.user.id as string | undefined) ?? null;
  const { id } = await context.params;

  const [item] = await db
    .select({ id: productionItems.id, status: productionItems.status })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (item.status === "Published") {
    return NextResponse.json(
      { error: "Media is locked after publishing — swap before you publish." },
      { status: 409 },
    );
  }

  const resolution = await resolveCleanSourceMedia(id);
  if (resolution.kind === "none") {
    return NextResponse.json({ error: resolution.reason }, { status: 422 });
  }
  // depth 0 means the item's own media already IS the clean original.
  if (resolution.origin.depth === 0) {
    return NextResponse.json({ pulled: false, reason: "Media is already the original." });
  }

  const cleanRows = resolution.rows;
  const inserted = await db.transaction(async (tx) => {
    // Snapshot current rows for media_removed events, then replace the whole
    // media set with the clean original (the intent of "swap in original").
    const current = await tx
      .select({
        id: productionItemMedia.id,
        index: productionItemMedia.index,
        kind: productionItemMedia.kind,
        s3Key: productionItemMedia.s3Key,
        posterS3Key: productionItemMedia.posterS3Key,
      })
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, id));

    await tx
      .delete(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, id));

    // Re-base the clean rows to index 0..n preserving order; share S3 keys
    // and carry sourceUrl (so classification + Descript re-sync stay correct).
    const ordered = [...cleanRows].sort((a, b) => a.index - b.index);
    const newRows = await tx
      .insert(productionItemMedia)
      .values(
        ordered.map((m, i) => ({
          productionItemId: id,
          index: i,
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
        contentType: productionItemMedia.contentType,
        sizeBytes: productionItemMedia.sizeBytes,
        s3Key: productionItemMedia.s3Key,
        posterS3Key: productionItemMedia.posterS3Key,
      });

    // Mirror the new index-0 onto the legacy cover columns (image-only poster
    // rule, same as media/route.ts).
    const lowest = newRows.find((r) => r.index === 0) ?? newRows[0];
    if (lowest) {
      const fallbackPoster =
        lowest.posterS3Key ?? (lowest.kind === "image" ? lowest.s3Key : null);
      const lowestFull = ordered[0];
      await tx
        .update(productionItems)
        .set({
          mediaS3Bucket: lowestFull.s3Bucket,
          mediaS3Key: lowest.s3Key,
          mediaContentType: lowest.contentType,
          posterS3Key: fallbackPoster,
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, id));
    }

    const changes: ContentChange[] = [
      ...current.map<ContentChange>((row) => ({
        target: {
          kind: "media_removed",
          mediaId: row.id,
          index: row.index,
          mediaKind: row.kind as "image" | "video",
          s3Key: row.s3Key,
          posterS3Key: row.posterS3Key ?? null,
        },
      })),
      ...newRows.map<ContentChange>((row) => ({
        target: {
          kind: "media_added",
          mediaId: row.id,
          index: row.index,
          mediaKind: row.kind as "image" | "video",
          s3Key: row.s3Key,
          posterS3Key: row.posterS3Key ?? null,
        },
      })),
    ];
    await recordContentChanges({
      tx,
      contentItemId: id,
      userId: actorUserId,
      source: { kind: "import" },
      changes,
    });

    return newRows;
  });

  const withUrls = await Promise.all(
    inserted.map(async (row) => ({
      id: row.id,
      index: row.index,
      kind: row.kind,
      url: await getPresignedGetUrl(row.s3Key, PRESIGN_GET_TTL).catch(() => null),
    })),
  );

  return NextResponse.json({
    pulled: true,
    source: resolution.label,
    mediaCount: inserted.length,
    media: withUrls,
  });
}
