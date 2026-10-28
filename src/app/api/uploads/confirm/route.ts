import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireBrandEdit } from "@/lib/auth-guards";
import { brandOfProductionItem } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { headObject } from "@/lib/s3";
import { maybeEnqueueWhisperTranscribe } from "@/lib/services/transcribe-after-upload";

export async function POST(request: NextRequest) {
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

  const guard = await requireBrandEdit(await brandOfProductionItem(itemId));
  if (guard.response) return guard.response;

  // Verify the object actually exists in storage (defends against client lying).
  const head = await headObject(key, bucket);
  if (!head) {
    return NextResponse.json(
      { error: "Object not found in storage" },
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

  // Bytes are in S3 — kick off Whisper transcription if this item doesn't
  // already have a transcript.
  await maybeEnqueueWhisperTranscribe(itemId);

  return NextResponse.json({
    success: true,
    sizeBytes: head.contentLength ?? fileSize,
  });
}
