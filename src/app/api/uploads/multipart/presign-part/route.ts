import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { presignUploadPart } from "@/lib/s3";

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  let body: { key?: string; uploadId?: string; partNumber?: number; bucket?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = body.key?.trim();
  const uploadId = body.uploadId?.trim();
  const bucket = body.bucket?.trim();
  const partNumber = Number(body.partNumber);

  if (!key || !uploadId || !partNumber || !bucket) {
    return NextResponse.json(
      { error: "key, uploadId, partNumber, bucket required" },
      { status: 400 },
    );
  }
  if (partNumber < 1 || partNumber > 10000 || !Number.isInteger(partNumber)) {
    return NextResponse.json(
      { error: "partNumber must be an integer 1–10000" },
      { status: 400 },
    );
  }

  try {
    const url = await presignUploadPart(key, uploadId, partNumber, 3600, bucket);
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
