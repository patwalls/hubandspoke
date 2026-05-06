import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPresignedPutUrl } from "@/lib/s3";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — comments aren't a media archive
const PREFIX = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads")
  .replace(/\/+$/, "");

// Allow images + PDFs. The bucket is private; everything served back goes
// through the auth-checked /api/files proxy.
const ALLOWED_RE = /^(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf)$/;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    fileName?: string;
    contentType?: string;
    fileSize?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fileName = body.fileName?.trim();
  const contentType = body.contentType?.trim();
  const fileSize = Number(body.fileSize);

  if (!fileName || !contentType || !fileSize || fileSize <= 0) {
    return NextResponse.json(
      { error: "fileName, contentType, fileSize required" },
      { status: 400 },
    );
  }
  if (fileSize > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES} bytes)` },
      { status: 413 },
    );
  }
  if (!ALLOWED_RE.test(contentType)) {
    return NextResponse.json(
      { error: "Only images and PDFs are allowed" },
      { status: 400 },
    );
  }

  const safe = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
  const key = `${PREFIX}/comment-attachments/${randomUUID()}-${safe}`;

  try {
    const uploadUrl = await getPresignedPutUrl(key, contentType, fileSize);
    // Durable proxy URL — does not expire. /api/files redirects to a fresh
    // presigned GET on each request, so the comment body can store this
    // forever without breakage.
    const fileUrl = `/api/files/${key}`;
    return NextResponse.json({ uploadUrl, key, fileUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
