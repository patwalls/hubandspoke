import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getPresignedPutUrl } from "@/lib/s3";

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB
const PREFIX = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads")
  .replace(/\/+$/, "");

const ALLOWED_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    brand?: string;
    fileName?: string;
    contentType?: string;
    fileSize?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { brand: brandSlug, fileName, contentType, fileSize } = body;

  if (!brandSlug || !fileName || !contentType || !fileSize || fileSize <= 0) {
    return NextResponse.json(
      { error: "brand, fileName, contentType, fileSize required" },
      { status: 400 }
    );
  }
  if (fileSize > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 413 }
    );
  }
  if (!ALLOWED_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: "Only ZIP files are allowed" },
      { status: 400 }
    );
  }

  const brand = await fetchBrandBySlug(brandSlug);
  if (!brand) {
    return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  }

  const safe = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "watermarks.zip";
  const key = `${PREFIX}/brand-watermarks/${brand.slug}/${randomUUID()}-${safe}`;

  try {
    const uploadUrl = await getPresignedPutUrl(key, contentType, fileSize);
    return NextResponse.json({ uploadUrl, key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
