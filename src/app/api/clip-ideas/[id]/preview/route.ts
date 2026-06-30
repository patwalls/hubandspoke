import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { clipIdeas, productionItems, transcripts } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  const [row] = await db
    .select({
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      hookSegments: clipIdeas.hookSegments,
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      mediaS3Key: productionItems.mediaS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
      mediaContentType: productionItems.mediaContentType,
      contentMediaUrl: productionItems.contentMediaUrl,
    })
    .from(clipIdeas)
    .leftJoin(
      productionItems,
      eq(productionItems.id, clipIdeas.sourceProductionItemId),
    )
    .where(eq(clipIdeas.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);

  const [t] = await db
    .select({ segments: transcripts.segments })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, row.sourceProductionItemId))
    .limit(1);

  // Segments overlap the clip range iff seg.end > startSec AND seg.start < endSec.
  // Using strict inequality on the edges skips segments that only touch the
  // boundary, which would otherwise pad the excerpt with a stray word.
  const allSegments = t?.segments ?? [];
  const overlapping = allSegments.filter(
    (s) => s.endSec > startSec && s.startSec < endSec,
  );

  // Opening segments of the source = what "Include intro at top" prepends.
  // We take the natural intro window (first INTRO_WINDOW segments) and then a
  // ~15s lead-in PAST it, extended to a full segment so the intro never ends
  // mid-sentence — operators kept wanting "a little more after the intro" (the
  // host's hand-off into the interview). Capped at MAX_INTRO_SEGMENTS so the
  // payload stays small and we can't accidentally prepend half the episode.
  const INTRO_WINDOW = 24;
  const INTRO_PAD_SEC = 15;
  const MAX_INTRO_SEGMENTS = 40;
  let introCount = Math.min(INTRO_WINDOW, allSegments.length);
  if (introCount > 0) {
    const targetEnd = allSegments[introCount - 1].endSec + INTRO_PAD_SEC;
    for (
      let i = introCount;
      i < allSegments.length && i < MAX_INTRO_SEGMENTS;
      i++
    ) {
      introCount = i + 1;
      if (allSegments[i].endSec >= targetEnd) break; // land on a full sentence
    }
  }
  const introSegments = allSegments.slice(0, introCount);

  let videoUrl: string | null = null;
  let videoContentType: string | null = row.mediaContentType ?? null;
  if (row.mediaS3Key) {
    try {
      videoUrl = await getPresignedGetUrl(row.mediaS3Key, 3600, {
        bucket: row.mediaS3Bucket ?? undefined,
      });
    } catch {
      videoUrl = null;
    }
  } else if (row.contentMediaUrl) {
    videoUrl = row.contentMediaUrl;
  }

  return NextResponse.json({
    startSec,
    endSec,
    hookSegments: row.hookSegments ?? [],
    videoUrl,
    videoContentType,
    segments: overlapping.map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.text,
      speaker: s.speaker ?? null,
    })),
    introSegments: introSegments.map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.text,
      speaker: s.speaker ?? null,
    })),
  });
}
