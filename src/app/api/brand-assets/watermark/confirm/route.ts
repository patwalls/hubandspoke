import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { brandWatermarks } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { headObject } from "@/lib/s3";

const PREFIX = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads")
  .replace(/\/+$/, "");

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { brand?: string; key?: string; fileName?: string; fileSize?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { brand: brandSlug, key, fileName, fileSize } = body;

  if (!brandSlug || !key || !fileName) {
    return NextResponse.json(
      { error: "brand, key, and fileName required" },
      { status: 400 }
    );
  }

  const expectedPrefix = `${PREFIX}/brand-watermarks/${brandSlug}/`;
  if (!key.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  const brand = await fetchBrandBySlug(brandSlug);
  if (!brand) {
    return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  }

  // Verify the object actually landed in S3 before recording it.
  const meta = await headObject(key);
  if (!meta) {
    return NextResponse.json(
      { error: "Upload not found in S3 — complete the upload first" },
      { status: 422 }
    );
  }

  const [row] = await db
    .insert(brandWatermarks)
    .values({
      brandId: brand.id,
      s3Key: key,
      fileName,
      sizeBytes: fileSize ?? meta.contentLength ?? null,
    })
    .returning({ id: brandWatermarks.id });

  return NextResponse.json({ ok: true, id: row.id });
}
