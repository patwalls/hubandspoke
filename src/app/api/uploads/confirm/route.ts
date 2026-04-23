import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { headObject } from "@/lib/s3";
import { maybeEnqueueDescriptTranscribe } from "@/lib/services/transcribe-after-upload";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    itemId?: string;
    key?: string;
    bucket?: string;
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
  const contentType = body.contentType?.trim() || null;
  const fileSize = Number(body.fileSize) || null;

  if (!itemId || !key || !bucket) {
    return NextResponse.json(
      { error: "itemId, key, bucket required" },
      { status: 400 }
    );
  }

  // Verify the object actually exists on S3 (defends against client lying).
  const head = await headObject(key);
  if (!head) {
    return NextResponse.json(
      { error: "Object not found in S3" },
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

  // Bytes are in S3 — let Descript transcribe if the feature flag is on
  // and this item doesn't already have a transcript.
  await maybeEnqueueDescriptTranscribe(itemId);

  return NextResponse.json({
    success: true,
    sizeBytes: head.contentLength ?? fileSize,
  });
}
