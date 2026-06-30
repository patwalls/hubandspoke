import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const itemId = request.nextUrl.searchParams.get("itemId");
  if (!itemId) {
    return NextResponse.json({ error: "itemId required" }, { status: 400 });
  }

  const [item] = await db
    .select({
      title: productionItems.title,
      mediaS3Key: productionItems.mediaS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId));

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (!item.mediaS3Key) {
    return NextResponse.json(
      { error: "No media file uploaded for this item" },
      { status: 404 }
    );
  }

  // Build a friendly download filename from the title; fall back to the S3
  // key's basename.
  const baseName =
    (item.title || item.mediaS3Key.split("/").pop() || "video")
      .replace(/[^\w. -]+/g, "_")
      .slice(0, 120) || "video";
  const ext = item.mediaS3Key.match(/\.[a-z0-9]{1,8}$/i)?.[0] || ".mp4";
  const downloadFileName = baseName.toLowerCase().endsWith(ext.toLowerCase())
    ? baseName
    : `${baseName}${ext}`;

  const url = await getPresignedGetUrl(item.mediaS3Key, 60 * 5, {
    downloadFileName,
    bucket: item.mediaS3Bucket ?? undefined,
  });
  return NextResponse.redirect(url, 302);
}
