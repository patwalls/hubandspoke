// POST /api/uploads/multipart/abort
//
// Best-effort cleanup when the user cancels or a multipart upload fails part
// way. Aborts the S3 multipart upload so the uploaded parts don't linger and
// accrue storage. Always 200s — a failed abort is non-fatal (S3 lifecycle
// rules can also reap incomplete uploads).

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { abortMultipartUpload } from "@/lib/s3";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { key?: string; uploadId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = body.key?.trim();
  const uploadId = body.uploadId?.trim();
  if (!key || !uploadId) {
    return NextResponse.json({ error: "key and uploadId required" }, { status: 400 });
  }

  try {
    await abortMultipartUpload(key, uploadId);
  } catch {
    // Non-fatal — incomplete uploads are reaped by S3 lifecycle anyway.
  }
  return NextResponse.json({ success: true });
}
