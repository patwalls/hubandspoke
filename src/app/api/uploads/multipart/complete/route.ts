import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { completeMultipartUpload } from "@/lib/s3";

interface Part {
  PartNumber: number;
  ETag: string;
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  let body: { key?: string; uploadId?: string; bucket?: string; parts?: unknown };
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
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    return NextResponse.json(
      { error: "parts[] required" },
      { status: 400 },
    );
  }

  const parts: Part[] = [];
  for (const raw of body.parts) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "Bad part entry" }, { status: 400 });
    }
    const p = raw as Record<string, unknown>;
    const PartNumber = Number(p.PartNumber);
    const ETag = typeof p.ETag === "string" ? p.ETag.trim() : "";
    if (!Number.isInteger(PartNumber) || PartNumber < 1 || !ETag) {
      return NextResponse.json(
        { error: "Each part needs PartNumber (int ≥ 1) and ETag (string)" },
        { status: 400 },
      );
    }
    parts.push({ PartNumber, ETag });
  }

  parts.sort((a, b) => a.PartNumber - b.PartNumber);

  try {
    await completeMultipartUpload(key, uploadId, parts, bucket);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
