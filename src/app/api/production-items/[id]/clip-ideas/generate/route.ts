import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import { enqueue } from "@/jobs/enqueue";
import { getClippableFormats } from "@/lib/db/formats";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface GenerateBody {
  /** When set, generate clip ideas only for this clippable format. When
   *  absent, fan out across every `is_clippable_format=true` format on
   *  the pillar's brand (the default — operators trigger a full refresh
   *  via the Regenerate button on the pillar's panel). */
  targetFormatId?: string;
  /** v10 (2026-05-22): when true, re-run section detection from scratch
   *  before any hooks are written. Kills the live `clip_sections` batch
   *  (cascade-deletes derived clip_ideas across every format) and runs
   *  Splice v10 again. Implies `force` for every format job kicked off
   *  in the same call. */
  forceSections?: boolean;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const actorUserId = guard.session.user.id as string;

  let body: GenerateBody = {};
  try {
    // The legacy fetch sites don't pass a body; only treat missing-body as
    // empty options. Anything malformed surfaces as a 400.
    const raw = await request.text();
    if (raw.trim().length > 0) body = JSON.parse(raw) as GenerateBody;
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `Bad request body: ${err.message}`
            : "Bad request body",
      },
      { status: 400 },
    );
  }

  const [item] = await db
    .select({ id: productionItems.id, brand: productionItems.brand })
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

  // Resolve the set of target formats. With body.targetFormatId we run
  // for that one format only; without it we fan out across every
  // clippable format on the brand. Empty fan-out = no clippable formats
  // configured for the brand — surface a clear 400 so the operator knows
  // to flip the checkbox somewhere.
  let targetFormatIds: string[];
  if (body.targetFormatId) {
    targetFormatIds = [body.targetFormatId];
  } else {
    const clippable = await getClippableFormats(item.brand);
    if (clippable.length === 0) {
      return NextResponse.json(
        {
          error: `No clippable formats configured for brand "${item.brand}". Tick "Clippable format" on at least one format in /${item.brand}/formats.`,
        },
        { status: 400 },
      );
    }
    targetFormatIds = clippable.map((f) => f.id);
  }

  // Enqueue one `generate-clip-ideas` graphile-worker job per format.
  // The worker dyno has its own connection budget — running this work
  // inline on the web dyno held web's postgres-js pool open through
  // ~30s Sonnet+Haiku calls per format, which exhausted the web pool
  // and 502'd concurrent UI requests (see Splice v10 incident,
  // 2026-05-22). The job key dedupes concurrent enqueues for the same
  // (pillar, format) pair.
  for (const targetFormatId of targetFormatIds) {
    try {
      await enqueue("generate-clip-ideas", {
        productionItemId: id,
        targetFormatId,
        actorUserId,
        skipPostTypeGate: true,
        force: true,
        forceSections: body.forceSections === true,
      });
    } catch (err) {
      console.error(
        `[clip-ideas] enqueue failed for item=${id} format=${targetFormatId}:`,
        err,
      );
    }
  }

  return NextResponse.json(
    {
      ok: true,
      status: "pending",
      targetFormatIds,
      formatCount: targetFormatIds.length,
    },
    { status: 202 }
  );
}
