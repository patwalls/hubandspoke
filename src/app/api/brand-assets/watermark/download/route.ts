import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getPresignedGetUrl } from "@/lib/s3";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const brandSlug = request.nextUrl.searchParams.get("brand");
  if (!brandSlug) {
    return NextResponse.json({ error: "Missing brand" }, { status: 400 });
  }

  const brand = await fetchBrandBySlug(brandSlug);
  if (!brand) {
    return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  }

  if (!brand.watermarkS3Key) {
    // Fall back to the static public file for brands without an upload yet.
    return NextResponse.redirect(
      new URL("/watermarks/starter-story-watermarks.zip", request.url)
    );
  }

  const safeName = `${brand.slug}-watermarks.zip`;
  const url = await getPresignedGetUrl(brand.watermarkS3Key, 900, {
    downloadFileName: safeName,
  });

  return NextResponse.redirect(url);
}
