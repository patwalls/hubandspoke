import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAcademyEditor } from "@/lib/academy/editor-guard";
import { getPresignedPutUrl } from "@/lib/s3";

const MAX_BYTES = 15 * 1024 * 1024; // screenshots, not video
const PREFIX = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads").replace(/\/+$/, "");
const IMAGE_RE = /^image\/(png|jpe?g|gif|webp)$/;

/**
 * POST /api/academy/images — Academy editor: presigned upload for a
 * screenshot in a video's step-by-step guide. Body: { fileName, contentType,
 * fileSize }. Same flow as comment attachments: the browser PUTs to
 * `uploadUrl`, then stores `fileUrl` (the auth-checked /api/files proxy, so
 * only signed-in users can load it, and the URL never expires).
 */
export async function POST(request: NextRequest) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;

  const body = (await request.json().catch(() => null)) as { fileName?: string; contentType?: string; fileSize?: number } | null;
  const fileName = body?.fileName?.trim();
  const contentType = body?.contentType?.trim();
  const fileSize = Number(body?.fileSize);
  if (!fileName || !contentType || !fileSize || fileSize <= 0) {
    return NextResponse.json({ error: "fileName, contentType, fileSize required" }, { status: 400 });
  }
  if (fileSize > MAX_BYTES) return NextResponse.json({ error: "Image too large (max 15 MB)" }, { status: 413 });
  if (!IMAGE_RE.test(contentType)) return NextResponse.json({ error: "Only PNG, JPG, GIF or WebP images" }, { status: 400 });

  const safe =
    fileName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "image";
  const key = `${PREFIX}/academy-images/${randomUUID()}-${safe}`;

  try {
    const uploadUrl = await getPresignedPutUrl(key, contentType, fileSize);
    return NextResponse.json({ uploadUrl, fileUrl: `/api/files/${key}` });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Upload failed" }, { status: 500 });
  }
}
