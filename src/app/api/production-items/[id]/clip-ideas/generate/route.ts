import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, productionItems } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { getTranscriptForPrompt } from "@/lib/services/transcript-fetch";
import {
  generateClipIdeas,
  GENERATED_BY,
  PROMPT_VERSION,
  type PerfRow,
} from "@/lib/clip-idea-agent";
import { topShortFormPerformers } from "@/lib/db/queries";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SHORT_FORM_PLATFORMS = ["YouTube Shorts", "Instagram Reel", "TikTok"];

function isShortForm(platform: string[] | null): boolean {
  if (!platform) return false;
  return platform.some((p) => SHORT_FORM_PLATFORMS.includes(p));
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
      brand: productionItems.brand,
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

  // Derivatives of THIS pillar — direct children only (depth 1), short-form.
  // Keeping to depth 1 matches the "clips already made from this video" framing
  // and avoids pulling cousin long-form posts that share an ancestor.
  const derivativeRows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      platform: productionItems.platform,
      format: productionItems.format,
      views: productionItems.views,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.pillarContentItemId, id),
        isNotNull(productionItems.views),
        sql`(${productionItems.platform}::jsonb @> '["YouTube Shorts"]'::jsonb OR ${productionItems.platform}::jsonb @> '["Instagram Reel"]'::jsonb OR ${productionItems.platform}::jsonb @> '["TikTok"]'::jsonb)`
      )
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(20);

  const derivatives: PerfRow[] = derivativeRows
    .filter((d) => isShortForm(d.platform as string[] | null))
    .map((d) => ({
      title: d.title,
      platform: d.platform as string[] | null,
      format: d.format,
      views: d.views,
    }));

  const topPerfRows = await topShortFormPerformers({
    brand: item.brand,
    excludeDerivativesOfPillarId: id,
    limit: 30,
  });
  const topPerformers: PerfRow[] = topPerfRows.map((r) => ({
    title: r.title,
    platform: r.platform,
    format: r.format,
    views: r.views,
  }));

  try {
    const result = await generateClipIdeas({
      pillarTitle: item.title,
      pillarFormat: item.format,
      pillarChannels: item.platform,
      transcriptSegmentsMarkdown: transcript.segmentsMarkdown,
      durationSec: transcript.durationSec,
      derivatives,
      topPerformers,
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
      estimatedViews: idea.estimatedViews,
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
      derivativesCount: derivatives.length,
      topPerformersCount: topPerformers.length,
      modelUsage: result.modelUsage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("clip-idea generation failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
