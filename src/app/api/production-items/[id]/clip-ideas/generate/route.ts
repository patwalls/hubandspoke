import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import { generateClipIdeasForItem } from "@/lib/services/clip-idea-generate";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const actorUserId = guard.session.user.id as string;

  const [item] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  // Surface the no-transcript case as a 400 up front so the panel can show a
  // useful error before the long Sonnet call kicks off in the background.
  const transcript = await getTranscriptForPrompt(id);
  if (!transcript) {
    return NextResponse.json(
      { error: "No transcript for this item. Fetch transcript first." },
      { status: 400 }
    );
  }

  // The Sonnet call + potential retry can exceed Heroku's 30s router limit
  // (H12), which would hand the client an HTML error page and blow up
  // res.json() in the panel. Return 202 now and run the generation in the
  // background; the client polls GET /clip-ideas until a new batch lands.
  // Mirrors the pattern in /transcript/fetch/route.ts.
  (async () => {
    await generateClipIdeasForItem(id, {
      actorUserId,
      // Manual route: operator already chose the pillar, bypass the
      // post_type gate the cron path enforces.
      skipPostTypeGate: true,
      // Manual Regenerate is explicit operator intent — overwrite the
      // existing batch instead of bailing on idempotency.
      force: true,
    });
  })().catch((err) => {
    console.error(
      `[clip-ideas] background generation failed for item=${id}:`,
      err
    );
  });

  return NextResponse.json(
    { ok: true, status: "pending" },
    { status: 202 }
  );
}
