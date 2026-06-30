// POST /api/uploads/multipart/create
//
// Starts a browser→S3 multipart upload for a large recording. Returns the
// uploadId plus a presigned UploadPart URL for every part, so the client can
// PUT parts directly to S3 (each part is a small, independently-retryable
// request — far more reliable than one giant presigned PUT that stalls and
// never resumes).
//
// Completion happens in /api/uploads/multipart/complete, where the server
// reads part ETags via ListParts (the bucket CORS doesn't expose ETag, so the
// browser can't read them itself).

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  bucketName,
  buildKey,
  createMultipartUpload,
  getPresignedUploadPartUrl,
} from "@/lib/s3";

const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const MIN_PART_SIZE = 8 * 1024 * 1024; // 8 MB (>5MB S3 minimum for non-final parts)
const MAX_PARTS = 9000; // S3 hard limit is 10k; leave headroom

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    itemId?: string;
    fileName?: string;
    contentType?: string;
    fileSize?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const itemId = body.itemId?.trim();
  const fileName = body.fileName?.trim();
  const contentType = body.contentType?.trim();
  const fileSize = Number(body.fileSize);

  if (!itemId || !fileName || !contentType || !fileSize || fileSize <= 0) {
    return NextResponse.json(
      { error: "itemId, fileName, contentType, fileSize required" },
      { status: 400 }
    );
  }
  if (fileSize > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES} bytes)` },
      { status: 413 }
    );
  }
  if (!/^(video|audio)\//.test(contentType)) {
    return NextResponse.json(
      { error: "contentType must be video/* or audio/*" },
      { status: 400 }
    );
  }

  const [item] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.id, itemId));
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  // Scale the part size up for very large files so we never exceed MAX_PARTS.
  let partSize = MIN_PART_SIZE;
  if (Math.ceil(fileSize / partSize) > MAX_PARTS) {
    partSize = Math.ceil(fileSize / MAX_PARTS / (1024 * 1024)) * 1024 * 1024;
  }
  const partCount = Math.ceil(fileSize / partSize);

  const key = buildKey(itemId, fileName);
  const bucket = bucketName();

  try {
    const uploadId = await createMultipartUpload(key, contentType);
    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, i) =>
        getPresignedUploadPartUrl(key, uploadId, i + 1).then((url) => ({
          partNumber: i + 1,
          url,
        }))
      )
    );
    return NextResponse.json({ uploadId, key, bucket, partSize, partUrls });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
