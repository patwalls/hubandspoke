import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, productionItems } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { getTranscriptForPrompt } from "@/lib/services/transcript-fetch";
import {
  generateClipIdeas,
  GENERATED_BY,
  PROMPT_VERSION,
} from "@/lib/clip-idea-agent";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Generation is a single Sonnet call, typically <15s, but allow headroom.
export const maxDuration = 120;

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      platform: productionItems.platform,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const transcript = await getTranscriptForPrompt(id);
  if (!transcript) {
    return NextResponse.json(
      { error: "No transcript for this item. Fetch transcript first." },
      { status: 400 }
    );
  }

  try {
    const result = await generateClipIdeas({
      pillarTitle: item.title,
      pillarFormat: item.format,
      pillarChannels: item.platform,
      transcriptSegmentsMarkdown: transcript.segmentsMarkdown,
      durationSec: transcript.durationSec,
    });

    const batchId = randomUUID();
    const rows = result.ideas.map((idea) => ({
      sourceProductionItemId: id,
      batchId,
      startSec: idea.startSec.toFixed(3),
      endSec: idea.endSec.toFixed(3),
      hook: idea.hook,
      angle: idea.angle,
      rationale: idea.rationale,
      confidence: idea.confidence.toFixed(4),
      generatedBy: GENERATED_BY,
      promptVersion: PROMPT_VERSION,
      modelUsage: result.modelUsage,
      status: "suggested" as const,
    }));

    await db.insert(clipIdeas).values(rows);

    return NextResponse.json({
      ok: true,
      batchId,
      count: rows.length,
      modelUsage: result.modelUsage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("clip-idea generation failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
