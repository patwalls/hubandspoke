import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  // Validate the item has archived media we can transcribe — surface a 400
  // to the client rather than letting the worker discover it.
  const [item] = await db
    .select({
      mediaS3Key: productionItems.mediaS3Key,
      mediaContentType: productionItems.mediaContentType,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    return NextResponse.json(
      { ok: false, error: "Item not found", kind: "not_found" },
      { status: 404 },
    );
  }
  if (!item.mediaS3Key) {
    return NextResponse.json(
      {
        ok: false,
        error: "No archived media on S3 — cannot transcribe",
        kind: "no_media",
      },
      { status: 400 },
    );
  }
  const ct = item.mediaContentType ?? "";
  if (!ct.startsWith("video/") && !ct.startsWith("audio/")) {
    return NextResponse.json(
      {
        ok: false,
        error: `Media content type ${ct || "unknown"} is not audio/video`,
        kind: "not_av",
      },
      { status: 400 },
    );
  }

  // jobKey dedupes back-to-back clicks of Refetch so we don't stack runs.
  await enqueue(
    "transcribe-whisper",
    { productionItemId: id },
    { jobKey: `transcribe-whisper:${id}` },
  );

  return NextResponse.json(
    { ok: true, status: "pending" },
    { status: 202 },
  );
}
