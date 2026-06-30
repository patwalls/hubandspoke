import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { abortMultipartUpload } from "@/lib/s3";

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  let body: { key?: string; uploadId?: string; bucket?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = body.key?.trim();
  const uploadId = body.uploadId?.trim();
  const bucket = body.bucket?.trim();

  if (!key || !uploadId || !bucket) {
    return NextResponse.json(
      { error: "key, uploadId, bucket required" },
      { status: 400 },
    );
  }

  // Best-effort — abortMultipartUpload swallows errors internally.
  await abortMultipartUpload(key, uploadId, bucket);
  return NextResponse.json({ success: true });
}
