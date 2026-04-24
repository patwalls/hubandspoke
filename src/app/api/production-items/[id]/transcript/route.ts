import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { transcripts } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  const [row] = await db
    .select({
      id: transcripts.id,
      source: transcripts.source,
      model: transcripts.model,
      language: transcripts.language,
      fullText: transcripts.fullText,
      segments: transcripts.segments,
      wordCount: transcripts.wordCount,
      durationSec: transcripts.durationSec,
      fetchedAt: transcripts.fetchedAt,
    })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ transcript: null });
  }

  return NextResponse.json({
    transcript: {
      ...row,
      durationSec: row.durationSec ? Number(row.durationSec) : null,
    },
  });
}
