// POST /api/uploads/multipart/complete
//
// Finishes a multipart upload started by /api/uploads/multipart/create. The
// server reads the uploaded parts' ETags via ListParts (the bucket CORS
// doesn't expose ETag to the browser) and calls CompleteMultipartUpload, then
// stamps media_s3_* on the production item and kicks off Whisper — same
// post-upload effect as the single-PUT /api/uploads/confirm path.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { completeMultipartUpload, headObject } from "@/lib/s3";
import { maybeEnqueueWhisperTranscribe } from "@/lib/services/transcribe-after-upload";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    itemId?: string;
    key?: string;
    bucket?: string;
    uploadId?: string;
    contentType?: string;
    fileSize?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const itemId = body.itemId?.trim();
  const key = body.key?.trim();
  const bucket = body.bucket?.trim();
  const uploadId = body.uploadId?.trim();
  const contentType = body.contentType?.trim() || null;
  const fileSize = Number(body.fileSize) || null;

  if (!itemId || !key || !bucket || !uploadId) {
    return NextResponse.json(
      { error: "itemId, key, bucket, uploadId required" },
      { status: 400 }
    );
  }

  try {
    await completeMultipartUpload(key, uploadId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Complete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Verify the assembled object exists before stamping the row.
  const head = await headObject(key);
  if (!head) {
    return NextResponse.json(
      { error: "Object not found in S3 after completion" },
      { status: 404 }
    );
  }

  await db
    .update(productionItems)
    .set({
      mediaS3Bucket: bucket,
      mediaS3Key: key,
      mediaS3UploadedAt: new Date(),
      mediaSizeBytes: head.contentLength ?? fileSize,
      mediaContentType: head.contentType ?? contentType,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, itemId));

  await maybeEnqueueWhisperTranscribe(itemId);

  return NextResponse.json({
    success: true,
    sizeBytes: head.contentLength ?? fileSize,
  });
}
