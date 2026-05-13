import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems, productionItemMedia } from "@/lib/db/schema";
import { getPresignedGetUrl, headObject } from "@/lib/s3";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";
import {
  ALLOWED_CONTENT_TYPES,
  MAX_FILES_PER_REQUEST,
  addMediaRowsToDraft,
  validateMediaForPostType,
} from "@/lib/services/draft-media";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ConfirmedUpload {
  key: string;
  bucket: string;
  contentType: string;
  sizeBytes: number;
  kind: "image" | "video";
  posterS3Key?: string | null;
}

const PRESIGN_GET_TTL = 60 * 60; // 1h, matches detail GET

/**
 * POST /api/production-items/[id]/media
 *
 * Body: { uploads: [{ key, bucket, contentType, sizeBytes, kind, posterS3Key? }] }
 *
 * Confirms each upload landed in S3 (HEAD), re-runs the per-platform
 * validator (defense-in-depth), and inserts `production_item_media` rows
 * inside one transaction. Mirrors index-0 onto the legacy single-cover
 * columns so cover-thumbnail consumers (queue/list views) stay correct.
 *
 * Returns the new rows with presigned GET URLs so the simulator can render
 * immediately without a full item refetch.
 */
export async function POST(request: Request, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id as string;

  const { id } = await context.params;

  let body: { uploads?: unknown };
  try {
    body = (await request.json()) as { uploads?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.uploads) || body.uploads.length === 0) {
    return NextResponse.json(
      { error: "uploads[] required" },
      { status: 400 },
    );
  }
  if (body.uploads.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Up to ${MAX_FILES_PER_REQUEST} files per request` },
      { status: 400 },
    );
  }

  const uploads: ConfirmedUpload[] = [];
  for (const raw of body.uploads) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "Bad upload entry" }, { status: 400 });
    }
    const u = raw as Record<string, unknown>;
    const key = typeof u.key === "string" ? u.key : "";
    const bucket = typeof u.bucket === "string" ? u.bucket : "";
    const contentType = typeof u.contentType === "string" ? u.contentType : "";
    const sizeBytes = Number(u.sizeBytes);
    const kind = u.kind === "image" || u.kind === "video" ? u.kind : null;
    const posterS3Key =
      typeof u.posterS3Key === "string" && u.posterS3Key.length > 0
        ? u.posterS3Key
        : null;
    if (
      !key ||
      !bucket ||
      !contentType ||
      !Number.isFinite(sizeBytes) ||
      sizeBytes <= 0 ||
      !kind
    ) {
      return NextResponse.json(
        { error: "Each upload needs key, bucket, contentType, sizeBytes, kind" },
        { status: 400 },
      );
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${contentType}` },
        { status: 400 },
      );
    }
    uploads.push({ key, bucket, contentType, sizeBytes, kind, posterS3Key });
  }

  const [item] = await db
    .select({
      id: productionItems.id,
      status: productionItems.status,
      postType: productionItems.postType,
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

  // HEAD each key to confirm S3 actually has the bytes the client claims
  // were uploaded. Catches a faked confirm where the PUT failed silently.
  for (const u of uploads) {
    const head = await headObject(u.key);
    if (!head) {
      return NextResponse.json(
        { error: `Upload not found in S3: ${u.key}` },
        { status: 400 },
      );
    }
  }

  const existingRows = await db
    .select({ kind: productionItemMedia.kind })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, id));
  const validation = validateMediaForPostType(
    item.postType,
    existingRows.map((r) => ({ kind: r.kind as "image" | "video" })),
    uploads.map((u) => ({ kind: u.kind })),
  );
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }

  const inserted = await db.transaction(async (tx) => {
    const rows = await addMediaRowsToDraft(tx, {
      itemId: id,
      files: uploads.map((u) => ({
        s3Bucket: u.bucket,
        s3Key: u.key,
        contentType: u.contentType,
        sizeBytes: u.sizeBytes,
        kind: u.kind,
        posterS3Key: u.posterS3Key,
        sourceUrl: null,
      })),
    });

    // Mirror the new index-0 onto the legacy single-cover columns so the
    // queue / list cover thumbnails reflect the latest state. Mirrors what
    // enrichment does at twitter.ts:202-203.
    const [lowest] = await tx
      .select({
        s3Bucket: productionItemMedia.s3Bucket,
        s3Key: productionItemMedia.s3Key,
        contentType: productionItemMedia.contentType,
        kind: productionItemMedia.kind,
        posterS3Key: productionItemMedia.posterS3Key,
      })
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, id))
      .orderBy(asc(productionItemMedia.index))
      .limit(1);

    if (lowest) {
      // Only fall back to s3Key as the poster when slide-0 is an image.
      // For video slides without an explicit posterS3Key, leave the column
      // null — feeding a video URL into image-only consumers (the vision
      // sweep, cover-thumbnail renderers) breaks them.
      const fallbackPoster =
        lowest.posterS3Key ?? (lowest.kind === "image" ? lowest.s3Key : null);
      await tx
        .update(productionItems)
        .set({
          mediaS3Bucket: lowest.s3Bucket,
          mediaS3Key: lowest.s3Key,
          mediaContentType: lowest.contentType,
          posterS3Key: fallbackPoster,
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, id));
    }

    // One media_added event per row inserted, so the activity feed can
    // render a thumbnail per slide. s3Key + posterS3Key snapshot in the
    // payload means future deletes don't invalidate the renderer.
    const mediaChanges: ContentChange[] = rows.map((row) => ({
      target: {
        kind: "media_added",
        mediaId: row.id,
        index: row.index,
        mediaKind: row.kind as "image" | "video",
        s3Key: row.s3Key,
        posterS3Key: row.posterS3Key ?? null,
      },
    }));
    await recordContentChanges({
      tx,
      contentItemId: id,
      userId: actorUserId,
      source: { kind: "user" },
      changes: mediaChanges,
    });

    return rows;
  });

  // Sign GET URLs so the simulator can render the new media immediately.
  const withUrls = await Promise.all(
    inserted.map(async (row) => {
      const url = await getPresignedGetUrl(row.s3Key, PRESIGN_GET_TTL).catch(
        () => null,
      );
      const posterUrl = row.posterS3Key
        ? await getPresignedGetUrl(row.posterS3Key, PRESIGN_GET_TTL).catch(
            () => null,
          )
        : null;
      return {
        id: row.id,
        index: row.index,
        kind: row.kind,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        url,
        posterUrl,
      };
    }),
  );

  return NextResponse.json({ media: withUrls }, { status: 201 });
}
