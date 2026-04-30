import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import { buildKey, getPresignedPutUrl } from "@/lib/s3";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per photo

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  let body: { fileName?: string; contentType?: string; contentLength?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fileName = (body.fileName ?? "").toString().slice(0, 200) || "photo";
  const contentType = (body.contentType ?? "").toString();
  const contentLength = Number(body.contentLength);

  if (!contentType.startsWith("image/")) {
    return NextResponse.json(
      { error: "Only image/* uploads allowed" },
      { status: 400 }
    );
  }
  if (
    !Number.isFinite(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_BYTES
  ) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES} bytes)` },
      { status: 400 }
    );
  }

  // Group fix photos under a stable subprefix so we can find them later.
  const key = buildKey("fixes", fileName);
  const url = await getPresignedPutUrl(key, contentType, contentLength);
  return NextResponse.json({ url, key });
}
