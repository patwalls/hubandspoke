// POST /api/production-items/upload-recording
//
// Creates a pillar production item for a raw interview/fireside recording that
// was NOT published to any brand channel. Sets sourceType="source_recording"
// so the clip-ideas auto-gate fires after Whisper transcription without
// requiring Published status or the standard recency cap.
//
// The client follows up with:
//   POST /api/uploads/s3-presign  → get signed PUT URL
//   PUT <uploadUrl>               → stream file to S3
//   POST /api/uploads/confirm     → write mediaS3Key + enqueue Whisper
//
// After Whisper finishes, maybeAutoEnqueueClipIdeas fires generate-clip-ideas
// for every clippable format on the brand.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { resolveEditor } from "@/lib/services/assignees";
import { recordItemCreated } from "@/lib/services/item-created";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { title?: string; brand?: string; format?: string; accountId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = body.title?.trim();
  const brand = body.brand?.trim();
  const accountId = body.accountId?.trim() || null;

  if (!title || !brand) {
    return NextResponse.json(
      { error: "title and brand are required" },
      { status: 400 },
    );
  }

  const formatCheck = await normalizeFormatForWrite(brand, body.format ?? null);
  if (!formatCheck.ok) {
    return NextResponse.json({ error: formatCheck.error }, { status: 400 });
  }
  const validatedFormat = formatCheck.value;

  // Assign the uploading user as editor; fall back to brand/global default
  // so the item always has an owner even if called from a context without a user.
  const editorUserId =
    session.user.id ??
    (await resolveEditor({ brand, format: validatedFormat ?? null }));

  const [created] = await db
    .insert(productionItems)
    .values({
      title,
      brand,
      format: validatedFormat ?? null,
      accountId,
      postType: "youtube_long",
      sourceType: "source_recording",
      status: "Idea",
      editorUserId,
      createdVia: "api:upload-recording",
    })
    .returning({ id: productionItems.id });

  try {
    await recordItemCreated(db, {
      itemId: created.id,
      source: "api:upload-recording",
      actorUserId: session.user.id ?? null,
      format: validatedFormat ?? null,
      sourceType: "source_recording",
      postType: "youtube_long",
    });
  } catch (err) {
    console.error("recordItemCreated failed for upload-recording:", err);
  }

  return NextResponse.json({ id: created.id }, { status: 201 });
}
