import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { detectFillerWords } from "@/lib/services/clip-editor/detect-fillers";
import { loadClipEditorSession } from "@/lib/services/clip-editor/session";
import { isWordInRange } from "@/lib/clip-editor/words";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Which words of this clip are filler. Body: `{ ranges: TimeRange[] }` — the
 * source ranges currently in the clip (the client knows its unsaved trim;
 * the server does not). Words are re-read server-side from the transcript, so
 * the client can only choose WHICH words get classified, never their text.
 * Returns `{ fillerIndexes }` — transcript word indexes; the editor turns
 * them into removals.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const body = (await request.json().catch(() => null)) as {
    ranges?: Array<{ startSec?: unknown; endSec?: unknown }>;
  } | null;
  const ranges = (body?.ranges ?? [])
    .map((r) => ({ startSec: Number(r.startSec), endSec: Number(r.endSec) }))
    .filter((r) => Number.isFinite(r.startSec) && r.endSec > r.startSec)
    .slice(0, 20);
  if (ranges.length === 0) {
    return NextResponse.json({ error: "ranges is required" }, { status: 400 });
  }

  const session = await loadClipEditorSession({
    clipIdeaId: id,
    userId: guard.session.user.id as string,
  });
  const words = session.words.filter((w) => ranges.some((r) => isWordInRange(w, r)));

  const result = await detectFillerWords({ words });
  if (!result.ok) {
    const status = result.failure.reason === "no-words" ? 400 : 502;
    return NextResponse.json(
      { error: "Couldn't detect filler words — try again.", failure: result.failure },
      { status },
    );
  }
  return NextResponse.json({ fillerIndexes: result.fillerIndexes });
}
