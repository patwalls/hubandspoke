import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems, productionItemMedia } from "@/lib/db/schema";
import { bucketName, buildKey, getPresignedPutUrl } from "@/lib/s3";
import {
  X_ALLOWED_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  inferKindFromContentType,
  validateMediaForPostType,
} from "@/lib/services/draft-media";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface FileSpec {
  name: string;
  contentType: string;
  sizeBytes: number;
}

interface PresignResponseFile {
  uploadUrl: string;
  key: string;
  bucket: string;
  contentType: string;
  sizeBytes: number;
  kind: "image" | "video";
}

/**
 * POST /api/production-items/[id]/media/presign
 *
 * Body: { files: [{ name, contentType, sizeBytes }] }
 *
 * Validates the batch against per-platform rules (X today: ≤4 photos OR
 * ≤1 video), the per-file size caps, and the content-type allowlist.
 * Issues a 15-minute presigned PUT URL per file. The browser PUTs each
 * file directly to S3 using the returned URL, then calls
 * POST /api/production-items/[id]/media to commit DB rows.
 *
 * Refuses on a published item — the post is live, the media on it should
 * reflect what's actually published.
 */
export async function POST(request: Request, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  let body: { files?: unknown };
  try {
    body = (await request.json()) as { files?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json(
      { error: "files[] required" },
      { status: 400 },
    );
  }
  if (body.files.length > 4) {
    return NextResponse.json(
      { error: "Up to 4 files per request" },
      { status: 400 },
    );
  }

  const incoming: FileSpec[] = [];
  for (const raw of body.files) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "Bad file entry" }, { status: 400 });
    }
    const f = raw as Record<string, unknown>;
    const name = typeof f.name === "string" ? f.name.trim() : "";
    const contentType =
      typeof f.contentType === "string" ? f.contentType.trim() : "";
    const sizeBytes = Number(f.sizeBytes);
    if (!name || !contentType || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return NextResponse.json(
        { error: "Each file needs name, contentType, sizeBytes" },
        { status: 400 },
      );
    }
    if (!X_ALLOWED_CONTENT_TYPES.has(contentType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${contentType}` },
        { status: 400 },
      );
    }
    const kind = inferKindFromContentType(contentType);
    if (!kind) {
      return NextResponse.json(
        { error: `Cannot infer kind for ${contentType}` },
        { status: 400 },
      );
    }
    const cap = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (sizeBytes > cap) {
      return NextResponse.json(
        {
          error:
            kind === "image"
              ? "Images must be under 15 MB."
              : "Videos must be under 200 MB.",
        },
        { status: 413 },
      );
    }
    incoming.push({ name, contentType, sizeBytes });
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

  const existingRows = await db
    .select({ kind: productionItemMedia.kind })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, id));
  const existingShapes = existingRows.map((r) => ({
    kind: r.kind as "image" | "video",
  }));
  const incomingShapes = incoming.map((f) => ({
    kind: inferKindFromContentType(f.contentType)!,
  }));

  const validation = validateMediaForPostType(
    item.postType,
    existingShapes,
    incomingShapes,
  );
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }

  const bucket = bucketName();
  const out: PresignResponseFile[] = [];
  for (const f of incoming) {
    const key = buildKey(id, f.name);
    const uploadUrl = await getPresignedPutUrl(key, f.contentType, f.sizeBytes);
    out.push({
      uploadUrl,
      key,
      bucket,
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
      kind: inferKindFromContentType(f.contentType)!,
    });
  }

  return NextResponse.json({ files: out });
}
