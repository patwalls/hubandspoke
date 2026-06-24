import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchBrandBySlug, invalidateBrandCache } from "@/lib/db/brands";
import { headObject } from "@/lib/s3";

const PREFIX = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads")
  .replace(/\/+$/, "");

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { brand?: string; key?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { brand: brandSlug, key } = body;

  if (!brandSlug || !key) {
    return NextResponse.json(
      { error: "brand and key required" },
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

  // Verify the object actually landed in S3 before recording the key.
  try {
    await headObject(key);
  } catch {
    return NextResponse.json(
      { error: "Upload not found in S3 — complete the upload first" },
      { status: 422 }
    );
  }

  await db
    .update(brands)
    .set({ watermarkS3Key: key, updatedAt: new Date() })
    .where(eq(brands.id, brand.id));

  invalidateBrandCache();

  return NextResponse.json({ ok: true });
}
