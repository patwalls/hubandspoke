import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { r2BucketName, buildKey, createMultipartUpload } from "@/lib/s3";

const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

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
      { status: 400 },
    );
  }
  if (fileSize > MAX_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 5 GB)" },
      { status: 413 },
    );
  }
  if (!/^(video|audio)\//.test(contentType)) {
    return NextResponse.json(
      { error: "contentType must be video/* or audio/*" },
      { status: 400 },
    );
  }

  const [item] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.id, itemId));
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const bucket = r2BucketName();
  const key = buildKey(itemId, fileName);
  try {
    const uploadId = await createMultipartUpload(key, contentType, bucket);
    return NextResponse.json({ uploadId, key, bucket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
