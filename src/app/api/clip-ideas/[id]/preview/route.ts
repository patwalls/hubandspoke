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
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      mediaS3Key: productionItems.mediaS3Key,
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
  const overlapping = (t?.segments ?? []).filter(
    (s) => s.endSec > startSec && s.startSec < endSec,
  );

  let videoUrl: string | null = null;
  let videoContentType: string | null = row.mediaContentType ?? null;
  if (row.mediaS3Key) {
    try {
      videoUrl = await getPresignedGetUrl(row.mediaS3Key, 3600);
    } catch {
      videoUrl = null;
    }
  } else if (row.contentMediaUrl) {
    videoUrl = row.contentMediaUrl;
  }

  return NextResponse.json({
    startSec,
    endSec,
    videoUrl,
    videoContentType,
    segments: overlapping.map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.text,
      speaker: s.speaker ?? null,
    })),
  });
}
