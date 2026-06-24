import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { brandWatermarks } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getPresignedGetUrl } from "@/lib/s3";
import { eq, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const brandSlug = request.nextUrl.searchParams.get("brand");
  const watermarkId = request.nextUrl.searchParams.get("id");

  if (!brandSlug && !watermarkId) {
    return NextResponse.json({ error: "Missing brand or id" }, { status: 400 });
  }

  // Download a specific watermark by ID
  if (watermarkId) {
    const [wm] = await db
      .select()
      .from(brandWatermarks)
      .where(eq(brandWatermarks.id, watermarkId))
      .limit(1);
    if (!wm) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const url = await getPresignedGetUrl(wm.s3Key, 900, {
      downloadFileName: wm.fileName,
    });
    return NextResponse.redirect(url);
  }

  // Download latest watermark for a brand (used by content-detail Actions menu)
  const brand = await fetchBrandBySlug(brandSlug!);
  if (!brand) {
    return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  }

  // Prefer newest entry in brand_watermarks
  const [latest] = await db
    .select()
    .from(brandWatermarks)
    .where(eq(brandWatermarks.brandId, brand.id))
    .orderBy(desc(brandWatermarks.createdAt))
    .limit(1);

  if (latest) {
    const url = await getPresignedGetUrl(latest.s3Key, 900, {
      downloadFileName: latest.fileName,
    });
    return NextResponse.redirect(url);
  }

  // Fall back: single key stored on the brand row (uploaded before migration to multi-file)
  if (brand.watermarkS3Key) {
    const url = await getPresignedGetUrl(brand.watermarkS3Key, 900, {
      downloadFileName: `${brand.slug}-watermarks.zip`,
    });
    return NextResponse.redirect(url);
  }

  // Last resort: static public file
  return NextResponse.redirect(
    new URL("/watermarks/starter-story-watermarks.zip", request.url)
  );
}
