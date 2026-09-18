import { NextRequest, NextResponse } from "next/server";
import { imageSize } from "image-size";
import { requireFeature } from "@/lib/auth-guards";
import { bucketName, buildKey, getPresignedGetUrl, putObject } from "@/lib/s3";
import type { ImageCandidate } from "@/lib/services/design-editor/assets";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Upload a picture for the design (multipart `file`). Returns an
 *  ImageCandidate the editor can place or swap in. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: "Use a JPG, PNG or WebP" }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Image is over 15 MB" }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(buf);
  } catch {
    return NextResponse.json({ error: "That file isn't a readable image" }, { status: 415 });
  }
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const key = buildKey(id, `design-upload-${(file.name || "image").replace(/\.[^.]+$/, "")}.${ext}`);
  await putObject(key, buf, file.type);
  const candidate: ImageCandidate = {
    label: file.name || "Upload",
    src: { kind: "s3", bucket: bucketName(), key },
    previewUrl: await getPresignedGetUrl(key, 4 * 3600),
  };
  return NextResponse.json({ image: candidate, width: dims.width ?? null, height: dims.height ?? null });
}
