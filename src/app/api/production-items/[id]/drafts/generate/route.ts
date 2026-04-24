import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, formats, productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  generateDraft,
  GENERATED_BY,
  PROMPT_VERSION,
} from "@/lib/draft-agent";
import { resolveSchemaForPlatforms } from "@/lib/platform-field-schemas";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// A single Haiku call is typically <8s but give headroom for slow cold starts.
export const maxDuration = 120;

// POST /api/production-items/[id]/drafts/generate
// Runs the draft agent against the pillar's transcript (falling back to the
// item's own transcript if it is itself a pillar) and inserts a new current
// draft. Demoting the previous current row + inserting the new one happens in
// a transaction so the partial unique index never sees two currents.
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const actorUserId = guard.session.user.id ?? null;

  const [item] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  // Schema comes from the *platform* (where the post lives), not the format
  // (the editorial template). A Reel format cross-posted to X still needs
  // tweet fields. Format only provides editorial voice via its instructions.
  const platformArr = (item.platform as string[] | null) ?? null;
  const resolved = resolveSchemaForPlatforms(platformArr);
  if (!platformArr || platformArr.length === 0) {
    return NextResponse.json(
      { error: "Item has no platform — pick one before drafting." },
      { status: 400 },
    );
  }
  if (!resolved.schema || !resolved.key) {
    return NextResponse.json(
      {
        error: `No draft schema for platform "${resolved.raw ?? platformArr[0]}". Add one to platform-field-schemas.ts.`,
      },
      { status: 400 },
    );
  }
  const fieldSchema = resolved.schema;

  // Format row is still relevant — its `instructions` drive editorial voice.
  // Null format is fine; we just generate without editorial notes.
  let formatInstructions: string | null = null;
  if (item.format) {
    const [format] = await db
      .select({ instructions: formats.instructions })
      .from(formats)
      .where(and(eq(formats.brand, item.brand), eq(formats.name, item.format)))
      .limit(1);
    formatInstructions = format?.instructions ?? null;
  }

  // Transcript source: if this item is a derivative, pull from the pillar so
  // the agent grounds the draft in the source long-form content. If it is
  // itself a pillar (no parent), fall back to its own transcript.
  const transcriptSourceId = item.pillarContentItemId ?? item.id;
  const transcript = await getTranscriptForPrompt(transcriptSourceId);
  if (!transcript) {
    return NextResponse.json(
      {
        error:
          "No transcript available for this item's pillar. Fetch the transcript first.",
      },
      { status: 400 }
    );
  }

  // Load pillar title for context if we're deriving from one.
  let pillarTitle: string | null = item.title;
  if (item.pillarContentItemId) {
    const [pillar] = await db
      .select({ title: productionItems.title })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    if (pillar) pillarTitle = pillar.title;
  }

  try {
    const result = await generateDraft({
      item: {
        id: item.id,
        title: item.title,
        format: item.format,
        platform: (item.platform as string[] | null) ?? null,
        brand: item.brand,
      },
      fieldSchema,
      formatInstructions,
      pillarTitle,
      transcriptSegmentsMarkdown: transcript.segmentsMarkdown,
      transcriptDurationSec: transcript.durationSec,
    });

    // Demote previous current + insert new current as version+1 in a single
    // transaction. The partial unique index on (production_item_id) WHERE
    // is_current would reject two current rows; do the demote first inside
    // the tx so the insert never races.
    const inserted = await db.transaction(async (tx) => {
      const [prevCurrent] = await tx
        .select({ version: contentDrafts.version })
        .from(contentDrafts)
        .where(eq(contentDrafts.productionItemId, id))
        .orderBy(desc(contentDrafts.version))
        .limit(1);
      const nextVersion = (prevCurrent?.version ?? 0) + 1;

      await tx
        .update(contentDrafts)
        .set({ isCurrent: false, updatedAt: new Date() })
        .where(
          and(
            eq(contentDrafts.productionItemId, id),
            eq(contentDrafts.isCurrent, true),
          ),
        );

      const [row] = await tx
        .insert(contentDrafts)
        .values({
          productionItemId: id,
          version: nextVersion,
          isCurrent: true,
          content: result.content,
          fieldSchemaSnapshot: fieldSchema,
          generatedBy: GENERATED_BY,
          promptVersion: PROMPT_VERSION,
          modelUsage: result.modelUsage,
          createdByUserId: actorUserId,
        })
        .returning();
      return row;
    });

    return NextResponse.json({
      draft: inserted,
      platformKey: resolved.key,
      otherPlatforms: resolved.otherPlatforms,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("draft generation failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
