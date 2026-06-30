// POST /api/production-items/upload-external-link
//
// Creates a Published youtube_long source_recording from an external YouTube
// URL (e.g. a podcast episode Jonathan appeared on). Sets status='Published'
// and youtubeId so the home-machine archiver picks the video up in its next
// hourly run. After download, transcribe-whisper fires → maybeAutoEnqueueClipIdeas
// fans out clip ideas for every clippable format on the brand (the
// source_recording gate in clip-ideas-auto.ts bypasses the brand allowlist,
// Published-status, and recency checks).
//
// The dialog calls /api/production-items/preview-link first to pre-fill
// title/thumbnail/publishedDate — this route trusts those values and does NOT
// call SC again, to avoid burning a second credit.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { and, eq, isNull, ne } from "drizzle-orm";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { resolveEditor } from "@/lib/services/assignees";
import { recordItemCreated } from "@/lib/services/item-created";
import { enqueue } from "@/jobs/enqueue";
import { todayLocalISO } from "@/lib/utils/dates";

function extractYoutubeId(url: string): string | null {
  const m = url.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([\w-]{11})/);
  return m?.[1] ?? null;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    youtubeUrl?: string;
    title?: string;
    publishedDate?: string;
    thumbnail?: string;
    brand?: string;
    format?: string;
    accountId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const youtubeUrl = body.youtubeUrl?.trim();
  const title = body.title?.trim();
  const brand = body.brand?.trim();

  if (!youtubeUrl || !title || !brand) {
    return NextResponse.json(
      { error: "youtubeUrl, title, and brand are required" },
      { status: 400 },
    );
  }

  const youtubeId = extractYoutubeId(youtubeUrl);
  if (!youtubeId) {
    return NextResponse.json(
      { error: "Could not extract a YouTube video ID from that URL" },
      { status: 400 },
    );
  }

  // If this YouTube video already exists (and isn't soft-deleted), redirect to it.
  const [existing] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(and(eq(productionItems.youtubeId, youtubeId), isNull(productionItems.deletedAt), ne(productionItems.status, "Killed")))
    .limit(1);
  if (existing) {
    return NextResponse.json({ id: existing.id, alreadyExists: true }, { status: 200 });
  }

  try {
    const formatCheck = await normalizeFormatForWrite(brand, body.format ?? null);
    if (!formatCheck.ok) {
      return NextResponse.json({ error: formatCheck.error }, { status: 400 });
    }
    const validatedFormat = formatCheck.value;

    const editorUserId =
      session.user.id ??
      (await resolveEditor({ brand, format: validatedFormat ?? null }));

    const publishedDate = body.publishedDate ?? todayLocalISO();
    const thumbnail = body.thumbnail ?? null;

    const [created] = await db
      .insert(productionItems)
      .values({
        title,
        brand,
        format: validatedFormat ?? null,
        accountId: body.accountId?.trim() || null,
        postType: "youtube_long",
        sourceType: "source_recording",
        status: "Published",
        youtubeId,
        youtubeUrl,
        publishedLink: youtubeUrl,
        publishedDate,
        publishedAt: new Date(),
        thumbnail,
        editorUserId,
        createdVia: "api:upload-external-link",
      })
      .returning({ id: productionItems.id });

    try {
      await recordItemCreated(db, {
        itemId: created.id,
        source: "api:upload-external-link",
        actorUserId: session.user.id ?? null,
        format: validatedFormat ?? null,
        sourceType: "source_recording",
        postType: "youtube_long",
      });
    } catch (err) {
      console.error("recordItemCreated failed for upload-external-link:", err);
    }

    // Kick off the download immediately. The local worker picks this up and
    // runs yt-dlp; after the video lands in S3, transcribe-whisper fires and
    // clip ideas auto-generate (source_recording gate in clip-ideas-auto.ts).
    try {
      await enqueue("youtube-download", { productionItemId: created.id });
    } catch (err) {
      console.error("youtube-download enqueue failed (non-fatal):", err);
    }

    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    console.error("upload-external-link failed:", err);
    // Unique constraint on youtube_id — race between pre-check and insert
    const isUnique = err != null && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "23505";
    if (isUnique) {
      const [dup] = await db
        .select({ id: productionItems.id })
        .from(productionItems)
        .where(and(eq(productionItems.youtubeId, youtubeId), isNull(productionItems.deletedAt), ne(productionItems.status, "Killed")))
        .limit(1);
      if (dup) {
        return NextResponse.json({ id: dup.id, alreadyExists: true }, { status: 200 });
      }
    }
    return NextResponse.json({ error: "Something went wrong — please try again" }, { status: 500 });
  }
}
