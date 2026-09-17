import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { transcripts } from "@/lib/db/schema";
import { applyNames } from "@/lib/diarization/finalize";
import { maybeEnqueueDiarize } from "@/lib/services/diarization/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SKIP_MESSAGES: Record<string, string> = {
  disabled: "Speaker detection is switched off right now.",
  no_transcript: "This item has no transcript yet.",
  not_whisper: "Speaker detection needs a Whisper transcript (this one came from platform captions).",
  no_audio: "This transcript has no archived audio to analyze.",
  too_short: "This recording is too short.",
  already_done: "Speakers were already detected.",
};

/** Detect (or re-detect) speakers. Queues a background job — a 15-minute
 *  video takes roughly 7 minutes — and returns immediately. */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const result = await maybeEnqueueDiarize(id, { force: true, ignoreDuration: true });
  if (!result.enqueued) {
    return NextResponse.json(
      { error: SKIP_MESSAGES[result.reason] ?? "Can't detect speakers for this item." },
      { status: result.reason === "disabled" ? 503 : 400 },
    );
  }
  return NextResponse.json({ ok: true });
}

/**
 * Rename a speaker. Body: `{ speakerId, name }` — an empty name resets it to
 * "Speaker N". A user-set name is sticky: re-running detection keeps it.
 * The display name is denormalized onto every segment (`segments[].speaker`
 * is what prompts and exports print), so those are rewritten here too.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const body = (await request.json().catch(() => null)) as {
    speakerId?: unknown;
    name?: unknown;
  } | null;
  if (!body || typeof body.speakerId !== "string" || typeof body.name !== "string") {
    return NextResponse.json({ error: "speakerId and name are required" }, { status: 400 });
  }
  const name = body.name.trim().slice(0, 80);

  const [t] = await db
    .select({
      id: transcripts.id,
      words: transcripts.words,
      segments: transcripts.segments,
      speakers: transcripts.speakers,
    })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, id))
    .limit(1);
  if (!t?.speakers) return NextResponse.json({ error: "No speakers detected yet" }, { status: 404 });
  if (!t.speakers.some((s) => s.id === body.speakerId)) {
    return NextResponse.json({ error: "Unknown speaker" }, { status: 404 });
  }

  const renamed = applyNames({
    words: t.words ?? [],
    segments: t.segments,
    speakers: t.speakers.map((s) =>
      s.id === body.speakerId
        ? { ...s, name: name || null, nameSource: name ? ("user" as const) : null }
        : s,
    ),
  });
  await db
    .update(transcripts)
    .set({ speakers: renamed.speakers, segments: renamed.segments, updatedAt: sql`now()` })
    .where(eq(transcripts.id, t.id));

  return NextResponse.json({ speakers: renamed.speakers });
}
